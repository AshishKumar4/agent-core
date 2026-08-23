import { describe, expect, test } from "vitest";
import { Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { WorkspaceId } from "../../src/identity";
import { FacetRef, SurfaceRegistration } from "../../src/facets";
import { MemoryWorkspaceSurfaceStore } from "../../src/facets/surface-memory";
import {
    registration,
    surface,
    workspaceSurfaceStoreContract
} from "../w3/surface-store-contract";

workspaceSurfaceStoreContract("Memory", (owner) => new MemoryWorkspaceSurfaceStore(owner));

describe("MemoryWorkspaceSurfaceStore", () => {
    test("owns its Workspace and refuses a nested transaction", { tags: "p1" }, () => {
        const store = new MemoryWorkspaceSurfaceStore(new WorkspaceId("workspace"));

        expect(store.owner.value).toBe("workspace");
        expectAgentCoreError(
            () => store.transaction(() => store.transaction((transaction) => transaction.revision)),
            "protocol.invalid-state",
            /^Nested Surface transactions are not supported$/
        );
    });

    test(
        "refuses a revision that does not advance exactly once over a changed record set",
        { tags: "p0" },
        () => {
            const store = new MemoryWorkspaceSurfaceStore(new WorkspaceId("workspace"));
            const overview = registration("workspace:facet", "dashboard.overview", "Overview");

            expectAgentCoreError(
                () =>
                    store.transaction((transaction) =>
                        store.saveRevision(transaction, new Revision(5))
                    ),
                "protocol.revision-conflict",
                /advance exactly once/
            );
            // A record written without advancing the revision, and a revision advanced over
            // an unchanged store, are both fabrications the commit check refuses.
            expectAgentCoreError(
                () =>
                    store.transaction((transaction) =>
                        store.insertRegistration(transaction, overview)
                    ),
                "codec.invalid",
                /revision does not match its records/
            );
            expectAgentCoreError(
                () =>
                    store.transaction((transaction) =>
                        store.saveRevision(transaction, store.loadRevision(transaction).next())
                    ),
                "codec.invalid",
                /revision does not match its records/
            );
            expect(store.revision().value).toBe(0);
            expect(store.registrations()).toHaveLength(0);
        }
    );

    test("refuses record access outside its own active transaction", { tags: "p0" }, () => {
        const store = new MemoryWorkspaceSurfaceStore(new WorkspaceId("workspace"));
        const escaped = store.transaction((transaction) => transaction);
        const denied = /^Workspace Surface access requires its active transaction$/;

        for (const action of [
            () => store.loadRevision(escaped),
            () => store.saveRevision(escaped, new Revision(1)),
            () => store.loadRegistration(escaped, surface("dashboard.overview")),
            () => store.listRegistrations(escaped),
            () => store.retireRegistration(escaped, surface("dashboard.overview")),
            () =>
                store.insertRegistration(
                    escaped,
                    registration("workspace:facet", "dashboard.overview", "Overview")
                )
        ]) {
            expectAgentCoreError(action, "protocol.invalid-state", denied);
        }
    });

    test(
        "refuses a stored registration whose key does not match its codec bytes",
        { tags: "p1" },
        () => {
            const store = new MemoryWorkspaceSurfaceStore(new WorkspaceId("workspace"));
            const bytes = SurfaceRegistration.encode(
                registration("workspace:facet", "dashboard.overview", "Overview")
            );

            expectAgentCoreError(
                () =>
                    store.transaction((transaction) => {
                        transaction.registrations.set("dashboard.other", bytes);
                        return transaction.revision;
                    }),
                "codec.invalid",
                /^Stored Surface registration key does not match codec bytes$/
            );
            expect(store.registrations()).toHaveLength(0);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] retires a withdrawn Facet's Surfaces inside one control transaction",
        { tags: "p0" },
        () => {
            const store = new MemoryWorkspaceSurfaceStore(new WorkspaceId("workspace"));
            store.register(registration("workspace:mine", "dashboard.overview", "Overview"));
            store.register(registration("workspace:theirs", "dashboard.tasks", "Tasks"));
            const before = store.revision().value;

            const retired = store.transaction((transaction) => {
                const changed = store.retireWithdrawalSet(
                    transaction,
                    new FacetRef("workspace:mine")
                );
                store.saveRevision(transaction, store.loadRevision(transaction).next());
                return changed;
            });

            expect(retired).toBe(true);
            expect(store.revision().value).toBe(before + 1);
            expect(store.registration(surface("dashboard.overview"))).toBeUndefined();
            expect(store.registration(surface("dashboard.tasks"))).toBeDefined();
        }
    );
});

function expectAgentCoreError(
    action: () => void,
    code: AgentCoreError["code"],
    message: RegExp
): void {
    try {
        action();
        throw new TypeError("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code, message: expect.stringMatching(message) });
    }
}

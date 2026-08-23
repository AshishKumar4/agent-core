import { describe, expect, test } from "vitest";
import { Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { WorkspaceId } from "../../src/identity";
import { SettingsLayer } from "../../src/facets";
import { MemoryWorkspaceSettingsStore } from "../../src/facets/settings-memory";
import {
    layer,
    workspaceSettingsStoreContract
} from "../w3/settings-store-contract";
import { attribution } from "../w3/slot-store-contract";

workspaceSettingsStoreContract(
    "Memory",
    (owner) => new MemoryWorkspaceSettingsStore(owner)
);

describe("MemoryWorkspaceSettingsStore", () => {
    test("owns its Workspace and refuses a nested transaction", { tags: "p1" }, () => {
        const store = new MemoryWorkspaceSettingsStore(new WorkspaceId("workspace"));

        expect(store.owner.value).toBe("workspace");
        expectAgentCoreError(
            () => store.transaction(() => store.transaction((transaction) => transaction.revision)),
            "protocol.invalid-state",
            /^Nested Settings transactions are not supported$/
        );
    });

    test(
        "refuses a revision that does not advance exactly once over a changed record set",
        { tags: "p0" },
        () => {
            const store = new MemoryWorkspaceSettingsStore(new WorkspaceId("workspace"));
            const candidate = layer("workspace:facet", 0);

            expectAgentCoreError(
                () => store.transaction((transaction) => store.saveRevision(transaction, new Revision(5))),
                "protocol.revision-conflict",
                /advance exactly once/
            );
            // A layer written without advancing the revision, and a revision advanced over
            // an unchanged store, are both fabrications the commit check refuses.
            expectAgentCoreError(
                () =>
                    store.transaction((transaction) =>
                        store.insertLayer(transaction, candidate)
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
            expect(store.layers()).toHaveLength(0);
        }
    );

    test("refuses record access outside its own active transaction", { tags: "p0" }, () => {
        const store = new MemoryWorkspaceSettingsStore(new WorkspaceId("workspace"));
        const escaped = store.transaction((transaction) => transaction);
        const denied = /^Workspace Settings access requires its active transaction$/;
        const candidate = layer("workspace:facet", 0);

        for (const action of [
            () => store.loadRevision(escaped),
            () => store.saveRevision(escaped, new Revision(1)),
            () => store.loadLayer(escaped, candidate.id),
            () => store.loadLayerAt(escaped, candidate.origin),
            () => store.listLayers(escaped),
            () => store.retireLayer(escaped, candidate.id),
            () => store.insertLayer(escaped, candidate)
        ]) {
            expectAgentCoreError(action, "protocol.invalid-state", denied);
        }
    });

    test(
        "refuses a stored layer whose key does not match its codec bytes",
        { tags: "p1" },
        () => {
            const store = new MemoryWorkspaceSettingsStore(new WorkspaceId("workspace"));
            const bytes = SettingsLayer.encode(layer("workspace:facet", 0));

            expectAgentCoreError(
                () =>
                    store.transaction((transaction) => {
                        transaction.layers.set("settings:other", bytes);
                        return transaction.revision;
                    }),
                "codec.invalid",
                /^Stored Settings layer key does not match codec bytes$/
            );
            expect(store.layers()).toHaveLength(0);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] retires a withdrawn Facet's layers inside one control transaction",
        { tags: "p0" },
        () => {
            const store = new MemoryWorkspaceSettingsStore(new WorkspaceId("workspace"));
            store.contribute(layer("workspace:mine", 0));
            store.contribute(layer("workspace:theirs", 0));
            const before = store.revision().value;

            const retired = store.transaction((transaction) => {
                const changed = store.retireWithdrawalSet(transaction, attribution("workspace:mine"));
                store.saveRevision(transaction, store.loadRevision(transaction).next());
                return changed;
            });

            expect(retired).toBe(true);
            expect(store.revision().value).toBe(before + 1);
            expect(store.layers().map((held) => held.attribution.contributor.value)).toEqual([
                "workspace:theirs"
            ]);
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
        if (!(error instanceof AgentCoreError)) throw error;
        expect(error.code).toBe(code);
        expect(error.message).toMatch(message);
    }
}

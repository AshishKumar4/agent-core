import { describe, expect, test } from "vitest";
import { Revision } from "../../src/core";
import { WorkspaceId } from "../../src/identity";
import { Prompt, PromptSection } from "../../src/facets";
import { MemoryWorkspacePromptSectionStore } from "../../src/facets/prompt-memory";
import {
    section,
    workspacePromptStoreContract
} from "../w3/prompt-store-contract";
import { attribution } from "../w3/slot-store-contract";
import { expectAgentCoreError } from "../protocol/error-assertion";

workspacePromptStoreContract(
    "Memory",
    (owner) => new MemoryWorkspacePromptSectionStore(owner)
);

describe("MemoryWorkspacePromptSectionStore", () => {
    test("owns its Workspace and refuses a nested transaction", { tags: "p1" }, () => {
        const store = new MemoryWorkspacePromptSectionStore(new WorkspaceId("workspace"));

        expect(store.owner.value).toBe("workspace");
        expectAgentCoreError(
            () =>
                store.transaction(() =>
                    store.transaction((transaction) => transaction.revision)
                ),
            "protocol.invalid-state",
            /^Nested prompt section transactions are not supported$/
        );
    });

    test(
        "refuses a revision that does not advance exactly once over a changed record set",
        { tags: "p0" },
        () => {
            const store = new MemoryWorkspacePromptSectionStore(new WorkspaceId("workspace"));
            const candidate = [new Prompt("Overview", "Overview body", 1)];

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
                    store.transaction((transaction) => {
                        store.insertSection(transaction, section("workspace:facet", 0, "Overview"));
                        return transaction.revision;
                    }),
                "codec.invalid",
                /revision does not match its records/
            );
            store.contribute(attribution("workspace:facet"), candidate);
            const revision = store.revision().value;
            expectAgentCoreError(
                () =>
                    store.transaction((transaction) =>
                        store.saveRevision(transaction, new Revision(revision + 1))
                    ),
                "codec.invalid",
                /revision does not match its records/
            );
            expect(store.revision().value).toBe(revision);
        }
    );

    test("refuses record access outside its own active transaction", { tags: "p0" }, () => {
        const store = new MemoryWorkspacePromptSectionStore(new WorkspaceId("workspace"));
        const escaped = store.transaction((transaction) => transaction);
        const denied = /^Workspace prompt section access requires its active transaction$/;
        const held = section("workspace:facet", 0, "Overview");

        for (const action of [
            () => store.loadRevision(escaped),
            () => store.saveRevision(escaped, new Revision(1)),
            () => store.loadSection(escaped, held.id),
            () => store.loadSectionAt(escaped, held.origin),
            () => store.listSections(escaped),
            () => store.retireSection(escaped, held.id),
            () => store.insertSection(escaped, held)
        ]) {
            expectAgentCoreError(action, "protocol.invalid-state", denied);
        }
    });

    test(
        "refuses a stored section whose key does not match its codec bytes",
        { tags: "p1" },
        () => {
            const store = new MemoryWorkspacePromptSectionStore(new WorkspaceId("workspace"));
            const bytes = PromptSection.encode(section("workspace:facet", 0, "Overview"));

            expectAgentCoreError(
                () =>
                    store.transaction((transaction) => {
                        transaction.sections.set("prompt:other", bytes);
                        return transaction.revision;
                    }),
                "codec.invalid",
                /^Stored prompt section key does not match codec bytes$/
            );
            expect(store.assembledSections()).toHaveLength(0);
        }
    );
});

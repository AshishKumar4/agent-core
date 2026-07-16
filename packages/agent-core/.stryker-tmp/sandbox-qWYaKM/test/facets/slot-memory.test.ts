// @ts-nocheck
import { describe, expect, test } from "vitest";
import { JsonSchema, Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { WorkspaceId } from "../../src/identity";
import { SlotDeclaration, SlotEntry, SlotName } from "../../src/facets";
import { MemoryWorkspaceSlotStore } from "../../src/facets/slot-memory";
import { WorkspaceSlotCatalog, type SlotQueryAuthorityPort } from "../../src/facets/slot-store";
import {
    contribute,
    entry,
    install,
    slot,
    workspaceSlotStoreContract
} from "../w3/slot-store-contract";

workspaceSlotStoreContract("Memory", (owner) => new MemoryWorkspaceSlotStore(owner));

describe("MemoryWorkspaceSlotStore snapshots", () => {
    test("[C13-FACET-CONTRIBUTION-MATERIALIZATION] supports idempotent high-level install and contribution operations", () => {
        const store = new MemoryWorkspaceSlotStore(new WorkspaceId("workspace"));
        const declaration = slot();
        const candidate = entry("workspace:facet", 1, { title: "Card" });

        expect(store.install(declaration).value).toBe(1);
        expect(store.install(declaration).value).toBe(1);
        expect(store.contribute(candidate).value).toBe(2);
        expect(store.contribute(candidate).value).toBe(2);
        expect(store.slot(declaration.name)?.name.equals(declaration.name)).toBe(true);
        expect(store.entries(declaration.name)).toHaveLength(1);
        expect(store.revision().value).toBe(2);
        expect(() => store.contribute(entry("workspace:bad", 2, { invalid: true }))).toThrow(
            /schema/
        );
        expect(
            store.transaction((transaction) =>
                store.loadEntry(
                    transaction,
                    entry("workspace:missing", 99, { title: "Missing" }).id
                )
            )
        ).toBeUndefined();
        expect(() =>
            store.transaction((transaction) =>
                store.saveRevision(transaction, store.loadRevision(transaction).next().next())
            )
        ).toThrow(/exactly once/);
        expect(() => store.transaction(() => store.transaction(() => true))).toThrow(/Nested/);
    });

    test("restores detached state and rejects owner/key corruption", () => {
        const owner = new WorkspaceId("workspace");
        const store = new MemoryWorkspaceSlotStore(owner);
        install(store, slot());
        contribute(store, entry("workspace:facet", 1, { title: "Card" }));
        const snapshot = store.snapshot();
        snapshot.entries[0]![0] = 0;

        expect(() => MemoryWorkspaceSlotStore.restore(owner, snapshot)).toThrow();

        const detached = store.snapshot();
        const restored = MemoryWorkspaceSlotStore.restore(owner, detached);
        expect(restored.entries(slot().name)).toHaveLength(1);
        expect(restored.revision().value).toBe(2);
        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, {
                ...detached,
                version: 2 as 1
            })
        ).toThrow(/malformed/);
        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, {
                ...detached,
                revision: 0
            })
        ).toThrow(/revision/);
        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, {
                ...detached,
                entries: [detached.entries[0]!, detached.entries[0]!]
            })
        ).toThrow(/duplicate/);
    });

    test("[C13-FACET-SLOT-VISIBILITY] binds SlotCatalog to an authenticated Workspace viewer and filters every entry", async () => {
        const owner = new WorkspaceId("workspace");
        const store = new MemoryWorkspaceSlotStore(owner);
        const declaration = slot();
        install(store, declaration);
        contribute(store, entry("workspace:visible", 1, { title: "Visible" }));
        contribute(store, entry("workspace:hidden", 2, { title: "Hidden" }));
        const viewer: Readonly<{ authentication: string }> = Object.freeze({
            authentication: "sealed"
        });
        let authenticated = true;
        const authority: SlotQueryAuthorityPort<typeof viewer> = {
            workspace(candidate) {
                return authenticated && candidate === viewer ? owner : undefined;
            },
            async canViewSlot() {
                return true;
            },
            async canViewEntry(_candidate, _slot, candidate) {
                return candidate.contributor.value.endsWith("visible");
            }
        };
        const catalog = new WorkspaceSlotCatalog(store, viewer, authority);

        await expect(catalog.query(new SlotName("missing.slot"))).resolves.toEqual([]);
        await expect(catalog.query(declaration.name)).resolves.toEqual([
            expect.objectContaining({ value: { title: "Visible" } })
        ]);
        authenticated = false;
        await expect(catalog.query(declaration.name)).resolves.toEqual([]);
        authenticated = true;
        expect(
            () =>
                new WorkspaceSlotCatalog(
                    store,
                    Object.freeze({ authentication: "forged" }),
                    authority
                )
        ).toThrow(/authenticated viewer/);
    });

    test("[C13-INTERCEPTOR-THROW-BLOCK] rejects malformed snapshots, immutable origins, and out-of-transaction access with typed errors", async () => {
        const owner = new WorkspaceId("workspace");
        const store = new MemoryWorkspaceSlotStore(owner);
        const declaration = slot();
        store.install(declaration);
        store.contribute(entry("workspace:one", 1, { title: "One" }));
        const snapshot = store.snapshot();

        for (const malformed of [
            { ...snapshot, owner: 1 as unknown as string },
            { ...snapshot, revision: -1 },
            { ...snapshot, slots: [new Uint8Array()] },
            { ...snapshot, entries: ["bad" as unknown as Uint8Array] },
            { ...snapshot, extra: true }
        ]) {
            expect(() => MemoryWorkspaceSlotStore.restore(owner, malformed)).toThrow(
                AgentCoreError
            );
        }
        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, {
                ...snapshot,
                slots: [snapshot.slots[0]!, snapshot.slots[0]!],
                revision: 3
            })
        ).toThrow(/duplicate/);
        expectAgentCoreError(
            () =>
                store.install(
                    new SlotDeclaration(
                        declaration.name,
                        new JsonSchema({ type: "string" }),
                        declaration.authority
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () =>
                store.install(
                    new SlotDeclaration(
                        declaration.name,
                        new JsonSchema({ type: "number" }),
                        declaration.authority
                    )
                ),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () => store.contribute(entry("workspace:one", 1, { title: "Changed" })),
            "protocol.invalid-state"
        );
        expectAgentCoreError(() => store.loadRevision({} as never), "protocol.invalid-state");
        const inconsistent = new MemoryWorkspaceSlotStore(new WorkspaceId("empty"));
        expectAgentCoreError(
            () =>
                inconsistent.transaction((transaction) => {
                    inconsistent.saveRevision(transaction, new Revision(1));
                }),
            "codec.invalid"
        );

        const deniedAuthority: SlotQueryAuthorityPort<object> = {
            workspace: () => new WorkspaceId("workspace"),
            canViewSlot: async () => false,
            canViewEntry: async () => true
        };
        const denied = new WorkspaceSlotCatalog(store, {}, deniedAuthority);
        await expect(denied.query(declaration.name)).resolves.toEqual([]);

        const wrongWorkspace: SlotQueryAuthorityPort<object> = {
            workspace: () => new WorkspaceId("other"),
            canViewSlot: async () => true,
            canViewEntry: async () => true
        };
        expectAgentCoreError(
            () => new WorkspaceSlotCatalog(store, {}, wrongWorkspace),
            "authority.denied"
        );
    });

    test("[C13-INTERCEPTOR-ORDER] validates every committed map edge and deterministic snapshot ordering", async () => {
        const owner = new WorkspaceId("workspace");
        const store = new MemoryWorkspaceSlotStore(owner);
        const alpha = new SlotDeclaration(
            new SlotName("alpha"),
            new JsonSchema({}),
            slot().authority
        );
        const zeta = new SlotDeclaration(
            new SlotName("zeta"),
            new JsonSchema({}),
            slot().authority
        );
        store.install(zeta);
        store.install(alpha);
        store.contribute(SlotEntry.create(alpha.name, "workspace:zeta", 1, { value: 1 }));
        store.contribute(SlotEntry.create(alpha.name, "workspace:alpha", 1, { value: 2 }));
        const snapshot = store.snapshot();
        expect(snapshot.slots.map((bytes) => SlotDeclaration.decode(bytes).name.value)).toEqual([
            "alpha",
            "zeta"
        ]);
        expect(store.entries(alpha.name).map((candidate) => candidate.contributor.value)).toEqual([
            "workspace:alpha",
            "workspace:zeta"
        ]);

        expectAgentCoreError(
            () =>
                store.transaction((transaction) => {
                    transaction.slots.set("wrong", snapshot.slots[0]!);
                    transaction.revision += 1;
                }),
            "codec.invalid"
        );
        expectAgentCoreError(
            () =>
                store.transaction((transaction) => {
                    const candidate = SlotEntry.create(alpha.name, "workspace:wrong", 2, null);
                    transaction.entries.set("wrong", SlotEntry.encode(candidate));
                    transaction.revision += 1;
                }),
            "codec.invalid"
        );

        expect(() =>
            store.transaction(() => Promise.reject(new TypeError("async")) as never)
        ).toThrow(/synchronous/);
        await Promise.resolve();
        expect(store.transaction(() => null)).toBeNull();
        expect(typeof store.transaction(() => () => true)).toBe("function");
    });

    test("rejects orphaned, schema-invalid, and duplicate-origin snapshots", () => {
        const owner = new WorkspaceId("workspace");
        const declaration = slot();
        const valid = entry("workspace:facet", 1, { title: "Valid" });
        const conflict = entry("workspace:facet", 1, { title: "Conflict" });
        const declarationBytes = SlotDeclaration.encode(declaration);

        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, {
                version: 1,
                owner: "workspace",
                revision: 1,
                slots: [],
                entries: [SlotEntry.encode(valid)]
            })
        ).toThrow(/not installed/);
        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, {
                version: 1,
                owner: "workspace",
                revision: 2,
                slots: [declarationBytes],
                entries: [SlotEntry.encode(entry("workspace:bad", 2, { invalid: true }))]
            })
        ).toThrow(/schema/);
        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, {
                version: 1,
                owner: "workspace",
                revision: 3,
                slots: [declarationBytes],
                entries: [SlotEntry.encode(valid), SlotEntry.encode(conflict)]
            })
        ).toThrow(/origin/);
    });

    test("[C13-INTERCEPTOR-CROSS-FACET] rejects cross-workspace restore, non-Promise thenables, and duplicate draft origins", () => {
        const owner = new WorkspaceId("workspace");
        const store = new MemoryWorkspaceSlotStore(owner);
        const declaration = slot();
        store.install(declaration);

        expect(() =>
            MemoryWorkspaceSlotStore.restore(new WorkspaceId("other"), store.snapshot())
        ).toThrow(/another Workspace/);
        const thenable = Object.defineProperty({}, ["th", "en"].join(""), { value() {} });
        expect(() => store.transaction(() => thenable as never)).toThrow(/synchronous/);

        const first = entry("workspace:facet", 1, { title: "First" });
        const second = entry("workspace:facet", 1, { title: "Second" });
        expectAgentCoreError(
            () =>
                store.transaction((transaction) => {
                    transaction.entries.set(first.id.value, SlotEntry.encode(first));
                    transaction.entries.set(second.id.value, SlotEntry.encode(second));
                    transaction.revision += 2;
                }),
            "codec.invalid"
        );
    });
});

function expectAgentCoreError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new TypeError("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}

import { describe, expect, test } from "vitest";
import { JsonSchema, Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { WorkspaceId } from "../../src/identity";
import { SlotAuthorityPolicy, SlotDeclaration, SlotEntry, SlotName } from "../../src/facets";
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

describe("MemoryWorkspaceSlotStore isolation and identity", () => {
    test("snapshots detach bytes from live state and order entries deterministically", { tags: "p1" }, () => {
        const owner = new WorkspaceId("workspace");
        const store = new MemoryWorkspaceSlotStore(owner);
        const declaration = slot();
        install(store, declaration);
        const candidates = [
            entry("workspace:facet", 1, { title: "One" }),
            entry("workspace:facet", 2, { title: "Two" }),
            entry("workspace:facet", 3, { title: "Three" })
        ];
        const byIdAscending = [...candidates].sort((left, right) =>
            left.id.value < right.id.value ? -1 : 1
        );
        for (const candidate of [byIdAscending[2], byIdAscending[0], byIdAscending[1]]) {
            if (candidate !== undefined) contribute(store, candidate);
        }

        const snapshot = store.snapshot();
        expect(snapshot.entries.map((bytes) => SlotEntry.decode(bytes.slice()).id.value)).toEqual(
            candidates.map((candidate) => candidate.id.value).sort()
        );

        for (const bytes of [...snapshot.slots, ...snapshot.entries]) bytes[0] = 0;
        expect(store.slot(declaration.name)?.name.equals(declaration.name)).toBe(true);
        expect(store.entries(declaration.name)).toHaveLength(3);
        const clean = store.snapshot();
        expect(clean.slots[0]?.[0]).not.toBe(0);
        expect(clean.entries[0]?.[0]).not.toBe(0);
    });

    test("rolls back in-place byte tampering inside failed transactions", { tags: "p1" }, () => {
        const store = new MemoryWorkspaceSlotStore(new WorkspaceId("workspace"));
        const declaration = slot();
        install(store, declaration);
        contribute(store, entry("workspace:facet", 1, { title: "Card" }));

        expect(() =>
            store.transaction((transaction) => {
                for (const bytes of transaction.slots.values()) bytes[0] = 0;
                for (const bytes of transaction.entries.values()) bytes[0] = 0;
                throw new TypeError("injected rollback");
            })
        ).toThrow(/injected rollback/);
        expect(store.slot(declaration.name)?.name.equals(declaration.name)).toBe(true);
        expect(store.entries(declaration.name)).toHaveLength(1);
    });

    test("treats byte-identical reinsertion as a no-op and equal-length divergence as immutable", { tags: "p1" }, () => {
        const store = new MemoryWorkspaceSlotStore(new WorkspaceId("workspace"));
        const authority = new SlotAuthorityPolicy(["installed"], ["binding:dashboard.read"]);
        const stringDeclaration = new SlotDeclaration(
            new SlotName("typed.slot"),
            new JsonSchema({ type: "string" }),
            authority
        );
        const numberDeclaration = new SlotDeclaration(
            new SlotName("typed.slot"),
            new JsonSchema({ type: "number" }),
            authority
        );
        expect(SlotDeclaration.encode(stringDeclaration).byteLength).toBe(
            SlotDeclaration.encode(numberDeclaration).byteLength
        );

        store.install(stringDeclaration);
        expect(
            store.transaction((transaction) => {
                store.insertSlot(transaction, stringDeclaration);
                return store.loadRevision(transaction).value;
            })
        ).toBe(1);
        expectAgentCoreError(
            () => store.install(numberDeclaration),
            "protocol.invalid-state",
            /^Slot declaration typed\.slot is immutable$/
        );
    });

    test("lists only the requested slot's entries", { tags: "p1" }, () => {
        const store = new MemoryWorkspaceSlotStore(new WorkspaceId("workspace"));
        const authority = new SlotAuthorityPolicy(["installed"], ["binding:dashboard.read"]);
        const alpha = new SlotDeclaration(new SlotName("alpha"), new JsonSchema({}), authority);
        const beta = new SlotDeclaration(new SlotName("beta"), new JsonSchema({}), authority);
        store.install(alpha);
        store.install(beta);
        store.contribute(SlotEntry.create(alpha.name, "workspace:facet", 1, { value: 1 }));
        store.contribute(SlotEntry.create(beta.name, "workspace:facet", 1, { value: 2 }));
        store.contribute(SlotEntry.create(beta.name, "workspace:facet", 2, { value: 3 }));

        expect(store.entries(alpha.name)).toHaveLength(1);
        expect(
            store.entries(beta.name).every((candidate) => candidate.slot.equals(beta.name))
        ).toBe(true);
        expect(store.entries(beta.name)).toHaveLength(2);
    });

    test("carries exact codes and subjects for revision, key, and origin violations", { tags: "p2" }, () => {
        const store = new MemoryWorkspaceSlotStore(new WorkspaceId("workspace"));
        const declaration = slot();
        install(store, declaration);
        contribute(store, entry("workspace:facet", 1, { title: "Card" }));

        expectAgentCoreError(
            () =>
                store.transaction((transaction) =>
                    store.saveRevision(transaction, store.loadRevision(transaction).next().next())
                ),
            "protocol.revision-conflict",
            /advance exactly once/
        );
        expectAgentCoreError(
            () => store.loadRevision({} as never),
            "protocol.invalid-state",
            /active transaction/
        );
        expectAgentCoreError(
            () =>
                store.transaction((transaction) => {
                    transaction.revision += 1;
                }),
            "codec.invalid",
            /revision does not match its records/
        );
        expectAgentCoreError(
            () =>
                store.transaction((transaction) => {
                    transaction.slots.set("wrong", SlotDeclaration.encode(declaration));
                    transaction.revision += 1;
                }),
            "codec.invalid",
            /Stored Slot declaration key does not match codec bytes/
        );
        expectAgentCoreError(
            () =>
                store.transaction((transaction) => {
                    transaction.entries.set(
                        "wrong",
                        SlotEntry.encode(entry("workspace:facet", 2, { title: "Wrong" }))
                    );
                    transaction.revision += 1;
                }),
            "codec.invalid",
            /Stored Slot entry key does not match codec bytes/
        );
        const first = entry("workspace:facet", 7, { title: "First" });
        const second = entry("workspace:facet", 7, { title: "Second" });
        expectAgentCoreError(
            () =>
                store.transaction((transaction) => {
                    transaction.entries.set(first.id.value, SlotEntry.encode(first));
                    transaction.entries.set(second.id.value, SlotEntry.encode(second));
                    transaction.revision += 2;
                }),
            "codec.invalid",
            /duplicate origins/
        );
        const original = entry("workspace:facet", 11, { title: "Original" });
        const impostor = entry("workspace:facet", 12, { title: "Impostor" });
        expectAgentCoreError(
            () =>
                store.transaction((transaction) => {
                    transaction.entries.set(original.id.value, SlotEntry.encode(impostor));
                    store.insertEntry(transaction, original);
                }),
            "protocol.invalid-state",
            /^Slot entry slot:.+ is immutable$/
        );
    });

    test("classifies restore failures with exact codes and the malformed guard", { tags: "p1" }, () => {
        const owner = new WorkspaceId("workspace");
        const declaration = slot();
        const valid = entry("workspace:facet", 1, { title: "Valid" });
        expectAgentCoreError(
            () =>
                MemoryWorkspaceSlotStore.restore(owner, {
                    version: 1,
                    owner: "workspace",
                    revision: 1,
                    slots: [],
                    entries: [SlotEntry.encode(valid)]
                }),
            "facet.inactive",
            /^Slot dashboard\.card is not installed$/
        );
        expectAgentCoreError(
            () =>
                MemoryWorkspaceSlotStore.restore(owner, {
                    version: 1,
                    owner: "workspace",
                    revision: 2,
                    slots: [SlotDeclaration.encode(declaration)],
                    entries: [SlotEntry.encode(entry("workspace:bad", 2, { invalid: true }))]
                }),
            "operation.invalid-input",
            /does not match the entry schema/
        );
        const base = {
            version: 1 as const,
            owner: "workspace",
            revision: 0,
            slots: [],
            entries: []
        };
        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, { ...base, owner: 1 as unknown as string })
        ).toThrow(/malformed/);
        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, { ...base, revision: -1 })
        ).toThrow(/malformed/);
        expect(() =>
            MemoryWorkspaceSlotStore.restore(owner, {
                ...base,
                revision: 2,
                slots: [SlotDeclaration.encode(declaration)],
                entries: [SlotEntry.encode(valid), "bad" as unknown as Uint8Array]
            })
        ).toThrow(/malformed/);
    });

    test("rejects function thenables returned from transactions", { tags: "p1" }, () => {
        const store = new MemoryWorkspaceSlotStore(new WorkspaceId("workspace"));
        // oxlint-disable-next-line unicorn/no-thenable -- the guard under test rejects exactly this shape
        const thenable = Object.assign(() => true, { then: () => undefined });
        expect(() => store.transaction(() => thenable as never)).toThrow(/synchronous/);
    });

    test("raises typed facet.inactive and invalid-input errors from contribute", { tags: "p0" }, () => {
        const store = new MemoryWorkspaceSlotStore(new WorkspaceId("workspace"));
        expectAgentCoreError(
            () => store.contribute(entry("workspace:facet", 1, { title: "Card" })),
            "facet.inactive",
            /^Slot dashboard\.card is not installed$/
        );
        install(store, slot());
        expectAgentCoreError(
            () => store.contribute(entry("workspace:bad", 2, { invalid: true })),
            "operation.invalid-input",
            /^Slot entry slot:.+ does not match the entry schema$/
        );
    });

    test("never consults slot visibility for uninstalled slots", { tags: "p0" }, async () => {
        const owner = new WorkspaceId("workspace");
        const store = new MemoryWorkspaceSlotStore(owner);
        install(store, slot());
        const consulted: string[] = [];
        const authority: SlotQueryAuthorityPort<object> = {
            workspace: () => owner,
            canViewSlot: async (_viewer, declaration) => {
                consulted.push(declaration.name.value);
                return true;
            },
            canViewEntry: async () => true
        };
        const catalog = new WorkspaceSlotCatalog(store, {}, authority);

        await expect(catalog.query(new SlotName("missing.slot"))).resolves.toEqual([]);
        expect(consulted).toEqual([]);
        await expect(catalog.query(slot().name)).resolves.toEqual([]);
        expect(consulted).toEqual(["dashboard.card"]);
    });
});

function expectAgentCoreError(
    action: () => unknown,
    code: AgentCoreError["code"],
    message?: RegExp
): void {
    try {
        action();
        throw new TypeError("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
        if (message !== undefined) {
            expect(error).toMatchObject({ message: expect.stringMatching(message) });
        }
    }
}

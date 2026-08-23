import { describe, expect, test } from "vitest";
import { WorkspaceId } from "../../src/identity";
import { CatalogEntry } from "../../src/facets/catalog-entry";
import {
    MemoryWorkspaceCatalogStore,
    type MemoryWorkspaceCatalogSnapshot
} from "../../src/facets/catalog-entry-memory";
import {
    attributed,
    directDeclaration,
    withHelp,
    workspaceCatalogStoreContract
} from "../w3/catalog-store-contract";
import { attribution } from "../w3/slot-store-contract";
import { malformed } from "../helpers/malformed";

workspaceCatalogStoreContract("Memory", (owner) => new MemoryWorkspaceCatalogStore(owner));

describe("MemoryWorkspaceCatalogStore", () => {
    test("owns its Workspace and refuses a nested transaction", () => {
        const store = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));

        expect(store.owner.value).toBe("workspace");
        expect(() => store.transaction(() => store.transaction(() => 0))).toThrow(
            /Nested Catalog transactions/
        );
    });

    test("refuses record access outside its own active transaction", () => {
        const store = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        store.declare(directDeclaration("run"));
        const escaped = store.transaction((transaction) => transaction);

        expect(() => store.loadRevision(escaped)).toThrow(
            /Workspace Catalog access requires its active transaction/
        );
        expect(() => store.listEntries(escaped)).toThrow(
            /Workspace Catalog access requires its active transaction/
        );
        const foreign = new MemoryWorkspaceCatalogStore(new WorkspaceId("other"));
        // SAFETY: only a state handle stolen across stores reaches the guard that refuses
        // record access outside its own active transaction.
        const stolen = { revision: 0, entries: new Map() } as never;
        expect(() => foreign.loadRevision(stolen)).toThrow(/active transaction/);
    });

    test("[C13-FACET-CONTRIBUTION-ATTRIBUTION] decodes every stored entry on read, so corrupted bytes are refused", () => {
        const store = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        store.contribute(attributed("workspace:facet", "1.0.0", "resize"));
        // The snapshot is the only sanctioned view of the raw bytes; a flipped byte must be
        // refused at restore rather than decoded into a wrong record.
        const snapshot = store.snapshot();
        const tampered = [...snapshot.entries];
        const corrupted = tampered[0]!.slice();
        corrupted[0] = corrupted[0]! ^ 0xff;
        tampered[0] = corrupted;

        expect(() =>
            MemoryWorkspaceCatalogStore.restore(new WorkspaceId("workspace"), {
                ...snapshot,
                entries: tampered
            })
        ).toThrow();
    });

    test("restores a snapshot to a byte-identical store (restart parity)", () => {
        const store = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        store.declare(directDeclaration("run"));
        store.contribute(attributed("workspace:facet", "1.0.0", "resize"));
        store.contribute(attributed("workspace:facet", "2.0.0", "crop"));
        const snapshot = store.snapshot();

        const restored = MemoryWorkspaceCatalogStore.restore(new WorkspaceId("workspace"), snapshot);

        expect(restored.snapshot()).toEqual(snapshot);
        expect(restored.revision().value).toBe(store.revision().value);
        expect([...store.entries()].map(CatalogEntry.encode)).toEqual(
            [...restored.entries()].map(CatalogEntry.encode)
        );
        expect(
            restored
                .entries()
                .filter((entry) => entry.attribution !== undefined)
                .flatMap((entry) => entry.attribution!.package.version.toString())
                .sort()
        ).toEqual(["1.0.0", "2.0.0"]);
        // A restarted store withdraws only the exact release. The later release of the
        // same Facet and the direct declaration remain live.
        const before = restored.revision().value;
        expect(restored.withdraw(attribution("workspace:facet")).value).toBe(before + 1);
        expect(
            restored
                .entries()
                .map(
                    (entry) =>
                        `${entry.name}:${entry.attribution?.package.version.toString() ?? "direct"}`
                )
                .sort()
        ).toEqual(["crop:2.0.0", "run:direct"]);
    });

    test("refuses a malformed or foreign snapshot", () => {
        const store = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        store.contribute(attributed("workspace:facet", "1.0.0", "resize"));
        const snapshot = store.snapshot();

        expect(() =>
            MemoryWorkspaceCatalogStore.restore(new WorkspaceId("foreign"), snapshot)
        ).toThrow(/belongs to another Workspace/);
        // A malformed snapshot needs no real bytes: the version check fires first.
        const wrongVersion = malformed<MemoryWorkspaceCatalogSnapshot>({
            version: 2,
            owner: "workspace",
            revision: 0,
            entries: []
        });
        expect(() =>
            MemoryWorkspaceCatalogStore.restore(new WorkspaceId("workspace"), wrongVersion)
        ).toThrow(/malformed/);
        const negativeRevision = malformed<MemoryWorkspaceCatalogSnapshot>({
            version: 1,
            owner: "workspace",
            revision: -1,
            entries: []
        });
        expect(() =>
            MemoryWorkspaceCatalogStore.restore(new WorkspaceId("workspace"), negativeRevision)
        ).toThrow(/malformed/);
        expect(() =>
            MemoryWorkspaceCatalogStore.restore(new WorkspaceId("workspace"), {
                ...snapshot,
                entries: [...snapshot.entries, ...snapshot.entries]
            })
        ).toThrow(/duplicate entries/);
    });

    test("refuses a second record at one owner's origin behind a fabricated write", () => {
        const store = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        const held = attributed("workspace:mine", "1.0.0", "resize");

        expect(() =>
            store.transaction((transaction) => {
                store.insertEntry(transaction, held);
                store.insertEntry(transaction, withHelp("workspace:mine", "1.0.0", "Other"));
            })
        ).toThrow(/Catalog operation resize is already held by workspace:mine/);
    });
});

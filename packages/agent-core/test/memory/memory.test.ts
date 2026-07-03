import { describe, expect, test } from "vitest";
import { AsyncFileSystem } from "../../src/facets/filesystem/async";
import { MemoryFileSystem } from "../../src/facets/filesystem/memory/memory";
import { FilePath } from "../../src/facets/filesystem/path";
import { TreeMode } from "../../src/facets/filesystem/tree";
import { MemoryStore } from "../../src/facets/memory/store";
import { SQLiteMemoryIndex } from "../../src/substrates/sqlite";
import { TestSqlite } from "../filesystem/sqlite";
import { testOperationContext } from "../helpers/context";

const context = testOperationContext("memory");

function setup(): {
    store: MemoryStore;
    files: MemoryFileSystem;
} {
    const files = new MemoryFileSystem();
    files.makeDirectory(context, FilePath.parse("memory"), TreeMode.tree);
    const index = new SQLiteMemoryIndex(new TestSqlite());
    const store = new MemoryStore(new AsyncFileSystem(files), context, index);
    store.ensureSchema();
    return { store, files };
}

describe("MemoryStore", () => {
    test("writes, appends, reads line ranges, and lists files", async () => {
        const { store } = setup();

        await store.writeFile("memory/notes.md", "one\ntwo\nthree");
        await store.appendToFile("memory/notes.md", "\nfour");

        expect(await store.readFile("memory/notes.md")).toBe("one\ntwo\nthree\nfour");
        expect(await store.readFile("memory/notes.md", { start: 2, end: 3 })).toBe("two\nthree");
        expect(await store.readFile("memory/missing.md")).toBeNull();
        expect(await store.listFiles()).toEqual(["notes.md"]);
    });

    test("indexes and searches with the established AND-to-OR fallback", async () => {
        const { store } = setup();

        await store.indexFile("memory/alpha.md", "alpha beta shared context");
        await store.indexFile("memory/beta.md", "beta independent context");

        const results = store.search("alpha beta", 10);

        expect(results.map(result => result.path)).toEqual([
            "memory/alpha.md",
            "memory/beta.md"
        ]);
        expect(results[0]?.startLine).toBe(1);
        expect(results[0]?.snippet).toContain("alpha beta");
    });

    test("rebuilds recursively from eligible filesystem paths", async () => {
        const { store, files } = setup();
        files.makeDirectory(context, FilePath.parse("memory/nested/deep"), TreeMode.tree);
        await store.writeFile("memory/MEMORY.md", "curated lighthouse");
        await store.writeFile("memory/nested/deep/note.md", "nested compass");
        await store.writeFile("memory/nested/deep/ignored.txt", "not indexed");

        const result = await store.rebuildIndex();

        expect(result).toEqual({ indexed: 2, pruned: 0, skipped: 0 });
        expect(store.search("lighthouse")[0]?.path).toBe("memory/MEMORY.md");
        expect(store.search("compass")[0]?.path).toBe("memory/nested/deep/note.md");
        expect(store.search("ignored")).toEqual([]);
    });

    test("does not replace an index with stale content", async () => {
        const { store } = setup();
        await store.writeFile("memory/current.md", "current truth");
        await store.indexFile("memory/current.md", "previous truth");

        expect(await store.indexFileIfCurrent("memory/current.md", "previous truth")).toBe(false);
        expect(store.search("previous")[0]?.path).toBe("memory/current.md");
        expect(store.search("current")).toEqual([]);
    });

    test("prunes indexed files that disappeared", async () => {
        const { store, files } = setup();
        await store.writeFile("memory/transient.md", "temporary beacon");
        await store.rebuildIndex();
        files.remove(context, FilePath.parse("memory/transient.md"), TreeMode.node);

        const result = await store.rebuildIndex({ pruneMissing: true });

        expect(result.pruned).toBe(1);
        expect(store.search("beacon")).toEqual([]);
    });
});

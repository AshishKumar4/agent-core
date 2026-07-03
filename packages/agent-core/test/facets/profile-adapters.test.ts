import { describe, expect, test } from "vitest";
import { BindingSet } from "../../src/agents";
import {
    BindingName,
    FacetContext,
    FacetId,
    FacetOperationName,
    OperationAddress
} from "../../src/facets";
import { isFacetDataMap } from "../../src/facets/data";
import { AsyncFileSystem } from "../../src/facets/filesystem/async";
import { FileSystemFacet } from "../../src/facets/filesystem/facet";
import { MemoryFileSystem } from "../../src/facets/filesystem/memory/memory";
import { FilePath } from "../../src/facets/filesystem/path";
import { TreeMode } from "../../src/facets/filesystem/tree";
import { MemoryFacet } from "../../src/facets/memory";
import { MemoryStore } from "../../src/facets/memory/store";
import { createShell, ShellFacet } from "../../src/facets/shell";
import { NoopTelemetry } from "../../src/observability";
import { SQLiteMemoryIndex } from "../../src/substrates/sqlite";
import { TestSqlite } from "../filesystem/sqlite";
import { testOperationContext } from "../helpers/context";

function facetContext(name: string): FacetContext {
    const binding = new BindingName(name);
    return new FacetContext(
        new FacetId(`facet-${name}`),
        binding,
        testOperationContext(`facet-${name}`, binding),
        new NoopTelemetry()
    );
}

function operation(binding: string, name: string): OperationAddress {
    return new OperationAddress(new BindingName(binding), new FacetOperationName(name));
}

function context(bindings: BindingSet, binding: string) {
    const bindingName = new BindingName(binding);
    return testOperationContext(
        `operation-${binding}`,
        bindingName,
        bindings.authorityFor(bindingName),
        bindings
    );
}

describe("profile Facet adapters", () => {
    test("exposes filesystem operations through a bound Facet", async () => {
        const files = new AsyncFileSystem(new MemoryFileSystem());
        const bindings = BindingSet.of([
            new FileSystemFacet(facetContext("fs"), files)
        ]);
        await bindings.facets.start(context(bindings, "fs"));

        const write = bindings.operations().resolve(operation("fs", "writeText"));
        const read = bindings.operations().resolve(operation("fs", "readText"));
        if (write === undefined || read === undefined) {
            throw new Error("Expected filesystem operations");
        }

        await write.execute(context(bindings, "fs"), {
            path: "note.txt",
            content: "hello",
            mode: "create"
        });
        const output = await read.execute(context(bindings, "fs"), { path: "note.txt" });

        expect(output).toEqual({ content: "hello" });
    });

    test("exposes shell execution through a bound Facet", async () => {
        const files = new AsyncFileSystem(new MemoryFileSystem());
        const shell = createShell(files, testOperationContext("shell-service"));
        const bindings = BindingSet.of([
            new ShellFacet(facetContext("shell"), shell)
        ]);
        await bindings.facets.start(context(bindings, "shell"));
        const exec = bindings.operations().resolve(operation("shell", "exec"));
        if (exec === undefined) {
            throw new Error("Expected shell exec operation");
        }

        const output = await exec.execute(context(bindings, "shell"), {
            command: "printf 'hello'"
        });

        expect(output).toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
    });

    test("exposes memory operations through a bound Facet", async () => {
        const syncFiles = new MemoryFileSystem();
        syncFiles.makeDirectory(testOperationContext("memory-root"), FilePath.parse("memory"), TreeMode.tree);
        const store = new MemoryStore(
            new AsyncFileSystem(syncFiles),
            testOperationContext("memory-store"),
            new SQLiteMemoryIndex(new TestSqlite())
        );
        store.ensureSchema();
        const bindings = BindingSet.of([
            new MemoryFacet(facetContext("memory"), store)
        ]);
        await bindings.facets.start(context(bindings, "memory"));
        const write = bindings.operations().resolve(operation("memory", "write"));
        const read = bindings.operations().resolve(operation("memory", "read"));
        const rebuild = bindings.operations().resolve(operation("memory", "rebuild"));
        const search = bindings.operations().resolve(operation("memory", "search"));
        if (write === undefined || read === undefined || rebuild === undefined || search === undefined) {
            throw new Error("Expected memory operations");
        }

        await write.execute(context(bindings, "memory"), {
            path: "memory/note.md",
            content: "alpha beta memory"
        });
        expect(await read.execute(context(bindings, "memory"), { path: "memory/note.md" }))
            .toEqual({ content: "alpha beta memory" });
        await rebuild.execute(context(bindings, "memory"), {});
        const results = await search.execute(context(bindings, "memory"), { query: "alpha", limit: 5 });
        if (!isFacetDataMap(results)) {
            throw new Error("Expected memory search result object");
        }
        const resultList = results["results"];
        if (!Array.isArray(resultList)) {
            throw new Error("Expected memory search result list");
        }
        const first = resultList[0];
        if (!isFacetDataMap(first)) {
            throw new Error("Expected first memory search result");
        }

        expect(resultList).toHaveLength(1);
        expect(first["path"]).toBe("memory/note.md");
        expect(first["startLine"]).toBe(1);
        expect(first["endLine"]).toBe(1);
        expect(first["snippet"]).toBe("alpha beta memory");
        expect(first["score"]).toBeGreaterThan(0);
    });
});

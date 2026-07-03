import { AuthoritySummary, FacetDescription } from "../description";
import { Facet } from "../facet";
import type { FacetContext } from "../context";
import { FacetDataSchemas, type FacetDataMap } from "../data";
import { FacetOperationName, FacetVersion } from "../id";
import { FacetOperation, FacetOperationHandler, OperationDescriptor, OperationSet } from "../operation";
import type { OperationContext } from "../../operations";
import type { MemorySearchResult } from "./query";
import type { RebuildIndexResult } from "./store";
import { MemoryStore } from "./store";

const version = new FacetVersion("1.0.0");

export class MemoryFacet extends Facet {
    public constructor(
        context: FacetContext,
        private readonly memory: MemoryStore
    ) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Memory",
            "Reads, writes, indexes, and searches workspace memory.",
            version,
            AuthoritySummary.scoped("Reads and mutates the bound memory store.")
        );
    }

    public operations(): OperationSet {
        return OperationSet.of([
            operation("read", "Read a memory file.", "observe", new ReadHandler(this.memory)),
            operation("write", "Write a memory file.", "mutate", new WriteHandler(this.memory)),
            operation("append", "Append to a memory file.", "mutate", new AppendHandler(this.memory)),
            operation("search", "Search indexed memory.", "observe", new SearchHandler(this.memory)),
            operation("list", "List memory files.", "observe", new ListHandler(this.memory)),
            operation("rebuild", "Rebuild the memory index.", "mutate", new RebuildHandler(this.memory))
        ]);
    }
}

function operation(
    name: string,
    description: string,
    impact: "observe" | "mutate",
    handler: FacetOperationHandler<FacetDataMap, FacetDataMap>
): FacetOperation<FacetDataMap, FacetDataMap> {
    return new FacetOperation(
        new OperationDescriptor(
            new FacetOperationName(name),
            description,
            impact,
            FacetDataSchemas.object(),
            FacetDataSchemas.object()
        ),
        handler
    );
}

abstract class MemoryHandler extends FacetOperationHandler<FacetDataMap, FacetDataMap> {
    public constructor(protected readonly memory: MemoryStore) {
        super();
    }
}

class ReadHandler extends MemoryHandler {
    public async execute(_context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        return { content: await this.memory.readFile(stringField(input, "path")) };
    }
}

class WriteHandler extends MemoryHandler {
    public async execute(_context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        await this.memory.writeFile(stringField(input, "path"), stringField(input, "content"));
        return { ok: true };
    }
}

class AppendHandler extends MemoryHandler {
    public async execute(_context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        await this.memory.appendToFile(stringField(input, "path"), stringField(input, "content"));
        return { ok: true };
    }
}

class SearchHandler extends MemoryHandler {
    public execute(_context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        return Promise.resolve({
            results: this.memory.search(
                stringField(input, "query"),
                integerField(input, "limit", 10)
            ).map(searchResultData)
        });
    }
}

class ListHandler extends MemoryHandler {
    public async execute(_context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        return { files: await this.memory.listFiles(optionalStringField(input, "prefix")) };
    }
}

class RebuildHandler extends MemoryHandler {
    public async execute(_context: OperationContext, _input: FacetDataMap): Promise<FacetDataMap> {
        return rebuildData(await this.memory.rebuildIndex());
    }
}

function searchResultData(result: MemorySearchResult): FacetDataMap {
    return {
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        snippet: result.snippet,
        score: result.score
    };
}

function rebuildData(result: RebuildIndexResult): FacetDataMap {
    return {
        indexed: result.indexed,
        pruned: result.pruned,
        skipped: result.skipped
    };
}

function stringField(input: FacetDataMap, field: string): string {
    const value = input[field];
    if (typeof value !== "string") {
        throw new TypeError(`${field} must be a string`);
    }

    return value;
}

function optionalStringField(input: FacetDataMap, field: string): string | undefined {
    const value = input[field];
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new TypeError(`${field} must be a string`);
    }

    return value;
}

function integerField(input: FacetDataMap, field: string, fallback: number): number {
    const value = input[field];
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a nonnegative safe integer`);
    }

    return value;
}

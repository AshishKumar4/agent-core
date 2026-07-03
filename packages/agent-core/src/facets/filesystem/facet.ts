import { AuthoritySummary, FacetDescription } from "../description";
import { Facet } from "../facet";
import type { FacetContext } from "../context";
import { FacetDataSchemas, type FacetData, type FacetDataMap } from "../data";
import { FacetOperationName, FacetVersion } from "../id";
import { FacetOperation, FacetOperationHandler, OperationDescriptor, OperationSet } from "../operation";
import type { OperationContext } from "../../operations";
import { Durability } from "./durability";
import type { FileEntry } from "./entry";
import type { FileSystem } from "./filesystem";
import { ReplaceMode } from "./move";
import { ListPosition } from "./page";
import { FilePath } from "./path";
import { ReadRange } from "./range";
import type { MutationReceipt } from "./receipt";
import { TreeMode } from "./tree";
import { WriteMode } from "./write";

const version = new FacetVersion("1.0.0");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class FileSystemFacet extends Facet {
    public constructor(
        context: FacetContext,
        private readonly files: FileSystem
    ) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Filesystem",
            "Exposes substrate-neutral filesystem operations.",
            version,
            AuthoritySummary.scoped("Reads and mutates files through the bound filesystem.")
        );
    }

    public operations(): OperationSet {
        return OperationSet.of([
            operation("stat", "Stat a path.", "observe", new StatHandler(this.files)),
            operation("readText", "Read UTF-8 text from a file.", "observe", new ReadTextHandler(this.files)),
            operation("writeText", "Write UTF-8 text to a file.", "mutate", new WriteTextHandler(this.files)),
            operation("list", "List directory entries.", "observe", new ListHandler(this.files)),
            operation("makeDirectory", "Create a directory.", "mutate", new MakeDirectoryHandler(this.files)),
            operation("remove", "Remove a file or directory.", "mutate", new RemoveHandler(this.files)),
            operation("move", "Move a file or directory.", "mutate", new MoveHandler(this.files)),
            operation("flush", "Flush pending filesystem mutations.", "mutate", new FlushHandler(this.files))
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

abstract class FileSystemHandler extends FacetOperationHandler<FacetDataMap, FacetDataMap> {
    public constructor(protected readonly files: FileSystem) {
        super();
    }
}

class StatHandler extends FileSystemHandler {
    public async execute(context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        return entryData(await this.files.stat(context, pathInput(input)));
    }
}

class ReadTextHandler extends FileSystemHandler {
    public async execute(context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        const content = await this.files.read(context, pathInput(input), rangeInput(input));
        return { content: textDecoder.decode(content) };
    }
}

class WriteTextHandler extends FileSystemHandler {
    public async execute(context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        return receiptData(await this.files.write(
            context,
            pathInput(input),
            textEncoder.encode(stringField(input, "content")),
            writeMode(input["mode"]),
            durability(input["durability"])
        ));
    }
}

class ListHandler extends FileSystemHandler {
    public async execute(context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        const page = await this.files.list(
            context,
            pathInput(input, ""),
            ListPosition.first(),
            integerField(input, "limit", 256)
        );

        return {
            entries: page.entries.map(entryData),
            complete: page.continuation.complete
        };
    }
}

class MakeDirectoryHandler extends FileSystemHandler {
    public async execute(context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        return receiptData(await this.files.makeDirectory(context, pathInput(input), treeMode(input["recursive"])));
    }
}

class RemoveHandler extends FileSystemHandler {
    public async execute(context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        return receiptData(await this.files.remove(context, pathInput(input), treeMode(input["recursive"])));
    }
}

class MoveHandler extends FileSystemHandler {
    public async execute(context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        return receiptData(await this.files.move(
            context,
            pathInput(input, "source"),
            pathInput(input, "destination"),
            replaceMode(input["replace"])
        ));
    }
}

class FlushHandler extends FileSystemHandler {
    public async execute(context: OperationContext, _input: FacetDataMap): Promise<FacetDataMap> {
        return receiptData(await this.files.flush(context));
    }
}

function pathInput(input: FacetDataMap, field = "path"): FilePath {
    return FilePath.parse(stringField(input, field));
}

function rangeInput(input: FacetDataMap): ReadRange {
    const offset = input["offset"];
    const length = input["length"];
    if (offset === undefined) {
        return ReadRange.all();
    }

    if (length === undefined) {
        return ReadRange.from(integerValue(offset, "offset"));
    }

    return ReadRange.slice(integerValue(offset, "offset"), integerValue(length, "length"));
}

function writeMode(value: FacetData | undefined): WriteMode {
    switch (value ?? "upsert") {
        case "create":
            return WriteMode.create;
        case "replace":
            return WriteMode.replace;
        case "upsert":
            return WriteMode.upsert;
        default:
            throw new TypeError("Filesystem write mode must be create, replace, or upsert");
    }
}

function durability(value: FacetData | undefined): Durability {
    switch (value ?? "accepted") {
        case "accepted":
            return Durability.accepted;
        case "buffered":
            return Durability.buffered;
        case "durable":
            return Durability.durable;
        default:
            throw new TypeError("Filesystem durability must be accepted, buffered, or durable");
    }
}

function treeMode(value: FacetData | undefined): TreeMode {
    return value === true ? TreeMode.tree : TreeMode.node;
}

function replaceMode(value: FacetData | undefined): ReplaceMode {
    return value === true ? ReplaceMode.replace : ReplaceMode.preserve;
}

function stringField(input: FacetDataMap, field: string): string {
    const value = input[field];
    if (typeof value !== "string") {
        throw new TypeError(`${field} must be a string`);
    }

    return value;
}

function integerField(input: FacetDataMap, field: string, fallback: number): number {
    const value = input[field];
    return value === undefined ? fallback : integerValue(value, field);
}

function integerValue(value: FacetData, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a nonnegative safe integer`);
    }

    return value;
}

function entryData(entry: FileEntry): FacetDataMap {
    return {
        path: entry.path.toString(),
        kind: entry.kind.name,
        size: entry.size,
        modifiedAt: entry.modifiedAt
    };
}

function receiptData(receipt: MutationReceipt): FacetDataMap {
    return {
        operationId: receipt.operation.value,
        completion: receipt.completion.name
    };
}

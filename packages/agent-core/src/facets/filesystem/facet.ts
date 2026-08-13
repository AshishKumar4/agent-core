import { isMember } from "../../core";
import { Contributions, Contribution, OperationDescriptor } from "../contribution";
import type { FacetData } from "../data";
import {
    dataRecord,
    requireBytes,
    requireDataObject,
    requireSafeInteger,
    requireString
} from "../data";
import { OperationName, SlotName } from "../id";
import type { FacetManifest } from "../manifest";
import {
    InternalProfileFacetRuntime,
    ProfileOperationContract,
    profileWireCodec,
    type ProtectedProfileRuntimePort,
    type ProfileWireCodec,
    type PublicProfileInput,
    schema,
    strictObjectSchema,
    voidProfileWireCodec
} from "../profile-runtime";

export type FilesystemEntryKind = "file" | "directory";
const FILESYSTEM_WRITE_MODES = ["create", "replace", "upsert"] as const;

export type FilesystemWriteMode = (typeof FILESYSTEM_WRITE_MODES)[number];

export interface FilesystemStat {
    readonly path: string;
    readonly kind: FilesystemEntryKind;
    readonly size: number;
    readonly modifiedAt: number;
}

export interface FilesystemReadRange {
    readonly offset?: number;
    readonly length?: number;
}

export interface FilesystemPage {
    readonly entries: readonly FilesystemStat[];
    readonly cursor?: string;
}

export interface FilesystemReadInput extends PublicProfileInput {
    readonly path: string;
    readonly range?: FilesystemReadRange;
}

export interface FilesystemStatInput extends PublicProfileInput {
    readonly path: string;
}

export interface FilesystemListInput extends PublicProfileInput {
    readonly path: string;
    readonly cursor?: string;
    readonly limit?: number;
}

export interface FilesystemWriteInput extends PublicProfileInput {
    readonly path: string;
    readonly content: Uint8Array;
    readonly mode?: FilesystemWriteMode;
}

export interface FilesystemRemoveInput extends PublicProfileInput {
    readonly path: string;
}

export interface FilesystemMoveInput extends PublicProfileInput {
    readonly source: string;
    readonly destination: string;
}

export interface FilesystemMkdirInput extends PublicProfileInput {
    readonly path: string;
    readonly recursive?: boolean;
}

const pathProperty = { type: "string", minLength: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const statSchema = {
    type: "object",
    properties: {
        path: pathProperty,
        kind: { enum: ["file", "directory"] },
        size: nonNegativeInteger,
        modifiedAt: nonNegativeInteger
    },
    required: ["path", "kind", "size", "modifiedAt"],
    additionalProperties: false
} as const;
const voidSchema = schema({ type: "null" });

function operation<
    Name extends string,
    Input extends PublicProfileInput,
    Output,
    Mode extends "output" | "receipt"
>(
    name: Name,
    impact: "observe" | "mutate",
    input: ReturnType<typeof strictObjectSchema>,
    output: ReturnType<typeof schema>,
    inputCodec: ProfileWireCodec<Input>,
    outputCodec: ProfileWireCodec<Output>,
    resultMode: Mode
): ProfileOperationContract<Name, Input, Output, Mode> {
    return new ProfileOperationContract(
        name,
        new OperationDescriptor(new OperationName(name), impact, input, output),
        inputCodec,
        outputCodec,
        resultMode
    );
}

export const FILESYSTEM_OPERATION_CONTRACTS = Object.freeze({
    read: operation<"read", FilesystemReadInput, Uint8Array, "output">(
        "read",
        "observe",
        strictObjectSchema(
            {
                path: pathProperty,
                range: {
                    type: "object",
                    properties: { offset: nonNegativeInteger, length: nonNegativeInteger },
                    additionalProperties: false
                }
            },
            ["path"]
        ),
        schema({ type: "array", items: { type: "integer", minimum: 0, maximum: 255 } }),
        profileWireCodec(
            (input) =>
                dataRecord({
                    path: input.path,
                    range:
                        input.range === undefined
                            ? undefined
                            : dataRecord({
                                  offset: input.range.offset,
                                  length: input.range.length
                              })
                }),
            (data) => {
                const object = requireDataObject(data, "Filesystem read input");
                const range = object["range"];
                const input: FilesystemReadInput = {
                    path: requireString(object["path"], "Filesystem read path")
                };
                return range === undefined ? input : { ...input, range: decodeRange(range) };
            }
        ),
        byteCodec(),
        "output"
    ),
    stat: operation<"stat", FilesystemStatInput, FilesystemStat, "output">(
        "stat",
        "observe",
        strictObjectSchema({ path: pathProperty }, ["path"]),
        schema(statSchema),
        pathInputCodec((path) => ({ path })),
        statCodec(),
        "output"
    ),
    list: operation<"list", FilesystemListInput, FilesystemPage, "output">(
        "list",
        "observe",
        strictObjectSchema(
            { path: pathProperty, cursor: pathProperty, limit: { type: "integer", minimum: 1 } },
            ["path"]
        ),
        schema({
            type: "object",
            properties: {
                entries: { type: "array", items: statSchema },
                cursor: pathProperty
            },
            required: ["entries"],
            additionalProperties: false
        }),
        profileWireCodec(
            (input) => dataRecord({ path: input.path, cursor: input.cursor, limit: input.limit }),
            (data) => {
                const object = requireDataObject(data, "Filesystem list input");
                const cursor = object["cursor"];
                const limit = object["limit"];
                let input: FilesystemListInput = {
                    path: requireString(object["path"], "Filesystem list path")
                };
                if (cursor !== undefined) {
                    input = { ...input, cursor: requireString(cursor, "Filesystem list cursor") };
                }
                if (limit !== undefined) {
                    input = {
                        ...input,
                        limit: requireSafeInteger(limit, "Filesystem list limit")
                    };
                }
                return input;
            }
        ),
        pageCodec(),
        "output"
    ),
    write: operation<"write", FilesystemWriteInput, void, "receipt">(
        "write",
        "mutate",
        strictObjectSchema(
            {
                path: pathProperty,
                content: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 } },
                mode: { enum: ["create", "replace", "upsert"] }
            },
            ["path", "content"]
        ),
        voidSchema,
        profileWireCodec(
            (input) =>
                dataRecord({
                    path: input.path,
                    content: [...input.content],
                    mode: input.mode
                }),
            decodeWriteInput
        ),
        voidProfileWireCodec,
        "receipt"
    ),
    remove: operation<"remove", FilesystemRemoveInput, void, "receipt">(
        "remove",
        "mutate",
        strictObjectSchema({ path: pathProperty }, ["path"]),
        voidSchema,
        pathInputCodec((path) => ({ path })),
        voidProfileWireCodec,
        "receipt"
    ),
    move: operation<"move", FilesystemMoveInput, void, "receipt">(
        "move",
        "mutate",
        strictObjectSchema({ source: pathProperty, destination: pathProperty }, [
            "source",
            "destination"
        ]),
        voidSchema,
        profileWireCodec(
            (input) => ({ source: input.source, destination: input.destination }),
            (data) => {
                const object = requireDataObject(data, "Filesystem move input");
                return {
                    source: requireString(object["source"], "Filesystem move source"),
                    destination: requireString(object["destination"], "Filesystem move destination")
                };
            }
        ),
        voidProfileWireCodec,
        "receipt"
    ),
    mkdir: operation<"mkdir", FilesystemMkdirInput, void, "receipt">(
        "mkdir",
        "mutate",
        strictObjectSchema({ path: pathProperty, recursive: { type: "boolean" } }, ["path"]),
        voidSchema,
        profileWireCodec(
            (input) => dataRecord({ path: input.path, recursive: input.recursive }),
            (data) => {
                const object = requireDataObject(data, "Filesystem mkdir input");
                const recursive = object["recursive"];
                const input: FilesystemMkdirInput = {
                    path: requireString(object["path"], "Filesystem mkdir path")
                };
                return recursive === undefined
                    ? input
                    : { ...input, recursive: recursive === true };
            }
        ),
        voidProfileWireCodec,
        "receipt"
    )
});

export const FILESYSTEM_OPERATIONS: readonly OperationDescriptor[] = Object.freeze(
    Object.values(FILESYSTEM_OPERATION_CONTRACTS).map((contract) => contract.descriptor)
);
export const FILESYSTEM_CONTRIBUTIONS = new Contributions([
    new Contribution(
        new SlotName("operations"),
        FILESYSTEM_OPERATIONS.map((operation) => operation.toData())
    )
]);

export abstract class FilesystemBackend {
    public abstract read(path: string, range?: FilesystemReadRange): Uint8Array;
    public abstract stat(path: string): FilesystemStat;
    public abstract list(path: string, cursor?: string, limit?: number): FilesystemPage;
    public abstract write(path: string, content: Uint8Array, mode?: FilesystemWriteMode): void;
    public abstract remove(path: string): void;
    public abstract move(source: string, destination: string): void;
    public abstract mkdir(path: string, recursive?: boolean): void;
}

export abstract class FilesystemReaderBackend {
    public abstract read(path: string, range?: FilesystemReadRange): Uint8Array;
    public abstract stat(path: string): FilesystemStat;
    public abstract list(path: string, cursor?: string, limit?: number): FilesystemPage;
}

export class FilesystemFacet<Receipt> {
    public static readonly operations = FILESYSTEM_OPERATIONS;

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly backend: FilesystemBackend
    ) {}

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({
            manifest,
            runtime: this.runtime,
            operations: [
                this.runtime.operation(FILESYSTEM_OPERATION_CONTRACTS.read, (input) =>
                    this.backend.read(input.path, input.range)
                ),
                this.runtime.operation(FILESYSTEM_OPERATION_CONTRACTS.stat, (input) =>
                    this.backend.stat(input.path)
                ),
                this.runtime.operation(FILESYSTEM_OPERATION_CONTRACTS.list, (input) =>
                    this.backend.list(input.path, input.cursor, input.limit)
                ),
                this.runtime.operation(FILESYSTEM_OPERATION_CONTRACTS.write, (input) =>
                    this.backend.write(input.path, input.content, input.mode)
                ),
                this.runtime.operation(FILESYSTEM_OPERATION_CONTRACTS.remove, (input) =>
                    this.backend.remove(input.path)
                ),
                this.runtime.operation(FILESYSTEM_OPERATION_CONTRACTS.move, (input) =>
                    this.backend.move(input.source, input.destination)
                ),
                this.runtime.operation(FILESYSTEM_OPERATION_CONTRACTS.mkdir, (input) =>
                    this.backend.mkdir(input.path, input.recursive)
                )
            ]
        });
    }

    public read(input: FilesystemReadInput): Promise<Uint8Array> {
        return this.runtime.invoke(FILESYSTEM_OPERATION_CONTRACTS.read, input, (admitted) =>
            this.backend.read(admitted.path, admitted.range)
        );
    }

    public stat(input: FilesystemStatInput): Promise<FilesystemStat> {
        return this.runtime.invoke(FILESYSTEM_OPERATION_CONTRACTS.stat, input, (admitted) =>
            this.backend.stat(admitted.path)
        );
    }

    public list(input: FilesystemListInput): Promise<FilesystemPage> {
        return this.runtime.invoke(FILESYSTEM_OPERATION_CONTRACTS.list, input, (admitted) =>
            this.backend.list(admitted.path, admitted.cursor, admitted.limit)
        );
    }

    public write(input: FilesystemWriteInput): Promise<Receipt> {
        return this.runtime.invoke(FILESYSTEM_OPERATION_CONTRACTS.write, input, (admitted) =>
            this.backend.write(admitted.path, admitted.content, admitted.mode)
        );
    }

    public remove(input: FilesystemRemoveInput): Promise<Receipt> {
        return this.runtime.invoke(FILESYSTEM_OPERATION_CONTRACTS.remove, input, (admitted) =>
            this.backend.remove(admitted.path)
        );
    }

    public move(input: FilesystemMoveInput): Promise<Receipt> {
        return this.runtime.invoke(FILESYSTEM_OPERATION_CONTRACTS.move, input, (admitted) =>
            this.backend.move(admitted.source, admitted.destination)
        );
    }

    public mkdir(input: FilesystemMkdirInput): Promise<Receipt> {
        return this.runtime.invoke(FILESYSTEM_OPERATION_CONTRACTS.mkdir, input, (admitted) =>
            this.backend.mkdir(admitted.path, admitted.recursive)
        );
    }
}

function pathInputCodec<Input extends { readonly path: string }>(
    build: (path: string) => Input
): ProfileWireCodec<Input> {
    return profileWireCodec(
        (input) => ({ path: input.path }),
        (data) =>
            build(
                requireString(
                    requireDataObject(data, "Filesystem path input")["path"],
                    "Filesystem path"
                )
            )
    );
}

function byteCodec(): ProfileWireCodec<Uint8Array> {
    return profileWireCodec((value) => [...value], decodeBytes);
}

function statCodec(): ProfileWireCodec<FilesystemStat> {
    return profileWireCodec((value) => ({ ...value }), decodeStat);
}

function pageCodec(): ProfileWireCodec<FilesystemPage> {
    return profileWireCodec(
        (value) =>
            dataRecord({
                entries: value.entries.map((entry) => statCodec().encode(entry)),
                cursor: value.cursor
            }),
        decodePage
    );
}

function decodeRange(data: FacetData): FilesystemReadRange {
    const object = requireDataObject(data, "Filesystem read range");
    const offset = object["offset"];
    const length = object["length"];
    let range: FilesystemReadRange = {};
    if (offset !== undefined) {
        range = { ...range, offset: requireSafeInteger(offset, "Read offset") };
    }
    if (length !== undefined) {
        range = { ...range, length: requireSafeInteger(length, "Read length") };
    }
    return range;
}

function decodeWriteInput(data: FacetData): FilesystemWriteInput {
    const object = requireDataObject(data, "Filesystem write input");
    const mode = object["mode"];
    const input: FilesystemWriteInput = {
        path: requireString(object["path"], "Filesystem write path"),
        content: decodeBytes(object["content"]!)
    };
    return mode === undefined ? input : { ...input, mode: requireWriteMode(mode) };
}

function decodeBytes(data: FacetData): Uint8Array {
    return requireBytes(data, "Filesystem bytes are invalid");
}

function requireWriteMode(value: FacetData): FilesystemWriteMode {
    const mode = requireString(value, "Filesystem write mode");
    if (isMember(FILESYSTEM_WRITE_MODES, mode)) return mode;
    throw new TypeError("Filesystem write mode is invalid");
}

function decodePage(data: FacetData): FilesystemPage {
    const object = requireDataObject(data, "Filesystem page");
    const entries = object["entries"];
    if (!Array.isArray(entries)) throw new TypeError("Filesystem page entries must be an array");
    const page = { entries: Object.freeze(entries.map(decodeStat)) };
    const cursor = object["cursor"];
    return Object.freeze(
        cursor === undefined
            ? page
            : { ...page, cursor: requireString(cursor, "Filesystem page cursor") }
    );
}

function decodeStat(data: FacetData): FilesystemStat {
    const object = requireDataObject(data, "Filesystem stat");
    const kind = requireString(object["kind"], "Filesystem entry kind");
    if (kind !== "file" && kind !== "directory")
        throw new TypeError("Filesystem entry kind is invalid");
    return Object.freeze({
        path: requireString(object["path"], "Filesystem stat path"),
        kind,
        size: requireSafeInteger(object["size"], "Filesystem stat size"),
        modifiedAt: requireSafeInteger(object["modifiedAt"], "Filesystem modified time")
    });
}

import { Digest } from "../../core";
import { Contributions, Contribution, OperationDescriptor } from "../contribution";
import type { FacetData, FacetDataMap } from "../data";
import {
    dataRecord,
    isFacetDataMap,
    requireBytes,
    requireDataObject,
    requireSafeInteger,
    requireString
} from "../data";
import { OperationName, SlotName } from "../id";
import type { FacetManifest } from "../manifest";
import {
    DetailedProfileError,
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
import { FilesystemError } from "./error";

export type FilesystemEntryKind = "file" | "directory";

/**
 * What the store found at the write target when it reached its atomic step. `absent` and
 * `present` are separate shapes rather than a nullable content field, so a backing store
 * cannot report a present target without naming the content it holds: the state that would
 * let a guarded write pass against content nobody looked at is unconstructable rather than
 * checked. `fold` is total, so every consumer answers both cases or does not compile.
 */
export abstract class FilesystemTargetState {
    public static get absent(): FilesystemTargetState {
        return absentTargetState;
    }
    public static present(content: Uint8Array): FilesystemTargetState {
        return new PresentTargetState(content);
    }

    public abstract fold<Result>(cases: FilesystemTargetCases<Result>): Result;
}

export interface FilesystemTargetCases<Result> {
    readonly absent: () => Result;
    readonly present: (content: Uint8Array) => Result;
}

class AbsentTargetState extends FilesystemTargetState {
    public fold<Result>(cases: FilesystemTargetCases<Result>): Result {
        return cases.absent();
    }
}

class PresentTargetState extends FilesystemTargetState {
    public constructor(private readonly content: Uint8Array) {
        super();
        Object.freeze(this);
    }
    public fold<Result>(cases: FilesystemTargetCases<Result>): Result {
        return cases.present(this.content);
    }
}

const absentTargetState = Object.freeze(new AbsentTargetState());

/**
 * A write mode owns the precondition that makes it distinct: `create` requires the target
 * absent, `replace` requires it present and holding the content the request names, `upsert`
 * requires nothing. The precondition is a per-case method rather than a caller-side branch,
 * so no write path can reach the store without discharging it.
 *
 * `replace` is the one parameterized case, and it is a factory taking its guard rather than a
 * singleton: a `replace` that names no content is unconstructable, which is what makes the
 * request carry its own proof of observation instead of the profile keeping a per-session
 * observed-state ledger. `create` and `upsert` carry no guard and stay argument-less getters,
 * so the illegal pairings — a guarded `create`, an unguarded `replace` — are unrepresentable.
 */
export abstract class FilesystemWriteMode {
    public static get create(): FilesystemWriteMode {
        return createWriteMode;
    }
    public static replace(expected: Digest): FilesystemWriteMode {
        return new ReplaceWriteMode(expected);
    }
    public static get upsert(): FilesystemWriteMode {
        return upsertWriteMode;
    }

    /** The wire label this mode serializes to. */
    public abstract readonly name: string;

    /** Rejects the write when the target's state contradicts this mode's precondition. */
    public abstract requireWritable(path: string, target: FilesystemTargetState): void;

    /** The wire form: the label, plus the guard for the one case that carries one. */
    public abstract toData(): FacetData;
}

class CreateWriteMode extends FilesystemWriteMode {
    public readonly name = "create";
    public requireWritable(path: string, target: FilesystemTargetState): void {
        target.fold({
            absent: () => {},
            present: () => {
                throw new FilesystemError("exists", path, "Path already exists");
            }
        });
    }
    public toData(): FacetData {
        return { name: this.name };
    }
}

class ReplaceWriteMode extends FilesystemWriteMode {
    public readonly name = "replace";

    public constructor(public readonly expected: Digest) {
        super();
        if (!(expected instanceof Digest)) {
            throw new TypeError("Replace guard must be a Digest");
        }
        Object.freeze(this);
    }

    public requireWritable(path: string, target: FilesystemTargetState): void {
        target.fold({
            absent: () => {
                throw new FilesystemError("not-found", path, "Path does not exist");
            },
            present: (content) => {
                // Derived from the content and from nothing else, so the same guard is
                // meaningful against every backing store without a token translation.
                if (!Digest.sha256(content).equals(this.expected)) {
                    throw new FilesystemError(
                        "content-mismatch",
                        path,
                        "Path content differs from the digest the write names"
                    );
                }
            }
        });
    }

    public toData(): FacetData {
        return { name: this.name, expected: this.expected.value };
    }
}

/**
 * The profile's one write over content the caller never read. Its precondition is empty by
 * design rather than by omission: `create` requires absence and `replace` requires the
 * content it names, so `upsert` is the single unobserved overwrite, and because a mode is
 * always declared it is a `mutate` intent a Workspace policy can refuse by name instead of
 * the shape a write falls back to.
 */
class UpsertWriteMode extends FilesystemWriteMode {
    public readonly name = "upsert";
    public requireWritable(): void {}
    public toData(): FacetData {
        return { name: this.name };
    }
}

const createWriteMode = Object.freeze(new CreateWriteMode());
const upsertWriteMode = Object.freeze(new UpsertWriteMode());

/**
 * Every mode the wire admits, paired with the decoder that owns its exact field set. The
 * unguarded cases refuse a guard and `replace` requires one, so the illegal pairings the
 * domain makes unconstructable — a guarded `create`, an unguarded `replace` — are equally
 * unrepresentable on the wire rather than normalized on the way in.
 */
const FILESYSTEM_WRITE_MODE_TERMS: readonly {
    readonly name: string;
    readonly decode: (mode: FacetDataMap) => FilesystemWriteMode;
}[] = Object.freeze([
    Object.freeze({
        name: "create",
        decode: (mode: FacetDataMap): FilesystemWriteMode => {
            requireExactWriteModeFields(mode, ["name"]);
            return createWriteMode;
        }
    }),
    Object.freeze({
        name: "replace",
        decode: (mode: FacetDataMap): FilesystemWriteMode => {
            requireExactWriteModeFields(mode, ["name", "expected"]);
            return FilesystemWriteMode.replace(
                new Digest(requireString(mode["expected"], "Filesystem replace guard"))
            );
        }
    }),
    Object.freeze({
        name: "upsert",
        decode: (mode: FacetDataMap): FilesystemWriteMode => {
            requireExactWriteModeFields(mode, ["name"]);
            return upsertWriteMode;
        }
    })
]);

const FILESYSTEM_WRITE_MODE_NAMES: readonly string[] = Object.freeze(
    FILESYSTEM_WRITE_MODE_TERMS.map((term) => term.name)
);

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

/**
 * The mode is required rather than optional, and that requirement is what
 * `P11-FILESYSTEM-WRITE-UNOBSERVED` turns on: `upsert` is the profile's one write over
 * content the caller never read, so it has to be a declared intent a Workspace policy can
 * refuse. A declaration a caller may decline to make is not a declaration, so an omitted
 * mode is inadmissible here and at the backend seam, and no layer mints a default for it.
 */
export interface FilesystemWriteInput extends PublicProfileInput {
    readonly path: string;
    readonly content: Uint8Array;
    readonly mode: FilesystemWriteMode;
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
// The model-facing shape of a mode: a label plus, for `replace`, the digest it guards
// against. Per-case field exactness is the decoder's, since one schema cannot say that
// exactly one label requires the guard.
const writeModeSchema = {
    type: "object",
    properties: {
        name: { enum: FILESYSTEM_WRITE_MODE_NAMES },
        expected: { type: "string", pattern: "^[a-f0-9]{64}$" }
    },
    required: ["name"],
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
                mode: writeModeSchema
            },
            ["path", "content", "mode"]
        ),
        voidSchema,
        profileWireCodec(
            (input) =>
                dataRecord({
                    path: input.path,
                    content: [...input.content],
                    mode: input.mode.toData()
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

/**
 * The mutating seam. `write` takes the mode value object always: an omitted mode is
 * inadmissible here, so no backing store has an absent-mode branch to give a meaning to and
 * none of them mints `upsert` as a default. The unobserved overwrite
 * `P11-FILESYSTEM-WRITE-UNOBSERVED` permits stays reachable only by naming it.
 */
export abstract class FilesystemBackend {
    public abstract read(path: string, range?: FilesystemReadRange): Uint8Array;
    public abstract stat(path: string): FilesystemStat;
    public abstract list(path: string, cursor?: string, limit?: number): FilesystemPage;
    public abstract write(path: string, content: Uint8Array, mode: FilesystemWriteMode): void;
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
    return {
        path: requireString(object["path"], "Filesystem write path"),
        content: decodeBytes(object["content"]!),
        // An absent mode reaches requireWriteMode as `undefined` and is refused there with
        // the profile's own taxonomy: the decoder mints nothing, so the model-facing input
        // admits no undeclared write.
        mode: requireWriteMode(object["mode"])
    };
}

function decodeBytes(data: FacetData): Uint8Array {
    return requireBytes(data, "Filesystem bytes are invalid");
}

/**
 * The single parse-at-the-edge: the wire carries a mode label and, for `replace`, the digest
 * it guards against; the domain carries a mode object. An unrecognised label never reaches a
 * write path, and neither does a `replace` that names no digest — the term's own decoder owns
 * its exact field set, so an unguarded `replace` produces no mode rather than a permissive one.
 * An omitted mode takes the same exit: the decoder refuses it rather than choosing one, which
 * is what keeps `upsert` a declaration instead of the shape a write falls back to.
 */
function requireWriteMode(value: FacetData | undefined): FilesystemWriteMode {
    if (isFacetDataMap(value)) {
        const term = FILESYSTEM_WRITE_MODE_TERMS.find(
            (candidate) => candidate.name === value["name"]
        );
        if (term !== undefined) return term.decode(value);
    }
    // A bare label, an unknown label, and an omitted mode are all the pre-guard wire form,
    // and each is refused with the profile's own code rather than as a shape error: an
    // unguarded `replace` and an undeclared write are invalid input, not a type confusion,
    // and a caller branching on stable codes has to be able to see that.
    throw new DetailedProfileError(
        "operation.invalid-input",
        "operation.invalid-input",
        "Write mode must be create, replace, or upsert"
    );
}

function requireExactWriteModeFields(mode: FacetDataMap, admitted: readonly string[]): void {
    const keys = Object.keys(mode);
    if (keys.length !== admitted.length || admitted.some((field) => !(field in mode))) {
        throw new DetailedProfileError(
            "operation.invalid-input",
            "operation.invalid-input",
            `Write mode ${String(mode["name"])} admits exactly ${admitted.join(", ")}`
        );
    }
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

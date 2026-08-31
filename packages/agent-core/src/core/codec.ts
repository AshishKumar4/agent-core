import { AgentCoreError } from "../errors";
import { compareCanonicalText, decodeCanonicalJson, encodeCanonicalJson } from "./canonical";
import {
    hasExactJsonKeys,
    isJsonNumber,
    isJsonObject,
    isJsonString,
    isObjectRecord,
    jsonDataParser,
    type JsonObject,
    type JsonValue
} from "./json";
import { hasOnlyUnicodeScalarValues } from "./unicode";

export interface RecordVersion {
    readonly major: number;
    readonly minor: number;
}

export interface RecordEnvelope {
    readonly kind: string;
    readonly version: RecordVersion;
    readonly payload: JsonValue;
}

export interface RecordClass<Record = object> {
    readonly prototype: Record;
}

export type RecordClasses<Record> = readonly [RecordClass<Record>, ...RecordClass[]];

const functionSource = Function.prototype.toString;

export abstract class RecordCodec<Record> {
    public readonly kind: string;
    public readonly version: RecordVersion;

    protected constructor(
        recordClasses: RecordClasses<Record>,
        kind: string,
        version: RecordVersion
    ) {
        if (
            !isJsonString(kind) ||
            kind.trim().length === 0 ||
            kind !== kind.trim() ||
            !hasOnlyUnicodeScalarValues(kind)
        ) {
            throw new TypeError("Record codec kind must be a nonblank canonical string");
        }
        this.kind = kind;
        this.version = validateAndDetachVersion(version);
        sealRecordClasses(recordClasses);
        this.#encodePayload = this.encodePayload.bind(this);
        this.#decodePayload = this.decodePayload.bind(this);
        const encode = this.encode.bind(this);
        const decode = this.decode.bind(this);
        Object.defineProperties(this, {
            decode: {
                configurable: false,
                enumerable: false,
                value: (bytes: Uint8Array): Record => decode(bytes),
                writable: false
            },
            encode: {
                configurable: false,
                enumerable: false,
                value: (record: Record): Uint8Array => encode(record),
                writable: false
            },
            kind: {
                configurable: false,
                enumerable: true,
                value: this.kind,
                writable: false
            },
            version: {
                configurable: false,
                enumerable: true,
                value: this.version,
                writable: false
            }
        });
    }

    readonly #decodePayload: (payload: JsonValue, version: RecordVersion) => Record;
    readonly #encodePayload: (record: Record) => JsonValue;

    public encode(record: Record): Uint8Array {
        return encodeCanonicalJson({
            kind: this.kind,
            version: {
                major: this.version.major,
                minor: this.version.minor
            },
            payload: this.#encodePayload(record)
        });
    }

    public decode(bytes: Uint8Array): Record {
        const value = decodeCanonicalJson(bytes);
        if (!isEnvelope(value)) {
            throw new AgentCoreError("codec.invalid", "Record envelope is malformed");
        }
        if (value.kind !== this.kind) {
            throw new AgentCoreError("codec.invalid", `Expected record kind ${this.kind}`);
        }
        assertCompatibleRecordVersion(this.kind, value.version, this.version);
        const version = Object.freeze({
            major: value.version.major,
            minor: value.version.minor
        });
        try {
            return this.#decodePayload(value.payload, version);
        } catch (error) {
            if (error instanceof AgentCoreError) {
                throw error;
            }
            if (!(error instanceof TypeError)) throw error;
            const message = error.message;
            throw new AgentCoreError("codec.invalid", `Invalid ${this.kind} record: ${message}`);
        }
    }

    protected abstract encodePayload(record: Record): JsonValue;

    protected abstract decodePayload(payload: JsonValue, version: RecordVersion): Record;
}

/**
 * The single §8.3 compatibility decision. Every reader — one record's codec and a whole
 * record set's declaration alike — asks this one predicate, so a record and the set that
 * holds it can never disagree about whether a stored version is readable.
 * Both components must already be non-negative safe integers.
 */
export function supportsRecordVersion(declared: RecordVersion, supported: RecordVersion): boolean {
    return declared.major === supported.major && declared.minor <= supported.minor;
}

/**
 * Names the refusal `supportsRecordVersion` earned: an unknown major fails as
 * codec.unknown-major and an unsupported newer minor fails as codec.invalid, while an
 * older minor tolerates read within the major.
 */
export function assertCompatibleRecordVersion(
    subject: string,
    declared: RecordVersion,
    supported: RecordVersion
): void {
    if (supportsRecordVersion(declared, supported)) return;
    if (declared.major !== supported.major) {
        throw new AgentCoreError(
            "codec.unknown-major",
            `Unsupported ${subject} codec major ${declared.major}`
        );
    }
    throw new AgentCoreError(
        "codec.invalid",
        `Unsupported ${subject} codec minor ${declared.minor}`
    );
}

/**
 * One record kind and the codec version the records of that kind were written under.
 * A `RecordCodec` satisfies this shape, so a reader declares itself from its own codecs.
 */
export interface DeclaredCodecVersion {
    readonly kind: string;
    readonly version: RecordVersion;
}

/**
 * The §8.3 verdict a reader reaches from a record set's declaration before it decodes any
 * record of the set. The decision is total over declarations: the stored set is compatible,
 * or it names a kind this reader does not declare, or it names a version this reader's codec
 * refuses. There is no fourth answer and no undecided input.
 */
export abstract class CodecCompatibility {
    public static get compatible(): CodecCompatibility {
        return compatibleDeclaration;
    }

    /**
     * Serves the reader only where the declaration is compatible. An incompatible set is
     * left exactly as stored — no repair, no downgrade, no partial rewrite — and no record
     * of it is decoded, so a derivation can never answer from the part that still reads.
     */
    public abstract admit(serve: () => void): void;

    /** The refusal every operation over an incompatible record set owes its caller. */
    public abstract requireCompatible(): void;
}

class CompatibleDeclaration extends CodecCompatibility {
    public admit(serve: () => void): void {
        serve();
    }

    public requireCompatible(): void {}
}

class UndeclaredKind extends CodecCompatibility {
    public constructor(private readonly kind: string) {
        super();
        Object.freeze(this);
    }

    public admit(): void {}

    public requireCompatible(): never {
        throw new AgentCoreError(
            "schema.unreadable",
            `Record set declares ${this.kind}, which this reader does not declare`
        );
    }
}

/**
 * Only `compatibilityWith` constructs this, and only where `supportsRecordVersion` has
 * already refused the pair, so naming the refusal is all that is left to do.
 */
class UnsupportedVersion extends CodecCompatibility {
    public constructor(
        private readonly kind: string,
        private readonly declared: RecordVersion,
        private readonly supported: RecordVersion
    ) {
        super();
        Object.freeze(this);
    }

    public admit(): void {}

    public requireCompatible(): void {
        assertCompatibleRecordVersion(this.kind, this.declared, this.supported);
    }
}

const compatibleDeclaration: CodecCompatibility = Object.freeze(new CompatibleDeclaration());

/**
 * The codec versions the records one Actor owns were written under (§8.3). It is
 * constituent data of the durable state a store already holds about its Actor, so a reader
 * reaches it before it decodes any record of the set, and never a durable plane of its own.
 */
export class CodecDeclaration {
    public static get empty(): CodecDeclaration {
        return emptyDeclaration;
    }

    /** The declaration a reader makes of itself, from the codecs it holds. */
    public static of(codecs: Iterable<DeclaredCodecVersion>): CodecDeclaration {
        return new CodecDeclaration([...codecs]);
    }

    public readonly declared: readonly DeclaredCodecVersion[];

    public constructor(declared: readonly DeclaredCodecVersion[]) {
        this.declared = canonicalDeclared(declared);
        Object.freeze(this);
    }

    public static fromData(value: JsonValue | undefined): CodecDeclaration {
        const declared = data.array(value, "Codec declaration");
        try {
            return new CodecDeclaration(declared.map(declaredVersionFromData));
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            throw new AgentCoreError(
                "codec.invalid",
                `Invalid Codec declaration: ${error.message}`
            );
        }
    }

    /**
     * The stable raw form an Actor store carries before it decodes the Actor's record set.
     * It is deliberately NOT `encode`/`decode`: those names mean "through this record's own
     * RecordCodec" everywhere else, and this carrier has no codec on purpose, because a
     * future record codec is exactly what the reader is refusing to understand. Pairs with
     * `toData`/`fromData` on the same value.
     */
    public static toBytes(declaration: CodecDeclaration): Uint8Array {
        return encodeCanonicalJson(requireExactDeclaration(declaration).toData());
    }

    public static fromBytes(bytes: Uint8Array): CodecDeclaration {
        return CodecDeclaration.fromData(decodeCanonicalJson(bytes));
    }

    public toData(): readonly JsonObject[] {
        return this.declared.map((entry) => ({
            kind: entry.kind,
            version: { major: entry.version.major, minor: entry.version.minor }
        }));
    }

    public versionOf(kind: string): RecordVersion | undefined {
        return this.declared.find((entry) => entry.kind === kind)?.version;
    }

    /**
     * Whether a reader declaring `reader` may serve this stored set. The version question is
     * the one `supportsRecordVersion` already answers, so a record set and a single record
     * never disagree about whether a stored version is readable.
     */
    public compatibilityWith(reader: CodecDeclaration): CodecCompatibility {
        for (const entry of this.declared) {
            const supported = reader.versionOf(entry.kind);
            if (supported === undefined) {
                return new UndeclaredKind(entry.kind);
            }
            if (!supportsRecordVersion(entry.version, supported)) {
                return new UnsupportedVersion(entry.kind, entry.version, supported);
            }
        }
        return CodecCompatibility.compatible;
    }

    public equals(other: CodecDeclaration): boolean {
        return (
            this.declared.length === other.declared.length &&
            this.declared.every((entry, index) => {
                const candidate = other.declared[index];
                return (
                    candidate !== undefined &&
                    entry.kind === candidate.kind &&
                    entry.version.major === candidate.version.major &&
                    entry.version.minor === candidate.version.minor
                );
            })
        );
    }
}

const emptyDeclaration = new CodecDeclaration([]);

const data = jsonDataParser(
    (message) => new AgentCoreError("codec.invalid", `${message} in a codec declaration`)
);

/** The carrier writes only an exact CodecDeclaration; a lookalike is a caller wiring fault. */
function requireExactDeclaration(declaration: CodecDeclaration): CodecDeclaration {
    if (declaration.constructor !== CodecDeclaration) {
        throw new TypeError("Codec declaration encoding requires an exact CodecDeclaration");
    }
    return declaration;
}

function canonicalDeclared(
    declared: readonly DeclaredCodecVersion[]
): readonly DeclaredCodecVersion[] {
    const byKind = new Map<string, RecordVersion>();
    for (const entry of declared) {
        const kind = entry.kind;
        if (
            kind.trim().length === 0 ||
            kind !== kind.trim() ||
            !hasOnlyUnicodeScalarValues(kind) ||
            byKind.has(kind)
        ) {
            throw new TypeError(
                "Codec declaration must name distinct nonblank canonical record kinds"
            );
        }
        byKind.set(kind, validateAndDetachVersion(entry.version));
    }
    return Object.freeze(
        [...byKind.entries()]
            .sort(([left], [right]) => compareCanonicalText(left, right))
            .map(([kind, version]) => Object.freeze({ kind, version }))
    );
}

function declaredVersionFromData(entry: JsonValue): DeclaredCodecVersion {
    const object = data.exact(
        data.object(entry, "Declared codec version"),
        ["kind", "version"],
        "Declared codec version"
    );
    const version = data.exact(
        data.object(object["version"], "Declared codec version"),
        ["major", "minor"],
        "Declared codec version"
    );
    return {
        kind: data.nonemptyString(object["kind"], "Declared codec kind"),
        version: {
            major: data.safeInteger(version["major"], "Declared codec major"),
            minor: data.safeInteger(version["minor"], "Declared codec minor")
        }
    };
}

function sealRecordClasses<Record>(recordClasses: RecordClasses<Record>): void {
    const classes = validateAndDetachRecordClasses(recordClasses);
    for (const recordClass of classes) {
        Object.freeze(recordClass.prototype);
        Object.freeze(recordClass);
    }
}

function validateAndDetachRecordClasses<Record>(
    recordClasses: RecordClasses<Record>
): ReadonlyArray<RecordClass> {
    if (
        !Array.isArray(recordClasses) ||
        Object.getPrototypeOf(recordClasses) !== Array.prototype ||
        recordClasses.length === 0 ||
        Reflect.ownKeys(recordClasses).length !== recordClasses.length + 1
    ) {
        throw new TypeError("Record codec must name a nonempty ordinary class tuple");
    }
    const detached: RecordClass[] = [];
    for (let index = 0; index < recordClasses.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(recordClasses, index);
        const candidate = descriptor?.value;
        if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            !descriptor.enumerable ||
            !isOrdinaryRecordClass(candidate)
        ) {
            throw new TypeError("Record codec classes must be ordinary class constructors");
        }
        if (!detached.includes(candidate)) detached.push(candidate);
    }
    return Object.freeze(detached);
}

function isOrdinaryRecordClass(value: unknown): value is RecordClass {
    if (typeof value !== "function") return false;
    if (!functionSource.call(value).startsWith("class")) return false;
    const prototype = Object.getOwnPropertyDescriptor(value, "prototype")?.value;
    if (!isObjectPrototype(prototype)) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    return constructor !== undefined && "value" in constructor && constructor.value === value;
}

function isObjectPrototype(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}

function isEnvelope(value: JsonValue): value is JsonValue & RecordEnvelope {
    if (!isJsonObject(value)) {
        return false;
    }
    const version = value["version"];
    return (
        hasExactJsonKeys(value, ["kind", "payload", "version"]) &&
        isJsonString(value["kind"]) &&
        isJsonObject(version) &&
        hasExactJsonKeys(version, ["major", "minor"]) &&
        Number.isSafeInteger(version["major"]) &&
        isJsonNumber(version["major"]) &&
        version["major"] >= 0 &&
        Number.isSafeInteger(version["minor"]) &&
        isJsonNumber(version["minor"]) &&
        version["minor"] >= 0 &&
        Object.hasOwn(value, "payload")
    );
}

/** Detaches a caller-supplied version into a frozen pair of non-negative safe integers. */
function validateAndDetachVersion(version: RecordVersion): RecordVersion {
    if (
        !isObjectRecord(version) ||
        Object.getPrototypeOf(version) !== Object.prototype ||
        !hasExactVersionKeys(version)
    ) {
        throw new TypeError("Record codec version must contain non-negative safe integers");
    }
    const majorDescriptor = Object.getOwnPropertyDescriptor(version, "major");
    const minorDescriptor = Object.getOwnPropertyDescriptor(version, "minor");
    if (
        majorDescriptor === undefined ||
        minorDescriptor === undefined ||
        !("value" in majorDescriptor) ||
        !("value" in minorDescriptor) ||
        !majorDescriptor.enumerable ||
        !minorDescriptor.enumerable
    ) {
        throw new TypeError("Record codec version must contain non-negative safe integers");
    }
    const major: unknown = majorDescriptor.value;
    const minor: unknown = minorDescriptor.value;
    if (
        !isJsonNumber(major) ||
        !Number.isSafeInteger(major) ||
        major < 0 ||
        !isJsonNumber(minor) ||
        !Number.isSafeInteger(minor) ||
        minor < 0
    ) {
        throw new TypeError("Record codec version must contain non-negative safe integers");
    }
    return Object.freeze({ major, minor });
}

function hasExactVersionKeys(version: RecordVersion): boolean {
    const keys = Reflect.ownKeys(version);
    return keys.length === 2 && keys.includes("major") && keys.includes("minor");
}

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as actors from "../../src/actors";
import * as agents from "../../src/agents";
import * as authority from "../../src/authority";
import * as composition from "../../src/composition";
import * as content from "../../src/content";
import * as core from "../../src/core";
import * as definition from "../../src/definition";
import * as environments from "../../src/environments";
import * as executionReferences from "../../src/execution-references";
import * as facets from "../../src/facets";
import * as identity from "../../src/identity";
import * as interactionReferences from "../../src/interaction-references";
import * as invocationReferences from "../../src/invocation-references";
import * as invocations from "../../src/invocations";
import * as operations from "../../src/operations";
import * as protocol from "../../src/protocol";
import * as slates from "../../src/slates";
import * as substrates from "../../src/substrates";
import * as workspaces from "../../src/workspaces";
import {
    RecordCodec,
    encodeCanonicalJson,
    isJsonObject,
    isJsonValue,
    type JsonValue,
    type RecordVersion
} from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { expectAgentCoreError } from "../protocol/error-assertion";
import {
    attemptCodec,
    claimCodec,
    continuationCodec,
    preparedCodec
} from "../invocations/fixture";

// The registry names every record by its declaring module; the barrels are the
// only way to reach the values, because a computed import specifier is a
// reference the import-boundary checker cannot verify.
const barrels: readonly object[] = [
    actors,
    agents,
    authority,
    composition,
    content,
    core,
    definition,
    environments,
    executionReferences,
    facets,
    identity,
    interactionReferences,
    invocationReferences,
    invocations,
    operations,
    protocol,
    slates,
    substrates,
    workspaces
];

interface RecordRow {
    readonly symbol: string;
    readonly kind: string;
    readonly codec: string;
}

interface ValueCodec {
    decode(bytes: Uint8Array): void;
}

type DecodeFunction = ValueCodec["decode"];

const packageUrl = new URL("../../", import.meta.url);
const rows = readRecordRegistry();

// A record whose codec is a class rather than a value is parameterised by the
// codecs of the references it embeds, so it has no registry-reachable instance.
const constructedCodecs = [
    "src/identity/guest-verification.ts#GuestVerification.codec",
    "src/invocations/approval.ts#ApprovalRecordCodec",
    "src/invocations/attempt.ts#EffectAttemptCodec",
    "src/invocations/audit.ts#AuditRecordCodecV1",
    "src/invocations/claim.ts#ItemClaimCodec",
    "src/invocations/continuation.ts#InvocationContinuationCodec",
    "src/invocations/prepared.ts#PreparedInvocationCodec",
    "src/invocations/publication.ts#InvocationPublicationOutboxCodecV1",
    "src/invocations/receipt.ts#ReceiptCodecV2",
    "src/invocations/replay.ts#MediatedReplayRecordCodecV1",
    "src/substrates/sqlite/tenant.ts#TenantBootstrapMarker.codec"
] as const;

const envelopeCodecs = rows.flatMap((row) => {
    const codec = select(row.codec, isRecordCodec);
    return codec === undefined ? [] : [{ row, codec }];
});
const valueCodecs = rows.flatMap((row) => {
    const decode = select(
        `${row.codec.slice(0, row.codec.lastIndexOf("."))}.decode`,
        isDecodeFunction
    );
    const envelopeCodec = select(row.codec, isRecordCodec);
    return decode === undefined || envelopeCodec !== undefined ? [] : [{ row, codec: { decode } }];
});

// Registry selectors name the declaring module's codec symbol, which can be a
// module-private class. A selector-unreachable record is still covered when
// its declared kind identifies an exported envelope codec instance, or when
// the record class itself exposes the public static decode that delegates to
// the private instance. Only records with no runtime export at all — their
// bytes are decoded strictly inside their owning context — stay uncovered.
// Only the decode side of a codec matters here; typing instances through this
// structural view keeps generic record codecs assignable without casts.
interface InstanceCodec {
    readonly kind: string;
    readonly version: RecordVersion;
    readonly decode: (bytes: Uint8Array) => void;
}

interface SupplementalCodec {
    readonly selector: string;
    readonly decode: (bytes: Uint8Array) => void;
    readonly kind: string;
    readonly version?: RecordVersion;
}

const ZERO_VERSION: RecordVersion = { major: 0, minor: 0 };
const coveredKinds = new Set(envelopeCodecs.map(({ row }) => row.kind));
const codecsByKind = collectEnvelopeCodecsByKind(barrels);
interface ParameterizedCodecBySymbol {
    readonly [symbol: string]: InstanceCodec | undefined;
    readonly EffectAttempt: InstanceCodec;
    readonly InvocationContinuation: InstanceCodec;
    readonly ItemClaim: InstanceCodec;
    readonly PreparedInvocation: InstanceCodec;
}

const parameterizedCodecs: ParameterizedCodecBySymbol = {
    EffectAttempt: attemptCodec,
    InvocationContinuation: continuationCodec,
    ItemClaim: claimCodec,
    PreparedInvocation: preparedCodec
};
const constructedByKind: readonly SupplementalCodec[] = rows.flatMap((row): SupplementalCodec[] => {
    if (coveredKinds.has(row.kind)) return [];
    const instance = codecsByKind.get(row.kind);
    if (instance !== undefined) {
        return [
            {
                selector: row.codec,
                decode: (bytes) => instance.decode.call(instance, bytes),
                kind: instance.kind,
                version: instance.version
            }
        ];
    }
    const parameterized = parameterizedCodecs[row.symbol];
    if (parameterized !== undefined) {
        return [
            {
                selector: row.codec,
                decode: (bytes) => parameterized.decode.call(parameterized, bytes),
                kind: parameterized.kind,
                version: parameterized.version
            }
        ];
    }
    const decode = select(`${row.symbol}.decode`, isDecodeFunction);
    if (decode === undefined) return [];
    return [{ selector: `${row.symbol}.decode`, decode, kind: row.kind }];
});
const supplementalSelectors = new Set(constructedByKind.map((entry) => entry.selector));
const internalOnlyRows = rows
    .filter((row) => !coveredKinds.has(row.kind))
    .filter(
        (row) =>
            !supplementalSelectors.has(row.codec) &&
            !supplementalSelectors.has(`${row.symbol}.decode`)
    )
    .map((row) => `${row.symbol} (${row.kind})`)
    .sort();

describe("registered record decode contract", () => {
    test("covers every registered record codec the registry can reach", { tags: "p2" }, () => {
        const reached = new Set([
            ...envelopeCodecs.map(({ row }) => row.codec),
            ...valueCodecs.map(({ row }) => row.codec)
        ]);
        expect(
            rows
                .filter((row) => !reached.has(row.codec))
                .map((row) => row.codec)
                .sort()
        ).toEqual([...constructedCodecs].sort());
        expect(envelopeCodecs.length).toBeGreaterThan(0);
        expect(valueCodecs.length).toBeGreaterThan(0);
    });

    // A record whose class has no runtime export has its bytes decoded strictly
    // inside its owning context, behind covered store and record codecs.
    test("admits only owning-context-internal records from public coverage", { tags: "p0" }, () => {
        expect(internalOnlyRows).toEqual([
            "GuestVerification (identity.guest-verification)",
            "TenantBootstrapMarker (protocol.tenant-bootstrap-marker)"
        ]);
        expect(constructedByKind.length).toBeGreaterThan(0);
    });

    // Selector-unreachable durable records run the same typed-outcome battery.
    // An exported instance carries its real supported version; a record's
    // public static decode proves routing with structural mutations plus an
    // absurd major that no supported codec major can equal.
    test.each(constructedByKind.map((entry) => [entry.selector, entry] as const))(
        "%s refuses structurally mutated envelopes and incompatible versions with typed errors",
        { tags: "p0" },
        (_selector, entry) => {
            for (const mutation of structuralMutations(entry.kind, entry.version ?? ZERO_VERSION)) {
                expectAgentCoreError(() => entry.decode(mutation.bytes), mutation.code);
            }
            if (entry.version === undefined) {
                expectAgentCoreError(
                    () =>
                        entry.decode(
                            envelopeBytes(
                                entry.kind,
                                { major: Number.MAX_SAFE_INTEGER, minor: 0 },
                                null
                            )
                        ),
                    "codec.unknown-major"
                );
                return;
            }
            for (const mutation of versionMutations(entry.kind, entry.version)) {
                expectAgentCoreError(() => entry.decode(mutation.bytes), mutation.code);
            }
        }
    );

    test.each(envelopeCodecs.map(({ row, codec }) => [row.codec, codec] as const))(
        "%s refuses a structurally mutated envelope with a typed error",
        { tags: "p0" },
        (_selector, codec) => {
            for (const mutation of structuralMutations(codec.kind, codec.version)) {
                expectAgentCoreError(() => codec.decode(mutation.bytes), mutation.code);
            }
            for (const mutation of versionMutations(codec.kind, codec.version)) {
                expectAgentCoreError(() => codec.decode(mutation.bytes), mutation.code);
            }
        }
    );

    test.each(envelopeCodecs.map(({ row, codec }) => [row.codec, codec] as const))(
        "%s answers a well-formed envelope carrying a hostile payload without escaping its taxonomy",
        { tags: "p0" },
        (_selector, codec) => {
            for (const payload of hostilePayloads) {
                expectTypedOrAccepted(() =>
                    codec.decode(envelopeBytes(codec.kind, codec.version, payload))
                );
            }
        }
    );

    // A value codec exposes static encode/decode over a private envelope codec, so
    // its version is not public and only the version-independent mutations apply.
    test.each(valueCodecs.map(({ row, codec }) => [row.codec, row.kind, codec] as const))(
        "%s refuses a structurally mutated envelope with a typed error",
        { tags: "p0" },
        (_selector, kind, codec) => {
            for (const mutation of structuralMutations(kind, { major: 0, minor: 0 })) {
                expectAgentCoreError(() => codec.decode(mutation.bytes), mutation.code);
            }
        }
    );
});

interface Mutation {
    readonly bytes: Uint8Array;
    readonly code: AgentCoreErrorCode;
}

const hostilePayloads: readonly JsonValue[] = [
    null,
    true,
    0,
    -1,
    "",
    "payload",
    [],
    [null],
    {},
    { "": null },
    { ["__proto__"]: null, constructor: null }
];

// Every one of these is refused before the envelope version is consulted, so the
// version they carry never decides the outcome.
function structuralMutations(kind: string, version: RecordVersion): readonly Mutation[] {
    const numbers = { major: version.major, minor: version.minor };
    const valid = envelopeBytes(kind, numbers, null);
    const malformed: readonly JsonValue[] = [
        null,
        true,
        0,
        "envelope",
        [],
        [kind, numbers, null],
        { payload: null, version: numbers },
        { kind, payload: null },
        { kind, version: numbers },
        { knid: kind, payload: null, version: numbers },
        { extra: null, kind, payload: null, version: numbers },
        { kind: 0, payload: null, version: numbers },
        { kind, payload: null, version: null },
        { kind, payload: null, version: "0.0" },
        { kind, payload: null, version: [version.major, version.minor] },
        { kind, payload: null, version: { major: String(version.major), minor: version.minor } },
        { kind, payload: null, version: { major: version.major, minor: String(version.minor) } },
        { kind, payload: null, version: { major: version.major + 0.5, minor: version.minor } },
        { kind, payload: null, version: { major: -1, minor: version.minor } },
        { kind, payload: null, version: { major: version.major, minor: -1 } },
        { kind, payload: null, version: { ...numbers, patch: 0 } },
        { kind, payload: null, version: { major: version.major } },
        { kind: `${kind}.unregistered`, payload: null, version: numbers }
    ];
    return [
        ...malformed.map((value) => ({ bytes: encodeCanonicalJson(value), code: INVALID })),
        { bytes: new Uint8Array(0), code: INVALID },
        { bytes: valid.slice(0, valid.length - 1), code: INVALID },
        { bytes: valid.slice(1), code: INVALID },
        {
            bytes: text(
                `{"payload":null,"kind":${JSON.stringify(kind)},"version":${JSON.stringify(numbers)}}`
            ),
            code: INVALID
        },
        {
            bytes: text(
                ` {"kind":${JSON.stringify(kind)},"payload":null,"version":${JSON.stringify(numbers)}}`
            ),
            code: INVALID
        }
    ];
}

function versionMutations(kind: string, version: RecordVersion): readonly Mutation[] {
    return [
        {
            bytes: envelopeBytes(kind, { major: version.major + 1, minor: version.minor }, null),
            code: "codec.unknown-major"
        },
        {
            bytes: envelopeBytes(kind, { major: Number.MAX_SAFE_INTEGER, minor: 0 }, null),
            code: "codec.unknown-major"
        },
        {
            bytes: envelopeBytes(kind, { major: version.major, minor: version.minor + 1 }, null),
            code: INVALID
        }
    ];
}

const INVALID: AgentCoreErrorCode = "codec.invalid";

function envelopeBytes(kind: string, version: RecordVersion, payload: JsonValue): Uint8Array {
    return encodeCanonicalJson({
        kind,
        payload,
        version: { major: version.major, minor: version.minor }
    });
}

function expectTypedOrAccepted(operation: () => void): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
    }
}

function text(source: string): Uint8Array {
    return new TextEncoder().encode(source);
}

function select<Value>(
    selector: string,
    accepts: (candidate: unknown) => candidate is Value
): Value | undefined {
    const path = selector.slice(selector.indexOf("#") + 1).split(".");
    const root = path[0];
    if (root === undefined) return undefined;
    let owner = lookupOwner(root);
    const members = path.slice(1);
    for (const [index, member] of members.entries()) {
        if (owner === undefined) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(owner, member);
        if (descriptor === undefined) return undefined;
        const candidate: unknown =
            descriptor.get === undefined ? descriptor.value : descriptor.get.call(owner);
        if (index === members.length - 1) return accepts(candidate) ? candidate : undefined;
        owner = isSelectorOwner(candidate) ? candidate : undefined;
    }
    return accepts(owner) ? owner : undefined;
}

function lookupOwner(name: string): object | undefined {
    for (const barrel of barrels) {
        const descriptor = Object.getOwnPropertyDescriptor(barrel, name);
        if (descriptor === undefined) continue;
        const candidate: unknown =
            descriptor.get === undefined ? descriptor.value : descriptor.get.call(barrel);
        if (isSelectorOwner(candidate)) return candidate;
    }
    return undefined;
}

function isSelectorOwner(value: unknown): value is object {
    return Object(value) === value;
}

function isRecordCodec(value: unknown): value is RecordCodec<object> {
    return value instanceof RecordCodec;
}

function isDecodeFunction(value: unknown): value is DecodeFunction {
    return typeof value === "function";
}

function readRecordRegistry(): readonly RecordRow[] {
    return readFragments("artifacts/records/index.json").flatMap((fragment) =>
        readRows(`artifacts/records/${fragment}`)
    );
}

function readFragments(path: string): readonly string[] {
    const document = readJson(path);
    if (!isJsonObject(document) || !Array.isArray(document["fragments"])) {
        throw new TypeError("Record registry index is malformed");
    }
    const fragments = document["fragments"];
    if (!fragments.every(isString)) throw new TypeError("Record registry fragment is malformed");
    return fragments;
}

function readRows(path: string): readonly RecordRow[] {
    const document = readJson(path);
    if (!isJsonObject(document) || !Array.isArray(document["records"])) {
        throw new TypeError("Record registry fragment is malformed");
    }
    return document["records"].map((value) => {
        if (
            !isJsonObject(value) ||
            !isString(value["symbol"]) ||
            !isString(value["kind"]) ||
            !isString(value["codec"])
        ) {
            throw new TypeError("Record registry row is malformed");
        }
        return { symbol: value["symbol"], kind: value["kind"], codec: value["codec"] };
    });
}

function readJson(path: string): JsonValue {
    const value: unknown = JSON.parse(readFileSync(new URL(path, packageUrl), "utf8"));
    if (!isJsonValue(value)) throw new TypeError("Record registry JSON is malformed");
    return value;
}

function isString(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

function isTextKey(name: PropertyKey): name is string {
    return typeof name === "string";
}

// A codec subclass's constructor also satisfies instanceof, so require the
// constructed shape: only instances carry kind, version, and bound decode.
function isInstanceCodec(value: unknown): value is InstanceCodec {
    if (!(value instanceof RecordCodec)) return false;
    return isString(value.kind);
}

function codecSources(containers: readonly object[]): readonly object[] {
    const sources: object[] = [];
    for (const container of containers) {
        for (const name of Reflect.ownKeys(container)) {
            if (!isTextKey(name)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(container, name);
            let candidate: unknown;
            if (descriptor?.get !== undefined) {
                try {
                    candidate = descriptor.get.call(container);
                } catch {
                    continue; // A throwing getter is not a codec source.
                }
            } else {
                candidate = descriptor?.value;
            }
            if (isSelectorOwner(candidate)) sources.push(candidate);
        }
    }
    return sources;
}

function recordInstanceCodec(byKind: Map<string, InstanceCodec>, codec: InstanceCodec): void {
    const seen = byKind.get(codec.kind);
    if (seen === codec) return;
    if (seen === undefined) {
        byKind.set(codec.kind, codec);
        return;
    }
    if (seen.version.major !== codec.version.major || seen.version.minor !== codec.version.minor) {
        throw new TypeError(
            `Registered record kind ${codec.kind} is served by two codec versions`
        );
    }
}

function collectEnvelopeCodecsByKind(
    sourceBarrels: readonly object[]
): ReadonlyMap<string, InstanceCodec> {
    const byKind = new Map<string, InstanceCodec>();
    // Barrels hold codec instances at symbol level and one container level
    // deeper, the two shapes this contract's selectors already assume.
    for (const barrel of sourceBarrels) {
        for (const outer of codecSources([barrel])) {
            if (isInstanceCodec(outer)) {
                recordInstanceCodec(byKind, outer);
                continue;
            }
            for (const inner of codecSources([outer])) {
                if (isInstanceCodec(inner)) recordInstanceCodec(byKind, inner);
            }
        }
    }
    return byKind;
}

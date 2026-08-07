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
    type JsonValue,
    type RecordVersion
} from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { expectAgentCoreError } from "../protocol/error-assertion";

// The registry names every record by its declaring module; the barrels are the
// only way to reach the values, because a computed import specifier is a
// reference the import-boundary checker cannot verify.
const barrels: ReadonlyArray<Readonly<Record<string, unknown>>> = [
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
    decode(bytes: Uint8Array): unknown;
}

const packageUrl = new URL("../../", import.meta.url);
const rows = readRecordRegistry();

// A record whose codec is a class rather than a value is parameterised by the
// codecs of the references it embeds, so it has no registry-reachable instance.
const constructedCodecs = [
    "src/facets/operation.ts#BoundOperationRef.codec",
    "src/facets/operation.ts#FacetOperationRef.codec",
    "src/identity/guest-verification.ts#GuestVerification.codec",
    "src/invocations/approval.ts#ApprovalRecordCodec",
    "src/invocations/attempt.ts#EffectAttemptCodec",
    "src/invocations/audit.ts#AuditRecordCodecV1",
    "src/invocations/claim.ts#ItemClaimCodec",
    "src/invocations/continuation.ts#InvocationContinuationCodec",
    "src/invocations/prepared.ts#PreparedInvocationCodec",
    "src/invocations/publication.ts#InvocationPublicationOutboxCodecV1",
    "src/invocations/receipt.ts#ReceiptCodecV1",
    "src/invocations/replay.ts#MediatedReplayRecordCodecV1",
    "src/substrates/sqlite/tenant.ts#TenantBootstrapMarker.codec"
] as const;

const envelopeCodecs = rows.flatMap((row) => {
    const codec = resolveSelector(row.codec);
    return codec instanceof RecordCodec ? [{ row, codec }] : [];
});
const valueCodecs = rows.flatMap((row) => {
    const decode = resolveSelector(`${row.codec.slice(0, row.codec.lastIndexOf("."))}.decode`);
    return typeof decode === "function" && !(resolveSelector(row.codec) instanceof RecordCodec)
        ? [{ row, codec: { decode } as ValueCodec }]
        : [];
});

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

function expectTypedOrAccepted(operation: () => unknown): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
    }
}

function text(source: string): Uint8Array {
    return new TextEncoder().encode(source);
}

function resolveSelector(selector: string): unknown {
    const path = selector.slice(selector.indexOf("#") + 1).split(".");
    let value = lookup(path[0]!);
    for (const member of path.slice(1)) {
        if (value === undefined || value === null) return undefined;
        value = (value as Record<string, unknown>)[member];
    }
    return value;
}

function lookup(name: string): unknown {
    for (const barrel of barrels) {
        if (Object.hasOwn(barrel, name)) return barrel[name];
    }
    return undefined;
}

function readRecordRegistry(): readonly RecordRow[] {
    const index = readJson<{ fragments: readonly string[] }>("artifacts/records/index.json");
    return index.fragments.flatMap(
        (fragment) => readJson<{ records: RecordRow[] }>(`artifacts/records/${fragment}`).records
    );
}

function readJson<Value>(path: string): Value {
    return JSON.parse(readFileSync(new URL(path, packageUrl), "utf8")) as Value;
}

import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { RunCommitId } from "../../src/agents";
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { TenantId } from "../../src/identity";
import * as invocations from "../../src/invocations";
import {
    ApprovalId,
    AuditRecord,
    AuditRecordCodec,
    AuditRecordId,
    CorrelationId,
    EffectAttemptId,
    InvocationId,
    ReceiptId,
    RouteProjectionId,
    RouteReservationId,
    WriteRecordId,
    validateAuditAppend,
    type AuditEvidenceResolver,
    type AuditKind,
    type AuditRootAdmission,
    type WriteAuditOutcome
} from "../../src/invocations";
import { EventId } from "../../src/workspaces";

const actor = new ActorRef("run", new ActorId("audit-actor"));
const tenant = new TenantId("audit-tenant");
const correlation = new CorrelationId("audit-correlation");
let nextRecord = 0;

const writeOutcomes = [
    "committed",
    "rejectedMalformed",
    "rejectedAuthentication",
    "rejectedAuthority",
    "rejectedLifecycle",
    "rejectedRevision",
    "rejectedLease",
    "duplicate"
] as const satisfies readonly WriteAuditOutcome[];

const rejectedWriteOutcomes = writeOutcomes.filter((outcome) => outcome.startsWith("rejected"));

const codecKinds: readonly (readonly [string, AuditKind])[] = [
    ["invocation", { kind: "invocation", id: new InvocationId("invocation") }],
    ...(["pending", "approved", "denied", "expired", "consumed"] as const).map(
        (phase) =>
            [
                `approval ${phase}`,
                { kind: "approval", id: new ApprovalId(`approval-${phase}`), phase }
            ] as const
    ),
    ["attempt", { kind: "attempt", id: new EffectAttemptId("attempt") }],
    ...(
        ["deniedPreEffect", "cancelledPreEffect", "succeeded", "failed", "indeterminate"] as const
    ).map(
        (outcome) =>
            [
                `receipt ${outcome}`,
                { kind: "receipt", id: new ReceiptId(`receipt-${outcome}`), outcome }
            ] as const
    ),
    [
        "receipt superseded",
        {
            kind: "receiptSuperseded",
            previous: new ReceiptId("receipt-previous"),
            next: new ReceiptId("receipt-next")
        }
    ],
    ...writeOutcomes.map(
        (outcome) =>
            [
                `write ${outcome}`,
                { kind: "write", id: new WriteRecordId(`write-${outcome}`), outcome }
            ] as const
    ),
    ["event", { kind: "event", id: new EventId("event") }],
    ["route reserved", { kind: "routeReserved", id: new RouteReservationId("reservation") }],
    [
        "route projected",
        {
            kind: "routeProjected",
            projection: new RouteProjectionId("projection"),
            reservation: new RouteReservationId("projected-reservation")
        }
    ],
    ["delivery", { kind: "delivery", reservation: new RouteReservationId("delivery-reservation") }],
    ["commit", { kind: "commit", id: new RunCommitId("commit") }]
];

const representativeKinds: readonly (readonly [string, AuditKind])[] = Object.values(
    Object.fromEntries(codecKinds.map(([name, kind]) => [kind.kind, [name, kind] as const]))
);

const unsupportedRoots: readonly (readonly [string, AuditKind, AuditRootAdmission | undefined])[] =
    [
        ...representativeKinds
            .filter(([, kind]) => kind.kind !== "invocation" && kind.kind !== "write")
            .map(([name, kind]) => [name, kind, undefined] as const),
        [
            "invocation with root marker",
            { kind: "invocation", id: new InvocationId("marked-invocation") },
            { kind: "commandRejection" }
        ],
        [
            "committed write",
            { kind: "write", id: new WriteRecordId("root-committed"), outcome: "committed" },
            { kind: "commandRejection" }
        ],
        [
            "duplicate write",
            { kind: "write", id: new WriteRecordId("root-duplicate"), outcome: "duplicate" },
            { kind: "commandRejection" }
        ]
    ];

function audit(
    kind: AuditKind,
    cause?: AuditRecordId,
    init: {
        readonly actor?: ActorRef;
        readonly tenant?: TenantId;
        readonly correlation?: CorrelationId;
        readonly id?: AuditRecordId;
    } = {}
): AuditRecord {
    nextRecord += 1;
    return new AuditRecord({
        id: init.id ?? new AuditRecordId(`audit-${nextRecord}`),
        actor: init.actor ?? actor,
        tenant: init.tenant ?? tenant,
        correlation: init.correlation ?? correlation,
        ...(cause === undefined ? {} : { cause }),
        kind
    });
}

function lookup(...records: readonly AuditRecord[]): {
    get(id: AuditRecordId): AuditRecord | undefined;
} {
    return { get: (id) => records.find((record) => id.equals(record.id)) };
}

function writeEvidence(
    invocation: InvocationId,
    write: WriteRecordId,
    outcome: WriteAuditOutcome
): AuditEvidenceResolver {
    return {
        approval: () => undefined,
        attempt: () => undefined,
        receipt: () => undefined,
        event: () => undefined,
        route: () => undefined,
        projection: () => undefined,
        delivery: () => undefined,
        commit: () => undefined,
        write: (id) => (id.equals(write) ? { invocation, outcome } : undefined)
    };
}

function wireRecord(
    evidence: JsonValue,
    options: {
        readonly version?: { readonly major: number; readonly minor: number };
        readonly versionExtra?: Readonly<Record<string, JsonValue>>;
        readonly envelopeExtra?: Readonly<Record<string, JsonValue>>;
        readonly payloadExtra?: Readonly<Record<string, JsonValue>>;
        readonly actorExtra?: Readonly<Record<string, JsonValue>>;
    } = {}
): Uint8Array {
    return encodeCanonicalJson({
        kind: "audit-record",
        version: { ...(options.version ?? { major: 1, minor: 0 }), ...options.versionExtra },
        payload: {
            id: "wire-audit",
            actor: { kind: "run", id: "wire-actor", ...options.actorExtra },
            tenant: "wire-tenant",
            correlation: "wire-correlation",
            cause: null,
            evidence,
            ...options.payloadExtra
        },
        ...options.envelopeExtra
    });
}

function expectCodecError(bytes: Uint8Array, code: AgentCoreErrorCode): void {
    try {
        AuditRecordCodec.decode(bytes);
        throw new Error("Expected audit codec to reject the record");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
    }
}

describe("AuditRecord codec", () => {
    test.each(codecKinds)("round-trips the complete %s vocabulary", (_name, kind) => {
        const encoded = AuditRecordCodec.encode(audit(kind));
        const decoded = AuditRecordCodec.decode(encoded);

        expect(AuditRecordCodec.encode(decoded)).toEqual(encoded);
        expect(decoded.kind.kind).toBe(kind.kind);
    });

    test("uses v1.0 and the renamed attempt and projection identifiers", () => {
        const envelope = decodeCanonicalJson(AuditRecordCodec.encode(audit(codecKinds[0]![1])));
        const decodedAttempt = AuditRecordCodec.decode(
            wireRecord({ kind: "attempt", id: "renamed-attempt" })
        );
        const decodedProjection = AuditRecordCodec.decode(
            wireRecord({
                kind: "routeProjected",
                projection: "renamed-projection",
                reservation: "reservation"
            })
        );

        expect(envelope).toMatchObject({ kind: "audit-record", version: { major: 1, minor: 0 } });
        expect(decodedAttempt.kind).toMatchObject({ kind: "attempt" });
        expect(decodedAttempt.kind.kind === "attempt" && decodedAttempt.kind.id).toBeInstanceOf(
            EffectAttemptId
        );
        expect(decodedProjection.kind).toMatchObject({ kind: "routeProjected" });
        expect(
            decodedProjection.kind.kind === "routeProjected" && decodedProjection.kind.projection
        ).toBeInstanceOf(RouteProjectionId);
        expect(invocations).not.toHaveProperty("AttemptId");
        expect(invocations).not.toHaveProperty("ProjectionId");
        expect(invocations).not.toHaveProperty("DeliveryId");
    });

    test("encodes delivery with only its reservation", () => {
        const encoded = decodeCanonicalJson(
            AuditRecordCodec.encode(
                audit({
                    kind: "delivery",
                    reservation: new RouteReservationId("delivery-only-reservation")
                })
            )
        );

        expect(encoded).toMatchObject({
            payload: {
                evidence: { kind: "delivery", reservation: "delivery-only-reservation" }
            }
        });
        expect((encoded as { payload: { evidence: object } }).payload.evidence).not.toHaveProperty(
            "id"
        );
    });

    test("rejects the pre-public delivery id shape", () => {
        expectCodecError(
            wireRecord({
                kind: "delivery",
                id: "legacy-delivery",
                reservation: "delivery-reservation"
            }),
            "codec.invalid"
        );
    });

    test("rejects caused Invocation records in constructors and codec data", () => {
        expect(() =>
            audit(
                { kind: "invocation", id: new InvocationId("caused-invocation") },
                new AuditRecordId("invalid-invocation-cause")
            )
        ).toThrow(/cannot have a cause/);
        expectCodecError(
            encodeCanonicalJson({
                kind: "audit-record",
                version: { major: 1, minor: 0 },
                payload: {
                    id: "caused-wire-invocation",
                    actor: { kind: "run", id: "wire-actor" },
                    tenant: "wire-tenant",
                    correlation: "wire-correlation",
                    cause: "wire-cause",
                    evidence: { kind: "invocation", id: "wire-invocation" }
                }
            }),
            "codec.invalid"
        );
    });

    test("copies and freezes immutable AuditRecord data", () => {
        const mutableKind = {
            kind: "write" as const,
            id: new WriteRecordId("immutable-write"),
            outcome: "committed" as const
        };
        const record = audit(mutableKind);
        const encoded = AuditRecordCodec.encode(record);

        (mutableKind as { outcome: string }).outcome = "rejectedAuthority";
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.isFrozen(record.kind)).toBe(true);
        expect(record.kind).not.toBe(mutableKind);
        expect(record.kind).toMatchObject({ kind: "write", outcome: "committed" });
        expect(() => {
            (record as { cause?: AuditRecordId }).cause = new AuditRecordId("replacement-cause");
        }).toThrow(TypeError);
        expect(() => {
            (record.kind as { kind: string }).kind = "event";
        }).toThrow(TypeError);
        expect(AuditRecordCodec.encode(record)).toEqual(encoded);
    });

    test.each([
        [
            "envelope",
            wireRecord(
                { kind: "invocation", id: "invocation" },
                {
                    envelopeExtra: { unknown: true }
                }
            )
        ],
        [
            "version",
            wireRecord(
                { kind: "invocation", id: "invocation" },
                {
                    versionExtra: { patch: 0 }
                }
            )
        ],
        [
            "payload",
            wireRecord(
                { kind: "invocation", id: "invocation" },
                {
                    payloadExtra: { unknown: true }
                }
            )
        ],
        [
            "actor",
            wireRecord(
                { kind: "invocation", id: "invocation" },
                {
                    actorExtra: { unknown: true }
                }
            )
        ],
        ["evidence", wireRecord({ kind: "invocation", id: "invocation", unknown: true })]
    ] as const)("rejects unknown %s fields", (_name, bytes) => {
        expectCodecError(bytes, "codec.invalid");
    });

    test("rejects future minors and unknown majors", () => {
        expectCodecError(
            wireRecord(
                { kind: "invocation", id: "future-minor" },
                { version: { major: 1, minor: 1 } }
            ),
            "codec.invalid"
        );
        expectCodecError(
            wireRecord(
                { kind: "invocation", id: "unknown-major" },
                { version: { major: 2, minor: 0 } }
            ),
            "codec.unknown-major"
        );
    });

    test("rejects evidence outside the closed vocabulary", () => {
        expectCodecError(wireRecord({ kind: "unknown", id: "unknown" }), "codec.invalid");
    });
});

describe("AuditRecord append validation", () => {
    test("[C13-AUDIT-APPEND-ONLY] admits ordinary invocation roots", () => {
        expect(() =>
            validateAuditAppend(
                audit({ kind: "invocation", id: new InvocationId("root-invocation") }),
                lookup()
            )
        ).not.toThrow();
    });

    test.each(rejectedWriteOutcomes)(
        "admits cause-free %s only with command rejection admission",
        (outcome) => {
            const record = audit({
                kind: "write",
                id: new WriteRecordId(`root-${outcome}`),
                outcome
            });
            const admission: AuditRootAdmission = { kind: "commandRejection" };

            expect(() => validateAuditAppend(record, lookup(), admission)).not.toThrow();
            expect(() => validateAuditAppend(record, lookup())).toThrow(/not an admitted root/);
        }
    );

    test.each(unsupportedRoots)("rejects unsupported root %s", (_name, kind, admission) => {
        expect(() => validateAuditAppend(audit(kind), lookup(), admission)).toThrow(
            /not an admitted root/
        );
    });

    test.each(writeOutcomes)("permits the substantiated invocation -> %s write edge", (outcome) => {
        const invocationId = new InvocationId(`cause-${outcome}`);
        const writeId = new WriteRecordId(`caused-${outcome}`);
        const cause = audit({ kind: "invocation", id: invocationId });
        const next = audit(
            {
                kind: "write",
                id: writeId,
                outcome
            },
            cause.id
        );

        expect(() =>
            validateAuditAppend(
                next,
                lookup(cause),
                undefined,
                writeEvidence(invocationId, writeId, outcome)
            )
        ).not.toThrow();
    });

    test.each(
        representativeKinds.flatMap(([causeName, causeKind]) =>
            representativeKinds
                .filter(
                    ([, nextKind]) => causeKind.kind !== "invocation" || nextKind.kind !== "write"
                )
                .map(([nextName, nextKind]) => [causeName, nextName, causeKind, nextKind] as const)
        )
    )("rejects unsupported %s -> %s causality", (_causeName, _nextName, causeKind, nextKind) => {
        const cause = audit(causeKind);
        expect(() => validateAuditAppend(audit(nextKind, cause.id), lookup(cause))).toThrow(
            /not permitted|cannot have a cause/
        );
    });

    test("[C13-AUDIT-PREEXISTING-CAUSE] requires a preexisting cause", () => {
        const next = audit(
            {
                kind: "write",
                id: new WriteRecordId("missing-cause-write"),
                outcome: "committed"
            },
            new AuditRecordId("missing-cause")
        );

        expect(() => validateAuditAppend(next, lookup())).toThrow(/exist before append/);
    });

    test("[C13-ADV-NONPREEXISTING-AUDIT] rejects an audit edge whose cause has not been appended", () => {
        const next = audit(
            { kind: "attempt", id: new EffectAttemptId("nonpreexisting-attempt") },
            new AuditRecordId("nonpreexisting-cause")
        );

        expect(() => validateAuditAppend(next, lookup())).toThrow(/exist before append/);
    });

    test("[C13-ADV-UNBRIDGED-CROSS-ACTOR-AUDIT] rejects a direct cross-Actor audit cause", () => {
        const cause = audit({
            kind: "invocation",
            id: new InvocationId("cross-actor-invocation")
        });
        const next = audit(
            {
                kind: "write",
                id: new WriteRecordId("cross-actor-write"),
                outcome: "committed"
            },
            cause.id,
            { actor: new ActorRef("run", new ActorId("cross-actor-target")) }
        );

        expect(() => validateAuditAppend(next, lookup(cause))).toThrow(
            /share actor, tenant, and correlation/
        );
    });

    test.each([
        [
            "actor id",
            {
                actor: new ActorRef("run", new ActorId("other-actor"))
            }
        ],
        [
            "actor kind",
            {
                actor: new ActorRef("workspace", new ActorId("audit-actor"))
            }
        ],
        [
            "tenant",
            {
                tenant: new TenantId("other-tenant")
            }
        ],
        [
            "correlation",
            {
                correlation: new CorrelationId("other-correlation")
            }
        ]
    ] as const)("requires exact %s continuity", (_name, init) => {
        const cause = audit({ kind: "invocation", id: new InvocationId("scope-cause") });
        const next = audit(
            {
                kind: "write",
                id: new WriteRecordId("scope-write"),
                outcome: "committed"
            },
            cause.id,
            init
        );

        expect(() => validateAuditAppend(next, lookup(cause))).toThrow(
            /share actor, tenant, and correlation/
        );
    });

    test("[C13-ADV-RECEIPT-AGGREGATE] rejects root admission on a caused record", () => {
        const cause = audit({ kind: "invocation", id: new InvocationId("marked-cause") });
        const next = audit(
            {
                kind: "write",
                id: new WriteRecordId("marked-write"),
                outcome: "rejectedAuthority"
            },
            cause.id
        );

        expect(() =>
            validateAuditAppend(next, lookup(cause), { kind: "commandRejection" })
        ).toThrow(/invalid for a caused record/);
    });

    test("[C13-ADV-RECEIPT-SUPERSESSION] [audit-record] preserves append-only records", () => {
        const record = audit({ kind: "invocation", id: new InvocationId("existing-invocation") });

        expect(() => validateAuditAppend(record, lookup(record))).toThrow(/append-only/);
    });
});

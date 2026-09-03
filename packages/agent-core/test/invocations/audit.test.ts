import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { RunCommitId } from "../../src/agents";
import {
    Digest,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonValue
} from "../../src/core";
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
    InvocationError,
    InvocationId,
    ReceiptId,
    RouteProjectionId,
    RouteReservationId,
    WriteRecordId,
    auditEvidenceIdentity,
    validateAuditAppend,
    validateStoredAuditLinkage,
    type AuditEvidenceResolver,
    type AuditKind,
    type AuditRecordLookup,
    type AuditRootAdmission,
    type InvocationFailure,
    type WriteAuditOutcome
} from "../../src/invocations";
import { EventId } from "../../src/workspaces";

/** A write kind's outcome without its literal type, so the caller's copy can be changed. */
interface WritableWriteOutcome {
    outcome: string;
}

/** A record's own fields without their readonly modifier, so a write can be attempted. */
interface WritableAuditRecord {
    cause: AuditRecordId | undefined;
}

/** A record kind's own discriminant without its readonly modifier, so a write can be attempted. */
interface WritableAuditKind {
    kind: string;
}

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

// Stated, not filtered by the `rejected` prefix: deriving the expectation with the rule
// under test would make this suite agree with the implementation by construction.
const rejectedWriteOutcomes = [
    "rejectedAuthentication",
    "rejectedAuthority",
    "rejectedLease",
    "rejectedLifecycle",
    "rejectedMalformed",
    "rejectedRevision"
] as const satisfies readonly WriteAuditOutcome[];

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
    const init_ = {
        id: init.id ?? new AuditRecordId(`audit-${nextRecord}`),
        actor: init.actor ?? actor,
        tenant: init.tenant ?? tenant,
        correlation: init.correlation ?? correlation,
        kind
    };
    return new AuditRecord(cause === undefined ? init_ : { ...init_, cause });
}

/** Reads a field off canonical JSON this suite just encoded, failing loudly if it is absent. */
function jsonField(value: JsonValue, field: string): JsonValue {
    const member = isJsonObject(value) ? value[field] : undefined;
    if (member === undefined) throw new TypeError(`Expected encoded JSON carrying ${field}`);
    return member;
}

function lookup(...records: readonly AuditRecord[]): AuditRecordLookup {
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
        expect(error).toMatchObject({ code });
    }
}

describe("AuditRecord codec", () => {
    test(
        "[C13-AUDIT-TELEMETRY-EXCLUDED] refuses diagnostic evidence kinds outside the closed durable taxonomy",
        { tags: "p0" },
        () => {
            for (const kind of ["telemetry", "span", "log", "metric", "trace", "diagnostic"]) {
                expectCodecError(wireRecord({ kind, id: `${kind}-evidence` }), "codec.invalid");
            }
            const vocabulary = [...new Set(codecKinds.map(([, kind]) => kind.kind))].sort();
            expect(vocabulary).toEqual([
                "approval",
                "attempt",
                "commit",
                "delivery",
                "event",
                "invocation",
                "receipt",
                "receiptSuperseded",
                "routeProjected",
                "routeReserved",
                "write"
            ]);
        }
    );

    test.each(codecKinds)(
        "round-trips the complete %s vocabulary",
        { tags: "p1" },
        (_name, kind) => {
            const encoded = AuditRecordCodec.encode(audit(kind));
            const decoded = AuditRecordCodec.decode(encoded);

            expect(AuditRecordCodec.encode(decoded)).toEqual(encoded);
            expect(decoded.kind.kind).toBe(kind.kind);
        }
    );

    test("uses v1.0 and the renamed attempt and projection identifiers", { tags: "p2" }, () => {
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

    test("encodes delivery with only its reservation", { tags: "p1" }, () => {
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
        expect(jsonField(jsonField(encoded, "payload"), "evidence")).not.toHaveProperty("id");
    });

    test("rejects the pre-public delivery id shape", { tags: "p2" }, () => {
        expectCodecError(
            wireRecord({
                kind: "delivery",
                id: "legacy-delivery",
                reservation: "delivery-reservation"
            }),
            "codec.invalid"
        );
    });

    test("rejects caused Invocation records in constructors and codec data", { tags: "p1" }, () => {
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

    test("copies and freezes immutable AuditRecord data", { tags: "p0" }, () => {
        const mutableKind = {
            kind: "write" as const,
            id: new WriteRecordId("immutable-write"),
            outcome: "committed" as const
        };
        const record = audit(mutableKind);
        const encoded = AuditRecordCodec.encode(record);

        const writableOutcome: WritableWriteOutcome = mutableKind;

        writableOutcome.outcome = "rejectedAuthority";
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.isFrozen(record.kind)).toBe(true);
        expect(record.kind).not.toBe(mutableKind);
        expect(record.kind).toMatchObject({ kind: "write", outcome: "committed" });
        const writableRecord: WritableAuditRecord = record;
        const writableKind: WritableAuditKind = record.kind;

        expect(() => {
            writableRecord.cause = new AuditRecordId("replacement-cause");
        }).toThrow(TypeError);
        expect(() => {
            writableKind.kind = "event";
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
    ] as const)("rejects unknown %s fields", { tags: "p1" }, (_name, bytes) => {
        expectCodecError(bytes, "codec.invalid");
    });

    test("rejects future minors and unknown majors", { tags: "p2" }, () => {
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

    test("rejects evidence outside the closed vocabulary", { tags: "p1" }, () => {
        expectCodecError(wireRecord({ kind: "unknown", id: "unknown" }), "codec.invalid");
    });
});

describe("AuditRecord append validation", () => {
    test(
        "derives one canonical actor-owned identity for complete audit evidence",
        { tags: "p1" },
        () => {
            const kind = {
                kind: "receipt" as const,
                id: new ReceiptId("identity-receipt"),
                outcome: "indeterminate" as const
            };

            expect(
                auditEvidenceIdentity(actor, kind).equals(auditEvidenceIdentity(actor, kind))
            ).toBe(true);
            expect(
                auditEvidenceIdentity(actor, kind).equals(
                    auditEvidenceIdentity(
                        new ActorRef("run", new ActorId("other-audit-actor")),
                        kind
                    )
                )
            ).toBe(false);
            expect(
                auditEvidenceIdentity(actor, kind).equals(
                    auditEvidenceIdentity(
                        new ActorRef("workspace", new ActorId(actor.id.value)),
                        kind
                    )
                )
            ).toBe(false);
            expect(
                auditEvidenceIdentity(actor, kind).equals(
                    auditEvidenceIdentity(actor, { ...kind, outcome: "succeeded" })
                )
            ).toBe(false);
        }
    );

    test("[C13-AUDIT-APPEND-ONLY] admits ordinary invocation roots", { tags: "p1" }, () => {
        expect(() =>
            validateAuditAppend(
                audit({ kind: "invocation", id: new InvocationId("root-invocation") }),
                lookup()
            )
        ).not.toThrow();
    });

    test.each(rejectedWriteOutcomes)(
        "admits cause-free %s only with command rejection admission",
        { tags: "p1" },
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

    test.each(unsupportedRoots)(
        "rejects unsupported root %s",
        { tags: "p1" },
        (_name, kind, admission) => {
            expect(() => validateAuditAppend(audit(kind), lookup(), admission)).toThrow(
                /not an admitted root/
            );
        }
    );

    test.each(writeOutcomes)(
        "permits the substantiated invocation -> %s write edge",
        { tags: "p1" },
        (outcome) => {
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
        }
    );

    test.each(
        representativeKinds.flatMap(([causeName, causeKind]) =>
            representativeKinds
                .filter(
                    ([, nextKind]) => causeKind.kind !== "invocation" || nextKind.kind !== "write"
                )
                .map(([nextName, nextKind]) => [causeName, nextName, causeKind, nextKind] as const)
        )
    )(
        "rejects unsupported %s -> %s causality",
        { tags: "p1" },
        (_causeName, _nextName, causeKind, nextKind) => {
            const cause = audit(causeKind);
            expect(() => validateAuditAppend(audit(nextKind, cause.id), lookup(cause))).toThrow(
                /not permitted|cannot have a cause/
            );
        }
    );

    test("[C13-AUDIT-PREEXISTING-CAUSE] requires a preexisting cause", { tags: "p0" }, () => {
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

    test(
        "[C13-ADV-NONPREEXISTING-AUDIT] rejects an audit edge whose cause has not been appended",
        { tags: "p0" },
        () => {
            const next = audit(
                { kind: "attempt", id: new EffectAttemptId("nonpreexisting-attempt") },
                new AuditRecordId("nonpreexisting-cause")
            );

            expect(() => validateAuditAppend(next, lookup())).toThrow(/exist before append/);
        }
    );

    test(
        "[C13-ADV-UNBRIDGED-CROSS-ACTOR-AUDIT] rejects a direct cross-Actor audit cause",
        { tags: "p0" },
        () => {
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
        }
    );

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
    ] as const)("requires exact %s continuity", { tags: "p0" }, (_name, init) => {
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

    test(
        "[C13-ADV-RECEIPT-AGGREGATE] rejects root admission on a caused record",
        { tags: "p1" },
        () => {
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
        }
    );

    test("[audit-record] preserves append-only records", { tags: "p0" }, () => {
        const record = audit({ kind: "invocation", id: new InvocationId("existing-invocation") });

        expect(() => validateAuditAppend(record, lookup(record))).toThrow(/append-only/);
    });
});

const edgeKinds = {
    invocation: { kind: "invocation", id: new InvocationId("edge-invocation") },
    approvalPending: { kind: "approval", id: new ApprovalId("edge-approval"), phase: "pending" },
    approvalApproved: { kind: "approval", id: new ApprovalId("edge-approval"), phase: "approved" },
    approvalDenied: { kind: "approval", id: new ApprovalId("edge-approval"), phase: "denied" },
    approvalExpired: { kind: "approval", id: new ApprovalId("edge-approval"), phase: "expired" },
    approvalConsumed: { kind: "approval", id: new ApprovalId("edge-approval"), phase: "consumed" },
    attempt: { kind: "attempt", id: new EffectAttemptId("edge-attempt") },
    receipt: { kind: "receipt", id: new ReceiptId("edge-receipt"), outcome: "indeterminate" },
    receiptSuperseded: {
        kind: "receiptSuperseded",
        previous: new ReceiptId("edge-previous"),
        next: new ReceiptId("edge-next")
    },
    write: { kind: "write", id: new WriteRecordId("edge-write"), outcome: "committed" },
    event: { kind: "event", id: new EventId("edge-event") },
    routeReserved: { kind: "routeReserved", id: new RouteReservationId("edge-reservation") },
    routeProjected: {
        kind: "routeProjected",
        projection: new RouteProjectionId("edge-projection"),
        reservation: new RouteReservationId("edge-projected-reservation")
    },
    delivery: {
        kind: "delivery",
        reservation: new RouteReservationId("edge-delivery-reservation")
    },
    commit: { kind: "commit", id: new RunCommitId("edge-commit") }
} as const satisfies Record<string, AuditKind>;

type EdgeKindName = keyof typeof edgeKinds;

const permittedEdges: readonly (readonly [EdgeKindName, EdgeKindName])[] = [
    ["invocation", "approvalPending"],
    ["invocation", "attempt"],
    ["invocation", "receipt"],
    ["invocation", "write"],
    ["approvalApproved", "attempt"],
    ["approvalDenied", "receipt"],
    ["approvalExpired", "receipt"],
    ["attempt", "receipt"],
    ["receipt", "receiptSuperseded"],
    ["receipt", "event"],
    ["receipt", "commit"],
    ["receiptSuperseded", "event"],
    ["receiptSuperseded", "commit"],
    ["event", "routeReserved"],
    ["routeProjected", "delivery"],
    ["delivery", "commit"]
];

const forbiddenEdges: readonly (readonly [EdgeKindName, EdgeKindName])[] = [
    ["invocation", "event"],
    ["invocation", "commit"],
    ["invocation", "routeReserved"],
    ["invocation", "delivery"],
    ["approvalApproved", "receipt"],
    ["approvalApproved", "event"],
    ["approvalDenied", "attempt"],
    ["approvalDenied", "event"],
    ["approvalExpired", "attempt"],
    ["approvalPending", "attempt"],
    ["approvalPending", "receipt"],
    ["approvalConsumed", "attempt"],
    ["approvalConsumed", "receipt"],
    ["attempt", "event"],
    ["attempt", "commit"],
    ["receipt", "approvalPending"],
    ["receipt", "attempt"],
    ["receipt", "routeReserved"],
    ["receiptSuperseded", "receipt"],
    ["receiptSuperseded", "routeReserved"],
    ["event", "commit"],
    ["event", "event"],
    ["routeProjected", "event"],
    ["routeProjected", "commit"],
    ["routeReserved", "commit"],
    ["routeReserved", "event"],
    ["delivery", "event"],
    ["delivery", "receipt"],
    ["write", "event"],
    ["write", "commit"],
    ["commit", "event"],
    ["commit", "commit"]
];

describe("AuditRecord stored shape relation", () => {
    test(
        "admits stored invocation, route projection, and rejected write roots",
        { tags: "p1" },
        () => {
            expect(() =>
                validateStoredAuditLinkage(
                    audit({ kind: "invocation", id: new InvocationId("stored-root-invocation") }),
                    lookup()
                )
            ).not.toThrow();
            expect(() =>
                validateStoredAuditLinkage(audit(edgeKinds.routeProjected), lookup())
            ).not.toThrow();
            for (const outcome of rejectedWriteOutcomes) {
                expect(() =>
                    validateStoredAuditLinkage(
                        audit({
                            kind: "write",
                            id: new WriteRecordId(`stored-root-${outcome}`),
                            outcome
                        }),
                        lookup()
                    )
                ).not.toThrow();
            }
        }
    );

    test.each([
        [
            "committed write",
            { kind: "write", id: new WriteRecordId("stored-root-committed"), outcome: "committed" }
        ],
        [
            "duplicate write",
            { kind: "write", id: new WriteRecordId("stored-root-duplicate"), outcome: "duplicate" }
        ],
        ["event", { kind: "event", id: new EventId("stored-root-event") }],
        [
            "delivery",
            { kind: "delivery", reservation: new RouteReservationId("stored-root-delivery") }
        ],
        ["attempt", { kind: "attempt", id: new EffectAttemptId("stored-root-attempt") }]
    ] as const satisfies readonly (readonly [string, AuditKind])[])(
        "rejects the stored %s root",
        { tags: "p1" },
        (_name, kind) => {
            expect(() => validateStoredAuditLinkage(audit(kind), lookup())).toThrow(
                /Stored audit root kind is invalid/
            );
        }
    );

    test(
        "refuses a cause-free stored write root whose outcome no vocabulary declares",
        { tags: "p0" },
        () => {
            const forged: AuditKind = {
                kind: "write",
                id: new WriteRecordId("stored-root-forged"),
                // @ts-expect-error An outcome outside SPEC §8.5's vocabulary must not typecheck.
                outcome: "rejectedByHand"
            };

            expect(() => validateStoredAuditLinkage(audit(forged), lookup())).toThrow(
                /Stored audit root kind is invalid/
            );
        }
    );

    test.each(permittedEdges)(
        "permits the stored %s -> %s edge",
        { tags: "p1" },
        (causeName, nextName) => {
            const cause = audit(edgeKinds[causeName]);
            const next = audit(edgeKinds[nextName], cause.id);

            expect(() => validateStoredAuditLinkage(next, lookup(cause))).not.toThrow();
        }
    );

    test.each(forbiddenEdges)(
        "rejects the stored %s -> %s edge",
        { tags: "p1" },
        (causeName, nextName) => {
            const cause = audit(edgeKinds[causeName]);
            const next = audit(edgeKinds[nextName], cause.id);

            expect(() => validateStoredAuditLinkage(next, lookup(cause))).toThrow(/not permitted/);
        }
    );
});

describe("AuditRecord root admission", () => {
    test(
        "requires a projection evidence resolver for route projection roots",
        { tags: "p0" },
        () => {
            const projection = new RouteProjectionId("admission-projection");
            const reservation = new RouteReservationId("admission-reservation");
            const root = audit({ kind: "routeProjected", projection, reservation });

            expect(() =>
                validateAuditAppend(root, lookup(), {
                    kind: "routeProjection",
                    projection,
                    reservation
                })
            ).toThrow(/not an admitted root/);
        }
    );

    test("restricts route projection admissions to route projection roots", { tags: "p1" }, () => {
        const root = audit({ kind: "event", id: new EventId("admission-event") });

        expect(() =>
            validateAuditAppend(root, lookup(), {
                kind: "routeProjection",
                projection: new RouteProjectionId("admission-only-projection"),
                reservation: new RouteReservationId("admission-only-reservation")
            })
        ).toThrow(/not an admitted root/);
    });
});

const failureCases: readonly (readonly [string, InvocationFailure, RegExp, () => void])[] = [
    [
        "appending a duplicate record",
        "audit.append-conflict",
        /append-only/,
        () => {
            const existing = audit({
                kind: "invocation",
                id: new InvocationId("conflict-invocation")
            });
            validateAuditAppend(existing, lookup(existing));
        }
    ],
    [
        "admitting a caused record as a root",
        "audit.invalid-root",
        /invalid for a caused record/,
        () => {
            const cause = audit({ kind: "invocation", id: new InvocationId("code-cause") });
            const next = audit(
                {
                    kind: "write",
                    id: new WriteRecordId("code-write"),
                    outcome: "rejectedAuthority"
                },
                cause.id
            );
            validateAuditAppend(next, lookup(cause), { kind: "commandRejection" });
        }
    ],
    [
        "appending without a stored cause",
        "audit.missing-cause",
        /exist before append/,
        () => {
            validateAuditAppend(
                audit(
                    { kind: "attempt", id: new EffectAttemptId("code-missing-attempt") },
                    new AuditRecordId("code-missing-cause")
                ),
                lookup()
            );
        }
    ],
    [
        "breaking cause continuity",
        "audit.cause-mismatch",
        /share actor, tenant, and correlation/,
        () => {
            const cause = audit({ kind: "invocation", id: new InvocationId("code-scope-cause") });
            const next = audit(
                { kind: "attempt", id: new EffectAttemptId("code-scope-attempt") },
                cause.id,
                { tenant: new TenantId("code-other-tenant") }
            );
            validateAuditAppend(next, lookup(cause));
        }
    ],
    [
        "storing an unpermitted edge",
        "audit.evidence-mismatch",
        /attempt -> attempt is not permitted/,
        () => {
            const cause = audit({ kind: "attempt", id: new EffectAttemptId("code-edge-cause") });
            const next = audit(
                { kind: "attempt", id: new EffectAttemptId("code-edge-next") },
                cause.id
            );
            validateStoredAuditLinkage(next, lookup(cause));
        }
    ],
    [
        "storing an unsupported root",
        "audit.invalid-root",
        /Stored audit root kind is invalid/,
        () => {
            validateStoredAuditLinkage(
                audit({ kind: "event", id: new EventId("code-root-event") }),
                lookup()
            );
        }
    ],
    [
        "appending a non-admitted root",
        "audit.invalid-root",
        /not an admitted root/,
        () => {
            validateAuditAppend(
                audit({ kind: "commit", id: new RunCommitId("code-root-commit") }),
                lookup()
            );
        }
    ]
];

describe("AuditRecord failure codes", () => {
    test("reports every validation failure with its exact code and message", { tags: "p2" }, () => {
        for (const [scenario, failure, message, run] of failureCases) {
            try {
                run();
                throw new Error(`Expected the audit validation to fail for ${scenario}`);
            } catch (error) {
                expect(error, scenario).toBeInstanceOf(InvocationError);
                expect(error, scenario).toMatchObject({
                    failure,
                    message: expect.stringMatching(message)
                });
            }
        }
    });
});

describe("AuditRecord identity and copies", () => {
    test("derives the evidence identity from the audit-evidence.v1 domain", { tags: "p1" }, () => {
        const kind: AuditKind = { kind: "invocation", id: new InvocationId("domain-invocation") };
        const expected = Digest.sha256(
            encodeCanonicalJson({
                domain: "agent-core.audit-evidence.v1",
                actor: { kind: actor.kind, id: actor.id.value },
                evidence: { kind: "invocation", id: "domain-invocation" }
            })
        );

        expect(auditEvidenceIdentity(actor, kind).equals(expected)).toBe(true);
    });

    test("copies evidence identifiers into their own reference classes", { tags: "p1" }, () => {
        const reserved = audit({
            kind: "routeReserved",
            id: new RouteReservationId("copy-reservation")
        });
        const commitId = new RunCommitId("copy-commit");
        const committed = audit({ kind: "commit", id: commitId });
        const decoded = AuditRecordCodec.decode(
            wireRecord({ kind: "routeReserved", id: "decoded-reservation" })
        );

        expect(reserved.kind.kind === "routeReserved" && reserved.kind.id).toBeInstanceOf(
            RouteReservationId
        );
        expect(committed.kind.kind === "commit" && committed.kind.id).toBeInstanceOf(RunCommitId);
        expect(committed.kind.kind === "commit" && committed.kind.id).not.toBe(commitId);
        expect(committed.kind.kind === "commit" && commitId.equals(committed.kind.id)).toBe(true);
        expect(decoded.kind.kind === "routeReserved" && decoded.kind.id).toBeInstanceOf(
            RouteReservationId
        );
    });

    test("narrows attempt evidence to the exact EffectAttemptId class", { tags: "p0" }, () => {
        class DerivedAttemptId extends EffectAttemptId {}
        const derived = new DerivedAttemptId("narrowed-attempt");
        const record = audit({ kind: "attempt", id: derived });

        expect(record.kind.kind === "attempt" && record.kind.id.constructor).toBe(EffectAttemptId);
        expect(record.kind.kind === "attempt" && record.kind.id).not.toBe(derived);
        expect(
            record.kind.kind === "attempt" &&
                new EffectAttemptId("narrowed-attempt").equals(record.kind.id)
        ).toBe(true);
    });
});

describe("AuditRecord codec diagnostics", () => {
    test.each([
        ["null evidence", wireRecord(null), /Audit evidence must be an object/],
        ["numeric evidence", wireRecord(5), /Audit evidence must be an object/],
        [
            "non-string cause",
            wireRecord({ kind: "event", id: "diag-cause" }, { payloadExtra: { cause: false } }),
            /Audit cause must be a string or null/
        ],
        [
            "numeric id",
            wireRecord({ kind: "invocation", id: "diag-id" }, { payloadExtra: { id: 1 } }),
            /id must be a string/
        ],
        [
            "unknown actor kind",
            wireRecord(
                { kind: "invocation", id: "diag-actor" },
                { actorExtra: { kind: "operator" } }
            ),
            /Audit actor kind is invalid/
        ],
        [
            "unknown evidence kind",
            wireRecord({ kind: "mystery", id: "diag-kind" }),
            /Unknown audit evidence kind mystery/
        ]
    ] as const)("names the %s decode failure", { tags: "p2" }, (_name, bytes, message) => {
        expect(() => AuditRecordCodec.decode(bytes)).toThrow(message);
    });

    test.each(["tenant", "workspace", "run", "environment", "slate"] as const)(
        "decodes the %s audit actor kind",
        { tags: "p1" },
        (kind) => {
            const decoded = AuditRecordCodec.decode(
                wireRecord({ kind: "invocation", id: "actor-kind" }, { actorExtra: { kind } })
            );

            expect(decoded.actor.kind).toBe(kind);
        }
    );
});

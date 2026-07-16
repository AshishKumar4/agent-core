// @ts-nocheck
import { afterEach, describe, expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../src/actors";
import { RunCommitId } from "../../src/agents";
import { Digest } from "../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    ApprovalId,
    AuditRecord,
    AuditRecordId,
    CorrelationId,
    EffectAttemptId,
    InvocationId,
    ReceiptId,
    RouteProjectionId,
    RouteReservationId,
    WriteRecordId,
    type AuditKind
} from "../../src/invocations";
import {
    ProtocolPersistenceAdapter,
    WriteRecord,
    type CommandCaller,
    type CommandIdentity,
    type CommandOutcome
} from "../../src/protocol";
import { EventId } from "../../src/workspaces";
import { expectAgentCoreError } from "./error-assertion";

export interface ProtocolPersistenceHarness<Transaction> {
    readonly persistence: ProtocolPersistenceAdapter<Transaction>;
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    restart(): void;
    dispose(): void;
}

export type ProtocolPersistenceHarnessFactory<Transaction> =
    () => ProtocolPersistenceHarness<Transaction>;

export interface ProtocolTestRecords {
    readonly root: AuditRecord;
    readonly audit: AuditRecord;
    readonly write: WriteRecord;
    readonly identity: CommandIdentity;
}

interface ProtocolTestRecordOptions {
    readonly outcome?: CommandOutcome;
    readonly duplicateOf?: WriteRecordId;
    readonly auditWriteId?: WriteRecordId;
    readonly auditOutcome?: CommandOutcome;
    readonly actor?: ActorRef;
    readonly reply?: Uint8Array;
    readonly observation?: Uint8Array;
    readonly reserveIdentity?: boolean;
}

const tenant = new TenantId("persistence-tenant");
const defaultActor = new ActorRef("run", new ActorId("persistence-actor"));
const defaultCaller: CommandCaller = {
    kind: "principal",
    principal: new PrincipalRef(tenant, new PrincipalId("persistence-principal"))
};

export function protocolPersistenceContract<Transaction>(
    name: string,
    create: ProtocolPersistenceHarnessFactory<Transaction>
): void {
    describe(`ProtocolPersistence (${name})`, () => {
        const harnesses = new Set<ProtocolPersistenceHarness<Transaction>>();
        const open = (): ProtocolPersistenceHarness<Transaction> => {
            const harness = create();
            harnesses.add(harness);
            return harness;
        };
        afterEach(() => {
            for (const harness of harnesses) harness.dispose();
            harnesses.clear();
        });

        test("stores codec-backed records and resolves them synchronously", () => {
            const harness = open();
            const records = protocolTestRecords("codec", defaultCaller);

            const result = harness.transaction((transaction) => {
                appendProtocolTestRecords(harness.persistence, transaction, records);
                return {
                    write: harness.persistence.findWrite(transaction, records.identity),
                    byId: harness.persistence.findWriteById(transaction, records.write.id),
                    audit: harness.persistence.findAudit(transaction, records.audit.id)
                };
            });

            expect(result).not.toBeInstanceOf(Promise);
            expect(result.write?.id.equals(records.write.id)).toBe(true);
            expect(result.byId?.reply).toEqual(records.write.reply);
            expect(result.audit?.kind).toMatchObject({
                kind: "write",
                id: records.write.id,
                outcome: records.write.outcome
            });
        });

        test("[C13-PROTOCOL-WRITE-AUDIT-LINK] persists only reciprocal WriteRecord and AuditRecord links", () => {
            const harness = open();
            const linked = protocolTestRecords("write-audit-link", defaultCaller);
            harness.transaction((transaction) => {
                appendProtocolTestRecords(harness.persistence, transaction, linked);
            });
            harness.restart();
            harness.transaction((transaction) => {
                const write = harness.persistence.findWriteById(transaction, linked.write.id);
                const audit = harness.persistence.findAudit(transaction, linked.audit.id);
                expect(write?.audit.equals(linked.audit.id)).toBe(true);
                expect(audit?.kind).toMatchObject({
                    kind: "write",
                    id: linked.write.id,
                    outcome: linked.write.outcome
                });
            });

            const mismatched = protocolTestRecords("write-audit-mismatch", defaultCaller, {
                auditWriteId: new WriteRecordId("write-audit-other")
            });
            expect(() =>
                harness.transaction((transaction) => {
                    appendProtocolTestRecords(harness.persistence, transaction, mismatched);
                })
            ).toThrow(/not reciprocal/);
            harness.transaction((transaction) => {
                expect(
                    harness.persistence.findWriteById(transaction, mismatched.write.id)
                ).toBeUndefined();
                expect(
                    harness.persistence.findAudit(transaction, mismatched.audit.id)
                ).toBeUndefined();
            });
        });

        test("keeps caller and idempotency identity structurally distinct", () => {
            const harness = open();
            const identities = [
                protocolTestRecords(
                    "structured-a",
                    {
                        kind: "principal",
                        principal: new PrincipalRef(tenant, new PrincipalId("shared"))
                    },
                    { key: "part:tail" }
                ),
                protocolTestRecords(
                    "structured-b",
                    {
                        kind: "principal",
                        principal: new PrincipalRef(tenant, new PrincipalId("shared:part"))
                    },
                    { key: "tail" }
                ),
                protocolTestRecords(
                    "structured-c",
                    {
                        kind: "actor",
                        actor: new ActorRef("run", new ActorId("shared"))
                    },
                    { key: "part:tail" }
                ),
                protocolTestRecords(
                    "structured-d",
                    {
                        kind: "actor",
                        actor: new ActorRef("workspace", new ActorId("shared"))
                    },
                    { key: "part:tail" }
                ),
                protocolTestRecords(
                    "structured-e",
                    {
                        kind: "principal",
                        principal: new PrincipalRef(
                            new TenantId("persistence-other-tenant"),
                            new PrincipalId("shared")
                        )
                    },
                    { key: "part:tail" }
                )
            ];

            harness.transaction((transaction) => {
                for (const records of identities) {
                    appendProtocolTestRecords(harness.persistence, transaction, records);
                }
            });

            harness.transaction((transaction) => {
                for (const records of identities) {
                    expect(
                        harness.persistence.findWrite(transaction, records.identity)?.id.value
                    ).toBe(records.write.id.value);
                }
            });
        });

        test("reserves only the original write and leaves duplicate lookup unchanged", () => {
            const harness = open();
            const original = protocolTestRecords("original", defaultCaller);
            const duplicate = protocolTestRecords("duplicate", defaultCaller, {
                outcome: "duplicate",
                duplicateOf: original.write.id,
                key: original.identity.idempotencyKey,
                reply: original.write.reply
            });

            harness.transaction((transaction) => {
                appendProtocolTestRecords(harness.persistence, transaction, original);
                appendProtocolTestRecords(harness.persistence, transaction, duplicate);
            });

            harness.transaction((transaction) => {
                expect(
                    harness.persistence.findWrite(transaction, original.identity)?.id.value
                ).toBe(original.write.id.value);
                expect(
                    harness.persistence.findWriteById(transaction, duplicate.write.id)?.outcome
                ).toBe("duplicate");
            });
        });

        test("rejects a duplicate that does not name a reserved original", () => {
            const harness = open();
            const duplicate = protocolTestRecords("orphan-duplicate", defaultCaller, {
                outcome: "duplicate",
                duplicateOf: new WriteRecordId("missing-original")
            });

            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) => {
                        appendProtocolTestRecords(harness.persistence, transaction, duplicate);
                    }),
                "protocol.invalid-state"
            );

            harness.transaction((transaction) => {
                expect(
                    harness.persistence.findAudit(transaction, duplicate.root.id)
                ).toBeUndefined();
                expect(
                    harness.persistence.findWriteById(transaction, duplicate.write.id)
                ).toBeUndefined();
            });
        });

        test("rejects identity replacement and rolls back its staged audit and write", () => {
            const harness = open();
            const original = protocolTestRecords("identity-original", defaultCaller);
            const replacement = protocolTestRecords("identity-replacement", defaultCaller, {
                key: original.identity.idempotencyKey
            });
            harness.transaction((transaction) => {
                appendProtocolTestRecords(harness.persistence, transaction, original);
            });

            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) => {
                        appendProtocolTestRecords(harness.persistence, transaction, replacement);
                    }),
                "protocol.invalid-state"
            );

            harness.restart();
            harness.transaction((transaction) => {
                expect(
                    harness.persistence.findWrite(transaction, original.identity)?.id.value
                ).toBe(original.write.id.value);
                expect(
                    harness.persistence.findAudit(transaction, replacement.root.id)
                ).toBeUndefined();
                expect(
                    harness.persistence.findAudit(transaction, replacement.audit.id)
                ).toBeUndefined();
                expect(
                    harness.persistence.findWriteById(transaction, replacement.write.id)
                ).toBeUndefined();
            });
        });

        test("keeps malformed and unauthenticated writes out of the identity index", () => {
            const harness = open();
            const records = [
                protocolTestRecords("malformed", defaultCaller, { outcome: "rejectedMalformed" }),
                protocolTestRecords("unauthenticated", defaultCaller, {
                    outcome: "rejectedAuthentication"
                })
            ];

            harness.transaction((transaction) => {
                for (const record of records) {
                    appendProtocolTestRecords(harness.persistence, transaction, record, null);
                }
            });

            harness.transaction((transaction) => {
                for (const record of records) {
                    expect(
                        harness.persistence.findWrite(transaction, record.identity)
                    ).toBeUndefined();
                    expect(
                        harness.persistence.findWriteById(transaction, record.write.id)?.id.value
                    ).toBe(record.write.id.value);
                }
            });
        });

        test("reserves authenticated malformed writes and replays through duplicate lineage", () => {
            const harness = open();
            const malformed = protocolTestRecords("authenticated-malformed", defaultCaller, {
                outcome: "rejectedMalformed",
                reserveIdentity: true
            });
            const duplicate = protocolTestRecords(
                "authenticated-malformed-duplicate",
                defaultCaller,
                {
                    outcome: "duplicate",
                    duplicateOf: malformed.write.id,
                    key: malformed.identity.idempotencyKey,
                    reply: malformed.write.reply
                }
            );

            harness.transaction((transaction) => {
                appendProtocolTestRecords(harness.persistence, transaction, malformed);
                appendProtocolTestRecords(harness.persistence, transaction, duplicate);
            });

            harness.transaction((transaction) => {
                expect(
                    harness.persistence.findWrite(transaction, malformed.identity)?.id.value
                ).toBe(malformed.write.id.value);
                expect(
                    harness.persistence.findWriteById(transaction, duplicate.write.id)?.duplicateOf
                        ?.value
                ).toBe(malformed.write.id.value);
            });
        });

        test("enforces append-only audit and write identifiers", () => {
            const harness = open();
            const original = protocolTestRecords("append-only", defaultCaller);
            harness.transaction((transaction) => {
                appendProtocolTestRecords(harness.persistence, transaction, original);
            });

            const replacementRoot = new AuditRecord({
                id: original.root.id,
                actor: original.root.actor,
                tenant,
                correlation: new CorrelationId("replacement-correlation"),
                kind: { kind: "invocation", id: new InvocationId("replacement-invocation") }
            });
            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) => {
                        harness.persistence.appendAudit(transaction, replacementRoot);
                    }),
                "protocol.invalid-state"
            );

            const conflict = protocolTestRecords("write-conflict", defaultCaller, {
                auditWriteId: original.write.id
            });
            const conflictingWrite = copyWrite(conflict.write, {
                id: original.write.id,
                audit: conflict.audit.id
            });
            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) => {
                        harness.persistence.appendAudit(transaction, conflict.root);
                        harness.persistence.appendAudit(transaction, conflict.audit);
                        harness.persistence.appendWrite(transaction, conflictingWrite);
                    }),
                "protocol.invalid-state"
            );

            harness.transaction((transaction) => {
                expect(
                    harness.persistence.findAudit(transaction, conflict.root.id)
                ).toBeUndefined();
                expect(
                    harness.persistence.findAudit(transaction, conflict.audit.id)
                ).toBeUndefined();
                expect(
                    harness.persistence.findWriteById(transaction, original.write.id)?.audit.value
                ).toBe(original.audit.id.value);
            });
        });

        test.each(["id", "outcome", "actor"] as const)(
            "rejects non-reciprocal %s linkage and rolls back",
            (mismatch) => {
                const harness = open();
                const records = protocolTestRecords(`reciprocal-${mismatch}`, defaultCaller, {
                    ...(mismatch === "id"
                        ? { auditWriteId: new WriteRecordId(`other-${mismatch}`) }
                        : {}),
                    ...(mismatch === "outcome" ? { auditOutcome: "rejectedAuthority" } : {})
                });
                const write =
                    mismatch === "actor"
                        ? copyWrite(records.write, {
                              actor: new ActorRef("workspace", new ActorId("other-actor"))
                          })
                        : records.write;

                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) => {
                            harness.persistence.appendAudit(transaction, records.root);
                            harness.persistence.appendAudit(transaction, records.audit);
                            harness.persistence.appendWrite(transaction, write);
                        }),
                    "protocol.invalid-state"
                );

                harness.transaction((transaction) => {
                    expect(
                        harness.persistence.findAudit(transaction, records.root.id)
                    ).toBeUndefined();
                    expect(
                        harness.persistence.findAudit(transaction, records.audit.id)
                    ).toBeUndefined();
                    expect(
                        harness.persistence.findWriteById(transaction, records.write.id)
                    ).toBeUndefined();
                });
            }
        );

        test.each(["audit", "write", "identity"] as const)(
            "rolls back a fault at the %s persistence boundary",
            (boundary) => {
                const harness = open();
                const records = protocolTestRecords(
                    `rollback-${boundary}`,
                    defaultCaller,
                    boundary === "write" ? { outcome: "rejectedMalformed" } : {}
                );

                expect(() =>
                    harness.transaction((transaction) => {
                        harness.persistence.appendAudit(transaction, records.root);
                        if (boundary !== "audit") {
                            harness.persistence.appendAudit(transaction, records.audit);
                            harness.persistence.appendWrite(transaction, records.write);
                        }
                        throw new Error(`Injected ${boundary} boundary failure`);
                    })
                ).toThrow(`Injected ${boundary} boundary failure`);

                harness.restart();
                harness.transaction((transaction) => {
                    expect(
                        harness.persistence.findAudit(transaction, records.root.id)
                    ).toBeUndefined();
                    expect(
                        harness.persistence.findAudit(transaction, records.audit.id)
                    ).toBeUndefined();
                    expect(
                        harness.persistence.findWriteById(transaction, records.write.id)
                    ).toBeUndefined();
                    expect(
                        harness.persistence.findWrite(transaction, records.identity)
                    ).toBeUndefined();
                });
            }
        );

        test("retains committed records and rollback absence across restart", () => {
            const harness = open();
            const committed = protocolTestRecords("restart-committed", defaultCaller);
            const rolledBack = protocolTestRecords("restart-rolled-back", defaultCaller);
            harness.transaction((transaction) => {
                appendProtocolTestRecords(harness.persistence, transaction, committed);
            });

            expect(() =>
                harness.transaction((transaction) => {
                    appendProtocolTestRecords(harness.persistence, transaction, rolledBack);
                    throw new Error("Injected pre-restart failure");
                })
            ).toThrow("Injected pre-restart failure");

            harness.restart();
            harness.transaction((transaction) => {
                expect(
                    harness.persistence.findWrite(transaction, committed.identity)?.id.value
                ).toBe(committed.write.id.value);
                expect(
                    harness.persistence.findAudit(transaction, rolledBack.root.id)
                ).toBeUndefined();
                expect(
                    harness.persistence.findAudit(transaction, rolledBack.audit.id)
                ).toBeUndefined();
                expect(
                    harness.persistence.findWriteById(transaction, rolledBack.write.id)
                ).toBeUndefined();
                expect(
                    harness.persistence.findWrite(transaction, rolledBack.identity)
                ).toBeUndefined();
            });
        });

        test("rejects a codec-representable unsupported causal path without persistence", () => {
            const harness = open();
            const unsupported = protocolUnsupportedAuditRecords("unsupported").find(
                (record) => record.kind.kind === "commit"
            );
            if (unsupported === undefined) {
                throw new TypeError("Expected an unsupported commit audit fixture");
            }

            expect(() =>
                harness.transaction((transaction) => {
                    harness.persistence.appendAudit(transaction, unsupported);
                })
            ).toThrow("not an admitted root");

            harness.restart();
            harness.transaction((transaction) => {
                expect(harness.persistence.findAudit(transaction, unsupported.id)).toBeUndefined();
            });
        });
    });
}

export function protocolTestRecords(
    prefix: string,
    caller: CommandCaller = defaultCaller,
    options: ProtocolTestRecordOptions & { readonly key?: string } = {}
): ProtocolTestRecords {
    const actor = options.actor ?? defaultActor;
    const outcome = options.outcome ?? "committed";
    const idempotencyKey = options.key ?? `${prefix}-key`;
    const writeId = new WriteRecordId(`${prefix}-write`);
    const root = new AuditRecord({
        id: new AuditRecordId(`${prefix}-root-audit`),
        actor,
        tenant,
        correlation: new CorrelationId(`${prefix}-correlation`),
        kind: { kind: "invocation", id: new InvocationId(`${prefix}-invocation`) }
    });
    const audit = new AuditRecord({
        id: new AuditRecordId(`${prefix}-write-audit`),
        actor,
        tenant,
        correlation: root.correlation,
        cause: root.id,
        kind: {
            kind: "write",
            id: options.auditWriteId ?? writeId,
            outcome: options.auditOutcome ?? outcome
        }
    });
    const write = new WriteRecord({
        id: writeId,
        actor,
        envelopeDigest: Digest.sha256(new TextEncoder().encode(`${prefix}-envelope`)),
        caller,
        command: "test.command",
        ...(outcome === "rejectedAuthentication" ||
        (outcome === "rejectedMalformed" && options.reserveIdentity !== true)
            ? {}
            : { idempotencyKey }),
        at: new Date("2026-07-07T12:00:00.000Z"),
        outcome,
        audit: audit.id,
        ...(options.duplicateOf === undefined ? {} : { duplicateOf: options.duplicateOf }),
        reply: options.reply ?? new TextEncoder().encode(`${prefix}-reply`),
        ...(options.observation === undefined ? {} : { observation: options.observation })
    });
    return {
        root,
        audit,
        write,
        identity: { caller, idempotencyKey }
    };
}

export function protocolUnsupportedAuditRecords(prefix: string): readonly AuditRecord[] {
    const reservation = new RouteReservationId(`${prefix}-reservation`);
    const kinds: readonly AuditKind[] = [
        { kind: "approval", id: new ApprovalId(`${prefix}-approval`), phase: "pending" },
        { kind: "attempt", id: new EffectAttemptId(`${prefix}-attempt`) },
        {
            kind: "receipt",
            id: new ReceiptId(`${prefix}-receipt`),
            outcome: "succeeded"
        },
        {
            kind: "receiptSuperseded",
            previous: new ReceiptId(`${prefix}-previous-receipt`),
            next: new ReceiptId(`${prefix}-next-receipt`)
        },
        { kind: "event", id: new EventId(`${prefix}-event`) },
        { kind: "routeReserved", id: reservation },
        {
            kind: "routeProjected",
            projection: new RouteProjectionId(`${prefix}-projection`),
            reservation
        },
        { kind: "delivery", reservation },
        { kind: "commit", id: new RunCommitId(`${prefix}-commit`) }
    ];
    return kinds.map(
        (kind, index) =>
            new AuditRecord({
                id: new AuditRecordId(`${prefix}-unsupported-audit-${index}`),
                actor: defaultActor,
                tenant,
                correlation: new CorrelationId(`${prefix}-unsupported-correlation-${index}`),
                kind
            })
    );
}

export function appendProtocolTestRecords<Transaction>(
    persistence: ProtocolPersistenceAdapter<Transaction>,
    transaction: Transaction,
    records: ProtocolTestRecords,
    identity: CommandIdentity | null = records.identity
): void {
    persistence.appendAudit(transaction, records.root);
    persistence.appendAudit(transaction, records.audit);
    if (
        identity !== null &&
        (records.write.caller === undefined ||
            records.write.idempotencyKey !== identity.idempotencyKey)
    ) {
        throw new TypeError("Protocol test identity must match canonical write bytes");
    }
    persistence.appendWrite(transaction, records.write);
}

function copyWrite(
    write: WriteRecord,
    overrides: {
        readonly id?: WriteRecordId;
        readonly audit?: AuditRecordId;
        readonly actor?: ActorRef;
    }
): WriteRecord {
    return new WriteRecord({
        id: overrides.id ?? write.id,
        actor: overrides.actor ?? write.actor,
        envelopeDigest: write.envelopeDigest,
        ...(write.caller === undefined ? {} : { caller: write.caller }),
        ...(write.command === undefined ? {} : { command: write.command }),
        ...(write.idempotencyKey === undefined ? {} : { idempotencyKey: write.idempotencyKey }),
        at: write.at,
        outcome: write.outcome,
        audit: overrides.audit ?? write.audit,
        ...(write.duplicateOf === undefined ? {} : { duplicateOf: write.duplicateOf }),
        reply: write.reply,
        ...(write.observation === undefined ? {} : { observation: write.observation })
    });
}

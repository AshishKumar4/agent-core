// @ts-nocheck
import type { ActorRef } from "../../../../src/actors";
import { Digest, JsonSchema } from "../../../../src/core";
import { OperationDescriptor, OperationName } from "../../../../src/facets";
import { PrincipalId, PrincipalRef, TenantId } from "../../../../src/identity";
import {
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    ClaimWorkerId,
    CorrelationId,
    EffectAttempt,
    EffectAttemptId,
    InvocationId,
    ItemClaim,
    ItemClaimId,
    MemoryInvocationMediationPersistence,
    InvocationPublicationOutbox,
    InvocationPublicationDrainer,
    MediatedReplayRecord,
    PreEffectReceipt,
    ReceiptId,
    createInvocationMediationMemoryState,
    type InvocationEvidencePersistence,
    type InvocationReplayPersistence
} from "../../../../src/invocations";
import {
    SqliteInvocationMediationPersistence,
    SqliteInvocationPersistence
} from "../../../../src/substrates/sqlite/invocations";
import type { TransactionalSqlite } from "../../../../src/substrates/sqlite";
import { TestSqlite } from "../../../helpers/sqlite";
import { describe, expect, test } from "vitest";
import {
    admissionFor,
    attemptCodec,
    claimCodec,
    createLedger,
    invocationCodecs,
    prepared,
    preparedCodec
} from "../../../invocations/fixture";

describe("SqliteInvocationMediationPersistence", () => {
    test("[C13-PREPARED-SHARED-HEADER] [invocation-replay-persistence] [invocation-evidence-persistence] memory and SQLite satisfy one shared mediation contract", () => {
        const memoryState = createInvocationMediationMemoryState();
        const memory = new MemoryInvocationMediationPersistence();
        verifyMediationContract(memory, (operation) => operation(memoryState), "memory");

        const database = new TestSqlite();
        const sqlite = new SqliteInvocationMediationPersistence(database, {
            get: () => undefined,
            append: () => {
                throw new TypeError("audit append is not used by the shared contract");
            }
        });
        verifyMediationContract(
            sqlite,
            (operation) => database.transaction(() => operation(database)),
            "sqlite"
        );
    });

    test("[invocation.mediated-replay] [invocation.publication-outbox] persists replay revisions and durable publication acknowledgement", () => {
        const database = new TestSqlite();
        const persistence = new SqliteInvocationMediationPersistence(database, {
            get: () => undefined,
            append: () => {
                throw new TypeError("audit append is not used by this storage test");
            }
        });
        const descriptor = new OperationDescriptor(
            new OperationName("send"),
            "externalSend",
            new JsonSchema({}),
            new JsonSchema({})
        );
        const reserved = MediatedReplayRecord.reserve({
            ...replayBinding(),
            scope: "scope",
            requestKey: "request",
            facet: "workspace:target",
            operation: descriptor.name.value,
            descriptorDigest: Digest.sha256(new TextEncoder().encode("descriptor")),
            shape: { kind: "single" },
            rawPayloadIdentities: [Digest.sha256(new TextEncoder().encode("payload"))]
        });
        const prepared = reserved.prepare(
            new InvocationId("sqlite-mediated"),
            [{ value: 1 }],
            [[]]
        );
        const publication = InvocationPublicationOutbox.pending(
            Object.freeze({
                invocation: new InvocationId("sqlite-mediated"),
                receipt: new ReceiptId("sqlite-receipt"),
                audit: new AuditRecordId("sqlite-audit")
            })
        );

        database.transaction(() => {
            persistence.appendReplay(database, reserved);
            persistence.appendReplay(database, prepared);
            persistence.appendPublication(database, publication);
        });
        expect(persistence.replay(database, "scope", "request")?.revision.value).toBe(1);
        expect(persistence.pendingPublications(database)).toHaveLength(1);

        database.transaction(() => {
            const eventPublished = publication.eventPublished(new Date(10));
            persistence.appendPublication(database, eventPublished);
            expect(persistence.pendingPublications(database)[0]?.state).toMatchObject({
                kind: "pending",
                eventPublishedAt: new Date(10)
            });
            persistence.appendPublication(database, eventPublished.commitAppended(new Date(11)));
        });
        expect(persistence.pendingPublications(database)).toEqual([]);
        expect(persistence.publication(database, publication.id)?.state.kind).toBe("published");
    });

    test("[C13-ADV-RECEIPT-INDETERMINATE] atomically persists Receipt, Audit, and publication across crash and restart", () => {
        const database = new TestSqlite();
        const audits = new SqliteAuditStore(database);
        let evidence = new SqliteInvocationMediationPersistence(database, audits);
        let persistence = invocationPersistence(database);
        let ledger = createLedger(persistence);
        const invocation = prepared("sqlite-atomic-evidence");
        const claim = new ItemClaim<string>(
            new ItemClaimId("sqlite-atomic-claim"),
            invocation.header.id,
            0,
            0,
            {
                kind: "system",
                actor: invocation.header.actor,
                worker: new ClaimWorkerId("sqlite-atomic-worker")
            },
            new Date(10_000)
        );
        const attempt = new EffectAttempt<string, string>(
            new EffectAttemptId("sqlite-atomic-attempt"),
            invocation.header.id,
            0,
            0,
            claim.id,
            undefined,
            admissionFor(invocation.header.id.value, 0, 0),
            new Date(2_000),
            invocation.item(0).idempotencyKey,
            invocation.header.auditCause
        );
        const attemptAudit = audit(
            invocation.header.actor,
            new AuditRecordId("sqlite-atomic-attempt-audit"),
            invocation.header.auditCause,
            { kind: "attempt", id: attempt.id }
        );
        database.transaction(() => {
            ledger.prepare(database, invocation);
            ledger.claimItem(database, claim, new Date(1_000));
            ledger.admitAttemptWithAudit(
                database,
                attempt,
                new Date(2_000),
                attemptAudit,
                evidence
            );
        });

        const receipt = new AttemptReceipt(
            new ReceiptId("sqlite-atomic-receipt"),
            attempt.id,
            "succeeded",
            undefined,
            new Date(3_000),
            undefined
        );
        const receiptAudit = audit(
            invocation.header.actor,
            new AuditRecordId("sqlite-atomic-receipt-audit"),
            attemptAudit.id,
            { kind: "receipt", id: receipt.id, outcome: receipt.outcome }
        );
        const publication = InvocationPublicationOutbox.pending({
            invocation: invocation.header.id,
            receipt: receipt.id,
            audit: receiptAudit.id
        });

        const substitutedCause = audit(
            invocation.header.actor,
            new AuditRecordId("sqlite-substituted-cause-audit"),
            new AuditRecordId("sqlite-wrong-attempt-audit"),
            { kind: "receipt", id: receipt.id, outcome: receipt.outcome }
        );
        expect(() =>
            database.transaction(() =>
                ledger.recordAttemptReceiptWithAudit(
                    database,
                    receipt,
                    attemptAudit,
                    substitutedCause,
                    publication,
                    evidence
                )
            )
        ).toThrow(/does not bind the attempted effect/);
        expect(ledger.currentReceipt(database, invocation.header.id, 0)).toBeUndefined();

        expect(() =>
            database.transaction(() => {
                ledger.recordAttemptReceiptWithAudit(
                    database,
                    receipt,
                    attemptAudit,
                    receiptAudit,
                    publication,
                    evidence
                );
                throw new TypeError("forced crash");
            })
        ).toThrow("forced crash");
        expect(ledger.currentReceipt(database, invocation.header.id, 0)).toBeUndefined();
        expect(audits.has(receiptAudit.id)).toBe(false);
        expect(evidence.pendingPublications(database)).toEqual([]);

        database.transaction(() =>
            ledger.recordAttemptReceiptWithAudit(
                database,
                receipt,
                attemptAudit,
                receiptAudit,
                publication,
                evidence
            )
        );
        evidence = new SqliteInvocationMediationPersistence(database, audits);
        persistence = invocationPersistence(database);
        ledger = createLedger(persistence);
        expect(
            ledger.currentReceipt(database, invocation.header.id, 0)?.id.equals(receipt.id)
        ).toBe(true);
        expect(audits.has(receiptAudit.id)).toBe(true);
        expect(evidence.pendingPublications(database).map((record) => record.id.value)).toEqual([
            publication.id.value
        ]);
    });

    test("does not resend an acknowledged Event after a Commit sink crash", async () => {
        const database = new TestSqlite();
        const persistence = new SqliteInvocationMediationPersistence(
            database,
            new SqliteAuditStore(database)
        );
        const publication = InvocationPublicationOutbox.pending({
            invocation: new InvocationId("sqlite-partial-outbox"),
            receipt: new ReceiptId("sqlite-partial-receipt"),
            audit: new AuditRecordId("sqlite-partial-audit")
        });
        database.transaction(() => persistence.appendPublication(database, publication));
        const events: string[] = [];
        const commits: string[] = [];
        let crash = true;
        const drainer = new InvocationPublicationDrainer(
            {
                transact<Result>(operation: (transaction: TransactionalSqlite) => Result): Result {
                    return (database.transaction as unknown as (operation: () => Result) => Result)(
                        () => operation(database)
                    );
                }
            },
            persistence,
            { publish: async (id) => void events.push(id.value) },
            {
                append: async (id) => {
                    commits.push(id.value);
                    if (crash) {
                        crash = false;
                        throw new TypeError("sqlite commit crash");
                    }
                }
            },
            () => new Date(30)
        );

        await expect(drainer.flush()).rejects.toThrow("sqlite commit crash");
        await drainer.flush();
        expect(events).toEqual([publication.id.value]);
        expect(commits).toEqual([publication.id.value, publication.id.value]);
        expect(persistence.publication(database, publication.id)?.state.kind).toBe("published");
    });

    test("rejects duplicate or skipped replay and publication revisions across restart", () => {
        const database = new TestSqlite();
        const audits = new SqliteAuditStore(database);
        let persistence = new SqliteInvocationMediationPersistence(database, audits);
        const reserved = replay("sqlite-conflict");
        const prepared = reserved.prepare(new InvocationId("sqlite-conflict"), [{}], [[]]);
        const publication = InvocationPublicationOutbox.pending({
            invocation: new InvocationId("sqlite-conflict"),
            receipt: new ReceiptId("sqlite-conflict-receipt"),
            audit: new AuditRecordId("sqlite-conflict-audit")
        });
        database.transaction(() => {
            persistence.appendReplay(database, reserved);
            persistence.appendPublication(database, publication);
        });

        persistence = new SqliteInvocationMediationPersistence(database, audits);
        expect(() =>
            database.transaction(() => persistence.appendReplay(database, reserved))
        ).toThrow(/already exists|conflicted/);
        expect(() =>
            database.transaction(() =>
                persistence.appendReplay(
                    database,
                    new MediatedReplayRecord(
                        prepared.scope,
                        prepared.requestKey,
                        prepared.facet,
                        prepared.operation,
                        prepared.descriptorDigest,
                        prepared.principal,
                        prepared.authorityIdentity,
                        prepared.packageOperationPin,
                        prepared.execution,
                        prepared.shape,
                        prepared.items,
                        prepared.invocation,
                        prepared.revision.next()
                    )
                )
            )
        ).toThrow(/next reserved transition/);
        expect(() =>
            database.transaction(() => persistence.appendPublication(database, publication))
        ).toThrow(/next transition/);
        const orphanPublication = InvocationPublicationOutbox.pending({
            invocation: new InvocationId("sqlite-orphan-publication"),
            receipt: new ReceiptId("sqlite-orphan-publication-receipt"),
            audit: new AuditRecordId("sqlite-orphan-publication-audit")
        })
            .eventPublished(new Date(20))
            .commitAppended(new Date(21));
        expect(() =>
            database.transaction(() => persistence.appendPublication(database, orphanPublication))
        ).toThrow(/next transition/);
    });

    test("detects substituted replay and outbox projection columns after restart", () => {
        const database = new TestSqlite();
        const audits = new SqliteAuditStore(database);
        let persistence = new SqliteInvocationMediationPersistence(database, audits);
        const reserved = replay("sqlite-corrupt");
        const publication = InvocationPublicationOutbox.pending({
            invocation: new InvocationId("sqlite-corrupt"),
            receipt: new ReceiptId("sqlite-corrupt-receipt"),
            audit: new AuditRecordId("sqlite-corrupt-audit")
        });
        database.transaction(() => {
            persistence.appendReplay(database, reserved);
            persistence.appendPublication(database, publication);
        });
        database.run(
            "UPDATE invocation_mediated_replay_revisions SET revision = 1 WHERE replay_id = ?",
            [reserved.id.value]
        );
        database.run("UPDATE invocation_publication_outbox SET state = 'published' WHERE id = ?", [
            publication.id.value
        ]);
        persistence = new SqliteInvocationMediationPersistence(database, audits);

        expect(() => persistence.replayById(database, reserved.id)).toThrow(
            /projection is corrupt/
        );
        expect(() => persistence.publication(database, publication.id)).toThrow(
            /projection is corrupt/
        );
    });
});

function verifyMediationContract<Transaction>(
    persistence: InvocationReplayPersistence<Transaction> &
        InvocationEvidencePersistence<Transaction>,
    transaction: (operation: (transaction: Transaction) => void) => void,
    key: string
): void {
    const replay = MediatedReplayRecord.reserve({
        ...replayBinding(),
        scope: `scope-${key}`,
        requestKey: `request-${key}`,
        facet: "workspace:target",
        operation: "send",
        descriptorDigest: Digest.sha256(new TextEncoder().encode(`descriptor-${key}`)),
        shape: { kind: "single" },
        rawPayloadIdentities: [Digest.sha256(new TextEncoder().encode(`payload-${key}`))]
    });
    const publication = InvocationPublicationOutbox.pending({
        invocation: new InvocationId(`invocation-${key}`),
        receipt: new ReceiptId(`receipt-${key}`),
        audit: new AuditRecordId(`audit-${key}`)
    });
    transaction((scope) => {
        persistence.appendReplay(scope, replay);
        persistence.appendPublication(scope, publication);
        expect(
            persistence.replay(scope, replay.scope, replay.requestKey)?.id.equals(replay.id)
        ).toBe(true);
        expect(persistence.pendingPublications(scope)).toHaveLength(1);
        expect(() =>
            persistence.appendReplay(
                scope,
                MediatedReplayRecord.reserve({
                    ...replay,
                    principal: new PrincipalRef(
                        replay.principal.tenantId,
                        new PrincipalId(`substituted-${key}`)
                    ),
                    rawPayloadIdentities: replay.items.map((item) => item.rawPayloadIdentity)
                })
            )
        ).toThrow();
    });
}

function replay(id: string): MediatedReplayRecord {
    return MediatedReplayRecord.reserve({
        ...replayBinding(),
        scope: `scope:${id}`,
        requestKey: `request:${id}`,
        facet: "workspace:target",
        operation: "send",
        descriptorDigest: Digest.sha256(new TextEncoder().encode(`descriptor:${id}`)),
        shape: { kind: "single" },
        rawPayloadIdentities: [Digest.sha256(new TextEncoder().encode(`payload:${id}`))]
    });
}

function replayBinding() {
    return {
        principal: new PrincipalRef(
            new TenantId("sqlite-replay-tenant"),
            new PrincipalId("sqlite-replay-principal")
        ),
        authorityIdentity: new Digest("a".repeat(64)),
        packageOperationPin: new Digest("b".repeat(64)),
        execution: { kind: "lease" as const, digest: new Digest("c".repeat(64)) }
    };
}

class SqliteAuditStore {
    public constructor(private readonly database: TestSqlite) {
        database.transaction(() =>
            database.run(
                "CREATE TABLE IF NOT EXISTS invocation_test_audits (id TEXT PRIMARY KEY, record BLOB NOT NULL)",
                []
            )
        );
    }

    public append(database: TransactionalSqlite, record: AuditRecord): void {
        database.run("INSERT INTO invocation_test_audits (id, record) VALUES (?, ?)", [
            record.id.value,
            AuditRecord.encode(record)
        ]);
    }

    public get(database: TransactionalSqlite, id: AuditRecordId): AuditRecord | undefined {
        const row = database.all("SELECT record FROM invocation_test_audits WHERE id = ?", [
            id.value
        ])[0];
        const bytes = row?.["record"];
        return bytes instanceof Uint8Array ? AuditRecord.decode(bytes) : undefined;
    }

    public has(id: AuditRecordId): boolean {
        return (
            this.database.all("SELECT id FROM invocation_test_audits WHERE id = ?", [id.value])
                .length === 1
        );
    }
}

function invocationPersistence(database: TestSqlite) {
    return new SqliteInvocationPersistence(database, {
        prepared: preparedCodec,
        approval: invocationCodecs.approval,
        claim: claimCodec,
        attempt: attemptCodec,
        receipt: invocationCodecs.receipt,
        continuation: invocationCodecs.continuation,
        projectPrepared: (record) => ({ id: record.header.id.value }),
        projectApproval: (record) => ({
            id: record.id.value,
            invocation: record.invocation.value,
            revision: record.revision.value,
            phase: record.state.kind
        }),
        projectClaim: (record) => ({
            id: record.id.value,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            ordinal: record.attemptOrdinal
        }),
        projectAttempt: (record) => ({
            id: record.id.value,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            ordinal: record.ordinal,
            claim: record.claim.value
        }),
        projectReceipt: (record) => {
            if (record instanceof PreEffectReceipt) {
                return {
                    id: record.id.value,
                    variant: record.variant,
                    invocation: record.invocation.value,
                    itemIndex: record.itemIndex,
                    outcome: record.outcome
                };
            }
            if (record instanceof AttemptReceipt) {
                return {
                    id: record.id.value,
                    variant: record.variant,
                    attempt: record.attempt.value,
                    ...(record.previous === undefined ? {} : { previous: record.previous.value }),
                    outcome: record.outcome
                };
            }
            throw new TypeError("Unknown SQLite invocation Receipt");
        },
        projectContinuation: (record) => ({ invocation: record.invocation.value })
    });
}

function audit(
    actor: ActorRef,
    id: AuditRecordId,
    cause: AuditRecordId,
    kind: ConstructorParameters<typeof AuditRecord>[0]["kind"]
): AuditRecord {
    return new AuditRecord({
        id,
        actor,
        tenant: new TenantId("sqlite-atomic-tenant"),
        correlation: new CorrelationId("sqlite-atomic-correlation"),
        cause,
        kind
    });
}

import type { ActorRef } from "../../../../src/actors";
import { Digest, JsonSchema } from "../../../../src/core";
import { AgentCoreError } from "../../../../src/errors";
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
    ReceiptId,
    createInvocationMediationMemoryState,
    type InvocationEvidencePersistence,
    type InvocationReplayPersistence
} from "../../../../src/invocations";
import { SqliteInvocationMediationPersistence } from "../../../../src/substrates/sqlite/invocations";
import {
    SqliteProtocolPersistence,
    type SqliteRow,
    type SqliteValue,
    type TransactionalSqlite
} from "../../../../src/substrates/sqlite";
import { TestSqlite } from "../../../helpers/sqlite";
import { describe, expect, test } from "vitest";
import { admissionFor, createLedger, prepared } from "../../../invocations/fixture";
import { createSqliteInvocationPersistence } from "./fixture";

describe("SqliteInvocationMediationPersistence", () => {
    test("[C13-PREPARED-SHARED-HEADER] [invocation-replay-persistence] [invocation-evidence-persistence] memory and SQLite satisfy one shared mediation contract", () => {
        const memoryState = createInvocationMediationMemoryState();
        const memory = new MemoryInvocationMediationPersistence();
        verifyMediationContract(memory, (operation) => operation(memoryState), "memory");

        const database = new TestSqlite();
        const sqlite = new SqliteInvocationMediationPersistence(
            database,
            new SqliteProtocolPersistence(database)
        );
        verifyMediationContract(
            sqlite,
            (operation) => database.transaction(() => operation(database)),
            "sqlite"
        );
    });

    test("[invocation.mediated-replay] [invocation.publication-outbox] persists replay revisions and durable publication acknowledgement", () => {
        const database = new TestSqlite();
        const persistence = new SqliteInvocationMediationPersistence(
            database,
            new SqliteProtocolPersistence(database)
        );
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

    test(
        "[C13-ADV-RECEIPT-INDETERMINATE] atomically persists attempt, Receipt, and supersession audit edges through the invocation evidence port",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const audits = new SqliteProtocolPersistence(database);
            let evidence = new SqliteInvocationMediationPersistence(database, audits);
            let persistence = createSqliteInvocationPersistence(database);
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
            const invocationAudit = audit(
                invocation.header.actor,
                invocation.header.auditCause,
                undefined,
                { kind: "invocation", id: invocation.header.id }
            );
            const unrelatedAudit = audit(
                invocation.header.actor,
                new AuditRecordId("sqlite-unrelated-invocation-audit"),
                undefined,
                { kind: "invocation", id: new InvocationId("sqlite-unrelated-invocation") }
            );
            database.transaction(() => {
                ledger.prepareWithAudit(database, invocation, invocationAudit, evidence);
                audits.appendAudit(database, unrelatedAudit);
                ledger.claimItem(database, claim, new Date(1_000));
            });
            const substitutedAttemptCause = audit(
                invocation.header.actor,
                attemptAudit.id,
                unrelatedAudit.id,
                { kind: "attempt", id: attempt.id }
            );
            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        ledger.admitAttemptWithAudit(
                            database,
                            attempt,
                            new Date(2_000),
                            substitutedAttemptCause,
                            evidence
                        )
                    ),
                "invocation.invalid"
            );
            expect(persistence.attempt(database, attempt.id)).toBeUndefined();
            expect(audits.findAudit(database, attemptAudit.id)).toBeUndefined();
            database.transaction(() => {
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
                "indeterminate",
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
                receiptAudit.id,
                invocationAudit.id,
                { kind: "receipt", id: receipt.id, outcome: receipt.outcome }
            );
            expectAgentCoreError(
                () =>
                    database.transaction(() =>
                        ledger.recordAttemptReceiptWithAudit(
                            database,
                            receipt,
                            attemptAudit,
                            substitutedCause,
                            publication,
                            evidence
                        )
                    ),
                "invocation.invalid"
            );
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
            expect(audits.findAudit(database, receiptAudit.id)).toBeUndefined();
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
            persistence = createSqliteInvocationPersistence(database);
            ledger = createLedger(persistence);
            expect(
                ledger.currentReceipt(database, invocation.header.id, 0)?.id.equals(receipt.id)
            ).toBe(true);
            expect(audits.findAudit(database, receiptAudit.id)).toBeDefined();
            expect(evidence.pendingPublications(database).map((record) => record.id.value)).toEqual(
                [publication.id.value]
            );

            const finalReceipt = new AttemptReceipt(
                new ReceiptId("sqlite-atomic-final-receipt"),
                attempt.id,
                "succeeded",
                receipt.id,
                new Date(4_000),
                undefined
            );
            const supersessionAudit = audit(
                invocation.header.actor,
                new AuditRecordId("sqlite-atomic-supersession-audit"),
                receiptAudit.id,
                {
                    kind: "receiptSuperseded",
                    previous: receipt.id,
                    next: finalReceipt.id
                }
            );
            const finalReceiptAudit = audit(
                invocation.header.actor,
                new AuditRecordId("sqlite-atomic-final-receipt-audit"),
                attemptAudit.id,
                {
                    kind: "receipt",
                    id: finalReceipt.id,
                    outcome: finalReceipt.outcome
                }
            );
            const finalPublication = InvocationPublicationOutbox.pending({
                invocation: invocation.header.id,
                receipt: finalReceipt.id,
                audit: supersessionAudit.id
            });
            expect(() =>
                database.transaction(() => {
                    ledger.supersedeReceiptWithAudit(
                        database,
                        finalReceipt,
                        {
                            finalReceiptAudit,
                            supersessionAudit,
                            publication: finalPublication
                        },
                        evidence
                    );
                    throw new TypeError("forced supersession crash");
                })
            ).toThrow("forced supersession crash");
            expect(
                ledger.currentReceipt(database, invocation.header.id, 0)?.id.equals(receipt.id)
            ).toBe(true);
            expect(audits.findAudit(database, finalReceiptAudit.id)).toBeUndefined();
            expect(audits.findAudit(database, supersessionAudit.id)).toBeUndefined();

            database.transaction(() =>
                ledger.supersedeReceiptWithAudit(
                    database,
                    finalReceipt,
                    {
                        finalReceiptAudit,
                        supersessionAudit,
                        publication: finalPublication
                    },
                    evidence
                )
            );
            expect(
                ledger.currentReceipt(database, invocation.header.id, 0)?.id.equals(finalReceipt.id)
            ).toBe(true);
            expect(audits.findAudit(database, finalReceiptAudit.id)).toBeDefined();
            expect(audits.findAudit(database, supersessionAudit.id)).toBeDefined();
        }
    );

    test("does not resend an acknowledged Event after a Commit sink crash", async () => {
        const database = new TestSqlite();
        const persistence = new SqliteInvocationMediationPersistence(
            database,
            new SqliteProtocolPersistence(database)
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
        const audits = new SqliteProtocolPersistence(database);
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
        const audits = new SqliteProtocolPersistence(database);
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

describe("SqliteInvocationMediationPersistence conflict and corruption taxonomy", () => {
    function createPersistence() {
        const database = new TestSqlite();
        return {
            database,
            persistence: new SqliteInvocationMediationPersistence(
                database,
                new SqliteProtocolPersistence(database)
            )
        };
    }

    test("returns undefined when no replay reservation exists", { tags: "p1" }, () => {
        const { database, persistence } = createPersistence();
        expect(persistence.replay(database, "scope:absent", "request:absent")).toBeUndefined();
    });

    test("duplicate replay reservations carry the exact conflict message", { tags: "p0" }, () => {
        const { database, persistence } = createPersistence();
        const reserved = replay("sqlite-exact-reservation");
        database.transaction(() => persistence.appendReplay(database, reserved));
        expectExactError(
            () => database.transaction(() => persistence.appendReplay(database, reserved)),
            "invocation.invalid",
            "Replay reservation already exists"
        );
    });

    test("rejects replay revisions appended without a reservation", { tags: "p0" }, () => {
        const { database, persistence } = createPersistence();
        const unreserved = replay("sqlite-unreserved").prepare(
            new InvocationId("sqlite-unreserved"),
            [{}],
            [[]]
        );
        expectExactError(
            () => database.transaction(() => persistence.appendReplay(database, unreserved)),
            "invocation.invalid",
            "Replay revision is not the next reserved transition"
        );
    });

    test("fails closed when replay revisions hold a foreign replay record", { tags: "p1" }, () => {
        const { database, persistence } = createPersistence();
        const first = replay("sqlite-swap-first");
        const second = replay("sqlite-swap-second");
        database.transaction(() => {
            persistence.appendReplay(database, first);
            persistence.appendReplay(database, second);
        });
        const row = database.all(
            "SELECT record FROM invocation_mediated_replay_revisions WHERE replay_id = ?",
            [second.id.value]
        )[0];
        const blob = row?.record;
        expect(blob).toBeInstanceOf(Uint8Array);
        if (!(blob instanceof Uint8Array)) return;
        database.run(
            "UPDATE invocation_mediated_replay_revisions SET record = ? WHERE replay_id = ?",
            [blob, first.id.value]
        );
        expectExactError(
            () => persistence.replayById(database, first.id),
            "codec.invalid",
            "Stored invocation mediation projection is corrupt"
        );
    });

    test(
        "reports replay byte-level corruption with the exact codec failure",
        { tags: "p1" },
        () => {
            const { database, persistence } = createPersistence();
            const reserved = replay("sqlite-replay-bytes");
            database.transaction(() => persistence.appendReplay(database, reserved));
            database.run(
                "UPDATE invocation_mediated_replay_revisions SET record = 'corrupt-bytes' WHERE replay_id = ?",
                [reserved.id.value]
            );
            expectExactError(
                () => persistence.replayById(database, reserved.id),
                "codec.invalid",
                "Stored invocation mediation projection is corrupt"
            );
        }
    );

    test("fails closed on a substituted outbox id column", { tags: "p1" }, () => {
        const { database, persistence } = createPersistence();
        const publication = InvocationPublicationOutbox.pending({
            invocation: new InvocationId("sqlite-outbox-id"),
            receipt: new ReceiptId("sqlite-outbox-id-receipt"),
            audit: new AuditRecordId("sqlite-outbox-id-audit")
        });
        database.transaction(() => persistence.appendPublication(database, publication));
        database.run("UPDATE invocation_publication_outbox SET id = 'substituted-outbox'", []);
        expectExactError(
            () => persistence.pendingPublications(database),
            "codec.invalid",
            "Stored invocation mediation projection is corrupt"
        );
    });

    test("fails closed on a substituted outbox revision column", { tags: "p1" }, () => {
        const { database, persistence } = createPersistence();
        const publication = InvocationPublicationOutbox.pending({
            invocation: new InvocationId("sqlite-outbox-revision"),
            receipt: new ReceiptId("sqlite-outbox-revision-receipt"),
            audit: new AuditRecordId("sqlite-outbox-revision-audit")
        });
        database.transaction(() => persistence.appendPublication(database, publication));
        database.run("UPDATE invocation_publication_outbox SET revision = 4 WHERE id = ?", [
            publication.id.value
        ]);
        expectExactError(
            () => persistence.publication(database, publication.id),
            "codec.invalid",
            "Stored invocation mediation projection is corrupt"
        );
    });

    test(
        "fails closed when the substrate answers a publication lookup with a foreign row",
        { tags: "p1" },
        () => {
            const database = new RedirectingOutboxSqlite();
            const persistence = new SqliteInvocationMediationPersistence(
                database,
                new SqliteProtocolPersistence(database)
            );
            const requested = InvocationPublicationOutbox.pending({
                invocation: new InvocationId("sqlite-outbox-requested"),
                receipt: new ReceiptId("sqlite-outbox-requested-receipt"),
                audit: new AuditRecordId("sqlite-outbox-requested-audit")
            });
            const foreign = InvocationPublicationOutbox.pending({
                invocation: new InvocationId("sqlite-outbox-foreign"),
                receipt: new ReceiptId("sqlite-outbox-foreign-receipt"),
                audit: new AuditRecordId("sqlite-outbox-foreign-audit")
            });
            database.transaction(() => {
                persistence.appendPublication(database, requested);
                persistence.appendPublication(database, foreign);
            });
            database.redirect = foreign.id.value;
            expectExactError(
                () => persistence.publication(database, requested.id),
                "codec.invalid",
                "Stored invocation mediation projection is corrupt"
            );
        }
    );

    test("maps forced substrate append failures to the exact conflict", { tags: "p0" }, () => {
        const { database, persistence } = createPersistence();
        database.run(
            `CREATE TRIGGER outbox_conflict BEFORE INSERT ON invocation_publication_outbox
             BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END`,
            []
        );
        const publication = InvocationPublicationOutbox.pending({
            invocation: new InvocationId("sqlite-forced-outbox"),
            receipt: new ReceiptId("sqlite-forced-outbox-receipt"),
            audit: new AuditRecordId("sqlite-forced-outbox-audit")
        });
        expectExactError(
            () => database.transaction(() => persistence.appendPublication(database, publication)),
            "invocation.invalid",
            "Invocation mediation append conflicted"
        );
    });

    test(
        "rethrows substrate AgentCoreErrors instead of masking them as conflicts",
        { tags: "p0" },
        () => {
            const database = new FaultingMediationSqlite();
            const persistence = new SqliteInvocationMediationPersistence(
                database,
                new SqliteProtocolPersistence(database)
            );
            database.fault = () => {
                throw new AgentCoreError("codec.invalid", "substrate sentinel failure");
            };
            const publication = InvocationPublicationOutbox.pending({
                invocation: new InvocationId("sqlite-typed-outbox"),
                receipt: new ReceiptId("sqlite-typed-outbox-receipt"),
                audit: new AuditRecordId("sqlite-typed-outbox-audit")
            });
            expectExactError(
                () => persistence.appendPublication(database, publication),
                "codec.invalid",
                "substrate sentinel failure"
            );
        }
    );

    test("finds appended audits by their evidence identity", { tags: "p1" }, () => {
        const { database, persistence } = createPersistence();
        const invocation = prepared("sqlite-evidence-lookup");
        const record = audit(
            invocation.header.actor,
            new AuditRecordId("sqlite-evidence-lookup-audit"),
            undefined,
            { kind: "invocation", id: invocation.header.id }
        );
        database.transaction(() => persistence.appendAudit(database, record));
        expect(
            persistence
                .findAuditByEvidence(database, invocation.header.actor, record.kind)
                ?.id.equals(record.id)
        ).toBe(true);
        expect(persistence.audit(database, record.id)?.id.equals(record.id)).toBe(true);
    });
});

class RedirectingOutboxSqlite extends TestSqlite {
    public redirect: string | undefined;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (
            this.redirect !== undefined &&
            statement.includes("FROM invocation_publication_outbox") &&
            statement.includes("WHERE id = ?")
        ) {
            return super.all(statement, [this.redirect]);
        }
        return super.all(statement, bindings);
    }
}

class FaultingMediationSqlite extends TestSqlite {
    public fault: (() => never) | undefined;

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        if (
            this.fault !== undefined &&
            statement.includes("INSERT INTO invocation_publication_outbox")
        ) {
            this.fault();
        }
        super.run(statement, bindings);
    }
}

function expectExactError(
    operation: () => unknown,
    code: AgentCoreError["code"],
    message: string
): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        if (error instanceof AgentCoreError) {
            expect(error.code).toBe(code);
            expect(error.message).toBe(message);
        }
        return;
    }
    throw new TypeError(`Expected AgentCoreError ${code}`);
}

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

function audit(
    actor: ActorRef,
    id: AuditRecordId,
    cause: AuditRecordId | undefined,
    kind: ConstructorParameters<typeof AuditRecord>[0]["kind"]
): AuditRecord {
    return new AuditRecord({
        id,
        actor,
        tenant: new TenantId("sqlite-atomic-tenant"),
        correlation: new CorrelationId("sqlite-atomic-correlation"),
        ...(cause === undefined ? {} : { cause }),
        kind
    });
}

function expectAgentCoreError(operation: () => void, code: AgentCoreError["code"]): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
        return;
    }
    throw new TypeError(`Expected AgentCoreError ${code}`);
}

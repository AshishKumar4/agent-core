// @ts-nocheck
import type { SynchronousResultGuard } from "../../../../src/actors";
import {
    Approval,
    ApprovalId,
    AttemptReceipt,
    AuditRecordId,
    ClaimWorkerId,
    EffectAttempt,
    EffectAttemptId,
    InvocationError,
    InvocationId,
    InvocationContinuation,
    ItemClaim,
    ItemClaimId,
    MemoryInvocationPersistence,
    PreEffectReceipt,
    ReceiptId,
    createInvocationMemoryState,
    type PreparedInvocation
} from "../../../../src/invocations";
import { PrincipalId } from "../../../../src/identity";
import { SqliteInvocationPersistence } from "../../../../src/substrates/sqlite/invocations/persistence";
import { TransactionalSqlite } from "../../../../src/substrates/sqlite/sqlite";
import { TestSqlite } from "../../../helpers/sqlite";
import {
    attemptCodec,
    admissionFor,
    claimCodec,
    createLedger,
    invocationCodecs,
    prepared,
    preparedCodec,
    type InvocationHarness
} from "../../../invocations/fixture";
import { invocationLedgerContract } from "../../../invocations/ledger-contract";
import { describe, expect, test } from "vitest";

test("[invocation-persistence] memory and SQLite satisfy one shared codec-storage contract", () => {
    const memoryState = createInvocationMemoryState();
    const memory = new MemoryInvocationPersistence(invocationCodecs);
    verifyPreparedContract(memory, (operation) => operation(memoryState), "memory");

    const database = new TestSqlite();
    const sqlite = createPersistence(database);
    verifyPreparedContract(
        sqlite,
        (operation) => database.transaction(() => operation(database)),
        "sqlite"
    );
});

class SqliteHarness implements InvocationHarness<TransactionalSqlite> {
    public readonly database = new TestSqlite();
    public persistence = createPersistence(this.database);
    public ledger = createLedger(this.persistence);

    public transaction<Result>(operation: (transaction: TransactionalSqlite) => Result): Result {
        return this.database.transaction(
            () => operation(this.database),
            ...([] as SynchronousResultGuard<Result>)
        );
    }

    public restart(): void {
        this.persistence = createPersistence(this.database);
        this.ledger = createLedger(this.persistence);
    }

    public dispose(): void {}
}

function createPersistence(database: TransactionalSqlite) {
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
            if (record instanceof PreEffectReceipt)
                return {
                    id: record.id.value,
                    variant: record.variant,
                    invocation: record.invocation.value,
                    itemIndex: record.itemIndex,
                    outcome: record.outcome
                };
            if (record instanceof AttemptReceipt)
                return {
                    id: record.id.value,
                    variant: record.variant,
                    attempt: record.attempt.value,
                    ...(record.previous === undefined ? {} : { previous: record.previous.value }),
                    outcome: record.outcome
                };
            throw new TypeError("Unknown Receipt test record");
        },
        projectContinuation: (record) => ({ invocation: record.invocation.value })
    });
}

interface PreparedContract<Transaction> {
    insertPrepared(
        transaction: Transaction,
        record: PreparedInvocation<string, string, string, string>
    ): void;
    prepared(
        transaction: Transaction,
        id: InvocationId
    ): PreparedInvocation<string, string, string, string> | undefined;
}

function verifyPreparedContract<Transaction>(
    persistence: PreparedContract<Transaction>,
    transaction: (operation: (transaction: Transaction) => void) => void,
    key: string
): void {
    const record = prepared(`seam-${key}`);
    transaction((scope) => {
        persistence.insertPrepared(scope, record);
        expect(
            persistence.prepared(scope, record.header.id)?.intentDigest.equals(record.intentDigest)
        ).toBe(true);
    });
}

invocationLedgerContract("sqlite", () => new SqliteHarness());

describe("SqliteInvocationPersistence transaction scope", () => {
    test("[C13-ADV-SUPPLIED-ITEM-KEY] uses the supplied transaction for every operation", () => {
        const harness = new SqliteHarness();
        expect(() =>
            harness.persistence.prepared(
                new RejectingSqlite(),
                new InvocationId("foreign-transaction")
            )
        ).toThrow(/supplied transaction/);
        expect(() =>
            harness.persistence.insertPrepared(new RejectingSqlite(), prepared("foreign-write"))
        ).toThrow(/supplied transaction/);
    });

    test("returns undefined for every missing durable lookup", () => {
        const harness = new SqliteHarness();
        harness.transaction((transaction) => {
            expect(
                harness.persistence.prepared(transaction, new InvocationId("missing"))
            ).toBeUndefined();
            expect(
                harness.persistence.approval(transaction, new ApprovalId("missing"))
            ).toBeUndefined();
            expect(
                harness.persistence.approvalForInvocation(transaction, new InvocationId("missing"))
            ).toBeUndefined();
            expect(
                harness.persistence.approvalRevision(transaction, new ApprovalId("missing"), 1)
            ).toBeUndefined();
            expect(
                harness.persistence.claim(transaction, new ItemClaimId("missing"))
            ).toBeUndefined();
            expect(
                harness.persistence.attempt(transaction, new EffectAttemptId("missing"))
            ).toBeUndefined();
            expect(
                harness.persistence.attemptForClaim(transaction, new ItemClaimId("missing"))
            ).toBeUndefined();
            expect(
                harness.persistence.receipt(transaction, new ReceiptId("missing"))
            ).toBeUndefined();
        });
    });

    test("[C13-ADV-RECEIPT-SUCCEEDED] rejects orphan revisions, Receipts, and duplicate SQLite appends with typed errors", () => {
        const harness = new SqliteHarness();
        const invocation = prepared("sqlite-orphan");
        const pending = Approval.pending(
            new ApprovalId("sqlite-orphan"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000),
            new Date(5000)
        );
        const approved = pending.approve(new PrincipalId("approver"), new Date(2000));
        harness.transaction((transaction) => {
            expect(() => harness.persistence.appendApproval(transaction, approved)).toThrow(
                /projection/
            );
            expect(() =>
                harness.persistence.appendReceipt(
                    transaction,
                    new AttemptReceipt(
                        new ReceiptId("sqlite-orphan-receipt"),
                        new EffectAttemptId("missing-attempt"),
                        "failed",
                        undefined,
                        new Date(2000),
                        undefined
                    )
                )
            ).toThrow(InvocationError);
            harness.persistence.insertPrepared(transaction, invocation);
            expect(() => harness.persistence.insertPrepared(transaction, invocation)).toThrow(
                InvocationError
            );
        });
    });

    test("decodes source EffectAttempt bytes before appending an AttemptReceipt", () => {
        const harness = new SqliteHarness();
        const invocation = prepared("receipt-source-corruption");
        const claim = systemClaim("receipt-source-corruption", 0);
        const attempt = systemAttempt(invocation, claim, "receipt-source-corruption");
        harness.transaction((transaction) =>
            harness.persistence.appendAttempt(transaction, attempt)
        );
        harness.database.run(
            "UPDATE invocation_effect_attempts SET record = 'corrupt' WHERE id = ?",
            [attempt.id.value]
        );
        expect(() =>
            harness.persistence.appendReceipt(
                harness.database,
                new AttemptReceipt(
                    new ReceiptId("receipt-source-corruption"),
                    attempt.id,
                    "failed",
                    undefined,
                    new Date(3000),
                    undefined
                )
            )
        ).toThrow();
    });

    test.each([
        {
            name: "prepared key",
            setup: (harness: SqliteHarness) => {
                const invocation = prepared("corrupt-prepared");
                harness.transaction((transaction) =>
                    harness.persistence.insertPrepared(transaction, invocation)
                );
                harness.database.run("UPDATE invocation_prepared_records SET id = ? WHERE id = ?", [
                    "corrupt-prepared-key",
                    invocation.header.id.value
                ]);
                return () =>
                    harness.persistence.prepared(
                        harness.database,
                        new InvocationId("corrupt-prepared-key")
                    );
            }
        },
        {
            name: "Approval phase",
            setup: (harness: SqliteHarness) => {
                const invocation = prepared("corrupt-approval");
                const approval = Approval.pending(
                    new ApprovalId("corrupt-approval"),
                    invocation.header.id,
                    invocation.intentDigest,
                    new Date(1000)
                );
                harness.transaction((transaction) =>
                    harness.persistence.appendApproval(transaction, approval)
                );
                harness.database.run(
                    "UPDATE invocation_approval_revisions SET phase = 'approved' WHERE approval_id = ?",
                    [approval.id.value]
                );
                return () => harness.persistence.approval(harness.database, approval.id);
            }
        },
        {
            name: "claim ordinal",
            setup: (harness: SqliteHarness) => {
                const claim = systemClaim("corrupt-claim", 0);
                harness.transaction((transaction) =>
                    harness.persistence.appendClaim(transaction, claim)
                );
                harness.database.run("UPDATE invocation_item_claims SET ordinal = 1 WHERE id = ?", [
                    claim.id.value
                ]);
                return () => harness.persistence.claim(harness.database, claim.id);
            }
        },
        {
            name: "attempt claim",
            setup: (harness: SqliteHarness) => {
                const invocation = prepared("corrupt-attempt");
                const claim = systemClaim("corrupt-attempt", 0);
                const attempt = systemAttempt(invocation, claim, "corrupt-attempt");
                harness.transaction((transaction) =>
                    harness.persistence.appendAttempt(transaction, attempt)
                );
                harness.database.run(
                    "UPDATE invocation_effect_attempts SET claim_id = 'other' WHERE id = ?",
                    [attempt.id.value]
                );
                return () => harness.persistence.attempt(harness.database, attempt.id);
            }
        },
        {
            name: "Receipt outcome",
            setup: (harness: SqliteHarness) => {
                const receipt = new PreEffectReceipt(
                    new ReceiptId("corrupt-receipt"),
                    new InvocationId("corrupt-receipt-invocation"),
                    0,
                    "deniedPreEffect",
                    new Date(1000),
                    "denied"
                );
                harness.transaction((transaction) =>
                    harness.persistence.appendReceipt(transaction, receipt)
                );
                harness.database.run(
                    "UPDATE invocation_receipts SET outcome = 'failed' WHERE id = ?",
                    [receipt.id.value]
                );
                return () => harness.persistence.receipt(harness.database, receipt.id);
            }
        },
        {
            name: "record bytes",
            setup: (harness: SqliteHarness) => {
                const invocation = prepared("corrupt-bytes");
                harness.transaction((transaction) =>
                    harness.persistence.insertPrepared(transaction, invocation)
                );
                harness.database.run(
                    "UPDATE invocation_prepared_records SET record = 'not-bytes' WHERE id = ?",
                    [invocation.header.id.value]
                );
                return () => harness.persistence.prepared(harness.database, invocation.header.id);
            }
        }
    ])("fails closed on corrupt $name projections", ({ setup }) => {
        const harness = new SqliteHarness();
        expect(setup(harness)).toThrow(/Stored invocation projection|Invalid/);
    });

    test("[C13-PREPARED-APPROVAL-CONTINUATION] fails closed on orphaned Approval and continuation indexes after restart", () => {
        const harness = new SqliteHarness();
        const invocation = prepared("sqlite-restart-indexes");
        const approval = Approval.pending(
            new ApprovalId("sqlite-restart-indexes-approval"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );
        const continuation = new InvocationContinuation<string>(
            invocation.header.id,
            invocation.intentDigest,
            approval.id,
            new EffectAttemptId("sqlite-restart-indexes-attempt"),
            0,
            0,
            new ItemClaimId("sqlite-restart-indexes-claim"),
            {
                kind: "system",
                actor: invocation.header.actor,
                worker: new ClaimWorkerId("sqlite-restart-indexes-worker")
            },
            invocation.item(0).idempotencyKey,
            new Date(2000)
        );
        harness.transaction((transaction) => {
            harness.persistence.appendApproval(transaction, approval);
            harness.persistence.insertContinuation(transaction, continuation);
        });
        expect(
            harness.persistence.approvalRevision(harness.database, approval.id, 0)
        ).toMatchObject({
            id: approval.id
        });

        harness.database.run(
            "UPDATE invocation_approval_identities SET approval_id = 'missing-approval' WHERE invocation_id = ?",
            [invocation.header.id.value]
        );
        harness.database.run(
            "UPDATE invocation_continuations SET invocation_id = 'substituted-invocation' WHERE invocation_id = ?",
            [invocation.header.id.value]
        );
        harness.restart();
        expect(() =>
            harness.persistence.approvalForInvocation(harness.database, invocation.header.id)
        ).toThrow(/Stored invocation projection/);
        expect(() =>
            harness.persistence.continuation(
                harness.database,
                new InvocationId("substituted-invocation")
            )
        ).toThrow(/Stored invocation projection/);
    });

    test("[C13-RECEIPT-ATTEMPT-CHAIN] fails closed when an Attempt Receipt loses or changes its source attempt projection", () => {
        const orphan = new SqliteHarness();
        const invocation = prepared("sqlite-orphaned-receipt-source");
        const claim = systemClaim("sqlite-orphaned-receipt-source", 0);
        const attempt = systemAttempt(invocation, claim, "sqlite-orphaned-receipt-source");
        const receipt = new AttemptReceipt(
            new ReceiptId("sqlite-orphaned-receipt-source-receipt"),
            attempt.id,
            "failed",
            undefined,
            new Date(3000),
            undefined
        );
        orphan.transaction((transaction) => {
            orphan.persistence.appendAttempt(transaction, attempt);
            orphan.persistence.appendReceipt(transaction, receipt);
        });
        orphan.database.run("DELETE FROM invocation_effect_attempts WHERE id = ?", [
            attempt.id.value
        ]);
        orphan.restart();
        expect(() => orphan.persistence.receipt(orphan.database, receipt.id)).toThrow(
            /Stored invocation projection/
        );

        const substituted = new SqliteHarness();
        substituted.transaction((transaction) => {
            substituted.persistence.appendAttempt(transaction, attempt);
            substituted.persistence.appendReceipt(transaction, receipt);
        });
        substituted.database.run(
            "UPDATE invocation_receipts SET invocation_id = 'substituted' WHERE id = ?",
            [receipt.id.value]
        );
        substituted.restart();
        expect(() => substituted.persistence.receipt(substituted.database, receipt.id)).toThrow(
            /Stored invocation projection/
        );
    });
});

function systemClaim(id: string, ordinal: number): ItemClaim<string> {
    return new ItemClaim(
        new ItemClaimId(`${id}-claim`),
        new InvocationId(`${id}-invocation`),
        0,
        ordinal,
        {
            kind: "system",
            actor: prepared(`${id}-invocation`).header.actor,
            worker: new ClaimWorkerId(`${id}-worker`)
        },
        new Date(5000)
    );
}

function systemAttempt(
    invocation: ReturnType<typeof prepared>,
    claim: ItemClaim<string>,
    id: string
): EffectAttempt<string, string> {
    return new EffectAttempt<string, string>(
        new EffectAttemptId(`${id}-attempt`),
        invocation.header.id,
        0,
        claim.attemptOrdinal,
        claim.id,
        undefined,
        admissionFor(invocation.header.id.value, 0, claim.attemptOrdinal),
        new Date(2000),
        invocation.item(0).idempotencyKey,
        new AuditRecordId(`${id}-audit`)
    );
}

class RejectingSqlite extends TransactionalSqlite {
    public all(): never {
        throw new TypeError("supplied transaction was used");
    }

    public run(): never {
        throw new TypeError("supplied transaction was used");
    }

    public transaction<Result>(
        _operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        throw new TypeError("supplied transaction was used");
    }
}

import type { SynchronousResultGuard } from "../../../../src/actors";
import { encodeCanonicalJson } from "../../../../src/core";
import {
    Approval,
    ApprovalId,
    AttemptReceipt,
    AuditRecordId,
    ClaimWorkerId,
    createInvocationMemoryState,
    EffectAttempt,
    EffectAttemptId,
    InvocationContinuation,
    InvocationError,
    InvocationId,
    ItemClaim,
    ItemClaimId,
    MemoryInvocationPersistence,
    PreEffectReceipt,
    type PreparedInvocation,
    ReceiptId
} from "../../../../src/invocations";
import { PrincipalId } from "../../../../src/identity";
import { AgentCoreError } from "../../../../src/errors";
import {
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../../../src/substrates/sqlite/sqlite";
import { TestSqlite } from "../../../helpers/sqlite";
import {
    admissionFor,
    createLedger,
    failedByAbort,
    invocationCodecs,
    type InvocationHarness,
    prepared
} from "../../../invocations/fixture";
import { invocationLedgerContract } from "../../../invocations/ledger-contract";
import { createSqliteInvocationPersistence } from "./fixture";
import { describe, expect, test } from "vitest";

test(
    "[invocation-persistence] memory and SQLite satisfy one shared codec-storage contract",
    { tags: "p1" },
    () => {
        const memoryState = createInvocationMemoryState();
        const memory = new MemoryInvocationPersistence(invocationCodecs);
        verifyPreparedContract(memory, (operation) => operation(memoryState), "memory");

        const database = new TestSqlite();
        const sqlite = createSqliteInvocationPersistence(database);
        verifyPreparedContract(
            sqlite,
            (operation) => database.transaction(() => operation(database)),
            "sqlite"
        );
    }
);

class SqliteHarness implements InvocationHarness<TransactionalSqlite> {
    public readonly database = new TestSqlite();
    public persistence = createSqliteInvocationPersistence(this.database);
    public ledger = createLedger(this.persistence);

    public transaction<Result>(operation: (transaction: TransactionalSqlite) => Result): Result {
        // SAFETY: the guard is a phantom tuple that forces callers to prove their result
        // is synchronous. This double delegates a result the inner database already
        // checked, so it has nothing further to prove and passes the empty tuple.
        return this.database.transaction(
            () => operation(this.database),
            ...([] as SynchronousResultGuard<Result>)
        );
    }

    public restart(): void {
        this.persistence = createSqliteInvocationPersistence(this.database);
        this.ledger = createLedger(this.persistence);
    }

    public dispose(): void {}
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

invocationLedgerContract("sqlite", () => new SqliteHarness(), "excluded");

test(
    "[C13-RECEIPT-FAILURE-ORTHOGONAL] SQLite refuses pre-effect rows carrying a failure kind",
    { tags: "p0" },
    () => {
        // A row only a writer that bypassed the codec could insert: the projection columns
        // are consistent, so the refusal must come from decoding the record blob itself.
        const harness = new SqliteHarness();
        const record = encodeCanonicalJson({
            kind: "invocation.receipt",
            version: { major: 2, minor: 0 },
            payload: {
                failure: "raised",
                id: "sqlite-hostile",
                invocation: "sqlite-hostile-invocation",
                itemIndex: 0,
                outcome: "deniedPreEffect",
                reason: "denied",
                recordedAt: new Date(1000).toISOString(),
                variant: "preEffect"
            }
        });
        harness.database.run(
            `INSERT INTO invocation_receipts
             (id, variant, invocation_id, item_index, attempt_id, previous_id, outcome, record)
             VALUES ('sqlite-hostile', 'preEffect', 'sqlite-hostile-invocation', 0, NULL, NULL,
                     'deniedPreEffect', ?)`,
            [record]
        );
        expect(() =>
            harness.persistence.receipt(harness.database, new ReceiptId("sqlite-hostile"))
        ).toThrow(/Pre-effect Receipt contains missing or unknown fields/);
        expect(() =>
            harness.persistence.receiptsForItem(
                harness.database,
                new InvocationId("sqlite-hostile-invocation"),
                0
            )
        ).toThrow(/Pre-effect Receipt contains missing or unknown fields/);
    }
);

describe("SqliteInvocationPersistence transaction scope", () => {
    test(
        "uses the supplied transaction for every operation",
        { tags: "p0" },
        () => {
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
        }
    );

    test("returns undefined for every missing durable lookup", { tags: "p1" }, () => {
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

    test(
        "rejects orphan revisions, Receipts, and duplicate SQLite appends with typed errors",
        { tags: "p0" },
        () => {
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
                            failedByAbort,
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
        }
    );

    test(
        "decodes source EffectAttempt bytes before appending an AttemptReceipt",
        { tags: "p0" },
        () => {
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
                        failedByAbort,
                        undefined,
                        new Date(3000),
                        undefined
                    )
                )
            ).toThrow();
        }
    );

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
    ])("fails closed on corrupt $name projections", { tags: "p1" }, ({ setup }) => {
        const harness = new SqliteHarness();
        expect(setup(harness)).toThrow(/Stored invocation projection|Invalid/);
    });

    test(
        "[C13-PREPARED-APPROVAL-CONTINUATION] fails closed on orphaned Approval and continuation indexes after restart",
        { tags: "p0" },
        () => {
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
        }
    );

    test(
        "[C13-RECEIPT-ATTEMPT-CHAIN] fails closed when an Attempt Receipt loses or changes its source attempt projection",
        { tags: "p0" },
        () => {
            const orphan = new SqliteHarness();
            const invocation = prepared("sqlite-orphaned-receipt-source");
            const claim = systemClaim("sqlite-orphaned-receipt-source", 0);
            const attempt = systemAttempt(invocation, claim, "sqlite-orphaned-receipt-source");
            const receipt = new AttemptReceipt(
                new ReceiptId("sqlite-orphaned-receipt-source-receipt"),
                attempt.id,
                failedByAbort,
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
        }
    );
});

describe("SqliteInvocationPersistence append conflict taxonomy", () => {
    test("duplicate appends carry the exact duplicate-record failure", { tags: "p1" }, () => {
        const harness = new SqliteHarness();
        const invocation = prepared("sqlite-exact-duplicate");
        harness.transaction((transaction) =>
            harness.persistence.insertPrepared(transaction, invocation)
        );
        expectInvocationFailure(
            () => harness.persistence.insertPrepared(harness.database, invocation),
            "store.duplicate-record",
            "Invocation record append conflicted"
        );
    });

    test(
        "classifies substrate conflicts by SQLite result code, never by driver prose",
        { tags: "p1" },
        () => {
            // Extended result codes observed from both drivers this repo runs:
            // bun:sqlite exposes them as `errno`, node:sqlite as `errcode`. Only a
            // uniqueness violation is an append race. NOT NULL and CHECK are the
            // schema's corruption backstops and must reach the caller unchanged, and
            // a driver message is not a contract -- "no such column: unique_key" says
            // nothing about conflicts.
            const duplicates = [
                { errno: 1555, message: "UNIQUE constraint failed: prepared.id" },
                { errcode: 2067, message: "UNIQUE constraint failed: prepared.id" }
            ];
            for (const shape of duplicates) {
                const database = new FaultingSqlite();
                const persistence = createSqliteInvocationPersistence(database);
                database.fault = () => {
                    throw Object.assign(new TypeError(shape.message), shape);
                };
                expectInvocationFailure(
                    () => persistence.insertPrepared(database, prepared("sqlite-coded-conflict")),
                    "store.duplicate-record",
                    "Invocation record append conflicted"
                );
            }

            const passThrough = [
                { errno: 1299, message: "NOT NULL constraint failed: prepared.bytes" },
                { errcode: 275, message: "CHECK constraint failed: revision >= 0" },
                { errno: 1, message: "no such column: unique_key" },
                { code: "SQLITE_CONSTRAINT_UNIQUE", message: "row rejected" }
            ];
            for (const shape of passThrough) {
                const database = new FaultingSqlite();
                const persistence = createSqliteInvocationPersistence(database);
                const thrown = Object.assign(new TypeError(shape.message), shape);
                database.fault = () => {
                    throw thrown;
                };
                expect(() =>
                    persistence.insertPrepared(database, prepared("sqlite-passthrough"))
                ).toThrow(thrown);
            }
        }
    );

    test("rethrows non-constraint substrate errors unchanged", { tags: "p1" }, () => {
        const database = new FaultingSqlite();
        const persistence = createSqliteInvocationPersistence(database);
        database.fault = () => {
            throw Object.assign(new TypeError("disk io failure"), { code: "SQLITE_IOERR" });
        };
        let caught: unknown;
        try {
            persistence.insertPrepared(database, prepared("sqlite-io-failure"));
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TypeError);
        if (caught instanceof TypeError) expect(caught.message).toBe("disk io failure");
    });

    test("rethrows null substrate failures without conversion", { tags: "p1" }, () => {
        const database = new FaultingSqlite();
        const persistence = createSqliteInvocationPersistence(database);
        const torn = null;
        database.fault = () => {
            throw torn;
        };
        let caught: unknown;
        try {
            persistence.insertPrepared(database, prepared("sqlite-null-failure"));
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeNull();
    });

    test("rethrows non-object substrate failures without inspecting them", { tags: "p1" }, () => {
        const database = new FaultingSqlite();
        const persistence = createSqliteInvocationPersistence(database);
        const torn: unknown = undefined;
        database.fault = () => {
            throw torn;
        };
        let caught: unknown;
        try {
            persistence.insertPrepared(database, prepared("sqlite-undefined-failure"));
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeUndefined();
    });

    test("keeps substrate failures with a non-text message unclassified", { tags: "p1" }, () => {
        const database = new FaultingSqlite();
        const persistence = createSqliteInvocationPersistence(database);
        const torn = { message: ["unique constraint"] };
        database.fault = () => {
            throw torn;
        };
        let caught: unknown;
        try {
            persistence.insertPrepared(database, prepared("sqlite-nontext-message"));
        } catch (error) {
            caught = error;
        }
        expect(caught).toBe(torn);
    });

    test(
        "rethrows substrate AgentCoreErrors ahead of constraint classification",
        { tags: "p1" },
        () => {
            const database = new FaultingSqlite();
            const persistence = createSqliteInvocationPersistence(database);
            database.fault = () => {
                throw new AgentCoreError("codec.invalid", "unique constraint sentinel");
            };
            let caught: unknown;
            try {
                persistence.insertPrepared(database, prepared("sqlite-typed-failure"));
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(AgentCoreError);
            if (caught instanceof AgentCoreError) {
                expect(caught.code).toBe("codec.invalid");
                expect(caught.message).toBe("unique constraint sentinel");
            }
        }
    );
});

describe("SqliteInvocationPersistence projection integrity", () => {
    test("fails closed on every substituted Approval revision column", { tags: "p1" }, () => {
        const harness = new SqliteHarness();
        const approvals = ["id", "invocation", "revision"].map((key) => {
            const invocation = prepared(`sqlite-approval-${key}`);
            return Approval.pending(
                new ApprovalId(`sqlite-approval-${key}-approval`),
                invocation.header.id,
                invocation.intentDigest,
                new Date(1000)
            );
        });
        const [byId, byInvocation, byRevision] = approvals;
        harness.transaction((transaction) => {
            for (const approval of approvals) {
                harness.persistence.appendApproval(transaction, approval);
            }
        });
        expect(byId).toBeDefined();
        expect(byInvocation).toBeDefined();
        expect(byRevision).toBeDefined();
        if (byId === undefined || byInvocation === undefined || byRevision === undefined) return;

        harness.database.run(
            "UPDATE invocation_approval_revisions SET approval_id = 'sqlite-substituted-approval' WHERE approval_id = ?",
            [byId.id.value]
        );
        expectCorrupt(() =>
            harness.persistence.approval(
                harness.database,
                new ApprovalId("sqlite-substituted-approval")
            )
        );

        harness.database.run(
            "UPDATE invocation_approval_revisions SET invocation_id = 'sqlite-substituted-invocation' WHERE approval_id = ?",
            [byInvocation.id.value]
        );
        expectCorrupt(() => harness.persistence.approval(harness.database, byInvocation.id));

        harness.database.run(
            "UPDATE invocation_approval_revisions SET revision = 7 WHERE approval_id = ?",
            [byRevision.id.value]
        );
        expectCorrupt(() => harness.persistence.approval(harness.database, byRevision.id));
    });

    test(
        "fails closed when the Approval identity index points at a foreign Approval",
        { tags: "p1" },
        () => {
            const harness = new SqliteHarness();
            const first = prepared("sqlite-foreign-identity-first");
            const second = prepared("sqlite-foreign-identity-second");
            const firstApproval = Approval.pending(
                new ApprovalId("sqlite-foreign-identity-first-approval"),
                first.header.id,
                first.intentDigest,
                new Date(1000)
            );
            const secondApproval = Approval.pending(
                new ApprovalId("sqlite-foreign-identity-second-approval"),
                second.header.id,
                second.intentDigest,
                new Date(1000)
            );
            harness.transaction((transaction) => {
                harness.persistence.appendApproval(transaction, firstApproval);
                harness.persistence.appendApproval(transaction, secondApproval);
            });
            harness.database.run(
                "DELETE FROM invocation_approval_identities WHERE invocation_id = ?",
                [second.header.id.value]
            );
            harness.database.run(
                "UPDATE invocation_approval_identities SET approval_id = ? WHERE invocation_id = ?",
                [secondApproval.id.value, first.header.id.value]
            );
            expectCorrupt(() =>
                harness.persistence.approvalForInvocation(harness.database, first.header.id)
            );
        }
    );

    test(
        "rejects Approval revisions appended under a different Approval identity",
        { tags: "p1" },
        () => {
            const harness = new SqliteHarness();
            const invocation = prepared("sqlite-identity-mismatch");
            const original = Approval.pending(
                new ApprovalId("sqlite-identity-mismatch-original"),
                invocation.header.id,
                invocation.intentDigest,
                new Date(1000),
                new Date(5000)
            );
            const usurper = Approval.pending(
                new ApprovalId("sqlite-identity-mismatch-usurper"),
                invocation.header.id,
                invocation.intentDigest,
                new Date(1000),
                new Date(5000)
            ).approve(new PrincipalId("approver"), new Date(2000));
            harness.transaction((transaction) =>
                harness.persistence.appendApproval(transaction, original)
            );
            expectCorrupt(() => harness.persistence.appendApproval(harness.database, usurper));
        }
    );

    test("fails closed on every substituted claim column", { tags: "p1" }, () => {
        const harness = new SqliteHarness();
        const byId = systemClaim("sqlite-claim-id", 0);
        const byInvocation = systemClaim("sqlite-claim-invocation", 0);
        const byItem = systemClaim("sqlite-claim-item", 0);
        harness.transaction((transaction) => {
            harness.persistence.appendClaim(transaction, byId);
            harness.persistence.appendClaim(transaction, byInvocation);
            harness.persistence.appendClaim(transaction, byItem);
        });

        harness.database.run(
            "UPDATE invocation_item_claims SET id = 'sqlite-substituted-claim' WHERE id = ?",
            [byId.id.value]
        );
        expectCorrupt(() =>
            harness.persistence.claim(harness.database, new ItemClaimId("sqlite-substituted-claim"))
        );

        harness.database.run(
            "UPDATE invocation_item_claims SET invocation_id = 'sqlite-substituted-invocation' WHERE id = ?",
            [byInvocation.id.value]
        );
        expectCorrupt(() => harness.persistence.claim(harness.database, byInvocation.id));

        harness.database.run("UPDATE invocation_item_claims SET item_index = 6 WHERE id = ?", [
            byItem.id.value
        ]);
        expectCorrupt(() => harness.persistence.claim(harness.database, byItem.id));
    });

    test("fails closed on every substituted attempt column", { tags: "p1" }, () => {
        const harness = new SqliteHarness();
        const attempts = ["id", "invocation", "item", "ordinal"].map((key) => {
            const invocation = prepared(`sqlite-attempt-${key}`);
            const claim = systemClaim(`sqlite-attempt-${key}`, 0);
            return systemAttempt(invocation, claim, `sqlite-attempt-${key}`);
        });
        const [byId, byInvocation, byItem, byOrdinal] = attempts;
        harness.transaction((transaction) => {
            for (const attempt of attempts) {
                harness.persistence.appendAttempt(transaction, attempt);
            }
        });
        expect(byId).toBeDefined();
        expect(byInvocation).toBeDefined();
        expect(byItem).toBeDefined();
        expect(byOrdinal).toBeDefined();
        if (
            byId === undefined ||
            byInvocation === undefined ||
            byItem === undefined ||
            byOrdinal === undefined
        ) {
            return;
        }

        harness.database.run(
            "UPDATE invocation_effect_attempts SET id = 'sqlite-substituted-attempt' WHERE id = ?",
            [byId.id.value]
        );
        expectCorrupt(() => harness.persistence.attemptForClaim(harness.database, byId.claim));

        harness.database.run(
            "UPDATE invocation_effect_attempts SET invocation_id = 'sqlite-substituted-invocation' WHERE id = ?",
            [byInvocation.id.value]
        );
        expectCorrupt(() => harness.persistence.attempt(harness.database, byInvocation.id));

        harness.database.run("UPDATE invocation_effect_attempts SET item_index = 6 WHERE id = ?", [
            byItem.id.value
        ]);
        expectCorrupt(() => harness.persistence.attempt(harness.database, byItem.id));

        harness.database.run("UPDATE invocation_effect_attempts SET ordinal = 6 WHERE id = ?", [
            byOrdinal.id.value
        ]);
        expectCorrupt(() => harness.persistence.attempt(harness.database, byOrdinal.id));
    });

    test("fails closed on every substituted preEffect Receipt column", { tags: "p1" }, () => {
        const harness = new SqliteHarness();
        const receipts = ["id", "invocation", "item"].map(
            (key) =>
                new PreEffectReceipt(
                    new ReceiptId(`sqlite-receipt-${key}`),
                    new InvocationId(`sqlite-receipt-${key}-invocation`),
                    0,
                    "deniedPreEffect",
                    new Date(1000),
                    "denied"
                )
        );
        const [byId, byInvocation, byItem] = receipts;
        harness.transaction((transaction) => {
            for (const receipt of receipts) {
                harness.persistence.appendReceipt(transaction, receipt);
            }
        });
        expect(byId).toBeDefined();
        expect(byInvocation).toBeDefined();
        expect(byItem).toBeDefined();
        if (byId === undefined || byInvocation === undefined || byItem === undefined) return;

        harness.database.run(
            "UPDATE invocation_receipts SET id = 'sqlite-substituted-receipt' WHERE id = ?",
            [byId.id.value]
        );
        expectCorrupt(() =>
            harness.persistence.receipt(
                harness.database,
                new ReceiptId("sqlite-substituted-receipt")
            )
        );

        harness.database.run(
            "UPDATE invocation_receipts SET invocation_id = 'sqlite-substituted-invocation' WHERE id = ?",
            [byInvocation.id.value]
        );
        expectCorrupt(() => harness.persistence.receipt(harness.database, byInvocation.id));

        harness.database.run("UPDATE invocation_receipts SET item_index = 6 WHERE id = ?", [
            byItem.id.value
        ]);
        expectCorrupt(() => harness.persistence.receipt(harness.database, byItem.id));
    });

    test("fails closed on substituted attempt Receipt pointers", { tags: "p1" }, () => {
        const harness = new SqliteHarness();
        const sources = ["substituted", "previous", "item"].map((key) => {
            const invocation = prepared(`sqlite-receipt-pointer-${key}`);
            const claim = systemClaim(`sqlite-receipt-pointer-${key}`, 0);
            return systemAttempt(invocation, claim, `sqlite-receipt-pointer-${key}`);
        });
        const siblingInvocation = prepared("sqlite-receipt-pointer-sibling");
        const siblingClaim = systemClaim("sqlite-receipt-pointer-sibling", 0);
        const sibling = systemAttempt(
            siblingInvocation,
            siblingClaim,
            "sqlite-receipt-pointer-sibling"
        );
        const [substituted, forgedPrevious, movedItem] = sources;
        harness.transaction((transaction) => {
            for (const attempt of [...sources, sibling]) {
                harness.persistence.appendAttempt(transaction, attempt);
            }
        });
        expect(substituted).toBeDefined();
        expect(forgedPrevious).toBeDefined();
        expect(movedItem).toBeDefined();
        if (substituted === undefined || forgedPrevious === undefined || movedItem === undefined) {
            return;
        }
        const receiptFor = (attempt: EffectAttempt<string, string>, key: string) =>
            new AttemptReceipt(
                new ReceiptId(`sqlite-receipt-pointer-${key}-receipt`),
                attempt.id,
                failedByAbort,
                undefined,
                new Date(3000),
                undefined
            );
        const substitutedReceipt = receiptFor(substituted, "substituted");
        const forgedPreviousReceipt = receiptFor(forgedPrevious, "previous");
        const movedItemReceipt = receiptFor(movedItem, "item");
        harness.transaction((transaction) => {
            harness.persistence.appendReceipt(transaction, substitutedReceipt);
            harness.persistence.appendReceipt(transaction, forgedPreviousReceipt);
            harness.persistence.appendReceipt(transaction, movedItemReceipt);
        });

        harness.database.run("UPDATE invocation_receipts SET attempt_id = ? WHERE id = ?", [
            sibling.id.value,
            substitutedReceipt.id.value
        ]);
        expectCorrupt(() => harness.persistence.receipt(harness.database, substitutedReceipt.id));

        harness.database.run(
            "UPDATE invocation_receipts SET previous_id = 'sqlite-ghost-previous' WHERE id = ?",
            [forgedPreviousReceipt.id.value]
        );
        expectCorrupt(() =>
            harness.persistence.receipt(harness.database, forgedPreviousReceipt.id)
        );

        harness.database.run("UPDATE invocation_receipts SET item_index = 6 WHERE id = ?", [
            movedItemReceipt.id.value
        ]);
        expectCorrupt(() => harness.persistence.receipt(harness.database, movedItemReceipt.id));
    });

    test("fails closed on pointer columns forged onto preEffect Receipts", { tags: "p1" }, () => {
        const harness = new SqliteHarness();
        const receipts = ["attempt", "previous", "variant"].map(
            (key) =>
                new PreEffectReceipt(
                    new ReceiptId(`sqlite-forged-${key}`),
                    new InvocationId(`sqlite-forged-${key}-invocation`),
                    0,
                    "deniedPreEffect",
                    new Date(1000),
                    "denied"
                )
        );
        const [forgedAttempt, forgedPrevious, flippedVariant] = receipts;
        harness.transaction((transaction) => {
            for (const receipt of receipts) {
                harness.persistence.appendReceipt(transaction, receipt);
            }
        });
        expect(forgedAttempt).toBeDefined();
        expect(forgedPrevious).toBeDefined();
        expect(flippedVariant).toBeDefined();
        if (
            forgedAttempt === undefined ||
            forgedPrevious === undefined ||
            flippedVariant === undefined
        ) {
            return;
        }
        harness.database.run("PRAGMA ignore_check_constraints = 1", []);

        harness.database.run(
            "UPDATE invocation_receipts SET attempt_id = 'sqlite-ghost-attempt' WHERE id = ?",
            [forgedAttempt.id.value]
        );
        expectCorrupt(() => harness.persistence.receipt(harness.database, forgedAttempt.id));

        harness.database.run(
            "UPDATE invocation_receipts SET previous_id = 'sqlite-ghost-previous' WHERE id = ?",
            [forgedPrevious.id.value]
        );
        expectCorrupt(() => harness.persistence.receipt(harness.database, forgedPrevious.id));

        harness.database.run("UPDATE invocation_receipts SET variant = 'attempt' WHERE id = ?", [
            flippedVariant.id.value
        ]);
        expectCorrupt(() => harness.persistence.receipt(harness.database, flippedVariant.id));
    });

    test(
        "attempt Receipts without evidence carry the exact missing-evidence failure",
        { tags: "p1" },
        () => {
            const harness = new SqliteHarness();
            expectInvocationFailure(
                () =>
                    harness.persistence.appendReceipt(
                        harness.database,
                        new AttemptReceipt(
                            new ReceiptId("sqlite-missing-evidence"),
                            new EffectAttemptId("sqlite-missing-evidence-attempt"),
                            failedByAbort,
                            undefined,
                            new Date(2000),
                            undefined
                        )
                    ),
                "store.missing-evidence",
                "Attempt Receipt requires an existing EffectAttempt"
            );
        }
    );

    test("reports byte-level corruption with the exact codec failure", { tags: "p1" }, () => {
        const harness = new SqliteHarness();
        const invocation = prepared("sqlite-exact-bytes");
        harness.transaction((transaction) =>
            harness.persistence.insertPrepared(transaction, invocation)
        );
        harness.database.run(
            "UPDATE invocation_prepared_records SET record = 'not-bytes' WHERE id = ?",
            [invocation.header.id.value]
        );
        expectCorrupt(() => harness.persistence.prepared(harness.database, invocation.header.id));
    });

    test(
        "fails closed when the substrate returns rows keyed to a different identity",
        { tags: "p1" },
        () => {
            const database = new ColumnSubstitutingSqlite();
            const persistence = createSqliteInvocationPersistence(database);
            const invocation = prepared("sqlite-doctored-row");
            const continuation = new InvocationContinuation<string>(
                invocation.header.id,
                invocation.intentDigest,
                new ApprovalId("sqlite-doctored-row-approval"),
                new EffectAttemptId("sqlite-doctored-row-attempt"),
                0,
                0,
                new ItemClaimId("sqlite-doctored-row-claim"),
                {
                    kind: "system",
                    actor: invocation.header.actor,
                    worker: new ClaimWorkerId("sqlite-doctored-row-worker")
                },
                invocation.item(0).idempotencyKey,
                new Date(2000)
            );
            database.transaction(() => {
                persistence.insertPrepared(database, invocation);
                persistence.insertContinuation(database, continuation);
            });
            database.substitute = true;
            expectCorrupt(() => persistence.prepared(database, invocation.header.id));
            expectCorrupt(() => persistence.continuation(database, invocation.header.id));
        }
    );

    test("fails closed when a read loses the column it projects", { tags: "p0" }, () => {
        const database = new ColumnDroppingSqlite();
        const persistence = createSqliteInvocationPersistence(database);
        const invocation = prepared("sqlite-dropped-column");
        const approval = Approval.pending(
            new ApprovalId("sqlite-dropped-column-approval"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );
        database.transaction(() => persistence.appendApproval(database, approval));

        const receipt = new PreEffectReceipt(
            new ReceiptId("sqlite-dropped-column-receipt"),
            invocation.header.id,
            0,
            "deniedPreEffect",
            new Date(1000),
            "denied"
        );
        database.transaction(() => persistence.appendReceipt(database, receipt));

        database.dropped = ["invocation_approval_identities", "approval_id"];
        expectCorrupt(() => persistence.approvalForInvocation(database, invocation.header.id));

        database.dropped = ["invocation_receipts", "attempt_id"];
        expectCorrupt(() => persistence.receipt(database, receipt.id));
    });
});

function expectInvocationFailure(
    operation: () => void,
    failure: InvocationError["failure"],
    message: string
): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(InvocationError);
        if (error instanceof InvocationError) {
            expect(error.failure).toBe(failure);
            expect(error.message).toBe(message);
        }
        return;
    }
    throw new TypeError(`Expected InvocationError ${failure}`);
}

function expectCorrupt(operation: () => void): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        if (error instanceof AgentCoreError) {
            expect(error.code).toBe("codec.invalid");
            expect(error.message).toBe("Stored invocation projection does not match codec bytes");
        }
        return;
    }
    throw new TypeError("Expected stored projection corruption");
}

class FaultingSqlite extends TestSqlite {
    public fault: (() => never) | undefined;

    protected override execute(statement: string, bindings: readonly SqliteValue[]): void {
        if (this.fault !== undefined && statement.startsWith("INSERT")) this.fault();
        super.execute(statement, bindings);
    }
}

/** Answers a read with the named column absent, the way a drifted projection would. */
class ColumnDroppingSqlite extends TestSqlite {
    public dropped: readonly [table: string, column: string] | undefined;

    protected override query(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.query(statement, bindings);
        const dropped = this.dropped;
        if (dropped === undefined || !statement.includes(dropped[0])) return rows;
        return rows.map((row) =>
            Object.fromEntries(Object.entries(row).filter(([column]) => column !== dropped[1]))
        );
    }
}

class ColumnSubstitutingSqlite extends TestSqlite {
    public substitute = false;

    protected override query(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.query(statement, bindings);
        if (!this.substitute) return rows;
        if (statement.includes("FROM invocation_prepared_records")) {
            return rows.map((row) => ({ ...row, id: "sqlite-doctored-key" }));
        }
        if (statement.includes("FROM invocation_continuations")) {
            return rows.map((row) => ({ ...row, invocation_id: "sqlite-doctored-key" }));
        }
        return rows;
    }
}

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
    public constructor() {
        super({ read: rejectSuppliedTransaction, write: rejectSuppliedTransaction });
    }

    public transaction<Result>(
        _operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        throw new TypeError("supplied transaction was used");
    }
}

function rejectSuppliedTransaction(): never {
    throw new TypeError("supplied transaction was used");
}

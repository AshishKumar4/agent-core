import {
    Approval,
    ApprovalId,
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    ClaimWorkerId,
    CorrelationId,
    EffectAttempt,
    EffectAttemptId,
    InvocationError,
    ItemClaim,
    ItemClaimId,
    MemoryInvocationPersistence,
    PreEffectReceipt,
    ReceiptId,
    cloneInvocationMemoryState,
    createInvocationMemoryState,
    InvocationContinuation,
    type InvocationAuditPersistence,
    type InvocationMemoryState
} from "../../src/invocations";
import { AgentCoreError } from "../../src/errors";
import { PrincipalId, TenantId } from "../../src/identity";
import { expect, test } from "vitest";
import {
    admissionFor,
    attemptCodec,
    claimCodec,
    createLedger,
    invocationCodecs,
    prepared,
    preparedCodec,
    type InvocationHarness
} from "./fixture";
import { invocationLedgerContract } from "./ledger-contract";
import { encodeCanonicalJson } from "../../src/core";

const approvalRowKey = (id: string, revision: number): string =>
    new TextDecoder().decode(encodeCanonicalJson([id, revision]));

function rejects<Failure>(
    operation: () => unknown,
    kind: abstract new (...args: never[]) => Failure
): Failure {
    try {
        operation();
    } catch (error) {
        if (error instanceof kind) return error;
        throw error;
    }
    throw new Error("Expected the memory persistence to reject the operation");
}

class MemoryHarness implements InvocationHarness<InvocationMemoryState> {
    public readonly persistence = new MemoryInvocationPersistence(invocationCodecs);
    public readonly ledger = createLedger(this.persistence);
    private state = createInvocationMemoryState();

    public transaction<Result>(operation: (transaction: InvocationMemoryState) => Result): Result {
        const draft = cloneInvocationMemoryState(this.state);
        const result = operation(draft);
        this.state = cloneInvocationMemoryState(draft);
        return result;
    }

    public restart(): void {
        this.state = cloneInvocationMemoryState(this.state);
    }

    public dispose(): void {}
}

invocationLedgerContract("memory", () => new MemoryHarness());

test(
    "[C13-ADV-UNCHANGED-RECOVERY-OWNER] [invocation-persistence] memory rejects duplicate durable identities",
    { tags: "p0" },
    () => {
        const state = createInvocationMemoryState();
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-duplicates");
        persistence.insertPrepared(state, invocation);
        expect(() => persistence.insertPrepared(state, invocation)).toThrow();
        expect(persistence.approvalRevision(state, new ApprovalId("missing"), 0)).toBeUndefined();

        const firstApproval = Approval.pending(
            new ApprovalId("memory-approval-a"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );
        const secondApproval = Approval.pending(
            new ApprovalId("memory-approval-b"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );
        persistence.appendApproval(state, firstApproval);
        expect(() => persistence.appendApproval(state, secondApproval)).toThrow();
        state.approvalByInvocation.delete(invocation.header.id.value);
        expect(() => persistence.approvalForInvocation(state, invocation.header.id)).toThrow(
            /index/
        );
        state.approvalByInvocation.set(invocation.header.id.value, firstApproval.id.value);

        const attempt = new EffectAttempt<string, string>(
            new EffectAttemptId("memory-attempt-a"),
            invocation.header.id,
            0,
            0,
            new ItemClaimId("memory-claim"),
            undefined,
            admissionFor(invocation.header.id.value, 0, 0),
            new Date(1000),
            invocation.item(0).idempotencyKey,
            new AuditRecordId("memory-attempt-audit")
        );
        persistence.appendAttempt(state, attempt);
        expect(() =>
            persistence.appendAttempt(
                state,
                new EffectAttempt<string, string>(
                    new EffectAttemptId("memory-attempt-b"),
                    invocation.header.id,
                    0,
                    1,
                    attempt.claim,
                    undefined,
                    admissionFor(invocation.header.id.value, 0, 1),
                    new Date(2000),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("memory-attempt-b-audit")
                )
            )
        ).toThrow();
        expect(() =>
            persistence.appendAttempt(
                state,
                new EffectAttempt<string, string>(
                    new EffectAttemptId("memory-attempt-c"),
                    invocation.header.id,
                    0,
                    0,
                    new ItemClaimId("memory-claim-c"),
                    undefined,
                    admissionFor(invocation.header.id.value, 0, 0),
                    new Date(2000),
                    invocation.item(0).idempotencyKey,
                    new AuditRecordId("memory-attempt-c-audit")
                )
            )
        ).toThrow();
        expect(persistence.receipt(state, new ReceiptId("missing"))).toBeUndefined();
    }
);

test(
    "[C13-ATTEMPT-ORDINAL-AFTER-FAILURE] [invocation-persistence] memory rejects valid-byte index substitution",
    { tags: "p0" },
    () => {
        const state = createInvocationMemoryState();
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const left = prepared("memory-index-left");
        const right = prepared("memory-index-right");
        state.prepared.set(left.header.id.value, preparedCodec.encode(right));
        expect(() => persistence.prepared(state, left.header.id)).toThrow(/index/);
    }
);

test(
    "[invocation-persistence] memory rejects corrupt order and reverse indexes",
    { tags: "p0" },
    () => {
        const state = createInvocationMemoryState();
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-indexes");
        const claim = new ItemClaim<string>(
            new ItemClaimId("memory-indexes-claim"),
            invocation.header.id,
            0,
            0,
            {
                kind: "system",
                actor: invocation.header.actor,
                worker: new ClaimWorkerId("memory-indexes-worker")
            },
            new Date(5000)
        );
        persistence.appendClaim(state, claim);
        state.claimOrder.push(claim.id.value);
        expect(() => persistence.claimsForItem(state, invocation.header.id, 0)).toThrow(/order/);

        const fresh = createInvocationMemoryState();
        const attempt = new EffectAttempt<string, string>(
            new EffectAttemptId("memory-indexes-attempt"),
            invocation.header.id,
            0,
            0,
            claim.id,
            undefined,
            admissionFor(invocation.header.id.value, 0, 0),
            new Date(1000),
            invocation.item(0).idempotencyKey,
            new AuditRecordId("memory-indexes-audit")
        );
        fresh.attempts.set(attempt.id.value, attemptCodec.encode(attempt));
        expect(() => persistence.attempt(fresh, attempt.id)).toThrow(/index/);

        const receipt = new PreEffectReceipt(
            new ReceiptId("memory-indexes-receipt"),
            invocation.header.id,
            0,
            "deniedPreEffect",
            new Date(1000),
            "denied"
        );
        fresh.receipts.set(receipt.id.value, invocationCodecs.receipt.encode(receipt));
        expect(() => persistence.receipt(fresh, receipt.id)).toThrow(/order/);
    }
);

test(
    "[C13-EFFECT-SUPERSEDING-RECEIPT] [invocation-persistence] ledger rejects missing and cyclic Receipt predecessors",
    { tags: "p0" },
    () => {
        const make = () => {
            const state = createInvocationMemoryState();
            const persistence = new MemoryInvocationPersistence(invocationCodecs);
            const ledger = createLedger(persistence);
            const invocation = prepared("memory-lineage");
            const attempt = new EffectAttempt<string, string>(
                new EffectAttemptId("memory-lineage-attempt"),
                invocation.header.id,
                0,
                0,
                new ItemClaimId("memory-lineage-claim"),
                undefined,
                admissionFor(invocation.header.id.value, 0, 0),
                new Date(1000),
                invocation.item(0).idempotencyKey,
                new AuditRecordId("memory-lineage-audit")
            );
            persistence.insertPrepared(state, invocation);
            persistence.appendAttempt(state, attempt);
            return { state, persistence, ledger, invocation, attempt };
        };
        const missing = make();
        missing.persistence.appendReceipt(
            missing.state,
            new AttemptReceipt(
                new ReceiptId("memory-lineage-missing"),
                missing.attempt.id,
                "failed",
                new ReceiptId("absent-predecessor"),
                new Date(2000),
                undefined
            )
        );
        expect(() =>
            missing.ledger.currentReceipt(missing.state, missing.invocation.header.id, 0)
        ).toThrow(/missing predecessor/);

        const cyclic = make();
        cyclic.persistence.appendReceipt(
            cyclic.state,
            new AttemptReceipt(
                new ReceiptId("valid-head"),
                cyclic.attempt.id,
                "failed",
                undefined,
                new Date(1500),
                undefined
            )
        );
        cyclic.persistence.appendReceipt(
            cyclic.state,
            new AttemptReceipt(
                new ReceiptId("cycle-a"),
                cyclic.attempt.id,
                "failed",
                new ReceiptId("cycle-b"),
                new Date(2000),
                undefined
            )
        );
        cyclic.persistence.appendReceipt(
            cyclic.state,
            new AttemptReceipt(
                new ReceiptId("cycle-b"),
                cyclic.attempt.id,
                "failed",
                new ReceiptId("cycle-a"),
                new Date(3000),
                undefined
            )
        );
        expect(() =>
            cyclic.ledger.currentReceipt(cyclic.state, cyclic.invocation.header.id, 0)
        ).toThrow(/disconnected lineage/);
    }
);

test(
    "[C13-ADV-RECEIPT-FAILED] [invocation-persistence] memory fails closed on substituted durable record identities",
    { tags: "p0" },
    () => {
        const invocation = prepared("memory-substitution");
        const other = prepared("memory-substitution-other");
        const approval = Approval.pending(
            new ApprovalId("memory-substitution-approval"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );
        const otherApproval = Approval.pending(
            new ApprovalId("memory-substitution-other-approval"),
            other.header.id,
            other.intentDigest,
            new Date(1000)
        );
        const cases: Array<(state: ReturnType<typeof createInvocationMemoryState>) => void> = [
            (state) => {
                state.approvals.set(
                    approvalRowKey(approval.id.value, 0),
                    invocationCodecs.approval.encode(otherApproval)
                );
                new MemoryInvocationPersistence(invocationCodecs).approval(state, approval.id);
            },
            (state) => {
                state.approvalByInvocation.set(invocation.header.id.value, approval.id.value);
                new MemoryInvocationPersistence(invocationCodecs).approvalForInvocation(
                    state,
                    invocation.header.id
                );
            },
            (state) => {
                const continuation = new InvocationContinuation<string>(
                    other.header.id,
                    other.intentDigest,
                    otherApproval.id,
                    new EffectAttemptId("memory-substitution-attempt"),
                    0,
                    0,
                    new ItemClaimId("memory-substitution-claim"),
                    {
                        kind: "system",
                        actor: other.header.actor,
                        worker: new ClaimWorkerId("memory-substitution-worker")
                    },
                    other.item(0).idempotencyKey,
                    new Date(1000)
                );
                state.continuations.set(
                    invocation.header.id.value,
                    invocationCodecs.continuation.encode(continuation)
                );
                new MemoryInvocationPersistence(invocationCodecs).continuation(
                    state,
                    invocation.header.id
                );
            },
            (state) => {
                const claim = new ItemClaim<string>(
                    new ItemClaimId("memory-substitution-other-claim"),
                    other.header.id,
                    0,
                    0,
                    {
                        kind: "system",
                        actor: other.header.actor,
                        worker: new ClaimWorkerId("memory-substitution-other-worker")
                    },
                    new Date(5000)
                );
                state.claims.set(
                    "memory-substitution-requested-claim",
                    invocationCodecs.claim.encode(claim)
                );
                new MemoryInvocationPersistence(invocationCodecs).claim(
                    state,
                    new ItemClaimId("memory-substitution-requested-claim")
                );
            },
            (state) => {
                const receipt = new PreEffectReceipt(
                    new ReceiptId("memory-substitution-other-receipt"),
                    other.header.id,
                    0,
                    "deniedPreEffect",
                    new Date(1000),
                    "denied"
                );
                state.receipts.set(
                    "memory-substitution-requested-receipt",
                    invocationCodecs.receipt.encode(receipt)
                );
                state.receiptOrder.push("memory-substitution-requested-receipt");
                new MemoryInvocationPersistence(invocationCodecs).receipt(
                    state,
                    new ReceiptId("memory-substitution-requested-receipt")
                );
            }
        ];

        for (const corrupt of cases) {
            expect(() => corrupt(createInvocationMemoryState())).toThrow(/index|codec/i);
        }
    }
);

test(
    "[invocation-persistence] memory Approval revision reads fail closed on id and revision drift",
    { tags: "p0" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-approval-revision");
        const approval = Approval.pending(
            new ApprovalId("memory-approval-revision-a"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );
        const other = Approval.pending(
            new ApprovalId("memory-approval-revision-b"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );

        const revisionDrift = createInvocationMemoryState();
        revisionDrift.approvals.set(
            approvalRowKey(approval.id.value, 5),
            invocationCodecs.approval.encode(approval)
        );
        const substitutedId = createInvocationMemoryState();
        substitutedId.approvals.set(
            approvalRowKey(approval.id.value, 0),
            invocationCodecs.approval.encode(other)
        );

        const cases: readonly (readonly [InvocationMemoryState, number])[] = [
            [revisionDrift, 5],
            [substitutedId, 0]
        ];
        for (const [state, revision] of cases) {
            const error = rejects(
                () => persistence.approvalRevision(state, approval.id, revision),
                AgentCoreError
            );
            expect(error.code).toBe("codec.invalid");
        }
        expect(
            persistence.approvalRevision(createInvocationMemoryState(), approval.id, 0)
        ).toBeUndefined();
    }
);

test(
    "[invocation-persistence] memory Approval scans cannot be straddled by another id",
    { tags: "p0" },
    () => {
        // An ApprovalId is a bare TextId, so U+0000 is legal inside one. Under a NUL
        // delimiter the key for id `victim\u00007` revision 0 is byte-for-byte a prefix
        // match for a revision of id `victim`, so an unrelated approval is read as this
        // one's latest revision -- and its revision parses as NaN, poisoning the sort.
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-approval-straddle");
        const victim = Approval.pending(
            new ApprovalId("victim"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );
        const straddler = Approval.pending(
            new ApprovalId("victim\u00007"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );

        const state = createInvocationMemoryState();
        state.approvals.set(
            approvalRowKey(victim.id.value, 0),
            invocationCodecs.approval.encode(victim)
        );
        state.approvals.set(
            approvalRowKey(straddler.id.value, 0),
            invocationCodecs.approval.encode(straddler)
        );

        expect(persistence.approval(state, victim.id)?.id.value).toBe("victim");
        expect(persistence.approval(state, straddler.id)?.id.value).toBe("victim\u00007");
    }
);

test(
    "[invocation-persistence] memory reads the latest Approval revision from any map order",
    { tags: "p0" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-approval-order");
        const pending = Approval.pending(
            new ApprovalId("memory-approval-order-a"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );
        const approved = pending.approve(
            new PrincipalId("memory-approval-order-principal"),
            new Date(2000)
        );
        expect(approved.revision.value).toBe(1);
        const key = (revision: number): string => approvalRowKey(pending.id.value, revision);

        const ascending = createInvocationMemoryState();
        ascending.approvals.set(key(0), invocationCodecs.approval.encode(pending));
        ascending.approvals.set(key(1), invocationCodecs.approval.encode(approved));
        const descending = createInvocationMemoryState();
        descending.approvals.set(key(1), invocationCodecs.approval.encode(approved));
        descending.approvals.set(key(0), invocationCodecs.approval.encode(pending));

        for (const state of [ascending, descending]) {
            const latest = persistence.approval(state, pending.id);
            expect(latest?.revision.value).toBe(1);
            expect(latest?.state.kind).toBe("approved");
        }
    }
);

test(
    "[invocation-persistence] memory EffectAttempt indexes fail closed on size, key, and claim drift",
    { tags: "p0" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-attempt-index");
        const attempt = new EffectAttempt<string, string>(
            new EffectAttemptId("memory-attempt-index-attempt"),
            invocation.header.id,
            0,
            0,
            new ItemClaimId("memory-attempt-index-claim"),
            undefined,
            admissionFor(invocation.header.id.value, 0, 0),
            new Date(1000),
            invocation.item(0).idempotencyKey,
            new AuditRecordId("memory-attempt-index-audit")
        );

        const extraProjection = createInvocationMemoryState();
        extraProjection.attempts.set(attempt.id.value, attemptCodec.encode(attempt));
        extraProjection.attemptByClaim.set(attempt.claim.value, attempt.id.value);
        extraProjection.attemptByClaim.set("memory-attempt-index-ghost", attempt.id.value);

        const substitutedKey = createInvocationMemoryState();
        substitutedKey.attempts.set("memory-attempt-index-other", attemptCodec.encode(attempt));
        substitutedKey.attemptByClaim.set(attempt.claim.value, "memory-attempt-index-other");

        const misprojectedClaim = createInvocationMemoryState();
        misprojectedClaim.attempts.set(attempt.id.value, attemptCodec.encode(attempt));
        misprojectedClaim.attemptByClaim.set("memory-attempt-index-other-claim", attempt.id.value);

        for (const state of [extraProjection, substitutedKey, misprojectedClaim]) {
            const error = rejects(() => persistence.attempt(state, attempt.id), AgentCoreError);
            expect(error.code).toBe("codec.invalid");
            expect(error.message).toMatch(/index does not match codec bytes/);
        }
    }
);

test(
    "[invocation-persistence] memory claim lookup fails closed on an unprojected EffectAttempt",
    { tags: "p0" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-attempt-scan");
        const attempt = new EffectAttempt<string, string>(
            new EffectAttemptId("memory-attempt-scan-attempt"),
            invocation.header.id,
            0,
            0,
            new ItemClaimId("memory-attempt-scan-claim"),
            undefined,
            admissionFor(invocation.header.id.value, 0, 0),
            new Date(1000),
            invocation.item(0).idempotencyKey,
            new AuditRecordId("memory-attempt-scan-audit")
        );

        const orphaned = createInvocationMemoryState();
        orphaned.attempts.set(attempt.id.value, attemptCodec.encode(attempt));
        const error = rejects(
            () => persistence.attemptForClaim(orphaned, attempt.claim),
            AgentCoreError
        );
        expect(error.code).toBe("codec.invalid");
        expect(
            persistence.attemptForClaim(createInvocationMemoryState(), attempt.claim)
        ).toBeUndefined();
    }
);

test(
    "[invocation-persistence] memory orders item EffectAttempts by ordinal from either append order",
    { tags: "p1" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-attempt-ordinal");
        const attemptAt = (ordinal: number): EffectAttempt<string, string> =>
            new EffectAttempt<string, string>(
                new EffectAttemptId(`memory-attempt-ordinal-${ordinal}`),
                invocation.header.id,
                0,
                ordinal,
                new ItemClaimId(`memory-attempt-ordinal-claim-${ordinal}`),
                undefined,
                admissionFor(invocation.header.id.value, 0, ordinal),
                new Date(1000 + ordinal),
                invocation.item(0).idempotencyKey,
                new AuditRecordId(`memory-attempt-ordinal-audit-${ordinal}`)
            );

        for (const appendOrder of [
            [0, 1],
            [1, 0]
        ]) {
            const state = createInvocationMemoryState();
            for (const ordinal of appendOrder) persistence.appendAttempt(state, attemptAt(ordinal));
            expect(
                persistence
                    .attemptsForItem(state, invocation.header.id, 0)
                    .map((attempt) => attempt.ordinal)
            ).toEqual([0, 1]);
        }
    }
);

test(
    "[invocation-persistence] memory item Receipts exclude EffectAttempts of other items",
    { tags: "p0" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-receipt-scope", [
            { value: "first" },
            { value: "second" }
        ]);
        const state = createInvocationMemoryState();
        for (const itemIndex of [0, 1]) {
            persistence.appendAttempt(
                state,
                new EffectAttempt<string, string>(
                    new EffectAttemptId(`memory-receipt-scope-attempt-${itemIndex}`),
                    invocation.header.id,
                    itemIndex,
                    0,
                    new ItemClaimId(`memory-receipt-scope-claim-${itemIndex}`),
                    undefined,
                    admissionFor(invocation.header.id.value, itemIndex, 0),
                    new Date(1000 + itemIndex),
                    invocation.item(itemIndex).idempotencyKey,
                    new AuditRecordId(`memory-receipt-scope-audit-${itemIndex}`)
                )
            );
        }
        persistence.appendReceipt(
            state,
            new PreEffectReceipt(
                new ReceiptId("memory-receipt-scope-pre-effect"),
                invocation.header.id,
                0,
                "deniedPreEffect",
                new Date(2000),
                "denied"
            )
        );
        persistence.appendReceipt(
            state,
            new AttemptReceipt(
                new ReceiptId("memory-receipt-scope-foreign"),
                new EffectAttemptId("memory-receipt-scope-attempt-1"),
                "failed",
                undefined,
                new Date(3000),
                undefined
            )
        );

        expect(
            persistence
                .receiptsForItem(state, invocation.header.id, 0)
                .map((receipt) => receipt.id.value)
        ).toEqual(["memory-receipt-scope-pre-effect"]);
        expect(
            persistence
                .receiptsForItem(state, invocation.header.id, 1)
                .map((receipt) => receipt.id.value)
        ).toEqual(["memory-receipt-scope-foreign"]);
    }
);

test(
    "[invocation-persistence] memory claim order rejects duplicate and dangling entries",
    { tags: "p0" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-claim-order");
        const claimAt = (suffix: string): ItemClaim<string> =>
            new ItemClaim<string>(
                new ItemClaimId(`memory-claim-order-${suffix}`),
                invocation.header.id,
                0,
                0,
                {
                    kind: "system",
                    actor: invocation.header.actor,
                    worker: new ClaimWorkerId(`memory-claim-order-worker-${suffix}`)
                },
                new Date(5000)
            );

        const duplicated = createInvocationMemoryState();
        for (const suffix of ["a", "b"]) {
            const claim = claimAt(suffix);
            duplicated.claims.set(claim.id.value, claimCodec.encode(claim));
        }
        duplicated.claimOrder.push("memory-claim-order-a", "memory-claim-order-a");

        const dangling = createInvocationMemoryState();
        const present = claimAt("a");
        dangling.claims.set(present.id.value, claimCodec.encode(present));
        dangling.claimOrder.push("memory-claim-order-absent");

        for (const state of [duplicated, dangling]) {
            const error = rejects(
                () => persistence.claimsForItem(state, invocation.header.id, 0),
                AgentCoreError
            );
            expect(error.code).toBe("codec.invalid");
            expect(error.message).toMatch(/order is corrupt/);
        }
    }
);

test(
    "[invocation-persistence] memory append-only guards report the duplicate-record failure",
    { tags: "p0" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-duplicate-failure");
        const state = createInvocationMemoryState();
        persistence.insertPrepared(state, invocation);
        persistence.appendApproval(
            state,
            Approval.pending(
                new ApprovalId("memory-duplicate-failure-approval-a"),
                invocation.header.id,
                invocation.intentDigest,
                new Date(1000)
            )
        );
        const attemptFor = (
            suffix: string,
            ordinal: number,
            claim: string
        ): EffectAttempt<string, string> =>
            new EffectAttempt<string, string>(
                new EffectAttemptId(`memory-duplicate-failure-attempt-${suffix}`),
                invocation.header.id,
                0,
                ordinal,
                new ItemClaimId(claim),
                undefined,
                admissionFor(invocation.header.id.value, 0, ordinal),
                new Date(2000),
                invocation.item(0).idempotencyKey,
                new AuditRecordId(`memory-duplicate-failure-audit-${suffix}`)
            );
        persistence.appendAttempt(state, attemptFor("a", 0, "memory-duplicate-failure-claim"));

        const duplicates: readonly (() => unknown)[] = [
            () => persistence.insertPrepared(state, invocation),
            () =>
                persistence.appendApproval(
                    state,
                    Approval.pending(
                        new ApprovalId("memory-duplicate-failure-approval-b"),
                        invocation.header.id,
                        invocation.intentDigest,
                        new Date(1000)
                    )
                ),
            () =>
                persistence.appendAttempt(
                    state,
                    attemptFor("b", 1, "memory-duplicate-failure-claim")
                ),
            () =>
                persistence.appendAttempt(
                    state,
                    attemptFor("c", 0, "memory-duplicate-failure-claim-c")
                )
        ];
        for (const duplicate of duplicates) {
            expect(rejects(duplicate, InvocationError).failure).toBe("store.duplicate-record");
        }
    }
);

test(
    "[invocation-persistence] cloned memory state does not alias durable record bytes",
    { tags: "p0" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-clone-aliasing");
        const state = createInvocationMemoryState();
        persistence.insertPrepared(state, invocation);

        const clone = cloneInvocationMemoryState(state);
        const bytes = clone.prepared.get(invocation.header.id.value);
        if (bytes === undefined) throw new Error("Cloned state must carry the prepared bytes");
        bytes.fill(0);

        expect(persistence.prepared(state, invocation.header.id)?.header.id.value).toBe(
            invocation.header.id.value
        );
    }
);

test(
    "[invocation-persistence] ledger fails closed on duplicated pre-effect Receipt history",
    { tags: "p0" },
    () => {
        const state = createInvocationMemoryState();
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const ledger = createLedger(persistence);
        const invocation = prepared("memory-duplicate-pre-effect");
        persistence.insertPrepared(state, invocation);
        for (const suffix of ["first", "second"]) {
            persistence.appendReceipt(
                state,
                new PreEffectReceipt(
                    new ReceiptId(`memory-duplicate-pre-effect-${suffix}`),
                    invocation.header.id,
                    0,
                    "deniedPreEffect",
                    new Date(1000),
                    "denied"
                )
            );
        }
        const error = rejects(
            () => ledger.currentReceipt(state, invocation.header.id, 0),
            AgentCoreError
        );
        expect(error.code).toBe("invocation.invalid");
    }
);

test(
    "[invocation-persistence] ledger refuses transition times the time port distrusts",
    { tags: "p0" },
    () => {
        const state = createInvocationMemoryState();
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const ledger = createLedger(persistence, {
            timeAdmits: (time) => time.getTime() >= 2000
        });
        const invocation = prepared("memory-distrusted-time");
        const claim = new ItemClaim<string>(
            new ItemClaimId("memory-distrusted-time-claim"),
            invocation.header.id,
            0,
            0,
            {
                kind: "system",
                actor: invocation.header.actor,
                worker: new ClaimWorkerId("memory-distrusted-time-worker")
            },
            new Date(10000)
        );
        ledger.prepare(state, invocation);
        const error = rejects(() => ledger.claimItem(state, claim, new Date(1000)), AgentCoreError);
        expect(error.code).toBe("invocation.invalid");
        expect(error.message).toBe("Invocation transition time is not trusted");
        expect(persistence.claim(state, claim.id)).toBeUndefined();
        ledger.claimItem(state, claim, new Date(2000));
        expect(persistence.claim(state, claim.id)?.id.value).toBe(claim.id.value);
    }
);

test(
    "[invocation-persistence] memory latest-Approval reads fail closed on revision-key drift",
    { tags: "p0" },
    () => {
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("memory-approval-latest-drift");
        const approval = Approval.pending(
            new ApprovalId("memory-approval-latest-drift-approval"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000)
        );
        const state = createInvocationMemoryState();
        state.approvals.set(
            approvalRowKey(approval.id.value, 5),
            invocationCodecs.approval.encode(approval)
        );
        const error = rejects(() => persistence.approval(state, approval.id), AgentCoreError);
        expect(error.code).toBe("codec.invalid");
    }
);

class RecordedAuditEvidence implements InvocationAuditPersistence<InvocationMemoryState> {
    private readonly audits = new Map<string, AuditRecord>();

    public seed(record: AuditRecord): void {
        this.audits.set(record.id.value, record);
    }

    public audit(_transaction: InvocationMemoryState, id: AuditRecordId): AuditRecord | undefined {
        return this.audits.get(id.value);
    }

    public findAuditByEvidence(): AuditRecord | undefined {
        return undefined;
    }

    public appendAudit(_transaction: InvocationMemoryState, record: AuditRecord): void {
        this.audits.set(record.id.value, record);
    }
}

test(
    "[invocation.audit] audit relations fail closed when receipt evidence names a ghost attempt",
    { tags: "p1" },
    () => {
        const state = createInvocationMemoryState();
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const ledger = createLedger(persistence);
        const evidence = new RecordedAuditEvidence();
        const invocation = prepared("memory-ghost-attempt");
        const receipt = new AttemptReceipt(
            new ReceiptId("memory-ghost-attempt-receipt"),
            new EffectAttemptId("memory-ghost-attempt-attempt"),
            "failed",
            undefined,
            new Date(2000),
            undefined
        );
        persistence.appendReceipt(state, receipt);
        const attemptAudit = new AuditRecord({
            id: new AuditRecordId("memory-ghost-attempt-audit"),
            actor: invocation.header.actor,
            tenant: new TenantId("tenant:memory"),
            correlation: new CorrelationId("correlation:memory"),
            kind: { kind: "attempt", id: receipt.attempt }
        });
        evidence.seed(attemptAudit);
        const receiptAudit = new AuditRecord({
            id: new AuditRecordId("memory-ghost-attempt-receipt-audit"),
            actor: invocation.header.actor,
            tenant: new TenantId("tenant:memory"),
            correlation: new CorrelationId("correlation:memory"),
            cause: attemptAudit.id,
            kind: { kind: "receipt", id: receipt.id, outcome: "failed" }
        });
        const error = rejects(
            () => ledger.requirePersistedAuditRelation(state, receiptAudit, evidence),
            InvocationError
        );
        expect(error.failure).toBe("audit.evidence-mismatch");
    }
);

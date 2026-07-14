import {
    Approval,
    ApprovalId,
    AttemptReceipt,
    AuditRecordId,
    ClaimWorkerId,
    EffectAttempt,
    EffectAttemptId,
    ItemClaim,
    ItemClaimId,
    MemoryInvocationPersistence,
    PreEffectReceipt,
    ReceiptId,
    cloneInvocationMemoryState,
    createInvocationMemoryState,
    InvocationContinuation,
    type InvocationMemoryState
} from "../../src/invocations";
import { expect, test } from "vitest";
import {
    admissionFor,
    attemptCodec,
    createLedger,
    invocationCodecs,
    prepared,
    preparedCodec,
    type InvocationHarness
} from "./fixture";
import { invocationLedgerContract } from "./ledger-contract";

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

test("[C13-ADV-UNCHANGED-RECOVERY-OWNER] [invocation-persistence] memory rejects duplicate durable identities", () => {
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
    expect(() => persistence.approvalForInvocation(state, invocation.header.id)).toThrow(/index/);
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
});

test("[C13-ATTEMPT-ORDINAL-AFTER-FAILURE] [invocation-persistence] memory rejects valid-byte index substitution", () => {
    const state = createInvocationMemoryState();
    const persistence = new MemoryInvocationPersistence(invocationCodecs);
    const left = prepared("memory-index-left");
    const right = prepared("memory-index-right");
    state.prepared.set(left.header.id.value, preparedCodec.encode(right));
    expect(() => persistence.prepared(state, left.header.id)).toThrow(/index/);
});

test("[invocation-persistence] memory rejects corrupt order and reverse indexes", () => {
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
});

test("[C13-EFFECT-SUPERSEDING-RECEIPT] [invocation-persistence] ledger rejects missing and cyclic Receipt predecessors", () => {
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
});

test("[C13-ADV-RECEIPT-FAILED] [invocation-persistence] memory fails closed on substituted durable record identities", () => {
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
                `${approval.id.value}\u00000`,
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
});

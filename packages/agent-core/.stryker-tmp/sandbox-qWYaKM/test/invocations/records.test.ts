// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { ContentRef, Digest, Revision, encodeCanonicalJson } from "../../src/core";
import { PrincipalId } from "../../src/identity";
import {
    Approval,
    ApprovalCodec,
    ApprovalId,
    AttemptReceipt,
    AuditRecordId,
    ClaimWorkerId,
    EffectAttempt,
    EffectAttemptId,
    InvocationId,
    ItemClaim,
    ItemClaimId,
    deriveBatchOutcome,
    PreEffectReceipt,
    Receipt,
    ReceiptCodec,
    ReceiptId,
    terminalBatchOutcome
} from "../../src/invocations";
import { admissionFor, attemptCodec, claimCodec } from "./fixture";

describe("Invocation evidence records", () => {
    test("guards every Approval terminal transition and round-trips revisions", () => {
        const pending = approval("decision", time(10));
        const denied = pending.deny(new PrincipalId("denier"), time(2), "not allowed");
        const decodedDenied = ApprovalCodec.decode(ApprovalCodec.encode(denied));
        expect(decodedDenied.state).toMatchObject({ kind: "denied", reason: "not allowed" });
        expect(decodedDenied.revision.value).toBe(1);
        expect(() => decodedDenied.approve(new PrincipalId("late"), time(3))).toThrow();

        const expired = approval("expiry", time(3)).expire(time(3));
        expect(ApprovalCodec.decode(ApprovalCodec.encode(expired)).state.kind).toBe("expired");
        expect(() => approval("early-expiry", time(5)).expire(time(4))).toThrow();
        expect(() =>
            approval("late-approval", time(3)).approve(new PrincipalId("approver"), time(3))
        ).toThrow();

        const approved = approval("consume", time(10)).approve(
            new PrincipalId("approver"),
            time(2)
        );
        const consumed = approved.consume(new EffectAttemptId("first-attempt"), time(3));
        const decodedConsumed = ApprovalCodec.decode(ApprovalCodec.encode(consumed));
        expect(decodedConsumed.state).toMatchObject({
            kind: "consumed",
            firstAttempt: new EffectAttemptId("first-attempt")
        });
        expect(() => consumed.consume(new EffectAttemptId("second"), time(4))).toThrow();
        expect(
            () =>
                new Approval(
                    new ApprovalId("impossible"),
                    new InvocationId("impossible-invocation"),
                    Digest.sha256(new TextEncoder().encode("impossible")),
                    time(1),
                    time(3),
                    new Revision(1),
                    { kind: "approved", by: new PrincipalId("late"), at: time(3) }
                )
        ).toThrow(/before expiry/);
    });

    test("rejects every malformed Approval chronology and codec state", () => {
        class DerivedApprovalId extends ApprovalId {}
        expect(() =>
            Approval.pending(
                new DerivedApprovalId("derived-approval"),
                new InvocationId("derived-approval-invocation"),
                Digest.sha256(new TextEncoder().encode("derived")),
                time(1)
            )
        ).toThrow(/exact context classes/);
        const id = new ApprovalId("invalid-approval");
        const invocation = new InvocationId("invalid-approval-invocation");
        const digest = Digest.sha256(new TextEncoder().encode("invalid-approval"));
        const principal = new PrincipalId("invalid-approver");
        const create = (
            revision: number,
            state: ConstructorParameters<typeof Approval>[6],
            requestedAt = time(1),
            expiresAt: Date | undefined = time(5)
        ) =>
            new Approval(
                id,
                invocation,
                digest,
                requestedAt,
                expiresAt,
                new Revision(revision),
                state
            );

        expect(() => Approval.pending(id, invocation, digest, time(1), time(1))).toThrow();
        const noExpiry = Approval.pending(id, invocation, digest, time(1));
        expect(noExpiry.expiresAt).toBeUndefined();
        expect(() => noExpiry.expire(time(2))).toThrow();
        expect(() => noExpiry.approve(principal, time(0))).toThrow();
        expect(() => noExpiry.deny(principal, time(2), " ")).toThrow();
        expect(() => create(1, { kind: "pending" })).toThrow();
        expect(() => create(1, { kind: "approved", by: principal, at: time(0) })).toThrow();
        expect(() => create(0, { kind: "approved", by: principal, at: time(2) })).toThrow();
        expect(() => create(1, { kind: "approved", by: principal, at: time(5) })).toThrow();
        expect(() =>
            create(1, { kind: "denied", by: principal, at: time(2), reason: "" })
        ).toThrow();
        expect(() => create(0, { kind: "expired", at: time(5) })).toThrow();
        expect(() => create(1, { kind: "expired", at: time(4) })).toThrow();
        expect(() =>
            create(2, {
                kind: "consumed",
                by: principal,
                approvedAt: time(0),
                at: time(2),
                firstAttempt: new EffectAttemptId("invalid-first")
            })
        ).toThrow();
        const approved = create(1, { kind: "approved", by: principal, at: time(3) });
        expect(() => approved.consume(new EffectAttemptId("backdated"), time(2))).toThrow();

        const envelope = (state: unknown) =>
            encodeCanonicalJson({
                kind: "invocation.approval",
                version: { major: 1, minor: 0 },
                payload: {
                    expiresAt: time(5).toISOString(),
                    id: id.value,
                    intentDigest: digest.value,
                    invocation: invocation.value,
                    requestedAt: time(1).toISOString(),
                    revision: 1,
                    state: state as never
                }
            });
        expect(() => Approval.decode(envelope({ kind: "unknown" }))).toThrow();
        expect(() => Approval.decode(envelope(null))).toThrow();
    });

    test("round-trips executor and system claims and enforces recovery ownership", () => {
        const executor = new ItemClaim(
            new ItemClaimId("executor-claim"),
            new InvocationId("claim-invocation"),
            0,
            0,
            { kind: "executor", token: "lease", worker: new ClaimWorkerId("worker-a") },
            time(5)
        );
        const decodedExecutor = claimCodec.decode(claimCodec.encode(executor));
        expect(decodedExecutor.owner).toMatchObject({ kind: "executor", token: "lease" });
        decodedExecutor.requireFuture(time(4));
        expect(() => decodedExecutor.requireFuture(time(5))).toThrow();
        expect(() =>
            decodedExecutor.recover(
                new ItemClaimId("same-worker"),
                { kind: "executor", token: "lease", worker: new ClaimWorkerId("worker-a") },
                time(8),
                time(5)
            )
        ).toThrow();

        const system = new ItemClaim<string>(
            new ItemClaimId("system-claim"),
            new InvocationId("system-invocation"),
            1,
            2,
            {
                kind: "system",
                actor: new ActorRef("run", new ActorId("system-actor")),
                worker: new ClaimWorkerId("worker-system")
            },
            time(9)
        );
        const decodedSystem = claimCodec.decode(claimCodec.encode(system));
        expect(decodedSystem.owner.kind).toBe("system");
        expect(decodedSystem.attemptOrdinal).toBe(2);
        expect(
            () =>
                new ItemClaim(
                    new ItemClaimId("invalid-claim-index"),
                    new InvocationId("invalid-claim-invocation"),
                    -1,
                    0,
                    { kind: "executor", token: "lease", worker: new ClaimWorkerId("worker") },
                    time(9)
                )
        ).toThrow();

        const claimEnvelope = (owner: unknown) =>
            encodeCanonicalJson({
                kind: "invocation.item-claim",
                version: { major: 1, minor: 0 },
                payload: {
                    attemptOrdinal: 0,
                    expiresAt: time(9).toISOString(),
                    id: "wire-claim",
                    invocation: "wire-invocation",
                    itemIndex: 0,
                    owner: owner as never
                }
            });
        expect(() => claimCodec.decode(claimEnvelope(null))).toThrow();
        expect(() =>
            claimCodec.decode(claimEnvelope({ kind: "unknown", worker: "worker" }))
        ).toThrow();
        expect(() =>
            claimCodec.decode(
                claimEnvelope({
                    actor: { id: "actor", kind: "unknown" },
                    kind: "system",
                    worker: "worker"
                })
            )
        ).toThrow();
        expect(
            claimCodec.decode(
                claimEnvelope({
                    actor: { id: "actor", kind: "environment" },
                    kind: "system",
                    worker: "worker"
                })
            ).owner.kind
        ).toBe("system");
    });

    test("round-trips EffectAttempts with and without executor tokens", () => {
        class DerivedEffectAttemptId extends EffectAttemptId {}
        expect(
            () =>
                new EffectAttempt(
                    new DerivedEffectAttemptId("derived-attempt"),
                    new InvocationId("derived-attempt-invocation"),
                    0,
                    0,
                    new ItemClaimId("derived-attempt-claim"),
                    "lease",
                    admissionFor("derived-attempt-invocation", 0, 0),
                    time(1),
                    "key",
                    new AuditRecordId("derived-attempt-audit")
                )
        ).toThrow(/exact context classes/);
        for (const token of ["lease", undefined]) {
            const attempt = new EffectAttempt(
                new EffectAttemptId(`attempt-${token ?? "system"}`),
                new InvocationId("attempt-invocation"),
                1,
                2,
                new ItemClaimId("attempt-claim"),
                token,
                admissionFor("attempt-invocation", 1, 2),
                time(2),
                "agent-core.item.v1:key",
                new AuditRecordId("attempt-audit")
            );
            const decoded = attemptCodec.decode(attemptCodec.encode(attempt));
            expect(decoded.token).toBe(token);
            expect(decoded.startedAt.toISOString()).toBe(time(2).toISOString());
        }
        expect(
            () =>
                new EffectAttempt(
                    new EffectAttemptId("invalid-index"),
                    new InvocationId("invalid-index-invocation"),
                    -1,
                    0,
                    new ItemClaimId("invalid-index-claim"),
                    "lease",
                    admissionFor("invalid-index-invocation", 0, 0),
                    time(2),
                    "key",
                    new AuditRecordId("invalid-index-audit")
                )
        ).toThrow();
        expect(
            () =>
                new EffectAttempt(
                    new EffectAttemptId("invalid-key"),
                    new InvocationId("invalid-key-invocation"),
                    0,
                    0,
                    new ItemClaimId("invalid-key-claim"),
                    "lease",
                    admissionFor("invalid-key-invocation", 0, 0),
                    time(2),
                    "",
                    new AuditRecordId("invalid-key-audit")
                )
        ).toThrow();
    });

    test("round-trips every Receipt variant and rejects illegal result lineage", () => {
        const preEffect = new PreEffectReceipt(
            new ReceiptId("pre-effect"),
            new InvocationId("receipt-invocation"),
            0,
            "cancelledPreEffect",
            time(1),
            "turn lost"
        );
        expect(ReceiptCodec.decode(ReceiptCodec.encode(preEffect))).toMatchObject({
            variant: "preEffect",
            outcome: "cancelledPreEffect"
        });
        const succeeded = new AttemptReceipt(
            new ReceiptId("succeeded"),
            new EffectAttemptId("receipt-attempt"),
            "succeeded",
            undefined,
            time(2),
            content("result")
        );
        const failed = new AttemptReceipt(
            new ReceiptId("failed"),
            succeeded.attempt,
            "failed",
            new ReceiptId("unknown"),
            time(3),
            undefined
        );
        const decodedSucceeded = ReceiptCodec.decode(ReceiptCodec.encode(succeeded));
        const decodedFailed = ReceiptCodec.decode(ReceiptCodec.encode(failed));
        expect(
            decodedSucceeded instanceof AttemptReceipt ? decodedSucceeded.result?.value : undefined
        ).toBe(succeeded.result?.value);
        expect(
            decodedFailed instanceof AttemptReceipt ? decodedFailed.previous?.value : undefined
        ).toBe("unknown");
        expect(
            () =>
                new AttemptReceipt(
                    new ReceiptId("illegal"),
                    succeeded.attempt,
                    "indeterminate",
                    undefined,
                    time(4),
                    content("forbidden")
                )
        ).toThrow();
        expect(
            () =>
                new PreEffectReceipt(
                    new ReceiptId("invalid-pre-index"),
                    new InvocationId("invalid-pre-invocation"),
                    -1,
                    "deniedPreEffect",
                    time(1),
                    "reason"
                )
        ).toThrow();
        expect(
            () =>
                new PreEffectReceipt(
                    new ReceiptId("invalid-pre-outcome"),
                    new InvocationId("invalid-pre-invocation"),
                    0,
                    "invalid" as never,
                    time(1),
                    "reason"
                )
        ).toThrow();
        expect(
            () =>
                new PreEffectReceipt(
                    new ReceiptId("invalid-pre-reason"),
                    new InvocationId("invalid-pre-invocation"),
                    0,
                    "deniedPreEffect",
                    time(1),
                    " "
                )
        ).toThrow();
        expect(
            () =>
                new AttemptReceipt(
                    new ReceiptId("invalid-attempt-outcome"),
                    new EffectAttemptId("invalid-attempt"),
                    "invalid" as never,
                    undefined,
                    time(1),
                    undefined
                )
        ).toThrow();

        const envelope = (payload: unknown) =>
            encodeCanonicalJson({
                kind: "invocation.receipt",
                version: { major: 1, minor: 0 },
                payload: payload as never
            });
        expect(() => Receipt.decode(envelope(null))).toThrow();
        expect(() =>
            Receipt.decode(
                envelope({
                    id: "wire-pre",
                    invocation: "wire-invocation",
                    itemIndex: "zero",
                    outcome: "deniedPreEffect",
                    reason: "reason",
                    recordedAt: time(1).toISOString(),
                    variant: "preEffect"
                })
            )
        ).toThrow();
        expect(() =>
            Receipt.decode(
                envelope({
                    attempt: "wire-attempt",
                    id: "wire-attempt-receipt",
                    outcome: "failed",
                    previous: false,
                    recordedAt: time(1).toISOString(),
                    result: null,
                    variant: "attempt"
                })
            )
        ).toThrow();
        expect(() => Receipt.decode(envelope({ variant: "unknown" }))).toThrow();
        expect(() => Receipt.encode(new UnknownReceipt())).toThrow();
    });

    test("[C13-PREPARED-ROUTED-PROJECTION] covers every BatchOutcome precedence and terminal projection", () => {
        const invocation = new InvocationId("outcome-invocation");
        const denied = new PreEffectReceipt(
            new ReceiptId("outcome-denied"),
            invocation,
            0,
            "deniedPreEffect",
            time(1),
            "denied"
        );
        const cancelled = new PreEffectReceipt(
            new ReceiptId("outcome-cancelled"),
            invocation,
            1,
            "cancelledPreEffect",
            time(1),
            "cancelled"
        );
        const success = attempted("outcome-success", "succeeded");
        const failed = attempted("outcome-failed", "failed");
        const unknown = attempted("outcome-unknown", "indeterminate");
        expect(deriveBatchOutcome(1, [undefined])).toBeUndefined();
        expect(deriveBatchOutcome(1, [success])).toBe("succeeded");
        expect(deriveBatchOutcome(2, [success, failed])).toBe("partiallySucceeded");
        expect(deriveBatchOutcome(1, [failed])).toBe("failed");
        expect(deriveBatchOutcome(2, [denied, cancelled])).toBe("cancelled");
        expect(deriveBatchOutcome(1, [denied])).toBe("denied");
        expect(deriveBatchOutcome(1, [unknown])).toBe("indeterminate");
        expect(terminalBatchOutcome("failed")).toBe("failed");
        expect(terminalBatchOutcome("indeterminate")).toBeUndefined();
        expect(() => deriveBatchOutcome(0, [])).toThrow();
    });
});

class UnknownReceipt extends Receipt {
    declare public readonly variant: "attempt";
    declare public readonly id: ReceiptId;
    declare public readonly outcome: "failed";

    public constructor() {
        super(time(1), {
            variant: "attempt",
            id: new ReceiptId("unknown-receipt"),
            outcome: "failed"
        });
    }
}

function approval(id: string, expiresAt: Date): Approval {
    return Approval.pending(
        new ApprovalId(id),
        new InvocationId(`invocation-${id}`),
        Digest.sha256(new TextEncoder().encode(id)),
        time(1),
        expiresAt
    );
}

function attempted(id: string, outcome: "succeeded" | "failed" | "indeterminate"): AttemptReceipt {
    return new AttemptReceipt(
        new ReceiptId(id),
        new EffectAttemptId(`attempt-${id}`),
        outcome,
        undefined,
        time(1),
        outcome === "succeeded" ? content(id) : undefined
    );
}

function content(value: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(value)));
}

function time(second: number): Date {
    return new Date(second * 1000);
}

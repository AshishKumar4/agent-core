// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { TenantId } from "../../src/identity";
import {
    Approval,
    ApprovalId,
    AuditRecord,
    AuditRecordId,
    ClaimWorkerId,
    CorrelationId,
    EffectAttempt,
    EffectAttemptId,
    InvocationId,
    ItemClaim,
    ItemClaimId,
    PreEffectReceipt,
    PreparedInvocation,
    Receipt,
    ReceiptId
} from "../../src/invocations";
import {
    admissionFor,
    attemptCodec,
    claimCodec,
    prepared,
    preparedReferenceCodecs,
    referenceCodec
} from "./fixture";

describe("durable invocation record codecs", () => {
    test("[audit-record] round-trips an actual immutable fixture", () => {
        const record = new AuditRecord({
            id: new AuditRecordId("static-audit"),
            actor: new ActorRef("run", new ActorId("static-actor")),
            tenant: new TenantId("static-tenant"),
            correlation: new CorrelationId("static-correlation"),
            kind: { kind: "invocation", id: new InvocationId("static-invocation") }
        });
        expect(AuditRecord.decode(AuditRecord.encode(record)).id.equals(record.id)).toBe(true);
    });

    test("[invocation.prepared] round-trips an actual immutable fixture", () => {
        const record = prepared("static-prepared");
        const decoded = PreparedInvocation.decode(
            PreparedInvocation.encode(record, preparedReferenceCodecs),
            preparedReferenceCodecs
        );
        expect(decoded.intentDigest.equals(record.intentDigest)).toBe(true);
    });

    test("[invocation.approval] round-trips an actual immutable fixture", () => {
        const invocation = prepared("static-approval");
        const record = Approval.pending(
            new ApprovalId("static-approval"),
            invocation.header.id,
            invocation.intentDigest,
            new Date(1000),
            new Date(2000)
        );
        expect(Approval.decode(Approval.encode(record)).id.equals(record.id)).toBe(true);
    });

    test("[invocation.item-claim] round-trips an actual immutable fixture", () => {
        const record = new ItemClaim(
            new ItemClaimId("static-claim"),
            new InvocationId("static-claim-invocation"),
            0,
            0,
            { kind: "executor", token: "lease", worker: new ClaimWorkerId("worker") },
            new Date(2000)
        );
        expect(
            ItemClaim.decode(ItemClaim.encode(record, referenceCodec), referenceCodec).id.equals(
                record.id
            )
        ).toBe(true);
        expect(claimCodec.decode(claimCodec.encode(record)).id.equals(record.id)).toBe(true);
    });

    test("[invocation.effect-attempt] round-trips an actual immutable fixture", () => {
        const record = new EffectAttempt(
            new EffectAttemptId("static-attempt"),
            new InvocationId("static-attempt-invocation"),
            0,
            0,
            new ItemClaimId("static-attempt-claim"),
            "lease",
            admissionFor("static-attempt-invocation", 0, 0),
            new Date(1000),
            "agent-core.item.v1:static",
            new AuditRecordId("static-attempt-audit")
        );
        const decoded = EffectAttempt.decode(
            EffectAttempt.encode(record, referenceCodec, referenceCodec),
            referenceCodec,
            referenceCodec
        );
        expect(decoded.id.equals(record.id)).toBe(true);
        expect(attemptCodec.decode(attemptCodec.encode(record)).id.equals(record.id)).toBe(true);
    });

    test("[invocation.receipt] round-trips an actual immutable fixture", () => {
        const record = new PreEffectReceipt(
            new ReceiptId("static-receipt"),
            new InvocationId("static-receipt-invocation"),
            0,
            "cancelledPreEffect",
            new Date(1000),
            "cancelled"
        );
        const decoded = Receipt.decode(Receipt.encode(record));
        expect(decoded.id.equals(record.id)).toBe(true);
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.isFrozen(decoded)).toBe(true);
    });
});

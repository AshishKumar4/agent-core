import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { encodeCanonicalJson } from "../../src/core";
import { PrincipalId, TenantId } from "../../src/identity";
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
    ReceiptId,
    type ItemClaimOwner
} from "../../src/invocations";
import {
    admissionFor,
    attemptCodec,
    claimCodec,
    continuationCodec,
    digest,
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

    test("decodes every Approval state kind into an identical record", { tags: "p1" }, () => {
        const pending = Approval.pending(
            new ApprovalId("codec-state"),
            new InvocationId("codec-state-invocation"),
            digest("codec-state"),
            new Date(1000),
            new Date(10_000)
        );
        const approved = pending.approve(new PrincipalId("codec-approver"), new Date(2000));
        const expired = pending.expire(new Date(10_000));
        for (const record of [pending, approved, expired]) {
            const encoded = Approval.encode(record);
            const decoded = Approval.decode(encoded);
            expect(decoded.state.kind).toBe(record.state.kind);
            expect(Approval.encode(decoded)).toEqual(encoded);
        }
    });

    test("rejects malformed Approval states with their precise errors", { tags: "p2" }, () => {
        const envelope = (state: unknown) =>
            encodeCanonicalJson({
                kind: "invocation.approval",
                version: { major: 1, minor: 0 },
                payload: {
                    expiresAt: null,
                    id: "wire-approval",
                    intentDigest: digest("wire-approval").value,
                    invocation: "wire-approval-invocation",
                    requestedAt: new Date(1000).toISOString(),
                    revision: 0,
                    state: state as never
                }
            });
        for (const state of [null, [], "approved", { kind: null }]) {
            expect(() => Approval.decode(envelope(state))).toThrow(/Approval state is malformed/);
        }
        expect(() => Approval.decode(envelope({}))).toThrow(/kind must be a string or null/);
        expect(() => Approval.decode(envelope({ kind: "unknown" }))).toThrow(
            /Approval state kind is invalid/
        );
    });

    test("decodes every claim owner Actor kind and rejects malformed owners precisely", { tags: "p1" }, () => {
        const envelope = (owner: unknown) =>
            encodeCanonicalJson({
                kind: "invocation.item-claim",
                version: { major: 1, minor: 0 },
                payload: {
                    attemptOrdinal: 0,
                    expiresAt: new Date(9000).toISOString(),
                    id: "wire-owner-claim",
                    invocation: "wire-owner-invocation",
                    itemIndex: 0,
                    owner: owner as never
                }
            });
        for (const owner of [null, [], "executor"]) {
            expect(() => claimCodec.decode(envelope(owner))).toThrow(
                /Claim owner must be an object/
            );
        }
        expect(() => claimCodec.decode(envelope({ kind: "unknown", worker: "worker" }))).toThrow(
            /Claim owner kind is invalid/
        );
        for (const kind of ["tenant", "workspace", "run", "environment", "slate"]) {
            const decoded = claimCodec.decode(
                envelope({ actor: { id: "wire-actor", kind }, kind: "system", worker: "worker" })
            );
            expect(systemActorKind(decoded.owner)).toBe(kind);
        }
        expect(() =>
            claimCodec.decode(
                envelope({
                    actor: { id: "wire-actor", kind: "unknown" },
                    kind: "system",
                    worker: "worker"
                })
            )
        ).toThrow(/Claim owner Actor kind is invalid/);
    });

    test("decodes every continuation owner Actor kind and rejects unknown kinds precisely", { tags: "p1" }, () => {
        const envelope = (owner: unknown) =>
            encodeCanonicalJson({
                kind: "invocation.continuation",
                version: { major: 1, minor: 0 },
                payload: {
                    admittedAt: new Date(3000).toISOString(),
                    approval: "wire-continuation-approval",
                    firstAttempt: "wire-continuation-attempt",
                    firstClaim: "wire-continuation-claim",
                    firstClaimOwner: owner as never,
                    firstItemIndex: 0,
                    firstItemKey: "agent-core.item.v1:wire",
                    firstOrdinal: 0,
                    intentDigest: digest("wire-continuation").value,
                    invocation: "wire-continuation-invocation"
                }
            });
        for (const kind of ["tenant", "workspace", "run", "environment", "slate"]) {
            const decoded = continuationCodec.decode(
                envelope({ actor: { id: "wire-actor", kind }, kind: "system", worker: "worker" })
            );
            expect(systemActorKind(decoded.firstClaimOwner)).toBe(kind);
        }
        expect(() =>
            continuationCodec.decode(
                envelope({
                    actor: { id: "wire-actor", kind: "unknown" },
                    kind: "system",
                    worker: "worker"
                })
            )
        ).toThrow(/Continuation Actor kind is invalid/);
    });

    test("rejects malformed Receipt payloads with their precise errors", { tags: "p2" }, () => {
        const envelope = (payload: unknown) =>
            encodeCanonicalJson({
                kind: "invocation.receipt",
                version: { major: 1, minor: 0 },
                payload: payload as never
            });
        for (const payload of [null, [], "receipt"]) {
            expect(() => Receipt.decode(envelope(payload))).toThrow(
                /Receipt payload must be an object/
            );
        }
        expect(() => Receipt.decode(envelope({ variant: "unknown" }))).toThrow(
            /Receipt variant is invalid/
        );
        const preEffect = (overrides: { readonly [key: string]: unknown }) =>
            envelope({
                id: "wire-pre-receipt",
                invocation: "wire-pre-invocation",
                itemIndex: 0,
                outcome: "deniedPreEffect",
                reason: "reason",
                recordedAt: new Date(1000).toISOString(),
                variant: "preEffect",
                ...overrides
            });
        expect(() => Receipt.decode(preEffect({ itemIndex: "zero" }))).toThrow(
            "Receipt item index must be a safe integer"
        );
        expect(() => Receipt.decode(preEffect({ itemIndex: 1.5 }))).toThrow(
            "Receipt item index must be a safe integer"
        );
        expect(() => Receipt.decode(preEffect({ outcome: "invalid" }))).toThrow(
            /Pre-effect Receipt outcome is invalid/
        );
        const attempt = (overrides: { readonly [key: string]: unknown }) =>
            envelope({
                attempt: "wire-attempt",
                id: "wire-attempt-receipt",
                outcome: "failed",
                previous: null,
                recordedAt: new Date(1000).toISOString(),
                result: null,
                variant: "attempt",
                ...overrides
            });
        expect(() => Receipt.decode(attempt({ previous: false }))).toThrow(
            /Attempt Receipt references are malformed/
        );
        expect(() => Receipt.decode(attempt({ result: 5 }))).toThrow(
            /Attempt Receipt references are malformed/
        );
    });
});

function systemActorKind(owner: ItemClaimOwner<string>): string {
    if (owner.kind !== "system") throw new TypeError("Expected a system claim owner");
    return owner.actor.kind;
}

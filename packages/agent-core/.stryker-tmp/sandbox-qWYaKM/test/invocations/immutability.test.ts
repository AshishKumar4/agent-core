// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, type JsonValue } from "../../src/core";
import {
    Approval,
    ApprovalId,
    AuditRecordId,
    AuthorityAdmissionReference,
    ClaimWorkerId,
    EffectAttempt,
    EffectAttemptId,
    InvocationId,
    ItemClaim,
    ItemClaimId,
    PreparedInvocation,
    type StructuralCodec
} from "../../src/invocations";
import { PrincipalId } from "../../src/identity";
import { operationPin } from "./fixture";

interface MutableReference {
    value: string;
    nested: { value: string };
}

const referenceCodec: StructuralCodec<MutableReference> = {
    encode(value): JsonValue {
        return { nested: { value: value.nested.value }, value: value.value };
    },
    decode(value): MutableReference {
        const object = value as { value: string; nested: { value: string } };
        return { value: object.value, nested: { value: object.nested.value } };
    }
};

describe("invocation record immutability", () => {
    test("[C13-PREPARED-WHOLE-DIGEST] detaches PreparedInvocation structural references before digesting", () => {
        const authority = mutable("authority");
        const domain = mutable("domain");
        const epochs = mutable("epochs");
        const lease = mutable("lease");
        const record = PreparedInvocation.create(
            {
                id: new InvocationId("immutable-prepared"),
                operation: operationPin("immutable-prepared"),
                domain,
                actor: new ActorRef("run", new ActorId("immutable-actor")),
                authority,
                pathEpochs: epochs,
                lease,
                auditCause: new AuditRecordId("immutable-audit"),
                idempotencySeed: "immutable-seed"
            },
            { kind: "single", item: {} },
            {
                authority: referenceCodec,
                domain: referenceCodec,
                pathEpochs: referenceCodec,
                lease: referenceCodec
            }
        );
        const digest = record.intentDigest.value;
        authority.nested.value = "changed";
        domain.value = "changed";
        epochs.value = "changed";
        lease.value = "changed";
        expect(record.intentDigest.value).toBe(digest);
        expect(Object.isFrozen(record.intentDigest)).toBe(true);
        expect(record.header.authority.nested.value).toBe("authority-nested");
        expect(Object.isFrozen(record.header.authority.nested)).toBe(true);
        expect(Object.isFrozen(record.header.actor)).toBe(true);
        expect(Object.isFrozen(record.header.actor.id)).toBe(true);

        let hostileValue = "hostile-before";
        class HostileInvocationId extends InvocationId {
            public override get value(): string {
                return hostileValue;
            }
        }
        expect(() =>
            PreparedInvocation.create(
                {
                    id: new HostileInvocationId("ignored"),
                    operation: operationPin("hostile-before"),
                    domain: mutable("domain"),
                    actor: new ActorRef("run", new ActorId("hostile-actor")),
                    authority: mutable("authority"),
                    pathEpochs: mutable("epochs"),
                    auditCause: new AuditRecordId("hostile-audit"),
                    idempotencySeed: "hostile-seed"
                },
                { kind: "single", item: {} },
                {
                    authority: referenceCodec,
                    domain: referenceCodec,
                    pathEpochs: referenceCodec,
                    lease: referenceCodec
                }
            )
        ).toThrow(TypeError);
        hostileValue = "hostile-after";
    });

    test("[C13-PREPARED-APPROVAL-FIRST-ATTEMPT] freezes claim, attempt, admission, and Approval state aliases", () => {
        const token = mutable("token");
        const claim = new ItemClaim(
            new ItemClaimId("immutable-claim"),
            new InvocationId("immutable-invocation"),
            0,
            0,
            { kind: "executor", token, worker: new ClaimWorkerId("immutable-worker") },
            new Date(5000)
        );
        expect(Object.isFrozen(token.nested)).toBe(true);
        const admissionValue = mutable("admission");
        const admission = new AuthorityAdmissionReference(
            admissionValue,
            Digest.sha256(new TextEncoder().encode("admission"))
        );
        const attemptToken = mutable("attempt-token");
        const attempt = new EffectAttempt(
            new EffectAttemptId("immutable-attempt"),
            claim.invocation,
            0,
            0,
            claim.id,
            attemptToken,
            admission,
            new Date(1000),
            "agent-core.item.v1:immutable",
            new AuditRecordId("immutable-attempt-audit")
        );
        expect(Object.isFrozen(admission.reference.nested)).toBe(true);
        expect(Object.isFrozen(attempt.token?.nested)).toBe(true);

        const approved = Approval.pending(
            new ApprovalId("immutable-approval"),
            claim.invocation,
            Digest.sha256(new TextEncoder().encode("approval")),
            new Date(1000),
            new Date(5000)
        ).approve(new PrincipalId("approver"), new Date(2000));
        const exposed = approved.state;
        if (exposed.kind !== "approved") throw new TypeError("Expected approved state");
        exposed.at.setTime(4000);
        expect(approved.state.kind === "approved" ? approved.state.at.getTime() : 0).toBe(2000);
    });
});

function mutable(value: string): MutableReference {
    return { value, nested: { value: `${value}-nested` } };
}

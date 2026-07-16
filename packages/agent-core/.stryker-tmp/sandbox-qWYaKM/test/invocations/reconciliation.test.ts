// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
    AuditRecordId,
    EffectAttempt,
    EffectAttemptId,
    InvocationId,
    InvocationReconciler,
    ItemClaimId
} from "../../src/invocations";
import { admissionFor } from "./fixture";

describe("InvocationReconciler", () => {
    test("[C13-EFFECT-RECONCILIATION-DRIVER] queries once, never resends unknown, and finalizes only authoritative results", async () => {
        const attempt = new EffectAttempt<string, string>(
            new EffectAttemptId("reconcile-attempt"),
            new InvocationId("reconcile-invocation"),
            0,
            0,
            new ItemClaimId("reconcile-claim"),
            "lease",
            admissionFor("reconcile-invocation", 0, 0),
            new Date(1000),
            "agent-core.item.v1:reconcile",
            new AuditRecordId("reconcile-audit")
        );
        let finalizations = 0;
        const unknown = new InvocationReconciler<string, string>({
            async query() {
                return { kind: "unknown" };
            }
        });
        expect(
            await unknown.reconcile(attempt, {
                async finalize() {
                    finalizations += 1;
                    return "unexpected";
                }
            })
        ).toBeUndefined();
        expect(finalizations).toBe(0);

        const succeeded = new InvocationReconciler<string, string>({
            async query() {
                return { kind: "succeeded" };
            }
        });
        expect(
            await succeeded.reconcile(attempt, {
                async finalize(_attempt, result) {
                    finalizations += 1;
                    return result.kind;
                }
            })
        ).toBe("succeeded");
        expect(finalizations).toBe(1);
    });
});

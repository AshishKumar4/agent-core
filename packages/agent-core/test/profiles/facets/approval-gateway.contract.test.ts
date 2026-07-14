import { Digest, type JsonValue } from "../../../src/core";
import {
    APPROVAL_GATEWAY_CONTRIBUTIONS,
    APPROVAL_GATEWAY_ISOLATION,
    APPROVAL_GATEWAY_OPERATIONS,
    APPROVAL_GATEWAY_SURFACE,
    ApprovalGatewayAction,
    ApprovalGatewayBackend,
    ApprovalGatewayFacet,
    type ProfileEffectContext
} from "../../../src/facets";
import { InvocationId } from "../../../src/interaction-references";
import { describe, expect, test } from "vitest";
import { denyingRuntime, operationDeclarationEvidence, recordingRuntime } from "./harness";

operationDeclarationEvidence("Approval gateway", APPROVAL_GATEWAY_OPERATIONS, {
    observe: "observe",
    applyAction: "externalSend"
});

describe("Approval gateway protected provider profile", () => {
    test("[P11-APPROVAL-GATEWAY-OBSERVE] mediates observe with observe impact and returns the authorized resource", async () => {
        const backend = new TestGatewayBackend();
        const { runtime, admission } = recordingRuntime("approval-observe");
        const facet = new ApprovalGatewayFacet(
            runtime,
            new ApprovalGatewayAction(
                new InvocationId("observe-unused-action"),
                new Digest("a".repeat(64)),
                "account",
                {}
            ),
            backend
        );

        await expect(facet.observe({ resource: "account" })).resolves.toEqual({
            resource: "account"
        });
        expect(admission.calls).toMatchObject([
            { kind: "invoke", name: "observe", impact: "observe", input: { resource: "account" } }
        ]);
    });

    test("[P11-APPROVAL-GATEWAY-READS] denies an observation before the provider read", async () => {
        const backend = new TestGatewayBackend();
        const facet = new ApprovalGatewayFacet(
            denyingRuntime("approval-read").runtime,
            new ApprovalGatewayAction(
                new InvocationId("read-unused-action"),
                new Digest("b".repeat(64)),
                "account",
                {}
            ),
            backend
        );

        await expect(facet.observe({ resource: "account" })).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(backend.observations).toEqual([]);
    });

    test("[P11-APPROVAL-GATEWAY-PROVIDER] accesses the provider resource only inside admitted execution", async () => {
        const backend = new TestGatewayBackend();
        const { runtime, admission } = recordingRuntime("approval-provider");
        const invocation = new InvocationId("profile-invocation-1");
        const facet = new ApprovalGatewayFacet(
            runtime,
            new ApprovalGatewayAction(invocation, inputDigest("account"), "account", {
                approved: true
            }),
            backend
        );

        await expect(facet.applyAction({ resource: "account" })).resolves.toEqual({
            applied: true
        });
        expect(admission.calls[0]).toMatchObject({
            kind: "invoke",
            impact: "externalSend",
            name: "applyAction"
        });
        expect(backend.actions).toEqual([{ approved: true }]);
    });

    test("rejects noncanonical approved resource identities", () => {
        expect(
            () =>
                new ApprovalGatewayAction(
                    new InvocationId("invalid-resource"),
                    new Digest("a".repeat(64)),
                    " account ",
                    {}
                )
        ).toThrow(TypeError);
    });

    test("binds one frozen action to exact admitted Invocation, digest, and resource", async () => {
        const backend = new TestGatewayBackend();
        const { runtime, admission } = recordingRuntime("approval");
        const continuation = new ApprovalGatewayAction(
            new InvocationId("profile-invocation-2"),
            inputDigest("account"),
            "account",
            { wholeIntent: true }
        );
        const facet = new ApprovalGatewayFacet(runtime, continuation, backend);

        await expect(facet.observe({ resource: "account" })).resolves.toEqual({
            resource: "account"
        });
        await expect(facet.applyAction({ resource: "account" })).resolves.toEqual({
            applied: true
        });
        expect(admission.calls.map((call) => call.name)).toEqual(["observe", "applyAction"]);
        expect(backend.actions).toEqual([{ wholeIntent: true }]);
    });

    test("[P11-APPROVAL-GATEWAY-CREDENTIAL] rejects mismatched digest or resource before credential effects", async () => {
        const backend = new TestGatewayBackend();
        const { runtime } = recordingRuntime("approval");
        const continuation = new ApprovalGatewayAction(
            new InvocationId("profile-invocation-1"),
            new Digest("b".repeat(64)),
            "other",
            { denied: true }
        );
        const facet = new ApprovalGatewayFacet(runtime, continuation, backend);
        await expect(facet.applyAction({ resource: "account" })).rejects.toMatchObject({
            detailCode: "approval.mismatch"
        });
        expect(backend.actions).toEqual([]);
    });

    test("[P11-APPROVAL-GATEWAY-APPLY] protected admission denial prevents approval action access", async () => {
        const denied = denyingRuntime("approval");
        const continuation = new ApprovalGatewayAction(
            new InvocationId("denied-invocation"),
            new Digest("c".repeat(64)),
            "account",
            {}
        );
        const backend = new TestGatewayBackend();
        const facet = new ApprovalGatewayFacet(denied.runtime, continuation, backend);
        await expect(facet.applyAction({ resource: "account" })).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(backend.actions).toEqual([]);
    });

    test("[P11-APPROVAL-GATEWAY-SURFACE] declares provider isolation, approval Surface, and exact contributions", () => {
        expect(APPROVAL_GATEWAY_ISOLATION).toEqual(["provider"]);
        expect(APPROVAL_GATEWAY_SURFACE.id.value).toBe("approval.gateway");
        expect(APPROVAL_GATEWAY_CONTRIBUTIONS.entries.map((entry) => entry.slot.value)).toEqual([
            "operations",
            "surfaces"
        ]);
    });
});

class TestGatewayBackend extends ApprovalGatewayBackend {
    public readonly actions: JsonValue[] = [];
    public readonly observations: string[] = [];

    public async observe(resource: string): Promise<JsonValue> {
        this.observations.push(resource);
        return { resource };
    }

    public async apply(
        context: ProfileEffectContext,
        _resource: string,
        action: JsonValue
    ): Promise<JsonValue> {
        expect(context.idempotencyKey).toMatch(/^profile-idempotency-\d+$/u);
        this.actions.push(action);
        return { applied: true };
    }
}

function inputDigest(resource: string): Digest {
    return Digest.sha256(new TextEncoder().encode(JSON.stringify({ resource })));
}

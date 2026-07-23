import { MemoryContentStore } from "../../../src/content";
import { CompatRange, Digest, SemVer, type JsonValue } from "../../../src/core";
import {
    APPROVAL_GATEWAY_CONTRIBUTIONS,
    APPROVAL_GATEWAY_ISOLATION,
    APPROVAL_GATEWAY_OPERATIONS,
    APPROVAL_GATEWAY_SURFACE,
    ApprovalGatewayAction,
    ApprovalGatewayBackend,
    ApprovalGatewayError,
    ApprovalGatewayFacet,
    FacetPackageId,
    OperationName,
    ProfileEffectContext,
    createApprovalGatewayManifest,
    type EffectDispatch,
    type FacetManifest,
    type InternalProfileFacetRuntime,
    type Operation,
    type OperationContext
} from "../../../src/facets";
import { InvocationId } from "../../../src/interaction-references";
import { EffectAttemptId } from "../../../src/invocations";
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
        expect(backend.dispatchKeys).toEqual(["profile-idempotency-1"]);
    });

    test("rejects noncanonical approved resource identities", { tags: "p0" }, () => {
        expect(
            () =>
                new ApprovalGatewayAction(
                    new InvocationId("invalid-resource"),
                    new Digest("a".repeat(64)),
                    " account ",
                    {}
                )
        ).toThrow("Approved resource must be canonical");
        expect(
            () =>
                new ApprovalGatewayAction(
                    new InvocationId("empty-resource"),
                    new Digest("a".repeat(64)),
                    "",
                    {}
                )
        ).toThrow("Approved resource must be canonical");
    });

    test("releases the action only to the exactly admitted attempt identity", { tags: "p0" }, () => {
        const digest = inputDigest("account");
        const approval = new ApprovalGatewayAction(
            new InvocationId("admitted"),
            digest,
            "account",
            { approved: true }
        );
        expect(
            approval.actionFor(effectContext(new InvocationId("admitted"), digest), "account")
        ).toEqual({ approved: true });
    });

    test("rejects each single divergence from the admitted intent", { tags: "p0" }, () => {
        const digest = inputDigest("account");
        const approval = new ApprovalGatewayAction(
            new InvocationId("admitted"),
            digest,
            "account",
            { approved: true }
        );
        const mismatch = expect.objectContaining({
            name: "ApprovalGatewayError",
            code: "invocation.invalid",
            detailCode: "approval.mismatch",
            message: "Approval does not bind the exact admitted intent"
        });
        expect(() =>
            approval.actionFor(effectContext(new InvocationId("other"), digest), "account")
        ).toThrow(mismatch);
        expect(() =>
            approval.actionFor(
                effectContext(new InvocationId("admitted"), inputDigest("other")),
                "account"
            )
        ).toThrow(mismatch);
        expect(() =>
            approval.actionFor(effectContext(new InvocationId("admitted"), digest), "other")
        ).toThrow(mismatch);
    });

    test("rejects an attempt-less context with the typed approval error", { tags: "p0" }, () => {
        const approval = new ApprovalGatewayAction(
            new InvocationId("admitted"),
            inputDigest("account"),
            "account",
            {}
        );
        const attemptless = new ProfileEffectContext(
            new InvocationId("admitted"),
            0,
            "approval-key",
            undefined,
            undefined,
            undefined
        );
        let caught: unknown;
        try {
            approval.actionFor(attemptless, "account");
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ApprovalGatewayError);
        expect(caught).toMatchObject({ detailCode: "approval.mismatch" });
    });

    test("internal runtime mediates observe and applyAction with the bound approval", { tags: "p0" }, async () => {
        const backend = new TestGatewayBackend();
        const { runtime } = recordingRuntime("approval-internal");
        const digest = inputDigest("internal");
        const invocation = new InvocationId("internal-invocation");
        const approval = new ApprovalGatewayAction(invocation, digest, "account", {
            approved: true
        });
        const internal = new ApprovalGatewayFacet(runtime, approval, backend).asInternalRuntime(
            gatewayManifest()
        );
        await internal.start({ signal: new AbortController().signal });
        expect(internal.active).toBe(true);
        expect(internal.surface(APPROVAL_GATEWAY_SURFACE.id)?.descriptor).toBe(
            APPROVAL_GATEWAY_SURFACE
        );

        const context = internalContext(invocation, digest);
        await expect(
            internalOperation(internal, "observe").execute(context, { resource: "account" })
        ).resolves.toEqual({ resource: "account" });
        expect(backend.observations).toEqual(["account"]);
        await expect(
            internalOperation(internal, "applyAction").execute(context, { resource: "account" })
        ).resolves.toEqual({ applied: true });
        expect(backend.actions).toEqual([{ approved: true }]);
        expect(backend.dispatchKeys).toEqual(["internal-idempotency"]);
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
    public readonly dispatchKeys: string[] = [];

    public async observe(resource: string): Promise<JsonValue> {
        this.observations.push(resource);
        return { resource };
    }

    public async apply(
        dispatch: EffectDispatch,
        _resource: string,
        action: JsonValue
    ): Promise<JsonValue> {
        this.dispatchKeys.push(dispatch.idempotencyKey);
        this.actions.push(action);
        return { applied: true };
    }

    public async reconcile(): Promise<{ readonly kind: "unknown" }> {
        return { kind: "unknown" };
    }
}

function inputDigest(resource: string): Digest {
    return Digest.sha256(new TextEncoder().encode(JSON.stringify({ resource })));
}

function effectContext(invocation: InvocationId, intentDigest: Digest): ProfileEffectContext {
    return new ProfileEffectContext(
        invocation,
        0,
        "approval-key",
        new EffectAttemptId("approval-attempt"),
        0,
        intentDigest
    );
}

function internalContext(invocation: InvocationId, intentDigest: Digest): OperationContext {
    return Object.freeze({
        invocation,
        itemIndex: 0,
        idempotencyKey: "internal-idempotency",
        attempt: Object.freeze({
            id: new EffectAttemptId("internal-attempt"),
            ordinal: 0,
            intentDigest
        }),
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}

function internalOperation(internal: InternalProfileFacetRuntime, name: string): Operation {
    const operation = internal.operation(new OperationName(name));
    if (operation === undefined) throw new TypeError(`Missing internal Operation ${name}`);
    return operation;
}

function gatewayManifest(): FacetManifest {
    return createApprovalGatewayManifest({
        id: new FacetPackageId("profile.approval-internal"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        bindings: []
    });
}

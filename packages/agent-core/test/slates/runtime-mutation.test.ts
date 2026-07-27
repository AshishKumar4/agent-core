import { describe, expect, test } from "vitest";
import { ContentRef, Digest } from "../../src/core";
import { InvocationId, ReceiptId } from "../../src/invocations";
import {
    MemorySlateIdSource,
    MemorySlateStore,
    SlateEffectContext,
    SlateInvocationSeam,
    SlateMutationSeam,
    SlatePreviewValidationSeam,
    SlateProvider,
    SlateRuntime,
    type SlateInvocationRequest,
    type SlateInvocationResult,
    type SlateMutationRequest,
    type SlatePreviewLinkIntent,
    type SlateProviderDeployment,
    type SlateProviderDeploymentRequest,
    type SlateProviderResource,
    type SlateProviderResourceRequest
} from "../../src/slates";
import { WorkspaceId } from "../../src/workspaces";

describe("SlateRuntime mutation kills", () => {
    test("rejects non-canonical external keys before reserving", { tags: "p0" }, async () => {
        const fixture = runtimeFixture("external-key");
        const { publication } = await publishedSlate(fixture);
        const error = expect.objectContaining({
            code: "operation.invalid-input",
            message: "Slate deployment external key must be canonical"
        });

        await expect(
            fixture.runtime.deploy(publication.id, "production", " padded ")
        ).rejects.toEqual(error);
        await expect(fixture.runtime.deploy(publication.id, "production", "")).rejects.toEqual(
            error
        );
        await expect(
            fixture.runtime.deploy(publication.id, "production", 7 as unknown as string)
        ).rejects.toEqual(error);
        expect(fixture.provider.deployRequests).toHaveLength(0);
        expect(fixture.store.snapshot().deploymentReservations).toHaveLength(0);
    });

    test("reconcile reports activation only for the active deployment", { tags: "p0" }, async () => {
        const fixture = runtimeFixture("activated-flag");
        const { publication } = await publishedSlate(fixture);
        const first = await fixture.runtime.deploy(publication.id, "first", "external-active-1");
        const second = await fixture.runtime.deploy(publication.id, "second", "external-active-2");
        if (first.outcome !== "succeeded" || second.outcome !== "succeeded") {
            throw new TypeError("Expected successful deployments");
        }

        const firstReplay = await fixture.runtime.reconcileDeployment(first.deployment.id);
        const secondReplay = await fixture.runtime.reconcileDeployment(second.deployment.id);
        if (firstReplay.outcome !== "succeeded" || secondReplay.outcome !== "succeeded") {
            throw new TypeError("Expected successful replays");
        }

        expect(firstReplay.activated).toBe(false);
        expect(secondReplay.activated).toBe(true);
    });

    test("reservations pin the frozen expected active deployment", { tags: "p0" }, async () => {
        const fixture = runtimeFixture("expected-pointer");
        const { publication } = await publishedSlate(fixture);
        const first = await fixture.runtime.deploy(publication.id, "first", "external-pointer-1");
        if (first.outcome !== "succeeded") throw new TypeError("Expected first deployment");
        const second = await fixture.runtime.deploy(publication.id, "second", "external-pointer-2");
        if (second.outcome !== "succeeded") throw new TypeError("Expected second deployment");

        const firstReservation = fixture.store.getDeploymentReservation(first.deployment.id);
        const secondReservation = fixture.store.getDeploymentReservation(second.deployment.id);

        expect(firstReservation?.expectedActiveDeploymentId).toBeUndefined();
        expect(secondReservation?.expectedActiveDeploymentId?.equals(first.deployment.id)).toBe(
            true
        );
    });

    test("allocates prefixed IDs for every kind in sequence", { tags: "p1" }, () => {
        const defaultSource = new MemorySlateIdSource();
        expect(defaultSource.allocateSlateId().value).toBe("slate-slate-0");

        const source = new MemorySlateIdSource("wave");
        expect(source.allocateSlateId().value).toBe("wave-slate-0");
        expect(source.allocateVersionId().value).toBe("wave-version-1");
        expect(source.allocatePublicationId().value).toBe("wave-publication-2");
        expect(source.allocateDeploymentId().value).toBe("wave-deployment-3");
        expect(source.allocateResourceId().value).toBe("wave-resource-4");
        expect(source.allocatePreviewId().value).toBe("wave-preview-5");
    });

    test("rejects succeeded invocation results with extra keys", { tags: "p1" }, async () => {
        const fixture = runtimeFixture("succeeded-extra-key");
        const { publication } = await publishedSlate(fixture);
        fixture.invocations.resultOverride = {
            outcome: "succeeded",
            receiptId: new ReceiptId("receipt-extra-key"),
            value: { materialization: ref("extra") },
            extra: true
        };

        await expect(
            fixture.runtime.deploy(publication.id, "production", "external-extra-key")
        ).rejects.toEqual(
            expect.objectContaining({
                code: "invocation.invalid",
                message: "Slate invocation result is malformed"
            })
        );
    });

    test("rejects malformed provider materializations exactly", { tags: "p1" }, async () => {
        const fixture = runtimeFixture("malformed-materialization");
        const { publication } = await publishedSlate(fixture);
        const deploymentError = expect.objectContaining({
            code: "operation.invalid-output",
            message: "Slate provider deployment result is malformed"
        });
        let sequence = 0;
        for (const malformed of [null, "materialized", { materialization: "not-a-ref" }, {}]) {
            fixture.provider.deploymentResult = malformed;
            sequence += 1;
            await expect(
                fixture.runtime.deploy(
                    publication.id,
                    "production",
                    `external-malformed-provider-${sequence}`
                )
            ).rejects.toEqual(deploymentError);
        }
        fixture.provider.deploymentResult = undefined;

        const deployed = await fixture.runtime.deploy(
            publication.id,
            "production",
            "external-resource-host"
        );
        if (deployed.outcome !== "succeeded") throw new TypeError("Expected deployment");
        fixture.provider.resourceResult = null;
        await expect(
            fixture.runtime.materializeResource(deployed.deployment.id, "database", ref("schema"))
        ).rejects.toEqual(
            expect.objectContaining({
                code: "operation.invalid-output",
                message: "Slate provider resource result is malformed"
            })
        );
    });
});

class StubMutationSeam extends SlateMutationSeam {
    public mutate<Result>(request: SlateMutationRequest, mutation: () => Result): Promise<Result> {
        expect(Object.isFrozen(request)).toBe(true);
        return Promise.resolve(mutation());
    }
}

class StubInvocationSeam extends SlateInvocationSeam {
    #sequence = 0;
    public resultOverride: unknown | undefined;

    public prepare(request: SlateInvocationRequest): Promise<InvocationId> {
        expect(Object.isFrozen(request)).toBe(true);
        return Promise.resolve(new InvocationId(`invocation-${this.#sequence++}`));
    }

    public async invoke<Result>(
        _request: SlateInvocationRequest,
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>> {
        return this.run(invocationId, effect);
    }

    public async reconcile<Result>(
        _request: SlateInvocationRequest,
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>> {
        return this.run(invocationId, effect);
    }

    private async run<Result>(
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>> {
        if (this.resultOverride !== undefined) {
            return this.resultOverride as SlateInvocationResult<Result>;
        }
        const receiptId = new ReceiptId(`receipt-${this.#sequence++}`);
        const value = await effect(
            new SlateEffectContext(invocationId, 0, 0, `slate-item:${invocationId.value}:0`)
        );
        return { outcome: "succeeded", receiptId, value };
    }
}

class StubPreviewValidation extends SlatePreviewValidationSeam {
    public validate(request: SlatePreviewLinkIntent): Promise<void> {
        expect(Object.isFrozen(request)).toBe(true);
        return Promise.resolve();
    }
}

class StubProvider extends SlateProvider {
    public readonly deployRequests: SlateProviderDeploymentRequest[] = [];
    public deploymentResult: unknown | undefined;
    public resourceResult: unknown | undefined;

    public deploy(request: SlateProviderDeploymentRequest): Promise<SlateProviderDeployment> {
        this.deployRequests.push(request);
        if (this.deploymentResult !== undefined) {
            return Promise.resolve(this.deploymentResult as SlateProviderDeployment);
        }
        return Promise.resolve({ materialization: ref(`deployment-${request.deploymentId.value}`) });
    }

    public reconcileDeployment(
        request: SlateProviderDeploymentRequest
    ): Promise<SlateProviderDeployment> {
        return Promise.resolve({
            materialization: ref(`reconciled-${request.deploymentId.value}`)
        });
    }

    public materializeResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource> {
        if (this.resourceResult !== undefined) {
            return Promise.resolve(this.resourceResult as SlateProviderResource);
        }
        return Promise.resolve({ materialization: ref(`resource-${request.resourceId.value}`) });
    }

    public reconcileResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource> {
        return Promise.resolve({ materialization: ref(`resource-${request.resourceId.value}`) });
    }
}

interface RuntimeFixture {
    readonly workspace: WorkspaceId;
    readonly store: MemorySlateStore;
    readonly invocations: StubInvocationSeam;
    readonly provider: StubProvider;
    readonly runtime: SlateRuntime;
}

function runtimeFixture(label: string): RuntimeFixture {
    const store = new MemorySlateStore();
    const invocations = new StubInvocationSeam();
    const provider = new StubProvider();
    return {
        workspace: new WorkspaceId(`workspace-${label}`),
        store,
        invocations,
        provider,
        runtime: new SlateRuntime(
            store,
            provider,
            new StubMutationSeam(),
            invocations,
            new StubPreviewValidation(),
            new MemorySlateIdSource(label)
        )
    };
}

async function publishedSlate(fixture: RuntimeFixture): Promise<{
    readonly publication: Awaited<ReturnType<SlateRuntime["publish"]>>;
}> {
    const slate = await fixture.runtime.create(fixture.workspace, ref("source"));
    const version = await fixture.runtime.commit(slate.id);
    const publication = await fixture.runtime.publish(version.id, ref("publication"));
    return { publication };
}

function ref(label: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(label)));
}

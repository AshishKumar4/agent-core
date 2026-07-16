import { describe, expect, test } from "vitest";
import { ContentRef, Digest, Revision } from "../../src/core";
import {
    EnvironmentId,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    PortExposureId
} from "../../src/environments";
import { AgentCoreError } from "../../src/errors";
import { InvocationId, ReceiptId } from "../../src/invocations";
import {
    MemorySlateIdSource,
    MemorySlateStore,
    SlateDeploymentId,
    SlateEffectContext,
    SlateId,
    SlateInvocationSeam,
    SlateMutationSeam,
    SlatePreviewValidationSeam,
    SlateProvider,
    SlatePublicationId,
    SlateRuntime,
    SlateResourceId,
    SlateStore,
    SlateVersionId,
    canonicalSlateInvocationRequest,
    sameSlateInvocationRequest,
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

describe("SlateRuntime", () => {
    test("[P11-SLATE-SPECIFICATION] executes the complete section 4.6 source, version, fork, and publication contract", async () => {
        const fixture = runtimeFixture("intent");
        const slate = await fixture.runtime.create(fixture.workspace, ref("draft-one"));
        const updated = await fixture.runtime.update(slate.id, ref("draft-two"));
        const version = await fixture.runtime.commit(updated.id);
        const fork = await fixture.runtime.fork(version.id, fixture.workspace);
        const publication = await fixture.runtime.publish(version.id, ref("published"));

        expect(fork.forkedFrom?.versionId.equals(version.id)).toBe(true);
        expect(publication.versionId.equals(version.id)).toBe(true);
        expect(fixture.mutations.requests.every(Object.isFrozen)).toBe(true);
        const commit = fixture.mutations.requests.find((request) => request.operation === "commit");
        expect(commit).toMatchObject({
            impact: "mutate",
            slateId: slate.id,
            versionId: version.id,
            source: version.source
        });
        await expect(
            fixture.runtime.fork(version.id, new WorkspaceId("workspace-foreign"))
        ).rejects.toEqual(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate forks must remain in the source Workspace"
            )
        );
    });

    test("replays a reused external effect identity instead of deploying twice", async () => {
        const fixture = runtimeFixture("external-idempotency");
        const { publication } = await publishedSlate(fixture);
        const first = await fixture.runtime.deploy(publication.id, "production", "external-stable");
        const replay = await fixture.runtime.deploy(
            publication.id,
            "production",
            "external-stable"
        );
        expect(first.outcome).toBe("succeeded");
        expect(replay.outcome).toBe("succeeded");
        if (first.outcome === "succeeded" && replay.outcome === "succeeded") {
            expect(replay.deployment.id.equals(first.deployment.id)).toBe(true);
        }
        expect(fixture.provider.deployRequests).toHaveLength(1);

        await expect(
            fixture.runtime.deploy(publication.id, "staging", "external-stable")
        ).rejects.toEqual(
            new AgentCoreError(
                "protocol.invalid-state",
                "Slate deployment effect identity was reused for a different request"
            )
        );
        expect(fixture.provider.deployRequests).toHaveLength(1);
    });

    test("[P11-SLATE-MEDIATED-DEPLOY] passes the same frozen deployment intent through prepare, invoke, and reconcile", async () => {
        const fixture = runtimeFixture("deploy-reconcile");
        const { publication } = await publishedSlate(fixture);
        fixture.invocations.invokeOutcomes.push("indeterminate");

        const uncertain = await fixture.runtime.deploy(publication.id, "production", "external-1");
        if (uncertain.outcome === "succeeded") throw new TypeError("Expected indeterminate deploy");
        const reservation = fixture.store.getDeploymentReservation(uncertain.deploymentId)!;
        expect(fixture.store.getDeployment(uncertain.deploymentId)).toBeUndefined();

        const reconciled = await fixture.runtime.reconcileDeployment(uncertain.deploymentId);
        if (reconciled.outcome !== "succeeded")
            throw new TypeError("Expected successful reconcile");
        expect(reconciled.deployment.id.equals(uncertain.deploymentId)).toBe(true);
        expect(reconciled.deployment.invocationId.equals(reservation.invocationId)).toBe(true);
        expect(fixture.invocations.validatedRequests).toBe(2);
        const invokedRequest = fixture.provider.deployRequests[0]!;
        const reconciledRequest = fixture.provider.reconcileDeploymentRequests[0]!;
        expect(reconciledRequest).toMatchObject({
            deploymentId: uncertain.deploymentId,
            publicationMaterialization: publication.materialization,
            target: "production"
        });
        expect(invokedRequest.effectContext.invocationId.equals(reservation.invocationId)).toBe(
            true
        );
        expect(invokedRequest.effectContext.itemIndex).toBe(0);
        expect(invokedRequest.effectContext.attemptOrdinal).toBe(0);
        expect(Object.isFrozen(invokedRequest.effectContext)).toBe(true);
        expect(invokedRequest.idempotencyKey).toBe(invokedRequest.effectContext.idempotencyKey);
        expect(reconciledRequest.effectContext.sameItem(invokedRequest.effectContext)).toBe(true);
        expect(reconciledRequest.effectContext.attemptOrdinal).toBe(0);
        expect(reconciledRequest.idempotencyKey).toBe(invokedRequest.idempotencyKey);
    });

    test("guards delayed deployment activation with the frozen expected pointer", async () => {
        const fixture = runtimeFixture("race");
        const { slate, publication } = await publishedSlate(fixture);
        const firstEffect = deferred<SlateProviderDeployment>();
        const secondEffect = deferred<SlateProviderDeployment>();
        fixture.provider.pendingDeployments.set("first", firstEffect);
        fixture.provider.pendingDeployments.set("second", secondEffect);

        const first = fixture.runtime.deploy(publication.id, "first", "external-2");
        await fixture.provider.called("first");
        const second = fixture.runtime.deploy(publication.id, "second", "external-3");
        await fixture.provider.called("second");
        secondEffect.resolve({ materialization: ref("second-deployment") });
        const secondResult = await second;
        if (secondResult.outcome !== "succeeded") throw new TypeError("Expected second success");
        firstEffect.resolve({ materialization: ref("first-deployment") });
        const firstResult = await first;
        if (firstResult.outcome !== "succeeded") throw new TypeError("Expected first success");

        expect(secondResult.activated).toBe(true);
        expect(firstResult.activated).toBe(false);
        expect(
            fixture.store.getSlate(slate.id)?.activeDeploymentId?.equals(secondResult.deployment.id)
        ).toBe(true);
    });

    test("reconciles an indeterminate resource from its original reservation", async () => {
        const fixture = runtimeFixture("resource-reconcile");
        const { publication } = await publishedSlate(fixture);
        const deployed = await fixture.runtime.deploy(publication.id, "production", "external-4");
        if (deployed.outcome !== "succeeded") throw new TypeError("Expected deployment");
        fixture.invocations.invokeOutcomes.push("indeterminate");

        const uncertain = await fixture.runtime.materializeResource(
            deployed.deployment.id,
            "database",
            ref("schema")
        );
        if (uncertain.outcome === "succeeded")
            throw new TypeError("Expected indeterminate resource");
        const reservation = fixture.store.getResourceReservation(uncertain.resourceId)!;
        expect(fixture.store.getResource(uncertain.resourceId)).toBeUndefined();

        const recovered = await fixture.runtime.reconcileResource(uncertain.resourceId);
        if (recovered.outcome !== "succeeded") throw new TypeError("Expected recovered resource");
        expect(recovered.resource.id.equals(reservation.id)).toBe(true);
        expect(recovered.resource.invocationId.equals(reservation.invocationId)).toBe(true);
        const invokedRequest = fixture.provider.resourceRequests[0]!;
        const reconciledRequest = fixture.provider.reconcileResourceRequests[0]!;
        expect(reconciledRequest).toMatchObject({
            resourceId: reservation.id,
            resourceName: reservation.name,
            resourceSource: reservation.source,
            deploymentMaterialization: reservation.deploymentMaterialization
        });
        expect(invokedRequest.effectContext.invocationId.equals(reservation.invocationId)).toBe(
            true
        );
        expect(reconciledRequest.effectContext.sameItem(invokedRequest.effectContext)).toBe(true);
        expect(reconciledRequest.effectContext.attemptOrdinal).toBe(0);
        expect(reconciledRequest.idempotencyKey).toBe(invokedRequest.idempotencyKey);
        const replay = new MemorySlateStore(fixture.store.snapshot());
        expect(
            replay.getResource(recovered.resource.id)?.receiptId.equals(recovered.receiptId)
        ).toBe(true);
    });

    test("persists validated exact preview capability and exposure references", async () => {
        const fixture = runtimeFixture("preview");
        const slate = await fixture.runtime.create(fixture.workspace, ref("working"));
        const version = await fixture.runtime.commit(slate.id);
        const capability = sessionCapability("valid", 3, 7);
        const exposureId = new PortExposureId("exposure-valid");

        const preview = await fixture.runtime.linkPreview(
            slate.id,
            capability,
            exposureId,
            version.id
        );

        expect(preview.environmentId.equals(capability.environmentId)).toBe(true);
        expect(preview.sessionId.equals(capability.sessionId)).toBe(true);
        expect(preview.environmentRevision.equals(capability.environmentRevision)).toBe(true);
        expect(preview.sessionEpoch).toBe(capability.epoch);
        expect(preview.exposureId.equals(exposureId)).toBe(true);
        expect(fixture.previews.requests[0]).toBe(fixture.mutations.requests.at(-1));
    });

    test.each([
        ["stale", "environment.stale-session"],
        ["invalid", "environment.invalid-session"]
    ] as const)("denies %s preview references before persistence", async (_name, code) => {
        const fixture = runtimeFixture(`preview-${code}`);
        const slate = await fixture.runtime.create(fixture.workspace, ref("working"));
        fixture.previews.denial = new AgentCoreError(code, "preview denied");

        await expect(
            fixture.runtime.linkPreview(
                slate.id,
                sessionCapability(code, 1, 2),
                new PortExposureId(`exposure-${code}`)
            )
        ).rejects.toMatchObject({ code });
        expect(fixture.store.listPreviews(slate.id)).toEqual([]);
        expect(
            fixture.mutations.requests.some((request) => request.operation === "preview.link")
        ).toBe(false);
    });

    test("[P11-SLATE-ROLLBACK-POINTER] rolls back by local active-pointer selection without provider or invocation calls", async () => {
        const fixture = runtimeFixture("rollback");
        const { slate, publication } = await publishedSlate(fixture);
        const first = await fixture.runtime.deploy(publication.id, "first", "external-5");
        const second = await fixture.runtime.deploy(publication.id, "second", "external-6");
        if (first.outcome !== "succeeded" || second.outcome !== "succeeded") {
            throw new TypeError("Expected successful deploys");
        }
        const providerCalls = fixture.provider.totalCalls;
        const prepared = fixture.invocations.prepared.length;

        const rolledBack = await fixture.runtime.rollback(slate.id, first.deployment.id);

        expect(rolledBack.activeDeploymentId?.equals(first.deployment.id)).toBe(true);
        expect(fixture.provider.totalCalls).toBe(providerCalls);
        expect(fixture.invocations.prepared).toHaveLength(prepared);
    });

    test("rejects stale mutations and preserves only the concurrent winner", async () => {
        const fixture = runtimeFixture("stale-update");
        const slate = await fixture.runtime.create(fixture.workspace, ref("initial"));
        fixture.mutations.beforeMutation = (request) => {
            if (request.operation !== "update") return;
            const current = fixture.store.getSlate(slate.id)!;
            fixture.store.compareAndSetSlate(current.revision, current.update(ref("winner")));
        };

        await expect(
            fixture.runtime.update(slate.id, ref("loser"), slate.revision)
        ).rejects.toEqual(
            new AgentCoreError(
                "protocol.revision-conflict",
                `Slate ${slate.id.value} revision or active deployment changed`
            )
        );
        expect(fixture.store.getSlate(slate.id)?.source.equals(ref("winner"))).toBe(true);
        expect(fixture.store.listSlateHistory(slate.id)).toHaveLength(2);
        await expect(fixture.runtime.commit(slate.id, Revision.initial())).rejects.toEqual(
            new AgentCoreError(
                "protocol.revision-conflict",
                `Slate ${slate.id.value} revision or active deployment changed`
            )
        );
    });

    test("rejects cross-Slate previews and stale or cross-Slate rollbacks", async () => {
        const fixture = runtimeFixture("rollback-validation");
        const { slate, publication } = await publishedSlate(fixture);
        const other = await fixture.runtime.create(fixture.workspace, ref("other"));
        const otherVersion = await fixture.runtime.commit(other.id);
        await expect(
            fixture.runtime.linkPreview(
                slate.id,
                sessionCapability("foreign-version", 0, 0),
                new PortExposureId("exposure-foreign-version"),
                otherVersion.id
            )
        ).rejects.toEqual(
            new AgentCoreError(
                "slate.invalid-version",
                "Slate preview version belongs to another Slate"
            )
        );

        const first = await fixture.runtime.deploy(publication.id, "first", "external-7");
        const second = await fixture.runtime.deploy(publication.id, "second", "external-8");
        if (first.outcome !== "succeeded" || second.outcome !== "succeeded") {
            throw new TypeError("Expected successful deployments");
        }
        await expect(fixture.runtime.rollback(other.id, first.deployment.id)).rejects.toEqual(
            new AgentCoreError(
                "operation.invalid-input",
                "Rollback deployment belongs to another Slate"
            )
        );
        await expect(
            fixture.runtime.rollback(slate.id, first.deployment.id, first.deployment.id)
        ).rejects.toEqual(
            new AgentCoreError(
                "protocol.revision-conflict",
                `Slate ${slate.id.value} revision or active deployment changed`
            )
        );
        expect(
            fixture.store.getSlate(slate.id)?.activeDeploymentId?.equals(second.deployment.id)
        ).toBe(true);
    });

    test("rejects unknown reconciliation IDs and malformed mediated results", async () => {
        const fixture = runtimeFixture("malformed-results");
        const { publication } = await publishedSlate(fixture);
        await expect(
            fixture.runtime.reconcileDeployment(new SlateDeploymentId("deployment-unknown"))
        ).rejects.toEqual(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate deployment deployment-unknown is unknown"
            )
        );
        await expect(
            fixture.runtime.reconcileResource(new SlateResourceId("resource-unknown"))
        ).rejects.toEqual(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate resource resource-unknown is unknown"
            )
        );

        fixture.invocations.resultOverride = null;
        await expect(fixture.runtime.deploy(publication.id, "invalid-invocation", "external-9")).rejects.toEqual(
            new AgentCoreError("invocation.invalid", "Slate invocation result is malformed")
        );
        fixture.invocations.resultOverride = {
            outcome: "failed",
            receiptId: new ReceiptId("receipt-invalid-shape"),
            unexpected: true
        };
        await expect(
            fixture.runtime.deploy(publication.id, "invalid-invocation-shape", "external-10")
        ).rejects.toEqual(
            new AgentCoreError("invocation.invalid", "Slate invocation result is malformed")
        );
        fixture.invocations.resultOverride = undefined;
        fixture.provider.deploymentResult = {
            materialization: ref("provider-result"),
            unexpected: true
        };
        await expect(fixture.runtime.deploy(publication.id, "invalid-provider", "external-11")).rejects.toEqual(
            new AgentCoreError(
                "operation.invalid-output",
                "Slate provider deployment result is malformed"
            )
        );
    });

    test("codes missing Slate operation targets", async () => {
        const fixture = runtimeFixture("missing-targets");
        await expect(fixture.runtime.commit(new SlateId("slate-missing"))).rejects.toEqual(
            new AgentCoreError("operation.invalid-input", "Slate slate-missing is unknown")
        );
        await expect(
            fixture.runtime.publish(new SlateVersionId("version-missing"), ref("publication"))
        ).rejects.toEqual(
            new AgentCoreError("slate.invalid-version", "Slate version version-missing is unknown")
        );
        await expect(
            fixture.runtime.deploy(new SlatePublicationId("publication-missing"), "production", "external-missing")
        ).rejects.toEqual(
            new AgentCoreError(
                "slate.unpublished",
                "Slate publication publication-missing is unknown"
            )
        );
        await expect(
            fixture.runtime.materializeResource(
                new SlateDeploymentId("deployment-missing"),
                "database",
                ref("schema")
            )
        ).rejects.toEqual(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate deployment deployment-missing is unknown"
            )
        );
    });

    test("codes colliding runtime allocations as duplicates", async () => {
        const fixture = runtimeFixture("duplicate");
        await fixture.runtime.create(fixture.workspace, ref("first"));
        const colliding = new SlateRuntime(
            fixture.store,
            fixture.provider,
            fixture.mutations,
            fixture.invocations,
            fixture.previews,
            new MemorySlateIdSource("duplicate")
        );

        await expect(colliding.create(fixture.workspace, ref("second"))).rejects.toEqual(
            new AgentCoreError("protocol.duplicate", "Slate duplicate-slate-0 already exists")
        );
    });

    test("[P11-SLATE-SOURCE] preserves content-addressed source and immutable version lineage", async () => {
        expect(() => new MemorySlateIdSource(" ")).toThrow(TypeError);
        const fixture = runtimeFixture("completed-replay");
        const slate = await fixture.runtime.create(fixture.workspace, ref("first"));
        const firstVersion = await fixture.runtime.commit(slate.id);
        await fixture.runtime.update(slate.id, ref("second"));
        const secondVersion = await fixture.runtime.commit(slate.id);
        expect(secondVersion.parentVersionId?.equals(firstVersion.id)).toBe(true);

        const publication = await fixture.runtime.publish(secondVersion.id, ref("publication"));
        const deployed = await fixture.runtime.deploy(publication.id, "production", "external-12");
        if (deployed.outcome !== "succeeded") throw new TypeError("Expected successful deployment");
        const replayedDeployment = await fixture.runtime.reconcileDeployment(
            deployed.deployment.id
        );
        expect(replayedDeployment.outcome).toBe("succeeded");

        const resource = await fixture.runtime.materializeResource(
            deployed.deployment.id,
            "database",
            ref("schema")
        );
        if (resource.outcome !== "succeeded") throw new TypeError("Expected successful resource");
        const replayedResource = await fixture.runtime.reconcileResource(resource.resource.id);
        expect(replayedResource.outcome).toBe("succeeded");

        const fork = await fixture.runtime.fork(secondVersion.id, fixture.workspace);
        await fixture.runtime.commit(fork.id);
        expect(fixture.store.getSlate(fork.id)?.forkedFrom).toEqual(fork.forkedFrom);
    });

    test("retains failed deployment and resource reservations for deterministic replay", async () => {
        const fixture = runtimeFixture("failed-effects");
        const { publication } = await publishedSlate(fixture);
        fixture.invocations.invokeOutcomes.push("failed");
        const failedDeployment = await fixture.runtime.deploy(publication.id, "failed-target", "external-13");
        expect(failedDeployment.outcome).toBe("failed");
        if (failedDeployment.outcome === "succeeded")
            throw new TypeError("Expected failed deployment");
        expect(fixture.store.getDeploymentReservation(failedDeployment.deploymentId)).toBeDefined();
        expect(fixture.store.getDeployment(failedDeployment.deploymentId)).toBeUndefined();

        const deployed = await fixture.runtime.deploy(publication.id, "resource-host", "external-14");
        if (deployed.outcome !== "succeeded") throw new TypeError("Expected successful deployment");
        fixture.invocations.invokeOutcomes.push("failed");
        const failedResource = await fixture.runtime.materializeResource(
            deployed.deployment.id,
            "database",
            ref("schema")
        );
        expect(failedResource.outcome).toBe("failed");
        if (failedResource.outcome === "succeeded") throw new TypeError("Expected failed resource");
        expect(fixture.store.getResourceReservation(failedResource.resourceId)).toBeDefined();
        expect(fixture.store.getResource(failedResource.resourceId)).toBeUndefined();
    });

    test("advances retry ordinal without changing the invocation item key", async () => {
        const fixture = runtimeFixture("retry-ordinal");
        const { publication } = await publishedSlate(fixture);
        fixture.invocations.invokeOutcomes.push("failed");
        const failed = await fixture.runtime.deploy(publication.id, "retry-target", "external-15");
        if (failed.outcome === "succeeded") throw new TypeError("Expected failed deployment");
        const reservation = fixture.store.getDeploymentReservation(failed.deploymentId)!;
        const itemKey = fixture.invocations.itemKey(reservation.invocationId);
        expect(itemKey).toBeDefined();
        expect(fixture.provider.deployRequests).toHaveLength(0);

        const retried = await fixture.runtime.reconcileDeployment(failed.deploymentId);
        expect(retried.outcome).toBe("succeeded");
        const request = fixture.provider.reconcileDeploymentRequests[0]!;
        expect(request.effectContext.invocationId.equals(reservation.invocationId)).toBe(true);
        expect(request.effectContext.itemIndex).toBe(0);
        expect(request.effectContext.attemptOrdinal).toBe(1);
        expect(request.idempotencyKey).toBe(itemKey);
    });

    test("rejects missing, changed-key, and wrong-Invocation effect contexts", async () => {
        const missing = runtimeFixture("missing-context");
        const { publication: missingPublication } = await publishedSlate(missing);
        missing.invocations.nextContextOverride = null;
        await expect(
            missing.runtime.deploy(missingPublication.id, "missing-context", "external-16")
        ).rejects.toEqual(
            new AgentCoreError(
                "invocation.invalid",
                "Slate effect context does not match its Invocation"
            )
        );
        expect(missing.provider.deployRequests).toHaveLength(0);

        const changed = runtimeFixture("changed-context");
        const { publication } = await publishedSlate(changed);
        changed.invocations.invokeOutcomes.push("indeterminate");
        const uncertain = await changed.runtime.deploy(publication.id, "changed-key", "external-17");
        if (uncertain.outcome === "succeeded")
            throw new TypeError("Expected indeterminate deployment");
        const reservation = changed.store.getDeploymentReservation(uncertain.deploymentId)!;
        const initial = changed.provider.deployRequests[0]!.effectContext;
        changed.invocations.nextContextOverride = new SlateEffectContext(
            reservation.invocationId,
            initial.itemIndex,
            initial.attemptOrdinal,
            `${initial.idempotencyKey}:changed`
        );
        await expect(changed.runtime.reconcileDeployment(uncertain.deploymentId)).rejects.toEqual(
            new AgentCoreError(
                "invocation.invalid",
                "Slate effect context changed its invocation item identity"
            )
        );
        expect(changed.provider.reconcileDeploymentRequests).toHaveLength(0);

        changed.invocations.nextContextOverride = new SlateEffectContext(
            new InvocationId("invocation-wrong-context"),
            initial.itemIndex,
            initial.attemptOrdinal,
            initial.idempotencyKey
        );
        await expect(changed.runtime.reconcileDeployment(uncertain.deploymentId)).rejects.toEqual(
            new AgentCoreError(
                "invocation.invalid",
                "Slate effect context does not match its Invocation"
            )
        );
        expect(changed.provider.reconcileDeploymentRequests).toHaveLength(0);
    });

    test("reports every Slate head CAS loser without replacing the concurrent winner", async () => {
        const update = runtimeFixture("cas-update", new RejectingSlateStore());
        const updateSlate = await update.runtime.create(update.workspace, ref("initial"));
        (update.store as RejectingSlateStore).rejectNextCas = true;
        await expect(update.runtime.update(updateSlate.id, ref("loser"))).rejects.toMatchObject({
            code: "protocol.revision-conflict"
        });

        const commit = runtimeFixture("cas-commit", new RejectingSlateStore());
        const commitSlate = await commit.runtime.create(commit.workspace, ref("source"));
        (commit.store as RejectingSlateStore).rejectNextCas = true;
        await expect(commit.runtime.commit(commitSlate.id)).rejects.toMatchObject({
            code: "protocol.revision-conflict"
        });

        const publish = runtimeFixture("cas-publish", new RejectingSlateStore());
        const publishSlate = await publish.runtime.create(publish.workspace, ref("source"));
        const version = await publish.runtime.commit(publishSlate.id);
        (publish.store as RejectingSlateStore).rejectNextCas = true;
        await expect(publish.runtime.publish(version.id, ref("publication"))).rejects.toMatchObject(
            {
                code: "protocol.revision-conflict"
            }
        );

        const rollback = runtimeFixture("cas-rollback", new RejectingSlateStore());
        const { slate, publication } = await publishedSlate(rollback);
        const firstDeployment = await rollback.runtime.deploy(publication.id, "first", "external-18");
        const secondDeployment = await rollback.runtime.deploy(publication.id, "second", "external-19");
        if (firstDeployment.outcome !== "succeeded" || secondDeployment.outcome !== "succeeded") {
            throw new TypeError("Expected deployments");
        }
        (rollback.store as RejectingSlateStore).rejectNextCas = true;
        await expect(
            rollback.runtime.rollback(slate.id, firstDeployment.deployment.id)
        ).rejects.toMatchObject({ code: "protocol.revision-conflict" });
    });

    test("retains effect reservations when deployment and resource providers fail", async () => {
        const deployment = runtimeFixture("provider-deployment-failure");
        const { publication } = await publishedSlate(deployment);
        deployment.provider.throwDeployment = true;
        await expect(deployment.runtime.deploy(publication.id, "production", "external-20")).rejects.toThrow(
            /deployment provider failed/
        );
        expect(deployment.store.snapshot().deploymentReservations).toHaveLength(1);
        expect(deployment.store.snapshot().deployments).toHaveLength(0);

        const resource = runtimeFixture("provider-resource-failure");
        const published = await publishedSlate(resource);
        const deployed = await resource.runtime.deploy(published.publication.id, "production", "external-21");
        if (deployed.outcome !== "succeeded") throw new TypeError("Expected deployment");
        resource.provider.throwResource = true;
        await expect(
            resource.runtime.materializeResource(deployed.deployment.id, "database", ref("schema"))
        ).rejects.toThrow(/resource provider failed/);
        expect(resource.store.snapshot().resourceReservations).toHaveLength(1);
        expect(resource.store.snapshot().resources).toHaveLength(0);
    });

    test("rejects malformed resource output and stale preview persistence", async () => {
        const resource = runtimeFixture("malformed-resource");
        const { publication } = await publishedSlate(resource);
        const deployed = await resource.runtime.deploy(publication.id, "production", "external-22");
        if (deployed.outcome !== "succeeded") throw new TypeError("Expected deployment");
        resource.provider.resourceResult = { materialization: ref("resource"), extra: true };
        await expect(
            resource.runtime.materializeResource(deployed.deployment.id, "database", ref("schema"))
        ).rejects.toMatchObject({ code: "operation.invalid-output" });

        const preview = runtimeFixture("stale-preview");
        const slate = await preview.runtime.create(preview.workspace, ref("preview"));
        preview.mutations.beforeMutation = (request) => {
            if (request.operation !== "preview.link") return;
            const current = preview.store.getSlate(slate.id)!;
            preview.store.compareAndSetSlate(current.revision, current.update(ref("winner")));
        };
        await expect(
            preview.runtime.linkPreview(
                slate.id,
                sessionCapability("stale-preview", 0, 0),
                new PortExposureId("exposure-stale-preview")
            )
        ).rejects.toMatchObject({ code: "protocol.revision-conflict" });
        expect(preview.store.listPreviews(slate.id)).toEqual([]);
    });

    test("rejects colliding fork IDs and all malformed invocation result shapes", async () => {
        const fixture = runtimeFixture("fork-duplicate");
        const { version, publication } = await publishedSlate(fixture);
        await fixture.runtime.create(fixture.workspace, ref("collision"));
        const ids = new MemorySlateIdSource("fork-duplicate");
        ids.allocateSlateId();
        ids.allocateVersionId();
        ids.allocatePublicationId();
        const colliding = new SlateRuntime(
            fixture.store,
            fixture.provider,
            fixture.mutations,
            fixture.invocations,
            fixture.previews,
            ids
        );
        await expect(colliding.fork(version.id, fixture.workspace)).rejects.toMatchObject({
            code: "protocol.duplicate"
        });

        let malformedIndex = 0;
        for (const malformed of [
            { outcome: "succeeded", receiptId: new ReceiptId("receipt-missing-value") },
            {
                outcome: "failed",
                receiptId: new ReceiptId("receipt-failed-value"),
                value: { materialization: ref("unexpected") }
            },
            { outcome: "unknown", receiptId: new ReceiptId("receipt-unknown") },
            { outcome: "failed", receiptId: "not-a-receipt" }
        ]) {
            fixture.invocations.resultOverride = malformed;
            malformedIndex += 1;
            await expect(
                fixture.runtime.deploy(
                    publication.id,
                    "malformed",
                    `external-malformed-${malformedIndex}`
                )
            ).rejects.toMatchObject(
                {
                    code: "invocation.invalid"
                }
            );
        }
    });
});

class RejectingSlateStore extends MemorySlateStore {
    public rejectNextCas = false;

    public override transaction<Result>(operation: (store: SlateStore) => Result): Result {
        return this.rejectNextCas ? operation(this) : super.transaction(operation);
    }

    public override compareAndSetSlate(
        expected: Revision | undefined,
        next: import("../../src/slates").Slate
    ): boolean {
        if (this.rejectNextCas) {
            this.rejectNextCas = false;
            return false;
        }
        return super.compareAndSetSlate(expected, next);
    }
}

class TrackingMutationSeam extends SlateMutationSeam {
    public readonly requests: SlateMutationRequest[] = [];
    public beforeMutation: ((request: SlateMutationRequest) => void) | undefined;

    public async mutate<Result>(
        request: SlateMutationRequest,
        mutation: () => Result
    ): Promise<Result> {
        expect(Object.isFrozen(request)).toBe(true);
        this.requests.push(request);
        this.beforeMutation?.(request);
        return mutation();
    }
}

class TrackingInvocationSeam extends SlateInvocationSeam {
    public readonly prepared: SlateInvocationRequest[] = [];
    public readonly invokeOutcomes: Array<"succeeded" | "failed" | "indeterminate"> = [];
    public validatedRequests = 0;
    public resultOverride: unknown | undefined;
    public nextContextOverride: SlateEffectContext | null | undefined;
    #sequence = 0;
    #inside = 0;
    #activeContext: SlateEffectContext | undefined;
    readonly #requests = new Map<string, SlateInvocationRequest>();
    readonly #itemContexts = new Map<string, SlateEffectContext>();
    readonly #outcomes = new Map<string, "succeeded" | "failed" | "indeterminate">();
    public readonly contexts: SlateEffectContext[] = [];

    public get inside(): boolean {
        return this.#inside > 0;
    }
    public get activeContext(): SlateEffectContext | undefined {
        return this.#activeContext;
    }

    public itemKey(invocationId: InvocationId): string | undefined {
        return this.#itemContexts.get(invocationId.value)?.idempotencyKey;
    }

    public async prepare(request: SlateInvocationRequest): Promise<InvocationId> {
        expect(Object.isFrozen(request)).toBe(true);
        canonicalSlateInvocationRequest(request);
        const id = new InvocationId(`invocation-${this.#sequence++}`);
        this.#requests.set(id.value, request);
        this.prepared.push(request);
        return id;
    }

    public async invoke<Result>(
        request: SlateInvocationRequest,
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>> {
        this.validate(request, invocationId);
        if (this.resultOverride !== undefined) {
            return this.resultOverride as SlateInvocationResult<Result>;
        }
        const outcome = this.invokeOutcomes.shift() ?? "succeeded";
        const result = await this.run(outcome, effect, this.contextFor(invocationId, false));
        this.#outcomes.set(invocationId.value, outcome);
        return result;
    }

    public async reconcile<Result>(
        request: SlateInvocationRequest,
        invocationId: InvocationId,
        effect: (context: SlateEffectContext) => Promise<Result>
    ): Promise<SlateInvocationResult<Result>> {
        this.validate(request, invocationId);
        const result = await this.run(
            "succeeded",
            effect,
            this.contextFor(invocationId, this.#outcomes.get(invocationId.value) === "failed")
        );
        this.#outcomes.set(invocationId.value, "succeeded");
        return result;
    }

    private validate(request: SlateInvocationRequest, invocationId: InvocationId): void {
        const prepared = this.#requests.get(invocationId.value);
        if (prepared === undefined || !sameSlateInvocationRequest(prepared, request)) {
            throw new TypeError("Invocation request changed after preparation");
        }
        this.validatedRequests += 1;
    }

    private async run<Result>(
        outcome: "succeeded" | "failed" | "indeterminate",
        effect: (context: SlateEffectContext) => Promise<Result>,
        context: SlateEffectContext | undefined
    ): Promise<SlateInvocationResult<Result>> {
        const receiptId = new ReceiptId(`receipt-${this.#sequence++}`);
        if (outcome === "failed") return { outcome, receiptId };
        this.#inside += 1;
        this.#activeContext = context;
        if (context !== undefined) this.contexts.push(context);
        try {
            const value = await effect(context as SlateEffectContext);
            return outcome === "succeeded" ? { outcome, receiptId, value } : { outcome, receiptId };
        } finally {
            this.#activeContext = undefined;
            this.#inside -= 1;
        }
    }

    private contextFor(invocationId: InvocationId, retry: boolean): SlateEffectContext | undefined {
        const previous = this.#itemContexts.get(invocationId.value);
        const expected = new SlateEffectContext(
            invocationId,
            previous?.itemIndex ?? 0,
            (previous?.attemptOrdinal ?? 0) + (retry ? 1 : 0),
            previous?.idempotencyKey ?? `slate-item:${invocationId.value}:0`
        );
        const context =
            this.nextContextOverride === undefined
                ? expected
                : (this.nextContextOverride ?? undefined);
        this.nextContextOverride = undefined;
        if (context === undefined) return undefined;
        if (
            context.itemIndex !== expected.itemIndex ||
            context.attemptOrdinal !== expected.attemptOrdinal ||
            context.idempotencyKey !== expected.idempotencyKey
        ) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Slate effect context changed its invocation item identity"
            );
        }
        this.#itemContexts.set(invocationId.value, expected);
        return context;
    }
}

class TrackingPreviewValidation extends SlatePreviewValidationSeam {
    public readonly requests: SlatePreviewLinkIntent[] = [];
    public denial: AgentCoreError | undefined;

    public async validate(request: SlatePreviewLinkIntent): Promise<void> {
        expect(Object.isFrozen(request)).toBe(true);
        this.requests.push(request);
        if (this.denial !== undefined) throw this.denial;
    }
}

class TrackingProvider extends SlateProvider {
    public readonly deployRequests: SlateProviderDeploymentRequest[] = [];
    public readonly reconcileDeploymentRequests: SlateProviderDeploymentRequest[] = [];
    public readonly resourceRequests: SlateProviderResourceRequest[] = [];
    public readonly reconcileResourceRequests: SlateProviderResourceRequest[] = [];
    public readonly pendingDeployments = new Map<string, Deferred<SlateProviderDeployment>>();
    public deploymentResult: unknown | undefined;
    public resourceResult: unknown | undefined;
    public throwDeployment = false;
    public throwResource = false;
    readonly #called = new Map<string, Deferred<void>>();

    public constructor(private readonly invocations: TrackingInvocationSeam) {
        super();
    }

    public get totalCalls(): number {
        return (
            this.deployRequests.length +
            this.reconcileDeploymentRequests.length +
            this.resourceRequests.length +
            this.reconcileResourceRequests.length
        );
    }

    public async deploy(request: SlateProviderDeploymentRequest): Promise<SlateProviderDeployment> {
        this.requireMediated(request);
        this.deployRequests.push(request);
        this.signal(request.target);
        if (this.throwDeployment) throw new TypeError("deployment provider failed");
        if (this.deploymentResult !== undefined)
            return this.deploymentResult as SlateProviderDeployment;
        return (
            this.pendingDeployments.get(request.target)?.promise ?? {
                materialization: ref(`deployment-${request.deploymentId.value}`)
            }
        );
    }

    public async reconcileDeployment(
        request: SlateProviderDeploymentRequest
    ): Promise<SlateProviderDeployment> {
        this.requireMediated(request);
        this.reconcileDeploymentRequests.push(request);
        return { materialization: ref(`reconciled-${request.deploymentId.value}`) };
    }

    public async materializeResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource> {
        this.requireMediated(request);
        this.resourceRequests.push(request);
        if (this.throwResource) throw new TypeError("resource provider failed");
        if (this.resourceResult !== undefined) return this.resourceResult as SlateProviderResource;
        return { materialization: ref(`resource-${request.resourceId.value}`) };
    }

    public async reconcileResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource> {
        this.requireMediated(request);
        this.reconcileResourceRequests.push(request);
        return { materialization: ref(`reconciled-${request.resourceId.value}`) };
    }

    public called(target: string): Promise<void> {
        let called = this.#called.get(target);
        if (called === undefined) {
            called = deferred<void>();
            this.#called.set(target, called);
        }
        return called.promise;
    }

    private signal(target: string): void {
        let called = this.#called.get(target);
        if (called === undefined) {
            called = deferred<void>();
            this.#called.set(target, called);
        }
        called.resolve();
    }

    private requireMediated(request: object): void {
        expect(Object.isFrozen(request)).toBe(true);
        const context = this.invocations.activeContext;
        if (!this.invocations.inside || context === undefined) {
            throw new TypeError("Provider effect bypassed invocation context");
        }
        const effectRequest = request as {
            readonly invocationId: InvocationId;
            readonly effectContext: SlateEffectContext;
            readonly idempotencyKey: string;
        };
        expect(effectRequest.effectContext).toBe(context);
        expect(effectRequest.invocationId.equals(context.invocationId)).toBe(true);
        expect(effectRequest.idempotencyKey).toBe(context.idempotencyKey);
    }
}

interface RuntimeFixture {
    readonly workspace: WorkspaceId;
    readonly store: MemorySlateStore;
    readonly mutations: TrackingMutationSeam;
    readonly invocations: TrackingInvocationSeam;
    readonly previews: TrackingPreviewValidation;
    readonly provider: TrackingProvider;
    readonly runtime: SlateRuntime;
}

function runtimeFixture(
    label: string,
    store: MemorySlateStore = new MemorySlateStore()
): RuntimeFixture {
    const mutations = new TrackingMutationSeam();
    const invocations = new TrackingInvocationSeam();
    const previews = new TrackingPreviewValidation();
    const provider = new TrackingProvider(invocations);
    return {
        workspace: new WorkspaceId(`workspace-${label}`),
        store,
        mutations,
        invocations,
        previews,
        provider,
        runtime: new SlateRuntime(
            store,
            provider,
            mutations,
            invocations,
            previews,
            new MemorySlateIdSource(label)
        )
    };
}

async function publishedSlate(fixture: RuntimeFixture) {
    const slate = await fixture.runtime.create(fixture.workspace, ref("source"));
    const version = await fixture.runtime.commit(slate.id);
    const publication = await fixture.runtime.publish(version.id, ref("publication"));
    return { slate, version, publication };
}

function sessionCapability(label: string, revision: number, epoch: number) {
    return new EnvironmentSessionCapability(
        new EnvironmentId(`environment-${label}`),
        new EnvironmentSessionId(`session-${label}`),
        new Revision(revision),
        epoch
    );
}

interface Deferred<Value> {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

function ref(label: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(label)));
}

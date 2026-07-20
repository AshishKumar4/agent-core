import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
    ContentRef,
    Digest,
    InvocationId,
    TenantId,
    WorkspaceId,
    decodeCanonicalJson
} from "@agent-core/core";
import {
    SlateDeploymentId,
    SlateEffectContext,
    SlateId,
    SlatePublicationId,
    SlateResourceId,
    type SlateProviderDeploymentRequest,
    type SlateProviderResourceRequest
} from "@agent-core/core/slate-provider";
import { R2ContentObjectRepository, type CloudflareErrorPort } from "../../src/index.js";
import { SLATE_PROVIDER_TENANT } from "./worker.js";

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new Error(`${code}: ${message}`);
    }
};

const publicationMaterialization = ContentRef.fromDigest(Digest.sha256(new Uint8Array([1])));

function deploymentRequest(
    deployment: string,
    init: { readonly target?: string } = {}
): SlateProviderDeploymentRequest {
    const invocationId = new InvocationId(`inv-${deployment}`);
    const idempotencyKey = `deploy-${deployment}`;
    return Object.freeze({
        operation: "deploy",
        impact: "externalSend",
        workspaceId: new WorkspaceId("ws-1"),
        slateId: new SlateId("slate-1"),
        deploymentId: new SlateDeploymentId(deployment),
        publicationId: new SlatePublicationId("pub-1"),
        publicationMaterialization,
        target: init.target ?? "production",
        expectedActiveDeploymentId: undefined,
        invocationId,
        effectContext: new SlateEffectContext(invocationId, 0, 0, idempotencyKey),
        idempotencyKey
    });
}

function resourceRequest(resource: string, deployment: string): SlateProviderResourceRequest {
    const invocationId = new InvocationId(`inv-${resource}`);
    const idempotencyKey = `resource-${resource}`;
    return Object.freeze({
        operation: "resource.materialize",
        impact: "externalSend",
        workspaceId: new WorkspaceId("ws-1"),
        slateId: new SlateId("slate-1"),
        resourceId: new SlateResourceId(resource),
        deploymentId: new SlateDeploymentId(deployment),
        deploymentMaterialization: publicationMaterialization,
        resourceName: "database",
        resourceSource: ContentRef.fromDigest(Digest.sha256(new Uint8Array([2]))),
        invocationId,
        effectContext: new SlateEffectContext(invocationId, 0, 0, idempotencyKey),
        idempotencyKey
    });
}

describe("Cloudflare slate provider", () => {
    it("deploys once and replays the recorded materialization across Durable Object eviction", async () => {
        const stub = env.SLATES.getByName("deploy-durability");
        const request = deploymentRequest("dep-durable");

        const first = await runInDurableObject(stub, async (instance) =>
            instance.slates.deploy(request)
        );

        const manifest = await new R2ContentObjectRepository(env.CONTENT, errors).get(
            new TenantId(SLATE_PROVIDER_TENANT),
            first.materialization.digest.value
        );
        if (manifest === undefined) throw new TypeError("Expected a stored deployment manifest");
        expect(decodeCanonicalJson(manifest.bytes)).toMatchObject({
            deploymentId: "dep-durable",
            format: "agent-core-slate-deployment/1",
            target: "production"
        });

        await evictDurableObject(stub);

        const replayed = await runInDurableObject(stub, async (instance) =>
            instance.slates.reconcileDeployment(request)
        );
        expect(replayed.materialization.equals(first.materialization)).toBe(true);
    });

    it("rejects a reused deployment identity across eviction", async () => {
        const stub = env.SLATES.getByName("deploy-identity");
        await runInDurableObject(stub, async (instance) =>
            instance.slates.deploy(deploymentRequest("dep-1"))
        );

        await evictDurableObject(stub);

        await runInDurableObject(stub, async (instance) => {
            await expect(
                instance.slates.deploy(deploymentRequest("dep-1", { target: "staging" }))
            ).rejects.toThrowError(/different effect identity/u);
        });
    });

    it("materializes a resource once and replays it across eviction", async () => {
        const stub = env.SLATES.getByName("resource-durability");
        const deployment = deploymentRequest("dep-res");
        const request = resourceRequest("res-durable", "dep-res");

        const first = await runInDurableObject(stub, async (instance) => {
            await instance.slates.deploy(deployment);
            return instance.slates.materializeResource(request);
        });

        await evictDurableObject(stub);

        const replayed = await runInDurableObject(stub, async (instance) =>
            instance.slates.reconcileResource(request)
        );
        expect(replayed.materialization.equals(first.materialization)).toBe(true);
    });
});

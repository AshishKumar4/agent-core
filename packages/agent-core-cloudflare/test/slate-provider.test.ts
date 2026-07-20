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
import { describe, expect, test } from "vitest";
import {
    DurableObjectSlateProvider,
    R2ContentObjectRepository,
    SqliteApplicationMigrator,
    slateProviderMigration
} from "../src/index.js";
import { expectOperationalFailure } from "./assertions.js";
import { FakeR2Bucket, fakeErrors } from "./fakes.js";
import { NodeSqlite } from "./node-sqlite.js";

const tenant = new TenantId("slate-tests");
const publicationMaterialization = ContentRef.fromDigest(Digest.sha256(new Uint8Array([1])));
const resourceSource = ContentRef.fromDigest(Digest.sha256(new Uint8Array([2])));

function deploymentRequest(
    deployment: string,
    init: {
        readonly invocation?: string;
        readonly idempotencyKey?: string;
        readonly target?: string;
        readonly expectedActiveDeploymentId?: SlateDeploymentId;
        readonly attemptOrdinal?: number;
    } = {}
): SlateProviderDeploymentRequest {
    const invocationId = new InvocationId(init.invocation ?? "inv-1");
    const idempotencyKey = init.idempotencyKey ?? `deploy-${deployment}`;
    return Object.freeze({
        operation: "deploy",
        impact: "externalSend",
        workspaceId: new WorkspaceId("ws-1"),
        slateId: new SlateId("slate-1"),
        deploymentId: new SlateDeploymentId(deployment),
        publicationId: new SlatePublicationId("pub-1"),
        publicationMaterialization,
        target: init.target ?? "production",
        expectedActiveDeploymentId: init.expectedActiveDeploymentId,
        invocationId,
        effectContext: new SlateEffectContext(
            invocationId,
            0,
            init.attemptOrdinal ?? 0,
            idempotencyKey
        ),
        idempotencyKey
    });
}

function resourceRequest(
    resource: string,
    init: {
        readonly invocation?: string;
        readonly idempotencyKey?: string;
        readonly resourceName?: string;
        readonly attemptOrdinal?: number;
    } = {}
): SlateProviderResourceRequest {
    const invocationId = new InvocationId(init.invocation ?? "inv-2");
    const idempotencyKey = init.idempotencyKey ?? `resource-${resource}`;
    return Object.freeze({
        operation: "resource.materialize",
        impact: "externalSend",
        workspaceId: new WorkspaceId("ws-1"),
        slateId: new SlateId("slate-1"),
        resourceId: new SlateResourceId(resource),
        deploymentId: new SlateDeploymentId("dep-1"),
        deploymentMaterialization: publicationMaterialization,
        resourceName: init.resourceName ?? "database",
        resourceSource,
        invocationId,
        effectContext: new SlateEffectContext(
            invocationId,
            0,
            init.attemptOrdinal ?? 0,
            idempotencyKey
        ),
        idempotencyKey
    });
}

function createProvider(bucket: FakeR2Bucket = new FakeR2Bucket()): {
    readonly provider: DurableObjectSlateProvider;
    readonly bucket: FakeR2Bucket;
    readonly sqlite: NodeSqlite;
    readonly repository: R2ContentObjectRepository;
} {
    const sqlite = new NodeSqlite();
    new SqliteApplicationMigrator(sqlite, fakeErrors, [slateProviderMigration(1)]).migrate();
    const repository = new R2ContentObjectRepository(bucket, fakeErrors);
    const provider = new DurableObjectSlateProvider(sqlite, repository, tenant, fakeErrors);
    return { provider, bucket, sqlite, repository };
}

describe("DurableObjectSlateProvider", () => {
    test("deploys once and settles every replay to the exact recorded materialization", async () => {
        const { provider, bucket, repository } = createProvider();
        const request = deploymentRequest("dep-1");

        const first = await provider.deploy(request);
        const stored = await repository.get(tenant, first.materialization.digest.value);
        if (stored === undefined) throw new TypeError("Expected a stored deployment manifest");
        expect(decodeCanonicalJson(stored.bytes)).toEqual({
            deploymentId: "dep-1",
            format: "agent-core-slate-deployment/1",
            publicationId: "pub-1",
            publicationMaterialization: publicationMaterialization.value,
            slateId: "slate-1",
            target: "production",
            workspaceId: "ws-1"
        });

        const writesAfterFirst = bucket.putCalls.length;
        expect(await provider.deploy(request)).toEqual(first);
        expect(await provider.deploy(deploymentRequest("dep-1", { attemptOrdinal: 3 }))).toEqual(
            first
        );
        expect(await provider.reconcileDeployment(request)).toEqual(first);
        expect(bucket.putCalls.length).toBe(writesAfterFirst);
    });

    test("performs the deployment during reconciliation when no record exists", async () => {
        const { provider } = createProvider();
        const request = deploymentRequest("dep-1");
        const reconciled = await provider.reconcileDeployment(request);
        expect(await provider.deploy(request)).toEqual(reconciled);
    });

    test("rejects a deployment identity reused for a different request", async () => {
        const { provider } = createProvider();
        await provider.deploy(deploymentRequest("dep-1"));
        for (const conflicting of [
            deploymentRequest("dep-1", { target: "staging" }),
            deploymentRequest("dep-1", { invocation: "inv-other" }),
            deploymentRequest("dep-1", { idempotencyKey: "other-key" }),
            deploymentRequest("dep-1", {
                expectedActiveDeploymentId: new SlateDeploymentId("dep-0")
            })
        ]) {
            await expect(provider.deploy(conflicting)).rejects.toMatchObject({
                code: "protocol.invalid-state"
            });
            await expect(provider.reconcileDeployment(conflicting)).rejects.toMatchObject({
                code: "protocol.invalid-state"
            });
        }
    });

    test("materializes a resource once and replays it identically", async () => {
        const { provider, bucket, repository } = createProvider();
        const request = resourceRequest("res-1");

        const first = await provider.materializeResource(request);
        const stored = await repository.get(tenant, first.materialization.digest.value);
        if (stored === undefined) throw new TypeError("Expected a stored resource manifest");
        expect(decodeCanonicalJson(stored.bytes)).toEqual({
            deploymentId: "dep-1",
            deploymentMaterialization: publicationMaterialization.value,
            format: "agent-core-slate-resource/1",
            resourceId: "res-1",
            resourceName: "database",
            resourceSource: resourceSource.value,
            slateId: "slate-1",
            workspaceId: "ws-1"
        });

        const writesAfterFirst = bucket.putCalls.length;
        expect(await provider.materializeResource(request)).toEqual(first);
        expect(await provider.reconcileResource(request)).toEqual(first);
        expect(
            await provider.reconcileResource(resourceRequest("res-1", { attemptOrdinal: 2 }))
        ).toEqual(first);
        expect(bucket.putCalls.length).toBe(writesAfterFirst);
    });

    test("rejects a resource identity reused for a different request", async () => {
        const { provider } = createProvider();
        await provider.materializeResource(resourceRequest("res-1"));
        for (const conflicting of [
            resourceRequest("res-1", { resourceName: "queue" }),
            resourceRequest("res-1", { invocation: "inv-other" }),
            resourceRequest("res-1", { idempotencyKey: "other-key" })
        ]) {
            await expect(provider.materializeResource(conflicting)).rejects.toMatchObject({
                code: "protocol.invalid-state"
            });
            await expect(provider.reconcileResource(conflicting)).rejects.toMatchObject({
                code: "protocol.invalid-state"
            });
        }
    });

    test("replays a deployment that raced its own record during the R2 write", async () => {
        const bucket = new GatedPutR2Bucket();
        const { provider, sqlite } = createProvider(bucket);
        const request = deploymentRequest("dep-1");
        const recorded = ContentRef.fromDigest(Digest.sha256(new Uint8Array([42])));

        const pending = provider.deploy(request);
        await bucket.started;
        sqlite.run(
            `INSERT INTO agent_core_slate_deployments
                (deployment_id, invocation_id, idempotency_key, workspace_id, slate_id, publication_id,
                    publication_materialization, target, expected_active_deployment_id, materialization)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                "dep-1",
                request.invocationId.value,
                request.idempotencyKey,
                "ws-1",
                "slate-1",
                "pub-1",
                publicationMaterialization.value,
                "production",
                null,
                recorded.value
            ]
        );
        bucket.release();
        expect(await pending).toEqual({ materialization: recorded });
    });

    test("validates its construction tenant and every request boundary", async () => {
        const { provider, sqlite, repository } = createProvider();
        expectOperationalFailure(
            () =>
                Reflect.construct(DurableObjectSlateProvider, [
                    sqlite,
                    repository,
                    "slate-tests",
                    fakeErrors
                ]),
            "operation.invalid-input"
        );

        const call = (request: unknown): Promise<unknown> =>
            Reflect.apply(provider.deploy, provider, [request]);
        const valid = deploymentRequest("dep-1");
        await expect(call({ ...valid, operation: "publish" })).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(call({ ...valid, deploymentId: "dep-1" })).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(call({ ...valid, publicationId: "pub-1" })).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(
            call({ ...valid, publicationMaterialization: publicationMaterialization.value })
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(
            call({ ...valid, expectedActiveDeploymentId: "dep-0" })
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(call({ ...valid, target: "  padded" })).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(call({ ...valid, workspaceId: "ws-1" })).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(call({ ...valid, slateId: "slate-1" })).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(call({ ...valid, invocationId: "inv-1" })).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(
            call({ ...valid, invocationId: new InvocationId("inv-unbound") })
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(call({ ...valid, idempotencyKey: "other-key" })).rejects.toMatchObject({
            code: "operation.invalid-input"
        });

        const callResource = (request: unknown): Promise<unknown> =>
            Reflect.apply(provider.materializeResource, provider, [request]);
        const validResource = resourceRequest("res-1");
        await expect(callResource({ ...validResource, operation: "deploy" })).rejects.toMatchObject(
            { code: "operation.invalid-input" }
        );
        await expect(
            callResource({ ...validResource, resourceId: "res-1" })
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(
            callResource({ ...validResource, deploymentMaterialization: "ref" })
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(
            callResource({ ...validResource, resourceSource: resourceSource.value })
        ).rejects.toMatchObject({ code: "operation.invalid-input" });
        await expect(callResource({ ...validResource, resourceName: "" })).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
    });

    test("fails closed when a stored record decodes to a corrupt shape", async () => {
        const arm = (
            match: string,
            rows: readonly Record<string, string | number | Uint8Array | null>[]
        ): { readonly provider: DurableObjectSlateProvider; trigger: () => void } => {
            let armed = false;
            const sqlite = new (class extends NodeSqlite {
                public override all(
                    statement: string,
                    bindings: readonly (string | number | Uint8Array | null)[]
                ): readonly Record<string, string | number | Uint8Array | null>[] {
                    if (armed && statement.includes(match)) return rows;
                    return super.all(statement, bindings);
                }
            })();
            new SqliteApplicationMigrator(sqlite, fakeErrors, [slateProviderMigration(1)]).migrate();
            const provider = new DurableObjectSlateProvider(
                sqlite,
                new R2ContentObjectRepository(new FakeR2Bucket(), fakeErrors),
                tenant,
                fakeErrors
            );
            return {
                provider,
                trigger: () => {
                    armed = true;
                }
            };
        };

        const deployment = arm("FROM agent_core_slate_deployments", [
            { invocation_id: 1, idempotency_key: "k", workspace_id: "ws-1", slate_id: "slate-1", publication_id: "pub-1", publication_materialization: "ref", target: "production", expected_active_deployment_id: null, materialization: "ref" }
        ]);
        deployment.trigger();
        await expect(deployment.provider.deploy(deploymentRequest("dep-1"))).rejects.toMatchObject({
            code: "codec.invalid"
        });

        const resource = arm("FROM agent_core_slate_resources", [
            { invocation_id: "inv-2", idempotency_key: "k", workspace_id: "ws-1", slate_id: "slate-1", deployment_id: "dep-1", deployment_materialization: "ref", resource_name: "database", resource_source: "ref", materialization: 7 }
        ]);
        resource.trigger();
        await expect(
            resource.provider.materializeResource(resourceRequest("res-1"))
        ).rejects.toMatchObject({ code: "codec.invalid" });
    });
});

class GatedPutR2Bucket extends FakeR2Bucket {
    readonly #started = deferred();
    readonly #release = deferred();

    public get started(): Promise<void> {
        return this.#started.promise;
    }

    public release(): void {
        this.#release.resolve();
    }

    public override async put(
        key: string,
        value: ArrayBuffer | ArrayBufferView,
        options: Parameters<FakeR2Bucket["put"]>[2]
    ): Promise<Awaited<ReturnType<FakeR2Bucket["put"]>>> {
        this.#started.resolve();
        await this.#release.promise;
        return super.put(key, value, options);
    }
}

function deferred(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
} {
    let settle: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        settle = resolve;
    });
    return {
        promise,
        resolve(): void {
            if (settle === undefined) throw new TypeError("Deferred promise is unavailable");
            settle();
        }
    };
}

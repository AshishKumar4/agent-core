import {
    AgentCoreError,
    ContentRef,
    Digest,
    InvocationId,
    Revision,
    TenantId,
    WorkspaceId,
    type JsonValue
} from "@agent-core/core";
import {
    EnvironmentId,
    EnvironmentSessionId,
    EnvironmentSnapshotId,
    PortExposureId,
    ProviderDescriptor,
    ProviderId,
    type ExposePortRequest,
    type OpenSessionRequest,
    type SnapshotEnvironmentRequest
} from "@agent-core/core/environment-provider";
import {
    SlateDeploymentId,
    SlateEffectContext,
    SlateId,
    SlatePublicationId,
    SlateResourceId,
    type SlateProviderDeploymentRequest,
    type SlateProviderResourceRequest
} from "@agent-core/core/slate-provider";
import { DurableObject } from "cloudflare:workers";
import {
    CloudflareSqlite,
    DurableObjectEnvironmentProvider,
    DurableObjectSlateProvider,
    R2ContentObjectRepository,
    SqliteApplicationMigrator,
    environmentProviderMigration,
    slateProviderMigration,
    type CloudflareErrorPort
} from "../src/index.js";

interface LiveEnvironment {
    readonly CONTENT: R2Bucket;
    readonly ENVIRONMENTS: DurableObjectNamespace<LiveEnvironmentHarness>;
    readonly SLATES: DurableObjectNamespace<LiveSlateHarness>;
    readonly GIT_COMMIT?: string;
}

const LIVE_TENANT = "agent-core-live-evidence";
const PREVIEW_HOST = "preview.agent-core-live.test";

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

const providerDescriptor = new ProviderDescriptor(
    new ProviderId("cloudflare-do-live"),
    "1",
    ContentRef.fromDigest(Digest.sha256(new Uint8Array([0])))
);

function field(body: Record<string, JsonValue>, key: string): string {
    const value = body[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new AgentCoreError("operation.invalid-input", `Live request needs string ${key}`);
    }
    return value;
}

function numberField(body: Record<string, JsonValue>, key: string): number {
    const value = body[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new AgentCoreError("operation.invalid-input", `Live request needs number ${key}`);
    }
    return value;
}

function sessionRequest(body: Record<string, JsonValue>): OpenSessionRequest {
    return Object.freeze({
        environmentId: new EnvironmentId(field(body, "environmentId")),
        environmentRevision: new Revision(numberField(body, "environmentRevision")),
        generation: numberField(body, "generation"),
        sessionId: new EnvironmentSessionId(field(body, "sessionId")),
        ...(typeof body["restore"] === "string"
            ? { restore: new ContentRef(body["restore"]) }
            : {})
    });
}

function snapshotRequest(body: Record<string, JsonValue>): SnapshotEnvironmentRequest {
    return Object.freeze({
        environmentId: new EnvironmentId(field(body, "environmentId")),
        environmentRevision: new Revision(numberField(body, "environmentRevision")),
        generation: numberField(body, "generation"),
        sessionId: new EnvironmentSessionId(field(body, "sessionId")),
        sessionEpoch: numberField(body, "sessionEpoch"),
        snapshotId: new EnvironmentSnapshotId(field(body, "snapshotId"))
    });
}

function exposureRequest(body: Record<string, JsonValue>): ExposePortRequest {
    return Object.freeze({
        environmentId: new EnvironmentId(field(body, "environmentId")),
        environmentRevision: new Revision(numberField(body, "environmentRevision")),
        generation: numberField(body, "generation"),
        sessionId: new EnvironmentSessionId(field(body, "sessionId")),
        sessionEpoch: numberField(body, "sessionEpoch"),
        exposureId: new PortExposureId(field(body, "exposureId")),
        port: numberField(body, "port")
    });
}

function deploymentRequest(body: Record<string, JsonValue>): SlateProviderDeploymentRequest {
    const invocationId = new InvocationId(field(body, "invocationId"));
    const idempotencyKey = field(body, "idempotencyKey");
    const expected = body["expectedActiveDeploymentId"];
    return Object.freeze({
        operation: "deploy",
        impact: "externalSend",
        workspaceId: new WorkspaceId(field(body, "workspaceId")),
        slateId: new SlateId(field(body, "slateId")),
        deploymentId: new SlateDeploymentId(field(body, "deploymentId")),
        publicationId: new SlatePublicationId(field(body, "publicationId")),
        publicationMaterialization: new ContentRef(field(body, "publicationMaterialization")),
        target: field(body, "target"),
        expectedActiveDeploymentId:
            typeof expected === "string" ? new SlateDeploymentId(expected) : undefined,
        invocationId,
        effectContext: new SlateEffectContext(
            invocationId,
            numberField(body, "itemIndex"),
            numberField(body, "attemptOrdinal"),
            idempotencyKey
        ),
        idempotencyKey
    });
}

function resourceRequest(body: Record<string, JsonValue>): SlateProviderResourceRequest {
    const invocationId = new InvocationId(field(body, "invocationId"));
    const idempotencyKey = field(body, "idempotencyKey");
    return Object.freeze({
        operation: "resource.materialize",
        impact: "externalSend",
        workspaceId: new WorkspaceId(field(body, "workspaceId")),
        slateId: new SlateId(field(body, "slateId")),
        resourceId: new SlateResourceId(field(body, "resourceId")),
        deploymentId: new SlateDeploymentId(field(body, "deploymentId")),
        deploymentMaterialization: new ContentRef(field(body, "deploymentMaterialization")),
        resourceName: field(body, "resourceName"),
        resourceSource: new ContentRef(field(body, "resourceSource")),
        invocationId,
        effectContext: new SlateEffectContext(
            invocationId,
            numberField(body, "itemIndex"),
            numberField(body, "attemptOrdinal"),
            idempotencyKey
        ),
        idempotencyKey
    });
}

async function handle(operation: () => Promise<JsonValue>): Promise<Response> {
    try {
        return Response.json({ ok: true, result: await operation() });
    } catch (error) {
        if (error instanceof AgentCoreError) {
            return Response.json({ ok: false, code: error.code, message: error.message }, {
                status: 409
            });
        }
        throw error;
    }
}

export class LiveEnvironmentHarness extends DurableObject<LiveEnvironment> {
    readonly #environments: DurableObjectEnvironmentProvider;

    public constructor(state: DurableObjectState, environment: LiveEnvironment) {
        super(state, environment);
        const sqlite = new CloudflareSqlite(state.storage, errors);
        new SqliteApplicationMigrator(sqlite, errors, [environmentProviderMigration(1)]).migrate();
        this.#environments = new DurableObjectEnvironmentProvider(
            providerDescriptor,
            sqlite,
            new R2ContentObjectRepository(this.env.CONTENT, errors),
            new TenantId(LIVE_TENANT),
            { previewHost: PREVIEW_HOST },
            errors
        );
    }

    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const body =
            request.method === "POST"
                ? ((await request.json()) as Record<string, JsonValue>)
                : {};
        switch (url.pathname) {
            case "/abort":
                // Genuine instance kill: state persisted in Durable Object storage must
                // survive; everything held in memory must not.
                this.ctx.abort();
                return new Response(null, { status: 204 });
            case "/open":
                return handle(async () => outcome(await this.#environments.openSession(sessionRequest(body))));
            case "/inspect":
                return handle(async () => outcome(await this.#environments.inspectSession(sessionRequest(body))));
            case "/close":
                return handle(async () => outcome(await this.#environments.closeSession(sessionRequest(body))));
            case "/write-file": {
                const content = Uint8Array.from(atob(field(body, "contentBase64")), (c) =>
                    c.charCodeAt(0)
                );
                return handle(async () => {
                    this.#environments.writeSessionFile(
                        sessionRequest(body),
                        field(body, "path"),
                        content
                    );
                    return null;
                });
            }
            case "/read-file":
                return handle(async () => {
                    const content = this.#environments.readSessionFile(
                        sessionRequest(body),
                        field(body, "path")
                    );
                    return content === undefined ? null : btoa(String.fromCharCode(...content));
                });
            case "/snapshot":
                return handle(async () => outcome(await this.#environments.createSnapshot(snapshotRequest(body))));
            case "/inspect-snapshot":
                return handle(async () => outcome(await this.#environments.inspectSnapshot(snapshotRequest(body))));
            case "/expose":
                return handle(async () => outcome(await this.#environments.exposePort(exposureRequest(body))));
            case "/inspect-exposure":
                return handle(async () => outcome(await this.#environments.inspectExposure(exposureRequest(body))));
            case "/revoke":
                return handle(async () => outcome(await this.#environments.revokeExposure(exposureRequest(body))));
            default:
                return new Response("not found", { status: 404 });
        }
    }
}

export class LiveSlateHarness extends DurableObject<LiveEnvironment> {
    readonly #slates: DurableObjectSlateProvider;

    public constructor(state: DurableObjectState, environment: LiveEnvironment) {
        super(state, environment);
        const sqlite = new CloudflareSqlite(state.storage, errors);
        new SqliteApplicationMigrator(sqlite, errors, [slateProviderMigration(1)]).migrate();
        this.#slates = new DurableObjectSlateProvider(
            sqlite,
            new R2ContentObjectRepository(this.env.CONTENT, errors),
            new TenantId(LIVE_TENANT),
            errors
        );
    }

    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const body =
            request.method === "POST"
                ? ((await request.json()) as Record<string, JsonValue>)
                : {};
        switch (url.pathname) {
            case "/abort":
                this.ctx.abort();
                return new Response(null, { status: 204 });
            case "/deploy":
                return handle(async () => {
                    const deployed = await this.#slates.deploy(deploymentRequest(body));
                    return { materialization: deployed.materialization.value };
                });
            case "/reconcile-deploy":
                return handle(async () => {
                    const settled = await this.#slates.reconcileDeployment(deploymentRequest(body));
                    return { materialization: settled.materialization.value };
                });
            case "/materialize-resource":
                return handle(async () => {
                    const materialized = await this.#slates.materializeResource(resourceRequest(body));
                    return { materialization: materialized.materialization.value };
                });
            case "/reconcile-resource":
                return handle(async () => {
                    const settled = await this.#slates.reconcileResource(resourceRequest(body));
                    return { materialization: settled.materialization.value };
                });
            default:
                return new Response("not found", { status: 404 });
        }
    }
}

function outcome(value: {
    readonly name: string;
    readonly value?: unknown;
}): JsonValue {
    if (!("value" in value) || value.value === undefined) return { name: value.name };
    const inner = value.value;
    if (inner instanceof ContentRef) return { name: value.name, value: inner.value };
    if (typeof inner === "string") return { name: value.name, value: inner };
    // LiveEnvironmentSession handles carry no serializable payload.
    return { name: value.name };
}

export default {
    async fetch(request: Request, environment: LiveEnvironment): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/meta") {
            return Response.json({
                commit: environment.GIT_COMMIT ?? null,
                tenant: LIVE_TENANT,
                previewHost: PREVIEW_HOST
            });
        }
        const [, lane, instance, ...rest] = url.pathname.split("/");
        if ((lane === "env" || lane === "slate") && instance !== undefined && rest.length > 0) {
            const namespace = lane === "env" ? environment.ENVIRONMENTS : environment.SLATES;
            const stub = namespace.getByName(instance);
            const forwarded = new URL(request.url);
            forwarded.pathname = `/${rest.join("/")}`;
            return stub.fetch(new Request(forwarded, request));
        }
        return new Response("not found", { status: 404 });
    }
};

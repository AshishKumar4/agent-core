import {
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
import { encodeBase64 } from "../src/base64.js";
import {
    AtLeastOnceQueueAdapter,
    CloudflareSqlite,
    DurableObjectEnvironmentProvider,
    DurableObjectSlateProvider,
    R2ContentObjectRepository,
    SqliteApplicationMigrator,
    environmentProviderMigration,
    slateProviderMigration,
    type QueueDeliveryCodecs,
    type QueueTargetResult
} from "../src/index.js";
import {
    errors,
    field,
    flagField,
    handle,
    numberField,
    readBody,
    type LiveBody
} from "./protocol.js";
import { LiveRuntimeHarness, type LiveRuntimeEnvironment } from "./runtime-harness.js";

export { LiveRuntimeHarness };

interface LiveEnvironment extends LiveRuntimeEnvironment {
    readonly CONTENT: R2Bucket;
    readonly ENVIRONMENTS: DurableObjectNamespace<LiveEnvironmentHarness>;
    readonly SLATES: DurableObjectNamespace<LiveSlateHarness>;
    readonly RUNTIME: DurableObjectNamespace<LiveRuntimeHarness>;
    readonly DELIVERIES: Queue<LiveQueueBody>;
}

const LIVE_TENANT = "agent-core-live-evidence";
const PREVIEW_HOST = "preview.agent-core-live.test";
/** Must match `queues.consumers[].dead_letter_queue` in live/wrangler.live.jsonc. */
const POISON_QUEUE = "agent-core-live-evidence-poison";

const providerDescriptor = new ProviderDescriptor(
    new ProviderId("cloudflare-do-live"),
    "1",
    ContentRef.fromDigest(Digest.sha256(new Uint8Array([0])))
);

function sessionRequest(body: Record<string, JsonValue>): OpenSessionRequest {
    return Object.freeze({
        environmentId: new EnvironmentId(field(body, "environmentId")),
        environmentRevision: new Revision(numberField(body, "environmentRevision")),
        generation: numberField(body, "generation"),
        sessionId: new EnvironmentSessionId(field(body, "sessionId")),
        ...(typeof body["restore"] === "string" ? { restore: new ContentRef(body["restore"]) } : {})
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
        const body = await readBody(request);
        switch (url.pathname) {
            case "/abort":
                // Genuine instance kill: state persisted in Durable Object storage must
                // survive; everything held in memory must not.
                this.ctx.abort();
                return new Response(null, { status: 204 });
            case "/open":
                return handle(async () =>
                    outcome(await this.#environments.openSession(sessionRequest(body)))
                );
            case "/inspect":
                return handle(async () =>
                    outcome(await this.#environments.inspectSession(sessionRequest(body)))
                );
            case "/close":
                return handle(async () =>
                    outcome(await this.#environments.closeSession(sessionRequest(body)))
                );
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
                    return content === undefined ? null : encodeBase64(content);
                });
            case "/snapshot":
                return handle(async () =>
                    outcome(await this.#environments.createSnapshot(snapshotRequest(body)))
                );
            case "/inspect-snapshot":
                return handle(async () =>
                    outcome(await this.#environments.inspectSnapshot(snapshotRequest(body)))
                );
            case "/expose":
                return handle(async () =>
                    outcome(await this.#environments.exposePort(exposureRequest(body)))
                );
            case "/inspect-exposure":
                return handle(async () =>
                    outcome(await this.#environments.inspectExposure(exposureRequest(body)))
                );
            case "/revoke":
                return handle(async () =>
                    outcome(await this.#environments.revokeExposure(exposureRequest(body)))
                );
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
        const body = await readBody(request);
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
                    const materialized = await this.#slates.materializeResource(
                        resourceRequest(body)
                    );
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

function outcome(value: { readonly name: string; readonly value?: unknown }): JsonValue {
    if (!("value" in value) || value.value === undefined) return { name: value.name };
    const inner = value.value;
    if (inner instanceof ContentRef) return { name: value.name, value: inner.value };
    if (typeof inner === "string") return { name: value.name, value: inner };
    // LiveEnvironmentSession handles carry no serializable payload.
    return { name: value.name };
}

interface LiveStub {
    fetch(request: Request): Promise<Response>;
}

interface LiveQueuePayload {
    readonly instance: string;
    readonly mode: string;
}

/**
 * A poison body carries the same fields plus one more, so the delivery decoder rejects
 * it on shape alone while the harness can still route it to the instance under test.
 */
interface LiveQueueBody {
    readonly deliveryId: string;
    readonly payload: LiveQueuePayload;
    readonly poison?: true;
}

const liveQueueCodecs: QueueDeliveryCodecs<string, LiveQueuePayload> = Object.freeze({
    deliveryId: Object.freeze({
        decode(value: unknown): string {
            if (typeof value !== "string" || value.length === 0) {
                throw new TypeError("Live delivery ID must be non-empty text");
            }
            return value;
        }
    }),
    payload: Object.freeze({
        decode(value: unknown): LiveQueuePayload {
            if (
                typeof value !== "object" ||
                value === null ||
                !("instance" in value) ||
                typeof value.instance !== "string" ||
                !("mode" in value) ||
                typeof value.mode !== "string"
            ) {
                throw new TypeError("Live queue payload must name an instance and a mode");
            }
            return Object.freeze({ instance: value.instance, mode: value.mode });
        }
    })
});

function laneStub(
    environment: LiveEnvironment,
    lane: string | undefined,
    instance: string
): LiveStub | undefined {
    switch (lane) {
        case "env":
            return environment.ENVIRONMENTS.getByName(instance);
        case "slate":
            return environment.SLATES.getByName(instance);
        case "runtime":
            return environment.RUNTIME.getByName(instance);
        default:
            return undefined;
    }
}

async function runtimeCall(
    environment: LiveEnvironment,
    instance: string,
    operation: string,
    body: LiveBody
): Promise<LiveBody> {
    const response = await environment.RUNTIME.getByName(instance).fetch(
        new Request(`https://agent-core-live-harness/${operation}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        })
    );
    const decoded = (await response.json()) as {
        readonly ok?: unknown;
        readonly result?: LiveBody;
    };
    if (decoded.ok !== true || decoded.result === undefined) {
        throw new TypeError(`Live runtime lane ${operation} failed for ${instance}`);
    }
    return decoded.result;
}

async function publish(
    environment: LiveEnvironment,
    instance: string,
    body: LiveBody
): Promise<JsonValue> {
    const poison = flagField(body, "poison");
    const deliveryId = field(body, "deliveryId");
    await environment.DELIVERIES.send({
        deliveryId,
        payload: { instance, mode: field(body, "mode") },
        ...(poison ? { poison: true as const } : {})
    });
    return { deliveryId, poison };
}

async function recordPoison(
    environment: LiveEnvironment,
    messageId: string,
    body: unknown
): Promise<void> {
    if (
        typeof body !== "object" ||
        body === null ||
        !("deliveryId" in body) ||
        typeof body.deliveryId !== "string" ||
        !("payload" in body) ||
        typeof body.payload !== "object" ||
        body.payload === null ||
        !("instance" in body.payload) ||
        typeof body.payload.instance !== "string"
    ) {
        throw new TypeError(`Dead-lettered message ${messageId} carries no live routing`);
    }
    await runtimeCall(environment, body.payload.instance, "queue-poison", {
        messageId,
        deliveryId: body.deliveryId
    });
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
        if (instance === undefined || rest.length === 0) {
            return new Response("not found", { status: 404 });
        }
        if (lane === "queue" && rest[0] === "publish") {
            return handle(async () => publish(environment, instance, await readBody(request)));
        }
        const stub = laneStub(environment, lane, instance);
        if (stub === undefined) return new Response("not found", { status: 404 });
        const forwarded = new URL(request.url);
        forwarded.pathname = `/${rest.join("/")}`;
        return stub.fetch(new Request(forwarded, request));
    },

    async queue(batch: MessageBatch<unknown>, environment: LiveEnvironment): Promise<void> {
        if (batch.queue === POISON_QUEUE) {
            for (const message of batch.messages) {
                await recordPoison(environment, message.id, message.body);
                message.ack();
            }
            return;
        }
        await new AtLeastOnceQueueAdapter<string, LiveQueuePayload>(
            {
                async deliver(deliveryId, payload): Promise<QueueTargetResult> {
                    const result = await runtimeCall(
                        environment,
                        payload.instance,
                        "queue-delivery",
                        { deliveryId, mode: payload.mode }
                    );
                    return result["disposition"] === "retry"
                        ? { disposition: "retry", retryDelaySeconds: 1 }
                        : { disposition: "ack" };
                }
            },
            liveQueueCodecs,
            errors
        ).handle(batch);
    }
};

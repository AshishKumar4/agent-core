import {
    ContentRef,
    Digest,
    InvocationId,
    Revision,
    TenantId,
    WorkspaceId,
    isJsonObject,
    isJsonValue,
    jsonDataParser,
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
    type SnapshotEnvironmentRequest,
    type LiveEnvironmentSession,
    type ProviderActionOutcome,
    type ProviderResourceOutcome
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
import {
    LiveRuntimeHarness,
    liveSchemaRelease,
    type LiveRuntimeEnvironment
} from "./runtime-harness.js";
import { isText } from "../src/platform-value.js";

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
const liveData = jsonDataParser((message) => new TypeError(message));

const providerDescriptor = new ProviderDescriptor(
    new ProviderId("cloudflare-do-live"),
    "1",
    ContentRef.fromDigest(Digest.sha256(new Uint8Array([0])))
);

function sessionRequest(body: LiveBody): OpenSessionRequest {
    const request = {
        environmentId: new EnvironmentId(field(body, "environmentId")),
        environmentRevision: new Revision(numberField(body, "environmentRevision")),
        generation: numberField(body, "generation"),
        sessionId: new EnvironmentSessionId(field(body, "sessionId"))
    };
    const restore = body["restore"];
    return Object.freeze(
        isText(restore) ? { ...request, restore: new ContentRef(restore) } : request
    );
}

function snapshotRequest(body: LiveBody): SnapshotEnvironmentRequest {
    return Object.freeze({
        environmentId: new EnvironmentId(field(body, "environmentId")),
        environmentRevision: new Revision(numberField(body, "environmentRevision")),
        generation: numberField(body, "generation"),
        sessionId: new EnvironmentSessionId(field(body, "sessionId")),
        sessionEpoch: numberField(body, "sessionEpoch"),
        snapshotId: new EnvironmentSnapshotId(field(body, "snapshotId"))
    });
}

function exposureRequest(body: LiveBody): ExposePortRequest {
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

function deploymentRequest(body: LiveBody): SlateProviderDeploymentRequest {
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
        expectedActiveDeploymentId: isText(expected) ? new SlateDeploymentId(expected) : undefined,
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

function resourceRequest(body: LiveBody): SlateProviderResourceRequest {
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

type LiveOutcome =
    ProviderActionOutcome | ProviderResourceOutcome<ContentRef | LiveEnvironmentSession | string>;

function outcome(value: LiveOutcome): JsonValue {
    if (value.name !== "ready") return { name: value.name };
    const inner = value.value;
    if (inner instanceof ContentRef) return { name: value.name, value: inner.value };
    if (isText(inner)) return { name: value.name, value: inner };
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
        decode(value: JsonValue): string {
            return liveData.nonemptyString(value, "Live delivery ID");
        }
    }),
    payload: Object.freeze({
        decode(value: JsonValue): LiveQueuePayload {
            if (!isJsonObject(value)) {
                throw new TypeError("Live queue payload must name an instance and a mode");
            }
            return Object.freeze({
                instance: liveData.nonemptyString(value["instance"], "Live queue instance"),
                mode: liveData.nonemptyString(value["mode"], "Live queue mode")
            });
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
    const decoded: unknown = await response.json();
    if (!isJsonValue(decoded) || !isJsonObject(decoded) || decoded["ok"] !== true) {
        throw new TypeError(`Live runtime lane ${operation} failed for ${instance}`);
    }
    const result = decoded["result"];
    if (!isJsonObject(result)) {
        throw new TypeError(`Live runtime lane ${operation} returned no result for ${instance}`);
    }
    return result;
}

async function publish(
    environment: LiveEnvironment,
    instance: string,
    body: LiveBody
): Promise<JsonValue> {
    const poison = flagField(body, "poison");
    const deliveryId = field(body, "deliveryId");
    const message = {
        deliveryId,
        payload: { instance, mode: field(body, "mode") }
    };
    await environment.DELIVERIES.send(poison ? { ...message, poison: true } : message);
    return { deliveryId, poison };
}

async function recordPoison(
    environment: LiveEnvironment,
    messageId: string,
    body: LiveQueueBody
): Promise<void> {
    if (!isText(body.deliveryId) || !isText(body.payload.instance)) {
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
                // The lane walks base, next, base, next at one commit, so the release is
                // the only thing that distinguishes one deployment from the next.
                release: liveSchemaRelease,
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

    async queue(batch: MessageBatch<LiveQueueBody>, environment: LiveEnvironment): Promise<void> {
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

import {
    AgentCoreError,
    ContentRef,
    Digest,
    RouteReservationId,
    TenantId,
    jsonDataParser,
    isJsonObject,
    isJsonValue,
    type JsonValue
} from "@agent-core/core";
import { BindingName, FacetRef, type FacetData } from "@agent-core/core/facets";
import {
    AuthoredCodeCapability,
    AuthoredCodeCapabilitySet,
    AuthoredCodeInvocationPort,
    type AuthoredCodeInvocationRequest
} from "@agent-core/core/operations";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import { ProviderDescriptor, ProviderId } from "@agent-core/core/environment-provider";
import {
    SqliteActorStore,
    SqliteAuthorityPermitStore,
    SqliteContentStore
} from "@agent-core/core/substrates/sqlite";
import { AuthorityPermit, AuthorityPermitExpectation } from "@agent-core/core/authority";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
    AlarmOutboxReconciler,
    AtLeastOnceQueueAdapter,
    CloudflareSqlite,
    DurableObjectEnvironmentProvider,
    DurableObjectPermitAdmission,
    DurableObjectPermitRecordSource,
    DurableObjectSlateProvider,
    PermitIssuerDurableObjectHost,
    DynamicWorkerLoaderAdapter,
    PassedCapabilityRegistry,
    passedCapabilities,
    type AuthoredCodeEntrypointLike,
    type PassedCapabilityLike,
    type PassedCapabilityProps,
    SqliteApplicationMigrator,
    SqlitePlacementRegistry,
    cloudflareRuntimeMigrations,
    runHostingMigration,
    SqliteReconciliationOutbox,
    ReconciliationOutboxId,
    contentRepositoryFromR2Binding,
    createCloudflareDurableObjectClass,
    createCloudflareWorker,
    environmentProviderMigration,
    placementRegistryMigration,
    slateProviderMigration,
    type CloudflareDurableObjectInstance,
    type CloudflareErrorPort,
    type FetchServiceLike,
    type WorkerLoaderBindingLike
} from "../../src/index.js";
import { isPlatformMethod, isPlatformObject } from "../../src/platform-value.js";
import { queueCodecs } from "../queue-codecs.js";

export type TestEnvironment = Env;

const loaderCapabilities = new AuthoredCodeCapabilitySet([
    new AuthoredCodeCapability(new BindingName("CAPABILITY"), new FacetRef("mail:instance"))
]);
const workerdData = jsonDataParser((message) => new TypeError(message));

// A stand-in for the isolate's gateway port: the point of this scenario is that a
// delegated capability crosses the real Worker Loader boundary and calls back into the
// host, not what the host does with the call.
const loaderInvocations = new (class extends AuthoredCodeInvocationPort {
    public async invoke(request: AuthoredCodeInvocationRequest): Promise<FacetData> {
        return {
            binding: request.binding.value,
            operation: request.operation.value,
            input: request.input
        };
    }
})();

/**
 * The acknowledgement frame is JSON a client sent, so it is decoded once, here, and the
 * socket route receives the revision rather than a frame to interpret.
 */
function acknowledgedRevision(message: string | ArrayBuffer): number {
    if (message instanceof ArrayBuffer) {
        throw new TypeError("Expected text acknowledgement");
    }
    const frame: unknown = JSON.parse(message);
    if (!isJsonValue(frame) || !isJsonObject(frame)) {
        throw new TypeError("Expected acknowledgement object");
    }
    return workerdData.safeInteger(frame["ackedRevision"], "Acknowledged revision");
}

type WorkerdAuthoredCodeEntrypointCandidate = FetchServiceLike &
    Partial<AuthoredCodeEntrypointLike>;

function requireAuthoredCodeEntrypoint(
    entrypoint: WorkerdAuthoredCodeEntrypointCandidate
): AuthoredCodeEntrypointLike {
    if (!isAuthoredCodeEntrypoint(entrypoint)) {
        throw new AgentCoreError("operation.invalid-output", "Loaded code declares no run");
    }
    return entrypoint;
}

function isAuthoredCodeEntrypoint(
    value: WorkerdAuthoredCodeEntrypointCandidate
): value is WorkerdAuthoredCodeEntrypointCandidate & AuthoredCodeEntrypointLike {
    return isPlatformObject(value) && isPlatformMethod(value.run);
}

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};
const delivered = new Map<string, number>();

const LOADER_ISOLATE = "invocation:loader-1";
const loaderRegistry = new PassedCapabilityRegistry(errors);

// The host's capability entry point, exactly as cloudflare-os exports GatekeeperLoopback:
// a WorkerEntrypoint whose props carry only the routing identity, so the stub the loader
// serializes into `env` holds data and the live port is resolved here on every call.
export class TestPassedCapabilityEntrypoint extends WorkerEntrypoint<
    TestEnvironment,
    PassedCapabilityProps
> {
    public invoke(operation: string, input: FacetData): Promise<FacetData> {
        return loaderRegistry.invoke(this.ctx.props, operation, input);
    }
}

// Only the one export this route builds stubs from. Declaring that much locally keeps
// the full Cloudflare.Exports RPC types — which instantiate too deeply for the checker
// on a call like this — out of the test.
interface CapabilityExports {
    TestPassedCapabilityEntrypoint(options: {
        readonly props: PassedCapabilityProps;
    }): PassedCapabilityLike;
}

/** As much of the worker's own context as this route uses. */
interface WorkerContextLike {
    readonly exports?: Partial<CapabilityExports>;
}

function requireCapabilityExports(context: Partial<WorkerContextLike>): CapabilityExports {
    if (!isPlatformObject(context) || !isCapabilityExports(context.exports)) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Worker context exposes no capability entry point"
        );
    }
    return context.exports;
}

function isCapabilityExports(
    value: Partial<CapabilityExports> | undefined
): value is CapabilityExports {
    return isPlatformObject(value) && isPlatformMethod(value.TestPassedCapabilityEntrypoint);
}

const TestActorDelegate = createCloudflareDurableObjectClass<TestEnvironment>({
    errors,
    contentBucket: (environment) => environment.CONTENT,
    host: {
        create: (runtime) => {
            const outbox = new SqliteReconciliationOutbox(runtime.sqlite, errors);
            const alarms = new AlarmOutboxReconciler(
                runtime.alarms,
                outbox,
                async () => {},
                errors,
                { clock: { now: () => Number.MAX_SAFE_INTEGER } }
            );
            return {
                repairAlarm: () => alarms.repairAlarm(),
                async fetch(request): Promise<Response> {
                    const url = new URL(request.url);
                    if (url.pathname === "/content") {
                        const stored = await runtime.content?.put(
                            new TenantId("test"),
                            new Uint8Array([1, 2, 3])
                        );
                        return Response.json({ digest: stored?.digest });
                    }
                    if (url.pathname === "/enqueue-without-alarm") {
                        outbox.enqueue(
                            new ReconciliationOutboxId(url.searchParams.get("id") ?? "repair"),
                            Date.now() + 60_000
                        );
                        return new Response("enqueued");
                    }
                    if (url.pathname === "/core-store") {
                        const actorStore = new SqliteActorStore(runtime.sqlite);
                        const actor = new ActorRef("tenant", new ActorId("core-store"));
                        const recovery = actorStore.activateActor(actor, () => undefined);
                        const content = new SqliteContentStore(runtime.sqlite);
                        const stored = await content.put(new Uint8Array([4, 5, 6]));
                        return Response.json({
                            epoch: recovery.epoch,
                            bytes: [...(await content.get(stored.ref))]
                        });
                    }
                    if (url.pathname === "/probe-store") {
                        // Writes a nonce into this object's private SQLite and returns the
                        // running ledger size. Two resolutions that reach the same store see a
                        // growing count; a split into two stores would each report 1.
                        runtime.sqlite.run(
                            "CREATE TABLE IF NOT EXISTS probe_ledger (nonce TEXT PRIMARY KEY)",
                            []
                        );
                        runtime.sqlite.run(
                            "INSERT OR IGNORE INTO probe_ledger (nonce) VALUES (?)",
                            [url.searchParams.get("nonce") ?? ""]
                        );
                        return Response.json({
                            count: runtime.sqlite.all(
                                "SELECT COUNT(*) AS count FROM probe_ledger",
                                []
                            )[0]?.count
                        });
                    }
                    if (url.pathname === "/rollback") {
                        runtime.sqlite.run(
                            "CREATE TABLE IF NOT EXISTS rollback_probe (value INTEGER NOT NULL)",
                            []
                        );
                        try {
                            runtime.sqlite.transaction(() => {
                                runtime.sqlite.run(
                                    "INSERT INTO rollback_probe (value) VALUES (1)",
                                    []
                                );
                                throw new TypeError("rollback probe");
                            });
                        } catch (error) {
                            if (!(error instanceof TypeError)) throw error;
                        }
                        const count = runtime.sqlite.all(
                            "SELECT COUNT(*) AS count FROM rollback_probe",
                            []
                        )[0]?.count;
                        return Response.json({ count });
                    }
                    if (url.pathname === "/socket") {
                        if (runtime.revisions.currentRevision("test") === 0) {
                            runtime.revisions.append("test", 1, new Uint8Array([1]));
                        }
                        const pair = new WebSocketPair();
                        runtime.webSockets.accept(pair[1], "test", 0);
                        return new Response(null, { status: 101, webSocket: pair[0] });
                    }
                    return new Response("actor");
                },
                async alarm(): Promise<void> {
                    await alarms.handleAlarm();
                },
                webSocketMessage(socket, message): void {
                    runtime.webSockets.acknowledge(socket, acknowledgedRevision(message));
                    if (runtime.revisions.currentRevision("test") === 1) {
                        runtime.revisions.append("test", 2, new Uint8Array([2]));
                    }
                    runtime.webSockets.replay(socket);
                },
                webSocketClose(): void {},
                webSocketError(): void {}
            };
        }
    }
});

export class TestActorDurableObject extends DurableObject<TestEnvironment> {
    readonly #delegate: CloudflareDurableObjectInstance;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        this.#delegate = new TestActorDelegate(
            state satisfies ConstructorParameters<typeof TestActorDelegate>[0],
            environment
        );
    }

    public fetch(request: Request): Response | Promise<Response> {
        return this.#delegate.fetch(request);
    }

    public alarm(): void | Promise<void> {
        return this.#delegate.alarm();
    }

    public webSocketMessage(
        socket: WebSocket,
        message: string | ArrayBuffer
    ): void | Promise<void> {
        return this.#delegate.webSocketMessage(socket, message);
    }

    public webSocketClose(
        socket: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean
    ): void | Promise<void> {
        return this.#delegate.webSocketClose(socket, code, reason, wasClean);
    }

    public webSocketError(socket: WebSocket, error: Error): void | Promise<void> {
        return this.#delegate.webSocketError(socket, error);
    }
}

export const ENVIRONMENT_PROVIDER_TENANT = "environment-provider-tests";
export const PREVIEW_HOST = "preview.agent-core.test";
const environmentProviderDescriptor = new ProviderDescriptor(
    new ProviderId("cloudflare-do"),
    "1",
    ContentRef.fromDigest(Digest.sha256(new Uint8Array([0])))
);

export class EnvironmentProviderDurableObject extends DurableObject<TestEnvironment> {
    public readonly environments: DurableObjectEnvironmentProvider;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        const sqlite = new CloudflareSqlite(state.storage, errors);
        new SqliteApplicationMigrator(sqlite, errors, [environmentProviderMigration(1)]).migrate();
        this.environments = new DurableObjectEnvironmentProvider(
            environmentProviderDescriptor,
            sqlite,
            contentRepositoryFromR2Binding(environment, (bindings) => bindings.CONTENT, errors),
            new TenantId(ENVIRONMENT_PROVIDER_TENANT),
            { previewHost: PREVIEW_HOST },
            errors
        );
    }

    public fetch(): Response {
        return new Response("environment-provider");
    }
}

export const PERMIT_TENANT_ACTOR = new ActorRef("tenant", new ActorId("permit-tenant"));
export const PERMIT_TARGET_ACTOR = new ActorRef("run", new ActorId("permit-target"));

export class PermitTenantDurableObject extends DurableObject<TestEnvironment> {
    readonly #host: PermitIssuerDurableObjectHost<unknown>;
    public readonly permits: SqliteAuthorityPermitStore;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        this.permits = new SqliteAuthorityPermitStore(
            new CloudflareSqlite(state.storage, errors),
            PERMIT_TENANT_ACTOR
        );
        this.#host = new PermitIssuerDurableObjectHost(this.permits);
    }

    public issuePermit(bytes: Uint8Array): void {
        const permit = AuthorityPermit.decode(bytes);
        this.permits.transaction((transaction) => {
            this.permits.issue(transaction, permit);
        });
    }

    public issuedPermitRecord(nonce: string): Uint8Array | undefined {
        return this.#host.issuedPermitRecord(nonce);
    }

    public fetch(): Response {
        return new Response("permit-tenant");
    }
}

export class PermitTargetDurableObject extends DurableObject<TestEnvironment> {
    readonly #sqlite: CloudflareSqlite;
    readonly #admission: DurableObjectPermitAdmission<unknown>;
    #expected: AuthorityPermitExpectation | undefined;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        this.#sqlite = new CloudflareSqlite(state.storage, errors);
        this.#sqlite.transaction(() =>
            this.#sqlite.run(
                `CREATE TABLE IF NOT EXISTS effect_attempts (
                    nonce TEXT PRIMARY KEY,
                    admitted_at TEXT NOT NULL
                ) STRICT`,
                []
            )
        );
        const store = new SqliteAuthorityPermitStore(this.#sqlite, PERMIT_TARGET_ACTOR);
        this.#admission = new DurableObjectPermitAdmission(
            store,
            new DurableObjectPermitRecordSource(
                environment.PERMIT_TENANTS,
                PERMIT_TENANT_ACTOR,
                errors
            )
        );
    }

    public seedExpectation(bytes: Uint8Array): void {
        // Stands in for the target's persisted invocation, reservation, and claim
        // state: admission validates against this local record, never permit fields.
        this.#expected = AuthorityPermit.decode(bytes).expectation;
    }

    public async admitPermit(bytes: Uint8Array, at: number, failAppend = false): Promise<string> {
        if (this.#expected === undefined) throw new Error("Expectation was not seeded");
        const permit = AuthorityPermit.decode(bytes);
        await this.#admission.admit(permit, this.#expected, new Date(at), () => {
            if (failAppend) throw new Error("Injected effect-append failure");
            this.#sqlite.run("INSERT INTO effect_attempts (nonce, admitted_at) VALUES (?, ?)", [
                permit.nonce,
                new Date(at).toISOString()
            ]);
        });
        return permit.nonce;
    }

    public effectAttemptCount(): number {
        const rows = this.#sqlite.all("SELECT nonce FROM effect_attempts", []);
        return rows.length;
    }

    public fetch(): Response {
        return new Response("permit-target");
    }
}

/** The placement ledger belongs to one object; no Actor object keeps private pins. */
export class PlacementRegistryDurableObject extends DurableObject<TestEnvironment> {
    public readonly placements: SqlitePlacementRegistry;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        const sqlite = new CloudflareSqlite(state.storage, errors);
        new SqliteApplicationMigrator(sqlite, errors, [placementRegistryMigration(1)]).migrate();
        this.placements = new SqlitePlacementRegistry(sqlite, errors);
    }

    public fetch(): Response {
        return new Response("placement-registry");
    }
}

/**
 * A Workspace Actor object: it installs the Run index beside the runtime tables and, for a
 * Workspace-owned Run, holds that Run's records in this same private storage.
 */
export class RunWorkspaceDurableObject extends DurableObject<TestEnvironment> {
    public readonly sqlite: CloudflareSqlite;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        this.sqlite = new CloudflareSqlite(state.storage, errors);
        new SqliteApplicationMigrator(this.sqlite, errors, [
            ...cloudflareRuntimeMigrations,
            runHostingMigration(3)
        ]).migrate();
    }

    public fetch(): Response {
        return new Response("run-workspace");
    }
}

/** A Run Actor object: a Run pinned `dedicated` at start owns its records here instead. */
export class RunDurableObject extends DurableObject<TestEnvironment> {
    public readonly sqlite: CloudflareSqlite;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        this.sqlite = new CloudflareSqlite(state.storage, errors);
        new SqliteApplicationMigrator(this.sqlite, errors, cloudflareRuntimeMigrations).migrate();
    }

    public fetch(): Response {
        return new Response("run");
    }
}

export const SLATE_PROVIDER_TENANT = "slate-provider-tests";

export class SlateProviderDurableObject extends DurableObject<TestEnvironment> {
    public readonly slates: DurableObjectSlateProvider;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        const sqlite = new CloudflareSqlite(state.storage, errors);
        new SqliteApplicationMigrator(sqlite, errors, [slateProviderMigration(1)]).migrate();
        this.slates = new DurableObjectSlateProvider(
            sqlite,
            contentRepositoryFromR2Binding(environment, (bindings) => bindings.CONTENT, errors),
            new TenantId(SLATE_PROVIDER_TENANT),
            errors
        );
    }

    public fetch(): Response {
        return new Response("slate-provider");
    }
}

export default createCloudflareWorker<TestEnvironment, RouteReservationId, JsonValue>({
    router: {
        async fetch(request, environment, context): Promise<Response> {
            const url = new URL(request.url);
            if (url.pathname === "/delivery-count") {
                return Response.json({
                    count: delivered.get(url.searchParams.get("id") ?? "") ?? 0
                });
            }
            if (url.pathname === "/loader") {
                // SAFETY: this is the real Workers ExecutionContext. The public adapter
                // intentionally exposes only waitUntil, so this route restores the optional
                // exports field and validates it before use.
                const workerContext = context as typeof context & Partial<WorkerContextLike>;
                const adapter =
                    new DynamicWorkerLoaderAdapter<WorkerdAuthoredCodeEntrypointCandidate>(
                        environment.LOADER satisfies WorkerLoaderBindingLike<WorkerdAuthoredCodeEntrypointCandidate>,
                        errors
                    );
                using registered = loaderRegistry.open(LOADER_ISOLATE, loaderInvocations);
                void registered;
                const scope = adapter.load(
                    {
                        compatibilityDate: "2026-07-10",
                        // The same flag WorkerLoaderAuthoredCodeBacking sets, exercised
                        // here so real workerd validates it rather than only a fake.
                        compatibilityFlags: ["disallow_importable_env"],
                        mainModule: "index.js",
                        modules: {
                            "index.js": `import { WorkerEntrypoint } from "cloudflare:workers";
                            export default class extends WorkerEntrypoint {
                                async run(input) {
                                    return {
                                        names: Object.keys(this.env).sort(),
                                        result: await this.env.CAPABILITY.invoke("read", input)
                                    };
                                }
                            }`
                        }
                    },
                    passedCapabilities(loaderCapabilities, LOADER_ISOLATE, (props) =>
                        requireCapabilityExports(workerContext).TestPassedCapabilityEntrypoint({
                            props
                        })
                    ),
                    requireAuthoredCodeEntrypoint
                );
                try {
                    return Response.json(await scope.entrypoint.run({ path: "/a" }));
                } finally {
                    scope[Symbol.dispose]();
                }
            }
            if (url.pathname === "/loader-outbound") {
                const adapter = new DynamicWorkerLoaderAdapter<FetchServiceLike>(
                    environment.LOADER satisfies WorkerLoaderBindingLike<FetchServiceLike>,
                    errors
                );
                const scope = adapter.load(
                    {
                        compatibilityDate: "2026-07-10",
                        mainModule: "index.js",
                        modules: {
                            "index.js": `export default {
                            async fetch() {
                                try {
                                    await fetch("https://example.com/");
                                    return Response.json({ blocked: false });
                                } catch {
                                    return Response.json({ blocked: true });
                                }
                            }
                        }`
                        }
                    },
                    {},
                    requireFetchService
                );
                try {
                    return await scope.entrypoint.fetch(request);
                } finally {
                    scope[Symbol.dispose]();
                }
            }
            return environment.ACTORS.getByName("test").fetch(request);
        }
    },
    queue: new AtLeastOnceQueueAdapter(
        {
            deliver: async (deliveryId, payload) => {
                if (isJsonObject(payload) && "retry" in payload) {
                    return { disposition: "retry", retryDelaySeconds: 7 };
                }
                if (!delivered.has(deliveryId.value)) delivered.set(deliveryId.value, 1);
                return { disposition: "ack" };
            }
        },
        queueCodecs,
        errors
    )
});

function requireFetchService(value: Partial<FetchServiceLike>): FetchServiceLike {
    if (!isFetchService(value)) {
        throw new TypeError("Dynamic Worker entrypoint must provide fetch");
    }
    return value;
}

function isFetchService(value: Partial<FetchServiceLike>): value is FetchServiceLike {
    return isPlatformObject(value) && isPlatformMethod(value.fetch);
}

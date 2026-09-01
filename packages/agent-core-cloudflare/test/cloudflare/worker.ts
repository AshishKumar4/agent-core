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
    SqliteContentStore,
    type TransactionalSqlite
} from "@agent-core/core/substrates/sqlite";
import {
    AuthorityPermit,
    AuthorityPermitAdmissionPort,
    AuthorityPermitAuthenticator,
    AuthorityPermitIssuer,
    StoredAuthorityPermitAdmissionPort
} from "@agent-core/core/authority";
import {
    AuthorityPermitIssuanceReply,
    AuthorityPermitIssuanceRequest
} from "@agent-core/core/protocol";
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
    BASE_PERMIT_SPEC,
    buildExpectation,
    buildTargetRequest,
    tenantDecision,
    tenantActorRef,
    targetActorRef,
    type PermitSpec
} from "./permit-fixture.js";
import {
    AlarmOutboxReconciler,
    CapabilityAuthorityPermitIssuance,
    CapabilityAuthorityPermitRecords,
    TargetBoundTenantAuthority,
    TenantAuthorityPermitSink,
    type TenantAuthorityCapabilityStub,
    AtLeastOnceQueueAdapter,
    CloudflareSqlite,
    DurableObjectEnvironmentProvider,
    DurableObjectSlateProvider,
    DynamicWorkerLimits,
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

export { ProviderActorDurableObject } from "./provider-actor.js";

export type TestEnvironment = Env;

const loaderCapabilities = new AuthoredCodeCapabilitySet([
    new AuthoredCodeCapability(new BindingName("capability"), new FacetRef("mail:instance"))
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
/**
 * Real workerd enforces these, so they are sized for what the probes actually do: a few
 * milliseconds of JavaScript and one loopback call to the passed capability. Small on
 * purpose — a bound wide enough never to bite would not prove the loader carries one.
 */
const LOADER_LIMITS = new DynamicWorkerLimits(50, 8);
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
            runHostingMigration(cloudflareRuntimeMigrations.length + 1)
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

export const PERMIT_TENANT = BASE_PERMIT_SPEC.tenant;

export interface ForwardedPermitCall {
    readonly caller: string;
    readonly bytes: Uint8Array;
    readonly idempotencyKey: string;
}

/**
 * The capability as it crosses a Durable Object boundary. A stub is the only handle a
 * target can obtain, and only this Tenant can construct the object behind one, which is
 * what makes the binding unforgeable rather than conventional. The disposer runs after the
 * last stub is disposed, so the platform's own lifetime rule is what closes it.
 */
export class TenantAuthorityCapability extends RpcTarget {
    public constructor(
        private readonly bound: TargetBoundTenantAuthority,
        private readonly onDispose: () => void
    ) {
        super();
    }

    public issuePermit(request: Uint8Array, idempotencyKey: string): Promise<Uint8Array> {
        return this.bound.issuePermit(request, idempotencyKey);
    }

    public issuedPermit(nonce: string, digest: string): Promise<Uint8Array | undefined> {
        return this.bound.issuedPermit(nonce, digest);
    }

    public projectLeaseEvidence(evidence: Uint8Array, idempotencyKey: string): Promise<Uint8Array> {
        return this.bound.projectLeaseEvidence(evidence, idempotencyKey);
    }

    public [Symbol.dispose](): void {
        this.bound[Symbol.dispose]();
        this.onDispose();
    }
}

/**
 * The Tenant Actor object behind the permit plane. One real `SqliteAuthorityPermitStore`
 * in its own private storage, one real `AuthorityPermitIssuer` over it, and one
 * target-bound capability per caller. The issuance decision is core's: this object
 * authenticates who asked, derives the check evidence from the request the caller sent, and
 * hands both to the issuer inside a single Tenant transaction.
 */
export class TenantAuthorityDurableObject extends DurableObject<TestEnvironment> {
    readonly #permits: SqliteAuthorityPermitStore;
    readonly #forwarded: ForwardedPermitCall[] = [];
    readonly #sink: TenantAuthorityPermitSink;
    #decision: "allow" | "deny" = "allow";
    #clockMs = BASE_PERMIT_SPEC.issuedAtMs;
    #disposals = 0;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        const sqlite = new CloudflareSqlite(state.storage, errors);
        const permits = new SqliteAuthorityPermitStore(sqlite, tenantActorRef(BASE_PERMIT_SPEC));
        permits.transaction(() => undefined);
        this.#permits = permits;
        const issuer = new AuthorityPermitIssuer(permits);
        const forwarded = this.#forwarded;
        const tenantClock = (): number => this.#clockMs;
        const tenantDecisionKind = (): "allow" | "deny" => this.#decision;
        this.#sink = new (class extends TenantAuthorityPermitSink {
            public async issue(
                caller: ActorRef,
                request: Uint8Array,
                idempotencyKey: string
            ): Promise<Uint8Array> {
                forwarded.push(
                    Object.freeze({
                        caller: `${caller.kind}:${caller.id.value}`,
                        bytes: request.slice(),
                        idempotencyKey
                    })
                );
                const targetRequest = AuthorityPermitIssuanceRequest.decode(request).targetRequest;
                // SPEC section 10.3: the authenticated transport caller MUST be the target
                // Actor the request names. The caller arrives from the capability, so a
                // holder cannot answer for anyone else by editing the payload.
                if (!targetRequest.expectation.target.actor.equals(caller)) {
                    throw new AgentCoreError(
                        "authority.denied",
                        "The authenticated caller is not the target the request names"
                    );
                }
                const checkedAt = new Date(tenantClock());
                const evidence = tenantDecision(targetRequest, tenantDecisionKind(), checkedAt);
                if (!evidence.allowed) {
                    return AuthorityPermitIssuanceReply.encode(
                        AuthorityPermitIssuanceReply.denied(evidence)
                    );
                }
                const permit = permits.transaction((transaction) =>
                    issuer.issue(transaction, targetRequest, evidence, checkedAt)
                );
                return AuthorityPermitIssuanceReply.encode(
                    AuthorityPermitIssuanceReply.issued(evidence, permit)
                );
            }

            public async issued(
                caller: ActorRef,
                nonce: string,
                digest: string
            ): Promise<Uint8Array | undefined> {
                const held = permits.transaction((transaction) =>
                    permits.issued(transaction, nonce)
                );
                if (held === undefined || held.digest().value !== digest) return undefined;
                if (!held.expectation.target.actor.equals(caller)) return undefined;
                return AuthorityPermit.encode(held);
            }

            public async project(
                _caller: ActorRef,
                evidence: Uint8Array,
                _idempotencyKey: string
            ): Promise<Uint8Array> {
                return evidence.slice();
            }
        })();
    }

    /**
     * The trusted profile bootstrap. Only the deployed platform Worker holds this namespace
     * binding, so only it can ask for a capability, and it names the exact Actor that
     * capability speaks for. A holder cannot re-point one.
     */
    public bindTarget(actorKind: string, actorId: string): TenantAuthorityCapability {
        return new TenantAuthorityCapability(
            new TargetBoundTenantAuthority({
                tenantActor: tenantActorRef(BASE_PERMIT_SPEC),
                caller: new ActorRef(requireActorKind(actorKind), new ActorId(actorId)),
                sink: this.#sink,
                errors
            }),
            () => {
                this.#disposals += 1;
            }
        );
    }

    /** Fixes the Tenant's issuance clock, so a scenario decides the issuance instant. */
    public setClock(milliseconds: number): void {
        this.#clockMs = milliseconds;
    }

    /** Chooses what this Tenant decides next, so a denial is a decision and not a fault. */
    public setDecision(decision: "allow" | "deny"): void {
        this.#decision = decision;
    }

    public clock(): number {
        return this.#clockMs;
    }

    public decision(): "allow" | "deny" {
        return this.#decision;
    }

    /**
     * How many capabilities this Tenant has seen released. The platform runs an RpcTarget
     * disposer only after the LAST stub pointing at it is disposed, so this counter is the
     * observable that distinguishes a released capability from a leaked one.
     */
    public disposals(): number {
        return this.#disposals;
    }

    /** The digest of the issuance this Tenant holds, read from its own storage. */
    public heldDigest(nonce: string): string | undefined {
        return this.#permits
            .transaction((transaction) => this.#permits.issued(transaction, nonce))
            ?.digest().value;
    }

    /** What the capability forwarded, so a scenario can assert exact-byte carriage. */
    public forwarded(): readonly ForwardedPermitCall[] {
        return Object.freeze([...this.#forwarded]);
    }

    public fetch(): Response {
        return new Response("tenant-authority");
    }
}

/**
 * The target Actor object. It retains its own immutable request, asks its Tenant through
 * the capability it was handed, authenticates the reply against the Tenant's own record,
 * and admits the permit in one Durable Object transaction over its private SQLite.
 */
export class TargetMediationDurableObject extends DurableObject<TestEnvironment> {
    public readonly sqlite: CloudflareSqlite;
    readonly #permits: SqliteAuthorityPermitStore;
    readonly #admission: AuthorityPermitAdmissionPort<TransactionalSqlite>;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        this.sqlite = new CloudflareSqlite(state.storage, errors);
        this.#permits = new SqliteAuthorityPermitStore(
            this.sqlite,
            targetActorRef(BASE_PERMIT_SPEC)
        );
        this.#permits.transaction(() => undefined);
        this.#admission = new StoredAuthorityPermitAdmissionPort(this.#permits);
    }

    /**
     * Retains the immutable request for `requested`, asks the Tenant for a permit,
     * authenticates the reply against the Tenant's own record, and admits it against the
     * expectation for `expected` at `nowMs`. `capability` is a stub the platform Worker
     * minted and still owns, so this object never disposes it.
     */
    public async admit(
        capability: TenantAuthorityCapabilityStub,
        requested: PermitSpec,
        expected: PermitSpec,
        nowMs: number
    ): Promise<string> {
        const channel = {
            issuer: tenantActorRef(BASE_PERMIT_SPEC),
            capability,
            errors
        };
        const request = buildTargetRequest(requested);
        this.#permits.transaction((transaction) => this.#permits.request(transaction, request));
        const replyBytes = await new CapabilityAuthorityPermitIssuance(channel).issue(
            AuthorityPermitIssuanceRequest.encode(new AuthorityPermitIssuanceRequest(request)),
            requested.nonce
        );
        const reply = AuthorityPermitIssuanceReply.decode(replyBytes);
        if (reply.kind === "denied") {
            throw new AgentCoreError(
                "authority.denied",
                `Tenant authority denied permit issuance: ${reply.evidence.reason}`
            );
        }
        const permit = reply.requirePermit();
        const authentication = await new AuthorityPermitAuthenticator(
            new CapabilityAuthorityPermitRecords(channel)
        ).authenticate(permit, buildExpectation(expected));
        // One Durable Object transaction: the exact-permit consumption and nothing between.
        this.#permits.transaction((transaction) =>
            this.#admission.consume(
                transaction,
                authentication,
                permit,
                buildExpectation(expected),
                new Date(nowMs)
            )
        );
        return permit.digest().value;
    }

    /**
     * Retains the immutable request and asks the Tenant, and stops there. This is what a
     * lost response leaves behind: the Tenant has issued and the target has admitted
     * nothing, which is the state a retry has to be safe against.
     */
    public async request(
        capability: TenantAuthorityCapabilityStub,
        requested: PermitSpec
    ): Promise<void> {
        const request = buildTargetRequest(requested);
        this.#permits.transaction((transaction) => this.#permits.request(transaction, request));
        await new CapabilityAuthorityPermitIssuance({
            issuer: tenantActorRef(BASE_PERMIT_SPEC),
            capability,
            errors
        }).issue(
            AuthorityPermitIssuanceRequest.encode(new AuthorityPermitIssuanceRequest(request)),
            requested.nonce
        );
    }

    /** Whether this object has consumed that nonce, read from its durable storage. */
    public consumed(nonce: string): string | undefined {
        return this.#permits.transaction(
            (transaction) => this.#permits.consumed(transaction, nonce)?.value
        );
    }

    /** Whether this object still retains the immutable request for that nonce. */
    public retains(nonce: string): boolean {
        return (
            this.#permits.transaction((transaction) =>
                this.#permits.requested(transaction, nonce)
            ) !== undefined
        );
    }

    public fetch(): Response {
        return new Response("target-mediation");
    }
}

function requireActorKind(value: string): ActorRef["kind"] {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    ) {
        return value;
    }
    throw new AgentCoreError("operation.invalid-input", `Unknown Actor kind ${value}`);
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
                        LOADER_LIMITS,
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
                                        result: await this.env.capability.invoke("read", input)
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
                    LOADER_LIMITS,
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

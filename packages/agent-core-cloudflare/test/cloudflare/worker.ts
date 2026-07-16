import { AgentCoreError, RouteReservationId, TenantId } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import { SqliteActorStore, SqliteContentStore } from "@agent-core/core/substrates/sqlite";
import { DurableObject } from "cloudflare:workers";
import {
    AlarmOutboxReconciler,
    AtLeastOnceQueueAdapter,
    DynamicWorkerLoaderAdapter,
    SqliteReconciliationOutbox,
    ReconciliationOutboxId,
    createCloudflareDurableObjectClass,
    createCloudflareWorker,
    type CloudflareDurableObjectInstance,
    type CloudflareErrorPort,
    type FetchServiceLike,
    type WorkerLoaderBindingLike
} from "../../src/index.js";
import { queueCodecs } from "../queue-codecs.js";

export type TestEnvironment = Env;

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};
const delivered = new Map<string, number>();

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
                    if (typeof message !== "string") {
                        throw new TypeError("Expected text acknowledgement");
                    }
                    const value: unknown = JSON.parse(message);
                    if (
                        typeof value !== "object" ||
                        value === null ||
                        !("ackedRevision" in value) ||
                        typeof value.ackedRevision !== "number"
                    ) {
                        throw new TypeError("Expected numeric acknowledged revision");
                    }
                    runtime.webSockets.acknowledge(socket, value.ackedRevision);
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

    public webSocketError(socket: WebSocket, error: unknown): void | Promise<void> {
        return this.#delegate.webSocketError(socket, error);
    }
}

export default createCloudflareWorker<TestEnvironment, RouteReservationId, unknown>({
    router: {
        async fetch(request, environment): Promise<Response> {
            const url = new URL(request.url);
            if (url.pathname === "/delivery-count") {
                return Response.json({
                    count: delivered.get(url.searchParams.get("id") ?? "") ?? 0
                });
            }
            if (url.pathname === "/loader") {
                const adapter = new DynamicWorkerLoaderAdapter(
                    environment.LOADER satisfies WorkerLoaderBindingLike,
                    ["CAPABILITY"],
                    errors
                );
                const scope = adapter.load(
                    {
                        compatibilityDate: "2026-07-10",
                        mainModule: "index.js",
                        modules: {
                            "index.js": `export default {
                            fetch(_request, env) {
                                return Response.json({
                                    capability: env.CAPABILITY,
                                    keys: Object.keys(env).sort()
                                });
                            }
                        }`
                        }
                    },
                    { CAPABILITY: "allowed" },
                    requireFetchService
                );
                try {
                    return await scope.entrypoint.fetch(request);
                } finally {
                    scope[Symbol.dispose]();
                }
            }
            if (url.pathname === "/loader-outbound") {
                const adapter = new DynamicWorkerLoaderAdapter(
                    environment.LOADER satisfies WorkerLoaderBindingLike,
                    [],
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
            deliver: async (deliveryId, payload: unknown) => {
                if (typeof payload === "object" && payload !== null && "retry" in payload) {
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

function requireFetchService(value: unknown): FetchServiceLike {
    if (!isFetchService(value)) {
        throw new TypeError("Dynamic Worker entrypoint must provide fetch");
    }
    return value;
}

function isFetchService(value: unknown): value is FetchServiceLike {
    return (
        typeof value === "object" &&
        value !== null &&
        "fetch" in value &&
        typeof value.fetch === "function"
    );
}

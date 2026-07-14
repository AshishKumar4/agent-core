import {
    AtLeastOnceQueueAdapter,
    DispatchNamespaceAdapter,
    DynamicWorkerLoaderAdapter,
    ExplicitCloudflareDeploymentAdapter,
    contentRepositoryFromR2Binding,
    createCloudflareDurableObjectClass,
    createCloudflareWorker
} from "../src/index.js";
import { RouteReservationId, TenantId } from "@agent-core/core";
import {
    FakeDispatchNamespace,
    FakeDurableObjectHost,
    FakeDurableObjectStorage,
    FakeExecutionContext,
    FakeQueueMessage,
    FakeR2Bucket,
    FakeSqlStorage,
    FakeWebSocket,
    FakeWorkerLoader,
    FakeWorkerRouter,
    fakeErrors
} from "./fakes.js";
import { expectOperationalFailure } from "./assertions.js";
import { queueCodecs } from "./queue-codecs.js";

const source = Object.freeze({
    compatibilityDate: "2026-07-10",
    mainModule: "index.js",
    modules: Object.freeze({ "index.js": "export default { fetch() {} }" })
});

describe("Cloudflare hosting adapters", () => {
    test("forces one-time Dynamic Worker load with null outbound and allowlisted env", () => {
        const loader = new FakeWorkerLoader();
        const adapter = new DynamicWorkerLoaderAdapter(loader, ["VIEW"], fakeErrors);
        const capability = Object.freeze({ fetch: () => undefined });

        const scope = adapter.load(source, { VIEW: capability }, requireFetchService);
        expect(scope.entrypoint).toBe(loader.service);
        expect(loader.calls).toEqual([
            {
                ...source,
                modules: { ...source.modules },
                env: { VIEW: capability },
                globalOutbound: null
            }
        ]);
        expectOperationalFailure(
            () => adapter.load(source, { SECRET: "ambient" }, requireFetchService),
            "authority.denied"
        );
        scope[Symbol.dispose]();
        expect(loader.disposals).toBe(1);
    });

    test("resolves only the explicitly selected deployment mode without fallback", async () => {
        const loader = new FakeWorkerLoader();
        const namespace = new FakeDispatchNamespace();
        const deployments = new ExplicitCloudflareDeploymentAdapter(
            new DynamicWorkerLoaderAdapter(loader, [], fakeErrors),
            new DispatchNamespaceAdapter(namespace, fakeErrors),
            fakeErrors
        );

        await deployments.fetch(
            { mode: "dynamic", source, capabilities: {} },
            new Request("https://dynamic")
        );
        expect(loader.calls).toHaveLength(1);
        expect(namespace.calls).toEqual([]);
        await deployments.fetch(
            {
                mode: "dispatch",
                scriptName: "slate-v1",
                parameters: { tenant: "t1" }
            },
            new Request("https://dispatch")
        );
        expect(loader.calls).toHaveLength(1);
        expect(namespace.calls).toEqual([
            {
                scriptName: "slate-v1",
                parameters: { tenant: "t1" }
            }
        ]);
        expect(loader.disposals).toBe(1);
    });

    test("cleans every post-load failure and allows a later load after cleanup fails", () => {
        let attempts = 0;
        let entrypointDisposals = 0;
        let workerDisposals = 0;
        const adapter = new DynamicWorkerLoaderAdapter(
            {
                load: () => {
                    attempts += 1;
                    const entrypoint = {
                        fetch: () => new Response("loaded"),
                        [Symbol.dispose]: () => {
                            entrypointDisposals += 1;
                        }
                    };
                    return {
                        getEntrypoint: () => entrypoint,
                        [Symbol.dispose]: () => {
                            workerDisposals += 1;
                            if (attempts === 1) throw new TypeError("cleanup failed");
                        }
                    };
                }
            },
            [],
            fakeErrors
        );

        expectOperationalFailure(
            () =>
                adapter.load(source, {}, () => {
                    throw new TypeError("facet failed");
                }),
            "operation.invalid-output"
        );
        expect(entrypointDisposals).toBe(1);
        expect(workerDisposals).toBe(1);

        const scope = adapter.load(source, {}, requireFetchService);
        scope[Symbol.dispose]();
        scope[Symbol.dispose]();
        expect(attempts).toBe(2);
        expect(entrypointDisposals).toBe(2);
        expect(workerDisposals).toBe(2);
    });

    test("disposes distinct entrypoint resources and maps cleanup failure", () => {
        const adapter = new DynamicWorkerLoaderAdapter(
            {
                load: () => ({
                    getEntrypoint: () => "raw-entrypoint",
                    [Symbol.dispose](): never {
                        throw new TypeError("worker cleanup failed");
                    }
                })
            },
            [],
            fakeErrors
        );
        const scope = adapter.load(source, {}, () => ({ fetch: () => new Response("loaded") }));

        expectOperationalFailure(() => scope[Symbol.dispose](), "protocol.invalid-state");
    });

    test("integrates an R2 binding through the existing content repository", async () => {
        const bucket = new FakeR2Bucket();
        const repository = contentRepositoryFromR2Binding(
            { CONTENT: bucket },
            (environment) => environment.CONTENT,
            fakeErrors
        );
        const tenant = new TenantId("tenant");
        const stored = await repository.put(tenant, new Uint8Array([1, 2]));
        expect((await repository.get(tenant, stored.digest))?.bytes).toEqual(
            new Uint8Array([1, 2])
        );
    });

    test("composes Worker fetch and queue entrypoints around injected authority", async () => {
        const router = new FakeWorkerRouter<Record<string, never>>();
        const deliveries: RouteReservationId[] = [];
        const worker = createCloudflareWorker({
            router,
            queue: new AtLeastOnceQueueAdapter(
                {
                    deliver: async (id: RouteReservationId) => {
                        deliveries.push(id);
                        return { disposition: "ack" };
                    }
                },
                queueCodecs,
                fakeErrors
            )
        });
        const context = new FakeExecutionContext();
        const response = await worker.fetch(new Request("https://worker"), {}, context);
        const message = new FakeQueueMessage("platform", {
            deliveryId: "authoritative",
            payload: null
        });
        await worker.queue({ messages: [message] }, {}, context);

        expect(await response.text()).toBe("routed");
        expect(router.requests).toHaveLength(1);
        expect(deliveries).toEqual([new RouteReservationId("authoritative")]);
        expect(message.acknowledgements).toBe(1);
    });

    test("runs migrations synchronously and delegates DO lifecycle hooks to the host", async () => {
        const sql = new FakeSqlStorage((statement) => ({
            rows: statement.includes("FROM agent_core_migrations") ? [] : []
        }));
        const storage = new FakeDurableObjectStorage(sql);
        const accepted: unknown[] = [];
        const state = {
            storage,
            blockConcurrencyWhile: async <Result>(callback: () => Promise<Result>) => callback(),
            acceptWebSocket(socket: unknown): void {
                accepted.push(socket);
            }
        };
        const bucket = new FakeR2Bucket();
        const host = new FakeDurableObjectHost();
        let runtimeContent = false;
        const DurableObjectClass = createCloudflareDurableObjectClass({
            errors: fakeErrors,
            contentBucket: (_environment: { CONTENT: FakeR2Bucket }) => bucket,
            migrations: [
                {
                    version: 2,
                    name: "application-table",
                    statements: ["CREATE TABLE application_table (id INTEGER)"]
                }
            ],
            host: {
                create: (runtime) => {
                    runtimeContent = runtime.content !== undefined;
                    return host;
                }
            }
        });
        const instance = new DurableObjectClass(state, { CONTENT: bucket });
        const socket = new FakeWebSocket();

        expect(sql.calls[0]?.statement).toContain(
            "CREATE TABLE IF NOT EXISTS agent_core_migrations"
        );
        expect(sql.calls.some((call) => call.statement.includes("agent_core_view_snapshots"))).toBe(
            true
        );
        expect(
            sql.calls.some((call) => call.statement.includes("CREATE TABLE application_table"))
        ).toBe(true);
        expect(runtimeContent).toBe(true);
        expect(host.repairs).toBe(1);
        expect(await (await instance.fetch(new Request("https://object"))).text()).toBe(
            "https://object/"
        );
        await instance.alarm();
        await instance.webSocketMessage(socket, "message");
        await instance.webSocketClose(socket, 1000, "done", true);
        await instance.webSocketError(socket, new TypeError("socket"));
        expect(host.alarms).toBe(1);
        expect(host.messages).toEqual(["message"]);
        expect(host.closes).toBe(1);
        expect(host.errors).toBe(1);
        expect(accepted).toEqual([]);
    });

    test("constructs a Durable Object without optional migrations or content", () => {
        const storage = new FakeDurableObjectStorage(
            new FakeSqlStorage((statement) => ({
                rows: statement.includes("FROM agent_core_migrations") ? [] : []
            }))
        );
        const host = new FakeDurableObjectHost();
        const DurableObjectClass = createCloudflareDurableObjectClass({
            errors: fakeErrors,
            host: {
                create(runtime) {
                    expect(runtime.content).toBeUndefined();
                    return host;
                }
            }
        });
        const state = {
            storage,
            blockConcurrencyWhile: async <Result>(callback: () => Promise<Result>) => callback(),
            acceptWebSocket(): void {}
        };

        expect(
            new DurableObjectClass(state, {}).fetch(new Request("https://object"))
        ).toBeInstanceOf(Response);
    });
});

function requireFetchService(value: unknown): {
    fetch(request: Request): Response | Promise<Response>;
} {
    if (!isFetchService(value)) throw new TypeError("Expected Fetch service");
    return value;
}

function isFetchService(
    value: unknown
): value is { fetch(request: Request): Response | Promise<Response> } {
    return (
        typeof value === "object" &&
        value !== null &&
        "fetch" in value &&
        typeof value.fetch === "function"
    );
}

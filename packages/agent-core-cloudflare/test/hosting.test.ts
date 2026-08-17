import {
    AtLeastOnceQueueAdapter,
    DispatchNamespaceAdapter,
    DynamicWorkerLimits,
    DynamicWorkerLoaderAdapter,
    ExplicitCloudflareDeploymentAdapter,
    cloudflareRuntimeMigrations,
    contentRepositoryFromR2Binding,
    createCloudflareDurableObjectClass,
    createCloudflareWorker,
    type FetchServiceLike,
    type HibernatingWebSocketLike,
    type PassedCapabilityLike
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
    fakeErrors,
    fakeWorkerLimits
} from "./fakes.js";
import { isPlatformMethod, isPlatformObject } from "../src/platform-value.js";
import { expectOperationalFailure, malformedInput } from "./assertions.js";
import { queueCodecs } from "./queue-codecs.js";

const source = Object.freeze({
    compatibilityDate: "2026-07-10",
    mainModule: "index.js",
    modules: Object.freeze({ "index.js": "export default { fetch() {} }" })
});

describe("Cloudflare hosting adapters", () => {
    test("forces one-time Dynamic Worker load with null outbound and only passed Bindings", () => {
        const loader = new FakeWorkerLoader();
        const adapter = new DynamicWorkerLoaderAdapter(loader, fakeWorkerLimits, fakeErrors);

        const scope = adapter.load(source, {}, requireFetchService);
        expect(scope.entrypoint).toBe(loader.service);
        expect(loader.calls).toEqual([
            {
                ...source,
                modules: { ...source.modules },
                env: {},
                globalOutbound: null,
                limits: { cpuMs: 50, subRequests: 8 }
            }
        ]);
        scope[Symbol.dispose]();
        expect(loader.disposals).toBe(1);
    });

    test(
        "[C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND] carries the host's exact bound into every load",
        { tags: "p0" },
        () => {
            const loader = new FakeWorkerLoader();
            const adapter = new DynamicWorkerLoaderAdapter(
                loader,
                new DynamicWorkerLimits(25, 4),
                fakeErrors
            );

            adapter.load(source, {}, requireFetchService)[Symbol.dispose]();
            adapter.load(
                { ...source, modules: { "index.js": "export default { fetch() { return 1 } }" } },
                {},
                requireFetchService
            )[Symbol.dispose]();

            // The submission never states its own budget, so both loads carry the same
            // one: an omitted `limits` is the account's whole Workers-plan budget.
            expect(loader.calls.map((call) => call.limits)).toEqual([
                { cpuMs: 25, subRequests: 4 },
                { cpuMs: 25, subRequests: 4 }
            ]);
        }
    );

    test(
        "[C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND] refuses every bound that does not bound anything",
        { tags: "p0" },
        () => {
            for (const [cpuMs, subRequests] of [
                [0, 4],
                [-1, 4],
                [25, 0],
                [25, -1],
                [1.5, 4],
                [25, Number.POSITIVE_INFINITY],
                [Number.NaN, 4],
                [Number.MAX_SAFE_INTEGER + 2, 4]
            ] satisfies ReadonlyArray<readonly [number, number]>) {
                expect(() => new DynamicWorkerLimits(cpuMs, subRequests)).toThrow(TypeError);
            }
            expect(new DynamicWorkerLimits(25, 4).cpuMs).toBe(25);
        }
    );

    test(
        "[C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY] loads a second isolate for identical code " +
            "rather than serving it the first submission's delegation",
        { tags: "p0" },
        () => {
            const loader = new FakeWorkerLoader();
            const adapter = new DynamicWorkerLoaderAdapter(loader, fakeWorkerLimits, fakeErrors);
            const first: PassedCapabilityLike = { invoke: async () => "first" };
            const second: PassedCapabilityLike = { invoke: async () => "second" };

            adapter.load(source, { mail: first }, requireFetchService)[Symbol.dispose]();
            adapter.load(source, { mail: second }, requireFetchService)[Symbol.dispose]();

            // A name-keyed warm reuse would skip the second callback and run the second
            // submission in an isolate whose `env` still holds the first's delegation.
            expect(loader.calls).toHaveLength(2);
            expect(loader.calls[0]!.env["mail"]).toBe(first);
            expect(loader.calls[1]!.env["mail"]).toBe(second);
        }
    );

    test("resolves only the explicitly selected deployment mode without fallback", async () => {
        const loader = new FakeWorkerLoader();
        const namespace = new FakeDispatchNamespace();
        const deployments = new ExplicitCloudflareDeploymentAdapter(
            new DynamicWorkerLoaderAdapter(loader, fakeWorkerLimits, fakeErrors),
            new DispatchNamespaceAdapter(namespace, fakeErrors),
            fakeErrors
        );

        await deployments.fetch({ mode: "dynamic", source }, new Request("https://dynamic"));
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
        const adapter = new DynamicWorkerLoaderAdapter<FetchServiceLike>(
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
            fakeWorkerLimits,
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
        const adapter = new DynamicWorkerLoaderAdapter<FetchServiceLike>(
            {
                load: () => ({
                    getEntrypoint: () => malformedInput<FetchServiceLike, string>("raw-entrypoint"),
                    [Symbol.dispose](): never {
                        throw new TypeError("worker cleanup failed");
                    }
                })
            },
            fakeWorkerLimits,
            fakeErrors
        );
        const scope = adapter.load(source, {}, (): FetchServiceLike => ({
            fetch: () => new Response("loaded")
        }));

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
        const accepted: HibernatingWebSocketLike[] = [];
        const state = {
            storage,
            blockConcurrencyWhile: async <Result>(callback: () => Promise<Result>) => callback(),
            acceptWebSocket(socket: HibernatingWebSocketLike): void {
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
                    version: cloudflareRuntimeMigrations.length + 1,
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

    test("constructs a Durable Object without optional migrations or content", async () => {
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
            await new DurableObjectClass(state, {}).fetch(new Request("https://object"))
        ).toBeInstanceOf(Response);
    });

    test(
        "fails every entry point closed when startup alarm repair rejects",
        { tags: "p0" },
        async () => {
            const storage = new FakeDurableObjectStorage(new FakeSqlStorage(() => ({})));
            const host = new (class extends FakeDurableObjectHost {
                public override async repairAlarm(): Promise<void> {
                    throw new TypeError("outbox unavailable");
                }
            })();
            const DurableObjectClass = createCloudflareDurableObjectClass({
                errors: fakeErrors,
                host: { create: () => host }
            });
            const instance = new DurableObjectClass(
                {
                    storage,
                    blockConcurrencyWhile: async <Result>(callback: () => Promise<Result>) =>
                        callback(),
                    acceptWebSocket(): void {}
                },
                {}
            );

            // An unrepaired alarm must never serve traffic, in or out of the real runtime.
            await expect(instance.fetch(new Request("https://object"))).rejects.toMatchObject({
                code: "protocol.invalid-state",
                cause: new TypeError("outbox unavailable")
            });
            await expect(instance.alarm()).rejects.toMatchObject({
                code: "protocol.invalid-state"
            });
            await expect(
                instance.webSocketMessage(new FakeWebSocket(), "message")
            ).rejects.toMatchObject({ code: "protocol.invalid-state" });
            await expect(
                instance.webSocketClose(new FakeWebSocket(), 1000, "done", true)
            ).rejects.toMatchObject({ code: "protocol.invalid-state" });
            await expect(
                instance.webSocketError(new FakeWebSocket(), new TypeError("socket"))
            ).rejects.toMatchObject({ code: "protocol.invalid-state" });
            expect(host.alarms).toBe(0);
            expect(host.messages).toEqual([]);
            expect(host.closes).toBe(0);
            expect(host.errors).toBe(0);
        }
    );
});

function requireFetchService(value: Partial<FetchServiceLike>): FetchServiceLike {
    if (!isFetchService(value)) throw new TypeError("Expected Fetch service");
    return value;
}

function isFetchService(value: Partial<FetchServiceLike>): value is FetchServiceLike {
    return isPlatformObject(value) && isPlatformMethod(value.fetch);
}

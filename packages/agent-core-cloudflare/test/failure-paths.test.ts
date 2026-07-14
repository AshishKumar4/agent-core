import { AgentCoreError, TenantId } from "@agent-core/core";
import {
    AlarmOutboxReconciler,
    AtLeastOnceQueueAdapter,
    CloudflareSqlite,
    DispatchNamespaceAdapter,
    DurableViewRevisionLog,
    DynamicWorkerLoaderAdapter,
    ExplicitCloudflareDeploymentAdapter,
    HibernatingViewSocketAdapter,
    R2ContentObjectRepository,
    ReconciliationOutboxId,
    SqliteReconciliationOutbox,
    contentRepositoryFromR2Binding,
    operationalFailure,
    parseActorObjectName,
    type SynchronousSqlitePort
} from "../src/index.js";
import { expectOperationalFailure } from "./assertions.js";
import {
    FakeAlarmStorage,
    FakeDurableObjectStorage,
    FakeQueueMessage,
    FakeRuntimeSqlite,
    FakeSqlStorage,
    FakeWebSocket,
    FakeWebSocketContext,
    fakeErrors
} from "./fakes.js";
import { queueCodecs } from "./queue-codecs.js";

const identity = <Value>(value: Value): Value => value;

describe("Cloudflare operational failure mapping", () => {
    test("guarantees AgentCoreError even when an injected mapper violates its contract", () => {
        expect(() =>
            operationalFailure(
                {
                    raise(): never {
                        throw new TypeError("invalid mapper");
                    }
                },
                "protocol.invalid-state",
                "mapped failure",
                "cause"
            )
        ).toThrow(AgentCoreError);
        try {
            operationalFailure(
                {
                    raise(): never {
                        throw new TypeError("invalid mapper");
                    }
                },
                "protocol.invalid-state",
                "mapped failure",
                "cause"
            );
        } catch (error) {
            expect(error).toMatchObject({
                code: "protocol.invalid-state",
                message: "mapped failure",
                cause: "cause"
            });
        }
    });

    test("maps SQLite preparation, cursor, and platform transaction failures", () => {
        const prepareFailure = new CloudflareSqlite(
            new FakeDurableObjectStorage({
                exec(): never {
                    throw new TypeError("prepare");
                }
            }),
            fakeErrors
        );
        expectOperationalFailure(() => prepareFailure.run("UPDATE", []), "protocol.invalid-state");

        const iterationFailure = new CloudflareSqlite(
            new FakeDurableObjectStorage({
                exec: () => ({
                    [Symbol.iterator](): Iterator<never> {
                        throw new TypeError("iterate");
                    }
                })
            }),
            fakeErrors
        );
        expectOperationalFailure(
            () => iterationFailure.all("SELECT", []),
            "protocol.invalid-state"
        );
        expectOperationalFailure(
            () => iterationFailure.run("UPDATE", []),
            "protocol.invalid-state"
        );

        const transactionFailure = new CloudflareSqlite(
            {
                sql: new FakeSqlStorage(() => ({})),
                transactionSync(): never {
                    throw new TypeError("platform");
                }
            },
            fakeErrors
        );
        expectOperationalFailure(
            () => transactionFailure.transaction(() => undefined),
            "protocol.invalid-state"
        );
    });

    test("normalizes every supported SQL value and rejects unsupported decoded values", () => {
        const view = new Uint16Array([258]);
        const sql = new FakeSqlStorage(() => ({
            rows: [{ nil: null, text: "x", count: 1, view }]
        }));
        const database = new CloudflareSqlite(new FakeDurableObjectStorage(sql), fakeErrors);
        expect(database.all("SELECT", [])).toEqual([
            {
                nil: null,
                text: "x",
                count: 1,
                view: new Uint8Array(view.buffer)
            }
        ]);

        const invalidSql = new FakeSqlStorage(() => ({
            rows: [{ invalid: true } as unknown as Record<string, never>]
        }));
        const invalid = new CloudflareSqlite(new FakeDurableObjectStorage(invalidSql), fakeErrors);
        expectOperationalFailure(() => invalid.all("SELECT", []), "operation.invalid-output");
    });

    test("maps R2 operation failures and corruption without a custom Error subclass", async () => {
        const missingAfterWrite = new R2ContentObjectRepository(
            {
                put: async () => null,
                get: async () => null
            },
            fakeErrors
        );
        await expect(
            missingAfterWrite.put(new TenantId("tenant"), new Uint8Array([1]))
        ).rejects.toMatchObject({ code: "codec.invalid" });

        const failedRead = new R2ContentObjectRepository(
            {
                put: async () => null,
                get: async () => {
                    throw new TypeError("R2 unavailable");
                }
            },
            fakeErrors
        );
        await expect(failedRead.get(new TenantId("tenant"), "a".repeat(64))).rejects.toMatchObject({
            code: "protocol.invalid-state"
        });
        expectOperationalFailure(
            () => contentRepositoryFromR2Binding({}, () => null as never, fakeErrors),
            "operation.invalid-output"
        );
        expectOperationalFailure(
            () =>
                contentRepositoryFromR2Binding(
                    {},
                    () => {
                        throw new TypeError("binding unavailable");
                    },
                    fakeErrors
                ),
            "protocol.invalid-state"
        );
    });

    test("maps reconciliation storage corruption and validates input configuration", async () => {
        expect(
            () =>
                new AlarmOutboxReconciler(
                    new FakeAlarmStorage(),
                    {
                        dueIds: async () => [],
                        nextDueAt: async () => null,
                        acknowledge: async () => {},
                        reschedule: async () => {}
                    },
                    async () => {},
                    fakeErrors,
                    { batchSize: 0 }
                )
        ).toThrow(TypeError);

        const malformedOutbox = {
            dueIds: async () => ["" as never],
            nextDueAt: async () => -1,
            acknowledge: async () => {},
            reschedule: async () => {}
        };
        const repair = new AlarmOutboxReconciler(
            new FakeAlarmStorage(),
            malformedOutbox,
            async () => {},
            fakeErrors
        );
        await expect(repair.repairAlarm()).rejects.toMatchObject({
            code: "operation.invalid-output"
        });

        const handle = new AlarmOutboxReconciler(
            new FakeAlarmStorage(),
            { ...malformedOutbox, nextDueAt: async () => null },
            async () => {},
            fakeErrors,
            { clock: { now: () => 0 } }
        );
        await expect(handle.handleAlarm()).rejects.toMatchObject({
            code: "operation.invalid-output"
        });

        const invalidPhysicalAlarm = new AlarmOutboxReconciler(
            {
                getAlarm: async () => -1,
                setAlarm: async () => {},
                deleteAlarm: async () => {}
            },
            { ...malformedOutbox, nextDueAt: async () => null, dueIds: async () => [] },
            async () => {},
            fakeErrors
        );
        await expect(invalidPhysicalAlarm.repairAlarm()).rejects.toMatchObject({
            code: "operation.invalid-output"
        });

        const invalidClock = new AlarmOutboxReconciler(
            new FakeAlarmStorage(),
            { ...malformedOutbox, nextDueAt: async () => null, dueIds: async () => [] },
            async () => {},
            fakeErrors,
            { clock: { now: () => -1 } }
        );
        await expect(invalidClock.handleAlarm()).rejects.toMatchObject({
            code: "operation.invalid-output"
        });

        const overflow = new AlarmOutboxReconciler(
            new FakeAlarmStorage(),
            {
                dueIds: async () => [new ReconciliationOutboxId("id")],
                nextDueAt: async () => null,
                acknowledge: async () => {},
                reschedule: async () => {}
            },
            async () => {
                throw new TypeError("retry");
            },
            fakeErrors,
            { retryDelayMs: 1, clock: { now: () => Number.MAX_SAFE_INTEGER } }
        );
        await expect(overflow.handleAlarm()).rejects.toMatchObject({
            code: "protocol.invalid-state"
        });
    });

    test("validates durable outbox rows and all caller inputs", async () => {
        const malformed: SynchronousSqlitePort = {
            all: (statement) => (statement.startsWith("SELECT MIN") ? [] : [{ id: null }]),
            run: () => {},
            transaction: <Result>(
                operation: () => Result,
                ..._guard: import("../src/index.js").SynchronousResultGuard<Result>
            ): Result => operation()
        };
        const outbox = new SqliteReconciliationOutbox(malformed, fakeErrors);
        await expect(outbox.nextDueAt()).rejects.toMatchObject({
            code: "operation.invalid-output"
        });
        await expect(outbox.dueIds(0, 1)).rejects.toMatchObject({
            code: "operation.invalid-output"
        });
        const invalidTime = new SqliteReconciliationOutbox(
            {
                ...malformed,
                all: () => [{ scheduled_at: -1 }]
            },
            fakeErrors
        );
        await expect(invalidTime.nextDueAt()).rejects.toMatchObject({
            code: "operation.invalid-output"
        });
        expectOperationalFailure(() => outbox.enqueue("" as never, 0), "operation.invalid-input");
        expectOperationalFailure(
            () => outbox.enqueue(new ReconciliationOutboxId("id"), -1),
            "operation.invalid-input"
        );
        await expect(outbox.dueIds(0, 0)).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(outbox.acknowledge("" as never)).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(outbox.reschedule(new ReconciliationOutboxId("id"), -1)).rejects.toMatchObject(
            { code: "operation.invalid-input" }
        );
    });

    test("maps Loader and Dispatch failures and validates explicit inputs", () => {
        expect(
            () =>
                new DynamicWorkerLoaderAdapter(
                    { load: () => ({ getEntrypoint: () => ({}) }) },
                    [""],
                    fakeErrors
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new DynamicWorkerLoaderAdapter(
                    { load: () => ({ getEntrypoint: () => ({}) }) },
                    ["A", "A"],
                    fakeErrors
                )
        ).toThrow(TypeError);
        const loader = new DynamicWorkerLoaderAdapter(
            {
                load(): never {
                    throw new TypeError("load");
                }
            },
            [],
            fakeErrors
        );
        expectOperationalFailure(
            () =>
                loader.load(
                    {
                        compatibilityDate: "2026-07-10",
                        mainModule: "index.js",
                        modules: { "index.js": "code" }
                    },
                    {},
                    identity
                ),
            "protocol.invalid-state"
        );
        let invalidHandleDisposals = 0;
        const invalidHandle = new DynamicWorkerLoaderAdapter(
            {
                load: () =>
                    ({
                        [Symbol.dispose]: () => {
                            invalidHandleDisposals += 1;
                        }
                    }) as never
            },
            [],
            fakeErrors
        );
        expectOperationalFailure(
            () =>
                invalidHandle.load(
                    {
                        compatibilityDate: "2026-07-10",
                        mainModule: "index.js",
                        modules: { "index.js": "code" }
                    },
                    {},
                    identity
                ),
            "operation.invalid-output"
        );
        expect(invalidHandleDisposals).toBe(1);
        let entrypointFailureDisposals = 0;
        const entrypointFailure = new DynamicWorkerLoaderAdapter(
            {
                load: () => ({
                    getEntrypoint(): never {
                        throw new TypeError("entrypoint");
                    },
                    [Symbol.dispose](): void {
                        entrypointFailureDisposals += 1;
                    }
                })
            },
            [],
            fakeErrors
        );
        expectOperationalFailure(
            () =>
                entrypointFailure.load(
                    {
                        compatibilityDate: "2026-07-10",
                        mainModule: "index.js",
                        modules: { "index.js": "code" }
                    },
                    {},
                    identity
                ),
            "protocol.invalid-state"
        );
        expect(entrypointFailureDisposals).toBe(1);
        let missingEntrypointDisposals = 0;
        const missingEntrypoint = new DynamicWorkerLoaderAdapter(
            {
                load: () => ({
                    getEntrypoint: () => null,
                    [Symbol.dispose]: () => {
                        missingEntrypointDisposals += 1;
                    }
                })
            },
            [],
            fakeErrors
        );
        expectOperationalFailure(
            () =>
                missingEntrypoint.load(
                    {
                        compatibilityDate: "2026-07-10",
                        mainModule: "index.js",
                        modules: { "index.js": "code" }
                    },
                    {},
                    identity
                ),
            "operation.invalid-output"
        );
        expect(missingEntrypointDisposals).toBe(1);
        expect(() =>
            loader.load(
                {
                    compatibilityDate: "bad",
                    mainModule: "missing.js",
                    modules: { "index.js": "" }
                },
                {},
                identity
            )
        ).toThrow(TypeError);

        const dispatch = new DispatchNamespaceAdapter(
            {
                get(): never {
                    throw new TypeError("dispatch");
                }
            },
            fakeErrors
        );
        expectOperationalFailure(() => dispatch.resolve("script"), "protocol.invalid-state");
        const missingDispatch = new DispatchNamespaceAdapter(
            {
                get: () => null
            },
            fakeErrors
        );
        expectOperationalFailure(
            () => missingDispatch.resolve("missing"),
            "operation.invalid-output"
        );
        expectOperationalFailure(() => dispatch.resolve(""), "operation.invalid-input");
        expectOperationalFailure(
            () => dispatch.resolve("script", { "": "value" }),
            "operation.invalid-input"
        );

        const invalidDeployment = new ExplicitCloudflareDeploymentAdapter(
            new DynamicWorkerLoaderAdapter(
                {
                    load: () => ({ getEntrypoint: () => ({}) as never })
                },
                [],
                fakeErrors
            ),
            new DispatchNamespaceAdapter({ get: () => ({}) as never }, fakeErrors),
            fakeErrors
        );
        expectOperationalFailure(
            () =>
                invalidDeployment.resolve({
                    mode: "dynamic",
                    source: {
                        compatibilityDate: "2026-07-10",
                        mainModule: "index.js",
                        modules: { "index.js": "code" }
                    },
                    capabilities: {}
                }),
            "operation.invalid-output"
        );
    });

    test("maps queue dispositions only after valid target results", async () => {
        const retry = new FakeQueueMessage("platform", { deliveryId: "retry", payload: null });
        await new AtLeastOnceQueueAdapter(
            {
                deliver: async () => ({ disposition: "retry" })
            },
            queueCodecs,
            fakeErrors
        ).handle({ messages: [retry] });
        expect(retry.retries).toEqual([undefined]);

        const invalid = (result: unknown) =>
            new AtLeastOnceQueueAdapter(
                {
                    deliver: async () => result as never
                },
                queueCodecs,
                fakeErrors
            ).handle({
                messages: [new FakeQueueMessage("platform", { deliveryId: "id", payload: null })]
            });
        await expect(invalid({ disposition: "unknown" })).rejects.toMatchObject({
            code: "operation.invalid-output"
        });
        await expect(invalid({ disposition: "retry", retryDelaySeconds: 0 })).rejects.toMatchObject(
            { code: "operation.invalid-output" }
        );

        const message = new (class extends FakeQueueMessage<{ deliveryId: string; payload: null }> {
            public override ack(): void {
                throw new TypeError("ack");
            }
        })("platform", { deliveryId: "id", payload: null });
        await expect(
            new AtLeastOnceQueueAdapter(
                {
                    deliver: async () => ({ disposition: "ack" })
                },
                queueCodecs,
                fakeErrors
            ).handle({ messages: [message] })
        ).rejects.toMatchObject({ code: "protocol.invalid-state" });
    });

    test("maps WebSocket platform failures and validates hibernation data", () => {
        const revisions = new DurableViewRevisionLog(new FakeRuntimeSqlite(), fakeErrors);
        revisions.append("channel", 1, new Uint8Array([1]));
        const failingContext = {
            acceptWebSocket(): never {
                throw new TypeError("accept");
            }
        };
        expectOperationalFailure(
            () =>
                new HibernatingViewSocketAdapter(failingContext, revisions, fakeErrors).accept(
                    new FakeWebSocket(),
                    "channel",
                    0
                ),
            "protocol.invalid-state"
        );

        const failingAttachment = new FakeWebSocket();
        failingAttachment.serializeAttachment = () => {
            throw new TypeError("attachment");
        };
        expectOperationalFailure(
            () =>
                new HibernatingViewSocketAdapter(
                    new FakeWebSocketContext(),
                    revisions,
                    fakeErrors
                ).accept(failingAttachment, "channel", 0),
            "protocol.invalid-state"
        );

        const failingSend = new FakeWebSocket();
        failingSend.send = () => {
            throw new TypeError("send");
        };
        expectOperationalFailure(
            () =>
                new HibernatingViewSocketAdapter(
                    new FakeWebSocketContext(),
                    revisions,
                    fakeErrors
                ).accept(failingSend, "channel", 0),
            "protocol.invalid-state"
        );

        expectOperationalFailure(
            () =>
                new HibernatingViewSocketAdapter(
                    new FakeWebSocketContext(),
                    revisions,
                    fakeErrors
                ).accept(new FakeWebSocket(), "", 0),
            "operation.invalid-input"
        );

        const failingRead = new FakeWebSocket();
        failingRead.deserializeAttachment = () => {
            throw new TypeError("deserialize");
        };
        expectOperationalFailure(
            () =>
                new HibernatingViewSocketAdapter(
                    new FakeWebSocketContext(),
                    revisions,
                    fakeErrors
                ).attachment(failingRead),
            "protocol.invalid-state"
        );
    });

    test("rejects invalid UTF-8 actor names", () => {
        expect(() => parseActorObjectName("agent-core:actor:v1:%E0%A4%A:id:eu")).toThrow(
            "invalid UTF-8"
        );
    });
});

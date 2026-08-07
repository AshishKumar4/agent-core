import { describe, expect, test, vi } from "vitest";
import { CompatRange, Digest, JsonSchema, SemVer } from "../../src/core";
import { MemoryContentStore } from "../../src/content";
import { AgentCoreError } from "../../src/errors";
import {
    AttemptReceipt,
    EffectAttemptId,
    InvocationId,
    MemoryInvocationMediationPersistence,
    ReceiptId,
    ReplayOperationInvocationPort,
    cloneInvocationMediationMemoryState,
    createInvocationMediationMemoryState,
    type CanonicalBatchInvocationRequest,
    type CanonicalBatchInvoker,
    type InvocationMediationMemoryState,
    type InvocationTransactionPort
} from "../../src/invocations";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    BindingName,
    Command,
    Contribution,
    Contributions,
    FacetManifest,
    FacetPackageId,
    FieldMapping,
    FieldMove,
    InterceptorDeclaration,
    InterceptorId,
    OperationDescriptor,
    OperationName,
    OperationPattern,
    OperationRef,
    OperationSelector,
    SlotName,
    SlotEntry,
    SurfaceDescriptor,
    SurfaceId,
    isFacetDataMap,
    type FacetData
} from "../../src/facets";
import {
    CommandRuntime,
    type CommandEventPort,
    type CommandInvocationEvent,
    type CommandInvocationOrigin,
    type InstalledCommand
} from "../../src/operations/command-runtime";
import { FacetCorrespondenceValidator } from "../../src/operations/correspondence";
import {
    OperationGatewayHost,
    OperationRequestKey,
    type AuthorityResolution,
    type MediatedInvocationPreflight,
    type MediatedInvocationRequest,
    type MediatedPreflightResult,
    type OperationDispatchResult,
    type OperationAuthorityPort,
    type OperationInterceptionEvidence,
    type OperationInvocationPort,
    type OperationPayload,
    type OperationPayloadShape
} from "../../src/operations/gateway";
import { FacetRuntimeHost } from "../../src/operations/lifecycle";
import {
    Facet,
    Interceptor,
    Operation,
    Surface,
    type FacetLifecycleContext,
    type InterceptContext,
    type InterceptResult,
    type OperationContext
} from "../../src/operations/runtime";

const objectSchema = new JsonSchema({ type: "object" });

describe("Facet runtime", () => {
    test("rejects correspondence failures before lifecycle code runs", { tags: "p1" }, async () => {
        const descriptor = operationDescriptor("run");
        const expected = manifest("acme.runtime", [descriptor]);
        const start = vi.fn(async () => {});
        const facet = new TestFacet("workspace:runtime", expected, [], new Map(), new Map(), start);
        const validator = new FacetCorrespondenceValidator();

        expect(() => validator.validate([expected], [facet])).toThrow(/no runtime implementation/);
        const host = new FacetRuntimeHost([expected], [facet]);
        await expect(host.activate()).rejects.toMatchObject({ code: "facet.inactive" });
        expect(start).not.toHaveBeenCalled();
    });

    test(
        "starts parent before child once and disposes child before parent",
        { tags: "p1" },
        async () => {
            const order: string[] = [];
            const childManifest = manifest("acme.child", []);
            const child = new TestFacet(
                "workspace:child",
                childManifest,
                [],
                new Map(),
                new Map(),
                async () => {
                    order.push("start:child");
                },
                async () => {
                    order.push("stop:child");
                }
            );
            const parentManifest = manifest("acme.parent", []);
            const parent = new TestFacet(
                "workspace:parent",
                parentManifest,
                [child],
                new Map(),
                new Map(),
                async () => {
                    order.push("start:parent");
                },
                async () => {
                    order.push("stop:parent");
                }
            );
            const host = new FacetRuntimeHost([parentManifest, childManifest], [parent]);

            await Promise.all([host.activate(), host.activate()]);
            await host.activate();
            expect(order).toEqual(["start:parent", "start:child"]);
            await Promise.all([host.dispose(), host.dispose()]);
            expect(order).toEqual(["start:parent", "start:child", "stop:child", "stop:parent"]);
            expect(host.facets()).toEqual([]);
        }
    );

    test("rejects cycles, duplicate references, and descriptor mismatch", { tags: "p1" }, () => {
        const descriptor = operationDescriptor("run");
        const expected = manifest("acme.runtime", [descriptor]);
        const wrong = new TestOperation(
            operationDescriptor("run", "mutate"),
            async (input) => input
        );
        const facet = new TestFacet(
            "workspace:runtime",
            expected,
            [],
            new Map([["run", wrong]]),
            new Map()
        );
        expect(() => new FacetCorrespondenceValidator().validate([expected], [facet])).toThrow(
            /does not match/
        );

        const cyclic = new TestFacet("workspace:cycle", manifest("acme.cycle", []));
        cyclic.childFacets.push(cyclic);
        expect(() =>
            new FacetCorrespondenceValidator().validate([cyclic.manifest], [cyclic])
        ).toThrow(/cycle/);

        const duplicate = new InterceptorDeclaration(
            new InterceptorId("duplicate"),
            "operation.before",
            OperationSelector.own(),
            1
        );
        const duplicateManifest = manifest("acme.duplicate", [], [duplicate, duplicate]);
        const duplicateFacet = new TestFacet(
            "workspace:duplicate",
            duplicateManifest,
            [],
            new Map(),
            new Map([
                ["duplicate", new TestInterceptor(duplicate, (value) => ({ proceed: true, value }))]
            ])
        );
        expect(() =>
            new FacetCorrespondenceValidator().validate([duplicateManifest], [duplicateFacet])
        ).toThrow(/more than once/);
    });

    test("validates Surface declarations against runtime implementations", { tags: "p1" }, () => {
        const descriptor = new SurfaceDescriptor(new SurfaceId("dashboard"), "Dashboard");
        const expected = manifest("acme.surface", [], [], [descriptor]);
        const facet = new TestFacet(
            "workspace:surface",
            expected,
            [],
            new Map(),
            new Map(),
            async () => {},
            async () => {},
            new Map([["dashboard", new TestSurface(descriptor)]])
        );

        const validated = new FacetCorrespondenceValidator().validate([expected], [facet])
            .facets[0]!;
        expect(validated.ref.equals(facet.ref)).toBe(true);
        expect(validated.surface(descriptor.id)?.descriptor.id.equals(descriptor.id)).toBe(true);
    });

    test("rejects two runtime Facets that present the same pinned manifest", { tags: "p1" }, () => {
        const shared = manifest("acme.shared", []);
        expect(() =>
            new FacetCorrespondenceValidator().validate(
                [shared],
                [
                    new TestFacet("workspace:first", shared),
                    new TestFacet("workspace:second", shared)
                ]
            )
        ).toThrowError(
            expect.objectContaining({
                code: "facet.inactive",
                message: "Runtime contains duplicate Facet manifest acme.shared@1.0.0"
            })
        );
    });

    test(
        "names the kind of contribution that has no runtime implementation",
        { tags: "p1" },
        () => {
            const surfaceDescriptor = new SurfaceDescriptor(
                new SurfaceId("dashboard"),
                "Dashboard"
            );
            const guard = new InterceptorDeclaration(
                new InterceptorId("guard"),
                "operation.before",
                OperationSelector.own(),
                1
            );
            const cases = [
                [manifest("acme.no-operation", [operationDescriptor("run")]), "Operation run"],
                [manifest("acme.no-surface", [], [], [surfaceDescriptor]), "Surface dashboard"],
                [manifest("acme.no-interceptor", [], [guard]), "Interceptor guard"]
            ] as const;
            for (const [pinned, subject] of cases) {
                expect(() =>
                    new FacetCorrespondenceValidator().validate(
                        [pinned],
                        [new TestFacet("workspace:absent", pinned)]
                    )
                ).toThrowError(
                    expect.objectContaining({
                        code: "facet.inactive",
                        message: `${subject} has no runtime implementation`
                    })
                );
            }
        }
    );

    test(
        "rejects a runtime declaration that differs from its pinned bytes at a single position",
        { tags: "p0" },
        () => {
            const declared = new OperationDescriptor(
                new OperationName("run"),
                "observe",
                objectSchema,
                objectSchema,
                "aa"
            );
            const implemented = new OperationDescriptor(
                new OperationName("run"),
                "observe",
                objectSchema,
                objectSchema,
                "ab"
            );
            expect(OperationDescriptor.encode(implemented).byteLength).toBe(
                OperationDescriptor.encode(declared).byteLength
            );
            const pinned = manifest("acme.drifted", [declared]);
            const facet = new TestFacet(
                "workspace:drifted",
                pinned,
                [],
                new Map([["run", new TestOperation(implemented, async (input) => input)]])
            );
            expect(() =>
                new FacetCorrespondenceValidator().validate([pinned], [facet])
            ).toThrowError(
                expect.objectContaining({
                    code: "facet.inactive",
                    message: "Operation run does not match its declaration"
                })
            );
        }
    );

    test(
        "disposes an inactive host and continues stopping after a hook failure",
        { tags: "p1" },
        async () => {
            const inactiveHost = new FacetRuntimeHost([], []);
            expect(inactiveHost.active).toBe(false);
            expect(inactiveHost.facet(facetRef("workspace:missing"))).toBeUndefined();
            expect(inactiveHost.facets()).toEqual([]);
            await inactiveHost[Symbol.asyncDispose]();
            const explicitValidatorHost = new FacetRuntimeHost(
                [],
                [],
                new FacetCorrespondenceValidator()
            );
            await explicitValidatorHost.activate();
            await explicitValidatorHost.dispose();
            await expect(inactiveHost.activate()).rejects.toMatchObject({ code: "facet.inactive" });

            const stopped: string[] = [];
            const firstManifest = manifest("acme.first", []);
            const secondManifest = manifest("acme.second", []);
            const first = new TestFacet(
                "workspace:first",
                firstManifest,
                [],
                new Map(),
                new Map(),
                async () => {},
                async () => {
                    throw new TypeError("stop failed");
                }
            );
            const second = new TestFacet(
                "workspace:second",
                secondManifest,
                [],
                new Map(),
                new Map(),
                async () => {},
                async () => {
                    stopped.push("second");
                }
            );
            const host = new FacetRuntimeHost([firstManifest, secondManifest], [first, second]);
            await host.activate();
            expect(host.active).toBe(true);
            expect(host.facet(first.ref)?.ref.equals(first.ref)).toBe(true);
            await expect(host.dispose()).rejects.toMatchObject({ code: "facet.inactive" });
            expect(stopped).toEqual(["second"]);
        }
    );

    test(
        "rolls back already-started Facets after a later start hook fails",
        { tags: "p1" },
        async () => {
            const order: string[] = [];
            const firstManifest = manifest("acme.first", []);
            const secondManifest = manifest("acme.second", []);
            const first = new TestFacet(
                "workspace:first",
                firstManifest,
                [],
                new Map(),
                new Map(),
                async () => {
                    order.push("start:first");
                },
                async () => {
                    order.push("stop:first");
                }
            );
            const second = new TestFacet(
                "workspace:second",
                secondManifest,
                [],
                new Map(),
                new Map(),
                async () => {
                    throw new TypeError("start failed");
                }
            );
            const host = new FacetRuntimeHost([firstManifest, secondManifest], [first, second]);

            await expect(host.activate()).rejects.toMatchObject({ code: "facet.inactive" });
            expect(order).toEqual(["start:first", "stop:first"]);
            expect(host.active).toBe(false);
            await host.dispose();
        }
    );

    test(
        "rejects every malformed runtime forest and duplicate declaration shape",
        { tags: "p2" },
        () => {
            const validator = new FacetCorrespondenceValidator();
            const emptyManifest = manifest("acme.empty", []);
            const empty = new TestFacet("workspace:empty", emptyManifest);
            expect(() => validator.validate([], [empty])).toThrow(/pinned manifest/);
            expect(() => validator.validate([emptyManifest], [])).toThrow(/omits/);
            expect(() => validator.validate([emptyManifest], [empty, empty])).toThrow(
                /more than once/
            );

            const sameRefManifest = manifest("acme.other", []);
            const sameRef = new TestFacet("workspace:empty", sameRefManifest);
            expect(() =>
                validator.validate([emptyManifest, sameRefManifest], [empty, sameRef])
            ).toThrow(/Duplicate Facet reference/);
            expect(() => validator.validate([emptyManifest, emptyManifest], [empty])).toThrow(
                /duplicate/
            );
            const emptyManifestData = emptyManifest.toData() as {
                readonly [key: string]: FacetData;
            };
            const otherVersion = FacetManifest.fromData({ ...emptyManifestData, version: "2.0.0" });
            expect(() => validator.validate([emptyManifest, otherVersion], [empty])).toThrow(
                /multiple versions/
            );

            const operation = operationDescriptor("run");
            const duplicateOperation = manifest("acme.operations", [operation, operation]);
            const operationFacet = new TestFacet(
                "workspace:operations",
                duplicateOperation,
                [],
                new Map([["run", new TestOperation(operation, async (input) => input)]])
            );
            expect(() => validator.validate([duplicateOperation], [operationFacet])).toThrow(
                /more than once/
            );

            const surface = new SurfaceDescriptor(new SurfaceId("surface"), "Surface");
            const surfaceManifest = manifest("acme.missing-surface", [], [], [surface]);
            expect(() =>
                validator.validate(
                    [surfaceManifest],
                    [new TestFacet("workspace:missing-surface", surfaceManifest)]
                )
            ).toThrow(/no runtime implementation/);

            const interceptor = new InterceptorDeclaration(
                new InterceptorId("required"),
                "operation.before",
                1
            );
            const interceptorManifest = manifest("acme.missing-interceptor", [], [interceptor]);
            expect(() =>
                validator.validate(
                    [interceptorManifest],
                    [new TestFacet("workspace:missing-interceptor", interceptorManifest)]
                )
            ).toThrow(/no runtime implementation/);
        }
    );

    test(
        "cancels startup immediately and retries failed cleanup before disposal",
        { tags: "p1" },
        async () => {
            const cancellationManifest = manifest("acme.cancel", []);
            let started!: () => void;
            let reentrantDisposal: Promise<void> | undefined;
            let cancelling!: FacetRuntimeHost;
            const entered = new Promise<void>((resolve) => {
                started = resolve;
            });
            const cancellationFacet = new TestFacet(
                "workspace:cancel",
                cancellationManifest,
                [],
                new Map(),
                new Map(),
                (context) =>
                    new Promise<void>((resolve) => {
                        started();
                        context.signal.addEventListener(
                            "abort",
                            () => {
                                reentrantDisposal = cancelling.dispose();
                                resolve();
                            },
                            { once: true }
                        );
                    })
            );
            cancelling = new FacetRuntimeHost([cancellationManifest], [cancellationFacet]);
            const activation = cancelling.activate();
            await entered;
            const disposal = cancelling.dispose();
            expect(reentrantDisposal).toBe(disposal);
            await expect(cancelling.activate()).rejects.toMatchObject({ code: "facet.inactive" });
            await expect(activation).rejects.toMatchObject({ code: "facet.inactive" });
            await disposal;

            const cleanupManifest = manifest("acme.cleanup", []);
            let failStop = true;
            const cleanupFacet = new TestFacet(
                "workspace:cleanup",
                cleanupManifest,
                [],
                new Map(),
                new Map(),
                async () => {},
                async () => {
                    if (failStop) {
                        failStop = false;
                        throw new TypeError("first stop fails");
                    }
                }
            );
            const cleanup = new FacetRuntimeHost([cleanupManifest], [cleanupFacet]);
            await cleanup.activate();
            await expect(cleanup.dispose()).rejects.toMatchObject({ code: "facet.inactive" });
            await expect(cleanup.activate()).rejects.toMatchObject({ code: "facet.inactive" });
            await cleanup.dispose();
            await cleanup.dispose();
        }
    );

    test(
        "uses idempotent runtime leases and fences rollback cleanup failures",
        { tags: "p0" },
        async () => {
            const leaseManifest = manifest("acme.lease", []);
            const leaseFacet = new TestFacet("workspace:lease", leaseManifest);
            const leaseHost = new FacetRuntimeHost([leaseManifest], [leaseFacet]);
            await leaseHost.activate();
            const validated = leaseHost.facet(leaseFacet.ref)!;
            expect(leaseHost.acquire(facetRef("workspace:missing"), validated)).toBeUndefined();
            const lease = leaseHost.acquire(leaseFacet.ref, validated)!;
            lease.release();
            lease.release();
            await leaseHost.dispose();

            const firstManifest = manifest("acme.rollback", []);
            const failingManifest = manifest("acme.failure", []);
            let stopFails = true;
            const first = new TestFacet(
                "workspace:rollback",
                firstManifest,
                [],
                new Map(),
                new Map(),
                async () => {},
                async () => {
                    if (stopFails) {
                        stopFails = false;
                        throw new TypeError("rollback cleanup failed");
                    }
                }
            );
            const failing = new TestFacet(
                "workspace:failure",
                failingManifest,
                [],
                new Map(),
                new Map(),
                async () => {
                    throw "non-error start failure";
                }
            );
            const host = new FacetRuntimeHost([firstManifest, failingManifest], [first, failing]);
            await expect(host.activate()).rejects.toThrow(/rollback stop hook/);
            await expect(host.activate()).rejects.toThrow(/requires cleanup/);
            await host.dispose();
        }
    );

    test("reports no facets while a never-activated host is stopping", { tags: "p1" }, async () => {
        const host = new FacetRuntimeHost([], []);
        const disposal = host.dispose();
        expect(host.facets()).toEqual([]);
        expect(host.facet(facetRef("workspace:missing"))).toBeUndefined();
        await disposal;
    });

    test(
        "holds disposal until an in-flight activation transition settles",
        { tags: "p1" },
        async () => {
            const stops: string[] = [];
            let releaseStart!: () => void;
            let entered!: () => void;
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const startGate = new Promise<void>((resolve) => {
                releaseStart = resolve;
            });
            const blockedManifest = manifest("acme.blocked", []);
            const facet = new TestFacet(
                "workspace:blocked",
                blockedManifest,
                [],
                new Map(),
                new Map(),
                async () => {
                    entered();
                    await startGate;
                },
                async () => {
                    stops.push("stop");
                }
            );
            const host = new FacetRuntimeHost([blockedManifest], [facet]);
            const activation = host.activate();
            await started;
            const disposal = host.dispose();
            let disposed = false;
            void disposal.then(() => {
                disposed = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(disposed).toBe(false);
            releaseStart();
            await expect(activation).rejects.toMatchObject({ code: "facet.inactive" });
            await disposal;
            expect(stops).toEqual(["stop"]);
        }
    );

    test(
        "retries activation cleanly after a rolled-back start failure",
        { tags: "p1" },
        async () => {
            let attempts = 0;
            const retryManifest = manifest("acme.retry", []);
            const facet = new TestFacet(
                "workspace:retry",
                retryManifest,
                [],
                new Map(),
                new Map(),
                async () => {
                    attempts += 1;
                    if (attempts === 1) throw new TypeError("first start fails");
                }
            );
            const host = new FacetRuntimeHost([retryManifest], [facet]);
            await expect(host.activate()).rejects.toMatchObject({ code: "facet.inactive" });
            await host.activate();
            expect(host.active).toBe(true);
            expect(attempts).toBe(2);
            await host.dispose();
        }
    );

    test(
        "hands a dispose call racing a cancelled start the same disposal transition",
        { tags: "p1" },
        async () => {
            let entered!: () => void;
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const racingManifest = manifest("acme.racing", []);
            const facet = new TestFacet(
                "workspace:racing",
                racingManifest,
                [],
                new Map(),
                new Map(),
                (context) => {
                    entered();
                    if (context.signal.aborted) return Promise.reject(new TypeError("cancelled"));
                    return new Promise((_resolve, reject) => {
                        context.signal.addEventListener(
                            "abort",
                            () => reject(new TypeError("cancelled")),
                            { once: true }
                        );
                    });
                }
            );
            const host = new FacetRuntimeHost([racingManifest], [facet]);
            const activation = host.activate();
            await started;
            const first = host.dispose();
            let second: Promise<void> | undefined;
            // The rejection handler runs while the disposal transition is still stopping,
            // so this dispose call must observe the same in-flight transition promise.
            await activation.then(
                () => {
                    throw new TypeError("activation must fail");
                },
                () => {
                    second = host.dispose();
                }
            );
            expect(second).toBe(first);
            await first;
        }
    );

    test(
        "never restarts Facets while a cancelled activation is being disposed",
        { tags: "p1" },
        async () => {
            let startCalls = 0;
            let entered!: () => void;
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const cancelledManifest = manifest("acme.cancel-restart", []);
            const facet = new TestFacet(
                "workspace:cancel-restart",
                cancelledManifest,
                [],
                new Map(),
                new Map(),
                (context) => {
                    startCalls += 1;
                    entered();
                    if (context.signal.aborted) return Promise.reject(new TypeError("cancelled"));
                    return new Promise((_resolve, reject) => {
                        context.signal.addEventListener(
                            "abort",
                            () => reject(new TypeError("cancelled")),
                            { once: true }
                        );
                    });
                }
            );
            const host = new FacetRuntimeHost([cancelledManifest], [facet]);
            const activation = host.activate();
            await started;
            const disposal = host.dispose();
            await expect(activation.catch(() => host.activate())).rejects.toMatchObject({
                code: "facet.inactive"
            });
            await disposal;
            expect(startCalls).toBe(1);
        }
    );

    test(
        "retries failed stop hooks on the next disposal without restarting",
        { tags: "p1" },
        async () => {
            let startCalls = 0;
            let stopCalls = 0;
            let failStop = true;
            const cleanupManifest = manifest("acme.cleanup-retry", []);
            const facet = new TestFacet(
                "workspace:cleanup-retry",
                cleanupManifest,
                [],
                new Map(),
                new Map(),
                async () => {
                    startCalls += 1;
                },
                async () => {
                    stopCalls += 1;
                    if (failStop) {
                        failStop = false;
                        throw new TypeError("stop fails once");
                    }
                }
            );
            const host = new FacetRuntimeHost([cleanupManifest], [facet]);
            await host.activate();
            await expect(host.dispose()).rejects.toMatchObject({ code: "facet.inactive" });
            expect(stopCalls).toBe(1);
            await expect(host.activate()).rejects.toMatchObject({ code: "facet.inactive" });
            expect(startCalls).toBe(1);
            await host.dispose();
            expect(stopCalls).toBe(2);
            await host.dispose();
            expect(stopCalls).toBe(2);
        }
    );

    test(
        "hides Facets and holds the drain while runtime leases remain outstanding",
        { tags: "p1" },
        async () => {
            const stops: string[] = [];
            const drainingManifest = manifest("acme.draining", []);
            const facet = new TestFacet(
                "workspace:draining",
                drainingManifest,
                [],
                new Map(),
                new Map(),
                async () => {},
                async () => {
                    stops.push("stop");
                }
            );
            const host = new FacetRuntimeHost([drainingManifest], [facet]);
            await host.activate();
            const validated = host.facet(facet.ref)!;
            const first = host.acquire(facet.ref, validated)!;
            const second = host.acquire(facet.ref, validated)!;
            const disposal = host.dispose();
            expect(host.facet(facet.ref)).toBeUndefined();
            first.release();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(stops).toEqual([]);
            second.release();
            await disposal;
            expect(stops).toEqual(["stop"]);
        }
    );

    test("rolls back a failed activation in reverse start order", { tags: "p1" }, async () => {
        const stops: string[] = [];
        const firstManifest = manifest("acme.reverse-first", []);
        const secondManifest = manifest("acme.reverse-second", []);
        const first = new TestFacet(
            "workspace:reverse-first",
            firstManifest,
            [],
            new Map(),
            new Map(),
            async () => {},
            async () => {
                stops.push("stop:first");
            }
        );
        const second = new TestFacet(
            "workspace:reverse-second",
            secondManifest,
            [],
            new Map(),
            new Map(),
            async () => {
                throw new TypeError("start failed");
            },
            async () => {
                stops.push("stop:second");
            }
        );
        const host = new FacetRuntimeHost([firstManifest, secondManifest], [first, second]);
        await expect(host.activate()).rejects.toMatchObject({ code: "facet.inactive" });
        expect(stops).toEqual(["stop:second", "stop:first"]);
        await host.dispose();
    });
});

describe("Protected Operation gateway", () => {
    test(
        "executes direct only after synchronous authorization and rejects hidden handlers",
        { tags: "p0" },
        async () => {
            const events: string[] = [];
            const descriptor = operationDescriptor("run");
            const runtime = new TestOperation(descriptor, async (input) => {
                events.push("execute");
                return { ...requireObject(input), complete: true };
            });
            const hidden = new TestOperation(operationDescriptor("hidden"), async (input) => input);
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([
                    ["run", runtime],
                    ["hidden", hidden]
                ]),
                new Map()
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const authority = new TestAuthority(events, "direct");
            const invocations = new TestInvocations(events);
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                authority,
                invocations
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));

            const result = await resolved.dispatch({
                requestKey: new OperationRequestKey("request-1"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: { value: 1 } }
            });
            expect(result).toEqual({ kind: "direct", output: { complete: true, value: 1 } });
            expect(events).toEqual(["resolve", "authorize:direct", "context:direct", "execute"]);
            expect(resolved.descriptor(new OperationName("hidden"))).toBeUndefined();
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("request-hidden"),
                    operation: new OperationName("hidden"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "operation.missing" });
            await host.dispose();
        }
    );

    test(
        "dispatches only through implementation identities captured before start",
        { tags: "p0" },
        async () => {
            const calls: string[] = [];
            const descriptor = operationDescriptor("run");
            const implementation = new TestOperation(descriptor, async (input) => {
                calls.push("validated");
                return input;
            });
            const operations = new Map<string, Operation>([["run", implementation]]);
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                operations,
                new Map(),
                async () => {
                    (implementation as { descriptor: OperationDescriptor }).descriptor =
                        operationDescriptor("run", "mutate");
                    operations.set(
                        "run",
                        new TestOperation(descriptor, async (input) => {
                            calls.push("substituted");
                            return input;
                        })
                    );
                }
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            expect(resolved.descriptor(new OperationName("run"))?.impact).toBe("observe");

            await resolved.dispatch({
                requestKey: new OperationRequestKey("captured"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: {} }
            });
            expect(calls).toEqual(["validated"]);
            await host.dispose();
        }
    );

    test(
        "[C13-ADV-POST-PREPARATION-INTERCEPTOR] routes mediated effects through the invocation port with frozen interceptor traces",
        { tags: "p0" },
        async () => {
            const events: string[] = [];
            const descriptor = operationDescriptor("run", "mutate", true);
            const runtime = new TestOperation(descriptor, async (input) => {
                events.push("execute");
                return input;
            });
            const declaration = new InterceptorDeclaration(
                new InterceptorId("rewrite"),
                "operation.before",
                OperationSelector.own("run"),
                10
            );
            const afterDeclaration = new InterceptorDeclaration(
                new InterceptorId("present"),
                "operation.after",
                OperationSelector.own("run"),
                20
            );
            const interceptor = new TestInterceptor(declaration, (value) => ({
                proceed: true,
                value: { ...requireObject(value), rewritten: true }
            }));
            const afterInterceptor = new TestInterceptor(afterDeclaration, (value) => ({
                proceed: true,
                value: { ...requireObject(value), presented: true }
            }));
            const facetManifest = manifest(
                "acme.runtime",
                [descriptor],
                [declaration, afterDeclaration]
            );
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", runtime]]),
                new Map([
                    ["rewrite", interceptor],
                    ["present", afterInterceptor]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const authority = new TestAuthority(events, "mediated");
            const invocations = new TestInvocations(events);
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                authority,
                invocations
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));

            const result = await resolved.dispatch({
                requestKey: new OperationRequestKey("request-2"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: { value: 1 } }
            });
            expect(result).toEqual({
                kind: "mediated",
                output: { presented: true, rewritten: true, value: 1 },
                evidence: { receipt: "recorded" }
            });
            expect(invocations.lastRequest?.interceptions[0]).toHaveLength(1);
            expect(invocations.lastRequest?.inputs).toEqual([{ rewritten: true, value: 1 }]);
            expect(invocations.presentationTraces).toHaveLength(1);
            expect(events).toEqual(["resolve", "authorize:mediated", "invoke", "execute"]);
            await host.dispose();
        }
    );

    test("rejects invalid command arguments and missing mapping sources", { tags: "p1" }, () => {
        const passthrough = new Command({
            name: "run",
            title: "Run",
            arguments: new JsonSchema({
                type: "object",
                required: ["value"],
                properties: { value: {} }
            }),
            operation: new OperationRef("acme.runtime:run"),
            binding: new BindingName("runtime"),
            surfaces: [new SlotName("palette")]
        });
        const mapped = new Command({
            name: "mapped",
            title: "Mapped",
            arguments: objectSchema,
            operation: new OperationRef("acme.runtime:run"),
            binding: new BindingName("runtime"),
            mapping: new FieldMapping([new FieldMove("/value", { from: "/missing" })]),
            surfaces: [new SlotName("palette")]
        });
        const runtime = new CommandRuntime();

        expect(runtime.bind(passthrough, { value: 1 })).toEqual({ value: 1 });
        expect(() => runtime.bind(passthrough, {})).toThrow(/arguments/);
        expect(() => runtime.bind(mapped, {})).toThrow(/source/);
    });

    test(
        "applies root, literal, nested, and array command mappings strictly",
        { tags: "p1" },
        () => {
            const runtime = new CommandRuntime();
            const command = (moves: readonly FieldMove[]) =>
                new Command({
                    name: "mapped",
                    title: "Mapped",
                    arguments: objectSchema,
                    operation: new OperationRef("acme.runtime:run"),
                    binding: new BindingName("runtime"),
                    mapping: new FieldMapping(moves),
                    surfaces: [new SlotName("palette")]
                });

            expect(
                runtime.bind(command([new FieldMove("", { from: "/payload" })]), {
                    payload: { copied: true }
                })
            ).toEqual({ copied: true });
            expect(
                runtime.bind(
                    command([
                        new FieldMove("/nested/value", { from: "/values/0" }),
                        new FieldMove("/nested/literal", { literal: 7 })
                    ]),
                    { values: ["first"] }
                )
            ).toEqual({
                nested: { literal: 7, value: "first" }
            });
            expect(() =>
                runtime.bind(
                    command([
                        new FieldMove("", { literal: 1 }),
                        new FieldMove("/nested", { literal: true })
                    ]),
                    {}
                )
            ).toThrow(/target/);
            expect(() =>
                runtime.bind(command([new FieldMove("/value", { from: "/values/not-an-index" })]), {
                    values: [1]
                })
            ).toThrow(/array index/);
            expect(() =>
                runtime.bind(command([new FieldMove("/value", { from: "/values/2" })]), {
                    values: [1]
                })
            ).toThrow(/bounds/);
            for (const unsafe of ["__proto__", "constructor", "prototype"]) {
                expect(() =>
                    runtime.bind(
                        command([new FieldMove(`/${unsafe}/polluted`, { literal: true })]),
                        {}
                    )
                ).toThrow(/unsafe/);
            }
            expect((Object.prototype as { readonly polluted?: unknown }).polluted).toBeUndefined();
        }
    );

    test(
        "[C13-COMMAND-ARGUMENT-BINDING] binds validated surface arguments before emitting command.invoked",
        { tags: "p1" },
        async () => {
            const descriptor = mappedOperationDescriptor();
            const runtime = new CommandRuntime();
            const command = mappedCommand();
            const installed = runtime.install({
                contributor: facetRef("workspace:commands"),
                command,
                target: { package: command.operation.facet, descriptor }
            });
            const events = new TestCommandEvents();

            const invoked = await runtime.invoke(
                installed,
                { amount: 7 },
                { surface: new SurfaceId("palette") },
                events
            );
            expect(invoked.id).toBe("command-event-1");
            expect(events.records).toHaveLength(1);
            expect(events.records[0]).toMatchObject({
                kind: "command.invoked",
                payload: { input: { count: 7 } }
            });

            await expect(
                runtime.invoke(
                    installed,
                    { amount: "7" },
                    { surface: new SurfaceId("palette") },
                    events
                )
            ).rejects.toMatchObject({ code: "operation.invalid-input" });
            expect(events.records).toHaveLength(1);
        }
    );

    test(
        "[C13-COMMAND-INSTALL-MAPPING] rejects incompatible mappings before registering a command",
        { tags: "p1" },
        () => {
            const runtime = new CommandRuntime();
            const descriptor = mappedOperationDescriptor();
            const invalid = mappedCommand({
                mapping: new FieldMapping([new FieldMove("/count", { from: "/missing" })])
            });

            expect(() =>
                runtime.install({
                    contributor: facetRef("workspace:commands"),
                    command: invalid,
                    target: { package: invalid.operation.facet, descriptor }
                })
            ).toThrow(/mapping source/);
            const valid = mappedCommand();
            expect(
                runtime.install({
                    contributor: facetRef("workspace:commands"),
                    command: valid,
                    target: { package: valid.operation.facet, descriptor }
                }).id
            ).toBe("acme.runtime:run");

            const wrongLiteral = mappedCommand({
                name: "literal",
                mapping: new FieldMapping([new FieldMove("/count", { literal: "seven" })])
            });
            expect(() =>
                runtime.install({
                    contributor: facetRef("workspace:literals"),
                    command: wrongLiteral,
                    target: { package: wrongLiteral.operation.facet, descriptor }
                })
            ).toThrow(/literal/);
        }
    );

    test(
        "[C13-COMMAND-COLLISION] rejects later same-scope surface collisions atomically",
        { tags: "p1" },
        () => {
            const runtime = new CommandRuntime();
            const descriptor = mappedOperationDescriptor();
            const first = mappedCommand();
            runtime.install({
                contributor: facetRef("workspace:first"),
                command: first,
                target: { package: first.operation.facet, descriptor }
            });
            const conflicting = mappedCommand({ operation: new OperationRef("other.runtime:run") });

            expect(() =>
                runtime.install({
                    contributor: facetRef("workspace:second"),
                    command: conflicting,
                    target: { package: conflicting.operation.facet, descriptor }
                })
            ).toThrow(/conflicts in surface/);
            expect(
                runtime.install({
                    contributor: facetRef("other:second"),
                    command: conflicting,
                    target: { package: conflicting.operation.facet, descriptor }
                }).scope
            ).toBe("other");
        }
    );

    test(
        "[C13-COMMAND-SUBSCRIPTION-DEFAULTS] derives only the fixed command Subscription defaults",
        { tags: "p1" },
        () => {
            const runtime = new CommandRuntime();
            const command = mappedCommand();
            const installed = runtime.install({
                contributor: facetRef("workspace:commands"),
                command,
                target: {
                    package: command.operation.facet,
                    descriptor: mappedOperationDescriptor()
                }
            });

            expect(installed.subscription.source.toData()).toEqual({
                acceptedTrust: ["owner", "authenticated", "self"],
                kind: "command.invoked",
                source: "acme.runtime:run"
            });
            expect(installed.subscription.target.equals(command.operation)).toBe(true);
            expect(installed.subscription.mapping?.toData()).toEqual([{ from: "/input", to: "" }]);
            expect(installed.subscription.dedupe).toBe("event");
            expect(installed.subscription.authority).toBe("initiator");
            expect(installed.subscription.binding.equals(command.binding)).toBe(true);
        }
    );

    test(
        "[C13-COMMAND-RESULT] emits command.invoked carrying the surface and run correlation for completion",
        { tags: "p1" },
        async () => {
            const descriptor = mappedOperationDescriptor();
            const runtime = new CommandRuntime();
            const command = mappedCommand();
            const installed = runtime.install({
                contributor: facetRef("workspace:commands"),
                command,
                target: { package: command.operation.facet, descriptor }
            });
            const events = new TestCommandEvents();
            const origin = Object.freeze({
                surface: new SurfaceId("palette"),
                run: Object.freeze({ run: "run-1", branch: "main" })
            });

            const first = await runtime.invoke(installed, { amount: 1 }, origin, events);
            const second = await runtime.invoke(installed, { amount: 2 }, origin, events);

            expect(first.id).toBe("command-event-1");
            expect(second.id).toBe("command-event-2");
            expect(events.records).toMatchObject([
                {
                    id: "command-event-1",
                    kind: "command.invoked",
                    origin,
                    payload: { input: { count: 1 } }
                },
                {
                    id: "command-event-2",
                    kind: "command.invoked",
                    origin,
                    payload: { input: { count: 2 } }
                }
            ]);
        }
    );

    test(
        "submits one homogeneous mediated batch and invalidates resolutions on host disposal",
        { tags: "p1" },
        async () => {
            const descriptor = operationDescriptor("run", "mutate");
            const runtime = new TestOperation(descriptor, async (input) => input);
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", runtime]]),
                new Map()
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const events: string[] = [];
            const invocations = new TestInvocations(events);
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority(events, "mediated"),
                invocations
            );
            const resolved = await gateway.resolve(new BindingName("runtime"));

            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("batch-1"),
                    operation: new OperationName("run"),
                    payload: { kind: "batch", inputs: [{ item: 1 }, { item: 2 }] }
                })
            ).resolves.toEqual({
                kind: "mediated",
                output: [{ item: 1 }, { item: 2 }],
                evidence: { receipt: "recorded" }
            });
            expect(events.filter((event) => event === "invoke")).toHaveLength(1);
            expect(invocations.lastRequest?.inputs).toEqual([{ item: 1 }, { item: 2 }]);
            expect(invocations.lastRequest?.shape).toEqual({ kind: "batch", itemCount: 2 });

            await host.dispose();
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("after-dispose"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "facet.inactive" });
            resolved[Symbol.dispose]();
        }
    );

    test(
        "fails closed when a synchronous interceptor returns a Promise",
        { tags: "p1" },
        async () => {
            const execute = vi.fn(async (input: FacetData) => input);
            const descriptor = operationDescriptor("run");
            const declaration = new InterceptorDeclaration(
                new InterceptorId("async"),
                "operation.before",
                OperationSelector.own("run"),
                1
            );
            const interceptor = new TestInterceptor(
                declaration,
                (value) => Promise.resolve({ proceed: true, value }) as unknown as InterceptResult
            );
            const facetManifest = manifest("acme.runtime", [descriptor], [declaration]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, execute)]]),
                new Map([["async", interceptor]])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));

            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("async-interceptor"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "authority.denied" });
            expect(execute).not.toHaveBeenCalled();
            await host.dispose();
        }
    );

    test("surfaces an interceptor veto as a typed scoped denial", { tags: "p1" }, async () => {
        const descriptor = operationDescriptor("run");
        const declaration = new InterceptorDeclaration(
            new InterceptorId("veto"),
            "operation.before",
            OperationSelector.own("run"),
            1
        );
        const facetManifest = manifest("acme.runtime", [descriptor], [declaration]);
        const facet = new TestFacet(
            "workspace:runtime",
            facetManifest,
            [],
            new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
            new Map([
                [
                    "veto",
                    new TestInterceptor(declaration, () => ({
                        proceed: false,
                        reason: "policy veto"
                    }))
                ]
            ])
        );
        const host = new FacetRuntimeHost([facetManifest], [facet]);
        await host.activate();
        const gateway = new OperationGatewayHost(
            { caller: "authenticated" },
            host,
            new TestAuthority([], "direct"),
            new TestInvocations([])
        );
        using resolved = await gateway.resolve(new BindingName("runtime"));

        await expect(
            resolved.dispatch({
                requestKey: new OperationRequestKey("veto"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: {} }
            })
        ).rejects.toMatchObject({ code: "authority.denied", message: "policy veto" });
        await host.dispose();
    });

    test("denies cross-Facet interception without explicit authority", { tags: "p0" }, async () => {
        const descriptor = operationDescriptor("run", "observe", true);
        const targetManifest = manifest("acme.target", [descriptor]);
        const target = new TestFacet(
            "workspace:runtime",
            targetManifest,
            [],
            new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
            new Map()
        );
        const declaration = new InterceptorDeclaration(
            new InterceptorId("cross"),
            "operation.before",
            new OperationSelector([new OperationPattern("run", new FacetPackageId("acme.target"))]),
            1
        );
        const contributorManifest = manifest("acme.policy", [], [declaration]);
        const contributor = new TestFacet(
            "workspace:policy",
            contributorManifest,
            [],
            new Map(),
            new Map([
                ["cross", new TestInterceptor(declaration, (value) => ({ proceed: true, value }))]
            ])
        );
        const host = new FacetRuntimeHost(
            [targetManifest, contributorManifest],
            [target, contributor]
        );
        await host.activate();
        const gateway = new OperationGatewayHost(
            { caller: "authenticated" },
            host,
            new TestAuthority([], "direct", false),
            new TestInvocations([])
        );
        using resolved = await gateway.resolve(new BindingName("runtime"));

        await expect(
            resolved.dispatch({
                requestKey: new OperationRequestKey("cross"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: {} }
            })
        ).rejects.toMatchObject({ code: "authority.denied" });
        await host.dispose();
    });

    test(
        "fails closed on invalid schemas, denied direct admission, and malformed mediation output",
        { tags: "p1" },
        async () => {
            const descriptor = operationDescriptor("run", "mutate");
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async () => null)]]),
                new Map()
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();

            const deniedGateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct", true, false),
                new TestInvocations([])
            );
            using denied = await deniedGateway.resolve(new BindingName("runtime"));
            await expect(
                denied.dispatch({
                    requestKey: new OperationRequestKey("invalid-input"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: null }
                })
            ).rejects.toMatchObject({ code: "operation.invalid-input" });
            await expect(
                denied.dispatch({
                    requestKey: new OperationRequestKey("direct-denied"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "authority.denied" });

            const directGateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            using direct = await directGateway.resolve(new BindingName("runtime"));
            await expect(
                direct.dispatch({
                    requestKey: new OperationRequestKey("invalid-output"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "operation.invalid-output" });

            const mediatedGateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "mediated"),
                new TestInvocations([], true)
            );
            using mediated = await mediatedGateway.resolve(new BindingName("runtime"));
            await expect(
                mediated.dispatch({
                    requestKey: new OperationRequestKey("wrong-count"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "invocation.invalid" });
            await host.dispose();
        }
    );

    test(
        "drains in-flight execution before stopping and releasing authority",
        { tags: "p1" },
        async () => {
            const events: string[] = [];
            let complete!: () => void;
            let started!: () => void;
            const startedPromise = new Promise<void>((resolve) => {
                started = resolve;
            });
            const completion = new Promise<void>((resolve) => {
                complete = resolve;
            });
            const descriptor = operationDescriptor("run", "mutate");
            const after = new InterceptorDeclaration(
                new InterceptorId("after-drain"),
                "operation.after",
                OperationSelector.own("run"),
                1
            );
            const runtime = new TestOperation(descriptor, async (input) => {
                events.push("execute");
                started();
                await completion;
                events.push("complete");
                return input;
            });
            const facetManifest = manifest("acme.runtime", [descriptor], [after]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", runtime]]),
                new Map([
                    [
                        "after-drain",
                        new TestInterceptor(after, (value) => {
                            events.push("after");
                            return { proceed: true, value };
                        })
                    ]
                ]),
                async () => {},
                async () => {
                    events.push("stop");
                }
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const authority = new TestAuthority(events, "mediated");
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                authority,
                new TestInvocations(events)
            );
            const resolved = await gateway.resolve(new BindingName("runtime"));
            const dispatch = resolved.dispatch({
                requestKey: new OperationRequestKey("drain"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: {} }
            });
            await startedPromise;
            resolved[Symbol.dispose]();
            const stopping = host.dispose();
            await Promise.resolve();
            expect(events).not.toContain("stop");
            expect(events).not.toContain("release");

            complete();
            await dispatch;
            await stopping;
            expect(events.indexOf("complete")).toBeLessThan(events.indexOf("after"));
            expect(events.indexOf("after")).toBeLessThan(events.indexOf("release"));
            expect(events.indexOf("complete")).toBeLessThan(events.indexOf("release"));
            expect(events.indexOf("release")).toBeLessThan(events.indexOf("stop"));
        }
    );

    test(
        "covers direct batches, inactive resolution, disposal idempotency, and invalid interceptor rewrites",
        { tags: "p1" },
        async () => {
            const descriptor = operationDescriptor("run", "observe", true);
            const before = new InterceptorDeclaration(
                new InterceptorId("before"),
                "operation.before",
                OperationSelector.own("run"),
                1
            );
            const after = new InterceptorDeclaration(
                new InterceptorId("after"),
                "operation.after",
                OperationSelector.own("run"),
                2
            );
            let invalidBefore = false;
            let invalidAfter = false;
            const facetManifest = manifest("acme.runtime", [descriptor], [before, after]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
                new Map([
                    [
                        "before",
                        new TestInterceptor(before, (value) => ({
                            proceed: true,
                            value: invalidBefore ? null : value
                        }))
                    ],
                    [
                        "after",
                        new TestInterceptor(after, (value) => ({
                            proceed: true,
                            value: invalidAfter ? null : value
                        }))
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const events: string[] = [];
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority(events, "direct"),
                new TestInvocations(events)
            );
            const resolved = await gateway.resolve(new BindingName("runtime"));
            expect(resolved.package.value).toBe("acme.runtime");
            expect(resolved.descriptor(new OperationName("run"))).toBeDefined();
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("direct-batch"),
                    operation: new OperationName("run"),
                    payload: { kind: "batch", inputs: [{ item: 1 }, { item: 2 }] }
                })
            ).resolves.toEqual({ kind: "direct", output: [{ item: 1 }, { item: 2 }] });
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("empty-batch"),
                    operation: new OperationName("run"),
                    payload: { kind: "batch", inputs: [] as unknown as [FacetData, ...FacetData[]] }
                })
            ).rejects.toMatchObject({ code: "invocation.invalid" });

            invalidBefore = true;
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("bad-before"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "operation.invalid-input" });
            invalidBefore = false;
            invalidAfter = true;
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("bad-after"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "operation.invalid-output" });
            resolved[Symbol.dispose]();
            resolved[Symbol.dispose]();
            expect(() => resolved.descriptor(new OperationName("run"))).toThrow(/disposed/);
            await host.dispose();

            const inactiveHost = new FacetRuntimeHost([], []);
            const inactiveGateway = new OperationGatewayHost(
                { caller: "authenticated" },
                inactiveHost,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            await expect(inactiveGateway.resolve(new BindingName("runtime"))).rejects.toMatchObject(
                {
                    code: "facet.inactive"
                }
            );
        }
    );

    test(
        "fails closed on invalid interceptor results, throws, non-interceptable cross targets, and unknown mediated items",
        { tags: "p1" },
        async () => {
            const descriptor = operationDescriptor("run", "mutate", false);
            const invalid = new InterceptorDeclaration(
                new InterceptorId("invalid"),
                "operation.before",
                OperationSelector.own("run"),
                1
            );
            let behavior: "invalid" | "throw" | "valid" = "invalid";
            const targetManifest = manifest("acme.runtime", [descriptor], [invalid]);
            const target = new TestFacet(
                "workspace:runtime",
                targetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
                new Map([
                    [
                        "invalid",
                        new TestInterceptor(invalid, (value) => {
                            if (behavior === "throw") throw "failure";
                            if (behavior === "invalid") return null as unknown as InterceptResult;
                            return { proceed: true, value };
                        })
                    ]
                ])
            );
            const host = new FacetRuntimeHost([targetManifest], [target]);
            await host.activate();
            const invocations = new TestInvocations([], false, true);
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "mediated"),
                invocations
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("invalid-interceptor"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "authority.denied" });
            behavior = "throw";
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("throw-interceptor"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "authority.denied" });
            behavior = "valid";
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("unknown-item"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "invocation.invalid" });
            await host.dispose();

            const cross = new InterceptorDeclaration(
                new InterceptorId("cross"),
                "operation.before",
                new OperationSelector([
                    new OperationPattern("run", new FacetPackageId("acme.runtime"))
                ]),
                1
            );
            const policyManifest = manifest("acme.policy", [], [cross]);
            const policy = new TestFacet(
                "workspace:policy",
                policyManifest,
                [],
                new Map(),
                new Map([
                    ["cross", new TestInterceptor(cross, (value) => ({ proceed: true, value }))]
                ])
            );
            const crossHost = new FacetRuntimeHost(
                [targetManifest, policyManifest],
                [target, policy]
            );
            await crossHost.activate();
            const crossGateway = new OperationGatewayHost(
                { caller: "authenticated" },
                crossHost,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            using crossResolved = await crossGateway.resolve(new BindingName("runtime"));
            await expect(
                crossResolved.dispatch({
                    requestKey: new OperationRequestKey("not-interceptable"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "authority.denied" });
            await crossHost.dispose();
        }
    );

    test(
        "binds payload shape into direct and mediated identities and returns replay without rerunning interceptors",
        { tags: "p0" },
        async () => {
            let interceptions = 0;
            let executions = 0;
            const descriptor = operationDescriptor("run", "mutate");
            const declaration = new InterceptorDeclaration(
                new InterceptorId("count"),
                "operation.before",
                OperationSelector.own("run"),
                1
            );
            const facetManifest = manifest("acme.runtime", [descriptor], [declaration]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([
                    [
                        "run",
                        new TestOperation(descriptor, async (input) => {
                            executions += 1;
                            return input;
                        })
                    ]
                ]),
                new Map([
                    [
                        "count",
                        new TestInterceptor(declaration, (value) => {
                            interceptions += 1;
                            return { proceed: true, value };
                        })
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const invocations = new TestInvocations([]);
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "mediated"),
                invocations
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            await resolved.dispatch({
                requestKey: new OperationRequestKey("shape"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: { value: 1 } }
            });
            expect(invocations.preflights[0]?.shape).toEqual({ kind: "single" });
            expect(interceptions).toBe(1);
            expect(executions).toBe(1);

            invocations.replay = {
                kind: "mediated",
                output: [{ replayed: true }],
                evidence: { receipt: "existing" }
            };
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("shape"),
                    operation: new OperationName("run"),
                    payload: { kind: "batch", inputs: [{ value: 1 }] }
                })
            ).resolves.toEqual({
                kind: "mediated",
                output: [{ replayed: true }],
                evidence: { receipt: "existing" }
            });
            expect(invocations.preflights[1]?.shape).toEqual({ kind: "batch", itemCount: 1 });
            expect(interceptions).toBe(1);
            expect(executions).toBe(1);

            invocations.replay = { kind: "direct", output: {} };
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("bad-replay-tier"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "invocation.invalid" });
            invocations.replay = {
                kind: "mediated",
                output: [],
                evidence: {}
            };
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("bad-replay-shape"),
                    operation: new OperationName("run"),
                    payload: { kind: "batch", inputs: [{}] }
                })
            ).rejects.toMatchObject({ code: "invocation.invalid" });
            await host.dispose();
        }
    );

    test(
        "[C13-INTERCEPTOR-ATTRIBUTION] persists attributable pre-preparation rewrite evidence",
        { tags: "p1" },
        async () => {
            const before = new InterceptorDeclaration(
                new InterceptorId("attribute"),
                "operation.before",
                OperationSelector.own("run"),
                1
            );
            const after = new InterceptorDeclaration(
                new InterceptorId("present"),
                "operation.after",
                OperationSelector.own("run"),
                2
            );
            const descriptor = operationDescriptor("run", "mutate");
            const facetManifest = manifest("acme.runtime", [descriptor], [before, after]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([
                    [
                        "run",
                        new TestOperation(descriptor, async (input) => ({
                            ...requireObject(input),
                            effected: true
                        }))
                    ]
                ]),
                new Map([
                    [
                        "attribute",
                        new TestInterceptor(before, (value) => ({
                            proceed: true,
                            value: { ...requireObject(value), attributed: true }
                        }))
                    ],
                    [
                        "present",
                        new TestInterceptor(after, (value) => ({
                            proceed: true,
                            value: { ...requireObject(value), presented: true }
                        }))
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const transactions = new DurableTransactions();
            const persistence = new MemoryInvocationMediationPersistence();
            const batch = new DurableBatch(new InvocationId("attribution-invocation"));
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "mediated"),
                durableInvocations(transactions, persistence, batch)
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));

            await resolved.dispatch({
                requestKey: new OperationRequestKey("attribution"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: { value: 1 } }
            });
            const replay = transactions.inspect((state) =>
                persistence.replay(state, "operation-conformance", "attribution")
            )!;
            expect(replay.items[0]?.preparedArguments).toEqual({ attributed: true, value: 1 });
            expect(replay.items[0]?.presentation).toEqual({
                attributed: true,
                effected: true,
                presented: true,
                value: 1
            });
            expect(replay.items[0]?.before).toMatchObject([
                {
                    interceptor: "attribute",
                    contributor: "workspace:runtime",
                    cutPoint: "operation.before",
                    outcome: "rewritten"
                }
            ]);
            expect(
                replay.items[0]?.before?.[0]?.before.equals(replay.items[0]!.before![0]!.after)
            ).toBe(false);
            expect(Object.isFrozen(replay.items[0]?.before)).toBe(true);
            await host.dispose();
        }
    );

    test(
        "[C13-INTERCEPTOR-FROZEN-RETRY] retries a frozen intent without rerunning its mutating interceptor",
        { tags: "p0" },
        async () => {
            let interceptions = 0;
            let executions = 0;
            const declaration = new InterceptorDeclaration(
                new InterceptorId("freeze"),
                "operation.before",
                OperationSelector.own("run"),
                1
            );
            const descriptor = operationDescriptor("run", "mutate");
            const facetManifest = manifest("acme.runtime", [descriptor], [declaration]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([
                    [
                        "run",
                        new TestOperation(descriptor, async (input) => {
                            executions += 1;
                            return input;
                        })
                    ]
                ]),
                new Map([
                    [
                        "freeze",
                        new TestInterceptor(declaration, (value) => {
                            interceptions += 1;
                            return {
                                proceed: true,
                                value: { ...requireObject(value), frozen: interceptions }
                            };
                        })
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const transactions = new DurableTransactions();
            const batch = new DurableBatch(new InvocationId("frozen-retry-invocation"), 1);
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "mediated"),
                durableInvocations(transactions, new MemoryInvocationMediationPersistence(), batch)
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            const request = {
                requestKey: new OperationRequestKey("frozen-retry"),
                operation: new OperationName("run"),
                payload: { kind: "single" as const, input: { value: 1 } }
            };

            await expect(resolved.dispatch(request)).rejects.toThrow("injected mediation crash");
            await expect(resolved.dispatch(request)).resolves.toMatchObject({
                kind: "mediated",
                output: { frozen: 1, value: 1 }
            });
            expect(interceptions).toBe(1);
            expect(executions).toBe(1);
            expect(batch.calls).toBe(2);
            await host.dispose();
        }
    );

    test(
        "[C13-INTERCEPTOR-REPLAY] reuses durable pre-effect and post-effect transformations without rerunning either",
        { tags: "p0" },
        async () => {
            let beforeCalls = 0;
            let afterCalls = 0;
            let executions = 0;
            const before = new InterceptorDeclaration(
                new InterceptorId("before"),
                "operation.before",
                OperationSelector.own("run"),
                1
            );
            const after = new InterceptorDeclaration(
                new InterceptorId("after"),
                "operation.after",
                OperationSelector.own("run"),
                2
            );
            const descriptor = operationDescriptor("run", "mutate");
            const facetManifest = manifest("acme.runtime", [descriptor], [before, after]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([
                    [
                        "run",
                        new TestOperation(descriptor, async (input) => {
                            executions += 1;
                            return { ...requireObject(input), effect: executions };
                        })
                    ]
                ]),
                new Map([
                    [
                        "before",
                        new TestInterceptor(before, (value) => {
                            beforeCalls += 1;
                            return {
                                proceed: true,
                                value: { ...requireObject(value), before: beforeCalls }
                            };
                        })
                    ],
                    [
                        "after",
                        new TestInterceptor(after, (value) => {
                            afterCalls += 1;
                            return {
                                proceed: true,
                                value: { ...requireObject(value), after: afterCalls }
                            };
                        })
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const persistence = new MemoryInvocationMediationPersistence();
            const initialTransactions = new DurableTransactions();
            const firstBatch = new DurableBatch(new InvocationId("durable-replay-invocation"));
            const firstGateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "mediated"),
                durableInvocations(initialTransactions, persistence, firstBatch)
            );
            const request = {
                requestKey: new OperationRequestKey("durable-replay"),
                operation: new OperationName("run"),
                payload: { kind: "single" as const, input: { value: 1 } }
            };
            using firstResolved = await firstGateway.resolve(new BindingName("runtime"));
            const first = await firstResolved.dispatch(request);
            const restartedTransactions = new DurableTransactions(initialTransactions.snapshot());
            const replayBatch = new DurableBatch(new InvocationId("must-not-be-issued"), Infinity);
            const replayGateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "mediated"),
                durableInvocations(restartedTransactions, persistence, replayBatch)
            );
            using replayResolved = await replayGateway.resolve(new BindingName("runtime"));

            await expect(replayResolved.dispatch(request)).resolves.toEqual(first);
            expect({ beforeCalls, afterCalls, executions }).toEqual({
                beforeCalls: 1,
                afterCalls: 1,
                executions: 1
            });
            expect(firstBatch.calls).toBe(1);
            expect(replayBatch.calls).toBe(0);
            const replay = restartedTransactions.inspect((state) =>
                persistence.replay(state, "operation-conformance", "durable-replay")
            )!;
            expect(replay.items[0]?.before?.map((trace) => trace.interceptor)).toEqual(["before"]);
            expect(replay.items[0]?.after?.map((trace) => trace.interceptor)).toEqual(["after"]);
            await host.dispose();
        }
    );

    test(
        "[C13-INTERCEPTOR-SELF-SCOPE] defaults an omitted selector to only the contributing Facet",
        { tags: "p1" },
        async () => {
            let calls = 0;
            const declaration = new InterceptorDeclaration(
                new InterceptorId("self-only"),
                "operation.before",
                1
            );
            const runtimeDescriptor = operationDescriptor("run", "mutate", true);
            const policyDescriptor = operationDescriptor("run", "mutate");
            const runtimeManifest = manifest("acme.runtime", [runtimeDescriptor]);
            const policyManifest = manifest("acme.policy", [policyDescriptor], [declaration]);
            const runtimeFacet = new TestFacet(
                "workspace:runtime",
                runtimeManifest,
                [],
                new Map([["run", new TestOperation(runtimeDescriptor, async (input) => input)]])
            );
            const policyFacet = new TestFacet(
                "workspace:policy",
                policyManifest,
                [],
                new Map([["run", new TestOperation(policyDescriptor, async (input) => input)]]),
                new Map([
                    [
                        "self-only",
                        new TestInterceptor(declaration, (value) => {
                            calls += 1;
                            return { proceed: true, value };
                        })
                    ]
                ])
            );
            const host = new FacetRuntimeHost(
                [runtimeManifest, policyManifest],
                [runtimeFacet, policyFacet]
            );
            await host.activate();
            const transactions = new DurableTransactions();
            const persistence = new MemoryInvocationMediationPersistence();
            const runtimeGateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "mediated"),
                durableInvocations(
                    transactions,
                    persistence,
                    new DurableBatch(new InvocationId("self-scope-runtime-invocation"))
                )
            );
            const policyGateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "mediated", true, true, true, facetRef("workspace:policy")),
                durableInvocations(
                    transactions,
                    persistence,
                    new DurableBatch(new InvocationId("self-scope-policy-invocation"))
                )
            );
            using runtimeResolved = await runtimeGateway.resolve(new BindingName("runtime"));
            using policyResolved = await policyGateway.resolve(new BindingName("policy"));

            await runtimeResolved.dispatch({
                requestKey: new OperationRequestKey("self-scope-runtime"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: {} }
            });
            expect(calls).toBe(0);
            await policyResolved.dispatch({
                requestKey: new OperationRequestKey("self-scope-policy"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: {} }
            });
            expect(calls).toBe(1);
            await host.dispose();
        }
    );

    test(
        "authorizes the current caller before returning replay evidence",
        { tags: "p0" },
        async () => {
            const descriptor = operationDescriptor("run", "mutate");
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const invocations = new TestInvocations([], false, false, {
                kind: "mediated",
                output: { replayed: true },
                evidence: { receipt: "existing" }
            });
            const gateway = new OperationGatewayHost(
                { caller: "substituted" },
                host,
                new TestAuthority([], "mediated", true, true, false),
                invocations
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));

            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("caller-substitution"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "authority.denied" });
            expect(invocations.preflights).toEqual([]);
            await host.dispose();
        }
    );

    test(
        "wraps unknown handler failures and preserves typed failures",
        { tags: "p1" },
        async () => {
            let failure: unknown = new Error("secret plugin error");
            const descriptor = operationDescriptor("run");
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([
                    [
                        "run",
                        new TestOperation(descriptor, async () => {
                            throw failure;
                        })
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("unknown-failure"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({
                code: "invocation.invalid",
                message: "Operation handler failed"
            });
            failure = new AgentCoreError("authority.denied", "typed denial");
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("typed-failure"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toBe(failure);
            await host.dispose();
        }
    );

    test(
        "orders same-priority interceptors deterministically and applies authorized wildcard targets",
        { tags: "p1" },
        async () => {
            const calls: string[] = [];
            const descriptor = operationDescriptor("run", "observe", true);
            const ownB = new InterceptorDeclaration(
                new InterceptorId("b"),
                "operation.before",
                OperationSelector.own("r*"),
                5
            );
            const ownA = new InterceptorDeclaration(
                new InterceptorId("a"),
                "operation.before",
                OperationSelector.own("run"),
                5
            );
            const targetManifest = manifest("acme.runtime", [descriptor], [ownB, ownA]);
            const target = new TestFacet(
                "workspace:runtime",
                targetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
                new Map([
                    [
                        "a",
                        new TestInterceptor(ownA, (value) => {
                            calls.push("a");
                            return { proceed: true, value };
                        })
                    ],
                    [
                        "b",
                        new TestInterceptor(ownB, (value) => {
                            calls.push("b");
                            return { proceed: true, value };
                        })
                    ]
                ])
            );
            const cross = new InterceptorDeclaration(
                new InterceptorId("cross"),
                "operation.before",
                new OperationSelector([new OperationPattern("r*", new FacetPackageId("acme.*"))]),
                5
            );
            const skipped = new InterceptorDeclaration(
                new InterceptorId("skipped"),
                "operation.before",
                new OperationSelector([
                    new OperationPattern("other", new FacetPackageId("different.*"))
                ]),
                5
            );
            const policyManifest = manifest("policy.runtime", [], [cross, skipped]);
            const policy = new TestFacet(
                "workspace:policy",
                policyManifest,
                [],
                new Map(),
                new Map([
                    [
                        "cross",
                        new TestInterceptor(cross, (value) => {
                            calls.push("cross");
                            return { proceed: true, value };
                        })
                    ],
                    ["skipped", new TestInterceptor(skipped, (value) => ({ proceed: true, value }))]
                ])
            );
            const host = new FacetRuntimeHost([targetManifest, policyManifest], [target, policy]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct", true),
                new TestInvocations([])
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));

            await resolved.dispatch({
                requestKey: new OperationRequestKey("ordered"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: {} }
            });
            expect(calls).toEqual(["a", "b", "cross"]);
            await host.dispose();
        }
    );

    test(
        "releases resolution authority exactly once for an idle disposed resolution",
        { tags: "p0" },
        async () => {
            const descriptor = operationDescriptor("run");
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
                new Map()
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const events: string[] = [];
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority(events, "direct"),
                new TestInvocations(events)
            );
            const resolved = await gateway.resolve(new BindingName("runtime"));
            expect(resolved.facet.equals(facet.ref)).toBe(true);
            expect(events.filter((event) => event === "release")).toHaveLength(0);
            resolved[Symbol.dispose]();
            expect(events.filter((event) => event === "release")).toHaveLength(1);
            resolved[Symbol.dispose]();
            expect(events.filter((event) => event === "release")).toHaveLength(1);
            await host.dispose();
        }
    );

    test(
        "holds authority release until every in-flight dispatch completes",
        { tags: "p0" },
        async () => {
            const events: string[] = [];
            const releases = (): number => events.filter((event) => event === "release").length;
            const gates = new Map<string, () => void>();
            const waiting = new Map<string, Promise<void>>();
            for (const key of ["one", "two"]) {
                waiting.set(
                    key,
                    new Promise((resolve) => {
                        gates.set(key, resolve);
                    })
                );
            }
            let bothStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                bothStarted = resolve;
            });
            let executing = 0;
            const descriptor = operationDescriptor("run");
            const runtime = new TestOperation(descriptor, async (input) => {
                executing += 1;
                if (executing === 2) bothStarted();
                await waiting.get(String(requireObject(input)["key"]));
                return input;
            });
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", runtime]]),
                new Map()
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority(events, "direct"),
                new TestInvocations(events)
            );
            const resolved = await gateway.resolve(new BindingName("runtime"));
            const first = resolved.dispatch({
                requestKey: new OperationRequestKey("in-flight-1"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: { key: "one" } }
            });
            const second = resolved.dispatch({
                requestKey: new OperationRequestKey("in-flight-2"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: { key: "two" } }
            });
            await started;
            resolved[Symbol.dispose]();
            expect(releases()).toBe(0);
            gates.get("one")!();
            await first;
            expect(releases()).toBe(0);
            gates.get("two")!();
            await second;
            expect(releases()).toBe(1);
            await host.dispose();
        }
    );

    test(
        "rejects invalid input before consulting mediated authorization",
        { tags: "p0" },
        async () => {
            const descriptor = operationDescriptor("run", "mutate");
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
                new Map()
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const events: string[] = [];
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority(events, "mediated"),
                new TestInvocations(events)
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("invalid-before-authority"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: null }
                })
            ).rejects.toMatchObject({ code: "operation.invalid-input" });
            expect(events).toEqual(["resolve"]);
            await host.dispose();
        }
    );

    test(
        "rejects invalid raw output before after-interceptors can repair it",
        { tags: "p0" },
        async () => {
            const descriptor = operationDescriptor("run");
            const declaration = new InterceptorDeclaration(
                new InterceptorId("repair"),
                "operation.after",
                OperationSelector.own("run"),
                1
            );
            let repairs = 0;
            const facetManifest = manifest("acme.runtime", [descriptor], [declaration]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async () => null)]]),
                new Map([
                    [
                        "repair",
                        new TestInterceptor(declaration, () => {
                            repairs += 1;
                            return { proceed: true, value: {} };
                        })
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("invalid-raw-output"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "operation.invalid-output" });
            expect(repairs).toBe(0);
            await host.dispose();
        }
    );

    test(
        "refuses descriptors once the host no longer runs the resolved Facet",
        { tags: "p1" },
        async () => {
            const descriptor = operationDescriptor("run");
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
                new Map()
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            const resolved = await gateway.resolve(new BindingName("runtime"));
            expect(resolved.descriptor(new OperationName("run"))).toBeDefined();
            await host.dispose();
            expect(() => resolved.descriptor(new OperationName("run"))).toThrowError(
                expect.objectContaining({ code: "facet.inactive" })
            );
            resolved[Symbol.dispose]();
        }
    );

    test(
        "rejects payloads with an unknown kind or non-array batch inputs",
        { tags: "p0" },
        async () => {
            const descriptor = operationDescriptor("run");
            const facetManifest = manifest("acme.runtime", [descriptor]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
                new Map()
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("bogus-kind"),
                    operation: new OperationName("run"),
                    payload: { kind: "bogus", inputs: [{}] } as unknown as OperationPayload
                })
            ).rejects.toMatchObject({ code: "invocation.invalid" });
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("non-array-batch"),
                    operation: new OperationName("run"),
                    payload: { kind: "batch", inputs: "ab" } as unknown as OperationPayload
                })
            ).rejects.toMatchObject({ code: "invocation.invalid" });
            await host.dispose();
        }
    );

    test(
        "records attributable direct interception evidence for both cut points",
        { tags: "p0" },
        async () => {
            class EvidenceInvocations extends TestInvocations {
                public readonly evidence: OperationInterceptionEvidence[] = [];

                public override recordDirectInterceptions(
                    evidence: OperationInterceptionEvidence
                ): void {
                    this.evidence.push(evidence);
                }
            }
            const descriptor = operationDescriptor("run");
            const declaration = new InterceptorDeclaration(
                new InterceptorId("rewrite"),
                "operation.before",
                OperationSelector.own("run"),
                1
            );
            const facetManifest = manifest("acme.runtime", [descriptor], [declaration]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
                new Map([
                    [
                        "rewrite",
                        new TestInterceptor(declaration, (value) => ({
                            proceed: true,
                            value: { ...requireObject(value), rewritten: true }
                        }))
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const invocations = new EvidenceInvocations([]);
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                invocations
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            await resolved.dispatch({
                requestKey: new OperationRequestKey("evidence"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: { value: 1 } }
            });
            expect(invocations.evidence).toHaveLength(2);
            const [prepared, presented] = invocations.evidence;
            expect(prepared?.requestKey.value).toBe("evidence");
            expect(prepared?.facet.value).toBe("workspace:runtime");
            expect(prepared?.descriptor.name.value).toBe("run");
            expect(prepared?.shape).toEqual({ kind: "single" });
            expect(prepared?.traces).toHaveLength(1);
            expect(prepared?.traces[0]).toHaveLength(1);
            expect(prepared?.traces[0]?.[0]).toMatchObject({
                interceptor: "rewrite",
                contributor: "workspace:runtime",
                cutPoint: "operation.before",
                itemIndex: 0,
                outcome: "rewritten"
            });
            expect(presented?.traces).toEqual([[]]);
            await host.dispose();
        }
    );

    test(
        "reports interceptor applicability to the authority tier decision",
        { tags: "p0" },
        async () => {
            class TierProbeAuthority implements OperationAuthorityPort<
                { readonly caller: string },
                string,
                string,
                string
            > {
                public readonly flags: unknown[] = [];

                public async resolve(): Promise<AuthorityResolution<string>> {
                    return { facet: facetRef("workspace:runtime"), resolution: "resolution" };
                }

                public tier(
                    _resolution: string,
                    _descriptor: OperationDescriptor,
                    hasInterceptors: boolean
                ): "direct" | "mediated" {
                    this.flags.push(hasInterceptors);
                    return "direct";
                }

                public authorizeDirect(): string {
                    return "direct-authorization";
                }

                public async authorizeMediated(): Promise<string> {
                    return "mediated-authorization";
                }

                public replayBinding(): ReturnType<typeof replayBinding> {
                    return replayBinding();
                }

                public allowsInterception(): boolean {
                    return true;
                }

                public release(): void {}
            }
            const guarded = operationDescriptor("guarded");
            const watched = operationDescriptor("watched");
            const plain = operationDescriptor("plain");
            const beforeDeclaration = new InterceptorDeclaration(
                new InterceptorId("before-probe"),
                "operation.before",
                OperationSelector.own("guarded"),
                1
            );
            const afterDeclaration = new InterceptorDeclaration(
                new InterceptorId("after-probe"),
                "operation.after",
                OperationSelector.own("watched"),
                1
            );
            const facetManifest = manifest(
                "acme.runtime",
                [guarded, watched, plain],
                [beforeDeclaration, afterDeclaration]
            );
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([
                    ["guarded", new TestOperation(guarded, async (input) => input)],
                    ["watched", new TestOperation(watched, async (input) => input)],
                    ["plain", new TestOperation(plain, async (input) => input)]
                ]),
                new Map([
                    [
                        "before-probe",
                        new TestInterceptor(beforeDeclaration, (value) => ({
                            proceed: true,
                            value
                        }))
                    ],
                    [
                        "after-probe",
                        new TestInterceptor(afterDeclaration, (value) => ({ proceed: true, value }))
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const authority = new TierProbeAuthority();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                authority,
                new TestInvocations([])
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            for (const operation of ["guarded", "watched", "plain"]) {
                await resolved.dispatch({
                    requestKey: new OperationRequestKey(`tier-${operation}`),
                    operation: new OperationName(operation),
                    payload: { kind: "single", input: {} }
                });
            }
            expect(authority.flags).toEqual([true, true, false]);
            await host.dispose();
        }
    );

    test("presents the full intercept context to each interceptor", { tags: "p1" }, async () => {
        class ContextProbeInterceptor extends Interceptor {
            public readonly contexts: InterceptContext[] = [];

            public constructor(public readonly declaration: InterceptorDeclaration) {
                super();
            }

            public intercept(context: InterceptContext, value: FacetData): InterceptResult {
                this.contexts.push(context);
                return { proceed: true, value };
            }
        }
        const descriptor = operationDescriptor("run");
        const declaration = new InterceptorDeclaration(
            new InterceptorId("aware"),
            "operation.before",
            OperationSelector.own("run"),
            1
        );
        const probe = new ContextProbeInterceptor(declaration);
        const facetManifest = manifest("acme.runtime", [descriptor], [declaration]);
        const facet = new TestFacet(
            "workspace:runtime",
            facetManifest,
            [],
            new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
            new Map([["aware", probe]])
        );
        const host = new FacetRuntimeHost([facetManifest], [facet]);
        await host.activate();
        const gateway = new OperationGatewayHost(
            { caller: "authenticated" },
            host,
            new TestAuthority([], "direct"),
            new TestInvocations([])
        );
        using resolved = await gateway.resolve(new BindingName("runtime"));
        await resolved.dispatch({
            requestKey: new OperationRequestKey("context"),
            operation: new OperationName("run"),
            payload: { kind: "single", input: {} }
        });
        expect(probe.contexts).toHaveLength(1);
        const context = probe.contexts[0];
        expect(context?.cutPoint).toBe("operation.before");
        expect(context?.operation.name.value).toBe("run");
        expect(context?.target.value).toBe("workspace:runtime");
        expect(context?.interceptor.id.value).toBe("aware");
        await host.dispose();
    });

    test(
        "fails closed on non-object results and non-boolean proceed flags",
        { tags: "p0" },
        async () => {
            let behavior: "function" | "text-proceed" = "function";
            const descriptor = operationDescriptor("run");
            const declaration = new InterceptorDeclaration(
                new InterceptorId("shape"),
                "operation.before",
                OperationSelector.own("run"),
                1
            );
            const facetManifest = manifest("acme.runtime", [descriptor], [declaration]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([["run", new TestOperation(descriptor, async (input) => input)]]),
                new Map([
                    [
                        "shape",
                        new TestInterceptor(declaration, (value) =>
                            behavior === "function"
                                ? (Object.assign(() => value, {
                                      proceed: true,
                                      value
                                  }) as unknown as InterceptResult)
                                : ({ proceed: "yes", value } as unknown as InterceptResult)
                        )
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("function-result"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "authority.denied" });
            behavior = "text-proceed";
            await expect(
                resolved.dispatch({
                    requestKey: new OperationRequestKey("text-proceed"),
                    operation: new OperationName("run"),
                    payload: { kind: "single", input: {} }
                })
            ).rejects.toMatchObject({ code: "authority.denied" });
            await host.dispose();
        }
    );

    test(
        "applies a selector when any pattern matches and never prefix-matches exact names",
        { tags: "p0" },
        async () => {
            const calls: string[] = [];
            const run = operationDescriptor("run");
            const runx = operationDescriptor("runx");
            const declaration = new InterceptorDeclaration(
                new InterceptorId("multi"),
                "operation.before",
                new OperationSelector([new OperationPattern("other"), new OperationPattern("run")]),
                1
            );
            const facetManifest = manifest("acme.runtime", [run, runx], [declaration]);
            const facet = new TestFacet(
                "workspace:runtime",
                facetManifest,
                [],
                new Map([
                    ["run", new TestOperation(run, async (input) => input)],
                    ["runx", new TestOperation(runx, async (input) => input)]
                ]),
                new Map([
                    [
                        "multi",
                        new TestInterceptor(declaration, (value) => {
                            calls.push("multi");
                            return { proceed: true, value };
                        })
                    ]
                ])
            );
            const host = new FacetRuntimeHost([facetManifest], [facet]);
            await host.activate();
            const gateway = new OperationGatewayHost(
                { caller: "authenticated" },
                host,
                new TestAuthority([], "direct"),
                new TestInvocations([])
            );
            using resolved = await gateway.resolve(new BindingName("runtime"));
            await resolved.dispatch({
                requestKey: new OperationRequestKey("any-pattern"),
                operation: new OperationName("run"),
                payload: { kind: "single", input: {} }
            });
            expect(calls).toEqual(["multi"]);
            await resolved.dispatch({
                requestKey: new OperationRequestKey("exact-only"),
                operation: new OperationName("runx"),
                payload: { kind: "single", input: {} }
            });
            expect(calls).toEqual(["multi"]);
            await host.dispose();
        }
    );

    test("orders interceptors by priority before contributor and id", { tags: "p1" }, async () => {
        const calls: string[] = [];
        const run = operationDescriptor("run");
        const other = operationDescriptor("other");
        const samePriority = ["a", "b", "c"].map(
            (id) =>
                new InterceptorDeclaration(
                    new InterceptorId(id),
                    "operation.before",
                    OperationSelector.own("run"),
                    5
                )
        );
        const laterButHigher = new InterceptorDeclaration(
            new InterceptorId("y"),
            "operation.before",
            OperationSelector.own("other"),
            2
        );
        const earlierPriority = new InterceptorDeclaration(
            new InterceptorId("z"),
            "operation.before",
            OperationSelector.own("other"),
            1
        );
        const declarations = [...samePriority, laterButHigher, earlierPriority];
        const facetManifest = manifest("acme.runtime", [run, other], declarations);
        const facet = new TestFacet(
            "workspace:runtime",
            facetManifest,
            [],
            new Map([
                ["run", new TestOperation(run, async (input) => input)],
                ["other", new TestOperation(other, async (input) => input)]
            ]),
            new Map(
                declarations.map((declaration) => [
                    declaration.id.value,
                    new TestInterceptor(declaration, (value) => {
                        calls.push(declaration.id.value);
                        return { proceed: true, value };
                    })
                ])
            )
        );
        const host = new FacetRuntimeHost([facetManifest], [facet]);
        await host.activate();
        const gateway = new OperationGatewayHost(
            { caller: "authenticated" },
            host,
            new TestAuthority([], "direct"),
            new TestInvocations([])
        );
        using resolved = await gateway.resolve(new BindingName("runtime"));
        await resolved.dispatch({
            requestKey: new OperationRequestKey("id-tiebreak"),
            operation: new OperationName("run"),
            payload: { kind: "single", input: {} }
        });
        expect(calls).toEqual(["a", "b", "c"]);
        await resolved.dispatch({
            requestKey: new OperationRequestKey("priority-first"),
            operation: new OperationName("other"),
            payload: { kind: "single", input: {} }
        });
        expect(calls).toEqual(["a", "b", "c", "z", "y"]);
        await host.dispose();
    });
});

interface CommandEventRecord {
    readonly id: string;
    readonly kind: "command.invoked";
    readonly origin?: CommandInvocationOrigin;
    readonly payload?: FacetData;
}

class TestCommandEvents implements CommandEventPort {
    public readonly records: CommandEventRecord[] = [];

    public async invoked(
        _installed: InstalledCommand,
        origin: CommandInvocationOrigin,
        input: FacetData
    ): Promise<CommandInvocationEvent> {
        const event = Object.freeze({
            id: `command-event-${this.records.length + 1}`,
            kind: "command.invoked" as const,
            origin,
            payload: input
        });
        this.records.push(event);
        return Object.freeze({ id: event.id });
    }
}

class TestFacet extends Facet {
    public readonly ref: SlotEntry["contributor"];

    public constructor(
        ref: string,
        public readonly manifest: FacetManifest,
        public readonly childFacets: Facet[] = [],
        private readonly operationMap: ReadonlyMap<string, Operation> = new Map(),
        private readonly interceptorMap: ReadonlyMap<string, Interceptor> = new Map(),
        private readonly onStart: (
            context: FacetLifecycleContext
        ) => Promise<void> = async () => {},
        private readonly onStop: (context: FacetLifecycleContext) => Promise<void> = async () => {},
        private readonly surfaceMap: ReadonlyMap<string, Surface> = new Map()
    ) {
        super();
        this.ref = facetRef(ref);
    }

    public operation(name: OperationName): Operation | undefined {
        return this.operationMap.get(name.value);
    }

    public surface(id: SurfaceId): Surface | undefined {
        return this.surfaceMap.get(id.value);
    }

    public interceptor(id: InterceptorId): Interceptor | undefined {
        return this.interceptorMap.get(id.value);
    }

    public children(): readonly Facet[] {
        return this.childFacets;
    }

    public start(context: FacetLifecycleContext): Promise<void> {
        return this.onStart(context);
    }

    public stop(context: FacetLifecycleContext): Promise<void> {
        return this.onStop(context);
    }
}

class TestSurface extends Surface {
    public constructor(public readonly descriptor: SurfaceDescriptor) {
        super();
    }

    public async render(_context: OperationContext, input: FacetData): Promise<FacetData> {
        return input;
    }
}

class TestOperation extends Operation {
    public constructor(
        public readonly descriptor: OperationDescriptor,
        private readonly handler: (input: FacetData) => Promise<FacetData>
    ) {
        super();
    }

    public execute(_context: OperationContext, input: FacetData): Promise<FacetData> {
        return this.handler(input);
    }
}

class TestInterceptor extends Interceptor {
    public constructor(
        public readonly declaration: InterceptorDeclaration,
        private readonly handler: (value: FacetData) => InterceptResult
    ) {
        super();
    }

    public intercept(_context: InterceptContext, value: FacetData): InterceptResult {
        return this.handler(value);
    }
}

class TestAuthority implements OperationAuthorityPort<
    { readonly caller: string },
    string,
    string,
    string
> {
    public constructor(
        private readonly events: string[],
        private readonly selected: "direct" | "mediated",
        private readonly interceptionAllowed = true,
        private readonly directAllowed = true,
        private readonly mediatedAllowed = true,
        private readonly resolvedFacet = facetRef("workspace:runtime")
    ) {}

    public async resolve(): Promise<AuthorityResolution<string>> {
        this.events.push("resolve");
        return { facet: this.resolvedFacet, resolution: "resolution" };
    }

    public tier(): "direct" | "mediated" {
        return this.selected;
    }

    public authorizeDirect(): string | undefined {
        this.events.push("authorize:direct");
        return this.directAllowed ? "direct-authorization" : undefined;
    }

    public async authorizeMediated(): Promise<string> {
        this.events.push("authorize:mediated");
        if (!this.mediatedAllowed) {
            throw new AgentCoreError("authority.denied", "Current caller is not authorized");
        }
        return "mediated-authorization";
    }

    public replayBinding() {
        return replayBinding();
    }

    public allowsInterception(): boolean {
        return this.interceptionAllowed;
    }

    public release(): void {
        this.events.push("release");
    }
}

class TestInvocations implements OperationInvocationPort<string, string> {
    public lastRequest: MediatedInvocationRequest<string> | undefined;
    public presentationTraces: readonly unknown[] = [];
    public preflights: MediatedInvocationPreflight[] = [];
    public directShapes: readonly string[] = [];

    public constructor(
        private readonly events: string[],
        private readonly wrongItemCount = false,
        private readonly requestUnknownItem = false,
        public replay: OperationDispatchResult | undefined = undefined
    ) {}

    public directContext(
        requestKey: OperationRequestKey,
        itemIndex: number,
        shape: OperationPayloadShape
    ): OperationContext {
        this.events.push("context:direct");
        this.directShapes = [
            ...this.directShapes,
            shape.kind === "single" ? "single" : `batch:${shape.itemCount}`
        ];
        return operationContext(requestKey, itemIndex);
    }

    public async prepareMediated(
        request: MediatedInvocationPreflight,
        prepare: () => import("../../src/operations/gateway").MediatedInvocationPreparation
    ): Promise<MediatedPreflightResult> {
        this.preflights.push(request);
        return this.replay === undefined
            ? { kind: "new", preparation: prepare() }
            : { kind: "replay", result: this.replay };
    }

    public async invoke(request: MediatedInvocationRequest<string>) {
        this.events.push("invoke");
        this.lastRequest = request;
        if (this.requestUnknownItem) {
            await request.execute(
                request.inputs.length,
                operationContext(request.requestKey, request.inputs.length)
            );
        }
        const outputs = await Promise.all(
            request.inputs.map((_input, itemIndex) =>
                request.execute(itemIndex, operationContext(request.requestKey, itemIndex))
            )
        );
        return {
            outputs: this.wrongItemCount ? [] : outputs,
            evidence: { receipt: "recorded" }
        };
    }

    public recordDirectInterceptions(_evidence: OperationInterceptionEvidence): void {}

    public async presentMediated(
        _evidence: FacetData,
        outputs: readonly FacetData[],
        present: (
            itemIndex: number,
            output: FacetData
        ) => {
            readonly value: FacetData;
            readonly traces: readonly import("../../src/operations/interception").InterceptorTrace[];
        }
    ): Promise<readonly FacetData[]> {
        const presented = outputs.map((output, itemIndex) => present(itemIndex, output));
        this.presentationTraces = presented.flatMap((item) => item.traces);
        return presented.map((item) => item.value);
    }
}

class DurableTransactions implements InvocationTransactionPort<InvocationMediationMemoryState> {
    #state: InvocationMediationMemoryState;

    public constructor(state = createInvocationMediationMemoryState()) {
        this.#state = cloneInvocationMediationMemoryState(state);
    }

    public transact<Result>(
        operation: (transaction: InvocationMediationMemoryState) => Result
    ): Result {
        const transaction = cloneInvocationMediationMemoryState(this.#state);
        const result = operation(transaction);
        this.#state = cloneInvocationMediationMemoryState(transaction);
        return result;
    }

    public inspect<Result>(operation: (state: InvocationMediationMemoryState) => Result): Result {
        return operation(cloneInvocationMediationMemoryState(this.#state));
    }

    public snapshot(): InvocationMediationMemoryState {
        return cloneInvocationMediationMemoryState(this.#state);
    }
}

class DurableBatch implements CanonicalBatchInvoker<string> {
    public calls = 0;

    public constructor(
        public readonly invocation: InvocationId,
        private failuresRemaining = 0
    ) {}

    public async invoke(request: CanonicalBatchInvocationRequest<string>) {
        this.calls += 1;
        if (this.failuresRemaining > 0) {
            this.failuresRemaining -= 1;
            throw new TypeError("injected mediation crash");
        }
        const outputs = await Promise.all(
            request.request.inputs.map((_input, itemIndex) =>
                request.request.execute(
                    itemIndex,
                    operationContext(request.request.requestKey, itemIndex)
                )
            )
        );
        return {
            invocation: this.invocation,
            items: outputs.map((output, itemIndex) => ({
                kind: "succeeded" as const,
                itemIndex,
                output,
                receipt: new AttemptReceipt(
                    new ReceiptId(`${this.invocation.value}-receipt-${itemIndex}`),
                    new EffectAttemptId(`${this.invocation.value}-attempt-${itemIndex}`),
                    "succeeded",
                    undefined,
                    new Date(20),
                    undefined
                )
            }))
        };
    }
}

function durableInvocations(
    transactions: DurableTransactions,
    persistence: MemoryInvocationMediationPersistence,
    batch: DurableBatch
): ReplayOperationInvocationPort<InvocationMediationMemoryState, string, string> {
    return new ReplayOperationInvocationPort(
        "operation-conformance",
        transactions,
        persistence,
        { invocation: () => batch.invocation },
        {
            context: (requestKey, itemIndex) => operationContext(requestKey, itemIndex)
        },
        batch
    );
}

function operationContext(requestKey: OperationRequestKey, itemIndex: number): OperationContext {
    return Object.freeze({
        invocation: new InvocationId(`invocation:${requestKey.value}:${itemIndex}`),
        itemIndex,
        idempotencyKey: `${requestKey.value}:${itemIndex}`,
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}

function replayBinding() {
    const digest = new Digest("a".repeat(64));
    return {
        principal: new PrincipalRef(
            new TenantId("operation-test-tenant"),
            new PrincipalId("operation-test-principal")
        ),
        authorityIdentity: digest,
        packageOperationPin: digest,
        execution: { kind: "lease" as const, digest }
    };
}

function operationDescriptor(
    name: string,
    impact: "observe" | "mutate" = "observe",
    interceptable = false
): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName(name),
        impact,
        objectSchema,
        objectSchema,
        undefined,
        interceptable
    );
}

function mappedOperationDescriptor(): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName("run"),
        "observe",
        new JsonSchema({
            type: "object",
            additionalProperties: false,
            required: ["count"],
            properties: { count: { type: "integer" } }
        }),
        new JsonSchema({
            type: "object",
            additionalProperties: false,
            required: ["accepted"],
            properties: { accepted: { type: "boolean" } }
        })
    );
}

function mappedCommand(
    overrides: Partial<{
        readonly name: string;
        readonly operation: OperationRef;
        readonly mapping: FieldMapping;
    }> = {}
): Command {
    return new Command({
        name: overrides.name ?? "run",
        title: "Run",
        arguments: new JsonSchema({
            type: "object",
            additionalProperties: false,
            required: ["amount"],
            properties: { amount: { type: "integer" } }
        }),
        operation: overrides.operation ?? new OperationRef("acme.runtime:run"),
        binding: new BindingName("runtime"),
        mapping:
            overrides.mapping ?? new FieldMapping([new FieldMove("/count", { from: "/amount" })]),
        surfaces: [new SlotName("palette")]
    });
}

function manifest(
    id: string,
    operations: readonly OperationDescriptor[],
    interceptors: readonly InterceptorDeclaration[] = [],
    surfaces: readonly SurfaceDescriptor[] = []
): FacetManifest {
    const contributions = [
        ...(operations.length === 0
            ? []
            : [
                  new Contribution(
                      new SlotName("operations"),
                      operations.map((value) => value.toData())
                  )
              ]),
        ...(interceptors.length === 0
            ? []
            : [
                  new Contribution(
                      new SlotName("interceptors"),
                      interceptors.map((value) => value.toData())
                  )
              ]),
        ...(surfaces.length === 0
            ? []
            : [
                  new Contribution(
                      new SlotName("surfaces"),
                      surfaces.map((value) => value.toData())
                  )
              ])
    ];
    return new FacetManifest({
        id: new FacetPackageId(id),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["bundled"],
        bindings: [],
        contributions: new Contributions(contributions)
    });
}

function requireObject(value: FacetData): { readonly [key: string]: FacetData } {
    if (!isFacetDataMap(value)) {
        throw new TypeError("Expected object data");
    }
    return value;
}

function facetRef(value: string): SlotEntry["contributor"] {
    return SlotEntry.create(new SlotName("runtime.ref"), value, 0, null).contributor;
}

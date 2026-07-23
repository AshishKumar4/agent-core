import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "../../src/content";
import { CompatRange, Digest, JsonSchema, SemVer } from "../../src/core";
import * as facets from "../../src/facets-public";
import {
    BindingName,
    Contribution,
    Contributions,
    EventDeclaration,
    EventKind,
    Facet,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    Interceptor,
    InterceptorDeclaration,
    InterceptorId,
    OperationDescriptor,
    OperationName,
    ProtectedOperationPort,
    SlotName,
    SurfaceDescriptor,
    SurfaceId,
    type FacetData,
    type InterceptContext,
    type InterceptResult,
    type OperationContext,
    type ProtectedOperationRequest,
    type ProtectedOperationResult
} from "../../src/facets";
import {
    DetailedProfileError,
    EffectDispatch,
    EffectDispatchAttempt,
    InternalProfileFacetRuntime,
    ProfileControlContract,
    ProfileEffectContext,
    ProfileEventContract,
    ProfileOperationContract,
    ProfileRuntimeEffectsPort,
    ProfileRuntimeHostBinding,
    ProtectedProfileRuntimePort,
    VersionedProfileWireCodec,
    createStandardProfileManifest,
    profileWireCodec,
    strictObjectSchema,
    versionedProfileWireCodec,
    voidProfileWireCodec,
    type ProfileControlAdmission,
    type PublicProfileInput
} from "../../src/facets";
import { EffectAttemptId, InvocationId } from "../../src/invocations";

interface ExampleInput extends PublicProfileInput {
    readonly value: string;
}

const inputSchema = strictObjectSchema({ value: { type: "string" } }, ["value"]);
const outputSchema = new JsonSchema({ type: "string" });
const descriptor = new OperationDescriptor(
    new OperationName("example"),
    "observe",
    inputSchema,
    outputSchema
);
const contract = new ProfileOperationContract(
    "example",
    descriptor,
    profileWireCodec<ExampleInput>(
        (input) => ({ value: input.value }),
        (data) => ({ value: (data as { value: string }).value })
    ),
    profileWireCodec<string>(
        (value) => value,
        (data) => String(data)
    ),
    "output"
);

describe("W3 profile runtime", () => {
    test("keeps profile host adapters private and uses canonical Operation execution", async () => {
        expect("InternalProfileFacetRuntime" in facets).toBe(false);
        expect("ProtectedProfileRuntimePort" in facets).toBe(false);
        expect(voidProfileWireCodec.decode(null)).toBeUndefined();

        const protectedPort = new RecordingProtectedPort(true);
        const runtime = profileRuntime(protectedPort);
        expect(Object.isFrozen(runtime)).toBe(true);
        const output = await runtime.invoke(contract, { value: "input" }, (input, context) => {
            expect(input).toEqual({ value: "input" });
            expect(context.invocation.value).toBe("profile-invocation");
            expect(context.itemIndex).toBe(0);
            expect(context.attempt?.value).toBe("profile-attempt");
            expect(context.attemptOrdinal).toBe(2);
            expect(context.intentDigest?.value).toBe("a".repeat(64));
            return "output";
        });

        expect(output).toBe("output");
        expect(protectedPort.operations[0]).toBeInstanceOf(facets.Operation);
        await expect(
            runtime.invoke(contract, { value: 1 } as never, () => "unused")
        ).rejects.toMatchObject({ code: "operation.invalid-input", detailCode: "wire.input" });
    });

    test("models direct contexts without attempts and rejects partial attempt identity", () => {
        const direct = ProfileEffectContext.fromOperation(operationContext(false));
        expect(direct.attempt).toBeUndefined();
        expect(direct.attemptOrdinal).toBeUndefined();
        expect(direct.intentDigest).toBeUndefined();
        expect(
            () =>
                new ProfileEffectContext(
                    new InvocationId("partial"),
                    0,
                    "key",
                    new EffectAttemptId("attempt"),
                    undefined,
                    new Digest("a".repeat(64))
                )
        ).toThrow(TypeError);
        for (const invalid of [
            () =>
                new ProfileEffectContext(
                    new InvocationId("invalid-index"),
                    -1,
                    "key",
                    undefined,
                    undefined,
                    undefined
                ),
            () =>
                new ProfileEffectContext(
                    new InvocationId("invalid-key"),
                    0,
                    " key",
                    undefined,
                    undefined,
                    undefined
                ),
            () =>
                new ProfileEffectContext(
                    new InvocationId("invalid-ordinal"),
                    0,
                    "key",
                    new EffectAttemptId("attempt"),
                    -1,
                    new Digest("a".repeat(64))
                )
        ]) {
            expect(invalid).toThrow(TypeError);
        }
    });

    test("rejects mismatched profile contracts and non-exact host identifier classes", () => {
        expect(
            () =>
                new ProfileOperationContract(
                    "different",
                    descriptor,
                    contract.inputCodec,
                    contract.outputCodec,
                    "output"
                )
        ).toThrow(/match/);
        const declaration = new EventDeclaration(
            new EventKind("example.event"),
            "Example",
            inputSchema,
            "workspace"
        );
        expect(
            () =>
                new ProfileEventContract(
                    "different.event",
                    declaration,
                    profileWireCodec<ExampleInput>(
                        (input) => ({ value: input.value }),
                        (data) => ({ value: (data as { value: string }).value })
                    )
                )
        ).toThrow(/match/);
        expect(
            () =>
                new ProfileControlContract(
                    " control",
                    inputSchema,
                    outputSchema,
                    contract.inputCodec,
                    contract.outputCodec
                )
        ).toThrow(/canonical/);
        class DerivedFacetRef extends FacetRef {}
        expect(
            () =>
                new ProfileRuntimeHostBinding(
                    new DerivedFacetRef("workspace:derived"),
                    new BindingName("profile")
                )
        ).toThrow(/exact/);
        class DerivedBindingName extends BindingName {}
        expect(
            () =>
                new ProfileRuntimeHostBinding(
                    new FacetRef("workspace:profile"),
                    new DerivedBindingName("profile")
                )
        ).toThrow(/exact/);
        expect(() => voidProfileWireCodec.decode("not-null" as never)).toThrowError(
            expect.objectContaining({ code: "operation.invalid-input", detailCode: "wire.input" })
        );
    });

    test("fails closed on protected result substitution and wire codec failures", async () => {
        const receiptContract = new ProfileOperationContract(
            "example",
            descriptor,
            contract.inputCodec,
            contract.outputCodec,
            "receipt"
        );
        const template = profileRuntime(new RecordingProtectedPort(false));
        const substituted = new ProtectedProfileRuntimePort(
            template.host,
            new OutputSubstitutionPort(),
            new RecordingEffects()
        );
        substituted.activate();
        await expect(
            substituted.invoke(receiptContract, { value: "input" }, () => "output")
        ).rejects.toMatchObject({
            code: "operation.invalid-output",
            detailCode: "wire.output",
            message: "Protected Operation port omitted the operation Receipt"
        });

        const inputEncodingFailure = new ProfileOperationContract(
            "example",
            descriptor,
            profileWireCodec<ExampleInput>(
                () => {
                    throw new TypeError("encode");
                },
                () => ({ value: "unused" })
            ),
            contract.outputCodec,
            "output"
        );
        await expect(
            template.invoke(inputEncodingFailure, { value: "input" }, () => "output")
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            detailCode: "wire.input",
            message: "Profile input encoding failed"
        });

        const outputEncodingFailure = new ProfileOperationContract(
            "example",
            descriptor,
            contract.inputCodec,
            profileWireCodec<string>(() => {
                throw new TypeError("encode");
            }, String),
            "output"
        );
        await expect(
            template.invoke(outputEncodingFailure, { value: "input" }, () => "output")
        ).rejects.toMatchObject({
            code: "operation.invalid-output",
            detailCode: "wire.output",
            message: "Profile output encoding failed"
        });

        const inputDecodingFailure = new ProfileOperationContract(
            "example",
            descriptor,
            profileWireCodec<ExampleInput>(
                (input) => ({ value: input.value }),
                () => {
                    throw new TypeError("decode");
                }
            ),
            contract.outputCodec,
            "output"
        );
        await expect(
            template.invoke(inputDecodingFailure, { value: "input" }, () => "output")
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            detailCode: "wire.input",
            message: "Profile input decoding failed"
        });

        const outputDecodingFailure = new ProfileOperationContract(
            "example",
            descriptor,
            contract.inputCodec,
            profileWireCodec<string>(
                (value) => value,
                () => {
                    throw new TypeError("decode");
                }
            ),
            "output"
        );
        await expect(
            template.invoke(outputDecodingFailure, { value: "input" }, () => "output")
        ).rejects.toMatchObject({
            code: "operation.invalid-output",
            detailCode: "wire.output",
            message: "Profile output decoding failed"
        });

        await expect(
            template.invoke(contract, { value: 1 } as never, () => "unused")
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            detailCode: "wire.input",
            message: "Profile input does not match its Operation schema"
        });
        await expect(
            template.invoke(contract, { value: "input" }, () => 7 as never)
        ).rejects.toMatchObject({
            code: "operation.invalid-output",
            detailCode: "wire.output",
            message: "Profile output does not match its Operation schema"
        });
    });

    test("adapts descriptors to distinct runtime Operations and Surfaces", async () => {
        const protectedPort = new RecordingProtectedPort(false);
        const runtimePort = profileRuntime(protectedPort);
        const operation = runtimePort.operation(contract, (input) => input.value);
        const surfaceDescriptor = new SurfaceDescriptor(
            new SurfaceId("example.surface"),
            "Example"
        );
        const surface = runtimePort.surface(surfaceDescriptor);
        const manifest = operationManifest(descriptor, surfaceDescriptor);
        const runtime = new InternalProfileFacetRuntime({
            manifest,
            operations: [operation],
            surfaces: [surface],
            runtime: runtimePort
        });
        const lifecycle = { signal: new AbortController().signal };

        expect(runtime).toBeInstanceOf(Facet);
        expect(surface).not.toBe(surfaceDescriptor);
        await runtime.start(lifecycle);
        expect(runtime.operation(descriptor.name)).toBe(operation);
        expect(runtime.surface(surfaceDescriptor.id)).toBe(surface);
        await expect(surface.render(operationContext(false), { rendered: true })).resolves.toEqual({
            rendered: true
        });
        await runtime.stop(lifecycle);
        expect(runtime.active).toBe(false);
    });

    test("composes standard profile manifests without exporting profile implementations", () => {
        const manifest = createStandardProfileManifest(
            {
                id: new FacetPackageId("profile.standard"),
                version: new SemVer("1.0.0"),
                compat: new CompatRange("^1.0.0", "^1.0.0"),
                bindings: []
            },
            {
                isolation: ["bundled"],
                contributions: new Contributions([
                    new Contribution(new SlotName("operations"), [descriptor.toData()])
                ])
            }
        );
        expect(FacetManifest.decode(FacetManifest.encode(manifest)).toData()).toEqual(
            manifest.toData()
        );
    });

    test("coalesces lifecycle transitions, honors abort, and rejects duplicate runtime declarations", async () => {
        const runtimePort = profileRuntime(new RecordingProtectedPort(false));
        const operation = runtimePort.operation(contract, (input) => input.value);
        const manifest = operationOnlyManifest(descriptor);
        let starts = 0;
        const gate = deferred<void>();
        const runtime = new InternalProfileFacetRuntime({
            manifest,
            operations: [operation],
            runtime: runtimePort,
            async start() {
                starts += 1;
                await gate.promise;
            }
        });
        const lifecycle = { signal: new AbortController().signal };
        const first = runtime.start(lifecycle);
        const second = runtime.start(lifecycle);
        gate.resolve();
        await Promise.all([first, second]);
        expect(starts).toBe(1);
        expect(runtime.active).toBe(true);
        await runtime.start(lifecycle);
        await runtime.stop(lifecycle);
        await runtime.stop(lifecycle);

        const abortedController = new AbortController();
        abortedController.abort();
        const abortedPort = profileRuntime(new RecordingProtectedPort(false));
        const aborted = new InternalProfileFacetRuntime({
            manifest,
            operations: [abortedPort.operation(contract, (input) => input.value)],
            runtime: abortedPort
        });
        await aborted.start({ signal: abortedController.signal });
        expect(aborted.active).toBe(false);

        expect(
            () =>
                new InternalProfileFacetRuntime({
                    manifest,
                    operations: [operation, operation],
                    runtime: runtimePort
                })
        ).toThrowError(expect.objectContaining({ detailCode: "runtime.declaration" }));
        expect(
            () =>
                new InternalProfileFacetRuntime({
                    manifest,
                    operations: [],
                    runtime: runtimePort
                })
        ).toThrowError(expect.objectContaining({ detailCode: "runtime.declaration" }));

        const emptyManifest = new FacetManifest({
            id: new FacetPackageId("profile.empty"),
            version: new SemVer("1.0.0"),
            compat: new CompatRange("^1.0.0", "^1.0.0"),
            isolation: ["bundled"],
            bindings: [],
            contributions: Contributions.empty()
        });
        expect(
            () =>
                new InternalProfileFacetRuntime({
                    manifest: emptyManifest,
                    operations: [],
                    runtime: runtimePort
                })
        ).not.toThrow();

        const transitionGate = deferred<void>();
        const transitionPort = profileRuntime(new RecordingProtectedPort(false));
        const transitioning = new InternalProfileFacetRuntime({
            manifest,
            operations: [transitionPort.operation(contract, (input) => input.value)],
            runtime: transitionPort,
            stop: () => transitionGate.promise
        });
        await transitioning.start(lifecycle);
        const stopping = transitioning.stop(lifecycle);
        const restarting = transitioning.start(lifecycle);
        transitionGate.resolve();
        await Promise.all([stopping, restarting]);
        expect(transitioning.active).toBe(true);

        const startGate = deferred<void>();
        const stopDuringStartPort = profileRuntime(new RecordingProtectedPort(false));
        const stopDuringStart = new InternalProfileFacetRuntime({
            manifest,
            operations: [stopDuringStartPort.operation(contract, (input) => input.value)],
            runtime: stopDuringStartPort,
            start: () => startGate.promise
        });
        const starting = stopDuringStart.start(lifecycle);
        const earlyStop = stopDuringStart.stop(lifecycle);
        startGate.resolve();
        await Promise.all([starting, earlyStop]);
        expect(stopDuringStart.active).toBe(false);
    });
});

describe("W3 effect dispatch identity", () => {
    const digest = new Digest("a".repeat(64));
    const attemptId = new EffectAttemptId("attempt");

    test("admits only exact, canonical effect attempt identity", { tags: "p0" }, () => {
        class DerivedAttemptId extends EffectAttemptId {}
        class DerivedDigest extends Digest {}
        expect(() => new EffectDispatchAttempt(new DerivedAttemptId("attempt"), 0, digest)).toThrow(
            "Effect dispatch attempt must use the exact EffectAttemptId class"
        );
        expect(() => new EffectDispatchAttempt(attemptId, -1, digest)).toThrow(
            "Effect dispatch attempt ordinal must be a non-negative safe integer"
        );
        expect(() => new EffectDispatchAttempt(attemptId, 1.5, digest)).toThrow(
            "Effect dispatch attempt ordinal must be a non-negative safe integer"
        );
        expect(
            () => new EffectDispatchAttempt(attemptId, 0, new DerivedDigest("a".repeat(64)))
        ).toThrow("Effect dispatch attempt intent digest must use the exact Digest class");
        const attempt = new EffectDispatchAttempt(attemptId, 0, digest);
        expect(Object.isFrozen(attempt)).toBe(true);
        expect(attempt.id).toBe(attemptId);
        expect(attempt.ordinal).toBe(0);
        expect(attempt.intentDigest).toBe(digest);
    });

    test("canonicalizes dispatch idempotency keys and attempt classes", { tags: "p0" }, () => {
        for (const invalid of ["", " key", "key "]) {
            expect(() => new EffectDispatch(invalid)).toThrow(
                "Effect dispatch idempotency key must be canonical"
            );
        }
        class DerivedDispatchAttempt extends EffectDispatchAttempt {}
        expect(
            () => new EffectDispatch("key", new DerivedDispatchAttempt(attemptId, 0, digest))
        ).toThrow("Effect dispatch attempt must use the exact EffectDispatchAttempt class");
        const direct = new EffectDispatch("key");
        expect(Object.isFrozen(direct)).toBe(true);
        expect(direct.idempotencyKey).toBe("key");
        expect(direct.attempt).toBeUndefined();
    });

    test("derives dispatch identity from the effect context", { tags: "p0" }, () => {
        const attempted = ProfileEffectContext.fromOperation(operationContext(true)).dispatch();
        expect(attempted.idempotencyKey).toBe("profile-key");
        expect(attempted.attempt).toBeInstanceOf(EffectDispatchAttempt);
        expect(attempted.attempt?.id.value).toBe("profile-attempt");
        expect(attempted.attempt?.ordinal).toBe(2);
        expect(attempted.attempt?.intentDigest.value).toBe("a".repeat(64));
        const direct = ProfileEffectContext.fromOperation(operationContext(false)).dispatch();
        expect(direct.idempotencyKey).toBe("profile-key");
        expect(direct.attempt).toBeUndefined();
    });

    test("requires complete attempt identity and canonical keys", { tags: "p0" }, () => {
        const partials: readonly [
            EffectAttemptId | undefined,
            number | undefined,
            Digest | undefined
        ][] = [
            [attemptId, undefined, undefined],
            [undefined, 0, undefined],
            [undefined, undefined, digest],
            [attemptId, 0, undefined],
            [attemptId, undefined, digest],
            [undefined, 0, digest]
        ];
        for (const [attempt, ordinal, intentDigest] of partials) {
            expect(
                () =>
                    new ProfileEffectContext(
                        new InvocationId("partial"),
                        0,
                        "key",
                        attempt,
                        ordinal,
                        intentDigest
                    )
            ).toThrow("Profile effect attempt identity must be complete");
        }
        expect(
            () =>
                new ProfileEffectContext(
                    new InvocationId("blank-key"),
                    0,
                    "   ",
                    undefined,
                    undefined,
                    undefined
                )
        ).toThrow("Profile effect idempotency key must be canonical");
    });
});

describe("W3 profile wire codec versioning", () => {
    test("freezes wire codecs and validates declared versions", { tags: "p1" }, () => {
        const codec = profileWireCodec<string>(
            (value) => value,
            (data) => String(data)
        );
        expect(Object.isFrozen(codec)).toBe(true);
        const versioned = versionedProfileWireCodec<string>(
            (value) => value,
            (data) => String(data)
        );
        expect(Object.isFrozen(versioned)).toBe(true);
        expect(versioned.major).toBe(1);
        expect(versioned.minor).toBe(0);
        const invalidVersions: readonly [number, number][] = [
            [0, 0],
            [1, -1],
            [1.5, 0]
        ];
        for (const [major, minor] of invalidVersions) {
            expect(
                () =>
                    new VersionedProfileWireCodec<string>(
                        (value) => value,
                        (data) => String(data),
                        major,
                        minor
                    )
            ).toThrow("Profile wire codec version is invalid");
        }
    });

    test("decodes only supported wire versions", { tags: "p1" }, () => {
        const versioned = versionedProfileWireCodec<string>(
            (value) => value,
            (data) => String(data)
        );
        expect(versioned.decodeVersion({ major: 1, minor: 0 }, "value")).toBe("value");
        expect(versioned.decodeVersion({ major: 1, minor: 7 }, "value")).toBe("value");
        expect(() => versioned.decodeVersion({ major: 2, minor: 0 }, "value")).toThrowError(
            expect.objectContaining({
                code: "codec.unknown-major",
                detailCode: "wire.input",
                message: "Unsupported profile input codec major 2"
            })
        );
        for (const minor of [-1, 1.5]) {
            expect(() => versioned.decodeVersion({ major: 1, minor }, "value")).toThrowError(
                expect.objectContaining({
                    code: "codec.invalid",
                    detailCode: "wire.input",
                    message: "Profile input codec minor is invalid"
                })
            );
        }
    });
});

describe("W3 profile contracts", () => {
    test("round-trips event and control contract payloads", { tags: "p1" }, () => {
        const declaration = new EventDeclaration(
            new EventKind("example.event"),
            "Example",
            inputSchema,
            "workspace"
        );
        const eventContract = new ProfileEventContract(
            "example.event",
            declaration,
            profileWireCodec<ExampleInput>(
                (input) => ({ value: input.value }),
                (data) => ({ value: (data as { value: string }).value })
            )
        );
        expect(eventContract.encodePayload({ value: "payload" })).toEqual({ value: "payload" });
        expect(eventContract.decodePayload({ value: "payload" })).toEqual({ value: "payload" });

        for (const invalid of ["", "   ", "control "]) {
            expect(
                () =>
                    new ProfileControlContract(
                        invalid,
                        inputSchema,
                        outputSchema,
                        contract.inputCodec,
                        contract.outputCodec
                    )
            ).toThrow("Profile control contract name must be canonical");
        }
        const control = new ProfileControlContract(
            "control",
            inputSchema,
            outputSchema,
            contract.inputCodec,
            contract.outputCodec
        );
        expect(control.name).toBe("control");
        expect(control.encodeInput({ value: "input" })).toEqual({ value: "input" });
        expect(control.decodeInput({ value: "input" })).toEqual({ value: "input" });

        const error = new DetailedProfileError("codec.invalid", "wire.input", "detail");
        expect(error.name).toBe("DetailedProfileError");
        expect(error.detail).toEqual({ code: "wire.input" });
    });
});

describe("W3 internal profile facet runtime", () => {
    const lifecycle = { signal: new AbortController().signal };

    test("exposes its host ref, children, and interceptors", { tags: "p1" }, () => {
        const childPort = profileRuntime(new RecordingProtectedPort(false));
        const child = new InternalProfileFacetRuntime({
            manifest: emptyManifest("profile.child"),
            operations: [],
            runtime: childPort
        });
        const declaration = new InterceptorDeclaration(
            new InterceptorId("guard"),
            "operation.before",
            0
        );
        const interceptor = new PassThroughInterceptor(declaration);
        const port = profileRuntime(new RecordingProtectedPort(false));
        const runtime = new InternalProfileFacetRuntime({
            manifest: operationOnlyManifest(descriptor),
            operations: [port.operation(contract, (input) => input.value)],
            interceptors: [interceptor],
            children: [child],
            runtime: port
        });
        expect(runtime.ref.value).toBe("workspace:profile");
        expect(runtime.children()).toEqual([child]);
        expect(runtime.interceptor(declaration.id)).toBe(interceptor);
        expect(runtime.interceptor(new InterceptorId("missing"))).toBeUndefined();
    });

    test("is active only while both started and runtime-admitted", { tags: "p0" }, async () => {
        const port = profileRuntime(new RecordingProtectedPort(false));
        const runtime = new InternalProfileFacetRuntime({
            manifest: operationOnlyManifest(descriptor),
            operations: [port.operation(contract, (input) => input.value)],
            runtime: port
        });
        await runtime.start(lifecycle);
        expect(runtime.active).toBe(true);
        port.deactivate();
        expect(runtime.active).toBe(false);
        port.activate();
        expect(runtime.active).toBe(true);
        await runtime.stop(lifecycle);
    });

    test("runs lifecycle hooks exactly once per transition", { tags: "p1" }, async () => {
        let starts = 0;
        let stops = 0;
        const port = profileRuntime(new RecordingProtectedPort(false));
        const runtime = new InternalProfileFacetRuntime({
            manifest: operationOnlyManifest(descriptor),
            operations: [port.operation(contract, (input) => input.value)],
            runtime: port,
            start: () => {
                starts += 1;
            },
            stop: () => {
                stops += 1;
            }
        });
        await runtime.start(lifecycle);
        await runtime.start(lifecycle);
        expect(starts).toBe(1);
        await runtime.stop(lifecycle);
        expect(stops).toBe(1);
        await runtime.stop(lifecycle);
        expect(stops).toBe(1);
        await runtime.start(lifecycle);
        expect(starts).toBe(2);
        await runtime.stop(lifecycle);
        expect(stops).toBe(2);
        expect(runtime.active).toBe(false);
    });

    test("ignores stop before any start", { tags: "p1" }, async () => {
        let stops = 0;
        const port = profileRuntime(new RecordingProtectedPort(false));
        const runtime = new InternalProfileFacetRuntime({
            manifest: operationOnlyManifest(descriptor),
            operations: [port.operation(contract, (input) => input.value)],
            runtime: port,
            stop: () => {
                stops += 1;
            }
        });
        await runtime.stop(lifecycle);
        expect(stops).toBe(0);
        expect(runtime.active).toBe(false);
        await runtime.start(lifecycle);
        expect(runtime.active).toBe(true);
    });

    test("defers a restart until an in-flight stop completes", { tags: "p1" }, async () => {
        const events: string[] = [];
        const gate = deferred<void>();
        const port = profileRuntime(new RecordingProtectedPort(false));
        const runtime = new InternalProfileFacetRuntime({
            manifest: operationOnlyManifest(descriptor),
            operations: [port.operation(contract, (input) => input.value)],
            runtime: port,
            start: () => {
                events.push("start");
            },
            stop: async () => {
                events.push("stop:begin");
                await gate.promise;
                events.push("stop:end");
            }
        });
        await runtime.start(lifecycle);
        const stopping = runtime.stop(lifecycle);
        const restarting = runtime.start(lifecycle);
        gate.resolve();
        await Promise.all([stopping, restarting]);
        expect(events).toEqual(["start", "stop:begin", "stop:end", "start"]);
        expect(runtime.active).toBe(true);
    });

    test("shares the in-flight stop with concurrent stop callers", { tags: "p1" }, async () => {
        let stops = 0;
        const gate = deferred<void>();
        const port = profileRuntime(new RecordingProtectedPort(false));
        const runtime = new InternalProfileFacetRuntime({
            manifest: operationOnlyManifest(descriptor),
            operations: [port.operation(contract, (input) => input.value)],
            runtime: port,
            stop: async () => {
                stops += 1;
                await gate.promise;
            }
        });
        await runtime.start(lifecycle);
        const first = runtime.stop(lifecycle);
        const second = runtime.stop(lifecycle);
        let secondSettled = false;
        void second.then(() => {
            secondSettled = true;
        });
        for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
        expect(secondSettled).toBe(false);
        gate.resolve();
        await Promise.all([first, second]);
        expect(stops).toBe(1);
        expect(runtime.active).toBe(false);
    });

    test("matches declarations order-insensitively and rejects drift", { tags: "p1" }, () => {
        const descriptorAlpha = new OperationDescriptor(
            new OperationName("alpha"),
            "observe",
            inputSchema,
            outputSchema
        );
        const descriptorBeta = new OperationDescriptor(
            new OperationName("beta"),
            "observe",
            inputSchema,
            outputSchema
        );
        const contractAlpha = new ProfileOperationContract(
            "alpha",
            descriptorAlpha,
            contract.inputCodec,
            contract.outputCodec,
            "output"
        );
        const contractBeta = new ProfileOperationContract(
            "beta",
            descriptorBeta,
            contract.inputCodec,
            contract.outputCodec,
            "output"
        );
        const port = profileRuntime(new RecordingProtectedPort(false));
        const reordered = new FacetManifest({
            id: new FacetPackageId("profile.reordered"),
            version: new SemVer("1.0.0"),
            compat: new CompatRange("^1.0.0", "^1.0.0"),
            isolation: ["bundled"],
            bindings: [],
            contributions: new Contributions([
                new Contribution(new SlotName("operations"), [
                    descriptorBeta.toData(),
                    descriptorAlpha.toData()
                ])
            ])
        });
        expect(
            () =>
                new InternalProfileFacetRuntime({
                    manifest: reordered,
                    operations: [
                        port.operation(contractAlpha, (input) => input.value),
                        port.operation(contractBeta, (input) => input.value)
                    ],
                    runtime: port
                })
        ).not.toThrow();
        expect(
            () =>
                new InternalProfileFacetRuntime({
                    manifest: operationOnlyManifest(descriptorAlpha),
                    operations: [port.operation(contractBeta, (input) => input.value)],
                    runtime: port
                })
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                detailCode: "runtime.declaration"
            })
        );
    });

    test("names duplicate implementations in its declaration error", { tags: "p2" }, () => {
        const port = profileRuntime(new RecordingProtectedPort(false));
        const operation = port.operation(contract, (input) => input.value);
        expect(
            () =>
                new InternalProfileFacetRuntime({
                    manifest: operationOnlyManifest(descriptor),
                    operations: [operation, operation],
                    runtime: port
                })
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                detailCode: "runtime.declaration",
                message: "Internal profile Operation implementations must be unique"
            })
        );
    });
});

describe("W3 standard profile manifest composition", () => {
    test("composes constraint and supplied config schemas", { tags: "p1" }, () => {
        const constraint = new JsonSchema({ type: "object" });
        const supplied = new JsonSchema({
            type: "object",
            properties: { limit: { type: "number" } }
        });
        const composed = createStandardProfileManifest(
            {
                id: new FacetPackageId("profile.configured"),
                version: new SemVer("1.0.0"),
                compat: new CompatRange("^1.0.0", "^1.0.0"),
                bindings: [],
                configSchema: supplied
            },
            {
                isolation: ["bundled"],
                contributions: Contributions.empty(),
                configConstraint: constraint
            }
        );
        expect(composed.configSchema?.document).toEqual({
            allOf: [constraint.document, supplied.document]
        });
        const constrained = createStandardProfileManifest(
            {
                id: new FacetPackageId("profile.constrained"),
                version: new SemVer("1.0.0"),
                compat: new CompatRange("^1.0.0", "^1.0.0"),
                bindings: []
            },
            {
                isolation: ["bundled"],
                contributions: Contributions.empty(),
                configConstraint: constraint
            }
        );
        expect(constrained.configSchema?.document).toEqual(constraint.document);
    });

    test("validates core contribution schemas before admission", { tags: "p1" }, () => {
        const badSchema = { type: "nope" };
        const entries: readonly [string, FacetData][] = [
            [
                "commands",
                {
                    arguments: badSchema,
                    binding: "profile",
                    name: "run",
                    operation: "profile.example:example",
                    surfaces: ["chat"],
                    title: "Run"
                }
            ],
            [
                "events",
                {
                    description: "Example",
                    kind: "example.event",
                    payload: badSchema,
                    visibility: "workspace"
                }
            ],
            [
                "operations",
                {
                    impact: "observe",
                    input: badSchema,
                    interceptable: false,
                    name: "bad",
                    output: {}
                }
            ]
        ];
        for (const [slot, entry] of entries) {
            expect(() =>
                createStandardProfileManifest(
                    {
                        id: new FacetPackageId("profile.invalid"),
                        version: new SemVer("1.0.0"),
                        compat: new CompatRange("^1.0.0", "^1.0.0"),
                        bindings: []
                    },
                    {
                        isolation: ["bundled"],
                        contributions: new Contributions([
                            new Contribution(new SlotName(slot), [entry])
                        ])
                    }
                )
            ).toThrow(/Unsupported JSON Schema/);
        }
    });

    test("rejects contributions to undeclared slots with manifest detail", { tags: "p1" }, () => {
        expect(() =>
            createStandardProfileManifest(
                {
                    id: new FacetPackageId("profile.undeclared"),
                    version: new SemVer("1.0.0"),
                    compat: new CompatRange("^1.0.0", "^1.0.0"),
                    bindings: []
                },
                {
                    isolation: ["bundled"],
                    contributions: new Contributions([
                        new Contribution(new SlotName("custom"), [{ enabled: true }])
                    ])
                }
            )
        ).toThrowError(
            expect.objectContaining({
                name: "DetailedProfileError",
                code: "protocol.invalid-state",
                detailCode: "manifest.invalid",
                message: "Standard profile contribution targets undeclared slot custom"
            })
        );
    });
});

class PassThroughInterceptor extends Interceptor {
    public constructor(public readonly declaration: InterceptorDeclaration) {
        super();
    }

    public intercept(_context: InterceptContext, value: FacetData): InterceptResult {
        return { proceed: true, value };
    }
}

class RecordingProtectedPort extends ProtectedOperationPort<never> {
    public readonly operations: ProtectedOperationRequest["operation"][] = [];

    public constructor(private readonly attempted: boolean) {
        super();
    }

    public async invoke(
        request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<never>> {
        this.operations.push(request.operation);
        return {
            kind: "output",
            output: await request.operation.execute(operationContext(this.attempted), request.input)
        };
    }
}

class OutputSubstitutionPort extends ProtectedOperationPort<never> {
    public async invoke(): Promise<ProtectedOperationResult<never>> {
        return { kind: "output", output: "output" };
    }
}

class RecordingEffects extends ProfileRuntimeEffectsPort {
    public async emit(): Promise<void> {}

    public async control(
        _host: ProfileRuntimeHostBinding,
        _control: ProfileControlAdmission,
        input: FacetData,
        execute: (input: FacetData) => Promise<FacetData>
    ): Promise<FacetData> {
        return execute(input);
    }

    public async render(
        _host: ProfileRuntimeHostBinding,
        _descriptor: SurfaceDescriptor,
        _context: OperationContext,
        input: FacetData
    ): Promise<FacetData> {
        return input;
    }
}

function profileRuntime(port: ProtectedOperationPort<never>): ProtectedProfileRuntimePort<never> {
    const runtime = new ProtectedProfileRuntimePort(
        new ProfileRuntimeHostBinding(
            new FacetRef("workspace:profile"),
            new BindingName("profile")
        ),
        port,
        new RecordingEffects()
    );
    runtime.activate();
    return runtime;
}

function operationContext(attempted: boolean): OperationContext {
    return Object.freeze({
        invocation: new InvocationId("profile-invocation"),
        itemIndex: 0,
        idempotencyKey: "profile-key",
        ...(attempted
            ? {
                  attempt: Object.freeze({
                      id: new EffectAttemptId("profile-attempt"),
                      ordinal: 2,
                      intentDigest: new Digest("a".repeat(64))
                  })
              }
            : {}),
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}

function operationManifest(
    operation: OperationDescriptor,
    surface: SurfaceDescriptor
): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId("profile.runtime"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        isolation: ["bundled"],
        bindings: [],
        contributions: new Contributions([
            new Contribution(new SlotName("operations"), [operation.toData()]),
            new Contribution(new SlotName("surfaces"), [surface.toData()])
        ])
    });
}

function emptyManifest(id: string): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId(id),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        isolation: ["bundled"],
        bindings: [],
        contributions: Contributions.empty()
    });
}

function operationOnlyManifest(operation: OperationDescriptor): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId("profile.lifecycle"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        isolation: ["bundled"],
        bindings: [],
        contributions: new Contributions([
            new Contribution(new SlotName("operations"), [operation.toData()])
        ])
    });
}

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
} {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

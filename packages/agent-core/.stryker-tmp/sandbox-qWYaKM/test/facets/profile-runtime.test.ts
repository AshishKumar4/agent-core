// @ts-nocheck
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
    OperationDescriptor,
    OperationName,
    ProtectedOperationPort,
    SlotName,
    SurfaceDescriptor,
    SurfaceId,
    type FacetData,
    type OperationContext,
    type ProtectedOperationRequest,
    type ProtectedOperationResult
} from "../../src/facets";
import {
    InternalProfileFacetRuntime,
    ProfileControlContract,
    ProfileEffectContext,
    ProfileEventContract,
    ProfileOperationContract,
    ProfileRuntimeEffectsPort,
    ProfileRuntimeHostBinding,
    ProtectedProfileRuntimePort,
    createStandardProfileManifest,
    profileWireCodec,
    strictObjectSchema,
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
        expect(() => voidProfileWireCodec.decode("not-null" as never)).toThrowError(
            expect.objectContaining({ detailCode: "wire.input" })
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
        ).rejects.toMatchObject({ code: "operation.invalid-output", detailCode: "wire.output" });

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
        ).rejects.toMatchObject({ code: "operation.invalid-input", detailCode: "wire.input" });

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
        ).rejects.toMatchObject({ code: "operation.invalid-output", detailCode: "wire.output" });

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
        ).rejects.toMatchObject({ code: "operation.invalid-input", detailCode: "wire.input" });

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
        ).rejects.toMatchObject({ code: "operation.invalid-output", detailCode: "wire.output" });
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

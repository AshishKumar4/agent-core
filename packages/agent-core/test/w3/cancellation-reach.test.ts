import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "../../src/content";
import { CompatRange, JsonSchema, SemVer } from "../../src/core";
import { InvocationId } from "../../src/interaction-references";
import {
    BindingName,
    Contribution,
    Contributions,
    Facet,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    FilesystemFacet,
    MemoryFilesystemBackend,
    OperationDescriptor,
    OperationName,
    ProfileEffectContext,
    ProfileRuntimeEffectsPort,
    ProfileRuntimeHostBinding,
    ProtectedOperationPort,
    ProtectedProfileRuntimePort,
    SHELL_OPERATION_CONTRACTS,
    ShellBackend,
    ShellCommandRegistryBackend,
    ShellExecutionId,
    ShellFacet,
    ShellIoBackend,
    ShellTerminationClock,
    SlotName,
    type FacetData,
    type FacetDataMap,
    type FacetLifecycleContext,
    type Interceptor,
    type InterceptorDeclaration,
    type Operation,
    type OperationContext,
    type ProfileControlAdmission,
    type ProtectedOperationRequest,
    type ProtectedOperationResult,
    type ShellIo,
    type ShellProcessBackend,
    type Surface,
    type SurfaceId
} from "../../src/facets";
import { FacetCorrespondenceValidator } from "../../src/operations";

const objectSchema = new JsonSchema({ type: "object" });
const shellPackage = new FacetPackageId("profile.shell");
const shellFacet = new FacetRef("profile.shell:session");

/**
 * SPEC §4.1 (C13-FACET-CANCELLATION-REACH): the declared-input half of the rule.
 * Cancellation reaches a handler through its `OperationContext`, so a declaration offering
 * it as an authored field is refused where the declaration is read — which is every path
 * that builds an Operation, including the install-time decode of a pinned manifest.
 */
describe("Declared input cancellation exclusion", () => {
    test(
        "[C13-FACET-CANCELLATION-REACH] refuses a declared input that offers a cancellation field at any depth",
        { tags: "p0" },
        () => {
            const declare =
                (input: FacetDataMap): (() => OperationDescriptor) =>
                () =>
                    new OperationDescriptor(
                        new OperationName("run"),
                        "execute",
                        new JsonSchema(input),
                        objectSchema
                    );

            for (const name of ["signal", "abortSignal", "abort_signal", "cancellation"]) {
                expect(
                    declare({ type: "object", properties: { [name]: { type: "object" } } })
                ).toThrow(`Operation run input schema must not declare ${name}`);
            }

            // A nested object is the same authored surface one level down, a required name is
            // offered wherever additional properties are admitted, and a combinator branch is
            // still the declared input, so none of the three spellings escapes the screen.
            expect(
                declare({
                    type: "object",
                    properties: {
                        options: { type: "object", properties: { cancelToken: { type: "string" } } }
                    }
                })
            ).toThrow("must not declare cancelToken");
            expect(declare({ type: "object", required: ["cancellationSignal"] })).toThrow(
                "must not declare cancellationSignal"
            );
            expect(
                declare({ anyOf: [{ type: "object", properties: { abort: { type: "boolean" } } }] })
            ).toThrow("must not declare abort");
        }
    );

    test(
        "[C13-FACET-CANCELLATION-REACH] admits a declared field whose name states a datum rather than the cancellation",
        { tags: "p1" },
        () => {
            // The defect is the claim, not the spelling: a caller authors a reason and an
            // execution id, and neither purports to carry the thing only the host owns.
            const descriptor = new OperationDescriptor(
                new OperationName("cancel"),
                "mutate",
                new JsonSchema({
                    type: "object",
                    properties: {
                        cancelReason: { type: "string" },
                        executionId: { type: "string" },
                        signalStrength: { type: "integer" }
                    },
                    required: ["executionId"]
                }),
                objectSchema
            );
            expect(descriptor.input.document).toMatchObject({ required: ["executionId"] });
        }
    );

    test(
        "[C13-FACET-CANCELLATION-REACH] refuses the install rather than the first invocation of a cancellation-carrying declaration",
        { tags: "p0" },
        () => {
            const facet = new CancellationDeclaringFacet();

            // Install-time verification decodes the pinned `operations` contribution before it
            // looks for a runtime implementation, so the declaration is refused with no handler
            // resolved, no `start`, and no invocation.
            expect(() =>
                new FacetCorrespondenceValidator().validate([facet.manifest], [facet])
            ).toThrow("must not declare signal");
            expect(facet.resolved).toEqual([]);
            expect(facet.starts).toBe(0);

            // The same refusal reaches the wire form the manifest carries, so no decode path
            // admits what construction refuses.
            expect(() => OperationDescriptor.fromData(cancellationDeclaringData())).toThrow(
                "must not declare signal"
            );
        }
    );
});

/**
 * SPEC §4.1 (C13-FACET-CANCELLATION-REACH): the propagation half. A handler that awaits
 * further asynchronous work under its own invocation's lifetime passes the cancellation on,
 * and a bound it derives stays linked to the cancellation it derived from. §11.2 Shell is
 * the sharpest case, because the work it awaits is a live process it owns.
 */
describe("Profile handler cancellation propagation", () => {
    test(
        "[C13-FACET-CANCELLATION-REACH] a §11.2 Shell run passes its invocation cancellation to the process that owns the effect",
        { tags: "p0" },
        async () => {
            const process = new HeldProcess();
            const registry = new ShellCommandRegistryBackend<unknown>();
            registry.register("held", { start: () => process });
            const admission = new ContextRecordingAdmission();
            const shell = new ShellFacet(
                profileRuntime(admission),
                new ShellBackend(
                    { fs: filesystemFacet() },
                    registry,
                    new SilentIoBackend(),
                    { confirmationMilliseconds: 0 },
                    new ImmediateTerminationClock()
                )
            );

            const running = shell.run({
                executionId: new ShellExecutionId("held"),
                commandLine: "held"
            });
            await admission.entered;
            expect(process.forceTerminations).toBe(0);

            // The handler is suspended on work whose only lifetime is this invocation's, and
            // the Turn's cancellation reaches it there rather than only at its entry.
            admission.cancel();

            // The abort reached the side-effect owner and the awaited work reached quiescence:
            // the run returns the exit code the boundary settled on rather than abandoning its
            // own wait, which is what separates this from an indeterminate attempt.
            await expect(running).resolves.toBe(137);
            expect(process.forceTerminations).toBe(1);
            expect(admission.observed?.cancellation.aborted).toBe(true);
        }
    );

    test(
        "[C13-FACET-CANCELLATION-REACH] the context conveys the invocation's own signal and a derived bound stays linked to it",
        { tags: "p0" },
        async () => {
            const controller = new AbortController();
            const context = ProfileEffectContext.fromOperation(operationContext(controller.signal));

            // Not a substitute: the profile handler observes the exact signal its
            // OperationContext conveyed, which is what makes the two claims one claim.
            expect(context.cancellation).toBe(controller.signal);

            const derived = context.bound(60_000);
            expect(derived.aborted).toBe(false);
            controller.abort();
            expect(derived.aborted).toBe(true);
            expect(context.cancellation.aborted).toBe(true);

            // The bound is still a bound: it fires on its own where the upstream cancellation
            // does not, so linking it costs the handler nothing it wanted from it. The wait is
            // on the signal's own event rather than on a duration.
            const live = ProfileEffectContext.fromOperation(
                operationContext(new AbortController().signal)
            );
            const elapsing = live.bound(0);
            // The executor form is required here: `lib` is ES2023, which has no
            // Promise.withResolvers.
            await new Promise<void>((resolve) => {
                elapsing.addEventListener("abort", () => resolve(), { once: true });
            });
            expect(elapsing.aborted).toBe(true);
            expect(live.cancellation.aborted).toBe(false);
            expect(() => live.bound(-1)).toThrow(
                "Profile effect bound must be a non-negative safe integer"
            );
        }
    );

    test(
        "[C13-FACET-CANCELLATION-REACH] the declared §11.2 run contract is the one this propagation was proved over",
        { tags: "p2" },
        () => {
            // A drift in the contract the two tests above drive would leave them proving
            // propagation for an Operation §11.2 no longer declares.
            expect(SHELL_OPERATION_CONTRACTS.run.descriptor.impact).toBe("execute");
            expect(SHELL_OPERATION_CONTRACTS.run.descriptor.name.value).toBe("run");
        }
    );
});

function cancellationDeclaringData(): FacetDataMap {
    return {
        impact: "execute",
        input: { type: "object", properties: { signal: { type: "object" } } },
        name: "run",
        output: { type: "object" }
    };
}

/**
 * A Facet whose pinned manifest declares an Operation input claiming to carry cancellation.
 * Its runtime cannot declare the matching descriptor — construction refuses it — so the
 * manifest is the only place such a declaration survives, which is exactly the shape
 * install-time verification has to refuse.
 */
class CancellationDeclaringFacet extends Facet {
    public readonly ref = shellFacet;
    public readonly manifest: FacetManifest;
    public readonly resolved: string[] = [];
    public starts = 0;

    public constructor() {
        super();
        this.manifest = new FacetManifest({
            id: shellPackage,
            version: new SemVer("1.0.0"),
            compat: new CompatRange("^1.0.0", "^1.0.0"),
            isolation: ["bundled"],
            bindings: [],
            contributions: new Contributions([
                new Contribution(new SlotName("operations"), [cancellationDeclaringData()])
            ])
        });
    }

    public operation(name: OperationName): Operation | undefined {
        this.resolved.push(name.value);
        return undefined;
    }

    public surface(_id: SurfaceId): Surface | undefined {
        return undefined;
    }

    public interceptor(_id: InterceptorDeclaration["id"]): Interceptor | undefined {
        return undefined;
    }

    public children(): readonly Facet[] {
        return [];
    }

    public async start(_context: FacetLifecycleContext): Promise<void> {
        this.starts += 1;
    }

    public async stop(_context: FacetLifecycleContext): Promise<void> {}
}

/**
 * The protected seam a profile Operation is admitted through, standing in for the mediated
 * pipeline: it hands the handler one real `OperationContext` under a cancellation this test
 * owns, and reports when the handler entered so the abort lands mid-execution.
 */
class ContextRecordingAdmission extends ProtectedOperationPort<unknown> {
    public observed: ProfileEffectContext | undefined;
    public readonly entered: Promise<void>;
    readonly #controller = new AbortController();
    #reached: (() => void) | undefined;

    public constructor() {
        super();
        // The executor form is required here: `lib` is ES2023, which has no
        // Promise.withResolvers.
        this.entered = new Promise<void>((resolve) => {
            this.#reached = resolve;
        });
    }

    public cancel(): void {
        this.#controller.abort();
    }

    public async invoke(
        request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<unknown>> {
        const context = operationContext(this.#controller.signal);
        this.observed = ProfileEffectContext.fromOperation(context);
        // Started, not awaited: the handler runs to its first suspension before this reports
        // entry, so a cancellation delivered afterwards lands inside the handler's execution.
        const output = request.operation.execute(context, request.input);
        this.#reached?.();
        return { kind: "output", output: await output };
    }
}

class SilentProfileEffects extends ProfileRuntimeEffectsPort<unknown> {
    public async emit(): Promise<void> {}

    public control(
        _host: ProfileRuntimeHostBinding,
        _control: ProfileControlAdmission,
        input: FacetData,
        execute: (input: FacetData) => Promise<FacetData>
    ): Promise<FacetData> {
        return execute(input);
    }

    public async render(): Promise<FacetData> {
        return {};
    }
}

/** A process that never completes on its own, so only cancellation can end its execution. */
class HeldProcess implements ShellProcessBackend {
    public forceTerminations = 0;
    public readonly completion: Promise<number>;

    public constructor() {
        // The executor form is required here: `lib` is ES2023, which has no
        // Promise.withResolvers.
        this.completion = new Promise<number>(() => {});
    }

    public forceTerminate(): void {
        this.forceTerminations += 1;
    }

    public confirmTerminated(): boolean {
        return true;
    }

    public fence(): void {}
}

class SilentIoBackend extends ShellIoBackend {
    public open(): ShellIo {
        return {
            stdin: (async function* (): AsyncIterable<Uint8Array> {})(),
            writeStdout() {},
            writeStderr() {}
        };
    }
}

class ImmediateTerminationClock extends ShellTerminationClock {
    public async wait(): Promise<void> {}
}

function profileRuntime(
    admission: ProtectedOperationPort<unknown>
): ProtectedProfileRuntimePort<unknown> {
    const runtime = new ProtectedProfileRuntimePort<unknown>(
        new ProfileRuntimeHostBinding(shellFacet, new BindingName("shell")),
        admission,
        new SilentProfileEffects()
    );
    runtime.activate();
    return runtime;
}

function filesystemFacet(): FilesystemFacet<unknown> {
    return new FilesystemFacet(
        profileRuntime(new ContextRecordingAdmission()),
        new MemoryFilesystemBackend()
    );
}

function operationContext(signal: AbortSignal): OperationContext {
    return Object.freeze({
        invocation: new InvocationId("cancellation-reach-invocation"),
        itemIndex: 0,
        idempotencyKey: "cancellation-reach-key",
        signal,
        content: new MemoryContentStore()
    });
}

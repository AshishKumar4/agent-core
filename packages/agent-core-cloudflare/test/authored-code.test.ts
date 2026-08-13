import { BindingName, FacetRef, type FacetData } from "@agent-core/core/facets";
import {
    AuthoredCodeCapability,
    AuthoredCodeCapabilitySet,
    AuthoredCodeInvocationPort,
    type AuthoredCodeInvocationRequest,
    type AuthoredCodeRunRequest
} from "@agent-core/core/operations";
import {
    DISPATCH_NAMESPACE_BACKING,
    DispatchNamespaceAdapter,
    DispatchNamespaceAuthoredCodeBacking,
    DynamicWorkerLoaderAdapter,
    PassedCapabilityRegistry,
    WORKER_LOADER_BACKING,
    WorkerLoaderAuthoredCodeBacking,
    passedCapabilities,
    type AuthoredCodeEntrypointLike,
    type DispatchedAuthoredCodeEntrypointLike,
    type DynamicWorkerHandleLike,
    type DynamicWorkerLoadOptions,
    type PassedCapabilities,
    type PassedCapabilityProps,
    type WorkerLoaderBindingLike
} from "../src/index.js";
import { malformedInput } from "./assertions.js";
import { fakeErrors } from "./fakes.js";

const mailBinding = new BindingName("mail");
const notesBinding = new BindingName("notes");
const mailFacet = new FacetRef("mail:instance");
const notesFacet = new FacetRef("notes:instance");

const isolate = "invocation:authored-code-1";

/**
 * Stands in for `ctx.exports.<Entrypoint>({ props })`: the host builds a stub carrying
 * only routing data, and every call on it resolves the live port through the registry.
 */
function capabilityFactory(registry: PassedCapabilityRegistry) {
    return (props: PassedCapabilityProps) => ({
        invoke: (operation: string, input: FacetData) => registry.invoke(props, operation, input)
    });
}

describe("Cloudflare backings for §4.7 agent-authored code", () => {
    test("loads a fresh isolate whose whole environment is the delegated set", async () => {
        const registry = new PassedCapabilityRegistry(fakeErrors);
        const loader = new RecordingWorkerLoader((env, input) => ({
            names: Object.keys(env).sort(),
            input
        }));
        const backing = new WorkerLoaderAuthoredCodeBacking(
            new DynamicWorkerLoaderAdapter(loader, fakeErrors),
            "2026-07-10",
            registry,
            capabilityFactory(registry),
            fakeErrors
        );

        await expect(backing.run(runRequest())).resolves.toEqual({
            names: ["mail", "notes"],
            input: { folder: "inbox" }
        });
        expect(backing.id.value).toBe(WORKER_LOADER_BACKING.value);
        const call = loader.calls[0]!;
        expect(Object.keys(call.env).sort()).toEqual(["mail", "notes"]);
        expect(call.globalOutbound).toBe(null);
        // The reference implementation's own hardening: loaded code that could import
        // its worker's exports could call around the one channel it was given.
        expect(call.compatibilityFlags).toEqual(["disallow_importable_env"]);
        expect(loader.disposals).toBe(1);
    });

    test("carries an env binding's call back through the Invocation port", async () => {
        const registry = new PassedCapabilityRegistry(fakeErrors);
        const invocations = new RecordingInvocations();
        const loader = new RecordingWorkerLoader((env) =>
            env["mail"]!.invoke("read", { path: "/a" })
        );
        const backing = new WorkerLoaderAuthoredCodeBacking(
            new DynamicWorkerLoaderAdapter(loader, fakeErrors),
            "2026-07-10",
            registry,
            capabilityFactory(registry),
            fakeErrors
        );

        await expect(backing.run(runRequest(invocations))).resolves.toEqual({
            binding: "mail",
            operation: "read",
            input: { path: "/a" }
        });
        // The Binding a stub speaks through is the host's, fixed in its props when the
        // host built it; loaded code chooses only the operation and the input.
        expect(invocations.requests).toEqual([["mail", "read"]]);
    });

    test("severs a capability whose submission has ended", async () => {
        const registry = new PassedCapabilityRegistry(fakeErrors);
        const invocations = new RecordingInvocations();
        let escaped: PassedCapabilities | undefined;
        const loader = new RecordingWorkerLoader((env) => {
            escaped = env;
            return null;
        });
        const backing = new WorkerLoaderAuthoredCodeBacking(
            new DynamicWorkerLoaderAdapter(loader, fakeErrors),
            "2026-07-10",
            registry,
            capabilityFactory(registry),
            fakeErrors
        );

        await backing.run(runRequest(invocations));

        // A stub that outlived its isolate resolves to nothing, not to whatever runs next.
        await expect(escaped!["mail"]!.invoke("read", null)).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(invocations.requests).toEqual([]);
    });

    test("refuses two live isolates under one identity", () => {
        const registry = new PassedCapabilityRegistry(fakeErrors);
        const port = new RecordingInvocations();
        using first = registry.open(isolate, port);
        void first;
        expect(() => registry.open(isolate, port)).toThrow(
            expect.objectContaining({ code: "protocol.invalid-state" })
        );
    });

    test("refuses code with no entry point or a returned value that is not data", async () => {
        const registry = new PassedCapabilityRegistry(fakeErrors);
        const noEntrypoint = new WorkerLoaderAuthoredCodeBacking(
            new DynamicWorkerLoaderAdapter(
                new StubWorkerLoader(() => malformedInput("not-an-entrypoint")),
                fakeErrors
            ),
            "2026-07-10",
            registry,
            capabilityFactory(registry),
            fakeErrors
        );
        await expect(noEntrypoint.run(runRequest())).rejects.toMatchObject({
            code: "operation.invalid-output"
        });

        const notData = new WorkerLoaderAuthoredCodeBacking(
            new DynamicWorkerLoaderAdapter(
                new StubWorkerLoader(() => ({ run: () => ({ leaked: () => undefined }) })),
                fakeErrors
            ),
            "2026-07-10",
            registry,
            capabilityFactory(registry),
            fakeErrors
        );
        await expect(notData.run(runRequest())).rejects.toMatchObject({
            code: "operation.invalid-output"
        });
    });

    test("serves pre-deployed code from the script the platform's naming rule names", async () => {
        const registry = new PassedCapabilityRegistry(fakeErrors);
        const namespace = new RecordingDispatchNamespace((capabilities) => ({
            names: Object.keys(capabilities).sort()
        }));
        const backing = new DispatchNamespaceAuthoredCodeBacking(
            new DispatchNamespaceAdapter(namespace, fakeErrors),
            (request) => `slate-${request.entry}`,
            registry,
            capabilityFactory(registry),
            fakeErrors
        );

        await expect(backing.run(runRequest())).resolves.toEqual({ names: ["mail", "notes"] });
        expect(backing.id.value).toBe(DISPATCH_NAMESPACE_BACKING.value);
        expect(namespace.scripts).toEqual(["slate-index.js"]);
    });

    test("refuses pre-deployed code that exposes no entry point", async () => {
        const registry = new PassedCapabilityRegistry(fakeErrors);
        const backing = new DispatchNamespaceAuthoredCodeBacking(
            new DispatchNamespaceAdapter(
                { get: () => malformedInput("not-an-entrypoint") },
                fakeErrors
            ),
            () => "slate",
            registry,
            capabilityFactory(registry),
            fakeErrors
        );
        await expect(backing.run(runRequest())).rejects.toMatchObject({
            code: "operation.invalid-output"
        });
    });

    test("renders exactly the delegated Bindings and nothing else", () => {
        const registry = new PassedCapabilityRegistry(fakeErrors);
        const rendered = passedCapabilities(capabilitySet(), isolate, capabilityFactory(registry));

        expect(Object.keys(rendered).sort()).toEqual(["mail", "notes"]);
        expect(Object.isFrozen(rendered)).toBe(true);
        expect(
            passedCapabilities(AuthoredCodeCapabilitySet.none, isolate, capabilityFactory(registry))
        ).toEqual({});
    });
});

function capabilitySet(): AuthoredCodeCapabilitySet {
    return new AuthoredCodeCapabilitySet([
        new AuthoredCodeCapability(mailBinding, mailFacet),
        new AuthoredCodeCapability(notesBinding, notesFacet)
    ]);
}

function runRequest(invocations: AuthoredCodeInvocationPort = new RecordingInvocations()) {
    return {
        consumer: "programmaticToolCall",
        isolate,
        entry: "index.js",
        code: new Map([["index.js", "export default {}"]]),
        capabilities: capabilitySet(),
        invocations,
        input: { folder: "inbox" },
        signal: new AbortController().signal
    } satisfies AuthoredCodeRunRequest;
}

class RecordingInvocations extends AuthoredCodeInvocationPort {
    public readonly requests: Array<readonly [string, string]> = [];

    public async invoke(request: AuthoredCodeInvocationRequest): Promise<FacetData> {
        this.requests.push([request.binding.value, request.operation.value]);
        return {
            binding: request.binding.value,
            operation: request.operation.value,
            input: request.input
        };
    }
}

class RecordingWorkerLoader implements WorkerLoaderBindingLike {
    public readonly calls: DynamicWorkerLoadOptions[] = [];
    public disposals = 0;

    public constructor(
        private readonly run: (
            env: PassedCapabilities,
            input: FacetData
        ) => FacetData | Promise<FacetData>
    ) {}

    public load(options: DynamicWorkerLoadOptions): DynamicWorkerHandleLike {
        this.calls.push(options);
        return {
            getEntrypoint: () => ({
                run: (input: FacetData) => this.run(options.env, input)
            }),
            [Symbol.dispose]: () => {
                this.disposals += 1;
            }
        };
    }
}

class StubWorkerLoader implements WorkerLoaderBindingLike {
    public constructor(private readonly entrypoint: () => AuthoredCodeEntrypointLike) {}

    public load(): DynamicWorkerHandleLike {
        return { getEntrypoint: () => this.entrypoint(), [Symbol.dispose]: () => undefined };
    }
}

class RecordingDispatchNamespace {
    public readonly scripts: string[] = [];

    public constructor(private readonly run: (capabilities: PassedCapabilities) => FacetData) {}

    public get(scriptName: string): DispatchedAuthoredCodeEntrypointLike {
        this.scripts.push(scriptName);
        return {
            run: (capabilities: PassedCapabilities) => this.run(capabilities)
        };
    }
}

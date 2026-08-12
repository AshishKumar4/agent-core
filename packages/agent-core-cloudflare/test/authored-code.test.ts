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
    WORKER_LOADER_BACKING,
    WorkerLoaderAuthoredCodeBacking,
    createPassedCapabilityFactory,
    passedCapabilities,
    type AuthoredCodeCallLike,
    type DynamicWorkerHandleLike,
    type DynamicWorkerLoadOptions,
    type WorkerLoaderBindingLike
} from "../src/index.js";
import { fakeErrors } from "./fakes.js";

const mailBinding = new BindingName("mail");
const notesBinding = new BindingName("notes");
const mailFacet = new FacetRef("mail:instance");
const notesFacet = new FacetRef("notes:instance");

/** Stands in for the isolate boundary base class the host supplies (RpcTarget). */
class TestBoundaryTarget {}

describe("Cloudflare backings for §4.7 agent-authored code", () => {
    test("loads a fresh isolate with an empty environment and no ambient outbound", async () => {
        const loader = new RecordingWorkerLoader((call) => ({
            names: Object.keys(call.capabilities).sort(),
            input: call.input
        }));
        const backing = new WorkerLoaderAuthoredCodeBacking(
            new DynamicWorkerLoaderAdapter(loader, fakeErrors),
            "2026-07-10",
            createPassedCapabilityFactory(TestBoundaryTarget),
            fakeErrors
        );

        await expect(backing.run(runRequest())).resolves.toEqual({
            names: ["mail", "notes"],
            input: { folder: "inbox" }
        });
        expect(backing.id.value).toBe(WORKER_LOADER_BACKING.value);
        expect(loader.calls).toEqual([
            {
                compatibilityDate: "2026-07-10",
                mainModule: "index.js",
                modules: { "index.js": "export default {}" },
                env: {},
                globalOutbound: null
            }
        ]);
        expect(loader.disposals).toBe(1);
    });

    test("carries an isolate's call back through the Invocation port it was passed", async () => {
        const invocations = new RecordingInvocations();
        const loader = new RecordingWorkerLoader((call) =>
            call.capabilities["mail"]!.invoke("read", { path: "/a" })
        );
        const backing = new WorkerLoaderAuthoredCodeBacking(
            new DynamicWorkerLoaderAdapter(loader, fakeErrors),
            "2026-07-10",
            createPassedCapabilityFactory(TestBoundaryTarget),
            fakeErrors
        );

        await expect(backing.run(runRequest(invocations))).resolves.toEqual({
            binding: "mail",
            operation: "read",
            input: { path: "/a" }
        });
        // A capability the isolate holds is a Binding name and an operation, never a
        // channel it chose for itself.
        expect(invocations.requests).toEqual([["mail", "read"]]);
    });

    test("refuses code that exposes no entry point or returns a value that is not data", async () => {
        const noEntrypoint = new WorkerLoaderAuthoredCodeBacking(
            new DynamicWorkerLoaderAdapter(
                new StubWorkerLoader(() => "not-an-entrypoint"),
                fakeErrors
            ),
            "2026-07-10",
            createPassedCapabilityFactory(TestBoundaryTarget),
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
            createPassedCapabilityFactory(TestBoundaryTarget),
            fakeErrors
        );
        await expect(notData.run(runRequest())).rejects.toMatchObject({
            code: "operation.invalid-output"
        });
    });

    test("serves pre-deployed code from the script the platform's naming rule names", async () => {
        const namespace = new RecordingDispatchNamespace((call) => ({
            names: Object.keys(call.capabilities).sort()
        }));
        const backing = new DispatchNamespaceAuthoredCodeBacking(
            new DispatchNamespaceAdapter(namespace, fakeErrors),
            (request) => `slate-${request.entry}`,
            createPassedCapabilityFactory(TestBoundaryTarget),
            fakeErrors
        );

        await expect(backing.run(runRequest())).resolves.toEqual({ names: ["mail", "notes"] });
        expect(backing.id.value).toBe(DISPATCH_NAMESPACE_BACKING.value);
        expect(namespace.scripts).toEqual(["slate-index.js"]);
    });

    test("refuses pre-deployed code that exposes no entry point", async () => {
        const backing = new DispatchNamespaceAuthoredCodeBacking(
            new DispatchNamespaceAdapter({ get: () => "not-an-entrypoint" as unknown }, fakeErrors),
            () => "slate",
            createPassedCapabilityFactory(TestBoundaryTarget),
            fakeErrors
        );
        await expect(backing.run(runRequest())).rejects.toMatchObject({
            code: "operation.invalid-output"
        });
    });

    test("renders exactly the delegated Bindings and nothing else", () => {
        const invocations = new RecordingInvocations();
        const rendered = passedCapabilities(
            capabilitySet(),
            invocations,
            createPassedCapabilityFactory(TestBoundaryTarget)
        );

        expect(Object.keys(rendered).sort()).toEqual(["mail", "notes"]);
        expect(rendered["mail"]).toBeInstanceOf(TestBoundaryTarget);
        expect(
            passedCapabilities(
                AuthoredCodeCapabilitySet.none,
                invocations,
                createPassedCapabilityFactory(TestBoundaryTarget)
            )
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

    public constructor(private readonly run: (call: AuthoredCodeCallLike) => unknown) {}

    public load(options: DynamicWorkerLoadOptions): DynamicWorkerHandleLike {
        this.calls.push(options);
        return {
            getEntrypoint: () => ({ run: (call: AuthoredCodeCallLike) => this.run(call) }),
            [Symbol.dispose]: () => {
                this.disposals += 1;
            }
        };
    }
}

class StubWorkerLoader implements WorkerLoaderBindingLike {
    public constructor(private readonly entrypoint: () => unknown) {}

    public load(): DynamicWorkerHandleLike {
        return { getEntrypoint: () => this.entrypoint(), [Symbol.dispose]: () => undefined };
    }
}

class RecordingDispatchNamespace {
    public readonly scripts: string[] = [];

    public constructor(private readonly run: (call: AuthoredCodeCallLike) => unknown) {}

    public get(scriptName: string): unknown {
        this.scripts.push(scriptName);
        return { run: (call: AuthoredCodeCallLike) => this.run(call) };
    }
}

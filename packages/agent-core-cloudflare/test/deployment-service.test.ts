import { AgentCoreError } from "@agent-core/core";
import {
    DispatchNamespaceAdapter,
    DynamicWorkerLoaderAdapter,
    ExplicitCloudflareDeploymentAdapter,
    type CloudflareDeployment,
    type DispatchNamespaceLike,
    type DynamicWorkerHandleLike,
    type DynamicWorkerLoadOptions,
    type FetchServiceLike,
    type ScopedFetchServiceLike,
    type WorkerLoaderBindingLike
} from "../src/index.js";
import { malformedInput } from "./assertions.js";
import { fakeErrors, fakeWorkerLimits } from "./fakes.js";
import {
    CONTRACT_PARAMETERS,
    CONTRACT_REQUEST_URL,
    CONTRACT_SCRIPT_NAME,
    CONTRACT_SOURCE,
    DEPLOYMENT_OPERATIONS,
    DEPLOYMENT_TAXONOMY,
    DESTINATION_FAILURE,
    deploymentContract,
    type DeploymentGateway,
    type DeploymentImplementation,
    type DeploymentScenario,
    type DeploymentTransport
} from "./deployment-service-contract.js";

/**
 * The `dispatch.deployment` contract, run against both implementations the repository
 * admits: a reference gateway that performs the declared protocol directly, and the real
 * `ExplicitCloudflareDeploymentAdapter` over `DispatchNamespaceAdapter` and
 * `DynamicWorkerLoaderAdapter`.
 *
 * What is real and what is a double, precisely. Real: every line of `dispatch.ts`,
 * `deployment.ts` and `loader.ts` that runs in the adapter row — the input validation,
 * the resolution try/catch, the absent-service check, `isFetchService`, the two scope
 * classes, and the `finally` that releases the scope. Doubles: the platform bindings only
 * — `DispatchNamespaceLike.get` and `WorkerLoaderBindingLike.load` stand in for the
 * Workers-for-Platforms dispatch namespace and the Worker Loader, and the destination is
 * an in-process `FetchServiceLike` rather than a foreign isolate. `namespaceFor` is
 * shared by both rows, so the two implementations differ only in who speaks the protocol
 * over the same platform.
 *
 * The reference row is the control: it is what the contract would look like if the
 * transport were perfect, so a case only the adapter fails is a fact about the adapter
 * rather than about the suite.
 *
 * A real dispatch namespace is not reachable in any local lane — it needs a
 * Workers-for-Platforms account, an uploaded tenant script, and a deployed dispatch
 * binding — so nothing here observes real cross-isolate transport, real stub disposal, or
 * real dispatch-parameter propagation. That is stated as a premise in the report.
 */

/**
 * The platform both rows resolve through. Nothing here names a taxonomy code: the
 * classification under test belongs to the implementation, so the double only produces
 * the binding-level condition and lets the protocol decide what it means.
 */
function namespaceFor(
    scenario: DeploymentScenario,
    destination: FetchServiceLike
): DispatchNamespaceLike<FetchServiceLike> {
    return {
        get: (): FetchServiceLike => {
            if (scenario.kind === "faults") {
                // A broken RPC stub. Property access on a Workers stub whose session has
                // gone away throws, and both implementations read `.fetch` to check the
                // shape — outside every try/catch in `ExplicitCloudflareDeploymentAdapter`
                // — so this is the seam's own undeclared failure rather than the
                // destination's.
                const stub = {};
                Object.defineProperty(stub, "fetch", {
                    get: (): never => {
                        throw new TypeError("Dispatch stub is broken");
                    }
                });
                return malformedInput(stub);
            }
            if (scenario.kind !== "refuses") return destination;
            if (scenario.failure === "resolution-threw") {
                throw new TypeError("Dispatch namespace binding failed");
            }
            if (scenario.failure === "absent-service") return malformedInput(null);
            if (scenario.failure === "invalid-fetcher") return malformedInput({});
            return destination;
        }
    };
}

/** The destination itself: authored by someone else, and the only thing that is reached. */
function destinationFor(
    scenario: DeploymentScenario,
    state: { reached: boolean }
): FetchServiceLike {
    return {
        fetch: (request): Response => {
            state.reached = true;
            if (scenario.kind === "escapes") throw DESTINATION_FAILURE;
            return new Response(request.url);
        }
    };
}

/**
 * The Worker Loader double. The isolate seam's own load taxonomy is not exercised here;
 * this exists so the release of a `dynamic` scope is observable, which is the one thing
 * the deployment protocol adds over that seam.
 */
class ContractWorkerLoader implements WorkerLoaderBindingLike<FetchServiceLike> {
    public readonly calls: DynamicWorkerLoadOptions[] = [];
    public released = 0;

    public constructor(private readonly destination: FetchServiceLike) {}

    public load(options: DynamicWorkerLoadOptions): DynamicWorkerHandleLike<FetchServiceLike> {
        this.calls.push(options);
        return {
            getEntrypoint: (): FetchServiceLike => this.destination,
            [Symbol.dispose]: (): void => {
                this.released += 1;
            }
        };
    }
}

/**
 * The declared protocol, implemented directly. Every refusal it raises is raised because
 * the condition holds, not because the scenario named a code, and its `fetch` releases the
 * scope in a `finally` for the same reason the adapter's does.
 */
class ReferenceDeploymentGateway implements DeploymentGateway {
    public constructor(
        private readonly namespace: DispatchNamespaceLike<FetchServiceLike>,
        private readonly destination: FetchServiceLike,
        private readonly state: { released: number }
    ) {}

    public resolve(deployment: CloudflareDeployment): ScopedFetchServiceLike {
        const service =
            deployment.mode === "dynamic"
                ? this.destination
                : this.lookup(deployment.scriptName, deployment.parameters);
        return {
            fetch: (request): Response | Promise<Response> => service.fetch(request),
            [Symbol.dispose]: (): void => {
                // A dynamic deployment owns an isolate and a dispatch deployment owns
                // nothing, which is the same asymmetry `DynamicFetchServiceScope` and
                // `DispatchFetchServiceScope` have.
                if (deployment.mode === "dynamic") this.state.released += 1;
            }
        };
    }

    public async fetch(deployment: CloudflareDeployment, request: Request): Promise<Response> {
        const service = this.resolve(deployment);
        try {
            return await service.fetch(request);
        } finally {
            service[Symbol.dispose]();
        }
    }

    private lookup(
        scriptName: string,
        parameters: Readonly<Record<string, string>> | undefined
    ): FetchServiceLike {
        if (scriptName.length === 0) {
            throw new AgentCoreError(
                DEPLOYMENT_TAXONOMY["empty-script-name"],
                "Dispatch script name must be non-empty"
            );
        }
        if (
            parameters !== undefined &&
            Object.entries(parameters).some(
                ([name, value]) => name.length === 0 || value.length === 0
            )
        ) {
            throw new AgentCoreError(
                DEPLOYMENT_TAXONOMY["empty-parameter-name"],
                "Dispatch parameters must have non-empty names and values"
            );
        }
        let service: FetchServiceLike | null | undefined;
        try {
            service = this.namespace.get(scriptName, parameters);
        } catch (cause) {
            const failure = new AgentCoreError(
                DEPLOYMENT_TAXONOMY["resolution-threw"],
                `Dispatch namespace resolution failed for ${scriptName}`
            );
            Object.defineProperty(failure, "cause", { value: cause });
            throw failure;
        }
        if (service === undefined || service === null) {
            throw new AgentCoreError(
                DEPLOYMENT_TAXONOMY["absent-service"],
                `Dispatch namespace returned no service for ${scriptName}`
            );
        }
        if (!(service instanceof Object) || !(service.fetch instanceof Function)) {
            throw new AgentCoreError(
                DEPLOYMENT_TAXONOMY["invalid-fetcher"],
                "Cloudflare deployment binding returned an invalid Fetcher"
            );
        }
        return service;
    }
}

const reference: DeploymentImplementation = {
    transport(scenario): DeploymentTransport {
        const state = { reached: false, released: 0 };
        const destination = destinationFor(scenario, state);
        return {
            gateway: new ReferenceDeploymentGateway(
                namespaceFor(scenario, destination),
                destination,
                state
            ),
            reached: (): boolean => state.reached,
            released: (): number => state.released
        };
    }
};

const adapter: DeploymentImplementation = {
    transport(scenario): DeploymentTransport {
        const state = { reached: false };
        // One destination, reached through whichever mode the call names: the loader in
        // `dynamic` mode and the namespace in `dispatch` mode.
        const destination = destinationFor(scenario, state);
        const loader = new ContractWorkerLoader(destination);
        return {
            gateway: gatewayOver(namespaceFor(scenario, destination), loader),
            reached: (): boolean => state.reached,
            released: (): number => loader.released
        };
    }
};

function gatewayOver(
    namespace: DispatchNamespaceLike<FetchServiceLike>,
    loader: ContractWorkerLoader
): ExplicitCloudflareDeploymentAdapter {
    return new ExplicitCloudflareDeploymentAdapter(
        new DynamicWorkerLoaderAdapter(loader, fakeWorkerLimits, fakeErrors),
        new DispatchNamespaceAdapter(namespace, fakeErrors),
        fakeErrors
    );
}

deploymentContract("reference", reference);
deploymentContract("ExplicitCloudflareDeploymentAdapter", adapter);

describe("Cloudflare deployment service protocol", () => {
    test("declares exactly the operations an implementation has to serve", { tags: "p2" }, () => {
        expect([...DEPLOYMENT_OPERATIONS]).toEqual(["resolve", "fetch"]);
        // Exact rather than subset in this direction: a verb added to the adapter without
        // being added to the vocabulary is a protocol the contract does not cover.
        // `requireService` is the adapter's own private shape check, not a protocol verb.
        expect(
            Object.getOwnPropertyNames(ExplicitCloudflareDeploymentAdapter.prototype)
                .filter((name) => name !== "constructor")
                .sort()
        ).toEqual(["fetch", "requireService", "resolve"]);
    });

    test("passes a dynamic deployment no capabilities at all", { tags: "p0" }, async () => {
        const state = { reached: false };
        const destination = destinationFor({ kind: "answers" }, state);
        const loader = new ContractWorkerLoader(destination);
        const gateway = gatewayOver(namespaceFor({ kind: "answers" }, destination), loader);

        const answer = await gateway.fetch(
            { mode: "dynamic", source: CONTRACT_SOURCE },
            new Request(CONTRACT_REQUEST_URL)
        );

        expect(await answer.text()).toBe(CONTRACT_REQUEST_URL);
        expect(loader.calls).toHaveLength(1);
        // A fetch surface is not a §4.7 submission, so it delegates nothing: the isolate
        // seam would happily carry a capability set here and the deployment protocol
        // passes `{}`. `globalOutbound: null` is the isolate seam's own claim, asserted
        // here only to show this path does not widen it.
        expect(Object.keys(loader.calls[0]!.env)).toEqual([]);
        expect(loader.calls[0]!.globalOutbound).toBeNull();
    });

    test(
        "constrains nothing about the response a destination returns",
        { tags: "p2" },
        async () => {
            // FINDING, not a fix: `ExplicitCloudflareDeploymentAdapter.fetch` returns
            // `await service.fetch(request)` with no check, so its declared `Promise<Response>`
            // is the type system's claim rather than the runtime's. A destination that answers
            // something else has that something else handed to the runtime.
            const destination: FetchServiceLike = {
                fetch: (): Response => malformedInput("plain")
            };
            const gateway = gatewayOver(
                { get: (): FetchServiceLike => destination },
                new ContractWorkerLoader(destination)
            );

            const answer = await gateway.fetch(
                {
                    mode: "dispatch",
                    scriptName: CONTRACT_SCRIPT_NAME,
                    parameters: CONTRACT_PARAMETERS
                },
                new Request(CONTRACT_REQUEST_URL)
            );

            expect(answer instanceof Response).toBe(false);
            expect(typeof answer).toBe("string");
        }
    );

    test("never releases a dispatch-mode Fetcher", { tags: "p2" }, async () => {
        // FINDING, not a fix: `FetchServiceLike extends DisposableCandidate`, so the type
        // admits a Fetcher that must be released, and `DispatchFetchServiceScope`'s
        // `[Symbol.dispose]` is empty. The dynamic scope releases its isolate; the dispatch
        // scope drops whatever it resolved.
        let released = 0;
        const destination: FetchServiceLike = {
            fetch: (request): Response => new Response(request.url),
            [Symbol.dispose]: (): void => {
                released += 1;
            }
        };
        const gateway = gatewayOver(
            { get: (): FetchServiceLike => destination },
            new ContractWorkerLoader(destination)
        );

        await gateway.fetch(
            { mode: "dispatch", scriptName: CONTRACT_SCRIPT_NAME },
            new Request(CONTRACT_REQUEST_URL)
        );

        expect(released).toBe(0);
    });

    test("names the site of each output refusal the one code covers", { tags: "p2" }, () => {
        // `operation.invalid-output` carries two mechanisms, so the code alone cannot say
        // which one fired. The messages can, and this is the evidence for those two rows of
        // the taxonomy: the absent-service check lives in `DispatchNamespaceAdapter.resolve`
        // and the shape check in the adapter's private `requireService`, over
        // `deployment.ts#isFetchService`.
        const deployment: CloudflareDeployment = {
            mode: "dispatch",
            scriptName: CONTRACT_SCRIPT_NAME
        };
        // A dispatch resolve never reaches the loader; the adapter takes one regardless.
        const unreached = new ContractWorkerLoader(malformedInput({}));

        const absent = refused(() =>
            gatewayOver({ get: (): FetchServiceLike => malformedInput(null) }, unreached).resolve(
                deployment
            )
        );
        expect(absent.code).toBe("operation.invalid-output");
        expect(absent.message).toBe(
            `Dispatch namespace returned no service for ${CONTRACT_SCRIPT_NAME}`
        );

        const invalid = refused(() =>
            gatewayOver({ get: (): FetchServiceLike => malformedInput({}) }, unreached).resolve(
                deployment
            )
        );
        expect(invalid.code).toBe("operation.invalid-output");
        expect(invalid.message).toBe("Cloudflare deployment binding returned an invalid Fetcher");
        expect(unreached.calls).toEqual([]);
    });
});

/** The refusal one act produces, as the failure it was raised as. */
function refused(act: () => void): AgentCoreError {
    try {
        act();
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw error;
    }
    throw new TypeError("Expected the deployment seam to refuse");
}

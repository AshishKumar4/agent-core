import { describe, expect, test } from "vitest";
import { AgentCoreError } from "@agent-core/core";
import type {
    CloudflareDeployment,
    DynamicWorkerSource,
    ScopedFetchServiceLike
} from "../src/index.js";

/**
 * The `dispatch.deployment` service contract.
 *
 * The runtime's seam onto a deployment is Workers for Platforms: the destination is code
 * the Tenant did not author — a Slate preview or a published version — reached either
 * through a dispatch namespace (`dispatch.ts#DispatchNamespaceAdapter`) or through the
 * Worker Loader (`loader.ts#DynamicWorkerLoaderAdapter`), and
 * `deployment.ts#ExplicitCloudflareDeploymentAdapter` is the one place that chooses
 * between them. Every byte that crosses back is authored by someone else, which is what
 * makes this a SPEC §14 trust boundary rather than an internal call.
 *
 * The Worker Loader half is NOT re-modelled here. It is already the `isolate` substrate
 * seam in `packages/agent-core/artifacts/substrate-contracts.json`, and this contract
 * only observes the two things the deployment protocol adds on top of it: that a
 * `dynamic` deployment is passed no capabilities, and that the scope it hands back is
 * released. Its load taxonomy (`loader.ts#DynamicWorkerLoaderAdapter.load`) belongs to
 * that seam and every refusal case below therefore runs in `dispatch` mode.
 *
 * The adapters throw; the contract answers values. `deploymentReply` below is the whole
 * correspondence and it is total: every throw the protocol declares becomes exactly one
 * reply value, and anything undeclared becomes `escaped` or `indeterminate` rather than
 * being dressed up as a refusal the service never gave.
 */

/**
 * The closed operation vocabulary. Two, because the seam offers two: a lookup that
 * resolves a destination, and a call through the destination it resolved.
 */
export const DEPLOYMENT_OPERATIONS = Object.freeze(["resolve", "fetch"] as const);

export type DeploymentOperation = (typeof DEPLOYMENT_OPERATIONS)[number];

/**
 * The closed refusal vocabulary: the seam was reached and its answer is a failure. Every
 * code is a `CloudflareOperationalErrorCode`, which is the shared `AgentCoreErrorCode`
 * taxonomy narrowed to what a Cloudflare substrate can answer (`error.ts`).
 */
export const DEPLOYMENT_REFUSALS = Object.freeze([
    "operation.invalid-input",
    "operation.invalid-output",
    "protocol.invalid-state"
] as const);

export type DeploymentRefusalCode = (typeof DEPLOYMENT_REFUSALS)[number];

/**
 * The closed failure vocabulary: one member per distinct way the protocol refuses. Three
 * codes carry five mechanisms, so the mechanisms are named separately and
 * `DEPLOYMENT_TAXONOMY` is the mapping. Without this the totality case could only claim
 * that three codes are reachable, not that every declared way of failing reaches one.
 */
export const DEPLOYMENT_FAILURES = Object.freeze([
    "empty-script-name",
    "empty-parameter-name",
    "resolution-threw",
    "absent-service",
    "invalid-fetcher"
] as const);

export type DeploymentFailure = (typeof DEPLOYMENT_FAILURES)[number];

/**
 * Failure to stable code. Mechanisms, in order:
 * `dispatch.ts#DispatchNamespaceAdapter.resolve` refuses an empty script name and an
 * empty parameter name or value as `operation.invalid-input`, a throw out of
 * `DispatchNamespaceLike.get` as `protocol.invalid-state`, and a null or undefined
 * service as `operation.invalid-output`;
 * `deployment.ts#ExplicitCloudflareDeploymentAdapter` (its private `requireService`, over
 * `deployment.ts#isFetchService`) refuses a Fetcher of invalid shape as
 * `operation.invalid-output`.
 */
export const DEPLOYMENT_TAXONOMY: Readonly<Record<DeploymentFailure, DeploymentRefusalCode>> =
    Object.freeze({
        "empty-script-name": "operation.invalid-input",
        "empty-parameter-name": "operation.invalid-input",
        "resolution-threw": "protocol.invalid-state",
        "absent-service": "operation.invalid-output",
        "invalid-fetcher": "operation.invalid-output"
    });

/**
 * The closed reply vocabulary. Five kinds, and the last three are the ones that keep this
 * honest.
 *
 * `resolved` and `answered` are separate because the two operations answer different
 * things and only one of them crosses the boundary: a lookup that could answer a Response
 * would not be a lookup.
 *
 * `escaped` is a destination that was reached and still threw. The deployment protocol
 * declares no refusal for that, so the value travels whole. Calling it `refused` would
 * attribute someone else's crash to the runtime's own dispatch protocol, and calling it
 * `indeterminate` would discard the one thing the runtime does know — that the failure
 * arrived from across the boundary.
 *
 * `indeterminate` is an undeclared throw at the runtime's own seam: the runtime does not
 * know what happened, which is a different claim from "the service refused".
 */
export type DeploymentReply =
    | { readonly kind: "resolved"; readonly service: ScopedFetchServiceLike }
    | { readonly kind: "answered"; readonly response: Response }
    | { readonly kind: "refused"; readonly code: DeploymentRefusalCode }
    | { readonly kind: "escaped"; readonly cause: unknown }
    | { readonly kind: "indeterminate"; readonly cause: unknown };

/**
 * Membership over a closed literal set, so a code the union does not carry cannot be
 * classified. A record rather than a Set because the table is static and string-keyed;
 * `provider-capability.ts#DISCLOSED_CODES` states its disclosed set the same way.
 */
const REFUSAL_CODES: Readonly<Record<string, DeploymentRefusalCode | undefined>> = Object.freeze(
    Object.fromEntries(DEPLOYMENT_REFUSALS.map((code) => [code, code]))
);

/** One invocation of the seam, discriminated by the operation it names. */
export type DeploymentCall =
    | { readonly operation: "resolve"; readonly deployment: CloudflareDeployment }
    | {
          readonly operation: "fetch";
          readonly deployment: CloudflareDeployment;
          readonly request: Request;
      };

/**
 * The seam as the contract reaches it. `ExplicitCloudflareDeploymentAdapter` satisfies it
 * structurally, so the real adapter is driven with no wrapper of its own.
 */
export interface DeploymentGateway {
    resolve(deployment: CloudflareDeployment): ScopedFetchServiceLike;
    fetch(deployment: CloudflareDeployment, request: Request): Promise<Response>;
}

/**
 * One implementation of the protocol plus the two facts about it that are not in any
 * reply: whether the destination's own code ran, and how many times the resource behind
 * the resolved scope was released.
 */
export interface DeploymentTransport {
    readonly gateway: DeploymentGateway;
    /** Whether the destination's own `fetch` ran — the trust-boundary crossing, observed. */
    reached(): boolean;
    /** How many times the resource behind the resolved scope was released. */
    released(): number;
}

/**
 * One call, one reply value. This is the whole correspondence between what the adapters
 * throw and what the contract says the service answered, and it is the only place in
 * these files that inspects a thrown value.
 *
 * Reach is consulted before the code, deliberately. Once the destination has run, the
 * runtime cannot tell its throw apart from its own — `ExplicitCloudflareDeploymentAdapter`
 * awaits `service.fetch(request)` with no classification at all — so a throw from that
 * point on is reported as having crossed the boundary rather than as a refusal the
 * runtime's dispatch protocol issued. That ordering is what makes the missing
 * classification visible instead of laundering an `AgentCoreError` thrown by
 * third-party code into a refusal.
 */
export async function deploymentReply(
    transport: DeploymentTransport,
    call: DeploymentCall
): Promise<DeploymentReply> {
    try {
        if (call.operation === "resolve") {
            return { kind: "resolved", service: transport.gateway.resolve(call.deployment) };
        }
        return {
            kind: "answered",
            response: await transport.gateway.fetch(call.deployment, call.request)
        };
    } catch (cause) {
        if (transport.reached()) return { kind: "escaped", cause };
        const refused = cause instanceof AgentCoreError ? REFUSAL_CODES[cause.code] : undefined;
        // Classification, not a membership test followed by an assertion repeating it: the
        // table answers the vocabulary member itself, so nothing has to be asserted.
        if (refused !== undefined) return { kind: "refused", code: refused };
        return { kind: "indeterminate", cause };
    }
}

/**
 * What an implementation must be able to be put into. One member per reply the vocabulary
 * declares, so a suite that iterates the taxonomy cannot skip a case; `answers` covers
 * both success kinds because which one is possible is chosen by the operation rather than
 * by the transport.
 */
export type DeploymentScenario =
    | { readonly kind: "answers" }
    | { readonly kind: "refuses"; readonly failure: DeploymentFailure }
    | { readonly kind: "escapes" }
    | { readonly kind: "faults" };

/** One implementation of the deployment protocol, built for one scenario. */
export interface DeploymentImplementation {
    transport(scenario: DeploymentScenario): DeploymentTransport;
}

/** The published version every dispatch deployment in this contract names. */
export const CONTRACT_SCRIPT_NAME = "slate-preview-v1";

/** The dispatch parameters a sound call carries, so an unsound one is nameable. */
export const CONTRACT_PARAMETERS: Readonly<Record<string, string>> = Object.freeze({
    tenant: "tenant-1"
});

/** The request every `fetch` in this contract carries; the destination echoes its URL. */
export const CONTRACT_REQUEST_URL = "https://deployment.invalid/view";

/**
 * The module set a `dynamic` deployment loads. Shaped to pass
 * `loader.ts#validateSource`, since a source the loader rejects would answer the isolate
 * seam's contract rather than this one.
 */
export const CONTRACT_SOURCE: DynamicWorkerSource = Object.freeze({
    compatibilityDate: "2026-07-10",
    mainModule: "index.js",
    modules: Object.freeze({ "index.js": "export default { fetch: () => new Response('ok') };" })
});

/**
 * What the destination throws once it has been reached. Not an Error: code the Tenant did
 * not author can throw any value at all, and the contract's claim is that whatever it
 * throws arrives whole rather than normalized, renamed, or replaced by a code.
 */
export const DESTINATION_FAILURE: unknown = Object.freeze({ destination: "unavailable" });

/**
 * The call a scenario is exercised with. Two of the five failures are properties of the
 * request rather than of the transport, so the scenario has to reach the deployment
 * record as well as the implementation.
 */
function deploymentFor(
    scenario: DeploymentScenario,
    mode: CloudflareDeployment["mode"]
): CloudflareDeployment {
    if (mode === "dynamic") return { mode, source: CONTRACT_SOURCE };
    if (scenario.kind === "refuses" && scenario.failure === "empty-script-name") {
        return { mode, scriptName: "" };
    }
    if (scenario.kind === "refuses" && scenario.failure === "empty-parameter-name") {
        return { mode, scriptName: CONTRACT_SCRIPT_NAME, parameters: { "": "tenant-1" } };
    }
    return { mode, scriptName: CONTRACT_SCRIPT_NAME, parameters: CONTRACT_PARAMETERS };
}

export function deploymentContract(name: string, implementation: DeploymentImplementation): void {
    describe(`${name} Cloudflare deployment service contract`, () => {
        test(
            "resolves a dispatch deployment as a lookup that reaches no destination",
            { tags: "p1" },
            async () => {
                const scenario: DeploymentScenario = { kind: "answers" };
                const transport = implementation.transport(scenario);
                const reply = await deploymentReply(transport, {
                    operation: "resolve",
                    deployment: deploymentFor(scenario, "dispatch")
                });

                expect(reply.kind).toBe("resolved");
                if (reply.kind !== "resolved") return;
                expect(typeof reply.service.fetch).toBe("function");
                // The claim `resolve` exists to make: a lookup carries no request, so
                // nothing crosses the boundary until `fetch` is called.
                expect(transport.reached()).toBe(false);
                reply.service[Symbol.dispose]();
            }
        );

        test(
            "answers a fetch with the destination's own response and releases the resolved scope",
            { tags: "p1" },
            async () => {
                const scenario: DeploymentScenario = { kind: "answers" };
                const transport = implementation.transport(scenario);
                const reply = await deploymentReply(transport, {
                    operation: "fetch",
                    deployment: deploymentFor(scenario, "dynamic"),
                    request: new Request(CONTRACT_REQUEST_URL)
                });

                expect(reply.kind).toBe("answered");
                if (reply.kind !== "answered") return;
                expect(await reply.response.text()).toBe(CONTRACT_REQUEST_URL);
                expect(transport.reached()).toBe(true);
                expect(transport.released()).toBe(1);
            }
        );

        test(
            "refuses every failure the taxonomy declares, and declares every refusal it answers",
            { tags: "p0" },
            async () => {
                const produced: Record<string, true> = {};
                for (const failure of DEPLOYMENT_FAILURES) {
                    const scenario: DeploymentScenario = { kind: "refuses", failure };
                    const deployment = deploymentFor(scenario, "dispatch");
                    for (const operation of DEPLOYMENT_OPERATIONS) {
                        const transport = implementation.transport(scenario);
                        const reply = await deploymentReply(
                            transport,
                            operation === "resolve"
                                ? { operation, deployment }
                                : {
                                      operation,
                                      deployment,
                                      request: new Request(CONTRACT_REQUEST_URL)
                                  }
                        );

                        expect(reply).toEqual({
                            kind: "refused",
                            code: DEPLOYMENT_TAXONOMY[failure]
                        });
                        // Every declared refusal is decided before anything crosses the
                        // trust boundary, `fetch` included.
                        expect(transport.reached()).toBe(false);
                        if (reply.kind === "refused") produced[reply.code] = true;
                    }
                }

                // Both directions: the vocabulary has no code this implementation cannot
                // produce, and this implementation produced no code outside it.
                expect(Object.keys(produced).sort()).toEqual([...DEPLOYMENT_REFUSALS].sort());
                expect(Object.keys(produced).every((code) => REFUSAL_CODES[code] === code)).toBe(
                    true
                );
            }
        );

        test(
            "releases the resolved scope exactly once when the destination fails",
            { tags: "p1" },
            async () => {
                const scenario: DeploymentScenario = { kind: "escapes" };
                const transport = implementation.transport(scenario);
                const reply = await deploymentReply(transport, {
                    operation: "fetch",
                    deployment: deploymentFor(scenario, "dynamic"),
                    request: new Request(CONTRACT_REQUEST_URL)
                });

                expect(reply.kind).toBe("escaped");
                // The `finally` in `ExplicitCloudflareDeploymentAdapter.fetch` runs on the
                // failing path too, and runs once: a destination that crashes must not
                // leak the isolate it crashed in.
                expect(transport.released()).toBe(1);
            }
        );

        test(
            "carries a destination failure out unclassified rather than as a refusal",
            { tags: "p1" },
            async () => {
                const scenario: DeploymentScenario = { kind: "escapes" };
                const transport = implementation.transport(scenario);
                const reply = await deploymentReply(transport, {
                    operation: "fetch",
                    deployment: deploymentFor(scenario, "dispatch"),
                    request: new Request(CONTRACT_REQUEST_URL)
                });

                expect(reply.kind).toBe("escaped");
                if (reply.kind !== "escaped") return;
                // The value the destination threw travels whole. A refusal code invented
                // here would be the runtime claiming to know an answer nobody gave it.
                expect(reply.cause).toBe(DESTINATION_FAILURE);
                expect(reply.cause instanceof AgentCoreError).toBe(false);
                expect(transport.reached()).toBe(true);
            }
        );

        test(
            "answers an undeclared resolution failure as indeterminate rather than as a refusal",
            { tags: "p1" },
            async () => {
                const scenario: DeploymentScenario = { kind: "faults" };
                const transport = implementation.transport(scenario);
                const reply = await deploymentReply(transport, {
                    operation: "fetch",
                    deployment: deploymentFor(scenario, "dispatch"),
                    request: new Request(CONTRACT_REQUEST_URL)
                });

                expect(reply.kind).toBe("indeterminate");
                if (reply.kind !== "indeterminate") return;
                expect(reply.cause).toBeDefined();
                expect(reply.cause instanceof AgentCoreError).toBe(false);
                // Undeclared at the seam, not across it: the shape check that failed runs
                // before the destination is ever called.
                expect(transport.reached()).toBe(false);
            }
        );

        test(
            "refuses an empty parameter value the way it refuses an empty parameter name",
            { tags: "p2" },
            async () => {
                const scenario: DeploymentScenario = { kind: "answers" };
                const deployment: CloudflareDeployment = {
                    mode: "dispatch",
                    scriptName: CONTRACT_SCRIPT_NAME,
                    parameters: { tenant: "" }
                };
                const reply = await deploymentReply(implementation.transport(scenario), {
                    operation: "resolve",
                    deployment
                });

                expect(reply).toEqual({
                    kind: "refused",
                    code: DEPLOYMENT_TAXONOMY["empty-parameter-name"]
                });
            }
        );
    });
}

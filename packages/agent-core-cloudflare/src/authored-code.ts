import { AuthoredCodeBackingId, isFacetData, type FacetData } from "@agent-core/core/facets";
import { AuthoredCodeBacking, type AuthoredCodeRunRequest } from "@agent-core/core/operations";
import type { DispatchNamespaceAdapter } from "./dispatch.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { DynamicWorkerLoaderAdapter } from "./loader.js";
import {
    passedCapabilities,
    type PassedCapabilities,
    type PassedCapabilityFactory
} from "./passed-capability.js";

/** The two backings SPEC §10.2 names for this profile. */
export const WORKER_LOADER_BACKING = new AuthoredCodeBackingId("workerLoader");
export const DISPATCH_NAMESPACE_BACKING = new AuthoredCodeBackingId("dispatchNamespace");

/**
 * The one call a §4.7 isolate ever receives. The delegated capability set arrives here
 * and never as an ambient binding: a Worker Loader `env` is structured-cloned and cannot
 * carry a live capability at all, and a dispatch namespace's `env` belongs to its own
 * deployment. So the isolate starts holding nothing, and this argument is the whole of
 * what it is handed.
 */
export interface AuthoredCodeCallLike {
    readonly capabilities: PassedCapabilities;
    readonly input: FacetData;
}

/** What agent-authored code exports, identically under either backing. */
export interface AuthoredCodeEntrypointLike {
    run(call: AuthoredCodeCallLike): unknown;
}

/**
 * Worker Loader as a §4.7 backing: a fresh isolate per submission, `globalOutbound:
 * null` so it has no network reach of its own, and an empty `env` so it starts holding
 * nothing at all.
 */
export class WorkerLoaderAuthoredCodeBacking extends AuthoredCodeBacking {
    public readonly id = WORKER_LOADER_BACKING;

    public constructor(
        private readonly loader: DynamicWorkerLoaderAdapter,
        private readonly compatibilityDate: string,
        private readonly capabilities: PassedCapabilityFactory,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
    }

    public async run(request: AuthoredCodeRunRequest): Promise<FacetData> {
        const scope = this.loader.load(
            {
                compatibilityDate: this.compatibilityDate,
                mainModule: request.entry,
                modules: Object.fromEntries(request.code)
            },
            (entrypoint) => requireEntrypoint(entrypoint, this.errors)
        );
        try {
            const returned = await scope.entrypoint.run(
                authoredCodeCall(request, this.capabilities)
            );
            if (!isFacetData(returned)) notData(this.errors);
            return returned;
        } finally {
            scope[Symbol.dispose]();
        }
    }
}

/**
 * How a submission names the pre-deployed script that carries its code. A dispatch
 * namespace serves code deployed before the call (§10.2), so the platform states the
 * naming rule its own deploy step established; this adapter has none to invent.
 */
export type DispatchScriptNaming = (request: AuthoredCodeRunRequest) => string;

/**
 * Workers for Platforms as a §4.7 backing, for the consumers whose code is deployed
 * ahead of the call.
 *
 * It discharges one half of what every `dynamic` backing owes: the entry point receives
 * exactly the delegated capability set and no other channel is opened to it. It does not
 * discharge the other half. Zero ambient egress for a pre-deployed script is a property
 * of that deployment and of the namespace binding's own `outbound` configuration —
 * neither visible nor settable here at call time — so this adapter can neither establish
 * it nor check it, and the platform states it where it deploys. §4.7 requires each
 * backing to demonstrate the invariant independently, "never by comparison against
 * another backing", so Worker Loader's `globalOutbound: null` does not cover this one.
 * That gap is what keeps C13-PLACEMENT-AUTHORED-BACKING behind
 * C13-PLACEMENT-DYNAMIC-NO-EGRESS.
 */
export class DispatchNamespaceAuthoredCodeBacking extends AuthoredCodeBacking {
    public readonly id = DISPATCH_NAMESPACE_BACKING;

    public constructor(
        private readonly namespace: DispatchNamespaceAdapter<unknown>,
        private readonly naming: DispatchScriptNaming,
        private readonly capabilities: PassedCapabilityFactory,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
    }

    public async run(request: AuthoredCodeRunRequest): Promise<FacetData> {
        const entrypoint = requireEntrypoint(
            this.namespace.resolve(this.naming(request)),
            this.errors
        );
        const returned = await entrypoint.run(authoredCodeCall(request, this.capabilities));
        if (!isFacetData(returned)) notData(this.errors);
        return returned;
    }
}

function authoredCodeCall(
    request: AuthoredCodeRunRequest,
    capabilities: PassedCapabilityFactory
): AuthoredCodeCallLike {
    return {
        capabilities: passedCapabilities(request.capabilities, request.invocations, capabilities),
        input: request.input
    };
}

function requireEntrypoint(
    value: unknown,
    errors: CloudflareErrorPort
): AuthoredCodeEntrypointLike {
    if (!isEntrypoint(value)) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Agent-authored code exposes no callable entry point"
        );
    }
    return value;
}

function isEntrypoint(value: unknown): value is AuthoredCodeEntrypointLike {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? typeof Reflect.get(value, "run") === "function"
        : false;
}

function notData(errors: CloudflareErrorPort): never {
    operationalFailure(
        errors,
        "operation.invalid-output",
        "Agent-authored code returned a value that is not data"
    );
}

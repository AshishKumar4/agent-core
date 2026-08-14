import { AuthoredCodeBackingId, isFacetData, type FacetData } from "@agent-core/core/facets";
import { AuthoredCodeBacking, type AuthoredCodeRunRequest } from "@agent-core/core/operations";
import type { DispatchNamespaceAdapter } from "./dispatch.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { DisposableCandidate, DynamicWorkerLoaderAdapter } from "./loader.js";
import {
    passedCapabilities,
    type PassedCapabilities,
    type PassedCapabilityFactory,
    type PassedCapabilityRegistry
} from "./passed-capability.js";
import { isPlatformMethod, isPlatformObject } from "./platform-value.js";

/** The two backings SPEC §10.2 names for this profile. */
export const WORKER_LOADER_BACKING = new AuthoredCodeBackingId("workerLoader");
export const DISPATCH_NAMESPACE_BACKING = new AuthoredCodeBackingId("dispatchNamespace");

/**
 * What code loaded by Worker Loader exports. Its capabilities are its `env` — one entry
 * per passed Binding, addressed as `env.<name>.invoke(...)` — which is the binding
 * channel every user of this platform expects and the one the reference implementation
 * of this pattern uses.
 */
export interface AuthoredCodeEntrypointLike extends DisposableCandidate {
    run(input: FacetData): FacetData | Promise<FacetData>;
}

interface AuthoredCodeEntrypointCandidate extends DisposableCandidate {
    run?(input: FacetData): FacetData | Promise<FacetData>;
}

/**
 * What pre-deployed code in a dispatch namespace exports. Its `env` is fixed by its own
 * deployment and cannot carry a per-submission capability set, so the delegated set
 * arrives as the call's first argument instead. The stub in it is the same one the
 * loaded-code path puts in `env`; only the channel differs, because the mechanism
 * leaves no choice.
 */
export interface DispatchedAuthoredCodeEntrypointLike extends DisposableCandidate {
    run(capabilities: PassedCapabilities, input: FacetData): FacetData | Promise<FacetData>;
}

/**
 * Worker Loader as a §4.7 backing: a fresh isolate per submission, `globalOutbound:
 * null` so it has no network reach of its own, `disallow_importable_env` so the loaded
 * code cannot reach its own worker's exports and call back around the membrane, and an
 * `env` holding the delegated capability set and nothing else.
 */
export class WorkerLoaderAuthoredCodeBacking extends AuthoredCodeBacking {
    public readonly id = WORKER_LOADER_BACKING;

    public constructor(
        private readonly loader: DynamicWorkerLoaderAdapter<AuthoredCodeEntrypointCandidate>,
        private readonly compatibilityDate: string,
        private readonly registry: PassedCapabilityRegistry,
        private readonly capabilities: PassedCapabilityFactory,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
    }

    public async run(request: AuthoredCodeRunRequest): Promise<FacetData> {
        using registered = this.registry.open(request.isolate, request.invocations);
        void registered;
        const scope = this.loader.load(
            {
                compatibilityDate: this.compatibilityDate,
                compatibilityFlags: ISOLATE_COMPATIBILITY_FLAGS,
                mainModule: request.entry,
                modules: Object.fromEntries(request.code)
            },
            passedCapabilities(request.capabilities, request.isolate, this.capabilities),
            (entrypoint) => requireAuthoredEntrypoint(entrypoint, this.errors)
        );
        try {
            const entrypoint: AuthoredCodeEntrypointLike = scope.entrypoint;
            const returned = await entrypoint.run(request.input);
            if (!isFacetData(returned)) notData(this.errors);
            return returned;
        } finally {
            scope[Symbol.dispose]();
        }
    }
}

// `disallow_importable_env` also disallows importable `ctx.exports`, which is what stops
// loaded code from reaching its own worker's entry points and calling around the one
// channel it was given.
const ISOLATE_COMPATIBILITY_FLAGS: readonly string[] = Object.freeze(["disallow_importable_env"]);

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
        private readonly namespace: DispatchNamespaceAdapter<DispatchedAuthoredCodeEntrypointLike>,
        private readonly naming: DispatchScriptNaming,
        private readonly registry: PassedCapabilityRegistry,
        private readonly capabilities: PassedCapabilityFactory,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
    }

    public async run(request: AuthoredCodeRunRequest): Promise<FacetData> {
        using registered = this.registry.open(request.isolate, request.invocations);
        void registered;
        const entrypoint = requireDispatchedEntrypoint(
            this.namespace.resolve(this.naming(request)),
            this.errors
        );
        const returned = await entrypoint.run(
            passedCapabilities(request.capabilities, request.isolate, this.capabilities),
            request.input
        );
        if (!isFacetData(returned)) notData(this.errors);
        return returned;
    }
}

function requireAuthoredEntrypoint(
    value: AuthoredCodeEntrypointCandidate,
    errors: CloudflareErrorPort
): AuthoredCodeEntrypointLike {
    if (!isAuthoredEntrypoint(value)) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Agent-authored code exposes no callable entry point"
        );
    }
    return value;
}

function requireDispatchedEntrypoint(
    value: DispatchedAuthoredCodeEntrypointLike,
    errors: CloudflareErrorPort
): DispatchedAuthoredCodeEntrypointLike {
    if (!isDispatchedEntrypoint(value)) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Agent-authored code exposes no callable entry point"
        );
    }
    return value;
}

function isAuthoredEntrypoint(
    value: AuthoredCodeEntrypointCandidate
): value is AuthoredCodeEntrypointLike {
    return isPlatformObject(value) && isPlatformMethod(value.run);
}

function isDispatchedEntrypoint(
    value: DispatchedAuthoredCodeEntrypointLike
): value is DispatchedAuthoredCodeEntrypointLike {
    return isPlatformObject(value) && isPlatformMethod(value.run);
}

function notData(errors: CloudflareErrorPort): never {
    operationalFailure(
        errors,
        "operation.invalid-output",
        "Agent-authored code returned a value that is not data"
    );
}

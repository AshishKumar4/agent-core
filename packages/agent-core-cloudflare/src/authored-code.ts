import { AuthoredCodeBackingId, isFacetData, type FacetData } from "@agent-core/core/facets";
import { AuthoredCodeBacking, type AuthoredCodeRunRequest } from "@agent-core/core/operations";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { DisposableCandidate, DynamicWorkerLoaderAdapter } from "./loader.js";
import {
    passedCapabilities,
    type PassedCapabilityFactory,
    type PassedCapabilityRegistry
} from "./passed-capability.js";
import { isPlatformMethod, isPlatformObject } from "./platform-value.js";

/** The Worker Loader backing implemented by this profile. */
export const WORKER_LOADER_BACKING = new AuthoredCodeBackingId("workerLoader");

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

function isAuthoredEntrypoint(
    value: AuthoredCodeEntrypointCandidate
): value is AuthoredCodeEntrypointLike {
    return isPlatformObject(value) && isPlatformMethod(value.run);
}

function notData(errors: CloudflareErrorPort): never {
    operationalFailure(
        errors,
        "operation.invalid-output",
        "Agent-authored code returned a value that is not data"
    );
}

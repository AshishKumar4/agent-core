import { BindingName, OperationName, type FacetData } from "@agent-core/core/facets";
import type {
    AuthoredCodeCapabilitySet,
    AuthoredCodeInvocationPort
} from "@agent-core/core/operations";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";

/**
 * One passed Binding as a §4.7 isolate addresses it: `env.<name>.invoke(...)`. This is
 * the whole of what such an isolate holds, and every call it carries re-enters the
 * Invocation pipeline under the isolate's own delegated authority.
 */
export interface PassedCapabilityLike {
    invoke(operation: string, input: FacetData): Promise<FacetData>;
}

/** The `env` of a §4.7 isolate: one entry per passed Binding and nothing else. */
export type PassedCapabilities = Readonly<Record<string, PassedCapabilityLike>>;

/**
 * The routing identity a passed capability carries, and the only thing it carries.
 *
 * A Worker Loader `env` is serialized, so a capability placed in one cannot close over a
 * live host object — that is what makes an ad-hoc RpcTarget fail with `DataCloneError`.
 * What the serializer does accept is a WorkerEntrypoint stub built with props, so the
 * props hold data alone and the live capability is resolved host-side on every call.
 * Re-resolving per call is also what §3.4 rules 7–8 ask of any stub that outlives a
 * step, so the platform's shape and the SPEC's agree here.
 */
export interface PassedCapabilityProps {
    readonly isolate: string;
    readonly binding: string;
}

/**
 * Builds the stub that carries one passed Binding. On Workers the host writes
 * `(props) => ctx.exports.<Entrypoint>({ props })`, exactly as it already supplies the
 * Durable Object base class — so this package still imports nothing from the Workers
 * runtime, and the stub is one the loader's `env` serializer accepts.
 */
export type PassedCapabilityFactory = (props: PassedCapabilityProps) => PassedCapabilityLike;

/**
 * The delegated capability set as an isolate's `env`. It is a plain object because the
 * loader's serializer rejects anything else — including a null-prototype one — so what
 * keeps a name from colliding with an `Object.prototype` member is the Binding name's
 * own canonical-identifier validation, not the container's shape.
 */
export function passedCapabilities(
    capabilities: AuthoredCodeCapabilitySet,
    isolate: string,
    create: PassedCapabilityFactory
): PassedCapabilities {
    const environment: Record<string, PassedCapabilityLike> = {};
    for (const name of capabilities.names) {
        environment[name.value] = create({ isolate, binding: name.value });
    }
    return Object.freeze(environment);
}

/**
 * The live Invocation ports the capability entrypoint resolves against, keyed by the
 * isolate each belongs to. A backing opens one entry for the length of a submission and
 * closes it when the submission ends, so a stub whose isolate is gone resolves to
 * nothing rather than to another submission's authority.
 */
export class PassedCapabilityRegistry {
    readonly #ports = new Map<string, AuthoredCodeInvocationPort>();

    public constructor(private readonly errors: CloudflareErrorPort) {}

    public open(isolate: string, port: AuthoredCodeInvocationPort): Disposable {
        if (this.#ports.has(isolate)) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                `Agent-authored code isolate ${isolate} is already running`
            );
        }
        this.#ports.set(isolate, port);
        return {
            [Symbol.dispose]: () => {
                this.#ports.delete(isolate);
            }
        };
    }

    /**
     * Carries one call from a capability stub to its isolate's own Invocation port. The
     * Binding name comes from the stub's props, which the host set when it built the
     * stub — loaded code chooses the operation and the input, never which Binding it is
     * speaking through.
     */
    public async invoke(
        props: PassedCapabilityProps,
        operation: string,
        input: FacetData
    ): Promise<FacetData> {
        const port = this.#ports.get(props.isolate);
        if (port === undefined) {
            operationalFailure(
                this.errors,
                "authority.denied",
                "Agent-authored code capability outlived its submission"
            );
        }
        return port.invoke({
            binding: new BindingName(props.binding),
            operation: new OperationName(operation),
            input
        });
    }
}

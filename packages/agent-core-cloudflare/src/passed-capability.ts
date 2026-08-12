import { BindingName, OperationName, type FacetData } from "@agent-core/core/facets";
import type {
    AuthoredCodeCapabilitySet,
    AuthoredCodeInvocationPort
} from "@agent-core/core/operations";

/**
 * One passed Binding as a §4.7 isolate addresses it, and the only kind of thing such an
 * isolate ever holds. Every call it carries re-enters the Invocation pipeline under the
 * isolate's own delegated authority.
 */
export interface PassedCapabilityLike {
    invoke(operation: string, input: FacetData): Promise<FacetData>;
}

export type PassedCapabilities = Readonly<Record<string, PassedCapabilityLike>>;

export type PassedCapabilityFactory = (
    binding: BindingName,
    invocations: AuthoredCodeInvocationPort
) => PassedCapabilityLike;

/**
 * The runtime base class a capability must extend to survive the isolate boundary. On
 * Workers that is `RpcTarget`: a plain object with methods is neither cloneable nor
 * callable across the boundary, so a capability that did not extend it would simply
 * fail to be passed. The host supplies the class, as it does for Durable Objects, so
 * this package keeps importing nothing from the Workers runtime.
 */
export type IsolateBoundaryTargetClass = abstract new () => object;

/**
 * Builds passed capabilities over the host's isolate-boundary base class. Every
 * capability this produces is backed by a delegated Binding, because the only way to
 * get one is to name a Binding the delegation actually passed.
 */
export function createPassedCapabilityFactory(
    base: IsolateBoundaryTargetClass
): PassedCapabilityFactory {
    class BoundaryPassedCapability extends base implements PassedCapabilityLike {
        public constructor(
            private readonly binding: BindingName,
            private readonly invocations: AuthoredCodeInvocationPort
        ) {
            super();
        }

        public async invoke(operation: string, input: FacetData): Promise<FacetData> {
            return this.invocations.invoke({
                binding: this.binding,
                operation: new OperationName(operation),
                input
            });
        }
    }
    return (binding, invocations) => new BoundaryPassedCapability(binding, invocations);
}

/**
 * The delegated capability set, rendered as the objects an isolate calls. Building it is
 * the adapter's job and never a caller's: a caller free to supply entries could put a
 * capability into an isolate that no delegated Binding backs, which is exactly the
 * defect this indirection makes unexpressible.
 */
export function passedCapabilities(
    capabilities: AuthoredCodeCapabilitySet,
    invocations: AuthoredCodeInvocationPort,
    create: PassedCapabilityFactory
): PassedCapabilities {
    return Object.freeze(
        Object.fromEntries(
            capabilities.names.map((name) => [name.value, create(name, invocations)])
        )
    );
}

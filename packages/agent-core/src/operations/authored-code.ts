import type { ContentStore } from "../content";
import { AgentCoreError } from "../errors";
import {
    AuthoredCodeSource,
    BindingName,
    canonicalFacetData,
    CapabilitySpec,
    FacetPackageId,
    FacetRef,
    Operation,
    OperationDescriptor,
    requireAuthoredCodeConsumer,
    requireDataObject,
    requireString,
    schema,
    strictObjectSchema,
    type AuthoredCodeBackingId,
    type AuthoredCodeConsumer,
    type FacetData,
    type OperationContext,
    type OperationName
} from "../facets";
import { OperationRequestKey } from "./gateway";
import type { OperationGateway } from "./gateway";

/**
 * One capability explicitly passed into an isolate: the name the loaded code addresses
 * it by, and the exact Facet that name must resolve to. The Package is derived from the
 * Facet reference rather than stated separately, so a passed capability cannot claim one
 * Package and resolve to another.
 */
export class AuthoredCodeCapability {
    public readonly package: FacetPackageId;

    public constructor(
        public readonly name: BindingName,
        public readonly facet: FacetRef,
        /**
         * What the isolate may do with it. Omitted means "equal to what the delegator
         * holds" — the widest §3.4 admits — and any stated narrowing is enforced by the
         * ordinary attenuation rules, never by this record.
         */
        public readonly capability?: CapabilitySpec
    ) {
        this.package = new FacetPackageId(facet.value.slice(0, facet.value.indexOf(":")));
        Object.freeze(this);
    }
}

/**
 * The complete capability set one isolate was passed (SPEC §4.7). It is the whole of
 * what the isolate can reach: a name absent from this set has no channel, because the
 * isolate holds no ambient authority and the only outward call path checks membership
 * here before it resolves anything.
 */
export class AuthoredCodeCapabilitySet {
    readonly #capabilities: ReadonlyMap<string, AuthoredCodeCapability>;

    public constructor(capabilities: readonly AuthoredCodeCapability[]) {
        const indexed = new Map<string, AuthoredCodeCapability>();
        for (const capability of capabilities) {
            if (!(capability instanceof AuthoredCodeCapability)) {
                throw new TypeError("Passed capabilities must use the canonical contract");
            }
            if (indexed.has(capability.name.value)) {
                throw new TypeError("Passed capability names must be unique");
            }
            indexed.set(capability.name.value, capability);
        }
        this.#capabilities = indexed;
        Object.freeze(this);
    }

    public static get none(): AuthoredCodeCapabilitySet {
        return emptyCapabilitySet;
    }

    public capability(name: BindingName): AuthoredCodeCapability | undefined {
        return this.#capabilities.get(name.value);
    }

    public get names(): readonly BindingName[] {
        return Object.freeze([...this.#capabilities.values()].map((entry) => entry.name));
    }
}

export interface AuthoredCodeInvocationRequest {
    readonly binding: BindingName;
    readonly operation: OperationName;
    readonly input: FacetData;
}

/**
 * The one channel out of an isolate. A backing hands the loaded code this port and
 * nothing else, so every call the code makes arrives here and leaves as an ordinary
 * Invocation.
 */
export abstract class AuthoredCodeInvocationPort {
    public abstract invoke(request: AuthoredCodeInvocationRequest): Promise<FacetData>;
}

/**
 * The isolate's calls, re-entering the ordinary Invocation pipeline under the isolate's
 * own delegated authority. Three checks make the wrong call unexpressible rather than
 * merely discouraged: the requested name must belong to the passed set; the gateway is
 * the isolate's own, so resolution happens against the isolate's protection domain and
 * never the loader's; and the resolved Facet and Package must be the exact ones the
 * passed capability pinned.
 *
 * Unlike a Turn's bound Operations, an isolate's calls are not forced onto the mediated
 * path here — §4.7 makes them ordinary Invocations tiered by §7.2, and §7.2 alone
 * decides. A `dynamic` facet is never `direct`, but a `dynamic` isolate calling a
 * `bundled` facet is a case the tiering rules already answer.
 */
export class GatewayAuthoredCodeInvocationPort extends AuthoredCodeInvocationPort {
    #calls = 0;

    public constructor(
        private readonly gateway: OperationGateway,
        private readonly capabilities: AuthoredCodeCapabilitySet,
        private readonly isolate: string,
        private readonly signal: AbortSignal
    ) {
        super();
    }

    public async invoke(request: AuthoredCodeInvocationRequest): Promise<FacetData> {
        this.requireNotCancelled();
        const capability = this.capabilities.capability(request.binding);
        if (capability === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Agent-authored code invoked a capability it was not passed"
            );
        }
        // The request key is the host's, never the isolate's: it is the identity the
        // pipeline deduplicates and replays on, so loaded code that could choose it
        // could replay another call's admission.
        const requestKey = new OperationRequestKey(`${this.isolate}:${(this.#calls += 1)}`);
        const resolved = await this.gateway.resolve(request.binding);
        try {
            const descriptor = resolved.descriptor(request.operation);
            if (
                !resolved.facet.equals(capability.facet) ||
                !resolved.package.equals(capability.package) ||
                descriptor === undefined
            ) {
                throw new AgentCoreError(
                    "binding.invalid",
                    "Resolved Facet does not match the exact passed capability"
                );
            }
            this.requireNotCancelled();
            const result = await resolved.dispatch({
                requestKey,
                operation: descriptor.name,
                payload: { kind: "single", input: canonicalFacetData(request.input) }
            });
            this.requireNotCancelled();
            if (Array.isArray(result.output)) {
                throw new AgentCoreError(
                    "operation.invalid-output",
                    "Single agent-authored code Invocation returned a batch result"
                );
            }
            return canonicalFacetData(result.output);
        } finally {
            resolved[Symbol.dispose]();
        }
    }

    private requireNotCancelled(): void {
        if (this.signal.aborted) {
            throw new AgentCoreError("lease.invalid", "Agent-authored code execution is cancelled");
        }
    }
}

/**
 * The passed capability set as the authority plane holds it: Grants delegated under
 * §3.4 and Bindings in the isolate's own protection domain, plus the gateway that
 * resolves them. Disposing it revokes the delegation — which severs the isolate and
 * leaves the authority it was delegated from untouched, because those are different
 * Grants in one lineage.
 */
export abstract class AuthoredCodeDelegation implements AsyncDisposable {
    public abstract readonly capabilities: AuthoredCodeCapabilitySet;
    public abstract readonly gateway: OperationGateway;
    public abstract [Symbol.asyncDispose](): Promise<void>;
}

export interface AuthoredCodeDelegationRequest {
    readonly consumer: AuthoredCodeConsumer;
    /** The capabilities the submission asks for, each pinned to an exact Facet. */
    readonly requested: AuthoredCodeCapabilitySet;
    /** Identifies the one isolate this delegation is for, and nothing else. */
    readonly isolate: string;
    readonly signal: AbortSignal;
}

/**
 * Delegating a capability set into a fresh isolate domain. Implementations mint the
 * passed Grants as attenuations of the delegator's own, which is what bounds the set at
 * "equal at most, never wider" without this seam restating the §3.4 rules.
 */
export abstract class AuthoredCodeDelegationPort {
    public abstract delegate(
        request: AuthoredCodeDelegationRequest
    ): Promise<AuthoredCodeDelegation>;
}

export interface AuthoredCodeRunRequest {
    readonly consumer: AuthoredCodeConsumer;
    /** The one isolate this run is for: §4.7 gives each submission exactly one. */
    readonly isolate: string;
    readonly entry: string;
    /** Module name to its UTF-8 source, resolved from the submission's content refs. */
    readonly code: ReadonlyMap<string, string>;
    readonly capabilities: AuthoredCodeCapabilitySet;
    readonly invocations: AuthoredCodeInvocationPort;
    readonly input: FacetData;
    readonly signal: AbortSignal;
}

/**
 * A hosting mechanism for a `dynamic` domain (§4.7, §10.2). Every backing loads the
 * code into a fresh isolate with zero ambient authority and zero ambient egress, gives
 * it `invocations` and nothing else, runs it once against `input`, and disposes it. The
 * choice between backings is operational: each satisfies those guarantees on its own,
 * never by comparison with another.
 */
export abstract class AuthoredCodeBacking {
    public abstract readonly id: AuthoredCodeBackingId;
    public abstract run(request: AuthoredCodeRunRequest): Promise<FacetData>;
}

/**
 * The backings a substrate profile offers and the one it declares as its default. The
 * default is the profile's, not the Blueprint's: §4.7 sends a consumer the Blueprint
 * does not map here rather than to an arbitrary member of the offered set.
 */
export class AuthoredCodeBackingSet {
    readonly #backings: ReadonlyMap<string, AuthoredCodeBacking>;

    public constructor(
        backings: readonly AuthoredCodeBacking[],
        public readonly declaredDefault: AuthoredCodeBackingId
    ) {
        const indexed = new Map<string, AuthoredCodeBacking>();
        for (const backing of backings) {
            if (!(backing instanceof AuthoredCodeBacking)) {
                throw new TypeError("Offered backings must implement the backing contract");
            }
            if (indexed.has(backing.id.value)) {
                throw new TypeError("Offered backing identifiers must be unique");
            }
            indexed.set(backing.id.value, backing);
        }
        if (!indexed.has(declaredDefault.value)) {
            throw new TypeError("A profile's declared default backing must be one it offers");
        }
        this.#backings = indexed;
        Object.freeze(this);
    }

    public backing(id: AuthoredCodeBackingId): AuthoredCodeBacking {
        const backing = this.#backings.get(id.value);
        if (backing === undefined) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Backing ${id.value} is not offered by this profile`
            );
        }
        return backing;
    }
}

export interface AuthoredCodeSubmission {
    readonly source: AuthoredCodeSource;
    readonly capabilities: AuthoredCodeCapabilitySet;
    readonly input: FacetData;
}

export interface AuthoredCodeRunScope {
    /**
     * The isolate's identity, which is the submitting Invocation's: one isolate per
     * submission, so the Invocation that carries the submission names it exactly.
     */
    readonly isolate: string;
    readonly content: ContentStore;
    readonly signal: AbortSignal;
}

export interface AuthoredCodeHostInit {
    readonly delegations: AuthoredCodeDelegationPort;
    readonly backings: AuthoredCodeBackingSet;
    /** The Blueprint's consumer → backing declaration (§9.2 `policies.placement`). */
    readonly backingFor: (
        consumer: AuthoredCodeConsumer,
        profileDefault: AuthoredCodeBackingId
    ) => AuthoredCodeBackingId;
}

/**
 * One submission of agent-authored code, run once. The host owns the whole shape §4.7
 * states: delegate the passed capability set into a fresh isolate domain, resolve the
 * submitted source, select the declared backing, run the code with the one outward
 * channel and nothing else, and revoke the delegation when the submission ends.
 *
 * The three §4.7 consumers differ only in when that last step happens, which is why the
 * consumer is a parameter here rather than three code paths.
 */
export class AuthoredCodeHost {
    public constructor(private readonly init: AuthoredCodeHostInit) {}

    public async run(
        consumer: AuthoredCodeConsumer,
        submission: AuthoredCodeSubmission,
        scope: AuthoredCodeRunScope
    ): Promise<FacetData> {
        const code = await resolveCode(submission.source, scope.content);
        const backing = this.init.backings.backing(
            this.init.backingFor(consumer, this.init.backings.declaredDefault)
        );
        const delegation = await this.init.delegations.delegate({
            consumer,
            requested: submission.capabilities,
            isolate: scope.isolate,
            signal: scope.signal
        });
        try {
            return await backing.run({
                consumer,
                isolate: scope.isolate,
                entry: submission.source.entry,
                code,
                capabilities: delegation.capabilities,
                invocations: new GatewayAuthoredCodeInvocationPort(
                    delegation.gateway,
                    delegation.capabilities,
                    scope.isolate,
                    scope.signal
                ),
                input: canonicalFacetData(submission.input),
                signal: scope.signal
            });
        } finally {
            await delegation[Symbol.asyncDispose]();
        }
    }
}

const AUTHORED_CODE_INPUT_SCHEMA = strictObjectSchema(
    {
        capabilities: {
            type: "array",
            items: strictObjectSchema(
                {
                    binding: { type: "string", minLength: 1 },
                    capability: { type: "object" },
                    facet: { type: "string", minLength: 1 }
                },
                ["binding", "facet"]
            ).document,
            uniqueItems: true
        },
        consumer: { const: "programmaticToolCall" },
        input: {},
        source: strictObjectSchema(
            {
                entry: { type: "string", minLength: 1 },
                modules: {
                    type: "object",
                    minProperties: 1,
                    additionalProperties: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }
                }
            },
            ["entry", "modules"]
        ).document
    },
    ["capabilities", "consumer", "input", "source"]
);

/**
 * Programmatic tool calling as the model sees it: one Operation invocation, code in,
 * value out, with every Operation the code called in between carrying its own admission
 * and evidence. Its impact is `delegate` because handing the capability set to the
 * isolate is delegation, which §7.2 floors at mediated — so a submission is admitted,
 * receipted, and audited exactly once whatever the code inside goes on to do.
 *
 * §4.7 fixes the shape and §11 declares no profile that owns it, so the Operation's
 * name is the contributing Facet's to choose (P11-BASE-NAMES); the impact and the
 * semantics are not.
 */
export class AuthoredCodeOperation extends Operation {
    public readonly descriptor: OperationDescriptor;

    public constructor(
        name: OperationName,
        private readonly host: AuthoredCodeHost
    ) {
        super();
        this.descriptor = new OperationDescriptor(
            name,
            "delegate",
            AUTHORED_CODE_INPUT_SCHEMA,
            schema({}),
            "Runs submitted agent-authored code once in a fresh isolate holding only the passed capabilities."
        );
    }

    public async execute(context: OperationContext, input: FacetData): Promise<FacetData> {
        return this.host.run("programmaticToolCall", decodeSubmission(input), {
            isolate: context.invocation.value,
            content: context.content,
            signal: context.signal
        });
    }
}

export function decodeSubmission(input: FacetData): AuthoredCodeSubmission {
    const object = requireDataObject(input, "Agent-authored code submission");
    requireAuthoredCodeConsumer(object["consumer"], "Agent-authored code consumer");
    const capabilities = object["capabilities"];
    if (!Array.isArray(capabilities)) {
        throw new TypeError("Agent-authored code capabilities must be an array");
    }
    return Object.freeze({
        source: AuthoredCodeSource.fromData(
            requireDataObject(object["source"], "Submitted source")
        ),
        capabilities: new AuthoredCodeCapabilitySet(
            capabilities.map((entry) => {
                const passed = requireDataObject(entry, "Passed capability");
                const narrowing = passed["capability"];
                return new AuthoredCodeCapability(
                    new BindingName(requireString(passed["binding"], "Passed capability name")),
                    new FacetRef(requireString(passed["facet"], "Passed capability Facet")),
                    narrowing === undefined ? undefined : CapabilitySpec.fromData(narrowing)
                );
            })
        ),
        input: canonicalFacetData(object["input"] ?? null)
    });
}

async function resolveCode(
    source: AuthoredCodeSource,
    content: ContentStore
): Promise<ReadonlyMap<string, string>> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const resolved = new Map<string, string>();
    for (const [name, ref] of source.modules) {
        const stat = await content.stat(ref);
        if (stat === undefined || !stat.digest.equals(ref.digest)) {
            throw new AgentCoreError(
                "content.not-found",
                `Agent-authored code module ${name} is not available`
            );
        }
        resolved.set(name, decoder.decode(await content.get(ref)));
    }
    return resolved;
}

const emptyCapabilitySet = new AuthoredCodeCapabilitySet([]);

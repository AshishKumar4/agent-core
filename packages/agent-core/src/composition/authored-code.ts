import {
    Binding,
    Grant,
    GrantId,
    type AuthorityMutationService,
    type TenantAuthorityReadStore
} from "../authority";
import { Digest, encodeCanonicalJson } from "../core";
import { AgentCoreError } from "../errors";
import { ProtectionDomain, type BindingName } from "../facets";
import type { ScopeRef, SubjectRef } from "../identity";
import {
    AuthoredCodeCapability,
    AuthoredCodeCapabilitySet,
    AuthoredCodeDelegation,
    AuthoredCodeDelegationPort,
    type AuthoredCodeDelegationRequest,
    type OperationGateway
} from "../operations";

/**
 * How the isolate's own Invocations reach the authority plane. The factory is given the
 * fresh protection domain the delegated Bindings live in, and returns a gateway that
 * resolves in that domain only — which is what makes "the isolate presents its own
 * delegated authority, never its loader's" a property of the wiring rather than a rule
 * the loaded code is trusted to observe.
 */
export type IsolateGatewayFactory = (
    domain: ProtectionDomain,
    subject: SubjectRef
) => OperationGateway;

export interface TenantAuthoredCodeDelegationInit {
    /** Exactly the two reads the delegation needs: the source Binding and its Grant. */
    readonly store: Pick<TenantAuthorityReadStore, "binding" | "grant">;
    readonly authority: AuthorityMutationService;
    /** The Workspace Scope the delegator's own Bindings live in. */
    readonly scope: ScopeRef;
    readonly subject: SubjectRef;
    /** The protection domain the delegator's own Bindings live in. */
    readonly domain: ProtectionDomain;
    readonly gateways: IsolateGatewayFactory;
}

/**
 * Passing a capability set into a §4.7 isolate, as the delegation §4.7 says it is.
 *
 * For each requested name the delegator's own Binding is read, its backing Grant is
 * delegated to an equal-or-narrower child Grant, and the child is bound under the same
 * name in a protection domain that exists only for this isolate. Nothing here restates
 * the §3.4 rules: creating the child Grant runs the ordinary delegation validation, so
 * a request for more than the delegator holds is refused by the same code that refuses
 * any other over-wide delegation, and a `deny` is not delegable at all because the
 * Grant record forbids attenuating one.
 *
 * Disposal revokes the delegated Grants. Revocation closes over descendants and leaves
 * ancestors alone, so the isolate is severed and its loader keeps exactly what it had.
 */
export class TenantAuthoredCodeDelegationPort extends AuthoredCodeDelegationPort {
    public constructor(private readonly init: TenantAuthoredCodeDelegationInit) {
        super();
    }

    public async delegate(request: AuthoredCodeDelegationRequest): Promise<AuthoredCodeDelegation> {
        const domain = isolateDomain(request.isolate);
        const minted: GrantId[] = [];
        try {
            const passed = request.requested.names.map((name) => {
                const capability = required(
                    request.requested.capability(name),
                    "Requested capability disappeared between reads"
                );
                const delegated = this.delegateOne(request.isolate, capability, domain);
                minted.push(delegated.id);
                // The declared Operations travel with the capability, so the §4.7
                // availability screen runs on the set the backing actually receives rather
                // than on the set the caller asked for.
                return new AuthoredCodeCapability(
                    capability.name,
                    capability.facet,
                    delegated.capability,
                    capability.operations
                );
            });
            return new MintedAuthoredCodeDelegation(
                new AuthoredCodeCapabilitySet(passed),
                this.init.gateways(domain, this.init.subject),
                minted,
                this.init.authority
            );
        } catch (error) {
            revokeAll(this.init.authority, minted);
            throw error;
        }
    }

    private delegateOne(
        isolate: string,
        capability: AuthoredCodeCapability,
        domain: ProtectionDomain
    ): Grant {
        const source = this.sourceBinding(capability.name);
        const parent = this.init.store.grant(source.grantId);
        if (parent === undefined || !parent.isLive || parent.effect !== "allow") {
            throw denied(
                `Passed capability ${capability.name.value} has no live allow Grant to delegate`
            );
        }
        const delegated = this.init.authority.createGrant(
            new Grant(
                delegatedGrantId(isolate, capability.name),
                parent.scope,
                parent.subject,
                "allow",
                capability.capability ?? parent.capability,
                { kind: "direct" },
                parent.id
            )
        );
        this.init.authority.createBinding(
            Binding.active(
                source.scope,
                source.subject,
                domain,
                capability.name,
                delegated.id,
                capability.facet
            )
        );
        return delegated;
    }

    private sourceBinding(name: BindingName): Binding {
        const binding = this.init.store.binding(
            Binding.keyFor(this.init.scope, this.init.subject, this.init.domain, name)
        );
        if (binding === undefined || !binding.resolves) {
            throw denied(`Delegator holds no live Binding named ${name.value}`);
        }
        return binding;
    }
}

class MintedAuthoredCodeDelegation extends AuthoredCodeDelegation {
    #revoked = false;

    public constructor(
        public readonly capabilities: AuthoredCodeCapabilitySet,
        public readonly gateway: OperationGateway,
        private readonly minted: readonly GrantId[],
        private readonly authority: AuthorityMutationService
    ) {
        super();
    }

    /**
     * Revoking the delegated Grants is the whole of severing: §4.7 names revocation as
     * the mechanism, and a Binding whose Grant is revoked resolves to nothing. The
     * inert Bindings stay, addressable only through a protection domain no later
     * submission is given, which is a retention question and not an authority one.
     */
    public async [Symbol.asyncDispose](): Promise<void> {
        if (this.#revoked) return;
        this.#revoked = true;
        revokeAll(this.authority, this.minted);
    }
}

/**
 * One protection domain per isolate, named after the submission it exists for. Two
 * submissions therefore never share a domain, and a Binding minted for one is not
 * addressable from the other — Binding identity includes the domain (§3.4).
 *
 * `no-secrets` is not a policy choice here: raw credentials stay in Tenant custody and
 * delegation moves capability stubs, never secrets (§3.4 rule 3).
 */
export function isolateDomain(isolate: string): ProtectionDomain {
    return new ProtectionDomain(
        "backend",
        `authored-code:${Digest.sha256(encodeCanonicalJson(isolate)).value}`,
        "no-secrets"
    );
}

function delegatedGrantId(isolate: string, name: BindingName): GrantId {
    return new GrantId(
        `authored-code:${Digest.sha256(encodeCanonicalJson([isolate, name.value])).value}`
    );
}

function revokeAll(authority: AuthorityMutationService, minted: readonly GrantId[]): void {
    for (const id of minted) authority.revokeGrant(id);
}

function required<Value>(value: Value | undefined, message: string): Value {
    if (value === undefined) throw new AgentCoreError("protocol.invalid-state", message);
    return value;
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

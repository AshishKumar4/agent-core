import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    AuthorityCheckRequest,
    AuthorityMutationService,
    Binding,
    BindingValidationRequest,
    Grant,
    GrantId,
    MemoryTenantControlStore,
    TenantAuthorityRuntime,
    type PathEpochEvidence
} from "../../src/authority";
import { TenantAuthoredCodeDelegationPort, isolateDomain } from "../../src/composition";
import { Digest, Revision, encodeCanonicalJson } from "../../src/core";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import { PrincipalId, ScopeRef, SubjectRef, TenantId, WorkspaceId } from "../../src/identity";
import {
    AuthoredCodeCapability,
    AuthoredCodeCapabilitySet,
    OperationGateway,
    type AuthoredCodeDelegation
} from "../../src/operations";
import { PrincipalRef, Workspace } from "../identity/internal-fixture";

const tenantId = new TenantId("authored-code-tenant");
const principalId = new PrincipalId("authored-code-principal");
const principal = new PrincipalRef(tenantId, principalId);
const subject = SubjectRef.principal(principal);
const workspaceId = new WorkspaceId("authored-code-workspace");
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const tenantActor = new ActorRef("tenant", new ActorId("authored-code-tenant-actor"));
const workspaceActor = new ActorRef("workspace", new ActorId("authored-code-workspace-actor"));
const loaderDomain = new ProtectionDomain("backend", "loader", "may-hold-secrets");
const mailFacet = new FacetRef("mail:instance");
const mailBinding = new BindingName("mail");
const loaderGrantId = new GrantId("authored-code-loader-grant");
const isolate = "invocation:authored-code-1";
const argumentsValue = { folder: "inbox" } as const;

describe("passing a capability set into a §4.7 isolate is delegation", () => {
    test(
        "[C13-AUTH-ISOLATE-DELEGATION] binds the passed set to attenuations in the isolate's own domain",
        { tags: "p0" },
        async () => {
            const fixture = createFixture();
            const delegation = await fixture.delegate();

            const delegated = fixture.store.grant(delegatedGrantId(mailBinding));
            expect(delegated?.attenuationOf?.value).toBe(loaderGrantId.value);
            expect(delegated?.isLive).toBe(true);
            expect(delegation.capabilities.names.map((name) => name.value)).toEqual(["mail"]);

            // The isolate's Binding lives in a domain of its own, and Binding identity
            // includes the domain — so the loader's Binding and the isolate's are two
            // records, resolvable only from their own side.
            const isolateBinding = fixture.isolateBinding();
            expect(isolateBinding.domain.equals(isolateDomain(isolate))).toBe(true);
            expect(isolateBinding.domain.equals(loaderDomain)).toBe(false);
            expect(fixture.check(isolateBinding).reason).toBe("allowed");

            await delegation[Symbol.asyncDispose]();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] revoking a passed Grant severs the isolate and leaves its loader whole",
        { tags: "p0" },
        async () => {
            const fixture = createFixture();
            const delegation = await fixture.delegate();
            const isolateBinding = fixture.isolateBinding();
            const loaderBinding = fixture.loaderBinding();

            expect(fixture.check(isolateBinding).reason).toBe("allowed");
            expect(fixture.check(loaderBinding).reason).toBe("allowed");

            fixture.authority.revokeGrant(delegatedGrantId(mailBinding));

            expect(fixture.check(isolateBinding).reason).toBe("revokedGrant");
            expect(fixture.check(isolateBinding).allowed).toBe(false);
            // The loader delegated authority; it did not give it away.
            expect(fixture.check(loaderBinding).reason).toBe("allowed");
            expect(fixture.store.grant(loaderGrantId)?.isLive).toBe(true);

            await delegation[Symbol.asyncDispose]();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] ends the delegation when the submission ends",
        { tags: "p0" },
        async () => {
            const fixture = createFixture();
            const delegation = await fixture.delegate();
            const isolateBinding = fixture.isolateBinding();

            await delegation[Symbol.asyncDispose]();
            expect(fixture.check(isolateBinding).reason).toBe("revokedGrant");
            expect(fixture.store.grant(loaderGrantId)?.isLive).toBe(true);

            // Disposal is idempotent: a second one neither throws nor revokes anything
            // it did not mint.
            await delegation[Symbol.asyncDispose]();
            expect(fixture.check(fixture.loaderBinding()).reason).toBe("allowed");
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] refuses a passed set wider than the delegator holds",
        { tags: "p0" },
        async () => {
            const fixture = createFixture();

            await expect(
                fixture.delegate(
                    new AuthoredCodeCapabilitySet([
                        new AuthoredCodeCapability(
                            mailBinding,
                            mailFacet,
                            new CapabilitySpec({
                                facetPattern: "mail:*",
                                operations: ["read", "send"],
                                impacts: ["observe", "externalSend"]
                            })
                        )
                    ])
                )
            ).rejects.toMatchObject({ code: "authority.denied" });

            // Nothing survives a refused delegation: no Grant, so no Binding resolves.
            expect(fixture.store.grant(delegatedGrantId(mailBinding))?.isLive).not.toBe(true);
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] admits an equal or narrower passed set",
        { tags: "p1" },
        async () => {
            const fixture = createFixture();
            const delegation = await fixture.delegate(
                new AuthoredCodeCapabilitySet([
                    new AuthoredCodeCapability(
                        mailBinding,
                        mailFacet,
                        new CapabilitySpec({
                            facetPattern: mailFacet.value,
                            operations: ["read"],
                            impacts: ["observe"]
                        })
                    )
                ])
            );

            const delegated = fixture.store.grant(delegatedGrantId(mailBinding));
            expect(delegated?.capability.operations).toEqual(["read"]);
            expect(delegation.capabilities.capability(mailBinding)?.capability?.operations).toEqual(
                ["read"]
            );
            await delegation[Symbol.asyncDispose]();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] refuses a capability the delegator does not hold at all",
        { tags: "p0" },
        async () => {
            const fixture = createFixture();

            await expect(
                fixture.delegate(
                    new AuthoredCodeCapabilitySet([
                        new AuthoredCodeCapability(
                            new BindingName("secrets"),
                            new FacetRef("secrets:instance")
                        )
                    ])
                )
            ).rejects.toMatchObject({ code: "authority.denied" });
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] refuses a capability whose backing Grant was revoked",
        { tags: "p0" },
        async () => {
            const fixture = createFixture();
            fixture.authority.revokeGrant(loaderGrantId);

            // Revocation does not deactivate the Bindings that name the Grant — Binding
            // state is the Binding's own lifecycle — so the delegator's Binding still
            // resolves and the source read succeeds. This is the state disposal leaves
            // behind: severing revokes the Grants and the inert Bindings stay.
            expect(fixture.store.grant(loaderGrantId)?.isLive).toBe(false);
            expect(fixture.loaderBinding().resolves).toBe(true);

            // The refusal names the capability. createGrant's own attenuation check
            // would refuse this too, so asserting only the code proves nothing about
            // where the refusal came from: the delegation port has to reject a dead
            // parent before it dereferences one, or an absent Grant reaches `parent.scope`
            // as a TypeError instead of a denial an operator can act on.
            await expect(fixture.delegate()).rejects.toMatchObject({
                code: "authority.denied",
                message: `Passed capability ${mailBinding.value} has no live allow Grant to delegate`
            });
            expect(fixture.store.grant(delegatedGrantId(mailBinding))).toBeUndefined();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] gives two submissions two unshared isolate domains",
        { tags: "p1" },
        () => {
            expect(isolateDomain("invocation:a").equals(isolateDomain("invocation:b"))).toBe(false);
            expect(isolateDomain(isolate).equals(isolateDomain(isolate))).toBe(true);
            expect(isolateDomain(isolate).canHoldSecrets).toBe(false);
        }
    );
});

function delegatedGrantId(name: BindingName): GrantId {
    return new GrantId(
        `authored-code:${Digest.sha256(encodeCanonicalJson([isolate, name.value])).value}`
    );
}

function createFixture(): DelegationFixture {
    return new DelegationFixture();
}

class DelegationFixture {
    public readonly store: MemoryTenantControlStore;
    public readonly authority: AuthorityMutationService;
    public readonly runtime: TenantAuthorityRuntime;
    public readonly port: TenantAuthoredCodeDelegationPort;

    public constructor() {
        const anchor = {
            actorId: tenantActor.id,
            tenantId,
            principalId,
            trustAnchor: Uint8Array.of(7, 7, 7)
        };
        this.store = MemoryTenantControlStore.create(anchor);
        this.store.bootstrapTenant(anchor, Revision.initial());
        this.authority = new AuthorityMutationService(this.store);
        this.authority.createWorkspace(
            new Workspace(workspaceId, tenantId, undefined, Revision.initial())
        );
        this.authority.createGrant(
            new Grant(
                loaderGrantId,
                workspaceScope,
                subject,
                "allow",
                new CapabilitySpec({
                    facetPattern: "mail:*",
                    operations: ["read"],
                    impacts: ["observe"]
                }),
                { kind: "direct" }
            )
        );
        this.authority.createBinding(
            Binding.active(
                workspaceScope,
                subject,
                loaderDomain,
                mailBinding,
                loaderGrantId,
                mailFacet
            )
        );
        this.runtime = new TenantAuthorityRuntime(this.store, tenantActor);
        this.port = new TenantAuthoredCodeDelegationPort({
            store: this.store,
            authority: this.authority,
            scope: workspaceScope,
            subject,
            domain: loaderDomain,
            // The isolate's gateway is the platform's to build; this delegation is about
            // the authority records behind it, so the factory records the domain it was
            // asked for and returns a gateway nothing here calls.
            gateways: (domain) => {
                this.isolateGatewayDomain = domain;
                return new UnusedGateway();
            }
        });
    }

    public isolateGatewayDomain: ProtectionDomain | undefined;

    public delegate(
        requested = new AuthoredCodeCapabilitySet([
            new AuthoredCodeCapability(mailBinding, mailFacet)
        ])
    ): Promise<AuthoredCodeDelegation> {
        return this.port.delegate({
            consumer: "programmaticToolCall",
            requested,
            isolate,
            signal: new AbortController().signal
        });
    }

    public isolateBinding(): Binding {
        return this.requireBinding(isolateDomain(isolate));
    }

    public loaderBinding(): Binding {
        return this.requireBinding(loaderDomain);
    }

    public check(binding: Binding): { readonly allowed: boolean; readonly reason: string } {
        const evidence = this.runtime.check(
            new AuthorityCheckRequest({
                ownerTenant: tenantId,
                owner: workspaceActor,
                ownerFence: 1,
                principal,
                binding,
                intent: {
                    facet: mailFacet,
                    operation: "read",
                    impact: "observe",
                    arguments: argumentsValue,
                    argumentsDigest: Digest.sha256(encodeCanonicalJson(argumentsValue))
                },
                expectedPath: this.currentPath(),
                invocationDigest: Digest.sha256(Uint8Array.of(9)),
                itemIndex: 0,
                attemptOrdinal: 0,
                nonce: `check-${binding.domain.label}`
            }),
            new Date(1_000)
        );
        return { allowed: evidence.allowed, reason: evidence.reason };
    }

    private currentPath(): PathEpochEvidence {
        return this.runtime.validateBinding(
            new BindingValidationRequest({
                ownerTenant: tenantId,
                workspaceActor,
                workspaceFence: 1,
                scope: workspaceScope,
                domain: loaderDomain,
                name: mailBinding,
                grantId: loaderGrantId,
                facet: mailFacet,
                nonce: "path"
            }),
            new Date(1_000)
        ).pathEpochs;
    }

    private requireBinding(domain: ProtectionDomain): Binding {
        const binding = this.store.binding(
            Binding.keyFor(workspaceScope, subject, domain, mailBinding)
        );
        if (binding === undefined) {
            throw new TypeError(`Fixture Binding for ${domain.label} is missing`);
        }
        return binding;
    }
}

class UnusedGateway extends OperationGateway {
    public resolve(): never {
        throw new TypeError("The delegation fixture never resolves through the isolate gateway");
    }
}

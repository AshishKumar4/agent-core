// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    Membership,
    MembershipId,
    GuestVerificationScheme,
    Principal,
    PrincipalId,
    RoleName,
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import {
    GuestTrust,
    GuestTrustId,
    GuestVerification,
    PrincipalRef,
    Workspace
} from "../identity/internal-fixture";
import { Binding } from "../../src/authority/binding";
import { BindingValidationRequest } from "../../src/authority/binding-evidence";
import { AuthorityCheckRequest } from "../../src/authority/evidence";
import { PathEpochEvidence, ScopeEpoch } from "../../src/authority/epoch";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { TenantAuthorityRuntime, type TenantAuthorityReadStore } from "../../src/authority/runtime";

const tenantId = new TenantId("runtime-hard-tenant");
const workspace = new Workspace(
    new WorkspaceId("runtime-hard-workspace"),
    tenantId,
    undefined,
    Revision.initial()
);
const workspaceScope = workspace.scope;
const principalId = new PrincipalId("runtime-hard-principal");
const principalRef = new PrincipalRef(tenantId, principalId);
const issuer = new ActorRef("tenant", new ActorId("runtime-hard-issuer"));
const owner = new ActorRef("workspace", new ActorId("runtime-hard-owner"));
const domain = new ProtectionDomain("backend", "runtime-hard", "no-secrets");
const facet = new FacetRef("workspace:runtime.hard");
const capability = new CapabilitySpec({
    facetPattern: "workspace:runtime.*",
    impacts: ["observe"]
});
const args = { value: true } as const;
const argsDigest = Digest.sha256(encodeCanonicalJson(args));

describe("TenantAuthorityRuntime hard gates", () => {
    test("requires a Tenant issuer and canonical request Tenant", () => {
        expect(() => new TenantAuthorityRuntime(new FakeAuthorityStore(), owner)).toThrow(
            AgentCoreError
        );
        const store = new FakeAuthorityStore();
        const runtime = new TenantAuthorityRuntime(store, issuer);
        expect(() =>
            runtime.validateBinding(
                validationRequest(new GrantId("missing"), {
                    ownerTenant: new TenantId("other")
                }),
                new Date(10)
            )
        ).toThrow(AgentCoreError);
        expect(() =>
            runtime.validateBinding(
                validationRequest(new GrantId("missing"), {
                    scope: ScopeRef.workspace(tenantId, new WorkspaceId("missing"))
                }),
                new Date(10)
            )
        ).toThrow(AgentCoreError);
    });

    test("rejects missing, deny, revoked, unreachable, and invalid-lineage backing Grants", () => {
        const store = new FakeAuthorityStore();
        const runtime = new TenantAuthorityRuntime(store, issuer);
        expect(() =>
            runtime.validateBinding(validationRequest(new GrantId("missing")), new Date(10))
        ).toThrow(AgentCoreError);

        const deny = directGrant("deny", "deny");
        store.grantRecords.push(deny);
        expect(() => runtime.validateBinding(validationRequest(deny.id), new Date(10))).toThrow(
            AgentCoreError
        );

        const revoked = directGrant("revoked").revoke();
        store.grantRecords.push(revoked);
        expect(() => runtime.validateBinding(validationRequest(revoked.id), new Date(10))).toThrow(
            AgentCoreError
        );

        const otherScope = ScopeRef.workspace(tenantId, new WorkspaceId("other-workspace"));
        const unreachable = directGrant("unreachable", "allow", otherScope);
        store.grantRecords.push(unreachable);
        expect(() =>
            runtime.validateBinding(validationRequest(unreachable.id), new Date(10))
        ).toThrow(AgentCoreError);

        const missingParent = new Grant(
            new GrantId("missing-parent-child"),
            workspaceScope,
            SubjectRef.principal(principalId),
            "allow",
            capability,
            { kind: "direct" },
            new GrantId("missing-parent")
        );
        store.grantRecords.push(missingParent);
        expect(() =>
            runtime.validateBinding(validationRequest(missingParent.id), new Date(10))
        ).toThrow(AgentCoreError);
    });

    test("returns closed denial reasons for local principal and Binding failures", () => {
        const store = new FakeAuthorityStore();
        const allow = directGrant("allow");
        store.grantRecords.push(allow);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        const binding = activeBinding(allow);
        const path = runtime.validateBinding(validationRequest(allow.id), new Date(10)).pathEpochs;

        expect(runtime.check(checkRequest(binding.deactivate(), path), new Date(10)).reason).toBe(
            "invalidBinding"
        );
        expect(runtime.check(checkRequest(binding, path), new Date(10)).reason).toBe(
            "missingPrincipal"
        );
        store.principalRecord = new Principal(principalId, "user", "disabled");
        expect(runtime.check(checkRequest(binding, path), new Date(10)).reason).toBe(
            "inactivePrincipal"
        );
        store.principalRecord = new Principal(principalId, "user", "active");

        const missing = activeBinding(allow, { grantId: new GrantId("missing") });
        expect(runtime.check(checkRequest(missing, path), new Date(10)).reason).toBe(
            "missingGrant"
        );
        const wrongSubject = activeBinding(allow, {
            subject: SubjectRef.principal(new PrincipalId("other"))
        });
        expect(runtime.check(checkRequest(wrongSubject, path), new Date(10)).reason).toBe(
            "noMatchingAllow"
        );
        const wrongFacet = activeBinding(allow, { facet: new FacetRef("workspace:other.facet") });
        expect(runtime.check(checkRequest(wrongFacet, path), new Date(10)).reason).toBe(
            "noMatchingAllow"
        );

        store.grantRecords[0] = allow.revoke();
        expect(runtime.check(checkRequest(binding, path), new Date(10)).reason).toBe(
            "revokedGrant"
        );
    });

    test("checks Team closure and rejects foreign identity substitution", () => {
        const store = new FakeAuthorityStore();
        store.principalRecord = new Principal(principalId, "user", "active");
        const team = new Team(
            new TeamId("team"),
            tenantId,
            "Team",
            [principalId],
            Revision.initial()
        );
        store.teamRecords.push(team);
        const allow = new Grant(
            new GrantId("team-allow"),
            workspaceScope,
            SubjectRef.team(team.id),
            "allow",
            capability,
            { kind: "direct" }
        );
        store.grantRecords.push(allow);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        const path = runtime.validateBinding(validationRequest(allow.id), new Date(10)).pathEpochs;
        expect(runtime.check(checkRequest(activeBinding(allow), path), new Date(10)).allowed).toBe(
            true
        );

        const foreignRequest = checkRequest(activeBinding(allow), path, {
            principal: new PrincipalRef(new TenantId("foreign-home"), principalId)
        });
        expect(runtime.check(foreignRequest, new Date(10)).reason).toBe("missingPrincipal");
    });

    test("[C13-AUTH-GUEST-ELEVATION] enforces guest proof, current trust, and elevation", () => {
        const store = new FakeAuthorityStore();
        const home = new TenantId("runtime-hard-home");
        const guest = new PrincipalId("runtime-hard-guest");
        const subject = SubjectRef.foreign(home, guest, GuestVerificationScheme.callback);
        const trust = new GuestTrust(
            new GuestTrustId("runtime-hard-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://runtime-hard.example/verify" },
            "active",
            Revision.initial()
        );
        const proof = new GuestVerification(
            new PrincipalRef(home, guest),
            trust.id,
            trust.revision,
            "callback",
            Digest.sha256(Uint8Array.of(9)),
            new Date(1),
            new Date(100)
        );
        const membership = new Membership(
            new MembershipId("runtime-hard-guest-member"),
            workspaceScope,
            subject,
            new RoleName("guest"),
            "active",
            Revision.initial(),
            proof
        );
        const allow = new Grant(
            GrantId.forRole(membership.id, 0),
            workspaceScope,
            subject,
            "allow",
            capability,
            {
                kind: "role",
                membershipId: membership.id,
                roleName: membership.role.value,
                ruleOrdinal: 0,
                guest: true
            }
        );
        store.grantRecords.push(allow);
        store.membershipRecords.push(membership);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        expect(() => runtime.validateBinding(validationRequest(allow.id), new Date(10))).toThrow(
            AgentCoreError
        );
        store.trustRecords.push(trust);
        const path = runtime.validateBinding(validationRequest(allow.id), new Date(10)).pathEpochs;
        expect(
            runtime.check(
                checkRequest(activeBinding(allow), path, {
                    principal: proof.principal,
                    impact: "delegate"
                }),
                new Date(10)
            ).reason
        ).toBe("guestElevation");
        store.trustRecords[0] = trust.rotate({
            kind: "callback",
            endpoint: "https://runtime-hard.example/rotated"
        });
        expect(
            runtime.check(
                checkRequest(activeBinding(allow), path, {
                    principal: proof.principal
                }),
                new Date(10)
            ).reason
        ).toBe("guestVerificationExpired");
    });

    test("fails closed for every malformed delegation lineage branch", () => {
        for (const malformed of [
            "revoked",
            "cycle",
            "missing",
            "deny",
            "foreign",
            "wider"
        ] as const) {
            const store = new FakeAuthorityStore();
            store.principalRecord = new Principal(principalId, "user", "active");
            const backing = directGrant(`backing-${malformed}`);
            store.grantRecords.push(backing);
            const childId = new GrantId(`child-${malformed}`);
            let parent: Grant | undefined;
            let child: Grant;
            if (malformed === "cycle") {
                child = new Grant(
                    childId,
                    workspaceScope,
                    backing.subject,
                    "allow",
                    capability,
                    { kind: "direct" },
                    childId
                );
            } else {
                const parentId = new GrantId(`parent-${malformed}`);
                parent = new Grant(
                    parentId,
                    malformed === "foreign"
                        ? ScopeRef.workspace(tenantId, new WorkspaceId("foreign-workspace"))
                        : workspaceScope,
                    malformed === "deny"
                        ? SubjectRef.principal(new PrincipalId("other-parent-subject"))
                        : backing.subject,
                    malformed === "deny" ? "deny" : "allow",
                    malformed === "wider"
                        ? new CapabilitySpec({
                              facetPattern: "workspace:other.*",
                              impacts: ["observe"]
                          })
                        : capability,
                    { kind: "direct" }
                );
                if (malformed === "revoked") parent = parent.revoke();
                child = new Grant(
                    childId,
                    workspaceScope,
                    backing.subject,
                    "allow",
                    capability,
                    { kind: "direct" },
                    malformed === "missing" ? new GrantId("missing") : parent.id
                );
            }
            if (parent !== undefined) store.grantRecords.push(parent);
            store.grantRecords.push(child);
            const runtime = new TenantAuthorityRuntime(store, issuer);
            const result = runtime.check(
                checkRequest(
                    activeBinding(backing),
                    new PathEpochEvidence([
                        new ScopeEpoch(ScopeRef.tenant(tenantId), 1),
                        new ScopeEpoch(workspaceScope, 2)
                    ])
                ),
                new Date(10)
            );
            expect(result.allowed, malformed).toBe(true);
        }
        const store = new FakeAuthorityStore();
        store.principalRecord = new Principal(principalId, "user", "active");
        const invalidBacking = new Grant(
            new GrantId("invalid-backing"),
            workspaceScope,
            SubjectRef.principal(principalId),
            "allow",
            capability,
            { kind: "direct" },
            new GrantId("missing-backing-parent")
        );
        store.grantRecords.push(invalidBacking);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        expect(
            runtime.check(
                checkRequest(
                    activeBinding(invalidBacking),
                    new PathEpochEvidence([
                        new ScopeEpoch(ScopeRef.tenant(tenantId), 1),
                        new ScopeEpoch(workspaceScope, 2)
                    ])
                ),
                new Date(10)
            ).reason
        ).toBe("revokedGrant");
    });

    test("rejects every guest-origin and trust mismatch branch", () => {
        const home = new TenantId("branch-home");
        const guest = new PrincipalId("branch-guest");
        const subject = SubjectRef.foreign(home, guest, GuestVerificationScheme.callback);
        const principal = new PrincipalRef(home, guest);
        const expectedPath = new PathEpochEvidence([
            new ScopeEpoch(ScopeRef.tenant(tenantId), 1),
            new ScopeEpoch(workspaceScope, 2)
        ]);

        const direct = new Grant(
            new GrantId("guest-direct"),
            workspaceScope,
            subject,
            "allow",
            capability,
            { kind: "direct" }
        );
        let store = new FakeAuthorityStore();
        store.grantRecords.push(direct);
        let runtime = new TenantAuthorityRuntime(store, issuer);
        expect(() => runtime.validateBinding(validationRequest(direct.id), new Date(10))).toThrow(
            AgentCoreError
        );
        expect(
            runtime.check(
                checkRequest(activeBinding(direct), expectedPath, { principal }),
                new Date(10)
            ).reason
        ).toBe("guestElevation");

        const membershipId = new MembershipId("branch-member");
        const proof = new GuestVerification(
            principal,
            new GuestTrustId("branch-trust"),
            Revision.initial(),
            "callback",
            Digest.sha256(Uint8Array.of(8)),
            new Date(1),
            new Date(100)
        );
        const membership = new Membership(
            membershipId,
            workspaceScope,
            subject,
            new RoleName("guest"),
            "active",
            Revision.initial(),
            proof
        );
        for (const origin of [
            { guest: false, capability },
            {
                guest: true,
                capability: new CapabilitySpec({
                    facetPattern: "workspace:runtime.*",
                    impacts: ["delegate"]
                })
            }
        ]) {
            const grant = new Grant(
                new GrantId(`guest-origin-${String(origin.guest)}-${origin.capability.impacts[0]}`),
                workspaceScope,
                subject,
                "allow",
                origin.capability,
                {
                    kind: "role",
                    membershipId: membership.id,
                    roleName: membership.role.value,
                    ruleOrdinal: 0,
                    guest: origin.guest
                }
            );
            store = new FakeAuthorityStore();
            store.grantRecords.push(grant);
            store.membershipRecords.push(membership);
            runtime = new TenantAuthorityRuntime(store, issuer);
            expect(
                runtime.check(
                    checkRequest(activeBinding(grant), expectedPath, { principal }),
                    new Date(10)
                ).reason
            ).toBe("guestElevation");
        }
    });

    test("excludes expired guest allows from successful evidence", () => {
        const store = new FakeAuthorityStore();
        const home = new TenantId("matched-home");
        const guest = new PrincipalId("matched-guest");
        const subject = SubjectRef.foreign(home, guest, GuestVerificationScheme.callback);
        const trust = new GuestTrust(
            new GuestTrustId("matched-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://matched.example/verify" },
            "active",
            Revision.initial()
        );
        store.trustRecords.push(trust);
        const makeMembership = (id: string, expiresAt: number): Membership =>
            new Membership(
                new MembershipId(id),
                workspaceScope,
                subject,
                new RoleName("guest"),
                "active",
                Revision.initial(),
                new GuestVerification(
                    new PrincipalRef(home, guest),
                    trust.id,
                    trust.revision,
                    "callback",
                    Digest.sha256(encodeCanonicalJson({ id })),
                    new Date(1),
                    new Date(expiresAt)
                )
            );
        const currentMembership = makeMembership("current-member", 100);
        const expiredMembership = makeMembership("expired-member", 5);
        store.membershipRecords.push(currentMembership, expiredMembership);
        const makeGrant = (membership: Membership): Grant =>
            new Grant(
                GrantId.forRole(membership.id, 0),
                workspaceScope,
                subject,
                "allow",
                capability,
                {
                    kind: "role",
                    membershipId: membership.id,
                    roleName: membership.role.value,
                    ruleOrdinal: 0,
                    guest: true
                }
            );
        const backing = makeGrant(currentMembership);
        const expired = makeGrant(expiredMembership);
        store.grantRecords.push(backing, expired);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        const evidence = runtime.check(
            checkRequest(
                activeBinding(backing),
                new PathEpochEvidence([
                    new ScopeEpoch(ScopeRef.tenant(tenantId), 1),
                    new ScopeEpoch(workspaceScope, 2)
                ]),
                { principal: new PrincipalRef(home, guest) }
            ),
            new Date(10)
        );

        expect(evidence.allowed).toBe(true);
        expect(evidence.matchedAllow.map((id) => id.value)).toEqual([backing.id.value]);
    });
});

class FakeAuthorityStore implements TenantAuthorityReadStore {
    public readonly tenantId = tenantId;
    public principalRecord: Principal | undefined;
    public readonly teamRecords: Team[] = [];
    public readonly grantRecords: Grant[] = [];
    public readonly membershipRecords: Membership[] = [];
    public readonly trustRecords: GuestTrust[] = [];

    public principal(id: PrincipalId): Principal | undefined {
        return this.principalRecord?.id.equals(id) === true ? this.principalRecord : undefined;
    }
    public teams(): readonly Team[] {
        return this.teamRecords;
    }
    public workspace(id: WorkspaceId): Workspace | undefined {
        return workspace.id.equals(id) ? workspace : undefined;
    }
    public membership(id: MembershipId): Membership | undefined {
        return this.membershipRecords.find((record) => record.id.equals(id));
    }
    public guestTrust(id: GuestTrustId): GuestTrust | undefined {
        return this.trustRecords.find((record) => record.id.equals(id));
    }
    public grant(id: GrantId): Grant | undefined {
        return this.grantRecords.find((record) => record.id.equals(id));
    }
    public grants(): readonly Grant[] {
        return this.grantRecords;
    }
    public epoch(scope: ScopeRef): ScopeEpoch {
        return new ScopeEpoch(scope, scope.kind === "tenant" ? 1 : 2);
    }
}

function directGrant(
    id: string,
    effect: "allow" | "deny" = "allow",
    scope = workspaceScope
): Grant {
    return new Grant(
        new GrantId(id),
        scope,
        SubjectRef.principal(principalId),
        effect,
        capability,
        { kind: "direct" }
    );
}

function activeBinding(
    grant: Grant,
    overrides: { grantId?: GrantId; subject?: Grant["subject"]; facet?: FacetRef } = {}
): Binding {
    return Binding.active(
        workspaceScope,
        overrides.subject ?? grant.subject,
        domain,
        new BindingName(`binding-${grant.id.value}`),
        overrides.grantId ?? grant.id,
        overrides.facet ?? facet
    );
}

function validationRequest(
    grantId: GrantId,
    overrides: { ownerTenant?: TenantId; scope?: ScopeRef } = {}
): BindingValidationRequest {
    return new BindingValidationRequest({
        ownerTenant: overrides.ownerTenant ?? tenantId,
        workspaceActor: owner,
        workspaceFence: 1,
        scope: overrides.scope ?? workspaceScope,
        domain,
        name: new BindingName("runtime-hard"),
        grantId,
        facet,
        nonce: `validate-${grantId.value}`
    });
}

function checkRequest(
    target: Binding,
    expectedPath: PathEpochEvidence,
    overrides: { principal?: PrincipalRef; impact?: "observe" | "delegate" } = {}
): AuthorityCheckRequest {
    const impact = overrides.impact ?? "observe";
    return new AuthorityCheckRequest({
        ownerTenant: tenantId,
        owner,
        ownerFence: 1,
        principal: overrides.principal ?? principalRef,
        binding: target,
        intent: {
            facet,
            operation: "read",
            impact,
            arguments: args,
            argumentsDigest: argsDigest
        },
        expectedPath,
        invocationDigest: Digest.sha256(Uint8Array.of(4)),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: `check-${target.name.value}-${impact}`
    });
}

import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, SecretRef, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    Membership,
    MembershipId,
    GuestVerificationScheme,
    Principal,
    PrincipalId,
    ProjectId,
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
    mintGuestVerification,
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
    test("requires a Tenant issuer and canonical request Tenant", { tags: "p0" }, () => {
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

    test(
        "rejects missing, deny, revoked, unreachable, and invalid-lineage backing Grants",
        { tags: "p0" },
        () => {
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
            expect(() =>
                runtime.validateBinding(validationRequest(revoked.id), new Date(10))
            ).toThrow(AgentCoreError);

            const otherScope = ScopeRef.workspace(tenantId, new WorkspaceId("other-workspace"));
            const unreachable = directGrant("unreachable", "allow", otherScope);
            store.grantRecords.push(unreachable);
            expect(() =>
                runtime.validateBinding(validationRequest(unreachable.id), new Date(10))
            ).toThrow(AgentCoreError);

            const missingParent = new Grant(
                new GrantId("missing-parent-child"),
                workspaceScope,
                SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                "allow",
                capability,
                { kind: "direct" },
                new GrantId("missing-parent")
            );
            store.grantRecords.push(missingParent);
            expect(() =>
                runtime.validateBinding(validationRequest(missingParent.id), new Date(10))
            ).toThrow(AgentCoreError);
        }
    );

    test(
        "returns closed denial reasons for local principal and Binding failures",
        { tags: "p0" },
        () => {
            const store = new FakeAuthorityStore();
            const allow = directGrant("allow");
            store.grantRecords.push(allow);
            const runtime = new TenantAuthorityRuntime(store, issuer);
            const binding = activeBinding(allow);
            const path = runtime.validateBinding(
                validationRequest(allow.id),
                new Date(10)
            ).pathEpochs;

            expect(
                runtime.check(checkRequest(binding.deactivate(), path), new Date(10)).reason
            ).toBe("invalidBinding");
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
                "invalidBinding"
            );
            const wrongSubject = activeBinding(allow, {
                subject: SubjectRef.principal(new PrincipalRef(tenantId, new PrincipalId("other")))
            });
            expect(runtime.check(checkRequest(wrongSubject, path), new Date(10)).reason).toBe(
                "invalidBinding"
            );
            const wrongFacet = activeBinding(allow, {
                facet: new FacetRef("workspace:other.facet")
            });
            expect(runtime.check(checkRequest(wrongFacet, path), new Date(10)).reason).toBe(
                "invalidBinding"
            );

            store.grantRecords[0] = allow.revoke();
            expect(runtime.check(checkRequest(binding, path), new Date(10)).reason).toBe(
                "revokedGrant"
            );
        }
    );

    test(
        "rejects request Binding bytes that differ from the canonical Tenant record",
        { tags: "p0" },
        () => {
            const store = new FakeAuthorityStore();
            store.principalRecord = new Principal(principalId, "user", "active");
            const allow = directGrant("canonical-binding");
            store.grantRecords.push(allow);
            const canonical = activeBinding(allow);
            const substituted = canonical.replace(allow.id, new FacetRef("workspace:forged"));
            const runtime = new TenantAuthorityRuntime(store, issuer);

            expect(runtime.check(checkRequest(substituted, fixedPath()), new Date(10)).reason).toBe(
                "invalidBinding"
            );
            expect(runtime.check(checkRequest(canonical, fixedPath()), new Date(10)).allowed).toBe(
                true
            );
        }
    );

    test("checks Team closure and rejects foreign identity substitution", { tags: "p0" }, () => {
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

    test(
        "[C13-AUTH-GUEST-ELEVATION] enforces guest proof, current trust, and elevation",
        { tags: "p0" },
        () => {
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
            const proof = mintGuestVerification(
                new PrincipalRef(home, guest),
                trust.id,
                trust.revision,
                GuestVerificationScheme.callback,
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
            expect(() =>
                runtime.validateBinding(validationRequest(allow.id), new Date(10))
            ).toThrow(AgentCoreError);
            store.trustRecords.push(trust);
            const path = runtime.validateBinding(
                validationRequest(allow.id),
                new Date(10)
            ).pathEpochs;
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
        }
    );

    test(
        "denies binding validation for foreign subjects backed by non-guest role Grants",
        { tags: "p0" },
        () => {
            const store = new FakeAuthorityStore();
            const home = new TenantId("runtime-hard-nonguest-home");
            const guest = new PrincipalId("runtime-hard-nonguest");
            const subject = SubjectRef.foreign(home, guest, GuestVerificationScheme.callback);
            const trust = new GuestTrust(
                new GuestTrustId("runtime-hard-nonguest-trust"),
                tenantId,
                home,
                { kind: "callback", endpoint: "https://runtime-hard.example/nonguest" },
                "active",
                Revision.initial()
            );
            const membership = new Membership(
                new MembershipId("runtime-hard-nonguest-member"),
                workspaceScope,
                subject,
                new RoleName("guest"),
                "active",
                Revision.initial(),
                mintGuestVerification(
                    new PrincipalRef(home, guest),
                    trust.id,
                    trust.revision,
                    GuestVerificationScheme.callback,
                    Digest.sha256(Uint8Array.of(21)),
                    new Date(1),
                    new Date(100)
                )
            );
            const backing = new Grant(
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
                    guest: false
                }
            );
            store.grantRecords.push(backing);
            store.membershipRecords.push(membership);
            store.trustRecords.push(trust);
            const runtime = new TenantAuthorityRuntime(store, issuer);
            expectAgentError(
                () => runtime.validateBinding(validationRequest(backing.id), new Date(10)),
                "authority.denied",
                "Binding requires a live allow Grant reaching its Workspace"
            );
        }
    );

    test("fails closed for every malformed delegation lineage branch", { tags: "p0" }, () => {
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
                        ? SubjectRef.principal(
                              new PrincipalRef(tenantId, new PrincipalId("other-parent-subject"))
                          )
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
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
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

    test("rejects every guest-origin and trust mismatch branch", { tags: "p0" }, () => {
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
        const proof = mintGuestVerification(
            principal,
            new GuestTrustId("branch-trust"),
            Revision.initial(),
            GuestVerificationScheme.callback,
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

    test("excludes expired guest allows from successful evidence", { tags: "p0" }, () => {
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
                mintGuestVerification(
                    new PrincipalRef(home, guest),
                    trust.id,
                    trust.revision,
                    GuestVerificationScheme.callback,
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

describe("TenantAuthorityRuntime mutation kill gates", () => {
    test("uses exact denial codes for issuer and Tenant guards", { tags: "p0" }, () => {
        expectAgentError(
            () => new TenantAuthorityRuntime(new FakeAuthorityStore(), owner),
            "protocol.invalid-state",
            "Tenant authority runtime requires a Tenant Actor"
        );
        const store = new FakeAuthorityStore();
        const allow = directGrant("tenant-guard-allow");
        store.grantRecords.push(allow);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        expectAgentError(
            () =>
                runtime.validateBinding(
                    validationRequest(allow.id, {
                        ownerTenant: new TenantId("tenant-guard-other")
                    }),
                    new Date(10)
                ),
            "authority.denied",
            "Authority request targets another Tenant"
        );
        expect(
            runtime.validateBinding(validationRequest(allow.id), new Date(10)).pathEpochs.path
        ).toHaveLength(2);
    });

    test("reports canonical topology and Grant denials with exact messages", { tags: "p0" }, () => {
        const store = new FakeAuthorityStore();
        const allow = directGrant("topology-allow");
        store.grantRecords.push(allow);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        expectAgentError(
            () =>
                runtime.validateBinding(
                    validationRequest(allow.id, {
                        scope: ScopeRef.workspace(tenantId, new WorkspaceId("topology-missing"))
                    }),
                    new Date(10)
                ),
            "authority.denied",
            "Authority target does not match canonical Tenant topology"
        );
        expectAgentError(
            () =>
                runtime.validateBinding(
                    validationRequest(allow.id, {
                        scope: ScopeRef.workspace(
                            tenantId,
                            new ProjectId("topology-phantom"),
                            workspace.id
                        )
                    }),
                    new Date(10)
                ),
            "authority.denied",
            "Authority target does not match canonical Tenant topology"
        );
        expectAgentError(
            () =>
                runtime.validateBinding(
                    validationRequest(new GrantId("topology-absent")),
                    new Date(10)
                ),
            "authority.denied",
            "Binding requires a live allow Grant reaching its Workspace"
        );
    });

    test(
        "denies deny-backed and revoked-backed Bindings with exact reasons and decision",
        { tags: "p0" },
        () => {
            const store = new FakeAuthorityStore();
            store.principalRecord = new Principal(principalId, "user", "active");
            const denyBacking = new Grant(
                new GrantId("deny-backing"),
                workspaceScope,
                SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                "deny",
                new CapabilitySpec({ facetPattern: "workspace:other.*", impacts: ["observe"] }),
                { kind: "direct" }
            );
            store.grantRecords.push(denyBacking);
            const runtime = new TenantAuthorityRuntime(store, issuer);
            const denied = runtime.check(
                checkRequest(activeBinding(denyBacking), fixedPath()),
                new Date(10)
            );
            expect(denied.decision).toBe("deny");
            expect(denied.allowed).toBe(false);
            expect(denied.reason).toBe("missingGrant");

            const revokedStore = new FakeAuthorityStore();
            revokedStore.principalRecord = new Principal(principalId, "user", "active");
            const revoked = new Grant(
                new GrantId("revoked-stranger-backing"),
                workspaceScope,
                SubjectRef.principal(
                    new PrincipalRef(tenantId, new PrincipalId("revoked-stranger"))
                ),
                "allow",
                capability,
                { kind: "direct" }
            ).revoke();
            revokedStore.grantRecords.push(revoked);
            const revokedRuntime = new TenantAuthorityRuntime(revokedStore, issuer);
            const evidence = revokedRuntime.check(
                checkRequest(activeBinding(revoked), fixedPath()),
                new Date(10)
            );
            expect(evidence.decision).toBe("deny");
            expect(evidence.reason).toBe("revokedGrant");
        }
    );

    test("rejects administer intents for guests before Grant evaluation", { tags: "p0" }, () => {
        const store = new FakeAuthorityStore();
        const home = new TenantId("administer-home");
        const guest = new PrincipalId("administer-guest");
        const subject = SubjectRef.foreign(home, guest, GuestVerificationScheme.callback);
        const trust = new GuestTrust(
            new GuestTrustId("administer-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://administer.example/verify" },
            "active",
            Revision.initial()
        );
        const proof = mintGuestVerification(
            new PrincipalRef(home, guest),
            trust.id,
            trust.revision,
            GuestVerificationScheme.callback,
            Digest.sha256(Uint8Array.of(13)),
            new Date(1),
            new Date(100)
        );
        const membership = new Membership(
            new MembershipId("administer-member"),
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
        store.trustRecords.push(trust);
        store.membershipRecords.push(membership);
        store.grantRecords.push(allow);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        expect(
            runtime.check(
                checkRequest(activeBinding(allow), fixedPath(), {
                    principal: proof.principal,
                    impact: "administer"
                }),
                new Date(10)
            ).reason
        ).toBe("guestElevation");
    });

    test("keeps Team-granted authority closed to non-members", { tags: "p0" }, () => {
        const store = new FakeAuthorityStore();
        store.principalRecord = new Principal(principalId, "user", "active");
        const team = new Team(
            new TeamId("closed-team"),
            tenantId,
            "Closed",
            [new PrincipalId("closed-member")],
            Revision.initial()
        );
        store.teamRecords.push(team);
        const allow = new Grant(
            new GrantId("closed-team-allow"),
            workspaceScope,
            SubjectRef.team(team.id),
            "allow",
            capability,
            { kind: "direct" }
        );
        store.grantRecords.push(allow);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        const result = runtime.check(checkRequest(activeBinding(allow), fixedPath()), new Date(10));
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe("noMatchingAllow");
    });

    test("admits valid attenuation chains across and within Scopes", { tags: "p0" }, () => {
        const store = new FakeAuthorityStore();
        store.principalRecord = new Principal(principalId, "user", "active");
        const parent = new Grant(
            new GrantId("chain-parent"),
            ScopeRef.tenant(tenantId),
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            "allow",
            capability,
            { kind: "direct" }
        );
        const child = new Grant(
            new GrantId("chain-child"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            "allow",
            capability,
            { kind: "direct" },
            parent.id
        );
        store.grantRecords.push(parent, child);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        const across = runtime.check(checkRequest(activeBinding(child), fixedPath()), new Date(10));
        expect(across.allowed).toBe(true);
        expect(across.reason).toBe("allowed");
        expect(across.decision).toBe("allow");
        expect(across.matchedAllow.map((id) => id.value)).toEqual(["chain-child", "chain-parent"]);

        const sameStore = new FakeAuthorityStore();
        sameStore.principalRecord = new Principal(principalId, "user", "active");
        const sameParent = new Grant(
            new GrantId("same-parent"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            "allow",
            capability,
            { kind: "direct" }
        );
        const sameChild = new Grant(
            new GrantId("same-child"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            "allow",
            capability,
            { kind: "direct" },
            sameParent.id
        );
        sameStore.grantRecords.push(sameParent, sameChild);
        const sameRuntime = new TenantAuthorityRuntime(sameStore, issuer);
        const within = sameRuntime.check(
            checkRequest(activeBinding(sameChild), fixedPath()),
            new Date(10)
        );
        expect(within.allowed).toBe(true);
        expect(within.matchedAllow.map((id) => id.value)).toEqual(["same-child", "same-parent"]);
    });

    test(
        "fails closed on each malformed backing lineage with the exact reason",
        { tags: "p0" },
        () => {
            const stranger = SubjectRef.principal(
                new PrincipalRef(tenantId, new PrincipalId("lineage-stranger"))
            );
            const denyParent = new Grant(
                new GrantId("lineage-deny-parent"),
                workspaceScope,
                stranger,
                "deny",
                capability,
                { kind: "direct" }
            );
            const offPathParent = new Grant(
                new GrantId("lineage-offpath-parent"),
                ScopeRef.workspace(tenantId, new WorkspaceId("lineage-elsewhere")),
                SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                "allow",
                capability,
                { kind: "direct" }
            );
            const invertedParent = new Grant(
                new GrantId("lineage-inverted-parent"),
                workspaceScope,
                SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                "allow",
                capability,
                { kind: "direct" }
            );
            const narrowParent = new Grant(
                new GrantId("lineage-narrow-parent"),
                workspaceScope,
                stranger,
                "allow",
                new CapabilitySpec({ facetPattern: "workspace:other.*", impacts: ["observe"] }),
                { kind: "direct" }
            );
            const cycleId = new GrantId("lineage-cycle");
            const cases: readonly { readonly parent?: Grant; readonly child: Grant }[] = [
                { parent: denyParent, child: attenuated("lineage-deny-child", denyParent.id) },
                {
                    parent: offPathParent,
                    child: attenuated("lineage-offpath-child", offPathParent.id)
                },
                {
                    parent: invertedParent,
                    child: new Grant(
                        new GrantId("lineage-inverted-child"),
                        ScopeRef.tenant(tenantId),
                        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                        "allow",
                        capability,
                        { kind: "direct" },
                        invertedParent.id
                    )
                },
                {
                    parent: narrowParent,
                    child: attenuated("lineage-narrow-child", narrowParent.id)
                },
                {
                    child: new Grant(
                        cycleId,
                        workspaceScope,
                        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                        "allow",
                        capability,
                        { kind: "direct" },
                        cycleId
                    )
                }
            ];
            for (const lineage of cases) {
                const store = new FakeAuthorityStore();
                store.principalRecord = new Principal(principalId, "user", "active");
                if (lineage.parent !== undefined) store.grantRecords.push(lineage.parent);
                store.grantRecords.push(lineage.child);
                const runtime = new TenantAuthorityRuntime(store, issuer);
                const result = runtime.check(
                    checkRequest(activeBinding(lineage.child), fixedPath()),
                    new Date(10)
                );
                expect(result.allowed, lineage.child.id.value).toBe(false);
                expect(result.reason, lineage.child.id.value).toBe("invalidDelegation");
            }
        }
    );

    test("excludes revoked and broken-lineage siblings from allow evidence", { tags: "p0" }, () => {
        const store = new FakeAuthorityStore();
        store.principalRecord = new Principal(principalId, "user", "active");
        const backing = directGrant("sibling-backing");
        const revokedSibling = directGrant("sibling-revoked").revoke();
        const orphanSibling = new Grant(
            new GrantId("sibling-orphan"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            "allow",
            capability,
            { kind: "direct" },
            new GrantId("sibling-ghost")
        );
        store.grantRecords.push(backing, revokedSibling, orphanSibling);
        const runtime = new TenantAuthorityRuntime(store, issuer);
        const evidence = runtime.check(
            checkRequest(activeBinding(backing), fixedPath()),
            new Date(10)
        );
        expect(evidence.allowed).toBe(true);
        expect(evidence.matchedAllow.map((id) => id.value)).toEqual([backing.id.value]);
    });

    test(
        "returns bare noMatchingAllow evidence for a backing Grant outside the Grant table",
        { tags: "p0" },
        () => {
            const store = new DetachedGrantStore();
            store.principalRecord = new Principal(principalId, "user", "active");
            const backing = directGrant("detached-backing");
            store.grantRecords.push(backing);
            const runtime = new TenantAuthorityRuntime(store, issuer);
            const evidence = runtime.check(
                checkRequest(activeBinding(backing), fixedPath()),
                new Date(10)
            );
            expect(evidence.allowed).toBe(false);
            expect(evidence.decision).toBe("deny");
            expect(evidence.reason).toBe("noMatchingAllow");
            expect(evidence.matchedAllow).toEqual([]);
            expect(evidence.matchedDeny).toEqual([]);
        }
    );

    test(
        "rejects each stale guest-grant currency branch through Binding validation",
        { tags: "p0" },
        () => {
            const home = new TenantId("currency-home");
            const guest = new PrincipalId("currency-guest");
            const subject = SubjectRef.foreign(home, guest, GuestVerificationScheme.callback);
            const message = "Binding requires a live allow Grant reaching its Workspace";
            const proofFor = (trust: GuestTrust): GuestVerification =>
                mintGuestVerification(
                    new PrincipalRef(home, guest),
                    trust.id,
                    trust.revision,
                    GuestVerificationScheme.callback,
                    Digest.sha256(Uint8Array.of(11)),
                    new Date(1),
                    new Date(100)
                );
            const makeMembership = (
                id: string,
                state: "active" | "revoked",
                proof?: GuestVerification
            ): Membership =>
                new Membership(
                    new MembershipId(id),
                    workspaceScope,
                    subject,
                    new RoleName("guest"),
                    state,
                    Revision.initial(),
                    proof
                );
            const roleGrant = (id: string, membershipId: MembershipId): Grant =>
                new Grant(new GrantId(id), workspaceScope, subject, "allow", capability, {
                    kind: "role",
                    membershipId,
                    roleName: "guest",
                    ruleOrdinal: 0,
                    guest: true
                });
            const expectStale = (
                grant: Grant,
                membership: Membership | undefined,
                trust: GuestTrust | undefined
            ): void => {
                const store = new FakeAuthorityStore();
                if (trust !== undefined) store.trustRecords.push(trust);
                if (membership !== undefined) store.membershipRecords.push(membership);
                store.grantRecords.push(grant);
                const runtime = new TenantAuthorityRuntime(store, issuer);
                expectAgentError(
                    () => runtime.validateBinding(validationRequest(grant.id), new Date(10)),
                    "authority.denied",
                    message
                );
            };

            const callbackTrust = new GuestTrust(
                new GuestTrustId("currency-trust-callback"),
                tenantId,
                home,
                { kind: "callback", endpoint: "https://currency.example/verify" },
                "active",
                Revision.initial()
            );
            const nonGuestMembership = makeMembership(
                "currency-member-nonguest",
                "active",
                proofFor(callbackTrust)
            );
            expectStale(
                new Grant(
                    new GrantId("currency-grant-nonguest"),
                    workspaceScope,
                    subject,
                    "allow",
                    capability,
                    {
                        kind: "role",
                        membershipId: nonGuestMembership.id,
                        roleName: "guest",
                        ruleOrdinal: 0,
                        guest: false
                    }
                ),
                nonGuestMembership,
                callbackTrust
            );
            expectStale(
                roleGrant("currency-grant-ghost", new MembershipId("currency-ghost")),
                undefined,
                callbackTrust
            );
            const revokedMembership = makeMembership(
                "currency-member-revoked",
                "revoked",
                proofFor(callbackTrust)
            );
            expectStale(
                roleGrant("currency-grant-revoked", revokedMembership.id),
                revokedMembership,
                callbackTrust
            );
            const unverifiedMembership = makeMembership("currency-member-unverified", "active");
            expectStale(
                roleGrant("currency-grant-unverified", unverifiedMembership.id),
                unverifiedMembership,
                callbackTrust
            );
            const tokenTrust = new GuestTrust(
                new GuestTrustId("currency-trust-token"),
                tenantId,
                home,
                {
                    kind: "token",
                    issuer: "currency-issuer",
                    key: new SecretRef("env", "host", "currency-key")
                },
                "active",
                Revision.initial()
            );
            const mismatchedMembership = makeMembership(
                "currency-member-mismatched",
                "active",
                proofFor(tokenTrust)
            );
            expectStale(
                roleGrant("currency-grant-mismatched", mismatchedMembership.id),
                mismatchedMembership,
                tokenTrust
            );
        }
    );

    // Both stores refuse to hold these two records: the Memory store re-derives the
    // Binding-to-Grant closure on every commit, and createBinding refuses them before that.
    // The runtime nonetheless reads its Grants and Bindings through an injected store and
    // does not trust what comes back, which is why missingGrant is in the decision
    // taxonomy at all. Planting the record at that seam is the only way to reach either
    // branch, and both are decisions an operator has to be able to tell apart.
    test("reports a Binding whose backing Grant is absent from the store", { tags: "p0" }, () => {
        const store = new PlantedBindingStore();
        store.principalRecord = new Principal(principalId, "user", "active");
        const present = directGrant("planted-present");
        store.grantRecords.push(present);
        const planted = activeBinding(present, { grantId: new GrantId("planted-absent") });
        store.bindingRecords.push(planted);
        const runtime = new TenantAuthorityRuntime(store, issuer);

        const evidence = runtime.check(checkRequest(planted, fixedPath()), new Date(10));

        expect(evidence.reason).toBe("missingGrant");
        expect(evidence.decision).toBe("deny");
        expect(evidence.matchedAllow).toEqual([]);
    });

    test(
        "refuses a Binding held by a subject its backing Grant does not name",
        { tags: "p0" },
        () => {
            const store = new PlantedBindingStore();
            store.principalRecord = new Principal(principalId, "user", "active");
            const teamId = new TeamId("planted-team");
            store.teamRecords.push(
                new Team(teamId, tenantId, "Planted", [principalId], Revision.initial())
            );
            const teamGrant = new Grant(
                new GrantId("planted-team-grant"),
                workspaceScope,
                SubjectRef.team(teamId),
                "allow",
                capability,
                { kind: "direct" }
            );
            store.grantRecords.push(teamGrant);
            // The Team Grant is within the principal's effective subjects, so it survives the
            // relevance filter and would carry the decision on its own. Only the comparison
            // against the Binding's own subject separates the two.
            const planted = activeBinding(teamGrant, {
                subject: SubjectRef.principal(new PrincipalRef(tenantId, principalId))
            });
            store.bindingRecords.push(planted);
            const runtime = new TenantAuthorityRuntime(store, issuer);

            const evidence = runtime.check(checkRequest(planted, fixedPath()), new Date(10));

            expect(evidence.reason).toBe("noMatchingAllow");
            expect(evidence.decision).toBe("deny");
            expect(evidence.matchedAllow).toEqual([]);
        }
    );
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
    public binding(key: string): Binding | undefined {
        return this.grantRecords
            .map((grant) => activeBinding(grant))
            .find((record) => record.key === key);
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

class DetachedGrantStore extends FakeAuthorityStore {
    public override grants(): readonly Grant[] {
        return [];
    }
}

/** Serves Binding records that no store would accept, so the runtime meets them anyway. */
class PlantedBindingStore extends FakeAuthorityStore {
    public readonly bindingRecords: Binding[] = [];

    public override binding(key: string): Binding | undefined {
        return this.bindingRecords.find((record) => record.key === key) ?? super.binding(key);
    }
}

function fixedPath(): PathEpochEvidence {
    return new PathEpochEvidence([
        new ScopeEpoch(ScopeRef.tenant(tenantId), 1),
        new ScopeEpoch(workspaceScope, 2)
    ]);
}

function attenuated(id: string, parent: GrantId): Grant {
    return new Grant(
        new GrantId(id),
        workspaceScope,
        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
        "allow",
        capability,
        { kind: "direct" },
        parent
    );
}

function expectAgentError(action: () => void, code: AgentCoreErrorCode, message: string): void {
    try {
        action();
        throw new Error("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code, message });
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
        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
        effect,
        capability,
        { kind: "direct" }
    );
}

// FakeAuthorityStore recovers a grant's Binding by recomputing its name and matching the
// resulting key, so the name has to stay distinct per grant. Spelling the GrantId straight
// into it stopped working once §3.4's canonical segment form was enforced: `GrantId.forRole`
// mints `role:<digest>`, and a colon is the FacetRef separator, which one segment never
// admits. The name is therefore derived from the id rather than being the id.
function bindingNameFor(grantId: GrantId): BindingName {
    const segment = grantId.value.replaceAll(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    return new BindingName(`binding-${segment}`);
}

function activeBinding(
    grant: Grant,
    overrides: { grantId?: GrantId; subject?: Grant["subject"]; facet?: FacetRef } = {}
): Binding {
    return Binding.active(
        workspaceScope,
        overrides.subject ?? grant.subject,
        domain,
        bindingNameFor(grant.id),
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
    overrides: {
        principal?: PrincipalRef;
        impact?: "observe" | "delegate" | "administer";
    } = {}
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

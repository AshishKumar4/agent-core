import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, SecretRef, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    GuestVerificationScheme,
    Membership,
    MembershipId,
    Principal,
    PrincipalId,
    Role,
    RoleName,
    ScopeRef,
    SubjectRef,
    Team,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import {
    GuestTrust,
    GuestTrustId,
    type GuestVerification,
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
import { RoleGrantMaterializer } from "../../src/authority/materializer";
import { TenantAuthorityRuntime, type TenantAuthorityReadStore } from "../../src/authority/runtime";

/*
 * The TypeScript half of AC-AUTH-001's guest clause: guest Grant origin provenance, and
 * Membership/GuestTrust verification currency. The abstract ledger carries neither — its
 * verification fact has no time index (AC-MATERIALIZE-001) and its Grants carry no origin —
 * so both are enforced here or nowhere.
 *
 * Provenance is written once, by src/authority/materializer.ts#materializeActive, and read on
 * every resolution by src/authority/runtime.ts#TenantAuthorityRuntime: a foreign subject's
 * Grant is admitted only through the Membership its own origin names, and that Membership's
 * verification and the GuestTrust behind it must both still be current at the instant of the
 * check. The currency predicate is a conjunction, so the table below flips exactly one
 * conjunct per case against one shared allowed baseline; a conjunct that stopped being
 * load-bearing would turn its own case green and nothing else.
 */

const tenantId = new TenantId("guest-currency-tenant");
const homeTenant = new TenantId("guest-currency-home");
const foreignHomeTenant = new TenantId("guest-currency-other-home");
const workspace = new Workspace(
    new WorkspaceId("guest-currency-workspace"),
    tenantId,
    undefined,
    Revision.initial()
);
const workspaceScope = workspace.scope;
const guestPrincipalId = new PrincipalId("guest-currency-guest");
const guestPrincipal = new PrincipalRef(homeTenant, guestPrincipalId);
const guestSubject = SubjectRef.foreign(
    homeTenant,
    guestPrincipalId,
    GuestVerificationScheme.callback
);
const issuer = new ActorRef("tenant", new ActorId("guest-currency-issuer"));
const owner = new ActorRef("workspace", new ActorId("guest-currency-owner"));
const domain = new ProtectionDomain("backend", "guest-currency", "no-secrets");
const facet = new FacetRef("workspace:guest.currency");
const capability = new CapabilitySpec({
    facetPattern: "workspace:guest.*",
    impacts: ["observe"]
});
const elevating = new CapabilitySpec({
    facetPattern: "workspace:guest.*",
    impacts: ["delegate"]
});
const args = { value: true } as const;
const argsDigest = Digest.sha256(encodeCanonicalJson(args));
const roleName = new RoleName("guest-currency-role");
const membershipId = new MembershipId("guest-currency-member");

const currentTrust = new GuestTrust(
    new GuestTrustId("guest-currency-trust"),
    tenantId,
    homeTenant,
    { kind: "callback", endpoint: "https://guest-currency.example/verify" },
    "active",
    Revision.initial()
);

function verification(
    overrides: {
        readonly trust?: GuestTrust;
        readonly scheme?: GuestVerificationScheme;
        readonly expiresAt?: number;
    } = {}
): GuestVerification {
    const trust = overrides.trust ?? currentTrust;
    return mintGuestVerification(
        guestPrincipal,
        trust.id,
        trust.revision,
        overrides.scheme ?? GuestVerificationScheme.callback,
        Digest.sha256(Uint8Array.of(7)),
        new Date(1),
        new Date(overrides.expiresAt ?? 100)
    );
}

function membership(
    overrides: {
        readonly id?: MembershipId;
        readonly state?: "active" | "revoked";
        readonly proof?: GuestVerification | undefined;
        readonly subject?: SubjectRef;
    } = {}
): Membership {
    return new Membership(
        overrides.id ?? membershipId,
        workspaceScope,
        overrides.subject ?? guestSubject,
        roleName,
        overrides.state ?? "active",
        Revision.initial(),
        "proof" in overrides ? overrides.proof : verification()
    );
}

function guestGrant(
    overrides: {
        readonly id?: GrantId;
        readonly membership?: MembershipId;
        readonly guest?: boolean;
        readonly capability?: CapabilitySpec;
    } = {}
): Grant {
    const named = overrides.membership ?? membershipId;
    return new Grant(
        overrides.id ?? GrantId.forRole(named, 0),
        workspaceScope,
        guestSubject,
        "allow",
        overrides.capability ?? capability,
        {
            kind: "role",
            membershipId: named,
            roleName: roleName.value,
            ruleOrdinal: 0,
            guest: overrides.guest ?? true
        }
    );
}

describe("guest Grant provenance", () => {
    test(
        "[AC-AUTH-001] materialization stamps every Grant with the Membership and rule it came from",
        { tags: "p0" },
        () => {
            const role = new Role(roleName, [
                { effect: "allow", capability },
                { effect: "deny", capability: elevating }
            ]);
            const materialized = new RoleGrantMaterializer().materialize({
                membership: membership(),
                role,
                existing: []
            });

            expect(materialized.changedRecords).toHaveLength(2);
            materialized.changedRecords.forEach((grant, ruleOrdinal) => {
                expect(grant.origin).toStrictEqual({
                    kind: "role",
                    membershipId,
                    roleName: roleName.value,
                    ruleOrdinal,
                    guest: true
                });
                // The origin is durable and immutable: it survives its own codec and a
                // revocation, so a resolution reads what materialization wrote.
                expect(Grant.decode(Grant.encode(grant)).origin).toStrictEqual(grant.origin);
                expect(grant.revoke().origin).toStrictEqual(grant.origin);
            });
        }
    );

    test(
        "[AC-AUTH-001] a local Membership's Grants are stamped as no guest's",
        { tags: "p0" },
        () => {
            const localSubject = SubjectRef.principal(
                new PrincipalRef(tenantId, new PrincipalId("guest-currency-local"))
            );
            const role = new Role(roleName, [{ effect: "allow", capability: elevating }]);
            const materialized = new RoleGrantMaterializer().materialize({
                membership: membership({ subject: localSubject, proof: undefined }),
                role,
                existing: []
            });

            expect(materialized.changedRecords).toHaveLength(1);
            expect(materialized.changedRecords[0]?.origin).toMatchObject({ guest: false });
        }
    );

    test(
        "[AC-AUTH-001] a resolution follows the Membership the origin names, not the subject",
        { tags: "p0" },
        () => {
            // A current, verified Membership for exactly this subject exists in the store, and
            // the Grant's origin names a different one. Reading currency off the subject rather
            // than off the provenance would admit this.
            const store = new FakeAuthorityStore();
            store.membershipRecords.push(membership());
            store.trustRecords.push(currentTrust);
            const strayGrant = guestGrant({
                id: new GrantId("guest-currency-stray"),
                membership: new MembershipId("guest-currency-stray-member")
            });
            store.grantRecords.push(strayGrant);
            const runtime = new TenantAuthorityRuntime(store, issuer);

            expect(runtime.check(checkRequest(strayGrant), new Date(10)).reason).toBe(
                "guestVerificationExpired"
            );
            expect(() =>
                runtime.validateBinding(validationRequest(strayGrant.id), new Date(10))
            ).toThrow(AgentCoreError);
        }
    );
});

describe("guest verification currency", () => {
    const revokedTrust = new GuestTrust(
        currentTrust.id,
        tenantId,
        homeTenant,
        currentTrust.verifier,
        "revoked",
        currentTrust.revision
    );
    const foreignTrust = new GuestTrust(
        currentTrust.id,
        tenantId,
        foreignHomeTenant,
        currentTrust.verifier,
        "active",
        currentTrust.revision
    );
    const tokenTrust = new GuestTrust(
        currentTrust.id,
        tenantId,
        homeTenant,
        {
            kind: "token",
            issuer: "guest-currency-issuer",
            key: new SecretRef("env", "guest-currency-host", "guest-currency-key")
        },
        "active",
        currentTrust.revision
    );

    const cases: readonly {
        readonly name: string;
        readonly membership: Membership;
        readonly trust: GuestTrust;
        readonly at: number;
        readonly allowed: boolean;
    }[] = [
        {
            name: "the current baseline",
            membership: membership(),
            trust: currentTrust,
            at: 10,
            allowed: true
        },
        {
            name: "a revoked GuestTrust",
            membership: membership(),
            trust: revokedTrust,
            at: 10,
            allowed: false
        },
        {
            name: "a rotated GuestTrust past the pinned revision",
            membership: membership(),
            trust: currentTrust.rotate({
                kind: "callback",
                endpoint: "https://guest-currency.example/rotated"
            }),
            at: 10,
            allowed: false
        },
        {
            name: "a GuestTrust for another home Tenant",
            membership: membership(),
            trust: foreignTrust,
            at: 10,
            allowed: false
        },
        {
            name: "a GuestTrust whose verifier is not the scheme the guest was verified by",
            membership: membership(),
            trust: tokenTrust,
            at: 10,
            allowed: false
        },
        {
            name: "a verification read at its exact expiry",
            membership: membership(),
            trust: currentTrust,
            at: 100,
            allowed: false
        },
        {
            name: "a verification read before it was minted",
            membership: membership(),
            trust: currentTrust,
            at: 0,
            allowed: false
        },
        {
            name: "a revoked Membership",
            membership: membership({ state: "revoked" }),
            trust: currentTrust,
            at: 10,
            allowed: false
        },
        {
            name: "a Membership carrying no verification at all",
            membership: membership({ proof: undefined }),
            trust: currentTrust,
            at: 10,
            allowed: false
        }
    ];

    test(
        "[AC-AUTH-001] every conjunct of guest currency denies a resolution on its own",
        { tags: "p0" },
        () => {
            for (const scenario of cases) {
                const store = new FakeAuthorityStore();
                store.membershipRecords.push(scenario.membership);
                store.trustRecords.push(scenario.trust);
                const grant = guestGrant();
                store.grantRecords.push(grant);
                const runtime = new TenantAuthorityRuntime(store, issuer);

                const evidence = runtime.check(checkRequest(grant), new Date(scenario.at));

                expect(evidence.allowed, scenario.name).toBe(scenario.allowed);
                if (scenario.allowed) {
                    expect(evidence.reason, scenario.name).toBe("allowed");
                    expect(
                        evidence.matchedAllow.map((id) => id.value),
                        scenario.name
                    ).toStrictEqual([grant.id.value]);
                } else {
                    expect(evidence.reason, scenario.name).toBe("guestVerificationExpired");
                    expect(evidence.matchedAllow, scenario.name).toStrictEqual([]);
                }
            }
        }
    );

    test(
        "[AC-AUTH-001] a stale guest Grant is excluded from the allow set, not only from the backing",
        { tags: "p0" },
        () => {
            const store = new FakeAuthorityStore();
            const staleMembership = membership({
                id: new MembershipId("guest-currency-stale-member"),
                proof: verification({ expiresAt: 5 })
            });
            store.membershipRecords.push(membership(), staleMembership);
            store.trustRecords.push(currentTrust);
            const current = guestGrant();
            const stale = guestGrant({
                id: GrantId.forRole(staleMembership.id, 0),
                membership: staleMembership.id
            });
            store.grantRecords.push(current, stale);
            const runtime = new TenantAuthorityRuntime(store, issuer);

            const evidence = runtime.check(checkRequest(current), new Date(10));

            expect(evidence.allowed).toBe(true);
            expect(evidence.matchedAllow.map((id) => id.value)).toStrictEqual([current.id.value]);
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

function bindingNameFor(grantId: GrantId): BindingName {
    const segment = grantId.value.replaceAll(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    return new BindingName(`binding-${segment}`);
}

function activeBinding(grant: Grant): Binding {
    return Binding.active(
        workspaceScope,
        grant.subject,
        domain,
        bindingNameFor(grant.id),
        grant.id,
        facet
    );
}

function validationRequest(grantId: GrantId): BindingValidationRequest {
    return new BindingValidationRequest({
        ownerTenant: tenantId,
        workspaceActor: owner,
        workspaceFence: 1,
        scope: workspaceScope,
        domain,
        name: new BindingName("guest-currency"),
        grantId,
        facet,
        nonce: `validate-${grantId.value}`
    });
}

function checkRequest(grant: Grant): AuthorityCheckRequest {
    return new AuthorityCheckRequest({
        ownerTenant: tenantId,
        owner,
        ownerFence: 1,
        principal: guestPrincipal,
        binding: activeBinding(grant),
        intent: {
            facet,
            operation: "read",
            impact: "observe",
            arguments: args,
            argumentsDigest: argsDigest
        },
        expectedPath: new PathEpochEvidence([
            new ScopeEpoch(ScopeRef.tenant(tenantId), 1),
            new ScopeEpoch(workspaceScope, 2)
        ]),
        invocationDigest: Digest.sha256(Uint8Array.of(4)),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: `check-${grant.id.value}`
    });
}

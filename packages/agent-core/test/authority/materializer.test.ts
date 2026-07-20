import { describe, expect, test } from "vitest";
import { Digest, Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { CapabilitySpec } from "../../src/facets";
import {
    GuestVerificationScheme,
    Membership,
    MembershipId,
    Role,
    RoleName,
    RoleRule,
    SubjectRef,
    type SubjectRef as SubjectReference
} from "../../src/identity";
import { GuestTrustId, GuestVerification, PrincipalRef } from "../identity/internal-fixture";
import {
    EpochPlanner,
    Grant,
    GrantId,
    RoleGrantMaterializer,
    ScopeEpoch
} from "../../src/authority";
import {
    otherPrincipalId,
    principal,
    projectScope,
    tenantId,
    tenantScope,
    workspaceScope
} from "./fixture";

function role(name: string, rules: readonly RoleRule[]): Role {
    return new Role(new RoleName(name), rules);
}

function membership(assignedRole: Role, subject: SubjectReference = principal): Membership {
    return new Membership(
        new MembershipId("membership-authority"),
        workspaceScope,
        subject,
        assignedRole.name,
        "active",
        Revision.initial()
    );
}

describe("RoleGrantMaterializer", () => {
    test("uses stable role Grant IDs and is an exact semantic no-op", () => {
        const assignedRole = role("reader-custom", [
            new RoleRule(
                "allow",
                new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] })
            ),
            new RoleRule(
                "deny",
                new CapabilitySpec({ facetPattern: "workspace:mail.secret", impacts: ["observe"] })
            )
        ]);
        const member = membership(assignedRole);
        const materializer = new RoleGrantMaterializer();
        const first = materializer.materialize({
            membership: member,
            role: assignedRole,
            existing: []
        });
        const second = materializer.materialize({
            membership: member,
            role: assignedRole,
            existing: first.desiredRecords
        });

        expect(first.desiredRecords.map((grant) => grant.id.value)).toEqual([
            GrantId.forRole(member.id, 0).value,
            GrantId.forRole(member.id, 1).value
        ]);
        expect(first.affectedScopes).toEqual([workspaceScope]);
        expect(second.semanticNoop).toBe(true);
        expect(second.affectedScopes).toEqual([]);
    });

    test("reconciles changed and obsolete rules without adding authority", () => {
        const original = role("custom", [
            new RoleRule(
                "allow",
                new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] })
            ),
            new RoleRule(
                "allow",
                new CapabilitySpec({ facetPattern: "workspace:files.*", impacts: ["observe"] })
            )
        ]);
        const revised = role("custom", [
            new RoleRule(
                "deny",
                new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] })
            )
        ]);
        const member = membership(original);
        const materializer = new RoleGrantMaterializer();
        const before = materializer.materialize({
            membership: member,
            role: original,
            existing: []
        });
        const after = materializer.materialize({
            membership: membership(revised),
            role: revised,
            existing: before.desiredRecords
        });

        expect(after.desiredRecords).toHaveLength(2);
        expect(after.desiredRecords[0]!.effect).toBe("deny");
        expect(after.desiredRecords[1]!.state.name).toBe("revoked");
        expect(after.affectedScopes).toEqual([workspaceScope]);
    });

    test.each([GuestVerificationScheme.token, GuestVerificationScheme.callback])(
        "materializes no Grants for unverified %s guests",
        (scheme) => {
            const guest = SubjectRef.foreign(tenantId, otherPrincipalId, scheme);
            const assignedRole = role("guest-role", [
                new RoleRule(
                    "allow",
                    new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] })
                ),
                new RoleRule(
                    "allow",
                    new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["delegate"] })
                ),
                new RoleRule(
                    "deny",
                    new CapabilitySpec({
                        facetPattern: "workspace:mail.secret",
                        impacts: ["administer"]
                    })
                )
            ]);
            const member = membership(assignedRole, guest);
            const materialization = new RoleGrantMaterializer().materialize({
                membership: member,
                role: assignedRole,
                existing: []
            });

            expect(materialization.desiredRecords).toEqual([]);
        }
    );

    test("[C13-AUTH-GUEST-SUBJECT] materializes verified guest allows and denies while removing elevated allows", () => {
        const guest = SubjectRef.foreign(tenantId, otherPrincipalId, GuestVerificationScheme.token);
        const assignedRole = role("verified-guest", [
            new RoleRule(
                "allow",
                new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] })
            ),
            new RoleRule(
                "allow",
                new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["delegate"] })
            ),
            new RoleRule(
                "deny",
                new CapabilitySpec({
                    facetPattern: "workspace:mail.secret",
                    impacts: ["administer"]
                })
            )
        ]);
        const verifiedAt = new Date(1_000);
        const verification = new GuestVerification(
            new PrincipalRef(tenantId, otherPrincipalId),
            new GuestTrustId("guest-trust"),
            Revision.initial(),
            "token",
            Digest.sha256(Uint8Array.of(1)),
            verifiedAt,
            new Date(2_000)
        );
        const result = new RoleGrantMaterializer().materialize({
            membership: membership(assignedRole, guest).withGuestVerification(verification),
            role: assignedRole,
            existing: []
        });

        expect(
            result.desiredRecords
                .map((grant) => [grant.effect, grant.capability.impacts])
                .sort(([left], [right]) => String(left).localeCompare(String(right)))
        ).toEqual([
            ["allow", ["observe"]],
            ["deny", ["administer"]]
        ]);
        expect(
            result.desiredRecords.every(
                (grant) => grant.origin.kind === "role" && grant.origin.guest
            )
        ).toBe(true);
    });

    test("revokes every stale guest Grant without inventing verification", () => {
        const guest = SubjectRef.foreign(tenantId, otherPrincipalId, GuestVerificationScheme.token);
        const assignedRole = role("guest-reconciled", [
            new RoleRule(
                "allow",
                new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] })
            ),
            new RoleRule(
                "deny",
                new CapabilitySpec({ facetPattern: "workspace:mail.secret", impacts: ["observe"] })
            )
        ]);
        const member = membership(assignedRole, guest);
        const existing = [0, 1].map(
            (ruleOrdinal) =>
                new Grant(
                    GrantId.forRole(member.id, ruleOrdinal),
                    member.scope,
                    member.subject,
                    "allow",
                    new CapabilitySpec({
                        facetPattern: "workspace:legacy.*",
                        impacts: ["observe"]
                    }),
                    {
                        kind: "role",
                        membershipId: member.id,
                        roleName: "legacy-guest-role",
                        ruleOrdinal,
                        guest: true
                    }
                )
        );

        const materialization = new RoleGrantMaterializer().materialize({
            membership: member,
            role: assignedRole,
            existing
        });

        expect(
            materialization.desiredRecords.map((grant) => ({
                id: grant.id.value,
                effect: grant.effect,
                state: grant.state.name,
                origin: grant.origin
            }))
        ).toEqual([
            {
                id: GrantId.forRole(member.id, 0).value,
                effect: "allow",
                state: "revoked",
                origin: {
                    kind: "role",
                    membershipId: member.id,
                    roleName: "legacy-guest-role",
                    ruleOrdinal: 0,
                    guest: true
                }
            },
            {
                id: GrantId.forRole(member.id, 1).value,
                effect: "allow",
                state: "revoked",
                origin: {
                    kind: "role",
                    membershipId: member.id,
                    roleName: "legacy-guest-role",
                    ruleOrdinal: 1,
                    guest: true
                }
            }
        ]);
    });

    test("rejects handshake as a steady-state guest verification scheme", () => {
        const guest = SubjectRef.foreign(
            tenantId,
            otherPrincipalId,
            GuestVerificationScheme.handshake
        );
        const assignedRole = role("handshake-role", [
            new RoleRule(
                "allow",
                new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] })
            )
        ]);

        expect(() =>
            new RoleGrantMaterializer().materialize({
                membership: membership(assignedRole, guest),
                role: assignedRole,
                existing: []
            })
        ).toThrow("Handshake is a guest bootstrap scheme");
    });
});

describe("EpochPlanner", () => {
    test("enumerates every resolver-input mutation and bumps each Scope once", () => {
        const mutations: Parameters<EpochPlanner["plan"]>[1] = [
            { kind: "grant", scope: workspaceScope },
            { kind: "membership", affectedScopes: [workspaceScope] },
            { kind: "role", affectedScopes: [workspaceScope] },
            { kind: "teamClosure", affectedScopes: [workspaceScope] },
            { kind: "principalClosure", affectedScopes: [workspaceScope] },
            { kind: "guestVerification", affectedScopes: [workspaceScope] },
            { kind: "topology", affectedScopes: [projectScope, workspaceScope] },
            { kind: "lifecycle", affectedScopes: [workspaceScope] },
            { kind: "policy", affectedScopes: [tenantScope, workspaceScope] },
            { kind: "trust", affectedScopes: [workspaceScope] },
            { kind: "bindingTransition", affectedScopes: [workspaceScope] }
        ];
        const plan = new EpochPlanner().plan(
            [
                new ScopeEpoch(tenantScope, 5),
                new ScopeEpoch(projectScope, 6),
                new ScopeEpoch(workspaceScope, 7)
            ],
            mutations
        );

        expect(plan.bumped.map((entry) => [entry.scope.kind, entry.epoch])).toEqual([
            ["project", 7],
            ["tenant", 6],
            ["workspace", 8]
        ]);
    });

    test("preflights overflow before producing any partial plan", () => {
        expect(() =>
            new EpochPlanner().plan(
                [
                    new ScopeEpoch(tenantScope, 2),
                    new ScopeEpoch(workspaceScope, Number.MAX_SAFE_INTEGER)
                ],
                [{ kind: "policy", affectedScopes: [tenantScope, workspaceScope] }]
            )
        ).toThrow(AgentCoreError);
    });
});

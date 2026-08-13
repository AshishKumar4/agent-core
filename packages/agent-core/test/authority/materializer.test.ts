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
    ScopeEpoch,
    scopeKey
} from "../../src/authority";
import { EpochPlan } from "../../src/authority/planner";
import { RoleGrantMaterialization } from "../../src/authority/materializer";
import {
    allowGrant,
    capability,
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
    test("uses stable role Grant IDs and is an exact semantic no-op", { tags: "p0" }, () => {
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

    test("reconciles changed and obsolete rules without adding authority", { tags: "p0" }, () => {
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
        { tags: "p0" },
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

    test(
        "[C13-AUTH-GUEST-SUBJECT] materializes verified guest allows and denies while removing elevated allows",
        { tags: "p0" },
        () => {
            const guest = SubjectRef.foreign(
                tenantId,
                otherPrincipalId,
                GuestVerificationScheme.token
            );
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
                GuestVerificationScheme.token,
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
        }
    );

    test("revokes every stale guest Grant without inventing verification", { tags: "p0" }, () => {
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

    test(
        "[C13-AUTH-ROLE-MATERIALIZATION] canonicalizes desired and changed records into Grant ID order",
        { tags: "p0" },
        () => {
            const assignedRole = role("ordered-role", [
                new RoleRule(
                    "allow",
                    new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] })
                ),
                new RoleRule(
                    "allow",
                    new CapabilitySpec({ facetPattern: "workspace:files.*", impacts: ["observe"] })
                )
            ]);
            const member = new Membership(
                new MembershipId("mutation-member"),
                workspaceScope,
                principal,
                assignedRole.name,
                "active",
                Revision.initial()
            );
            const result = new RoleGrantMaterializer().materialize({
                membership: member,
                role: assignedRole,
                existing: []
            });
            const ruleZero = GrantId.forRole(member.id, 0).value;
            const ruleOne = GrantId.forRole(member.id, 1).value;
            expect(ruleOne.localeCompare(ruleZero)).toBeLessThan(0);
            expect(result.desiredRecords.map((grant) => grant.id.value)).toEqual([
                ruleOne,
                ruleZero
            ]);
            expect(result.changedRecords.map((grant) => grant.id.value)).toEqual([
                ruleOne,
                ruleZero
            ]);
            expect(result.semanticNoop).toBe(false);
        }
    );

    test(
        "[C13-AUTH-ROLE-MATERIALIZATION] reconciles only Membership-owned role Grants and orders affected Scopes",
        { tags: "p0" },
        () => {
            const assignedRole = role("owned-role", [new RoleRule("allow", capability())]);
            const member = new Membership(
                new MembershipId("membership-authority"),
                workspaceScope,
                principal,
                assignedRole.name,
                "active",
                Revision.initial()
            );
            const foreignMembership = new MembershipId("membership-foreign");
            const direct = allowGrant("direct-existing");
            const foreign = new Grant(
                GrantId.forRole(foreignMembership, 0),
                workspaceScope,
                principal,
                "allow",
                capability(),
                {
                    kind: "role",
                    membershipId: foreignMembership,
                    roleName: "owned-role",
                    ruleOrdinal: 0,
                    guest: false
                }
            );
            const stale = new Grant(
                GrantId.forRole(member.id, 7),
                projectScope,
                principal,
                "allow",
                capability(["observe"], "workspace:legacy.*"),
                {
                    kind: "role",
                    membershipId: member.id,
                    roleName: "stale-role",
                    ruleOrdinal: 7,
                    guest: false
                }
            );
            const result = new RoleGrantMaterializer().materialize({
                membership: member,
                role: assignedRole,
                existing: [direct, foreign, stale]
            });
            const activeId = GrantId.forRole(member.id, 0).value;
            const staleId = GrantId.forRole(member.id, 7).value;
            expect(result.desiredRecords.map((grant) => grant.id.value)).toEqual(
                [activeId, staleId].sort((left, right) => left.localeCompare(right))
            );
            expect(
                result.desiredRecords.find((grant) => grant.id.value === activeId)?.state.name
            ).toBe("active");
            expect(
                result.desiredRecords.find((grant) => grant.id.value === staleId)?.state.name
            ).toBe("revoked");
            expect(result.changedRecords).toHaveLength(2);
            expect(result.semanticNoop).toBe(false);
            expect(result.affectedScopes.map((scope) => scope.kind)).toEqual([
                "project",
                "workspace"
            ]);
        }
    );

    test("rejects handshake as a steady-state guest verification scheme", { tags: "p0" }, () => {
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
    test(
        "enumerates every resolver-input mutation and bumps each Scope once",
        { tags: "p0" },
        () => {
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
        }
    );

    test("plans the complete next epoch set with canonical affected Scopes", { tags: "p0" }, () => {
        const plan = new EpochPlanner().plan(
            [new ScopeEpoch(tenantScope, 5), new ScopeEpoch(projectScope, 6)],
            [
                { kind: "grant", scope: workspaceScope },
                { kind: "membership", affectedScopes: [projectScope] }
            ]
        );
        expect(plan.affectedScopes.map((scope) => scope.kind)).toEqual(["project", "workspace"]);
        expect(plan.bumped.map((entry) => [entry.scope.kind, entry.epoch])).toEqual([
            ["project", 7],
            ["workspace", 1]
        ]);
        expect(plan.next.map((entry) => [entry.scope.kind, entry.epoch])).toEqual([
            ["project", 7],
            ["tenant", 5],
            ["workspace", 1]
        ]);
    });

    test("refuses to plan past an exhausted Scope epoch", { tags: "p0" }, () => {
        expect(() =>
            new EpochPlanner().plan(
                [
                    new ScopeEpoch(tenantScope, 2),
                    new ScopeEpoch(workspaceScope, Number.MAX_SAFE_INTEGER)
                ],
                [{ kind: "policy", affectedScopes: [tenantScope, workspaceScope] }]
            )
        ).toThrow(`Authority epoch is exhausted for ${scopeKey(workspaceScope)}`);
    });

    // EpochPlan is the planner's result type and canonicalises what it is handed. The
    // planner cannot hand it a repeated Scope — it builds both lists from a Map keyed by
    // scopeKey — so the guard answers for every other caller of the constructor.
    test("refuses an epoch plan that names one Scope twice", { tags: "p0" }, () => {
        expectAgentError(
            () =>
                new EpochPlan([new ScopeEpoch(tenantScope, 1), new ScopeEpoch(tenantScope, 2)], []),
            "Epoch plan Scopes must be unique"
        );
        expectAgentError(
            () =>
                new EpochPlan([], [new ScopeEpoch(tenantScope, 1), new ScopeEpoch(tenantScope, 1)]),
            "Epoch plan Scopes must be unique"
        );
    });
});

describe("RoleGrantMaterialization", () => {
    // The materializer builds desiredRecords from one Grant ID per Role rule plus the
    // owned records those ids exclude, so it cannot repeat one. The constructor is what
    // holds every other caller to the same rule.
    test("refuses a materialization that names one Grant twice", { tags: "p0" }, () => {
        const duplicate = allowGrant("materialization-duplicate");
        expectAgentError(
            () => new RoleGrantMaterialization([duplicate, duplicate], [], []),
            "Role materialization output Grant IDs must be unique"
        );
        expectAgentError(
            () => new RoleGrantMaterialization([], [duplicate, duplicate], []),
            "Role materialization output Grant IDs must be unique"
        );
    });
});

function expectAgentError(action: () => void, message: string): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentCoreError);
    expect(thrown).toMatchObject({ code: "protocol.invalid-state", message });
}

import { describe, expect, test } from "vitest";
import { ActorId } from "../../src/actors";
import { AuthorityMutationService, Grant, GrantId, PathEpochEvidence } from "../../src/authority";
import { CapabilitySpec } from "../../src/facets";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { createTenantControlBootstrapPlan } from "../../src/authority/service";
import { Digest, Revision, decodeCanonicalJson, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    GuestTrust,
    GuestTrustId,
    GuestVerificationScheme,
    Membership,
    MembershipId,
    MemoryIdentityRepository,
    Principal,
    PrincipalId,
    PrincipalRef,
    Project,
    Role,
    RoleName,
    RoleRule,
    SubjectRef,
    Team,
    TeamId,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { GuestVerification } from "../identity/internal-fixture";
import { Workspace } from "../identity/internal-fixture";
import { allowGrant, principalId, tenantId, workspaceScope } from "./fixture";

const anchor = Object.freeze({
    actorId: new ActorId("tenant-memory-actor"),
    tenantId,
    principalId,
    trustAnchor: Uint8Array.of(1, 2, 3)
});

describe("MemoryTenantControlStore", () => {
    test("[authority.grant] [authority.scope-epoch] [authority.binding] [authority.invalidation-watermark] bootstraps and restores the complete detached Tenant control snapshot", () => {
        const store = bootstrappedStore();
        const service = new AuthorityMutationService(store);
        const role = observeRole("memory-reader");
        const member = new Membership(
            new MembershipId("memory-member"),
            workspaceScope,
            SubjectRef.principal(principalId),
            role.name,
            "active",
            Revision.initial()
        );
        service.createRole(role);
        service.assignMembership(member);

        const snapshot = store.snapshot();
        const restarted = MemoryTenantControlStore.restore(snapshot);
        const identities = new MemoryIdentityRepository(restarted.identitySnapshot());
        snapshot.identity.records[0]!.bytes.fill(0);
        snapshot.grants[0]!.bytes.fill(0);
        snapshot.anchor.trustAnchor.fill(0);

        expect(Object.keys(snapshot).sort()).toEqual([
            "anchor",
            "epochs",
            "grants",
            "identity",
            "marker",
            "version"
        ]);
        expect(restarted.bootstrapMarker()?.ownerPrincipalId.equals(principalId)).toBe(true);
        expect(identities.loadMembership(member.id)?.role.equals(role.name)).toBe(true);
        expect(restarted.grants()).toHaveLength(2);
        expect(restarted.epoch(workspaceScope).epoch).toBe(2);
        expect(store.bootstrapAnchor().trustAnchor).toEqual(Uint8Array.of(1, 2, 3));
    });

    test("rejects unknown versions, extra fields, and codec-key disagreement", () => {
        const snapshot = bootstrappedStore().snapshot();
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                version: 2
            } as unknown as typeof snapshot)
        ).toThrow(/snapshot is malformed/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                extra: true
            } as unknown as typeof snapshot)
        ).toThrow(/snapshot is malformed/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                grants: [{ ...snapshot.grants[0]!, id: "different" }]
            })
        ).toThrow(/does not match/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                identity: {
                    ...snapshot.identity,
                    records: snapshot.identity.records.filter(
                        (record) => record.kind !== "membership"
                    )
                }
            })
        ).toThrow(/identity closure is incomplete/);
    });

    test("keeps bootstrap atomic and eligible after a late bootstrap failure", () => {
        const store = MemoryTenantControlStore.create(anchor);
        const plan = createTenantControlBootstrapPlan(anchor, Revision.initial());

        expect(() =>
            store.bootstrap({
                ...plan,
                epochs: [plan.epochs[0]!.next()]
            })
        ).toThrow("Scope epoch writes must advance exactly once");

        expect(store.isBootstrapEligible()).toBe(true);
        expect(store.bootstrapMarker()).toBeUndefined();
        expect(store.identitySnapshot().records).toEqual([]);
        expect(store.grants()).toEqual([]);
    });

    test("allows writes only after bootstrap and only inside an owned transaction", () => {
        const fresh = MemoryTenantControlStore.create(anchor);
        const service = new AuthorityMutationService(fresh);
        expect(() =>
            service.createPrincipal(new Principal(new PrincipalId("too-early"), "user", "active"))
        ).toThrow(/completed bootstrap/);
        expect(() => fresh.putGrant(allowGrant("outside-transaction"))).toThrow(
            /owned transaction/
        );

        const store = bootstrappedStore();
        new AuthorityMutationService(store).createGrant(allowGrant("after-bootstrap"));
        expect(store.grants().some((grant) => grant.id.value === "after-bootstrap")).toBe(true);
    });

    test("[C13-AUTH-EPOCH-ADVANCEMENT] memory advances durable path epochs for allow and deny changes", () => {
        const store = bootstrappedStore();
        const service = new AuthorityMutationService(store);
        const initial = store.epoch(workspaceScope).epoch;
        const allow = allowGrant("epoch-allow");
        const deny = new Grant(
            new GrantId("epoch-deny"),
            workspaceScope,
            SubjectRef.principal(principalId),
            "deny",
            allow.capability,
            { kind: "direct" }
        );

        service.createGrant(allow);
        expect(store.epoch(workspaceScope).epoch).toBe(initial + 1);
        service.createGrant(deny);
        expect(store.epoch(workspaceScope).epoch).toBe(initial + 2);
        service.revokeGrant(allow.id);
        expect(store.epoch(workspaceScope).epoch).toBe(initial + 3);
        service.revokeGrant(deny.id);
        expect(store.epoch(workspaceScope).epoch).toBe(initial + 4);

        expect(MemoryTenantControlStore.restore(store.snapshot()).epoch(workspaceScope).epoch).toBe(
            initial + 4
        );
    });

    test("rolls back post-bootstrap transactions and rejects asynchronous callbacks", () => {
        const store = bootstrappedStore();
        const before = store.snapshot();

        expect(() =>
            store.transaction((candidate) => {
                candidate.putGrant(allowGrant("grant-rollback"));
                throw new TypeError("abort");
            })
        ).toThrow("abort");
        expect(store.snapshot()).toEqual(before);
        expect(() => store.transaction(async () => undefined)).toThrow(
            "Memory Tenant control transactions must be synchronous"
        );
        const thenable = new Proxy({}, { has: (_target, key) => key === "then" });
        expect(() => store.transaction(() => thenable as never)).toThrow(
            "Memory Tenant control transactions must be synchronous"
        );
    });

    test("never grants write capability to a captured root store", () => {
        const store = bootstrappedStore();
        const before = store.snapshot();

        expect(() =>
            store.transaction(() => {
                store.putGrant(allowGrant("captured-root"));
            })
        ).toThrow(/owned transaction/);

        expect(store.snapshot()).toEqual(before);
        expect(store.grant(new GrantId("captured-root"))).toBeUndefined();
    });

    test("rejects captured-root reentry without committing an inner mutation", () => {
        const store = bootstrappedStore();
        const before = store.snapshot();

        expect(() =>
            store.transaction(() => {
                store.transaction((inner) => {
                    inner.putGrant(allowGrant("nested-root-grant"));
                });
                throw new TypeError("outer abort");
            })
        ).toThrow(/Nested Memory Tenant control transactions/);

        expect(store.snapshot()).toEqual(before);
        expect(store.grant(new GrantId("nested-root-grant"))).toBeUndefined();
    });

    test("fails closed on malformed anchors and bootstrap requests", () => {
        expect(() => MemoryTenantControlStore.create({ ...anchor, actorId: "" as never })).toThrow(
            /anchor is malformed/
        );
        expect(() =>
            MemoryTenantControlStore.create({
                ...anchor,
                trustAnchor: new Uint8Array()
            })
        ).toThrow(/anchor is malformed/);
        expect(() =>
            MemoryTenantControlStore.create({
                ...anchor,
                tenantKind: "invalid"
            } as never)
        ).toThrow(/Tenant kind is invalid/);

        const fresh = MemoryTenantControlStore.create(anchor);
        expect(() =>
            fresh.bootstrapTenant(
                {
                    ...anchor,
                    trustAnchor: Uint8Array.of(9)
                },
                Revision.initial()
            )
        ).toThrow(/does not match/);
        expect(() => fresh.bootstrapTenant(anchor, Revision.initial().next())).toThrow(
            /initial authorization revision/
        );

        const bootstrapped = bootstrappedStore();
        expect(() => bootstrapped.bootstrapTenant(anchor, Revision.initial())).toThrow(
            /not bootstrap eligible/
        );
    });

    test("rejects malformed marker and anchor snapshot projections", () => {
        const snapshot = bootstrappedStore().snapshot();
        expect(() => MemoryTenantControlStore.restore(null as never)).toThrow(
            /snapshot is malformed/
        );
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                grants: null
            } as never)
        ).toThrow(/snapshot is malformed/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                marker: "invalid"
            } as never)
        ).toThrow(/snapshot is malformed/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                marker: { ...snapshot.marker!, revision: -1 }
            })
        ).toThrow(/marker is malformed/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                anchor: { ...snapshot.anchor, tenantId: "" as never }
            })
        ).toThrow(/anchor is malformed/);
        expectCodecInvalid(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                anchor: { ...snapshot.anchor, tenantId: "x".repeat(257) as never }
            })
        );
        expectCodecInvalid(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                anchor: { ...snapshot.anchor, actorId: null as never }
            })
        );
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                grants: [snapshot.grants[0]!, snapshot.grants[0]!]
            })
        ).toThrow(/duplicate Grant records/);
        expect(() =>
            MemoryTenantControlStore.restore({ ...snapshot, grants: [null as never] })
        ).toThrow(/snapshot record is malformed/);
        expect(() => MemoryTenantControlStore.restore({ ...snapshot, marker: null })).toThrow(
            /not empty/
        );
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                marker: { ...snapshot.marker!, tenantId: new TenantId("different-marker-tenant") }
            })
        ).toThrow(/does not match its anchor/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                identity: {
                    ...snapshot.identity,
                    records: snapshot.identity.records.filter((record) => record.kind !== "project")
                }
            })
        ).toThrow(/missing Project/);
        const bootstrapGrant = Grant.decode(snapshot.grants[0]!.bytes);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                grants: [
                    {
                        id: bootstrapGrant.id.value,
                        bytes: Grant.encode(
                            new Grant(
                                bootstrapGrant.id,
                                bootstrapGrant.scope,
                                SubjectRef.principal(
                                    new PrincipalId("missing-bootstrap-principal")
                                ),
                                bootstrapGrant.effect,
                                bootstrapGrant.capability,
                                bootstrapGrant.origin,
                                bootstrapGrant.attenuationOf
                            )
                        )
                    }
                ]
            })
        ).toThrow(/missing Principal|invalid Membership evidence/);
    });

    test("rejects forged role-derived Grant bytes during restore", () => {
        const store = bootstrappedStore();
        const service = new AuthorityMutationService(store);
        const role = observeRole("restore-role");
        const member = new Membership(
            new MembershipId("restore-member"),
            workspaceScope,
            SubjectRef.principal(principalId),
            role.name,
            "active",
            Revision.initial()
        );
        service.createRole(role);
        service.assignMembership(member);
        const snapshot = store.snapshot();
        const stored = snapshot.grants.find((entry) => {
            const candidate = Grant.decode(entry.bytes);
            return (
                candidate.origin.kind === "role" && candidate.origin.membershipId.equals(member.id)
            );
        })!;
        const original = Grant.decode(stored.bytes);
        const forged = new Grant(
            original.id,
            original.scope,
            original.subject,
            original.effect,
            new CapabilitySpec({ facetPattern: "*", impacts: ["administer"] }),
            original.origin
        );

        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                grants: snapshot.grants.map((entry) =>
                    entry.id === stored.id ? { id: entry.id, bytes: Grant.encode(forged) } : entry
                )
            })
        ).toThrow(/materialization/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                grants: snapshot.grants.map((entry) =>
                    entry.id === stored.id
                        ? { id: entry.id, bytes: Grant.encode(forged.revoke()) }
                        : entry
                )
            })
        ).toThrow(/materialization/);
    });

    test("enforces narrowing and recursively revokes delegated Grant chains", () => {
        const store = bootstrappedStore();
        const service = new AuthorityMutationService(store);
        const parent = new Grant(
            new GrantId("memory-parent"),
            workspaceScope,
            SubjectRef.principal(principalId),
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe", "mutate"] }),
            { kind: "direct" }
        );
        const child = new Grant(
            new GrantId("memory-child"),
            workspaceScope,
            parent.subject,
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            { kind: "direct" },
            parent.id
        );
        const grandchild = new Grant(
            new GrantId("memory-grandchild"),
            workspaceScope,
            parent.subject,
            "allow",
            child.capability,
            { kind: "direct" },
            child.id
        );
        service.createGrant(parent);
        service.createGrant(child);
        service.createGrant(grandchild);
        const activeSnapshot = store.snapshot();
        const cyclic = new Grant(
            child.id,
            child.scope,
            child.subject,
            child.effect,
            child.capability,
            child.origin,
            child.id
        );
        expect(() =>
            MemoryTenantControlStore.restore({
                ...activeSnapshot,
                grants: activeSnapshot.grants.map((entry) =>
                    entry.id === child.id.value ? { ...entry, bytes: Grant.encode(cyclic) } : entry
                )
            })
        ).toThrow(/cycle/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...activeSnapshot,
                grants: activeSnapshot.grants.map((entry) =>
                    entry.id === parent.id.value
                        ? { id: entry.id, bytes: Grant.encode(parent.revoke()) }
                        : entry
                )
            })
        ).toThrow(/invalid parent authority/);
        expect(() =>
            service.createGrant(
                new Grant(
                    new GrantId("memory-widened"),
                    workspaceScope,
                    parent.subject,
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["administer"] }),
                    { kind: "direct" },
                    parent.id
                )
            )
        ).toThrow(/live attenuation/);

        service.revokeGrant(parent.id);
        expect([parent.id, child.id, grandchild.id].map((id) => store.grant(id)?.isLive)).toEqual([
            false,
            false,
            false
        ]);
    });

    test("keeps explicitly revoked role Grants terminal across Role reconciliation", () => {
        const store = bootstrappedStore();
        const service = new AuthorityMutationService(store);
        const role = observeRole("terminal-role-grant");
        const member = new Membership(
            new MembershipId("terminal-role-member"),
            workspaceScope,
            SubjectRef.principal(principalId),
            role.name,
            "active",
            Revision.initial()
        );
        service.createRole(role);
        service.assignMembership(member);
        const roleGrant = store
            .grants()
            .find(
                (grant) =>
                    grant.origin.kind === "role" && grant.origin.membershipId.equals(member.id)
            )!;
        service.revokeGrant(roleGrant.id);
        service.changeRole(
            new Role(role.name, [
                ...role.rules,
                new RoleRule(
                    "deny",
                    new CapabilitySpec({
                        argumentConstraints: {},
                        facetPattern: "workspace:secret.*",
                        impacts: ["observe"],
                        operations: []
                    })
                )
            ])
        );

        expect(store.grant(roleGrant.id)?.isLive).toBe(false);
    });

    test("restores deny authority through Team and verified guest identity closures", () => {
        const store = bootstrappedStore();
        const service = new AuthorityMutationService(store);
        const teammate = new PrincipalId("memory-team-principal");
        service.createPrincipal(new Principal(teammate, "user", "active"));
        const team = new Team(
            new TeamId("memory-deny-team"),
            tenantId,
            "Deny Team",
            [teammate],
            Revision.initial()
        );
        const denyRole = new Role(new RoleName("memory-deny-role"), [
            new RoleRule("deny", new CapabilitySpec({ facetPattern: "*", impacts: ["mutate"] }))
        ]);
        service.createTeam(team);
        service.createRole(denyRole);
        service.assignMembership(
            new Membership(
                new MembershipId("memory-team-membership"),
                workspaceScope,
                SubjectRef.team(team.id),
                denyRole.name,
                "active",
                Revision.initial()
            )
        );

        const home = new TenantId("memory-guest-home");
        const guest = new PrincipalId("memory-guest-principal");
        const trust = new GuestTrust(
            new GuestTrustId("memory-guest-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://memory-guest.example/verify" },
            "active",
            Revision.initial()
        );
        const guestRole = observeRole("memory-guest-role");
        const guestSubject = SubjectRef.foreign(home, guest, GuestVerificationScheme.callback);
        const verification = new GuestVerification(
            new PrincipalRef(home, guest),
            trust.id,
            trust.revision,
            "callback",
            Digest.sha256(Uint8Array.of(7)),
            new Date(1),
            new Date(100)
        );
        service.createGuestTrust(trust);
        service.createRole(guestRole);
        const guestMembership = service.assignGuestMembership(
            new Membership(
                new MembershipId("memory-guest-membership"),
                workspaceScope,
                guestSubject,
                guestRole.name,
                "active",
                Revision.initial()
            ),
            verification,
            new Date(10)
        );
        service.changeMembership(guestMembership.id, {
            role: guestRole.name,
            state: "suspended"
        });
        const directMemberPrincipal = new PrincipalId("memory-direct-member-principal");
        service.createPrincipal(new Principal(directMemberPrincipal, "user", "active"));
        service.assignMembership(
            new Membership(
                new MembershipId("memory-direct-membership"),
                workspaceScope,
                SubjectRef.principal(directMemberPrincipal),
                guestRole.name,
                "active",
                Revision.initial()
            )
        );

        const snapshot = store.snapshot();
        const restarted = MemoryTenantControlStore.restore(snapshot);
        expect(restarted.team(team.id)?.has(teammate)).toBe(true);
        expect(
            restarted
                .grants()
                .some((grant) => grant.effect === "deny" && grant.subject.kind === "team")
        ).toBe(true);
        expect(restarted.guestTrust(trust.id)?.isActive).toBe(true);

        for (const missingKind of ["team", "guestTrust"] as const) {
            expect(() =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    identity: {
                        ...snapshot.identity,
                        records: snapshot.identity.records.filter(
                            (record) => record.kind !== missingKind
                        )
                    }
                })
            ).toThrow(missingKind === "team" ? /missing Team/ : /invalid trust evidence/);
        }
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                identity: {
                    ...snapshot.identity,
                    records: snapshot.identity.records.filter(
                        (record) => !(record.kind === "role" && record.id === denyRole.name.value)
                    )
                }
            })
        ).toThrow(/missing Role/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                identity: {
                    ...snapshot.identity,
                    records: snapshot.identity.records.filter(
                        (record) =>
                            !(
                                record.kind === "principal" &&
                                record.id === directMemberPrincipal.value
                            )
                    )
                }
            })
        ).toThrow(/missing Principal/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                identity: {
                    ...snapshot.identity,
                    records: snapshot.identity.records.filter(
                        (record) =>
                            !(
                                record.kind === "team" ||
                                (record.kind === "membership" &&
                                    record.id === "memory-team-membership")
                            )
                    )
                }
            })
        ).toThrow(/Grant references a missing Team/);
        expect(() =>
            MemoryTenantControlStore.restore({
                ...snapshot,
                identity: {
                    ...snapshot.identity,
                    records: snapshot.identity.records.filter(
                        (record) =>
                            !(
                                record.kind === "membership" &&
                                record.id === "memory-team-membership"
                            )
                    )
                }
            })
        ).toThrow(/invalid Membership evidence/);
    });

    test("rejects direct stale Workspace and revoked Membership rewrites", () => {
        const store = bootstrappedStore();
        expect(() =>
            store.transaction((candidate) =>
                candidate.putWorkspace({
                    id: new WorkspaceId("memory-stale-workspace"),
                    tenantId,
                    projectId: undefined,
                    revision: new Revision(1)
                } as Workspace)
            )
        ).toThrow(/revision zero/);

        const service = new AuthorityMutationService(store);
        const role = observeRole("memory-terminal-membership-role");
        const member = new Membership(
            new MembershipId("memory-terminal-membership"),
            workspaceScope,
            SubjectRef.principal(principalId),
            role.name,
            "active",
            Revision.initial()
        );
        service.createRole(role);
        service.assignMembership(member);
        const revoked = service.revokeMembership(member.id);
        expect(() =>
            store.transaction((candidate) =>
                candidate.putMembership(
                    new Membership(
                        revoked.id,
                        revoked.scope,
                        revoked.subject,
                        revoked.role,
                        "active",
                        revoked.revision.next()
                    )
                )
            )
        ).toThrow(/cannot reactivate/);

        expect(() =>
            store.transaction((candidate) =>
                candidate.putMembership(
                    new Membership(
                        revoked.id,
                        revoked.scope,
                        SubjectRef.team(new TeamId("memory-substituted-team")),
                        revoked.role,
                        "revoked",
                        revoked.revision.next()
                    )
                )
            )
        ).toThrow(/subject and Scope are immutable/);

        const home = new TenantId("memory-unverified-home");
        expect(() =>
            store.transaction((candidate) =>
                candidate.putMembership(
                    new Membership(
                        new MembershipId("memory-unverified-guest"),
                        workspaceScope,
                        SubjectRef.foreign(
                            home,
                            new PrincipalId("memory-unverified-principal"),
                            GuestVerificationScheme.callback
                        ),
                        role.name,
                        "active",
                        Revision.initial()
                    )
                )
            )
        ).toThrow(/invalid trust evidence/);
    });

    test("rejects malformed authority record scalar and collection shapes", () => {
        const roleGrant = bootstrappedStore()
            .grants()
            .find((grant) => grant.origin.kind === "role")!;
        const encoded = decodeCanonicalJson(Grant.encode(roleGrant)) as any;
        const variants = [
            (value: any) => {
                value.payload = null;
            },
            (value: any) => {
                value.payload.id = 9;
            },
            (value: any) => {
                value.payload.origin.guest = "yes";
            }
        ];
        for (const mutate of variants) {
            const malformed = structuredClone(encoded);
            mutate(malformed);
            expect(() => Grant.decode(encodeCanonicalJson(malformed))).toThrow();
        }
        expect(() => PathEpochEvidence.fromData({ path: null } as never)).toThrow(/array/);
    });
});

function bootstrappedStore(): MemoryTenantControlStore {
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    if (workspaceScope.projectId !== undefined) {
        service.createProject(
            new Project(
                workspaceScope.projectId,
                tenantId,
                "Authority test Project",
                Revision.initial()
            )
        );
    }
    service.createWorkspace(
        new Workspace(
            workspaceScope.workspaceId!,
            tenantId,
            workspaceScope.projectId,
            Revision.initial()
        )
    );
    return store;
}

function observeRole(name: string): Role {
    return new Role(new RoleName(name), [
        new RoleRule("allow", new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }))
    ]);
}

function expectCodecInvalid(action: () => unknown): void {
    try {
        action();
        throw new Error("Expected codec.invalid");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code: "codec.invalid" });
    }
}

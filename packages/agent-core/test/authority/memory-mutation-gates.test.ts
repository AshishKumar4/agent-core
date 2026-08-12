import { describe, expect, test } from "vitest";
import { ActorId } from "../../src/actors";
import { AuthorityMutationService, Binding, Grant, GrantId } from "../../src/authority";
import {
    MemoryTenantControlStore,
    type MemoryTenantControlSnapshot
} from "../../src/authority/memory";
import {
    createTenantControlBootstrapPlan,
    type AuthorityMutationStore
} from "../../src/authority/service";
import { Digest, Revision, SecretRef } from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    GuestTrust,
    GuestTrustId,
    GuestVerificationScheme,
    Membership,
    MembershipId,
    Principal,
    PrincipalId,
    PrincipalRef,
    Project,
    ProjectId,
    Role,
    RoleName,
    RoleRule,
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    Tenant,
    TenantId,
    WorkspaceId,
    type StoredIdentityRecord
} from "../../src/identity";
import { GuestVerification, Workspace } from "../identity/internal-fixture";
import {
    allowGrant,
    capability,
    principal,
    principalId,
    projectId,
    projectScope,
    tenantId,
    tenantScope,
    workspaceId,
    workspaceScope
} from "./fixture";

const foreignTenantId = new TenantId("memory-gate-foreign");
const anchor = Object.freeze({
    actorId: new ActorId("memory-gate-actor"),
    tenantId,
    principalId,
    trustAnchor: Uint8Array.of(1, 2, 3)
});

describe("MemoryTenantControlStore mutation gates", () => {
    test("returns defensive copies of anchor and record bytes to callers", { tags: "p0" }, () => {
        const { store } = bootstrapped();

        store.bootstrapAnchor().trustAnchor.fill(9);
        expect(store.bootstrapAnchor().trustAnchor).toEqual(Uint8Array.of(1, 2, 3));

        const identityFirst = store.identitySnapshot();
        const identityBaseline = identityFirst.records.map((record) => ({
            kind: record.kind,
            id: record.id,
            bytes: [...record.bytes]
        }));
        expectDefined(identityFirst.records[0], "identity record").bytes.fill(0);
        expect(
            store.identitySnapshot().records.map((record) => ({
                kind: record.kind,
                id: record.id,
                bytes: [...record.bytes]
            }))
        ).toEqual(identityBaseline);

        const snapshotFirst = store.snapshot();
        const grantBaseline = snapshotFirst.grants.map((entry) => ({
            id: entry.id,
            bytes: [...entry.bytes]
        }));
        expectDefined(snapshotFirst.grants[0], "grant record").bytes.fill(0);
        expect(
            store.snapshot().grants.map((entry) => ({ id: entry.id, bytes: [...entry.bytes] }))
        ).toEqual(grantBaseline);
    });

    test("keeps record listings and snapshots canonically sorted", { tags: "p1" }, () => {
        const { store, service } = bootstrapped();
        service.createGrant(allowGrant("zz-order-grant"));
        service.createGrant(allowGrant("aa-order-grant"));
        service.createRole(observeRole("zz-order-role"));
        service.createRole(observeRole("aa-order-role"));

        const grantIds = store.grants().map((grant) => grant.id.value);
        expect(grantIds).toContain("aa-order-grant");
        expect(grantIds).toContain("zz-order-grant");
        expect(grantIds).toEqual([...grantIds].sort((left, right) => left.localeCompare(right)));
        expect(store.snapshot().grants.map((entry) => entry.id)).toEqual(grantIds);

        const roleNames = store.roles().map((role) => role.name.value);
        expect(roleNames).toContain("aa-order-role");
        expect(roleNames).toEqual([...roleNames].sort((left, right) => left.localeCompare(right)));

        const identityKeys = store
            .identitySnapshot()
            .records.map((record) => `${record.kind}\u0000${record.id}`);
        expect(identityKeys).toEqual(
            [...identityKeys].sort((left, right) => left.localeCompare(right))
        );
    });

    test("keeps in-transaction record listings canonically sorted", { tags: "p1" }, () => {
        const { store, service } = bootstrapped();
        service.createGrant(allowGrant("zz-transaction-order"));
        const observed = store.transaction((candidate) => {
            candidate.putGrant(allowGrant("aa-transaction-order"));
            return candidate.grants().map((grant) => grant.id.value);
        });
        expect(observed).toContain("aa-transaction-order");
        expect(observed).toContain("zz-transaction-order");
        expect(observed).toEqual([...observed].sort((left, right) => left.localeCompare(right)));
    });

    test("returns synchronous null transaction results unchanged", { tags: "p2" }, () => {
        const { store } = bootstrapped();
        expect(store.transaction(() => null)).toBeNull();
    });

    test(
        "rejects bootstrap anchors whose trust anchor merely extends the stored bytes",
        { tags: "p0" },
        () => {
            const fresh = MemoryTenantControlStore.create(anchor);
            expectAgentCoreError(
                () =>
                    fresh.bootstrapTenant(
                        { ...anchor, trustAnchor: Uint8Array.of(1, 2, 3, 4) },
                        Revision.initial()
                    ),
                "protocol.invalid-state",
                "Tenant bootstrap request does not match its immutable anchor"
            );
            expect(fresh.isBootstrapEligible()).toBe(true);
        }
    );

    test("ties bootstrap eligibility to every empty collection", { tags: "p0" }, () => {
        const empty = MemoryTenantControlStore.create(anchor).snapshot();
        const bound = bootstrapped();
        const backing = allowGrant("eligibility-binding-grant");
        bound.service.createGrant(backing);
        bound.service.createBinding(bindingAt("eligibility", backing.id, 0, 0));
        const boot = bound.store.snapshot();
        expect(bound.store.isBootstrapEligible()).toBe(false);
        expect(boot.bindings).toHaveLength(1);

        expectAgentCoreError(
            () => MemoryTenantControlStore.restore({ ...empty, identity: boot.identity }),
            "codec.invalid",
            "Unmarked Tenant control snapshot is not empty"
        );
        expectAgentCoreError(
            () => MemoryTenantControlStore.restore({ ...empty, grants: boot.grants }),
            "codec.invalid",
            "Unmarked Tenant control snapshot is not empty"
        );
        expectAgentCoreError(
            () => MemoryTenantControlStore.restore({ ...empty, bindings: boot.bindings }),
            "codec.invalid",
            "Unmarked Tenant control snapshot is not empty"
        );
        expectAgentCoreError(
            () => MemoryTenantControlStore.restore({ ...empty, epochs: boot.epochs }),
            "codec.invalid",
            "Unmarked Tenant control snapshot is not empty"
        );
    });

    test("reports bootstrap and transaction preconditions with exact codes", { tags: "p0" }, () => {
        const { store } = bootstrapped();
        expectAgentCoreError(
            () => store.bootstrapTenant(anchor, Revision.initial()),
            "protocol.invalid-state",
            "Tenant control is not bootstrap eligible"
        );

        const fresh = MemoryTenantControlStore.create(anchor);
        expectAgentCoreError(
            () => fresh.transaction(() => undefined),
            "protocol.invalid-state",
            "Tenant authority mutations require completed bootstrap"
        );
        expectAgentCoreError(
            () =>
                fresh.bootstrapTenant(
                    { ...anchor, trustAnchor: Uint8Array.of(9) },
                    Revision.initial()
                ),
            "protocol.invalid-state",
            "Tenant bootstrap request does not match its immutable anchor"
        );
    });

    test(
        "rejects bootstrap requests that differ from the anchor in any field",
        { tags: "p0" },
        () => {
            const fresh = MemoryTenantControlStore.create(anchor);
            const variants = [
                { ...anchor, actorId: new ActorId("memory-gate-other-actor") },
                { ...anchor, tenantId: new TenantId("memory-gate-other-tenant") },
                { ...anchor, principalId: new PrincipalId("memory-gate-other-principal") },
                { ...anchor, tenantKind: "organization" as const }
            ];
            for (const variant of variants) {
                expectAgentCoreError(
                    () => fresh.bootstrapTenant(variant, Revision.initial()),
                    "protocol.invalid-state",
                    "Tenant bootstrap request does not match its immutable anchor"
                );
                expect(fresh.isBootstrapEligible()).toBe(true);
            }
            fresh.bootstrapTenant(anchor, Revision.initial());
            expect(fresh.bootstrapMarker()?.tenantId.equals(tenantId)).toBe(true);
        }
    );

    test("rejects bootstrap plans violating any single anchor constraint", { tags: "p0" }, () => {
        const fresh = MemoryTenantControlStore.create(anchor);
        const plan = createTenantControlBootstrapPlan(anchor, Revision.initial());
        const owner = plan.ownerMembership;
        const tampered: (typeof plan)[] = [
            { ...plan, tenant: new Tenant(tenantId, "organization", "active", Revision.initial()) },
            { ...plan, tenant: new Tenant(tenantId, "personal", "active", new Revision(1)) },
            {
                ...plan,
                ownerMembership: new Membership(
                    owner.id,
                    ScopeRef.project(tenantId, new ProjectId("memory-gate-plan-project")),
                    owner.subject,
                    owner.role,
                    "active",
                    Revision.initial()
                )
            },
            {
                ...plan,
                ownerMembership: new Membership(
                    owner.id,
                    owner.scope,
                    SubjectRef.team(new TeamId("memory-gate-plan-team")),
                    owner.role,
                    "active",
                    Revision.initial()
                )
            },
            {
                ...plan,
                ownerMembership: new Membership(
                    owner.id,
                    owner.scope,
                    owner.subject,
                    owner.role,
                    "active",
                    new Revision(1)
                )
            }
        ];
        for (const candidate of tampered) {
            expectAgentCoreError(
                () => fresh.bootstrap(candidate),
                "protocol.invalid-state",
                "Tenant bootstrap plan does not match its immutable anchor"
            );
            expect(fresh.isBootstrapEligible()).toBe(true);
        }
    });

    test("round-trips organization and service Tenant kinds", { tags: "p0" }, () => {
        for (const tenantKind of ["organization", "service"] as const) {
            const kindAnchor = { ...anchor, tenantKind };
            const store = MemoryTenantControlStore.create(kindAnchor);
            store.bootstrapTenant(kindAnchor, Revision.initial());
            expect(store.bootstrapAnchor().tenantKind).toBe(tenantKind);
            const restored = MemoryTenantControlStore.restore(store.snapshot());
            expect(restored.bootstrapAnchor().tenantKind).toBe(tenantKind);
        }

        const snapshot = bootstrapped().store.snapshot();
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    anchor: { ...snapshot.anchor, tenantKind: "invalid" as never }
                }),
            "codec.invalid",
            "Memory Tenant control bootstrap Tenant kind is invalid"
        );
    });

    test("requires the initial marker revision on restore", { tags: "p0" }, () => {
        const snapshot = bootstrapped().store.snapshot();
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    marker: { ...markerOf(snapshot), revision: 1 }
                }),
            "codec.invalid",
            "Tenant control marker does not match its anchor"
        );
    });

    test("fails closed on malformed snapshot container shapes", { tags: "p0" }, () => {
        const snapshot = bootstrapped().store.snapshot();
        const grantRecord = expectDefined(snapshot.grants[0], "grant record");

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    Object.assign(() => undefined, { ...snapshot }) as never
                ),
            "codec.invalid",
            "Memory Tenant control snapshot is malformed"
        );

        expectAgentCoreError(
            () => MemoryTenantControlStore.restore({ ...snapshot, anchor: null as never }),
            "codec.invalid",
            "Memory Tenant control bootstrap anchor is malformed"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    anchor: Object.assign(() => undefined, { ...snapshot.anchor }) as never
                }),
            "codec.invalid",
            "Memory Tenant control bootstrap anchor is malformed"
        );
        const { tenantKind: renamedKind, ...anchorRest } = snapshot.anchor;
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    anchor: { ...anchorRest, renamed: renamedKind } as never
                }),
            "codec.invalid",
            "Memory Tenant control bootstrap anchor is malformed"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    anchor: { ...snapshot.anchor, trustAnchor: new Uint8Array() }
                }),
            "codec.invalid",
            "Memory Tenant control bootstrap anchor is malformed"
        );
        expectAgentCoreError(
            () => MemoryTenantControlStore.create({ ...anchor, trustAnchor: null as never }),
            "codec.invalid",
            "Memory Tenant control bootstrap anchor is malformed"
        );

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    marker: Object.assign(() => undefined, { ...markerOf(snapshot) }) as never
                }),
            "codec.invalid",
            "Memory Tenant control snapshot is malformed"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    marker: { ...markerOf(snapshot), extra: true } as never
                }),
            "codec.invalid",
            "Memory Tenant control bootstrap marker is malformed"
        );

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    grants: [
                        Object.assign(() => undefined, {
                            id: grantRecord.id,
                            bytes: grantRecord.bytes.slice()
                        }) as never
                    ]
                }),
            "codec.invalid",
            "Memory Tenant control Grant snapshot record is malformed"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    grants: [{ id: 5 as never, bytes: grantRecord.bytes.slice() }]
                }),
            "codec.invalid",
            "Memory Tenant control Grant snapshot record is malformed"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    grants: [{ id: "", bytes: grantRecord.bytes.slice() }]
                }),
            "codec.invalid",
            "Memory Tenant control Grant snapshot record is malformed"
        );
    });

    test("detects each broken bootstrap closure invariant during restore", { tags: "p0" }, () => {
        const minimal = MemoryTenantControlStore.create(anchor);
        minimal.bootstrapTenant(anchor, Revision.initial());
        const snapshot = minimal.snapshot();
        const closure = "Bootstrapped Tenant identity closure is incomplete";

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withoutIdentity(snapshot, (record) => record.kind === "tenant")
                ),
            "codec.invalid",
            closure
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withoutIdentity(
                        snapshot,
                        (record) => record.kind === "principal" && record.id === principalId.value
                    )
                ),
            "codec.invalid",
            closure
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    anchor: { ...snapshot.anchor, tenantKind: "organization" }
                }),
            "codec.invalid",
            closure
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withIdentityRecord(snapshot, {
                        kind: "tenant",
                        id: "memory-gate-extra-tenant",
                        bytes: Tenant.encode(
                            new Tenant(
                                new TenantId("memory-gate-extra-tenant"),
                                "personal",
                                "active",
                                Revision.initial()
                            )
                        )
                    })
                ),
            "codec.invalid",
            closure
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withoutIdentity(
                        snapshot,
                        (record) => record.kind === "role" && record.id === "reader"
                    )
                ),
            "codec.invalid",
            closure
        );
        expectAgentCoreError(
            () => MemoryTenantControlStore.restore({ ...snapshot, grants: [] }),
            "codec.invalid",
            closure
        );
        expectAgentCoreError(
            () => MemoryTenantControlStore.restore({ ...snapshot, epochs: [] }),
            "codec.invalid",
            closure
        );
    });

    test("rejects restored records that escape the local Tenant", { tags: "p0" }, () => {
        const snapshot = bootstrapped().store.snapshot();

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withIdentityRecord(snapshot, {
                        kind: "project",
                        id: "memory-gate-foreign-project",
                        bytes: Project.encode(
                            new Project(
                                new ProjectId("memory-gate-foreign-project"),
                                new TenantId("memory-gate-foreign-tenant"),
                                "Foreign",
                                Revision.initial()
                            )
                        )
                    })
                ),
            "protocol.invalid-state",
            "Project belongs to another Tenant"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withIdentityRecord(snapshot, {
                        kind: "guestTrust",
                        id: "memory-gate-foreign-trust",
                        bytes: GuestTrust.encode(
                            new GuestTrust(
                                new GuestTrustId("memory-gate-foreign-trust"),
                                new TenantId("memory-gate-foreign-host"),
                                new TenantId("memory-gate-foreign-home"),
                                { kind: "callback", endpoint: "https://foreign.example/verify" },
                                "active",
                                Revision.initial()
                            )
                        )
                    })
                ),
            "protocol.invalid-state",
            "Guest trust belongs to another Tenant"
        );
    });

    test(
        "holds a Membership's subject fixed across a revision for a team subject",
        { tags: "p0" },
        () => {
            // The store's revision guard dispatches on subject kind. Only the Principal
            // arm was ever exercised, so the team arm could be entered for the wrong kind
            // — reading a field that is not there — without any test noticing.
            const { store, service } = bootstrapped();
            const role = emptyRole("memory-gate-subject-kind-role");
            service.createRole(role);
            const team = new Team(
                new TeamId("memory-gate-subject-kind-team"),
                tenantId,
                "Subject Kind Team",
                [],
                Revision.initial()
            );
            service.createTeam(team);
            const other = new Team(
                new TeamId("memory-gate-subject-kind-other"),
                tenantId,
                "Other Team",
                [],
                Revision.initial()
            );
            service.createTeam(other);
            const id = new MembershipId("memory-gate-subject-kind-member");
            service.assignMembership(
                new Membership(
                    id,
                    workspaceScope,
                    SubjectRef.team(team.id),
                    role.name,
                    "active",
                    Revision.initial()
                )
            );

            // Same team subject at the next revision is accepted.
            service.changeMembership(id, { role: role.name, state: "suspended" });

            // Reading back proves the guard ran and accepted, rather than the write
            // being skipped: the state advanced and the subject is still the team.
            const current = store.membership(id);
            expect(current?.state).toBe("suspended");
            expect(current?.subject).toEqual(SubjectRef.team(team.id));
        }
    );

    test("detects Memberships whose subject records were removed", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const closureRole = emptyRole("memory-gate-closure-role");
        service.createRole(closureRole);
        const soloPrincipal = new PrincipalId("memory-gate-closure-principal");
        service.createPrincipal(new Principal(soloPrincipal, "user", "active"));
        service.assignMembership(
            new Membership(
                new MembershipId("memory-gate-closure-member"),
                workspaceScope,
                SubjectRef.principal(new PrincipalRef(tenantId, soloPrincipal)),
                closureRole.name,
                "active",
                Revision.initial()
            )
        );
        const team = new Team(
            new TeamId("memory-gate-closure-team"),
            tenantId,
            "Closure Team",
            [],
            Revision.initial()
        );
        service.createTeam(team);
        service.assignMembership(
            new Membership(
                new MembershipId("memory-gate-closure-team-member"),
                workspaceScope,
                SubjectRef.team(team.id),
                closureRole.name,
                "active",
                Revision.initial()
            )
        );
        const snapshot = store.snapshot();

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withoutIdentity(
                        snapshot,
                        (record) => record.kind === "principal" && record.id === soloPrincipal.value
                    )
                ),
            "codec.invalid",
            "Membership references a missing Principal"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withoutIdentity(
                        snapshot,
                        (record) => record.kind === "team" && record.id === team.id.value
                    )
                ),
            "codec.invalid",
            "Membership references a missing Team"
        );
    });

    test("revalidates guest Membership trust evidence on restore", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const home = new TenantId("memory-gate-home");
        const guest = new PrincipalId("memory-gate-guest");
        const trust = new GuestTrust(
            new GuestTrustId("memory-gate-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://memory-gate.example/verify" },
            "active",
            Revision.initial()
        );
        const guestRole = emptyRole("memory-gate-guest-role");
        service.createGuestTrust(trust);
        service.createRole(guestRole);
        expect(store.guestTrusts().map((entry) => entry.id.value)).toEqual([trust.id.value]);
        service.assignGuestMembership(
            new Membership(
                new MembershipId("memory-gate-guest-member"),
                workspaceScope,
                SubjectRef.foreign(home, guest, GuestVerificationScheme.callback),
                guestRole.name,
                "active",
                Revision.initial()
            ),
            new GuestVerification(
                new PrincipalRef(home, guest),
                trust.id,
                trust.revision,
                GuestVerificationScheme.callback,
                Digest.sha256(Uint8Array.of(7)),
                new Date(1),
                new Date(100)
            ),
            new Date(10)
        );
        const snapshot = store.snapshot();
        expect(MemoryTenantControlStore.restore(snapshot).guestTrust(trust.id)?.isActive).toBe(
            true
        );

        const rotated = trust.rotate({
            kind: "callback",
            endpoint: "https://memory-gate.example/rotated"
        });
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    replaceIdentityBytes(
                        snapshot,
                        "guestTrust",
                        trust.id.value,
                        GuestTrust.encode(rotated)
                    )
                ),
            "codec.invalid",
            "Guest Membership references invalid trust evidence"
        );

        const methodSwapped = new GuestTrust(
            trust.id,
            tenantId,
            home,
            {
                kind: "token",
                issuer: "memory-gate-issuer",
                key: new SecretRef("tenant", "oidc", "key")
            },
            "active",
            Revision.initial()
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    replaceIdentityBytes(
                        snapshot,
                        "guestTrust",
                        trust.id.value,
                        GuestTrust.encode(methodSwapped)
                    )
                ),
            "codec.invalid",
            "Guest Membership references invalid trust evidence"
        );
    });

    test("validates Grant reference closure precisely on restore", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const soloPrincipal = new PrincipalId("memory-gate-grant-principal");
        service.createPrincipal(new Principal(soloPrincipal, "user", "active"));
        service.createGrant(
            allowGrant(
                "memory-gate-grant-only",
                SubjectRef.principal(new PrincipalRef(tenantId, soloPrincipal))
            )
        );
        const parent = allowGrant("memory-gate-parent");
        const child = allowGrant(
            "memory-gate-child",
            parent.subject,
            workspaceScope,
            parent.capability,
            parent.id
        );
        service.createGrant(parent);
        service.createGrant(child);
        const snapshot = store.snapshot();

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withoutIdentity(
                        snapshot,
                        (record) => record.kind === "principal" && record.id === soloPrincipal.value
                    )
                ),
            "codec.invalid",
            "Grant references a missing Principal"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    grants: snapshot.grants.filter((entry) => entry.id !== parent.id.value)
                }),
            "codec.invalid",
            "Delegated Grant references invalid parent authority"
        );
    });

    test("verifies role Grant materialization byte-for-byte on restore", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const materialization = "Role Grant materialization does not match Membership evidence";
        const singleRole = observeRole("memory-gate-single-role");
        const singleMember = new Membership(
            new MembershipId("memory-gate-single-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            singleRole.name,
            "active",
            Revision.initial()
        );
        service.createRole(singleRole);
        service.assignMembership(singleMember);
        const dualRole = new Role(new RoleName("memory-gate-dual-role"), [
            new RoleRule("allow", new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] })),
            new RoleRule(
                "deny",
                new CapabilitySpec({ facetPattern: "workspace:secret.*", impacts: ["observe"] })
            )
        ]);
        const dualMember = new Membership(
            new MembershipId("memory-gate-dual-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            dualRole.name,
            "active",
            Revision.initial()
        );
        service.createRole(dualRole);
        service.assignMembership(dualMember);
        const snapshot = store.snapshot();

        const singleGrant = roleGrantOf(store, singleMember.id);
        const singleOrigin = singleGrant.origin;
        if (singleOrigin.kind !== "role") throw new Error("Expected role origin");
        const renamedOrigin = new Grant(
            singleGrant.id,
            singleGrant.scope,
            singleGrant.subject,
            singleGrant.effect,
            singleGrant.capability,
            {
                kind: "role",
                membershipId: singleOrigin.membershipId,
                roleName: "memory-gate-forged-role-name",
                ruleOrdinal: singleOrigin.ruleOrdinal,
                guest: singleOrigin.guest
            }
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withGrantBytes(snapshot, singleGrant.id.value, Grant.encode(renamedOrigin))
                ),
            "codec.invalid",
            "Role Grant references invalid Membership evidence"
        );

        const forgedExtra = new Grant(
            new GrantId("memory-gate-forged-extra"),
            singleGrant.scope,
            singleGrant.subject,
            singleGrant.effect,
            singleGrant.capability,
            singleOrigin
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    grants: [
                        ...snapshot.grants,
                        { id: forgedExtra.id.value, bytes: Grant.encode(forgedExtra) }
                    ]
                }),
            "codec.invalid",
            materialization
        );

        const dualGrants = store
            .grants()
            .filter(
                (grant) =>
                    grant.origin.kind === "role" && grant.origin.membershipId.equals(dualMember.id)
            );
        expect(dualGrants).toHaveLength(2);
        const tampered = expectDefined(dualGrants[0], "dual role grant");
        const widened = new Grant(
            tampered.id,
            tampered.scope,
            tampered.subject,
            tampered.effect,
            new CapabilitySpec({ facetPattern: "*", impacts: ["administer"] }),
            tampered.origin
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    withGrantBytes(snapshot, tampered.id.value, Grant.encode(widened))
                ),
            "codec.invalid",
            materialization
        );

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    grants: snapshot.grants.filter((entry) => entry.id !== tampered.id.value)
                }),
            "codec.invalid",
            materialization
        );
    });

    test("direct topology writers validate eagerly with exact errors", { tags: "p0" }, () => {
        const { store } = bootstrapped();
        const foreign = new TenantId("memory-gate-foreign");

        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putProject(
                    new Project(
                        new ProjectId("memory-gate-foreign-project"),
                        foreign,
                        "Foreign",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state",
            "Project belongs to another Tenant"
        );
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putWorkspace(
                    new Workspace(
                        new WorkspaceId("memory-gate-foreign-workspace"),
                        foreign,
                        undefined,
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state",
            "Workspace belongs to another Tenant"
        );
        const existingWorkspace = expectDefined(store.workspace(workspaceId), "workspace");
        expectEagerRejection(
            store,
            (candidate) => candidate.putWorkspace(existingWorkspace),
            "protocol.invalid-state",
            "Workspace topology is immutable"
        );
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putWorkspace({
                    id: new WorkspaceId("memory-gate-revised-workspace"),
                    tenantId,
                    projectId: undefined,
                    revision: new Revision(1)
                } as Workspace),
            "protocol.invalid-state",
            "New Workspaces require revision zero"
        );
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putTeam(
                    new Team(
                        new TeamId("memory-gate-foreign-team"),
                        foreign,
                        "Foreign",
                        [],
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state",
            "Team belongs to another Tenant"
        );
        expectAgentCoreError(
            () =>
                store.transaction((candidate) =>
                    candidate.putTeam(
                        new Team(
                            new TeamId("memory-gate-orphan-team"),
                            tenantId,
                            "Orphan",
                            [new PrincipalId("memory-gate-missing-principal")],
                            Revision.initial()
                        )
                    )
                ),
            "codec.invalid",
            "Team references a missing Principal"
        );
    });

    test("direct guest trust writers enforce identity and lifecycle", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const home = new TenantId("memory-gate-trust-home");
        const trust = new GuestTrust(
            new GuestTrustId("memory-gate-direct-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://memory-gate-direct.example/verify" },
            "active",
            Revision.initial()
        );
        service.createGuestTrust(trust);

        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGuestTrust(
                    new GuestTrust(
                        new GuestTrustId("memory-gate-foreign-host-trust"),
                        new TenantId("memory-gate-foreign"),
                        home,
                        trust.verifier,
                        "active",
                        Revision.initial()
                    )
                ),
            "protocol.invalid-state",
            "Guest trust belongs to another Tenant"
        );
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGuestTrust(
                    new GuestTrust(
                        new GuestTrustId("memory-gate-revised-trust"),
                        tenantId,
                        home,
                        trust.verifier,
                        "active",
                        new Revision(1)
                    )
                ),
            "protocol.invalid-state",
            "New guest trust requires revision zero and active state"
        );
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGuestTrust(
                    new GuestTrust(
                        trust.id,
                        tenantId,
                        new TenantId("memory-gate-other-home"),
                        trust.verifier,
                        "active",
                        trust.revision.next()
                    )
                ),
            "protocol.revision-conflict",
            "Guest trust identity changed"
        );
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGuestTrust(
                    new GuestTrust(
                        trust.id,
                        tenantId,
                        home,
                        trust.verifier,
                        "active",
                        new Revision(2)
                    )
                ),
            "protocol.revision-conflict",
            "Guest trust updates require immutable identity and the next revision"
        );

        const rotated = trust.rotate({
            kind: "callback",
            endpoint: "https://memory-gate-direct.example/rotated"
        });
        store.transaction((candidate) => candidate.putGuestTrust(rotated));
        const stored = expectDefined(store.guestTrust(trust.id), "rotated trust");
        expect(stored.revision.value).toBe(1);
        expect(stored.verifier).toEqual(rotated.verifier);
    });

    test("direct Principal and Membership writers enforce lifecycle", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const extra = new Principal(
            new PrincipalId("memory-gate-lifecycle-principal"),
            "user",
            "active"
        );
        service.createPrincipal(extra);

        expectEagerRejection(
            store,
            (candidate) => candidate.putPrincipal(new Principal(extra.id, "service", "active")),
            "protocol.invalid-state",
            "Principal kind is immutable"
        );
        store.transaction((candidate) => candidate.putPrincipal(extra));
        const disabled = service.disablePrincipal(extra.id);
        store.transaction((candidate) => candidate.putPrincipal(disabled));
        expect(store.principal(extra.id)?.status).toBe("disabled");

        const lifecycleRole = emptyRole("memory-gate-lifecycle-role");
        service.createRole(lifecycleRole);
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putMembership(
                    new Membership(
                        new MembershipId("memory-gate-new-revised-member"),
                        workspaceScope,
                        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                        lifecycleRole.name,
                        "active",
                        new Revision(1)
                    )
                ),
            "protocol.invalid-state",
            "New Memberships must be active at revision zero"
        );

        const member = new Membership(
            new MembershipId("memory-gate-lifecycle-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            lifecycleRole.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(member);
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putMembership(
                    new Membership(
                        member.id,
                        workspaceScope,
                        member.subject,
                        member.role,
                        "active",
                        new Revision(2)
                    )
                ),
            "protocol.revision-conflict",
            "Membership subject and Scope are immutable and updates require the next revision"
        );
        store.transaction((candidate) =>
            candidate.putMembership(
                new Membership(
                    member.id,
                    workspaceScope,
                    member.subject,
                    member.role,
                    "suspended",
                    new Revision(1)
                )
            )
        );
        expect(store.membership(member.id)?.state).toBe("suspended");

        const terminal = new Membership(
            new MembershipId("memory-gate-terminal-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            lifecycleRole.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(terminal);
        const revoked = service.revokeMembership(terminal.id);
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putMembership(
                    new Membership(
                        revoked.id,
                        revoked.scope,
                        revoked.subject,
                        revoked.role,
                        "active",
                        revoked.revision.next()
                    )
                ),
            "protocol.invalid-state",
            "Revoked Memberships cannot reactivate"
        );
        store.transaction((candidate) =>
            candidate.putMembership(
                new Membership(
                    revoked.id,
                    revoked.scope,
                    revoked.subject,
                    revoked.role,
                    "revoked",
                    revoked.revision.next()
                )
            )
        );
        expect(store.membership(terminal.id)?.revision.value).toBe(2);
        expect(store.membership(terminal.id)?.state).toBe("revoked");
    });

    test("records whether it found each written record already there", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const reader = observeRole("memory-gate-presence-role");
        service.createRole(reader);
        const member = new Membership(
            new MembershipId("memory-gate-presence-member"),
            workspaceScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            reader.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(member);
        const owned = (): readonly Grant[] =>
            store
                .grants()
                .filter(
                    (grant) =>
                        grant.origin.kind === "role" && grant.origin.membershipId.equals(member.id)
                );
        expect(owned()).toHaveLength(1);

        // Restating the same Role and state rewrites the Membership and no Grant at all.
        // The closure reads a created Membership's Role Grants out of the transaction's
        // own writes and a replaced one's out of the table, so a write recorded as a
        // creation when the record was already there would leave this Membership owning
        // nothing and fault its own materialization.
        const revised = service.changeMembership(member.id, {
            role: reader.name,
            state: "active"
        });

        expect(revised.revision.value).toBe(1);
        expect(owned()).toHaveLength(1);
    });

    test("direct Grant replacement respects revocation terminality", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const grant = allowGrant("memory-gate-terminal-grant");
        service.createGrant(grant);
        service.revokeGrant(grant.id);
        expectEagerRejection(
            store,
            (candidate) => candidate.putGrant(grant),
            "protocol.invalid-state",
            "Revoked Grants cannot reactivate"
        );
        expect(store.grant(grant.id)?.isLive).toBe(false);
    });

    test("enforces canonical Scopes on every direct authority write", { tags: "p0" }, () => {
        const { store } = bootstrapped();

        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGrant(
                    allowGrant(
                        "memory-gate-foreign-scope",
                        SubjectRef.principal(new PrincipalRef(foreignTenantId, principalId)),
                        ScopeRef.tenant(foreignTenantId)
                    )
                ),
            "protocol.invalid-state",
            "Authority Scope belongs to another Tenant"
        );
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGrant(
                    allowGrant(
                        "memory-gate-missing-project-scope",
                        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                        ScopeRef.project(tenantId, new ProjectId("memory-gate-missing-project"))
                    )
                ),
            "codec.invalid",
            "Authority Project Scope is not canonical"
        );
        const projectScopeWithoutId = {
            kind: "project",
            tenantId,
            projectId: undefined,
            workspaceId: undefined,
            path: [],
            equals: () => false
        } as unknown as ScopeRef;
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGrant(
                    allowGrant(
                        "memory-gate-idless-project-scope",
                        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                        projectScopeWithoutId
                    )
                ),
            "codec.invalid",
            "Authority Project Scope is not canonical"
        );
        store.transaction((candidate) =>
            candidate.putGrant(
                allowGrant(
                    "memory-gate-project-scope-grant",
                    SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                    projectScope
                )
            )
        );
        expect(store.grant(new GrantId("memory-gate-project-scope-grant"))?.isLive).toBe(true);

        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGrant(
                    allowGrant(
                        "memory-gate-missing-workspace-scope",
                        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                        ScopeRef.workspace(
                            tenantId,
                            projectId,
                            new WorkspaceId("memory-gate-missing-workspace")
                        )
                    )
                ),
            "codec.invalid",
            "Authority Workspace Scope is not canonical"
        );
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGrant(
                    allowGrant(
                        "memory-gate-mismatched-workspace-scope",
                        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                        ScopeRef.workspace(tenantId, workspaceId)
                    )
                ),
            "codec.invalid",
            "Authority Workspace Scope is not canonical"
        );
        const workspaceScopeWithoutId = {
            kind: "workspace",
            tenantId,
            projectId: undefined,
            workspaceId: undefined,
            path: [],
            equals: () => false
        } as unknown as ScopeRef;
        expectEagerRejection(
            store,
            (candidate) =>
                candidate.putGrant(
                    allowGrant(
                        "memory-gate-idless-workspace-scope",
                        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                        workspaceScopeWithoutId
                    )
                ),
            "codec.invalid",
            "Authority Workspace Scope is not canonical"
        );
    });

    test("keeps Membership subjects immutable across every subject kind", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const subjectRole = emptyRole("memory-gate-subject-role");
        service.createRole(subjectRole);

        const team = new Team(
            new TeamId("memory-gate-subject-team"),
            tenantId,
            "Subject Team",
            [],
            Revision.initial()
        );
        service.createTeam(team);
        const teamMember = new Membership(
            new MembershipId("memory-gate-subject-team-member"),
            workspaceScope,
            SubjectRef.team(team.id),
            subjectRole.name,
            "active",
            Revision.initial()
        );
        service.assignMembership(teamMember);
        store.transaction((candidate) =>
            candidate.putMembership(
                new Membership(
                    teamMember.id,
                    workspaceScope,
                    teamMember.subject,
                    teamMember.role,
                    "suspended",
                    new Revision(1)
                )
            )
        );
        expect(store.membership(teamMember.id)?.state).toBe("suspended");

        const home = new TenantId("memory-gate-subject-home");
        const guest = new PrincipalId("memory-gate-subject-guest");
        const trust = new GuestTrust(
            new GuestTrustId("memory-gate-subject-trust"),
            tenantId,
            home,
            { kind: "callback", endpoint: "https://memory-gate-subject.example/verify" },
            "active",
            Revision.initial()
        );
        service.createGuestTrust(trust);
        const guestMember = service.assignGuestMembership(
            new Membership(
                new MembershipId("memory-gate-subject-guest-member"),
                workspaceScope,
                SubjectRef.foreign(home, guest, GuestVerificationScheme.callback),
                subjectRole.name,
                "active",
                Revision.initial()
            ),
            new GuestVerification(
                new PrincipalRef(home, guest),
                trust.id,
                trust.revision,
                GuestVerificationScheme.callback,
                Digest.sha256(Uint8Array.of(11)),
                new Date(1),
                new Date(100)
            ),
            new Date(10)
        );
        const immutable =
            "Membership subject and Scope are immutable and updates require the next revision";
        const substitutions = [
            SubjectRef.foreign(
                new TenantId("memory-gate-subject-other-home"),
                guest,
                GuestVerificationScheme.callback
            ),
            SubjectRef.foreign(
                home,
                new PrincipalId("memory-gate-subject-other-guest"),
                GuestVerificationScheme.callback
            ),
            SubjectRef.foreign(home, guest, GuestVerificationScheme.token)
        ];
        for (const subject of substitutions) {
            expectEagerRejection(
                store,
                (candidate) =>
                    candidate.putMembership(
                        new Membership(
                            guestMember.id,
                            workspaceScope,
                            subject,
                            guestMember.role,
                            "active",
                            guestMember.revision.next()
                        )
                    ),
                "protocol.revision-conflict",
                immutable
            );
        }
        const suspendedGuest = service.changeMembership(guestMember.id, {
            role: subjectRole.name,
            state: "suspended"
        });
        expect(suspendedGuest.state).toBe("suspended");
    });

    test("transaction isolation keeps escaped candidates and results inert", { tags: "p0" }, () => {
        const { store } = bootstrapped();
        let captured: AuthorityMutationStore | undefined;
        expect(() =>
            store.transaction((candidate) => {
                captured = candidate;
                throw new TypeError("memory-gate-abort");
            })
        ).toThrow("memory-gate-abort");
        expectAgentCoreError(
            () =>
                expectDefined(captured, "captured candidate").putGrant(
                    allowGrant("memory-gate-escaped")
                ),
            "protocol.invalid-state",
            "Tenant control records can only change inside an owned transaction"
        );

        expect(store.transaction(() => 42)).toBe(42);
        const plainFunction = (): number => 7;
        expect(store.transaction(() => plainFunction)).toBe(plainFunction);
        const functionThenable = new Proxy(() => undefined, {
            has: (_target, key) => key === "then"
        });
        expect(() => store.transaction(() => functionThenable as never)).toThrow(
            "Memory Tenant control transactions must be synchronous"
        );
    });

    test(
        "handles rejected asynchronous transaction results without leaks",
        { tags: "p0" },
        async () => {
            const { store } = bootstrapped();
            const rejections: unknown[] = [];
            const listener = (reason: unknown): void => {
                rejections.push(reason);
            };
            process.on("unhandledRejection", listener);
            try {
                expect(() =>
                    store.transaction(() => Promise.reject(new Error("memory-gate-rejection")))
                ).toThrow("Memory Tenant control transactions must be synchronous");
                await new Promise((resolve) => {
                    setImmediate(resolve);
                });
                await new Promise((resolve) => {
                    setImmediate(resolve);
                });
                expect(rejections).toEqual([]);
            } finally {
                process.removeListener("unhandledRejection", listener);
            }
        }
    );

    // putGrant and putGuestTrust have the same three rules and all three are asserted for
    // them; the Binding copy was not. saveSqliteBinding repeats them word for word, so
    // these are the store contract rather than Memory bookkeeping.
    test("holds new Bindings to generation and revision zero", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const backing = allowGrant("memory-binding-generation");
        service.createGrant(backing);

        expectEagerRejection(
            store,
            (candidate) => {
                candidate.putBinding(bindingAt("generation-ahead", backing.id, 1, 0));
            },
            "protocol.revision-conflict",
            "New Bindings require generation and revision zero"
        );
        expectEagerRejection(
            store,
            (candidate) => {
                candidate.putBinding(bindingAt("revision-ahead", backing.id, 0, 1));
            },
            "protocol.revision-conflict",
            "New Bindings require generation and revision zero"
        );
        expect(store.bindings()).toEqual([]);
    });

    test("replaces a Binding only by its exact successor", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const backing = allowGrant("memory-binding-replacement");
        service.createGrant(backing);
        const binding = bindingAt("replaceable", backing.id, 0, 0);
        store.transaction((candidate) => {
            candidate.putBinding(binding);
        });

        // Rewriting the identical record is the idempotent write both stores short-circuit
        // on. Without that short-circuit the record reaches assertCanReplace and is
        // refused as its own successor.
        store.transaction((candidate) => {
            candidate.putBinding(Binding.decode(Binding.encode(binding)));
        });
        expect(store.binding(binding.key)?.generation).toBe(0);

        expectEagerRejection(
            store,
            (candidate) => {
                candidate.putBinding(bindingAt("replaceable", backing.id, 2, 2));
            },
            "binding.invalid",
            "Binding updates require immutable identity and the next generation and revision"
        );
        expect(store.binding(binding.key)?.generation).toBe(0);
    });

    // The Binding-to-Grant closure is the Memory store's own recomputation of what
    // requireBindingAuthority refuses up front, and it is what makes a restored snapshot
    // trustworthy. Restore is the only way to present it with records the service would
    // never have written, and each operand needs its own snapshot: the message alone does
    // not say which one fired.
    test("refuses a restored Binding its Grant does not authorize", { tags: "p0" }, () => {
        const { store, service } = bootstrapped();
        const backing = allowGrant("memory-closure-grant");
        service.createGrant(backing);
        const stranger = new PrincipalId("memory-closure-stranger");
        service.createPrincipal(new Principal(stranger, "user", "active"));
        service.createBinding(bindingAt("closure", backing.id, 0, 0));
        const snapshot = store.snapshot();
        const rewrite = (grant: Grant): MemoryTenantControlSnapshot =>
            withGrantBytes(snapshot, backing.id.value, Grant.encode(grant));

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    grants: snapshot.grants.filter((entry) => entry.id !== backing.id.value)
                }),
            "codec.invalid",
            "Binding references invalid Tenant authority"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    rewrite(
                        new Grant(
                            backing.id,
                            backing.scope,
                            backing.subject,
                            "deny",
                            backing.capability,
                            { kind: "direct" }
                        )
                    )
                ),
            "codec.invalid",
            "Binding references invalid Tenant authority"
        );
        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore(
                    rewrite(
                        new Grant(
                            backing.id,
                            backing.scope,
                            SubjectRef.principal(new PrincipalRef(tenantId, stranger)),
                            "allow",
                            backing.capability,
                            { kind: "direct" }
                        )
                    )
                ),
            "codec.invalid",
            "Binding references invalid Tenant authority"
        );
        expect(MemoryTenantControlStore.restore(snapshot).bindings()).toHaveLength(1);
    });

    // The lineage walk seeds its visited set with the Grant it starts from, so a Grant
    // reachable from itself is reported as a cycle on the hop that closes it. Seeded
    // empty, the walk takes one more hop before recognising the same loop, and that hop
    // asks a question the loop never intended: whether the child attenuates its own
    // parent. Where it does not — a broad Tenant Grant over a narrow Workspace one — the
    // store would report a broken lineage for a Grant set whose actual fault is the cycle.
    test("names a cycle rather than the lineage hop it closes on", { tags: "p0" }, () => {
        const snapshot = bootstrapped().store.snapshot();
        const narrow = allowGrant(
            "cycle-a",
            principal,
            workspaceScope,
            capability(["observe"], "workspace:mail.*"),
            new GrantId("cycle-b")
        );
        const broad = allowGrant(
            "cycle-b",
            principal,
            tenantScope,
            capability(["observe"], "*"),
            new GrantId("cycle-a")
        );
        expect(broad.canAttenuate(narrow)).toBe(true);
        expect(narrow.canAttenuate(broad)).toBe(false);

        expectAgentCoreError(
            () =>
                MemoryTenantControlStore.restore({
                    ...snapshot,
                    grants: [
                        ...snapshot.grants,
                        { id: narrow.id.value, bytes: Grant.encode(narrow) },
                        { id: broad.id.value, bytes: Grant.encode(broad) }
                    ]
                }),
            "codec.invalid",
            "Delegated Grant attenuation contains a cycle"
        );
    });
});

function bindingAt(name: string, grantId: GrantId, generation: number, revision: number): Binding {
    return new Binding(
        workspaceScope,
        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
        new ProtectionDomain("backend", "memory-gate", "no-secrets"),
        new BindingName(name),
        grantId,
        new FacetRef("workspace:memory.gate"),
        generation,
        "active",
        new Revision(revision)
    );
}

function bootstrapped(): { store: MemoryTenantControlStore; service: AuthorityMutationService } {
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    service.createProject(
        new Project(projectId, tenantId, "Mutation gate Project", Revision.initial())
    );
    service.createWorkspace(new Workspace(workspaceId, tenantId, projectId, Revision.initial()));
    return { store, service };
}

function observeRole(name: string): Role {
    return new Role(new RoleName(name), [
        new RoleRule("allow", new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }))
    ]);
}

function emptyRole(name: string): Role {
    return new Role(new RoleName(name), []);
}

function roleGrantOf(store: MemoryTenantControlStore, membershipId: MembershipId): Grant {
    return expectDefined(
        store
            .grants()
            .find(
                (grant) =>
                    grant.origin.kind === "role" && grant.origin.membershipId.equals(membershipId)
            ),
        "role grant"
    );
}

function markerOf(snapshot: MemoryTenantControlSnapshot): {
    readonly tenantId: TenantId;
    readonly ownerPrincipalId: PrincipalId;
    readonly revision: number;
} {
    if (snapshot.marker === null) throw new Error("Expected bootstrap marker");
    return snapshot.marker;
}

function withoutIdentity(
    snapshot: MemoryTenantControlSnapshot,
    reject: (record: StoredIdentityRecord) => boolean
): MemoryTenantControlSnapshot {
    return {
        ...snapshot,
        identity: {
            ...snapshot.identity,
            records: snapshot.identity.records.filter((record) => !reject(record))
        }
    };
}

function withIdentityRecord(
    snapshot: MemoryTenantControlSnapshot,
    record: StoredIdentityRecord
): MemoryTenantControlSnapshot {
    return {
        ...snapshot,
        identity: {
            ...snapshot.identity,
            records: [...snapshot.identity.records, record]
        }
    };
}

function replaceIdentityBytes(
    snapshot: MemoryTenantControlSnapshot,
    kind: StoredIdentityRecord["kind"],
    id: string,
    bytes: Uint8Array
): MemoryTenantControlSnapshot {
    return {
        ...snapshot,
        identity: {
            ...snapshot.identity,
            records: snapshot.identity.records.map((record) =>
                record.kind === kind && record.id === id ? { kind, id, bytes } : record
            )
        }
    };
}

function withGrantBytes(
    snapshot: MemoryTenantControlSnapshot,
    id: string,
    bytes: Uint8Array
): MemoryTenantControlSnapshot {
    return {
        ...snapshot,
        grants: snapshot.grants.map((entry) => (entry.id === id ? { id, bytes } : entry))
    };
}

function expectDefined<Value>(value: Value | undefined, label: string): Value {
    if (value === undefined) throw new Error(`Expected ${label}`);
    return value;
}

function expectAgentCoreError(
    action: () => unknown,
    code: AgentCoreErrorCode,
    message: string
): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentCoreError);
    expect(thrown).toMatchObject({ code, message });
}

function expectEagerRejection(
    store: MemoryTenantControlStore,
    operation: (candidate: AuthorityMutationStore) => void,
    code: AgentCoreErrorCode,
    message: string
): void {
    let completed = false;
    expectAgentCoreError(
        () =>
            store.transaction((candidate) => {
                operation(candidate);
                completed = true;
            }),
        code,
        message
    );
    expect(completed).toBe(false);
}

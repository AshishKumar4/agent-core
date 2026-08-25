import { describe, expect, test } from "vitest";
import { violating } from "../helpers/malformed";
import { ActorId } from "../../src/actors";
import { Digest, Revision } from "../../src/core";
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
    ShareOffer,
    ShareOfferId,
    ShareOfferRedemption,
    SubjectRef,
    Team,
    TeamId,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { mintGuestVerification, Workspace } from "../identity/internal-fixture";
import { Binding } from "../../src/authority/binding";
import {
    AuthorityChangeSet,
    AuthorityRecordChanges,
    assertAuthorityClosure
} from "../../src/authority/closure";
import { ScopeEpoch } from "../../src/authority/epoch";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { scopeKey } from "../../src/authority/reference";
import { AuthorityMutationService } from "../../src/authority/service";
import { AuthorityDivergence, DivergentAuthorityStore } from "./divergent-store";

const tenantId = new TenantId("closure-gate-tenant");
const foreignTenantId = new TenantId("closure-gate-foreign");
const guestHome = new TenantId("closure-gate-guest-home");
const ownerId = new PrincipalId("closure-gate-owner");
const memberId = new PrincipalId("closure-gate-member");
const guestId = new PrincipalId("closure-gate-guest");
const ghostId = new PrincipalId("closure-gate-ghost");
const workspaceId = new WorkspaceId("closure-gate-workspace");
const projectId = new ProjectId("closure-gate-project");
const tenantScope = ScopeRef.tenant(tenantId);
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const memberSubject = SubjectRef.principal(new PrincipalRef(tenantId, memberId));
const ghostSubject = SubjectRef.principal(new PrincipalRef(tenantId, ghostId));
const observe = new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] });
const observeAndMutate = new CapabilitySpec({ facetPattern: "*", impacts: ["observe", "mutate"] });
const readerName = new RoleName("closure-gate-reader");
const anchor = Object.freeze({
    actorId: new ActorId("closure-gate-actor"),
    tenantId,
    principalId: ownerId,
    trustAnchor: Uint8Array.of(7, 7, 7)
});

describe("AuthorityRecordChanges", () => {
    test("separates what a transaction created from what it replaced", { tags: "p0" }, () => {
        const changes = new AuthorityRecordChanges<string>();
        changes.record("created", "only", "created");
        changes.record("replaced", "before", "replaced");
        changes.record("replaced", "after", "replaced");
        // Created and then replaced inside one transaction is still created by it: what
        // can point at such a record is exactly what the same transaction wrote, which is
        // the whole reason the distinction is kept.
        changes.record("both", "new", "created");
        changes.record("both", "revised", "replaced");

        expect(changes.written()).toEqual(["only", "after", "revised"]);
        expect(changes.replaced()).toEqual(["after"]);
        expect(changes.isCreated("created")).toBe(true);
        expect(changes.isCreated("both")).toBe(true);
        expect(changes.isCreated("replaced")).toBe(false);
        expect(changes.isCreated("absent")).toBe(false);
    });
});

describe("Tenant authority closure canonical Scopes", () => {
    test("refuses a Scope naming a Project the Tenant does not hold", { tags: "p0" }, () => {
        const absent = ScopeRef.project(tenantId, new ProjectId("closure-gate-absent-project"));

        expect(() => assertAuthorityClosure(withEpoch(absent))).toThrow(
            corrupt("Authority Project Scope is not canonical")
        );
    });

    test("refuses a Project Scope carrying no Project ID", { tags: "p0" }, () => {
        expect(() => assertAuthorityClosure(withGrantScope(idlessScope("project")))).toThrow(
            corrupt("Authority Project Scope is not canonical")
        );
    });

    test("refuses a Scope naming a Workspace the Tenant does not hold", { tags: "p0" }, () => {
        const absent = ScopeRef.workspace(tenantId, new WorkspaceId("closure-gate-absent"));

        expect(() => assertAuthorityClosure(withEpoch(absent))).toThrow(
            corrupt("Authority Workspace Scope is not canonical")
        );
    });

    test("refuses a Workspace Scope the Workspace does not carry", { tags: "p0" }, () => {
        // The Workspace sits directly under the Tenant; this Scope claims a Project path
        // to it, which is a different Scope and so a different epoch and a different
        // authority path.
        const mismatched = ScopeRef.workspace(tenantId, projectId, workspaceId);

        expect(() => assertAuthorityClosure(withEpoch(mismatched))).toThrow(
            corrupt("Authority Workspace Scope is not canonical")
        );
    });

    test("refuses a Workspace Scope carrying no Workspace ID", { tags: "p0" }, () => {
        expect(() => assertAuthorityClosure(withGrantScope(idlessScope("workspace")))).toThrow(
            corrupt("Authority Workspace Scope is not canonical")
        );
    });
});

describe("Tenant authority closure incremental audit", () => {
    // The incremental audit exists because a transaction cannot break a record it did not
    // touch. Each case plants one broken record in a table and names no change at all: a
    // sweep finds it and an incremental audit must not, so an audit that quietly swept
    // would answer differently on the two calls below.
    test("judges the records a transaction wrote, not the whole store", { tags: "p0" }, () => {
        for (const table of brokenTables()) {
            const { store } = open();
            const divergence = new AuthorityDivergence();
            table.plant(divergence);
            const divergent = new DivergentAuthorityStore(store, divergence);

            expect(() => assertAuthorityClosure(divergent), table.name).toThrow(table.fault);
            expect(
                () => assertAuthorityClosure(divergent, new AuthorityChangeSet()),
                table.name
            ).not.toThrow();
        }
    });

    test("reads no record list to audit records a transaction created", { tags: "p0" }, () => {
        const { store, service } = open();
        const member = membership("closure-gate-created", workspaceScope);
        service.assignMembership(member);
        const owned = roleGrantsOf(store, member);
        expect(owned).toHaveLength(1);
        const divergence = new AuthorityDivergence();
        const divergent = new DivergentAuthorityStore(store, divergence);
        const changed = new AuthorityChangeSet();
        changed.memberships.record(member.id.value, member, "created");
        for (const grant of owned) changed.grants.record(grant.id.value, grant, "created");

        expect(() => assertAuthorityClosure(divergent, changed)).not.toThrow();

        // Nothing in the store can point at a record that did not exist when the
        // transaction opened, so an audit of creations searches for nothing.
        expect(divergence.teams.reads).toBe(0);
        expect(divergence.projects.reads).toBe(0);
        expect(divergence.workspaces.reads).toBe(0);
        expect(divergence.guestTrusts.reads).toBe(0);
        expect(divergence.memberships.reads).toBe(0);
        expect(divergence.grants.reads).toBe(0);
        expect(divergence.bindings.reads).toBe(0);
        expect(divergence.shareOffers.reads).toBe(0);
        expect(divergence.epochs.reads).toBe(0);
    });

    test("a rotated guest trust re-audits the guest Memberships on it", { tags: "p0" }, () => {
        const { store, trust } = openGuest();
        const divergence = new AuthorityDivergence();
        divergence.roles.absent(readerName.value);
        const changed = new AuthorityChangeSet();
        changed.guestTrusts.record(trust.id.value, trust, "replaced");

        // The guest Membership is not written and holds no materialized Grant, so the
        // rotated trust is the only thing that reaches it — and the Role guard inside
        // assertMembership is the only guard that judges it.
        expect(() =>
            assertAuthorityClosure(new DivergentAuthorityStore(store, divergence), changed)
        ).toThrow(corrupt("Membership references a missing Role"));
    });

    test("a rotated guest trust re-audits only the Memberships on it", { tags: "p1" }, () => {
        const { store, trust } = openGuest();
        const divergence = new AuthorityDivergence();
        divergence.memberships.answer(
            "closure-gate-stray-member",
            membership("closure-gate-stray-member", ScopeRef.tenant(foreignTenantId), {
                subject: SubjectRef.principal(new PrincipalRef(foreignTenantId, memberId))
            })
        );
        const changed = new AuthorityChangeSet();
        changed.guestTrusts.record(trust.id.value, trust, "replaced");

        expect(() =>
            assertAuthorityClosure(new DivergentAuthorityStore(store, divergence), changed)
        ).not.toThrow();
    });

    test("a replaced Role re-materializes the Memberships holding it", { tags: "p0" }, () => {
        const { store, service, reader } = open();
        const member = membership("closure-gate-role-holder", workspaceScope);
        service.assignMembership(member);
        const divergence = new AuthorityDivergence();
        divergence.roles.absent(readerName.value);
        const changed = new AuthorityChangeSet();
        changed.roles.record(readerName.value, reader, "replaced");

        // Nothing writes this Membership, so the replaced Role is the only thing that
        // reaches it, and the Role guard inside assertMaterialization is the only guard
        // that judges it. The one inside assertMembership never runs.
        expect(() =>
            assertAuthorityClosure(new DivergentAuthorityStore(store, divergence), changed)
        ).toThrow(corrupt("Membership references a missing Role"));
    });

    test("a replaced Role re-materializes only the Memberships holding it", { tags: "p1" }, () => {
        const { store, service } = open();
        const member = membership("closure-gate-unrelated-holder", workspaceScope);
        service.assignMembership(member);
        const spare = new Role(new RoleName("closure-gate-spare"), [
            new RoleRule("allow", observe)
        ]);
        service.createRole(spare);
        const divergence = new AuthorityDivergence();
        // This Membership would fail materialization if anything audited it.
        for (const grant of roleGrantsOf(store, member)) divergence.grants.absent(grant.id.value);
        const changed = new AuthorityChangeSet();
        changed.roles.record(spare.name.value, spare, "replaced");

        expect(() =>
            assertAuthorityClosure(new DivergentAuthorityStore(store, divergence), changed)
        ).not.toThrow();
    });

    test("a replaced Grant re-audits the Bindings resting on it", { tags: "p0" }, () => {
        const { store, service } = open();
        const allow = directGrant("closure-gate-bound", workspaceScope);
        service.createGrant(allow);
        service.createBinding(bindingOn("closure-gate-bound-binding", allow.id));
        const denied = new Grant(allow.id, workspaceScope, memberSubject, "deny", observe, {
            kind: "direct"
        });
        const divergence = new AuthorityDivergence();
        divergence.grants.answer(allow.id.value, denied);
        const changed = new AuthorityChangeSet();
        changed.grants.record(allow.id.value, denied, "replaced");

        // The Binding is not written and stays exactly as it was; what broke it is the
        // Grant underneath it, so the replacement has to reach it.
        expect(() =>
            assertAuthorityClosure(new DivergentAuthorityStore(store, divergence), changed)
        ).toThrow(corrupt("Binding references invalid Tenant authority"));
    });

    test("a replaced Grant re-audits only the Bindings resting on it", { tags: "p1" }, () => {
        const { store, service } = open();
        const allow = directGrant("closure-gate-unbound", workspaceScope);
        service.createGrant(allow);
        const divergence = new AuthorityDivergence();
        const stray = bindingOn("closure-gate-stray-binding", new GrantId("closure-gate-absent"));
        divergence.bindings.answer(stray.key, stray);
        const changed = new AuthorityChangeSet();
        changed.grants.record(allow.id.value, allow.revoke(), "replaced");

        expect(() =>
            assertAuthorityClosure(new DivergentAuthorityStore(store, divergence), changed)
        ).not.toThrow();
    });

    test("does not re-read a replaced Grant as its own descendant", { tags: "p0" }, () => {
        const { store, service } = open();
        const parent = directGrant("closure-gate-parent", tenantScope, observeAndMutate);
        service.createGrant(parent);
        const child = new Grant(
            new GrantId("closure-gate-child"),
            workspaceScope,
            memberSubject,
            "allow",
            observe,
            { kind: "direct" },
            parent.id
        );
        service.createGrant(child);
        const divergence = new AuthorityDivergence();
        // The store answers for the child with a record naming a Principal it does not
        // hold. The transaction replaced that child itself, so the audit judges what the
        // transaction wrote — the store's answer is reached only by walking down into it.
        divergence.grants.answer(
            child.id.value,
            new Grant(
                child.id,
                workspaceScope,
                ghostSubject,
                "allow",
                observe,
                { kind: "direct" },
                parent.id
            )
        );
        const changed = new AuthorityChangeSet();
        changed.grants.record(parent.id.value, parent, "replaced");
        changed.grants.record(child.id.value, child, "replaced");

        expect(() =>
            assertAuthorityClosure(new DivergentAuthorityStore(store, divergence), changed)
        ).not.toThrow();
    });

    test("a Membership created in the transaction owns only its writes", { tags: "p0" }, () => {
        const { store, service } = open();
        const member = membership("closure-gate-owner-member", workspaceScope);
        service.assignMembership(member);
        const owned = roleGrantsOf(store, member);
        const divergence = new AuthorityDivergence();
        // A Grant the store reports for this Membership that the transaction never wrote.
        // A Membership that did not exist when the transaction opened cannot be named by
        // one, so the audit reads its Grants out of the writes rather than the table.
        divergence.grants.answer(
            "closure-gate-phantom-role",
            new Grant(
                new GrantId("closure-gate-phantom-role"),
                workspaceScope,
                memberSubject,
                "allow",
                observe,
                {
                    kind: "role",
                    membershipId: member.id,
                    roleName: readerName.value,
                    ruleOrdinal: 3,
                    guest: false
                }
            )
        );
        const changed = new AuthorityChangeSet();
        changed.memberships.record(member.id.value, member, "created");
        for (const grant of owned) changed.grants.record(grant.id.value, grant, "created");

        expect(() =>
            assertAuthorityClosure(new DivergentAuthorityStore(store, divergence), changed)
        ).not.toThrow();
    });
});

describe("Tenant authority closure audits every written record", () => {
    test("audits every Membership a transaction wrote", { tags: "p0" }, () => {
        const { store, service } = open();
        const sound = membership("closure-gate-sound-member", workspaceScope);
        service.assignMembership(sound);
        const changed = new AuthorityChangeSet();
        changed.memberships.record(
            "closure-gate-foreign-member",
            membership("closure-gate-foreign-member", ScopeRef.tenant(foreignTenantId), {
                subject: SubjectRef.principal(new PrincipalRef(foreignTenantId, memberId))
            }),
            "replaced"
        );
        changed.memberships.record(sound.id.value, sound, "replaced");

        expect(() => assertAuthorityClosure(store, changed)).toThrow(
            boundary("Authority Scope belongs to another Tenant")
        );
    });

    test("re-materializes every Membership a transaction wrote", { tags: "p0" }, () => {
        const { store, service } = open();
        const sound = membership("closure-gate-material-member", workspaceScope);
        service.assignMembership(sound);
        const changed = new AuthorityChangeSet();
        // Canonical, with an existing Role and Principal, so only materialization can
        // fault it: it owns no Role Grant at all.
        changed.memberships.record(
            "closure-gate-bare-member",
            membership("closure-gate-bare-member", workspaceScope),
            "replaced"
        );
        changed.memberships.record(sound.id.value, sound, "replaced");

        expect(() => assertAuthorityClosure(store, changed)).toThrow(
            corrupt("Role Grant materialization does not match Membership evidence")
        );
    });

    test("audits every Grant a transaction wrote", { tags: "p0" }, () => {
        const { store } = open();
        const changed = new AuthorityChangeSet();
        changed.grants.record(
            "closure-gate-ghost-grant",
            new Grant(
                new GrantId("closure-gate-ghost-grant"),
                workspaceScope,
                ghostSubject,
                "allow",
                observe,
                { kind: "direct" }
            ),
            "replaced"
        );
        const sound = directGrant("closure-gate-sound-grant", workspaceScope);
        changed.grants.record(sound.id.value, sound, "replaced");

        expect(() => assertAuthorityClosure(store, changed)).toThrow(
            corrupt("Grant references a missing Principal")
        );
    });

    test("audits every Binding a transaction wrote", { tags: "p0" }, () => {
        const { store, service } = open();
        const allow = directGrant("closure-gate-binding-grant", workspaceScope);
        service.createGrant(allow);
        const changed = new AuthorityChangeSet();
        changed.bindings.record(
            "closure-gate-ghost-binding",
            bindingOn("closure-gate-ghost-binding", new GrantId("closure-gate-absent-grant")),
            "replaced"
        );
        const sound = bindingOn("closure-gate-sound-binding", allow.id);
        changed.bindings.record(sound.key, sound, "replaced");

        expect(() => assertAuthorityClosure(store, changed)).toThrow(
            corrupt("Binding references invalid Tenant authority")
        );
    });
});

describe("Tenant authority closure record evidence", () => {
    test("refuses a Role Grant whose subject left its Membership", { tags: "p0" }, () => {
        const { store, service } = open();
        const member = membership("closure-gate-evidence-member", workspaceScope);
        service.assignMembership(member);
        const [live] = roleGrantsOf(store, member);
        if (live === undefined) throw new TypeError("no Role Grant");
        const divergence = new AuthorityDivergence();
        divergence.grants.answer(
            live.id.value,
            new Grant(
                live.id,
                live.scope,
                SubjectRef.principal(new PrincipalRef(tenantId, ownerId)),
                live.effect,
                live.capability,
                live.origin
            )
        );

        expect(() =>
            assertAuthorityClosure(new DivergentAuthorityStore(store, divergence))
        ).toThrow(corrupt("Role Grant references invalid Membership evidence"));
    });

    test(
        "refuses a share offer redemption that names no Membership of its own holder",
        { tags: "p0" },
        () => {
            const { store, service } = open();
            const member = membership("closure-gate-offer-member", workspaceScope);
            service.assignMembership(member);
            const fault = corrupt("Share offer redemption references invalid Membership evidence");

            for (const broken of [
                shareOffer("closure-gate-absent-membership", readerName, [
                    new ShareOfferRedemption(
                        memberSubject,
                        new MembershipId("closure-gate-never-minted"),
                        new Date(150)
                    )
                ]),
                shareOffer("closure-gate-stray-holder", readerName, [
                    new ShareOfferRedemption(ghostSubject, member.id, new Date(150))
                ])
            ]) {
                expect(
                    () => assertAuthorityClosure(store, wroteOffer(broken)),
                    broken.id.value
                ).toThrow(fault);
            }

            const sound = shareOffer("closure-gate-sound-offer", readerName, [
                new ShareOfferRedemption(memberSubject, member.id, new Date(150))
            ]);
            expect(() => assertAuthorityClosure(store, wroteOffer(sound))).not.toThrow();
        }
    );
});

function corrupt(message: string): ReturnType<typeof expect.objectContaining> {
    return expect.objectContaining({ code: "codec.invalid", message });
}

function boundary(message: string): ReturnType<typeof expect.objectContaining> {
    return expect.objectContaining({ code: "protocol.invalid-state", message });
}

/** One broken record per table, each faulting through its own guard. */
function brokenTables(): readonly {
    readonly name: string;
    readonly fault: unknown;
    readonly plant: (divergence: AuthorityDivergence) => void;
}[] {
    return [
        {
            name: "teams",
            fault: corrupt("Team references a missing Principal"),
            plant: (divergence) =>
                divergence.teams.answer(
                    "closure-gate-team",
                    new Team(
                        new TeamId("closure-gate-team"),
                        tenantId,
                        "Ghost",
                        [ghostId],
                        Revision.initial()
                    )
                )
        },
        {
            name: "projects",
            fault: boundary("Project belongs to another Tenant"),
            plant: (divergence) =>
                divergence.projects.answer(
                    "closure-gate-foreign-project",
                    new Project(
                        new ProjectId("closure-gate-foreign-project"),
                        foreignTenantId,
                        "Foreign",
                        Revision.initial()
                    )
                )
        },
        {
            name: "workspaces",
            fault: boundary("Workspace belongs to another Tenant"),
            plant: (divergence) =>
                divergence.workspaces.answer(
                    "closure-gate-foreign-workspace",
                    new Workspace(
                        new WorkspaceId("closure-gate-foreign-workspace"),
                        foreignTenantId,
                        undefined,
                        Revision.initial()
                    )
                )
        },
        {
            name: "guest trusts",
            fault: boundary("Guest trust belongs to another Tenant"),
            plant: (divergence) =>
                divergence.guestTrusts.answer(
                    "closure-gate-foreign-trust",
                    new GuestTrust(
                        new GuestTrustId("closure-gate-foreign-trust"),
                        foreignTenantId,
                        guestHome,
                        { kind: "callback", endpoint: "https://foreign.example/verify" },
                        "active",
                        Revision.initial()
                    )
                )
        },
        {
            name: "Scope epochs",
            fault: boundary("Authority Scope belongs to another Tenant"),
            plant: (divergence) => {
                const scope = ScopeRef.tenant(foreignTenantId);
                divergence.epochs.answer(scopeKey(scope), new ScopeEpoch(scope, 1));
            }
        },
        {
            name: "memberships",
            fault: boundary("Authority Scope belongs to another Tenant"),
            plant: (divergence) =>
                divergence.memberships.answer(
                    "closure-gate-foreign-membership",
                    membership(
                        "closure-gate-foreign-membership",
                        ScopeRef.tenant(foreignTenantId),
                        {
                            subject: SubjectRef.principal(
                                new PrincipalRef(foreignTenantId, memberId)
                            )
                        }
                    )
                )
        },
        {
            name: "materialized memberships",
            fault: corrupt("Role Grant materialization does not match Membership evidence"),
            plant: (divergence) =>
                divergence.memberships.answer(
                    "closure-gate-bare-membership",
                    membership("closure-gate-bare-membership", workspaceScope)
                )
        },
        {
            name: "grants",
            fault: corrupt("Grant references a missing Principal"),
            plant: (divergence) =>
                divergence.grants.answer(
                    "closure-gate-ghost-grant",
                    new Grant(
                        new GrantId("closure-gate-ghost-grant"),
                        workspaceScope,
                        ghostSubject,
                        "allow",
                        observe,
                        { kind: "direct" }
                    )
                )
        },
        {
            name: "bindings",
            fault: corrupt("Binding references invalid Tenant authority"),
            plant: (divergence) => {
                const stray = bindingOn(
                    "closure-gate-ghost-binding",
                    new GrantId("closure-gate-absent-grant")
                );
                divergence.bindings.answer(stray.key, stray);
            }
        },
        {
            name: "share offers",
            fault: corrupt("Share offer references a missing Role"),
            plant: (divergence) =>
                divergence.shareOffers.answer(
                    "closure-gate-roleless-offer",
                    shareOffer(
                        "closure-gate-roleless-offer",
                        new RoleName("closure-gate-absent-role")
                    )
                )
        }
    ];
}

function shareOffer(
    id: string,
    role: RoleName,
    redemptions: readonly ShareOfferRedemption[] = []
): ShareOffer {
    return new ShareOffer(
        new ShareOfferId(id),
        workspaceScope,
        role,
        Digest.sha256(Uint8Array.of(11, 13)),
        new Date(100),
        new Date(200),
        2,
        redemptions,
        "open",
        Revision.initial()
    );
}

function wroteOffer(offer: ShareOffer): AuthorityChangeSet {
    const changed = new AuthorityChangeSet();
    changed.shareOffers.record(offer.id.value, offer, "created");
    return changed;
}

/** A store whose Scope epoch table answers with one epoch on `scope`. */
function withEpoch(scope: ScopeRef): DivergentAuthorityStore {
    const divergence = new AuthorityDivergence();
    divergence.epochs.answer(scopeKey(scope), new ScopeEpoch(scope, 1));
    return new DivergentAuthorityStore(open().store, divergence);
}

/** A store whose Grant table answers with one Grant on `scope`. */
function withGrantScope(scope: ScopeRef): DivergentAuthorityStore {
    const divergence = new AuthorityDivergence();
    divergence.grants.answer(
        "closure-gate-scoped-grant",
        new Grant(
            new GrantId("closure-gate-scoped-grant"),
            scope,
            memberSubject,
            "allow",
            observe,
            { kind: "direct" }
        )
    );
    return new DivergentAuthorityStore(open().store, divergence);
}

/**
 * A Scope of `kind` carrying none of the ids that kind requires. ScopeRef's factories
 * cannot build one, so only a counterfeit reaches the guard that refuses it.
 */
function idlessScope(kind: "project" | "workspace"): ScopeRef {
    return violating<ScopeRef>({
        kind,
        tenantId,
        projectId: undefined,
        workspaceId: undefined,
        path: [],
        equals: () => false
    });
}

function membership(
    id: string,
    scope: ScopeRef,
    options: { readonly subject?: SubjectRef } = {}
): Membership {
    return new Membership(
        new MembershipId(id),
        scope,
        options.subject ?? memberSubject,
        readerName,
        "active",
        Revision.initial()
    );
}

function directGrant(id: string, scope: ScopeRef, spec: CapabilitySpec = observe): Grant {
    return new Grant(new GrantId(id), scope, memberSubject, "allow", spec, { kind: "direct" });
}

function bindingOn(name: string, grantId: GrantId): Binding {
    return Binding.active(
        workspaceScope,
        memberSubject,
        new ProtectionDomain("backend", name, "no-secrets"),
        new BindingName(name),
        grantId,
        new FacetRef(`workspace:${name}`)
    );
}

function roleGrantsOf(store: MemoryTenantControlStore, member: Membership): readonly Grant[] {
    return store
        .grants()
        .filter(
            (grant) => grant.origin.kind === "role" && grant.origin.membershipId.equals(member.id)
        );
}

/** A bootstrapped Tenant with its mutation service and a reader Role. */
type ClosureFixture = {
    readonly store: MemoryTenantControlStore;
    readonly service: AuthorityMutationService;
    readonly reader: Role;
};

function open(): ClosureFixture {
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    const reader = new Role(readerName, [new RoleRule("allow", observe)]);
    service.createPrincipal(new Principal(memberId, "user", "active"));
    service.createWorkspace(new Workspace(workspaceId, tenantId, undefined, Revision.initial()));
    service.createRole(reader);
    return { store, service, reader };
}

/** The same Tenant with a guest trust recorded against it. */
type GuestClosureFixture = {
    readonly store: MemoryTenantControlStore;
    readonly service: AuthorityMutationService;
    readonly trust: GuestTrust;
};

function openGuest(): GuestClosureFixture {
    const { store, service } = open();
    const trust = new GuestTrust(
        new GuestTrustId("closure-gate-trust"),
        tenantId,
        guestHome,
        { kind: "callback", endpoint: "https://closure-gate.example/verify" },
        "active",
        Revision.initial()
    );
    service.createGuestTrust(trust);
    service.assignGuestMembership(
        new Membership(
            new MembershipId("closure-gate-guest-member"),
            workspaceScope,
            SubjectRef.foreign(guestHome, guestId, GuestVerificationScheme.callback),
            readerName,
            "active",
            Revision.initial()
        ),
        mintGuestVerification(
            new PrincipalRef(guestHome, guestId),
            trust.id,
            trust.revision,
            GuestVerificationScheme.callback,
            Digest.sha256(Uint8Array.of(3)),
            new Date(100),
            new Date(400)
        ),
        new Date(150)
    );
    return { store, service, trust };
}

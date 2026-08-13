import { Database } from "bun:sqlite";
import { describe, expect, test } from "vitest";
import { ActorId, requireSynchronousResult, type SynchronousResultGuard } from "../../src/actors";
import { Revision } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    Membership,
    MembershipId,
    Principal,
    PrincipalId,
    Role,
    RoleName,
    RoleRule,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { PrincipalRef, Workspace } from "../identity/internal-fixture";
import { Binding } from "../../src/authority/binding";
import { AuthorityChangeSet, assertAuthorityClosure } from "../../src/authority/closure";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import {
    AuthorityMutationService,
    type AuthorityMutationStore,
    type AuthorityReadStore
} from "../../src/authority/service";
import {
    TransactionalSqlite,
    createSqliteTenantControlStore,
    type SqliteRow,
    type SqliteValue
} from "../../src/substrates";
import { AuthorityDivergence, DivergentAuthorityStore } from "./divergent-store";

const tenantId = new TenantId("closure-tenant");
const ownerId = new PrincipalId("closure-owner");
const workspaceId = new WorkspaceId("closure-workspace");
const otherWorkspaceId = new WorkspaceId("closure-other-workspace");
const tenantScope = ScopeRef.tenant(tenantId);
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const otherWorkspaceScope = ScopeRef.workspace(tenantId, otherWorkspaceId);
const anchor = {
    actorId: new ActorId("closure-actor"),
    tenantId,
    principalId: ownerId,
    trustAnchor: Uint8Array.of(9, 9, 9)
};
const ownerSubject = SubjectRef.principal(new PrincipalRef(tenantId, ownerId));
const strangerId = new PrincipalId("closure-stranger");
const strangerSubject = SubjectRef.principal(new PrincipalRef(tenantId, strangerId));
const observe = new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] });
const observeAndMutate = new CapabilitySpec({ facetPattern: "*", impacts: ["observe", "mutate"] });

/**
 * One suite over both backings. The closure is a function over the store read surface, so
 * the same states and the same expected faults apply to a Memory snapshot and a durable
 * ledger alike — a divergence between them is a failure here rather than a gap nobody sees.
 */
describe.each([
    { name: "memory", open: openMemory },
    { name: "SQLite", open: openSqlite }
])("Tenant authority record closure: $name [authority-mutation-store]", (backing) => {
    test("refuses every Binding its Grant does not cover", { tags: "p0" }, () => {
        const { store, service } = backing.open();
        const backingGrant = directGrant("closure-backing", workspaceScope, ownerSubject);
        const deny = new Grant(
            new GrantId("closure-deny"),
            workspaceScope,
            ownerSubject,
            "deny",
            observe,
            { kind: "direct" }
        );
        const revoked = directGrant("closure-revoked", workspaceScope, ownerSubject);
        const elsewhere = directGrant("closure-elsewhere", otherWorkspaceScope, ownerSubject);
        const stranger = directGrant("closure-stranger-grant", workspaceScope, strangerSubject);
        service.createGrant(backingGrant);
        service.createGrant(deny);
        service.createGrant(revoked);
        service.createGrant(elsewhere);
        service.createGrant(stranger);
        service.revokeGrant(revoked.id);

        for (const [reason, grantId] of [
            ["absent", new GrantId("closure-absent")],
            ["revoked", revoked.id],
            ["deny", deny.id],
            ["another subject", stranger.id],
            ["another Workspace path", elsewhere.id]
        ] as const) {
            const candidate = bindingOn(`closure-binding-${grantId.value}`, grantId, ownerSubject);
            expect(() => service.createBinding(candidate), reason).toThrow(AgentCoreError);
            expect(store.binding(candidate.key), reason).toBeUndefined();
        }

        const accepted = bindingOn("closure-accepted", backingGrant.id, ownerSubject);
        expect(service.createBinding(accepted).grantId.value).toBe(backingGrant.id.value);
        expect(store.bindings().map((binding) => binding.key)).toEqual([accepted.key]);
    });

    test("refuses a Grant graph that attenuates in a cycle", { tags: "p0" }, () => {
        const { store } = backing.open();
        const { divergent, divergence } = cyclicGrants(store);

        expect(() => assertAuthorityClosure(divergent)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Delegated Grant attenuation contains a cycle"
            })
        );
        expect(divergence.grants.reads).toBeLessThan(divergence.grants.budget);
    });

    test("refuses a Binding whose Grant later denies", { tags: "p0" }, () => {
        const { store, service } = backing.open();
        const allow = directGrant("closure-flip", workspaceScope, ownerSubject);
        service.createGrant(allow);
        const binding = bindingOn("closure-flip-binding", allow.id, ownerSubject);
        service.createBinding(binding);
        const divergence = new AuthorityDivergence();
        divergence.grants.answer(
            allow.id.value,
            new Grant(allow.id, workspaceScope, ownerSubject, "deny", observe, { kind: "direct" })
        );
        const divergent = new DivergentAuthorityStore(store, divergence);

        expect(() => assertAuthorityClosure(divergent)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Binding references invalid Tenant authority"
            })
        );
    });

    test("refuses Role Grants that stopped matching their Membership", { tags: "p0" }, () => {
        const { store, service } = backing.open();
        const role = new Role(new RoleName("closure-reader"), [new RoleRule("allow", observe)]);
        const membership = new Membership(
            new MembershipId("closure-membership"),
            tenantScope,
            ownerSubject,
            role.name,
            "active",
            Revision.initial()
        );
        service.createRole(role);
        service.assignMembership(membership);
        const materialized = store
            .grants()
            .filter(
                (grant) =>
                    grant.origin.kind === "role" && grant.origin.membershipId.equals(membership.id)
            );
        expect(materialized).toHaveLength(1);
        const [live] = materialized;
        if (live === undefined) throw new AgentCoreError("codec.invalid", "no Role Grant");
        const widened = new Grant(
            live.id,
            live.scope,
            live.subject,
            live.effect,
            observeAndMutate,
            live.origin
        );
        const divergence = new AuthorityDivergence();
        divergence.grants.answer(live.id.value, widened);
        const divergent = new DivergentAuthorityStore(store, divergence);

        expect(() => assertAuthorityClosure(divergent)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Role Grant materialization does not match Membership evidence"
            })
        );
    });

    test(
        "reaches the same verdict from a changed record as from a full sweep",
        { tags: "p0" },
        () => {
            const { store, service } = backing.open();
            const parent = directGrant("closure-parent", tenantScope, ownerSubject, {
                capability: observeAndMutate
            });
            service.createGrant(parent);
            const child = new Grant(
                new GrantId("closure-child"),
                workspaceScope,
                ownerSubject,
                "allow",
                observe,
                { kind: "direct" },
                parent.id
            );
            service.createGrant(child);
            // Only the parent is revoked, and only the parent is named as changed: the
            // audit has to walk down to the child whose attenuation the revocation broke.
            const revokedParent = parent.revoke();
            const divergence = new AuthorityDivergence();
            divergence.grants.answer(parent.id.value, revokedParent);
            const divergent = new DivergentAuthorityStore(store, divergence);
            const changed = new AuthorityChangeSet();
            changed.grants.record(parent.id.value, revokedParent, "replaced");
            const fault = expect.objectContaining({
                code: "codec.invalid",
                message: "Delegated Grant references invalid parent authority"
            });

            expect(() => assertAuthorityClosure(divergent)).toThrow(fault);
            expect(() => assertAuthorityClosure(divergent, changed)).toThrow(fault);
        }
    );

    test("accepts a consistent store under both audits", { tags: "p1" }, () => {
        const { store, service } = backing.open();
        const grant = directGrant("closure-clean", workspaceScope, ownerSubject);
        service.createGrant(grant);
        service.createBinding(bindingOn("closure-clean-binding", grant.id, ownerSubject));
        const changed = new AuthorityChangeSet();
        changed.grants.record(grant.id.value, grant, "replaced");

        expect(() => assertAuthorityClosure(store)).not.toThrow();
        expect(() => assertAuthorityClosure(store, changed)).not.toThrow();
        expect(() => assertAuthorityClosure(store, new AuthorityChangeSet())).not.toThrow();
    });
});

/**
 * Each Grant names the other as its attenuation parent. No sequence of writes builds this,
 * because a parent has to exist before its child, so only a store answering with a graph it
 * was never given can present it.
 */
/** A store whose Grant table answers a cycle, with the divergence that produces it. */
type CyclicGrantClosure = {
    readonly divergent: DivergentAuthorityStore;
    readonly divergence: AuthorityDivergence;
};

function cyclicGrants(store: AuthorityMutationStore): CyclicGrantClosure {
    const service = new AuthorityMutationService(store);
    const first = directGrant("closure-cyclic-first", tenantScope, ownerSubject);
    const second = directGrant("closure-cyclic-second", tenantScope, ownerSubject);
    service.createGrant(first);
    service.createGrant(second);
    const divergence = new AuthorityDivergence();
    divergence.grants
        .answer(first.id.value, attenuating(first, second.id))
        .answer(second.id.value, attenuating(second, first.id));
    return { divergent: new DivergentAuthorityStore(store, divergence), divergence };
}

function attenuating(grant: Grant, parent: GrantId): Grant {
    return new Grant(
        grant.id,
        grant.scope,
        grant.subject,
        grant.effect,
        grant.capability,
        grant.origin,
        parent,
        grant.state
    );
}

function directGrant(
    id: string,
    scope: ScopeRef,
    subject: SubjectRef,
    options: { readonly capability?: CapabilitySpec } = {}
): Grant {
    return new Grant(new GrantId(id), scope, subject, "allow", options.capability ?? observe, {
        kind: "direct"
    });
}

function bindingOn(name: string, grantId: GrantId, subject: SubjectRef): Binding {
    return Binding.active(
        workspaceScope,
        subject,
        new ProtectionDomain("backend", name, "no-secrets"),
        new BindingName(name),
        grantId,
        new FacetRef(`workspace:${name}`)
    );
}

interface Backing {
    readonly store: AuthorityMutationStore & AuthorityReadStore;
    readonly service: AuthorityMutationService;
}

function openMemory(): Backing {
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    return withWorkspaces(store);
}

function openSqlite(): Backing {
    const database = new ClosureSqlite();
    const store = createSqliteTenantControlStore(database, anchor);
    database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
    return withWorkspaces(store);
}

function withWorkspaces(store: AuthorityMutationStore): Backing {
    const service = new AuthorityMutationService(store);
    service.createPrincipal(new Principal(strangerId, "user", "active"));
    service.createWorkspace(new Workspace(workspaceId, tenantId, undefined, Revision.initial()));
    service.createWorkspace(
        new Workspace(otherWorkspaceId, tenantId, undefined, Revision.initial())
    );
    return { store, service };
}

class ClosureSqlite extends TransactionalSqlite {
    readonly #database = new Database(":memory:");

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.query<SqliteRow, SqliteValue[]>(statement).all(...bindings);
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.query<SqliteRow, SqliteValue[]>(statement).run(...bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#database.transaction(() => requireSynchronousResult(operation()))();
    }
}

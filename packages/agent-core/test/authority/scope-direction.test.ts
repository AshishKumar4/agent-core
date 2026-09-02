import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, encodeCanonicalJson } from "../../src/core";
import {
    BindingName,
    CapabilitySpec,
    FacetRef,
    MemoryWorkspaceSlotStore,
    ProtectionDomain,
    WorkspaceSlotCatalog,
    type SlotQueryAuthorityPort
} from "../../src/facets";
import { contribute, entry, install, slot } from "../w3/slot-store-contract";
import {
    MemoryWorkspaceRecords,
    WorkspacePersistence,
    eventMatches,
    type Subscription
} from "../../src/workspaces";
import {
    eventFixture,
    sourceActor,
    subscriptionFixture,
    targetActor,
    tenant as routingTenant
} from "../workspaces/fixtures";
import {
    PrincipalId,
    Project,
    ProjectId,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { scopePath } from "../../src/identity";
import { Binding } from "../../src/authority/binding";
import { BindingValidationRequest } from "../../src/authority/binding-evidence";
import { PathEpochEvidence } from "../../src/authority/epoch";
import { AuthorityCheckRequest, type AuthorityCheckEvidence } from "../../src/authority/evidence";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { scopeKey } from "../../src/authority/reference";
import { TenantAuthorityRuntime } from "../../src/authority/runtime";
import { AuthorityMutationService } from "../../src/authority/service";
import { PrincipalRef, Workspace } from "../identity/internal-fixture";

const tenantId = new TenantId("tenant-scope-direction");
const principalId = new PrincipalId("principal-scope-direction");
const projectId = new ProjectId("project-scope-direction");
const nearId = new WorkspaceId("workspace-scope-direction-near");
const siblingId = new WorkspaceId("workspace-scope-direction-sibling");
const tenantScope = ScopeRef.tenant(tenantId);
const projectScope = ScopeRef.project(tenantId, projectId);
const nearScope = ScopeRef.workspace(tenantId, projectId, nearId);
const siblingScope = ScopeRef.workspace(tenantId, projectId, siblingId);
const tenantActor = new ActorRef("tenant", new ActorId("tenant-scope-direction-actor"));
const workspaceActor = new ActorRef("workspace", new ActorId("workspace-scope-direction-actor"));
const holder = new PrincipalRef(tenantId, principalId);
const subject = SubjectRef.principal(holder);
const domain = new ProtectionDomain("backend", "scope-direction", "no-secrets");
const facet = new FacetRef("workspace:mail.instance");
const argumentsValue = { folder: "inbox" } as const;
const argumentsDigest = Digest.sha256(encodeCanonicalJson(argumentsValue));
const mailObserve = new CapabilitySpec({
    facetPattern: "workspace:mail.*",
    impacts: ["observe"]
});
/**
 * The Workspace id a Tenant-scoped Slot Actor would answer under. Slot storage is keyed
 * by exactly one WorkspaceId (src/facets/slot-store.ts#WorkspaceSlotStore), so "installed
 * at the Tenant" has no other spelling today — and naming it here is what keeps the case
 * meaningful once one exists.
 */
const tenantSlotHost = new WorkspaceId("workspace-scope-direction-tenant-host");
const viewer: Readonly<{ readonly authentication: string }> = Object.freeze({
    authentication: "scope-direction"
});

/**
 * A slot authority that refuses nothing. The confinement under test is the store's, so
 * every policy answer here is deliberately permissive: a case that passed because the
 * authority port said no would prove nothing about Scope direction.
 */
function permissive(workspace: WorkspaceId): SlotQueryAuthorityPort<typeof viewer> {
    return {
        workspace: () => workspace,
        canViewSlot: async () => true,
        canViewEntry: async () => true
    };
}

describe("authority resolves downward along the Scope chain", () => {
    test(
        "[C13-AUTH-SCOPE-DIRECTION] the resolution path is the exact ordered ancestry and names no sibling or descendant",
        { tags: "p0" },
        () => {
            expect(scopePath(nearScope).map(scopeKey)).toEqual([
                scopeKey(tenantScope),
                scopeKey(projectScope),
                scopeKey(nearScope)
            ]);
            expect(scopePath(projectScope).map(scopeKey)).toEqual([
                scopeKey(tenantScope),
                scopeKey(projectScope)
            ]);
            expect(scopePath(tenantScope).map(scopeKey)).toEqual([scopeKey(tenantScope)]);

            // Downward only: an ancestor's path never reaches what lives beneath it, and a
            // Workspace's path never reaches the Workspace next door.
            for (const ancestor of [tenantScope, projectScope]) {
                expect(scopePath(ancestor).some((scope) => scope.equals(nearScope))).toBe(false);
                expect(scopePath(ancestor).some((scope) => scope.equals(siblingScope))).toBe(false);
            }
            expect(scopePath(nearScope).some((scope) => scope.equals(siblingScope))).toBe(false);
            expect(scopePath(siblingScope).some((scope) => scope.equals(nearScope))).toBe(false);
            // A Workspace that is a direct Tenant child is not on the Project's chain either,
            // so containment is the exact declared parent and never the Tenant by default.
            const loose = ScopeRef.workspace(tenantId, new WorkspaceId("workspace-loose"));
            expect(scopePath(loose).map(scopeKey)).toEqual([
                scopeKey(tenantScope),
                scopeKey(loose)
            ]);
        }
    );

    test(
        "[C13-AUTH-SCOPE-DIRECTION] a live allow Grant held at the Tenant or the Project reaches a Workspace beneath it",
        { tags: "p0" },
        () => {
            const { store, service, runtime } = fixture();
            for (const [index, scope] of [tenantScope, projectScope].entries()) {
                const name = new BindingName(`reach-${index}`);
                const grantId = new GrantId(`scope-direction-above-${index}`);
                service.createGrant(grant(grantId, scope));
                const binding = Binding.active(nearScope, subject, domain, name, grantId, facet);
                service.createBinding(binding);

                // The Binding validator and the authority check both resolve along the chain,
                // so an ancestor's Grant answers for a descendant Workspace at both sites.
                const validated = runtime.validateBinding(
                    validationRequest(nearScope, name, grantId),
                    new Date(1_000 + index)
                );
                expect(validated.grantId.equals(grantId)).toBe(true);

                const evidence = check(runtime, binding, path(store, nearScope));
                expect(evidence.allowed, scopeKey(scope)).toBe(true);
                expect(evidence.matchedAllow.map((id) => id.value)).toContain(grantId.value);
            }
        }
    );

    test(
        "[C13-AUTH-SCOPE-DIRECTION] a sibling Workspace's Grant reaches nothing here while an ancestor's does",
        { tags: "p0" },
        () => {
            const { store, service, runtime } = fixture();
            const above = new GrantId("scope-direction-allow-above");
            service.createGrant(grant(above, tenantScope));
            const name = new BindingName("reach");
            const binding = Binding.active(nearScope, subject, domain, name, above, facet);
            service.createBinding(binding);
            expect(check(runtime, binding, path(store, nearScope)).allowed).toBe(true);

            // A deny needs no Binding, so it is the one Grant that can be held anywhere and
            // asked whether it reaches. Held at the Workspace next door, it reaches nothing
            // here: the resolver's candidate set is this target's ancestry.
            const sideways = new GrantId("scope-direction-deny-sideways");
            service.createGrant(deny(sideways, siblingScope));
            const survived = check(runtime, binding, path(store, nearScope));
            expect(survived.allowed).toBe(true);
            expect(survived.matchedDeny).toEqual([]);

            // The same deny one Scope up does reach, which is what separates "downward" from
            // "only where it is held".
            const fromAbove = new GrantId("scope-direction-deny-above");
            service.createGrant(deny(fromAbove, projectScope));
            const refused = check(runtime, binding, path(store, nearScope));
            expect(refused.allowed).toBe(false);
            expect(refused.reason).toBe("matchingDeny");
            expect(refused.matchedDeny.map((id) => id.value)).toEqual([fromAbove.value]);
        }
    );

    test(
        "[C13-AUTH-SCOPE-DIRECTION] a Binding backed by a sibling Workspace's Grant is refused at every site that writes or reads it",
        { tags: "p0" },
        () => {
            const { store, service, runtime } = fixture();
            const heldAtNear = new GrantId("scope-direction-held-at-near");
            service.createGrant(grant(heldAtNear, nearScope));

            const name = new BindingName("sideways");
            const sideways = Binding.active(siblingScope, subject, domain, name, heldAtNear, facet);
            expect(() => service.createBinding(sideways)).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message:
                        "Binding requires a live allow Grant for its subject and Workspace path"
                })
            );
            expect(() =>
                runtime.validateBinding(
                    validationRequest(siblingScope, name, heldAtNear),
                    new Date(2_000)
                )
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Binding requires a live allow Grant reaching its Workspace"
                })
            );

            // And a host writing the record straight into the plane, past the service, does
            // not get it either: the closure the Tenant store asserts on every commit holds
            // the same reach predicate, so the sideways Binding is unrepresentable rather than
            // merely unresolvable.
            expect(() => store.transaction((mutable) => mutable.putBinding(sideways))).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "Binding references invalid Tenant authority"
                })
            );
            expect(store.binding(sideways.key)).toBeUndefined();
            expect(store.bindings()).toEqual([]);
        }
    );

    test(
        "[C13-AUTH-SCOPE-DIRECTION] authority never resolves upward: an attenuation from a descendant is refused where it is written",
        { tags: "p0" },
        () => {
            const { store, service } = fixture();
            const parentAtWorkspace = new GrantId("scope-direction-parent-below");
            const childAbove = new GrantId("scope-direction-child-above");
            service.createGrant(grant(parentAtWorkspace, nearScope));

            // The record itself knows the direction: a Workspace-held allow cannot parent a
            // Project- or Tenant-scoped attenuation, while an ancestor can parent a descendant.
            const held = store.grant(parentAtWorkspace);
            expect(held?.canAttenuate(grant(childAbove, projectScope, parentAtWorkspace))).toBe(
                false
            );
            expect(held?.canAttenuate(grant(childAbove, tenantScope, parentAtWorkspace))).toBe(
                false
            );
            const downwardParent = new GrantId("scope-direction-downward-parent");
            expect(
                grant(downwardParent, tenantScope).canAttenuate(
                    grant(childAbove, nearScope, downwardParent)
                )
            ).toBe(true);

            const upward = grant(childAbove, projectScope, parentAtWorkspace);
            expect(() => service.createGrant(upward)).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Delegated Grant is not a live attenuation"
                })
            );
            expect(() => store.transaction((mutable) => mutable.putGrant(upward))).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "Delegated Grant references invalid parent authority"
                })
            );
            expect(store.grant(childAbove)).toBeUndefined();
        }
    );

    test(
        "[C13-AUTH-SCOPE-DIRECTION] a Facet installed above a Workspace composes into no slot query beneath it",
        { tags: "p0" },
        async () => {
            // A Slot Actor is keyed by exactly one WorkspaceId today, so an ancestor-scoped
            // slot store is not representable and the ancestor's installation has to be
            // modelled as the store such an Actor WOULD own. That is the whole point of the
            // case: the confinement must not depend on the ancestor-scoped store staying
            // absent, because the day one is added it will hold a Slot with this exact
            // declaration, this exact contributor, and an entry a descendant would happily
            // render if anything let it through.
            const above = new MemoryWorkspaceSlotStore(tenantSlotHost);
            install(above, slot());
            contribute(above, entry("workspace:mail", 1, { title: "Installed at the Tenant" }));
            const beneath = new MemoryWorkspaceSlotStore(nearId);
            install(beneath, slot());

            // Nothing here refuses on policy. Both authority ports below authorize the
            // viewer, the Slot, and every entry, so a query that returned the ancestor's
            // entry would be composition rather than a permission bug — which is the
            // direction the regression would actually arrive from.
            const declaration = slot().declaration.name;
            const beneathCatalog = new WorkspaceSlotCatalog(beneath, viewer, permissive(nearId));
            await expect(beneathCatalog.query(declaration)).resolves.toEqual([]);

            // The entry exists and the Slot name matches: queried at the Workspace that owns
            // it, the same catalog over the same declaration answers with it. So the empty
            // answer above is confinement, not an absent fixture.
            const aboveCatalog = new WorkspaceSlotCatalog(
                above,
                viewer,
                permissive(tenantSlotHost)
            );
            await expect(aboveCatalog.query(declaration)).resolves.toEqual([
                expect.objectContaining({ value: { title: "Installed at the Tenant" } })
            ]);

            // And there is no way to ask the ancestor's store on a descendant's behalf: the
            // catalog binds to the viewer's own Workspace at construction, so an ancestor's
            // entries have no path into a descendant's query even when the authority port
            // would allow every one of them.
            expect(() => new WorkspaceSlotCatalog(above, viewer, permissive(nearId))).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "SlotCatalog requires an authenticated viewer for its Workspace"
                })
            );
        }
    );

    test(
        "[C13-AUTH-SCOPE-DIRECTION] an Event reaches only Subscriptions the accepting Actor itself holds",
        { tags: "p0" },
        () => {
            const event = eventFixture("scope-direction");
            const held = subscriptionFixture("scope-direction-accepting");
            const sideways = subscriptionFixture("scope-direction-sibling");

            // The matcher cannot separate these: both patterns accept this exact Event on
            // kind, source and trust, which is everything §6 gives it to compare. So if
            // confinement lived in the matcher it would already have failed here.
            expect(eventMatches(held.source, event)).toBe(true);
            expect(eventMatches(sideways.source, event)).toBe(true);

            const accepting = workspaceRecords(sourceActor, held);
            const sibling = workspaceRecords(targetActor, sideways);

            // Each Actor's candidate set is its own store's Subscriptions and nothing
            // else. The sibling's Subscription matches the Event exactly and is still not
            // a candidate where the Event is accepted, so a route is something an Actor
            // declares for itself rather than something a matching pattern earns.
            expect(subscriptionIds(accepting)).toEqual([held.id.value]);
            expect(subscriptionIds(sibling)).toEqual([sideways.id.value]);

            // The discriminator: widen the candidate supply past the accepting Actor and
            // the sibling's Subscription becomes a candidate for the same Event, against
            // the same matcher and the same records. The assertion above is what that
            // mutation turns red.
            expect(subscriptionIds(widened(accepting, sibling))).toEqual([
                held.id.value,
                sideways.id.value
            ]);
        }
    );

    test(
        "[C13-AUTH-SCOPE-DIRECTION] reacting across Scopes needs a declared Subscription and a Grant that reaches its Binding",
        { tags: "p0" },
        () => {
            const event = eventFixture("scope-direction-cross");
            const declared = subscriptionFixture("scope-direction-cross");

            // Standing above the Event's Workspace earns nothing. Before the route is
            // declared the reacting Actor's candidate set is empty even though its
            // pattern would match, which is the difference between a declared route and
            // inherited visibility.
            const reacting = workspaceRecords(sourceActor);
            expect(subscriptionIds(reacting)).toEqual([]);
            expect(eventMatches(declared.source, event)).toBe(true);

            reacting.persistence.saveSubscription(reacting.records, declared, undefined);
            expect(subscriptionIds(reacting)).toEqual([declared.id.value]);

            // And the declared route carries its own delivery authority rather than the
            // Event's: it names a Binding, and that Binding resolves down the same chain
            // every other authority decision in this file uses. Held at the Project the
            // Grant reaches the Workspace beneath it.
            if (declared.authority.kind !== "initiator") {
                throw new TypeError("Route fixture must declare initiator authority");
            }
            const routeName = declared.authority.binding;
            const { store, service, runtime } = fixture();
            const above = new GrantId("scope-direction-route-above");
            service.createGrant(grant(above, projectScope));
            const binding = Binding.active(nearScope, subject, domain, routeName, above, facet);
            service.createBinding(binding);
            expect(check(runtime, binding, path(store, nearScope)).allowed).toBe(true);

            // Held at the Workspace next door it reaches nothing, so the route's delivery
            // is refused there for the same reason a Binding is: the Grant is off the
            // target's ancestry.
            const { service: other, runtime: otherRuntime, store: otherStore } = fixture();
            const sideways = new GrantId("scope-direction-route-sideways");
            other.createGrant(grant(sideways, siblingScope));
            expect(() =>
                other.createBinding(
                    Binding.active(nearScope, subject, domain, routeName, sideways, facet)
                )
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message:
                        "Binding requires a live allow Grant for its subject and Workspace path"
                })
            );
            expect(otherStore.bindings()).toEqual([]);
            expect(
                otherRuntime.check(
                    new AuthorityCheckRequest({
                        ownerTenant: tenantId,
                        owner: workspaceActor,
                        ownerFence: 1,
                        principal: holder,
                        binding: Binding.active(
                            nearScope,
                            subject,
                            domain,
                            routeName,
                            sideways,
                            facet
                        ),
                        intent: {
                            facet,
                            operation: "read",
                            impact: "observe",
                            arguments: argumentsValue,
                            argumentsDigest
                        },
                        expectedPath: path(otherStore, nearScope),
                        invocationDigest: Digest.sha256(Uint8Array.of(7)),
                        itemIndex: 0,
                        attemptOrdinal: 0,
                        nonce: "scope-direction-route-sideways"
                    }),
                    new Date(5_000)
                ).allowed
            ).toBe(false);
        }
    );
});

/** Content retention is not what this proves; the store is. */
const routingRetention = { verify: () => true, release: () => {}, discard: () => {} };

interface WorkspaceRecords {
    readonly records: MemoryWorkspaceRecords;
    readonly persistence: WorkspacePersistence<MemoryWorkspaceRecords>;
}

/** One Workspace Actor's own record store, optionally holding one declared Subscription. */
function workspaceRecords(actor: ActorRef, declared?: Subscription): WorkspaceRecords {
    const records = new MemoryWorkspaceRecords();
    const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
        (value) => value,
        routingRetention,
        actor,
        routingTenant
    );
    if (declared !== undefined) persistence.saveSubscription(records, declared, undefined);
    return { records, persistence };
}

function subscriptionIds(owned: WorkspaceRecords): readonly string[] {
    return owned.persistence
        .listSubscriptions(owned.records)
        .map((subscription) => subscription.id.value);
}

/**
 * The mutation the Event conjunct needs: a candidate supply that reaches past the
 * accepting Actor into a sibling's store. Overriding the one method the routing snapshot
 * calls is the whole of it — there is no separate subscription-supply port to widen, so
 * this is exactly the shape the regression would take.
 */
function widened(accepting: WorkspaceRecords, sibling: WorkspaceRecords): WorkspaceRecords {
    class WidenedPersistence extends WorkspacePersistence<MemoryWorkspaceRecords> {
        public override listSubscriptions(
            transaction: MemoryWorkspaceRecords
        ): readonly Subscription[] {
            return [
                ...super.listSubscriptions(transaction),
                ...sibling.persistence.listSubscriptions(sibling.records)
            ];
        }
    }
    return {
        records: accepting.records,
        persistence: new WidenedPersistence(
            (value) => value,
            routingRetention,
            sourceActor,
            routingTenant
        )
    };
}

/** A bootstrapped Tenant holding one Project with two sibling Workspaces under it. */
function fixture() {
    const anchor = {
        actorId: tenantActor.id,
        tenantId,
        principalId,
        trustAnchor: Uint8Array.of(4, 5, 6)
    };
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    service.createProject(new Project(projectId, tenantId, "Scope direction", Revision.initial()));
    service.createWorkspace(new Workspace(nearId, tenantId, projectId, Revision.initial()));
    service.createWorkspace(new Workspace(siblingId, tenantId, projectId, Revision.initial()));
    return { store, service, runtime: new TenantAuthorityRuntime(store, tenantActor) };
}

function grant(id: GrantId, scope: ScopeRef, attenuationOf?: GrantId): Grant {
    return new Grant(id, scope, subject, "allow", mailObserve, { kind: "direct" }, attenuationOf);
}

function deny(id: GrantId, scope: ScopeRef): Grant {
    return new Grant(id, scope, subject, "deny", mailObserve, { kind: "direct" });
}

function path(store: MemoryTenantControlStore, workspace: ScopeRef): PathEpochEvidence {
    return new PathEpochEvidence([
        store.epoch(tenantScope),
        store.epoch(projectScope),
        store.epoch(workspace)
    ]);
}

function validationRequest(
    scope: ScopeRef,
    name: BindingName,
    grantId: GrantId
): BindingValidationRequest {
    return new BindingValidationRequest({
        ownerTenant: tenantId,
        workspaceActor,
        workspaceFence: 1,
        scope,
        domain,
        name,
        grantId,
        facet,
        nonce: `scope-direction-${name.value}`
    });
}

function check(
    runtime: TenantAuthorityRuntime,
    binding: Binding,
    expectedPath: PathEpochEvidence
): AuthorityCheckEvidence {
    return runtime.check(
        new AuthorityCheckRequest({
            ownerTenant: tenantId,
            owner: workspaceActor,
            ownerFence: 1,
            principal: holder,
            binding,
            intent: {
                facet,
                operation: "read",
                impact: "observe",
                arguments: argumentsValue,
                argumentsDigest
            },
            expectedPath,
            invocationDigest: Digest.sha256(Uint8Array.of(6)),
            itemIndex: 0,
            attemptOrdinal: 0,
            nonce: `scope-direction-check-${binding.name.value}`
        }),
        new Date(4_000)
    );
}

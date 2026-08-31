import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, encodeCanonicalJson } from "../../src/core";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
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
});

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

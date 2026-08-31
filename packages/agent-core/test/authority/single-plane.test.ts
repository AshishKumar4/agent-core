import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, encodeCanonicalJson } from "../../src/core";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import { PrincipalId, ScopeRef, SubjectRef, TenantId, WorkspaceId } from "../../src/identity";
import { Binding } from "../../src/authority/binding";
import { PathEpochEvidence, ScopeEpoch } from "../../src/authority/epoch";
import { AuthorityCheckRequest, type AuthorityCheckEvidence } from "../../src/authority/evidence";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { scopeKey } from "../../src/authority/reference";
import { TenantAuthorityRuntime } from "../../src/authority/runtime";
import { AuthorityMutationService, type AuthorityMutationStore } from "../../src/authority/service";
import { createSqliteTenantControlStore } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import { PrincipalRef, Workspace } from "../identity/internal-fixture";
import { AuthorityDivergence, DivergentAuthorityStore } from "./divergent-store";

const tenantId = new TenantId("tenant-single-plane");
const principalId = new PrincipalId("principal-single-plane");
const workspaceId = new WorkspaceId("workspace-single-plane");
const tenantScope = ScopeRef.tenant(tenantId);
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const tenantActor = new ActorRef("tenant", new ActorId("tenant-single-plane-actor"));
const workspaceActor = new ActorRef("workspace", new ActorId("workspace-single-plane-actor"));
const holder = new PrincipalRef(tenantId, principalId);
const subject = SubjectRef.principal(holder);
const domain = new ProtectionDomain("backend", "single-plane", "no-secrets");
const facet = new FacetRef("workspace:mail.instance");
const otherFacet = new FacetRef("workspace:mail.mirror");
const bindingName = new BindingName("mail");
const boundGrantId = new GrantId("single-plane-grant");
const argumentsValue = { folder: "inbox" } as const;
const argumentsDigest = Digest.sha256(encodeCanonicalJson(argumentsValue));
const anchor = {
    actorId: tenantActor.id,
    tenantId,
    principalId,
    trustAnchor: Uint8Array.of(3, 1, 4)
};

const owners = {
    memory: (): AuthorityMutationStore => {
        const store = MemoryTenantControlStore.create(anchor);
        store.bootstrapTenant(anchor, Revision.initial());
        return store;
    },
    sqlite: (): AuthorityMutationStore => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        return store;
    }
} as const;

describe.each(["memory", "sqlite"] as const)(
    "the one durable owner of Binding, Grant and ScopeEpoch records: %s",
    (name) => {
        test(
            "[C13-OWNERSHIP-AUTHORITY-RECORDS] every Binding transition advances its path epoch in the same transaction",
            { tags: "p0" },
            () => {
                const { store, service, binding } = fixture(name);
                const before = store.epoch(workspaceScope).epoch;

                service.createBinding(binding);
                expect(store.epoch(workspaceScope).epoch).toBe(before + 1);
                const replaced = service.replaceBinding(binding.key, boundGrantId, otherFacet);
                expect(store.epoch(workspaceScope).epoch).toBe(before + 2);
                const inactive = service.deactivateBinding(binding.key);
                expect(store.epoch(workspaceScope).epoch).toBe(before + 3);

                // A transition that changes nothing advances nothing: the epoch counts real
                // Binding changes rather than calls.
                expect(service.deactivateBinding(binding.key)).toEqual(inactive);
                expect(store.epoch(workspaceScope).epoch).toBe(before + 3);
                expect(inactive.generation).toBe(replaced.generation + 1);
                expect(store.bindings()).toEqual([inactive]);
            }
        );

        test(
            "[C13-OWNERSHIP-AUTHORITY-RECORDS] a failed epoch advance rolls back the Binding transition that asked for it",
            { tags: "p0" },
            () => {
                const { store, service, binding } = fixture(name);
                service.createBinding(binding);
                const committed = store.epoch(workspaceScope).epoch;

                // The Scope's epoch is exhausted as far as this transaction can see, so the
                // advance every transition demands cannot be planned. Each transition must
                // then leave the Binding exactly as the canonical plane already holds it.
                const exhausted = new AuthorityMutationService(
                    exhaustedEpochPlane(
                        store,
                        new ScopeEpoch(workspaceScope, Number.MAX_SAFE_INTEGER)
                    )
                );
                const second = Binding.active(
                    workspaceScope,
                    subject,
                    domain,
                    new BindingName("second"),
                    boundGrantId,
                    facet
                );
                for (const transition of [
                    () => exhausted.createBinding(second),
                    () => exhausted.replaceBinding(binding.key, boundGrantId, otherFacet),
                    () => exhausted.deactivateBinding(binding.key)
                ]) {
                    expect(transition).toThrow(
                        expect.objectContaining({
                            code: "protocol.invalid-state",
                            message: `Authority epoch is exhausted for ${scopeKey(workspaceScope)}`
                        })
                    );
                }

                expect(store.binding(second.key)).toBeUndefined();
                expect(store.bindings().map((record) => record.name.value)).toEqual([
                    bindingName.value
                ]);
                expect(store.binding(binding.key)?.generation).toBe(0);
                expect(store.binding(binding.key)?.state).toBe("active");
                expect(store.binding(binding.key)?.facet.equals(facet)).toBe(true);
                expect(store.epoch(workspaceScope).epoch).toBe(committed);
            }
        );

        test(
            "[C13-OWNERSHIP-AUTHORITY-RECORDS] a second store answering for a Binding, Grant or ScopeEpoch is detectably divergent rather than silently authoritative",
            { tags: "p0" },
            () => {
                const { store, service, binding } = fixture(name);
                service.createBinding(binding);
                const canonical = new TenantAuthorityRuntime(store, tenantActor);
                const request = checkRequest(binding, path(store));
                expect(canonical.check(request, new Date(1_000)).allowed).toBe(true);

                // Each case is the same request against the same canonical records, with one
                // second plane answering for one record kind. A host that treated the second
                // answer as authority would admit; the resolver refuses instead, and names
                // which record it could not reconcile.
                const mirroredBinding = new AuthorityDivergence();
                mirroredBinding.bindings.answer(
                    binding.key,
                    binding.replace(boundGrantId, otherFacet)
                );
                expect(refusal(store, mirroredBinding, request)).toBe("invalidBinding");

                const mirroredGrant = new AuthorityDivergence();
                const held = store.grant(boundGrantId);
                if (held === undefined) throw new TypeError("Bound Grant is missing");
                mirroredGrant.grants.answer(boundGrantId.value, held.revoke());
                expect(refusal(store, mirroredGrant, request)).toBe("revokedGrant");

                const mirroredEpoch = new AuthorityDivergence();
                mirroredEpoch.epochs.answer(
                    scopeKey(workspaceScope),
                    store.epoch(workspaceScope).next()
                );
                expect(refusal(store, mirroredEpoch, request)).toBe("stalePath");

                // The canonical owner never moved: the divergences were detected, not adopted.
                expect(canonical.check(request, new Date(1_001)).allowed).toBe(true);
            }
        );

        test(
            "[C13-OWNERSHIP-AUTHORITY-RECORDS] a Binding, Grant or ScopeEpoch write diverted to a second store never becomes authority",
            { tags: "p0" },
            () => {
                const { store, service, binding } = fixture(name);
                service.createBinding(binding);
                const canonical = new TenantAuthorityRuntime(store, tenantActor);
                const committedEpoch = store.epoch(workspaceScope).epoch;

                // A host dual-writing into an undeclared plane: every write for these three
                // keys lands there instead of here. The divergence keeps them, so the write
                // "succeeds" from the caller's side.
                const second = new AuthorityDivergence();
                second.bindings.answer(binding.key, binding);
                second.epochs.answer(scopeKey(workspaceScope), store.epoch(workspaceScope));
                const diverted = new AuthorityMutationService(
                    new DivergentAuthorityStore(store, second)
                );
                const replaced = diverted.replaceBinding(binding.key, boundGrantId, otherFacet);
                expect(replaced.facet.equals(otherFacet)).toBe(true);

                // And it changed nothing an authority decision reads. The canonical owner
                // still holds generation zero at the epoch it committed, so the second plane
                // is a divergent copy rather than a second source of truth.
                expect(store.binding(binding.key)?.facet.equals(facet)).toBe(true);
                expect(store.binding(binding.key)?.generation).toBe(0);
                expect(store.epoch(workspaceScope).epoch).toBe(committedEpoch);
                const request = checkRequest(binding, path(store));
                expect(canonical.check(request, new Date(2_000)).allowed).toBe(true);

                // Presenting the second plane's record to the canonical owner is refused, so
                // the diverted write cannot be laundered into an admission either.
                const mirrored = checkRequest(replaced, path(store));
                const evidence = canonical.check(mirrored, new Date(2_001));
                expect(evidence.allowed).toBe(false);
                expect(evidence.reason).toBe("invalidBinding");
            }
        );
    }
);

/** A bootstrapped Tenant with one Workspace, one allow Grant, and the Binding it backs. */
function fixture(name: "memory" | "sqlite") {
    const store = owners[name]();
    const service = new AuthorityMutationService(store);
    service.createWorkspace(new Workspace(workspaceId, tenantId, undefined, Revision.initial()));
    service.createGrant(
        new Grant(
            boundGrantId,
            workspaceScope,
            subject,
            "allow",
            new CapabilitySpec({ facetPattern: "workspace:mail.*", impacts: ["observe"] }),
            { kind: "direct" }
        )
    );
    return {
        store,
        service,
        binding: Binding.active(workspaceScope, subject, domain, bindingName, boundGrantId, facet)
    };
}

/**
 * The canonical plane with one Scope's epoch answered as exhausted, so the same-transaction
 * advance every Binding transition plans cannot be produced. Reusing the divergent store
 * keeps the injection behavioural: nothing in the service or the store is stubbed, and the
 * failure arrives from `ScopeEpoch.next` exactly as a real saturation would.
 */
function exhaustedEpochPlane(
    store: AuthorityMutationStore,
    exhausted: ScopeEpoch
): AuthorityMutationStore {
    const divergence = new AuthorityDivergence();
    divergence.epochs.answer(scopeKey(exhausted.scope), exhausted);
    return new DivergentAuthorityStore(store, divergence);
}

/** What the resolver answers when one record kind comes from a second plane. */
function refusal(
    store: AuthorityMutationStore,
    divergence: AuthorityDivergence,
    request: AuthorityCheckRequest
): AuthorityCheckEvidence["reason"] {
    const evidence = new TenantAuthorityRuntime(
        new DivergentAuthorityStore(store, divergence),
        tenantActor
    ).check(request, new Date(3_000));
    expect(evidence.allowed).toBe(false);
    return evidence.reason;
}

function path(store: AuthorityMutationStore): PathEpochEvidence {
    return new PathEpochEvidence([store.epoch(tenantScope), store.epoch(workspaceScope)]);
}

function checkRequest(binding: Binding, expectedPath: PathEpochEvidence): AuthorityCheckRequest {
    return new AuthorityCheckRequest({
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
        invocationDigest: Digest.sha256(Uint8Array.of(8)),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: `single-plane-check-${binding.generation}`
    });
}

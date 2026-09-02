import { describe, expect, test } from "vitest";
import { ActorId } from "../../src/actors";
import { AuthorityMutationService, Binding, Grant, GrantId } from "../../src/authority";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { Digest, Revision, SemVer } from "../../src/core";
import { PackageId, PackagePin } from "../../src/definition-references";
import {
    BindingName,
    CapabilitySpec,
    ContributionAttribution,
    FacetRef,
    ProtectionDomain
} from "../../src/facets";
import {
    Membership,
    MembershipId,
    PrincipalRef,
    Project,
    Role,
    RoleName,
    RoleRule,
    SubjectRef
} from "../../src/identity";
import { Workspace } from "../identity/internal-fixture";
import { principalId, tenantId, workspaceScope } from "./fixture";

const anchor = Object.freeze({
    actorId: new ActorId("tenant-withdrawal-actor"),
    tenantId,
    principalId,
    trustAnchor: Uint8Array.of(4, 5, 6)
});

const withdrawing = new FacetRef("workspace:withdrawn");
const retained = new FacetRef("workspace:retained");

describe("Facet withdrawal in the authority Actor's own transaction", () => {
    test(
        "[C13-FACET-WITHDRAWAL-EXACT] retires the withdrawing Facet's Bindings and solely-naming Grants and advances the Scope epoch with them",
        { tags: "p0" },
        () => {
            const harness = authorityHarness();
            const withdrawnBinding = harness.bind("binding.withdrawn", withdrawing);
            const retainedBinding = harness.bind("binding.retained", retained);
            const solely = harness.grant("grant-solely", withdrawing.value);
            const delegated = harness.attenuate("grant-delegated", solely);
            const wider = harness.grant("grant-wider", "workspace:*");
            const foreign = harness.grant("grant-foreign", retained.value);
            const before = harness.epoch();

            const result = harness.service.retireFacetContribution(contribution(withdrawing));

            // Exactly the Bindings naming this FacetRef go inactive; another Facet's Binding
            // is not in the set and still resolves.
            expect(result.bindings.map((binding) => binding.name.value)).toEqual([
                withdrawnBinding.name.value
            ]);
            expect(result.bindings.every((binding) => binding.resolves)).toBe(false);
            expect(harness.binding(withdrawnBinding)?.state).toBe("inactive");
            expect(harness.binding(withdrawnBinding)?.generation).toBe(
                withdrawnBinding.generation + 1
            );
            expect(harness.binding(retainedBinding)?.resolves).toBe(true);

            // Exactly the Grants whose capability names only this Facet's Operations are
            // revoked, together with their delegated closure; a wildcard capability that also
            // reaches other Facets and another Facet's Grant are untouched.
            expect(result.grants.map((id) => id.value).sort()).toEqual([
                delegated.id.value,
                solely.id.value
            ]);
            expect(harness.grantState(solely.id)).toBe("revoked");
            expect(harness.grantState(delegated.id)).toBe("revoked");
            expect(harness.grantState(wider.id)).toBe("active");
            expect(harness.grantState(foreign.id)).toBe("active");

            // The retirement and its path-epoch advance committed together, so the next
            // resolution attempt reads a moved epoch rather than the one it resolved under.
            expect(harness.epoch()).toBeGreaterThan(before);
            expect(
                result.epochs.some(
                    (epoch) => epoch.scope.equals(workspaceScope) && epoch.epoch === harness.epoch()
                )
            ).toBe(true);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] a Facet this Tenant granted nothing retires nothing and moves no epoch",
        { tags: "p0" },
        () => {
            const harness = authorityHarness();
            const untouched = harness.bind("binding.untouched", retained);
            const before = harness.epoch();

            const result = harness.service.retireFacetContribution(
                contribution(new FacetRef("workspace:absent"))
            );

            expect(result.bindings).toEqual([]);
            expect(result.grants).toEqual([]);
            expect(result.epochs).toEqual([]);
            expect(harness.epoch()).toBe(before);
            expect(harness.binding(untouched)?.resolves).toBe(true);
        }
    );

    test(
        "[C13-FACET-WITHDRAWAL-EXACT] a replayed retirement writes nothing further and moves no epoch again",
        { tags: "p0" },
        () => {
            const harness = authorityHarness();
            const binding = harness.bind("binding.replayed", withdrawing);
            harness.grant("grant-replayed", withdrawing.value);
            harness.service.retireFacetContribution(contribution(withdrawing));
            const settled = harness.epoch();
            const bytes = Binding.encode(harness.binding(binding)!);

            const replay = harness.service.retireFacetContribution(contribution(withdrawing));

            // An at-least-once administer delivery is not a second retirement: an inactive
            // Binding stays byte-identical and a revoked Grant is not revoked again.
            expect(replay.bindings).toEqual([]);
            expect(replay.grants).toEqual([]);
            expect(replay.epochs).toEqual([]);
            expect(harness.epoch()).toBe(settled);
            expect(Binding.encode(harness.binding(binding)!)).toEqual(bytes);
        }
    );
});

interface AuthorityHarness {
    readonly store: MemoryTenantControlStore;
    readonly service: AuthorityMutationService;
    bind(name: string, facet: FacetRef): Binding;
    grant(id: string, facetPattern: string): Grant;
    attenuate(id: string, parent: Grant): Grant;
    binding(binding: Binding): Binding | undefined;
    grantState(id: GrantId): string;
    epoch(): number;
}

/**
 * One bootstrapped Tenant control store with a Membership whose Role materialized a Grant,
 * so a Binding can be created against live authority the way §3.4 requires.
 */
function authorityHarness(): AuthorityHarness {
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    if (workspaceScope.projectId !== undefined) {
        service.createProject(
            new Project(
                workspaceScope.projectId,
                tenantId,
                "Withdrawal Project",
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
    const subject = SubjectRef.principal(new PrincipalRef(tenantId, principalId));
    service.createRole(
        new Role(new RoleName("withdrawal-operator"), [
            new RoleRule("allow", new CapabilitySpec({ facetPattern: "*", impacts: ["execute"] }))
        ])
    );
    service.assignMembership(
        new Membership(
            new MembershipId("withdrawal-member"),
            workspaceScope,
            subject,
            new RoleName("withdrawal-operator"),
            "active",
            Revision.initial()
        )
    );
    const roleGrant = store.grants().find((grant) => grant.origin.kind === "role");
    if (roleGrant === undefined) throw new TypeError("Role materialization produced no Grant");
    return {
        store,
        service,
        bind(name, facet) {
            return service.createBinding(
                Binding.active(
                    workspaceScope,
                    subject,
                    new ProtectionDomain("backend", name, "no-secrets"),
                    new BindingName(name),
                    roleGrant.id,
                    facet
                )
            );
        },
        grant(id, facetPattern) {
            return service.createGrant(
                new Grant(
                    new GrantId(id),
                    workspaceScope,
                    subject,
                    "allow",
                    new CapabilitySpec({ facetPattern, impacts: ["execute"] }),
                    { kind: "direct" }
                )
            );
        },
        attenuate(id, parent) {
            return service.createGrant(
                new Grant(
                    new GrantId(id),
                    workspaceScope,
                    subject,
                    "allow",
                    parent.capability,
                    { kind: "direct" },
                    parent.id
                )
            );
        },
        binding(binding) {
            return store.binding(binding.key);
        },
        grantState(id) {
            const grant = store.grant(id);
            if (grant === undefined) throw new TypeError(`Grant ${id.value} is absent`);
            return grant.isLive ? "active" : "revoked";
        },
        epoch() {
            return store.epoch(workspaceScope).epoch;
        }
    };
}

/** The exact pair the Workspace Actor retires its own records under (§4.2). */
function contribution(facet: FacetRef): ContributionAttribution {
    return new ContributionAttribution(
        facet,
        new PackagePin(
            new PackageId(facet.packageId.value),
            new SemVer("1.0.0"),
            Digest.sha256(new TextEncoder().encode(`manifest:${facet.value}`)),
            Digest.sha256(new TextEncoder().encode(`code:${facet.value}`))
        )
    );
}

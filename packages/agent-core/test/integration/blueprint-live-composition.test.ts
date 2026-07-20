import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { TurnId, TurnLease } from "../../src/agents";
import {
    Binding,
    GrantId,
    InvalidationWatermark,
    PathEpochEvidence,
    ScopeEpoch
} from "../../src/authority";
import { MediaHint } from "../../src/content";
import {
    TenantOperationAuthority,
    ResolvedOperationAuthority,
    type OperationAuthorityStatePort,
    type OperationResolutionCandidate
} from "../../src/composition";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    strictJsonSchemaValidator,
    type JsonValue
} from "../../src/core";
import {
    BlueprintDeclarationCodecPort,
    type BlueprintDeclarationField,
    Config,
    DeploymentKey,
    MetadataSnapshot,
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule,
    PackageDependency,
    PackageId,
    PackageInstall,
    PackageLock,
    PackagePin,
    PackageRelease,
    PlacementSourcePort,
    PlatformCompatibility,
    PolicySet,
    ValidatedBlueprint,
    Blueprint,
    planMaterialization,
    validateBlueprint,
    type DesiredProjection,
    MaterializationTopologyPort
} from "../../src/definition";
import {
    Automation,
    BindingName,
    CapabilitySpec,
    EventPattern,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    OperationDescriptor,
    OperationName,
    OperationRef,
    PayloadMapping,
    ProtectionDomain
} from "../../src/facets";
import { Contribution, Contributions } from "../../src/facets";
import { SlotName } from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { InvocationPlacementPin } from "../../src/invocations";
import { Subscription, SubscriptionId } from "../../src/workspaces";

/*
 * The end-to-end Blueprint proof: what a platform definer declares is what executes.
 *
 * Every other materialization test verifies that Blueprint constructs project to
 * durable records. This suite closes the remaining seam: the *records themselves* are
 * fed to the live membrane, and the declared semantics are observed as runtime
 * behavior —
 *
 *   1. a PolicySet tightening declared in the Blueprint changes an admission-tier
 *      decision from direct to mediated (SPEC §7.2);
 *   2. the Subscription record derived from a declared Automation targets exactly the
 *      declared Operation with the declared authority mode (SPEC §6.2 / §4.3); and
 *   3. the facet-placement record pins the declared isolation, and a non-bundled pin
 *      forecloses the direct tier entirely (SPEC §4.1 / §7.2).
 */

const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });
const tenantId = new TenantId("live-tenant");
const deploymentKey = new DeploymentKey("live");
const objectSchema = new JsonSchema({ additionalProperties: true, type: "object" });
const FACET_ID = "acme.notes.facet";
const OPERATION = `${FACET_ID}:append`;

const declarationCodecs = new BlueprintDeclarationCodecPort(
    ["scopes", "agents", "slots", "subscriptions", "environments", "surfaces"].map((field) => ({
        field: field as BlueprintDeclarationField,
        canonicalize: (value: JsonValue): JsonValue => value
    }))
);

const placementSource = new (class extends PlacementSourcePort {
    public sources(_release: PackageRelease, _manifest: FacetManifest) {
        return {
            substrate: ["dynamic", "provider", "bundled"],
            trust: ["dynamic", "provider", "bundled"]
        } as const;
    }
})();

const tenantActor = new ActorRef("tenant", new ActorId("live-tenant"));
const workspaceActor = new ActorRef("workspace", new ActorId("live-workspace"));
const topology = new (class extends MaterializationTopologyPort {
    public actorFor(_validated: ValidatedBlueprint, projection: DesiredProjection): ActorRef {
        return projection.recordKind === "policy-set" || projection.recordKind === "scope-scaffold"
            ? tenantActor
            : workspaceActor;
    }
})();

function declaredBlueprint(policies: PolicySet): ValidatedBlueprint {
    const contributions = new Contributions([
        new Contribution(new SlotName("operations"), [
            new OperationDescriptor(
                new OperationName("append"),
                "observe",
                objectSchema,
                objectSchema,
                "Append a note.",
                true
            ).toData()
        ]),
        new Contribution(new SlotName("automations"), [
            new Automation({
                source: new EventPattern("note.created", ["self"]),
                target: new OperationRef(OPERATION),
                binding: new BindingName("notes"),
                mapping: new PayloadMapping([]),
                dedupe: "event",
                authority: "delegated"
            }).toData()
        ])
    ]);
    const release = packageRelease("acme.notes", contributions);
    const blueprint = new Blueprint({
        meta: { name: "live", version: new SemVer("1.0.0") },
        packages: [
            new PackageInstall({
                request: new PackageDependency(new PackageId("acme.notes"), "^1"),
                config: new Config({})
            })
        ],
        policies,
        scopes: { projects: [{ key: "default" }] },
        agents: [],
        slots: [],
        subscriptions: [],
        environments: [],
        surfaces: { layout: [] }
    });
    return validateBlueprint(blueprint, {
        lock: packageLock([release]),
        releases: [release],
        target,
        declarationCodecs,
        placement: placementSource,
        schemaValidator: strictJsonSchemaValidator
    });
}

function materializedProjections(policies: PolicySet): readonly DesiredProjection[] {
    const plan = planMaterialization({
        validatedBlueprint: declaredBlueprint(policies),
        tenantId,
        deploymentKey,
        generation: 1,
        topology
    });
    return plan.actors.flatMap((actorPlan) => actorPlan.projections);
}

function projectionOfKind(
    projections: readonly DesiredProjection[],
    recordKind: string
): DesiredProjection {
    const found = projections.find((projection) => projection.recordKind === recordKind);
    expect(found, `expected a materialized ${recordKind} record`).toBeDefined();
    return found!;
}

// --- the live membrane the records are fed into ---------------------------------------------

const tenant = tenantId;
const principal = new PrincipalRef(tenant, new PrincipalId("live-principal"));
const owner = new ActorRef("workspace", new ActorId("live-owner"));
const tenantScope = ScopeRef.tenant(tenant);
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("live-workspace"));
const facet = new FacetRef(`workspace:${FACET_ID}`);
const domain = new ProtectionDomain("backend", "live-domain", "may-hold-secrets");
const binding = Binding.active(
    workspaceScope,
    SubjectRef.principal(principal.principalId),
    domain,
    new BindingName("notes"),
    new GrantId("live-grant"),
    facet
);
const path = new PathEpochEvidence([
    ScopeEpoch.initial(tenantScope),
    ScopeEpoch.initial(workspaceScope)
]);
const digest = new Digest("d".repeat(64));
const packagePin = new PackagePin(new PackageId("acme.notes"), new SemVer("1.0.0"), digest, digest);
const lease = TurnLease.restore(new TurnId("live-turn"), principal, 1, new Date(100));

// tier() is a pure decision over the resolution; the state port must stay untouched.
const untouchedState: OperationAuthorityStatePort<PrincipalRef> = new Proxy(
    {} as OperationAuthorityStatePort<PrincipalRef>,
    {
        get() {
            throw new Error("tier() must not consult the authority state port");
        }
    }
);
const authority = new TenantOperationAuthority(untouchedState, () => new Date(10));

function resolutionWith(
    policies: readonly PolicySet[],
    selected: "bundled" | "provider" | "dynamic"
): OperationResolutionCandidate {
    return {
        principal,
        binding,
        pathEpochs: path,
        watermark: InvalidationWatermark.empty(tenant, owner, principal),
        lease: { turn: lease.turn, holder: principal, epoch: lease.epoch },
        originalLease: lease,
        route: undefined,
        package: packagePin,
        placement: new InvocationPlacementPin({
            manifest: [selected],
            policy: [selected],
            substrate: [selected],
            trust: [selected],
            selected
        }),
        owner,
        policies:
            policies.length === 0
                ? [new PolicySet({ maxDirectRevocationWindowMs: 50 })]
                : policies,
        turnOwnedSession: true,
        turnActorAuthorityLocal: true,
        directAuthority: new ResolvedOperationAuthority(facet, [
            new CapabilitySpec({ facetPattern: facet.value, impacts: ["observe"] })
        ])
    };
}

const observeDescriptor = new OperationDescriptor(
    new OperationName("append"),
    "observe",
    objectSchema,
    objectSchema
);

describe("a declared Blueprint is what executes", () => {
    test("a policy tightening declared in the Blueprint flips live admission to mediated", () => {
        const projections = materializedProjections(
            new PolicySet({ tiers: { observe: "mediated" } })
        );
        const record = projectionOfKind(projections, "policy-set");
        const materialized = PolicySet.fromData(record.desired);

        // Without the Blueprint's policy the observe Operation runs direct;
        // feeding the materialized record into the same resolution mediates it.
        expect(authority.tier(resolutionWith([], "bundled"), observeDescriptor, false)).toBe(
            "direct"
        );
        expect(
            authority.tier(resolutionWith([materialized], "bundled"), observeDescriptor, false)
        ).toBe("mediated");
    });

    test("the derived Subscription record targets exactly the declared Operation", () => {
        const projections = materializedProjections(new PolicySet({}));
        const record = projections.find(
            (projection) =>
                projection.recordKind === "subscription" &&
                projection.logicalKey.includes("automation")
        );
        expect(record, "expected the automation-derived subscription record").toBeDefined();
        const automation = Automation.fromData(record!.desired);

        // The record's routing identity is the declaration's, verbatim: an Event can
        // decide whether this fires, never what it fires or as whom.
        expect(automation.target.value).toBe(OPERATION);
        expect(automation.binding.value).toBe("notes");
        expect(automation.source.kind).toBe("note.created");
        expect(automation.source.acceptedTrust).toEqual(["self"]);
        expect(automation.dedupe).toBe("event");
        expect(automation.authority).toBe("delegated");

        // And it constructs the exact live routing Subscription the workspace uses.
        const live = new Subscription({
            id: new SubscriptionId("live-subscription"),
            revision: Revision.initial(),
            source: automation.source,
            target: automation.target,
            mapping: automation.mapping!,
            dedupe: automation.dedupe!,
            authority: { kind: "initiator", binding: automation.binding }
        });
        expect(live.target.value).toBe(OPERATION);
        expect(live.source.acceptedTrust).toEqual(["self"]);
    });

    test("the placement record pins the declared isolation and forecloses the direct tier", () => {
        const projections = materializedProjections(new PolicySet({}));
        const record = projectionOfKind(projections, "facet-placement");
        const desired = record.desired as { readonly selected: string };

        // The manifest declared isolation ["dynamic"]; the four-source intersection
        // materializes that choice.
        expect(desired.selected).toBe("dynamic");

        // Feeding the pinned placement into the live membrane: even a plain observe
        // under a live lease cannot run direct off-actor.
        const resolution = resolutionWith([], "dynamic");
        expect(authority.tier(resolution, observeDescriptor, false)).toBe("mediated");
    });
});

// --- package fixture -------------------------------------------------------------------------

function packageRelease(id: string, contributions: Contributions): PackageRelease {
    const version = new SemVer("1.0.0");
    const manifests = [
        new FacetManifest({
            id: new FacetPackageId(`${id}.facet`),
            version,
            compat: CompatRange.any(),
            isolation: ["dynamic"],
            bindings: [],
            contributions
        })
    ] as [FacetManifest];
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digestOf(`code:${id}`)),
                media: new MediaHint("application/javascript")
            })
        ],
        entrypoints: [
            new PackageCodeEntrypoint({
                facet: manifests[0].id,
                version: manifests[0].version,
                module: "./main.js"
            })
        ]
    });
    return new PackageRelease({
        id: new PackageId(id),
        version,
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests,
        codeManifest,
        provenance: { registry: "test" }
    });
}

function packageLock(releases: readonly PackageRelease[]): PackageLock {
    const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases });
    return new PackageLock({
        target,
        roots: releases.map((release) => new PackageDependency(release.id, "^1")),
        snapshotRevision: snapshot.revision,
        snapshotDigest: snapshot.digest,
        packages: releases.map(
            (release) =>
                new PackagePin(
                    release.id,
                    release.version,
                    release.manifestDigest,
                    release.codeDigest
                )
        )
    });
}

function digestOf(label: string): Digest {
    return Digest.sha256(new TextEncoder().encode(label));
}

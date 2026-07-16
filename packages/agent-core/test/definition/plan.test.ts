import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { MediaHint } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    Revision,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import {
    ActorPlan,
    Blueprint,
    DeploymentId,
    DeploymentKey,
    DesiredProjection,
    ManagedOrigin,
    ManagedStateRecord,
    MaterializationPlan,
    MaterializationTopologyPort,
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
    PlatformCompatibility,
    PlacementInput,
    PlacementSelection,
    PlacementSourcePort,
    PolicySet,
    ValidatedBlueprint,
    placementProjection,
    policyProjection,
    selectPlacement,
    planMaterialization
} from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import { Contributions, FacetManifest, FacetPackageId } from "../../src/facets";
import { TenantId } from "../../src/identity";

const encoder = new TextEncoder();
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });
const tenantId = new TenantId("tenant-a");
const deploymentKey = new DeploymentKey("platform");
const placementSource = new (class extends PlacementSourcePort {
    public sources(_release: PackageRelease, _manifest: FacetManifest) {
        return {
            substrate: ["dynamic", "provider", "bundled"],
            trust: ["dynamic", "provider", "bundled"]
        } as const;
    }
})();
const topology = new (class extends MaterializationTopologyPort {
    public actorFor(_validated: ValidatedBlueprint, projection: DesiredProjection): ActorRef {
        return projection.recordKind === "policy-set"
            ? new ActorRef("tenant", new ActorId("tenant-a"))
            : new ActorRef("workspace", new ActorId("workspace-a"));
    }
})();

describe("materialization planning", () => {
    test("normalizes reordered inputs into byte-identical Actor-local plans", () => {
        const validatedBlueprint = validatedDefinition(["zeta", "alpha"]);
        const first = planMaterialization({
            validatedBlueprint,
            tenantId,
            deploymentKey,
            generation: 4,
            topology
        });
        const reorderedBlueprint = validatedDefinition(["alpha", "zeta"]);
        const second = planMaterialization({
            validatedBlueprint: reorderedBlueprint,
            tenantId,
            deploymentKey,
            generation: 4,
            topology
        });

        expect(MaterializationPlan.encode(second)).toEqual(MaterializationPlan.encode(first));
        expect(second.id.equals(first.id)).toBe(true);
        expect(first.actors.map((plan) => `${plan.actor.kind}:${plan.actor.id.value}`)).toEqual([
            "tenant:tenant-a",
            "workspace:workspace-a"
        ]);
        expect(first.actors[1]?.projections.map((projection) => projection.logicalKey)).toEqual([
            "install:alpha:alpha.facet",
            "install:zeta:zeta.facet",
            "placement:alpha:alpha.facet",
            "placement:zeta:zeta.facet"
        ]);
        expect(
            first.packageLockDigest.equals(
                Digest.sha256(PackageLock.encode(validatedBlueprint.lock))
            )
        ).toBe(true);
        expect(
            first.configDigest.equals(
                Digest.sha256(
                    encodeCanonicalJson({
                        alpha: { enabled: true },
                        zeta: { enabled: true }
                    })
                )
            )
        ).toBe(true);
        expect(
            first.blueprintDigest.equals(
                Digest.sha256(Blueprint.encode(validatedBlueprint.blueprint))
            )
        ).toBe(true);
        expect(first.generation).toBe(4);
        expect(() =>
            planMaterialization({
                validatedBlueprint,
                tenantId,
                deploymentKey,
                generation: 5,
                topology: new (class extends MaterializationTopologyPort {
                    public actorFor(): ActorRef {
                        return {} as ActorRef;
                    }
                })()
            })
        ).toThrow(/must return an ActorRef/);
    });

    test("[definition.managed-origin] [definition.actor-plan] [definition.materialization-plan] copies desired data and round-trips every planning record codec", () => {
        const approvals: ("execute" | "externalSend")[] = ["execute"];
        const projection = policyProjection("policy:dashboard", new PolicySet({ approvals }));
        const origin = managedOrigin();
        const actorPlan = new ActorPlan({
            actor: new ActorRef("workspace", new ActorId("workspace-a")),
            origin,
            projections: [projection]
        });
        const plan = new MaterializationPlan({ origin, actors: [actorPlan] });
        approvals.push("externalSend");

        expect(projection.desired).toEqual({
            approvals: ["execute"],
            placement: { allowed: ["dynamic", "provider", "bundled"] },
            tiers: {}
        });
        expect(Object.isFrozen(projection.desired)).toBe(true);
        expect(Object.isFrozen((projection.desired as { placement: JsonValue }).placement)).toBe(
            true
        );
        expect(ManagedOrigin.encode(ManagedOrigin.decode(ManagedOrigin.encode(origin)))).toEqual(
            ManagedOrigin.encode(origin)
        );
        expect(ActorPlan.encode(ActorPlan.decode(ActorPlan.encode(actorPlan)))).toEqual(
            ActorPlan.encode(actorPlan)
        );
        expect(
            MaterializationPlan.encode(MaterializationPlan.decode(MaterializationPlan.encode(plan)))
        ).toEqual(MaterializationPlan.encode(plan));
        expect(Object.isFrozen(plan)).toBe(true);
        expect(Object.isFrozen(plan.actors)).toBe(true);
        expect(Object.isFrozen(actorPlan.projections)).toBe(true);
        expect(
            new MaterializationPlan({ origin, actors: [actorPlan, actorPlan] }).actors
        ).toHaveLength(1);
        expect(() =>
            planMaterialization({
                validatedBlueprint: {} as ValidatedBlueprint,
                tenantId,
                deploymentKey,
                generation: 1,
                topology
            })
        ).toThrow(/requires a ValidatedBlueprint/);
        expect(() =>
            DesiredProjection.fromData({
                ...(projection.toData() as object),
                logicalKey: 7
            })
        ).toThrow(/string/);
    });

    test("deduplicates identical logical keys and rejects conflicting desired records", () => {
        const projection = policyProjection("scope:default", PolicySet.empty());
        const duplicate = policyProjection("scope:default", PolicySet.empty());
        const origin = managedOrigin();
        const actor = new ActorRef("tenant", new ActorId("tenant-a"));
        const plan = new ActorPlan({ actor, origin, projections: [projection, duplicate] });

        expect(plan.projections).toHaveLength(1);
        expect(
            () =>
                new ActorPlan({
                    actor,
                    origin,
                    projections: [
                        projection,
                        policyProjection("scope:default", new PolicySet({ approvals: ["execute"] }))
                    ]
                })
        ).toThrow(/Conflicting desired projections.*scope:default/);
    });

    test("records all four placement source sets and validates the fixed selection", () => {
        const projection = placementProjection(
            "placement:acme.deploy",
            "acme.deploy",
            selectPlacement({
                manifest: ["bundled", "dynamic", "provider"],
                policy: ["provider", "dynamic"],
                substrate: ["provider", "dynamic"],
                trust: ["provider"]
            })
        );

        expect(projection.desired).toEqual({
            facet: "acme.deploy",
            manifest: ["dynamic", "provider", "bundled"],
            policy: ["dynamic", "provider"],
            selected: "provider",
            substrate: ["dynamic", "provider"],
            trust: ["provider"]
        });
        const nonPreferredSelection = new PlacementSelection(
            new PlacementInput({
                manifest: ["dynamic", "provider"],
                policy: ["dynamic", "provider"],
                substrate: ["dynamic", "provider"],
                trust: ["dynamic", "provider"]
            }),
            "provider"
        );
        expect(() =>
            placementProjection("placement:acme.deploy", "acme.deploy", nonPreferredSelection)
        ).toThrow(/four-source intersection/);
    });

    test.each([
        "unknown",
        "nonsense-kind",
        "facet_placement",
        "test-resource",
        "binding",
        "authority.grant",
        "identity.role",
        "scope",
        "facet.slot-entry",
        "placement",
        "policy",
        "facet-placement.v1",
        "policy-set.v1"
    ])("rejects unsupported materialization kind %s", (recordKind) => {
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: "unsupported:projection",
                    recordKind,
                    desired: PolicySet.empty().toData()
                })
        ).toThrow(/Unsupported materialization record kind/);
    });

    test("admits every normative materialization kind", () => {
        expect(ManagedStateRecord.supportedRecordKinds()).toEqual([
            "agent-profile",
            "environment",
            "facet-install",
            "facet-placement",
            "policy-set",
            "scope-scaffold",
            "slot-entry",
            "subscription",
            "surface-layout"
        ]);
        expect(Object.isFrozen(ManagedStateRecord.supportedRecordKinds())).toBe(true);
    });

    test("snapshots kind accessors before validation and assignment", () => {
        let projectionKindReads = 0;
        const projection = new DesiredProjection({
            logicalKey: "policy:accessor",
            get recordKind() {
                projectionKindReads += 1;
                return projectionKindReads === 1 ? "policy-set" : "slot-entry";
            },
            desired: PolicySet.empty().toData()
        });
        expect(projectionKindReads).toBe(1);
        expect(projection.recordKind).toBe("policy-set");

        let recordKindReads = 0;
        const record = new ManagedStateRecord({
            actor: new ActorRef("tenant", new ActorId("tenant-accessor")),
            origin: managedOrigin(),
            generationId: digestOf("generation:accessor"),
            logicalKey: projection.logicalKey,
            get recordKind() {
                recordKindReads += 1;
                return recordKindReads === 1 ? "policy-set" : "slot-entry";
            },
            desired: projection.desired
        });
        expect(recordKindReads).toBe(1);
        expect(record.recordKind).toBe("policy-set");
    });

    test("canonicalizes policy-set desired data before deriving identity", () => {
        const noncanonical = new DesiredProjection({
            logicalKey: "policy:canonical",
            recordKind: "policy-set",
            desired: {
                approvals: ["mutate", "execute"],
                placement: { allowed: ["bundled", "dynamic", "provider"] },
                tiers: {}
            }
        });
        const canonical = policyProjection(
            "policy:canonical",
            new PolicySet({ approvals: ["execute", "mutate"] })
        );

        expect(noncanonical.desired).toEqual(canonical.desired);
        expect(noncanonical.desiredDigest.equals(canonical.desiredDigest)).toBe(true);
    });

    test("rejects non-primitive supported-kind lookalikes", () => {
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: "unsupported:boxed-kind",
                    recordKind: Object("policy-set") as string,
                    desired: PolicySet.empty().toData()
                })
        ).toThrow(/record kind/);
    });

    test("validates supported materialization payloads through their domain invariants", () => {
        const placement = placementProjection(
            "placement:acme.deploy",
            "acme.deploy",
            selectPlacement({
                manifest: ["dynamic", "provider"],
                policy: ["dynamic", "provider"],
                substrate: ["dynamic", "provider"],
                trust: ["dynamic", "provider"]
            })
        );
        const placementDesired = requireObject(placement.desired);

        expect(
            () =>
                new DesiredProjection({
                    logicalKey: placement.logicalKey,
                    recordKind: placement.recordKind,
                    desired: { ...placementDesired, selected: "provider" }
                })
        ).toThrow(/four-source intersection/);
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: placement.logicalKey,
                    recordKind: placement.recordKind,
                    desired: { ...placementDesired, manifest: ["provider", "dynamic"] }
                })
        ).toThrow(/canonical placement order/);
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: placement.logicalKey,
                    recordKind: placement.recordKind,
                    desired: null
                })
        ).toThrow(/must be an object/);
        const { trust: _trust, ...missingTrust } = placementDesired;
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: placement.logicalKey,
                    recordKind: placement.recordKind,
                    desired: missingTrust
                })
        ).toThrow(/missing or unknown fields/);
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: placement.logicalKey,
                    recordKind: placement.recordKind,
                    desired: { ...placementDesired, facet: " acme.deploy" }
                })
        ).toThrow(/nonblank canonical string/);
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: placement.logicalKey,
                    recordKind: placement.recordKind,
                    desired: { ...placementDesired, manifest: "dynamic" }
                })
        ).toThrow(/must be an array/);
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: "policy:malformed",
                    recordKind: "policy-set",
                    desired: { approvals: [], placement: { allowed: [] }, tiers: {} }
                })
        ).toThrow(/must not be empty/);
        expect(() =>
            DesiredProjection.fromData({
                ...requireObject(policyProjection("policy:valid", PolicySet.empty()).toData()),
                recordKind: "facet.slot-entry"
            })
        ).toThrow(/Unsupported materialization record kind/);
    });

    test("[C13-POLICY-EPOCH-RECHECK] rechecks supported kinds while assembling Actor and materialization plans", () => {
        const origin = managedOrigin();
        const actor = new ActorRef("tenant", new ActorId("tenant-a"));
        const valid = policyProjection("policy:tenant", PolicySet.empty());
        const unsupported = forgeProjectionKind(valid, "identity.role");

        expect(() => new ActorPlan({ actor, origin, projections: [unsupported] })).toThrow(
            /Unsupported materialization record kind/
        );

        const actorPlan = new ActorPlan({ actor, origin, projections: [valid] });
        const forgedActor = forgeActorPlanProjections(actorPlan, [unsupported]);
        expect(
            () =>
                new MaterializationPlan({
                    origin,
                    actors: [forgedActor]
                })
        ).toThrow(/Unsupported materialization record kind/);
        expectCodecError(() => ActorPlan.decode(ActorPlan.encode(forgedActor)), "codec.invalid");

        const materialization = new MaterializationPlan({ origin, actors: [actorPlan] });
        const forgedMaterialization = Object.assign(
            Object.create(MaterializationPlan.prototype) as MaterializationPlan,
            materialization,
            { actors: Object.freeze([forgedActor]) }
        );
        expectCodecError(
            () => MaterializationPlan.decode(MaterializationPlan.encode(forgedMaterialization)),
            "codec.invalid"
        );
    });

    test("rejects mismatched IDs, origins, digests, and unknown codec fields", () => {
        const origin = managedOrigin();
        const projection = policyProjection(
            "agent:helper",
            new PolicySet({
                tiers: { execute: "mediated" }
            })
        );
        const actorPlan = new ActorPlan({
            actor: new ActorRef("workspace", new ActorId("workspace-a")),
            origin,
            projections: [projection]
        });

        expect(
            () =>
                new DesiredProjection({
                    logicalKey: projection.logicalKey,
                    recordKind: projection.recordKind,
                    desired: projection.desired,
                    desiredDigest: digestOf("wrong")
                })
        ).toThrow(/digest/);
        expect(
            () =>
                new ManagedOrigin({
                    ...origin,
                    generation: -1
                })
        ).toThrow(/non-negative/);
        expect(
            new ActorPlan({
                actor: actorPlan.actor,
                origin,
                projections: []
            }).projections
        ).toEqual([]);
        expect(
            () =>
                new ActorPlan({
                    actor: actorPlan.actor,
                    origin,
                    projections: [projection],
                    id: digestOf("wrong")
                })
        ).toThrow(/Actor plan ID/);
        expect(
            () =>
                new MaterializationPlan({
                    origin,
                    actors: [
                        new ActorPlan({
                            actor: actorPlan.actor,
                            origin: new ManagedOrigin({
                                ...origin,
                                generation: origin.generation + 1
                            }),
                            projections: [projection]
                        })
                    ]
                })
        ).toThrow(/plan origin/);
        expect(
            () =>
                new MaterializationPlan({
                    origin,
                    actors: [actorPlan],
                    id: digestOf("wrong")
                })
        ).toThrow(/Materialization plan ID/);
        expect(
            new MaterializationPlan({
                origin,
                actors: []
            }).actors
        ).toEqual([]);

        const envelope = requireObject(decodeCanonicalJson(ManagedOrigin.encode(origin)));
        const payload = requireObject(envelope["payload"]!);
        expectCodecError(
            () =>
                ManagedOrigin.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...payload, current: true }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                ActorPlan.decode(
                    encodeCanonicalJson({
                        ...requireObject(decodeCanonicalJson(ActorPlan.encode(actorPlan))),
                        version: { major: 2, minor: 0 }
                    })
                ),
            "codec.unknown-major"
        );
        const materialization = new MaterializationPlan({ origin, actors: [actorPlan] });
        const planEnvelope = requireObject(
            decodeCanonicalJson(MaterializationPlan.encode(materialization))
        );
        const planPayload = requireObject(planEnvelope["payload"]!);
        expectCodecError(
            () =>
                MaterializationPlan.decode(
                    encodeCanonicalJson({
                        ...planEnvelope,
                        payload: { ...planPayload, activation: "pending" }
                    })
                ),
            "codec.invalid"
        );
    });
});

function managedOrigin(): ManagedOrigin {
    return new ManagedOrigin({
        tenantId,
        deploymentId: DeploymentId.derive(tenantId, deploymentKey),
        attestationDigest: digestOf("attestation"),
        blueprintDigest: digestOf("blueprint"),
        packageLockDigest: digestOf("package-lock"),
        configDigest: digestOf("config"),
        generation: 3
    });
}

function packageLock(releases: readonly PackageRelease[]): PackageLock {
    const snapshot = new MetadataSnapshot({ revision: new Revision(7), releases });
    return new PackageLock({
        target,
        roots: releases.map(
            (release) => new PackageDependency(release.id, release.version.toString())
        ),
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

function validatedDefinition(order: readonly string[]): ValidatedBlueprint {
    const releases = order.map((id) => packageRelease(id, "1.0.0"));
    const lock = packageLock(releases);
    const blueprint = new Blueprint({
        meta: { name: "platform", version: new SemVer("1.0.0") },
        packages: order.map(
            (id) =>
                new PackageInstall({
                    request: new PackageDependency(new PackageId(id), "1.0.0"),
                    config: { enabled: true }
                })
        ),
        policies: PolicySet.empty(),
        agents: []
    });
    return ValidatedBlueprint.validate(blueprint, {
        lock,
        releases,
        target,
        placement: placementSource,
        schemaValidator: { validate: () => true }
    });
}

function packageRelease(id: string, version: string): PackageRelease {
    const manifests = [
        new FacetManifest({
            id: new FacetPackageId(`${id}.facet`),
            version: new SemVer(version),
            compat: CompatRange.any(),
            isolation: ["dynamic"],
            bindings: [],
            contributions: new Contributions([])
        })
    ] as [FacetManifest];
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digestOf(`code:${id}:${version}`)),
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
        version: new SemVer(version),
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests,
        codeManifest,
        provenance: { registry: "test" }
    });
}

function digestOf(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

function forgeProjectionKind(projection: DesiredProjection, recordKind: string): DesiredProjection {
    return Object.assign(
        Object.create(DesiredProjection.prototype) as DesiredProjection,
        projection,
        { recordKind }
    );
}

function forgeActorPlanProjections(
    plan: ActorPlan,
    projections: readonly DesiredProjection[]
): ActorPlan {
    return Object.assign(Object.create(ActorPlan.prototype) as ActorPlan, plan, {
        projections: Object.freeze([...projections])
    });
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected object");
    }
    return value as { readonly [key: string]: JsonValue };
}

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected codec error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}

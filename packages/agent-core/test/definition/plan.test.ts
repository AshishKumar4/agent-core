import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { MediaHint } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    requireNonempty,
    type JsonValue
} from "../../src/core";
import {
    ActorPlan,
    Blueprint,
    BlueprintDeclarationCodecPort,
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
    planMaterialization,
    type BlueprintInit
} from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import {
    BindingName,
    Command,
    Contribution,
    Contributions,
    FacetManifest,
    FacetPackageId,
    OperationRef,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotName
} from "../../src/facets";
import { TenantId } from "../../src/identity";
import { recordData, requireObject, tamperedRecord } from "./record-data";

const encoder = new TextEncoder();
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });
const tenantId = new TenantId("tenant-a");
const deploymentKey = new DeploymentKey("platform");
const placementSource = new (class extends PlacementSourcePort {
    public substrateModes(_release: PackageRelease, _manifest: FacetManifest) {
        return ["dynamic", "provider", "bundled"] as const;
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
    test("normalizes reordered inputs into byte-identical Actor-local plans", { tags: "p0" }, () => {
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

    test("[definition.managed-origin] [definition.actor-plan] [definition.materialization-plan] copies desired data and round-trips every planning record codec", { tags: "p1" }, () => {
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
            maxDirectRevocationWindowMs: null,
            placement: { allowed: ["dynamic", "provider", "bundled"], trusted: ["*"] },
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
                ...recordData(projection),
                logicalKey: 7
            })
        ).toThrow(/string/);
    });

    test("deduplicates identical logical keys and rejects conflicting desired records", { tags: "p1" }, () => {
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

    test("records all four placement source sets and validates the fixed selection", { tags: "p1" }, () => {
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
    ])("rejects unsupported materialization kind %s", { tags: "p1" }, (recordKind) => {
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: "unsupported:projection",
                    recordKind,
                    desired: PolicySet.empty().toData()
                })
        ).toThrow(/Unsupported materialization record kind/);
    });

    test.each<MalformedProjection>([
        {
            label: "facet-install with unknown fields",
            recordKind: "facet-install",
            desired: {
                facetId: "acme.deploy",
                facetVersion: "1.0.0",
                packageId: "acme.tools",
                extra: "field"
            },
            message: /Facet install contains missing or unknown fields/
        },
        {
            label: "scope-scaffold with an empty declaration",
            recordKind: "scope-scaffold",
            desired: {},
            message: /declaration must not be empty/
        },
        {
            label: "slot-entry with a negative index",
            recordKind: "slot-entry",
            desired: {
                contributor: "acme.deploy",
                slot: "chat.composer",
                index: -1,
                value: { command: "deploy" }
            },
            message: /Slot entry index must be a non-negative safe integer/
        }
    ])("rejects malformed desired state: $label", { tags: "p1" }, ({ recordKind, desired, message }) => {
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: "malformed:projection",
                    recordKind,
                    desired
                })
        ).toThrow(message);
    });

    test("admits every normative materialization kind", { tags: "p1" }, () => {
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

    test("snapshots kind accessors before validation and assignment", { tags: "p1" }, () => {
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

    test("canonicalizes policy-set desired data before deriving identity", { tags: "p0" }, () => {
        const noncanonical = new DesiredProjection({
            logicalKey: "policy:canonical",
            recordKind: "policy-set",
            desired: {
                approvals: ["mutate", "execute"],
                maxDirectRevocationWindowMs: null,
                placement: { allowed: ["bundled", "dynamic", "provider"], backings: {}, trusted: ["*"] },
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

    test("rejects non-primitive supported-kind lookalikes", { tags: "p1" }, () => {
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: "unsupported:boxed-kind",
                    recordKind: Object("policy-set") as string,
                    desired: PolicySet.empty().toData()
                })
        ).toThrow(/record kind/);
    });

    test("validates supported materialization payloads through their domain invariants", { tags: "p1" }, () => {
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
                    desired: {
                        approvals: [],
                        maxDirectRevocationWindowMs: null,
                        placement: { allowed: [], backings: {}, trusted: ["*"] },
                        tiers: {}
                    }
                })
        ).toThrow(/must not be empty/);
        expect(() =>
            DesiredProjection.fromData({
                ...requireObject(policyProjection("policy:valid", PolicySet.empty()).toData()),
                recordKind: "facet.slot-entry"
            })
        ).toThrow(/Unsupported materialization record kind/);
    });

    test("rechecks supported kinds while assembling Actor and materialization plans", { tags: "p1" }, () => {
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
        const forgedMaterialization = tamperedRecord(materialization,
            { actors: Object.freeze([forgedActor]) }
        );
        expectCodecError(
            () => MaterializationPlan.decode(MaterializationPlan.encode(forgedMaterialization)),
            "codec.invalid"
        );
    });

    test("rejects mismatched IDs, origins, digests, and unknown codec fields", { tags: "p0" }, () => {
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

describe("materialization planning mutation boundaries", () => {
    test("consults topology in canonical record kind then logical key order", { tags: "p1" }, () => {
        const ownerSlot = new SlotDeclaration(
            new SlotName("owner.slot"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const validatedBlueprint = validatedCustom({
            slots: [ownerSlot.toData()],
            agents: [{ name: "helper" }],
            environments: [{ region: "eu" }]
        });
        const seen: (readonly [string, string])[] = [];
        const recording = new (class extends MaterializationTopologyPort {
            public actorFor(
                _validated: ValidatedBlueprint,
                projection: DesiredProjection
            ): ActorRef {
                seen.push([projection.recordKind, projection.logicalKey]);
                return new ActorRef("tenant", new ActorId("tenant-a"));
            }
        })();

        planMaterialization({
            validatedBlueprint,
            tenantId,
            deploymentKey,
            generation: 1,
            topology: recording
        });
        expect(seen).toEqual([
            ["agent-profile", "agent:0"],
            ["environment", "environment:0"],
            ["facet-install", "install:alpha:alpha.facet"],
            ["facet-placement", "placement:alpha:alpha.facet"],
            ["policy-set", "policy:platform"],
            ["slot-entry", "contribution:blueprint:slots:0"]
        ]);
    });

    test("derives one command subscription with the canonical input mapping", { tags: "p1" }, () => {
        const command = new Command({
            name: "deploy",
            title: "Deploy",
            arguments: new JsonSchema({ type: "object" }),
            operation: new OperationRef("acme.deploy:run"),
            binding: new BindingName("deploy"),
            surfaces: [new SlotName("settings"), new SlotName("surfaces")]
        });
        const validatedBlueprint = validatedCustom({
            packageId: "acme",
            contributions: new Contributions([
                new Contribution(new SlotName("commands"), [command.toData()])
            ])
        });

        const plan = planMaterialization({
            validatedBlueprint,
            tenantId,
            deploymentKey,
            generation: 1,
            topology
        });
        const subscription = plan.actors
            .flatMap((actor) => actor.projections)
            .find(
                (projection) => projection.logicalKey === "subscription:command:acme.facet:deploy"
            );
        const expected = new DesiredProjection({
            logicalKey: "subscription:command:acme.facet:deploy",
            recordKind: "subscription",
            desired: {
                authority: "initiator",
                binding: "deploy",
                dedupe: "event",
                mapping: [{ from: "/input", to: "" }],
                source: {
                    acceptedTrust: ["owner", "authenticated", "self"],
                    kind: "command.invoked",
                    source: "acme.facet:deploy"
                },
                target: "acme.deploy:run"
            }
        });
        expect(subscription?.desired).toEqual(expected.desired);
        expect(subscription?.desiredDigest.equals(expected.desiredDigest)).toBe(true);
    });

    test("honors slot contribute authority through wildcard selectors", { tags: "p1" }, () => {
        const contributions = new Contributions([
            new Contribution(new SlotName("dashboard.card"), [{ title: "Health" }])
        ]);
        const admitted = validatedCustom({
            packageId: "cards",
            contributions,
            slots: [
                new SlotDeclaration(
                    new SlotName("dashboard.card"),
                    new JsonSchema({ type: "object" }),
                    new SlotAuthorityPolicy(["cards.*", "installed"], ["scope.read"])
                ).toData()
            ]
        });
        const plan = planMaterialization({
            validatedBlueprint: admitted,
            tenantId,
            deploymentKey,
            generation: 1,
            topology
        });
        expect(
            plan.actors
                .flatMap((actor) => actor.projections)
                .some(
                    (projection) =>
                        projection.logicalKey === "contribution:cards.facet:dashboard.card:0"
                )
        ).toBe(true);

        const denied = validatedCustom({
            packageId: "cards",
            contributions,
            slots: [
                new SlotDeclaration(
                    new SlotName("dashboard.card"),
                    new JsonSchema({ type: "object" }),
                    new SlotAuthorityPolicy(["other.*"], ["scope.read"])
                ).toData()
            ]
        });
        expect(() =>
            planMaterialization({
                validatedBlueprint: denied,
                tenantId,
                deploymentKey,
                generation: 1,
                topology
            })
        ).toThrow(/Contributor cards.facet may not contribute to slot dashboard.card/);
    });

    test("permits contributions to host-published slots without contribute authority", { tags: "p1" }, () => {
        const validatedBlueprint = validatedCustom({
            packageId: "hosted",
            contributions: new Contributions([
                new Contribution(new SlotName("host.slot"), [{ enabled: true }])
            ]),
            coreSlots: [
                new SlotDeclaration(
                    new SlotName("host.slot"),
                    new JsonSchema({ type: "object" }),
                    new SlotAuthorityPolicy(["host"], ["scope.read"])
                )
            ]
        });
        const plan = planMaterialization({
            validatedBlueprint,
            tenantId,
            deploymentKey,
            generation: 1,
            topology
        });
        expect(
            plan.actors
                .flatMap((actor) => actor.projections)
                .some(
                    (projection) =>
                        projection.logicalKey === "contribution:hosted.facet:host.slot:0"
                )
        ).toBe(true);
    });

    test("recomputes placement from the intersection of all four sources", { tags: "p1" }, () => {
        const narrowManifest = placementProjection(
            "placement:acme:acme.deploy",
            "acme.deploy",
            selectPlacement({
                manifest: ["provider"],
                policy: ["dynamic", "provider"],
                substrate: ["dynamic", "provider"],
                trust: ["dynamic", "provider"]
            })
        );
        expect(requireObject(narrowManifest.desired)["selected"]).toBe("provider");

        const narrowPolicy = placementProjection(
            "placement:acme:acme.deploy",
            "acme.deploy",
            selectPlacement({
                manifest: ["provider"],
                policy: ["provider"],
                substrate: ["dynamic", "provider"],
                trust: ["dynamic", "provider"]
            })
        );
        expect(requireObject(narrowPolicy.desired)["selected"]).toBe("provider");
    });

    test("derives distinct Actor plan identities and rejects conflicting duplicates", { tags: "p1" }, () => {
        const origin = managedOrigin();
        const first = new ActorPlan({
            actor: new ActorRef("workspace", new ActorId("a")),
            origin,
            projections: []
        });
        const second = new ActorPlan({
            actor: new ActorRef("workspace", new ActorId("b")),
            origin,
            projections: []
        });
        expect(first.id.equals(second.id)).toBe(false);

        const left = new DesiredProjection({
            logicalKey: "contribution:acme:cards:0",
            recordKind: "slot-entry",
            desired: { contributor: "acme", index: 0, slot: "cards", value: { a: 1 } }
        });
        const right = new DesiredProjection({
            logicalKey: "contribution:acme:cards:0",
            recordKind: "slot-entry",
            desired: { contributor: "acme", index: 0, slot: "cards", value: { a: 2 } }
        });
        expect(encodeCanonicalJson(left.toData()).byteLength).toBe(
            encodeCanonicalJson(right.toData()).byteLength
        );
        const actor = new ActorRef("workspace", new ActorId("conflict"));
        expect(() => new ActorPlan({ actor, origin, projections: [left, right] })).toThrow(
            /Conflicting desired projections for logical key contribution:acme:cards:0/
        );

        const withLeft = new ActorPlan({ actor, origin, projections: [left] });
        const withRight = new ActorPlan({ actor, origin, projections: [right] });
        expect(() => new MaterializationPlan({ origin, actors: [withLeft, withRight] })).toThrow(
            /Conflicting Actor plans for workspace:conflict/
        );
    });

    test("labels every planning payload subject in decode errors", { tags: "p2" }, () => {
        const projection = policyProjection("policy:subject", PolicySet.empty());
        const projectionData = requireObject(projection.toData());
        expect(() => DesiredProjection.fromData({ ...projectionData, logicalKey: 7 })).toThrow(
            /Desired projection logical key must be a string/
        );
        expect(() => DesiredProjection.fromData({ ...projectionData, recordKind: 7 })).toThrow(
            /Desired projection record kind must be a string/
        );
        expect(() => DesiredProjection.fromData({ ...projectionData, desiredDigest: 7 })).toThrow(
            /Desired projection digest must be a string/
        );

        const origin = managedOrigin();
        const actorPlan = new ActorPlan({
            actor: new ActorRef("workspace", new ActorId("workspace-a")),
            origin,
            projections: [projection]
        });
        const actorPlanData = requireObject(actorPlan.toData());
        expect(() => ActorPlan.fromData({ ...actorPlanData, id: 7 })).toThrow(
            /Actor plan ID must be a string/
        );
        expect(() =>
            ActorPlan.fromData({ ...actorPlanData, origin: undefined } as never)
        ).toThrow(/Actor plan origin is required/);
        expect(() =>
            ActorPlan.fromData({ ...actorPlanData, actor: { id: 7, kind: "workspace" } })
        ).toThrow(/Actor ID must be a string/);

        const materialization = new MaterializationPlan({ origin, actors: [actorPlan] });
        const materializationData = requireObject(materialization.toData());
        expect(() => MaterializationPlan.fromData({ ...materializationData, id: 7 })).toThrow(
            /Materialization plan ID must be a string/
        );
    });

    test("rejects malformed canonical names and non-object payloads", { tags: "p1" }, () => {
        for (const logicalKey of ["", " ", "x "]) {
            expect(
                () =>
                    new DesiredProjection({
                        logicalKey,
                        recordKind: "policy-set",
                        desired: PolicySet.empty().toData()
                    })
            ).toThrow(/Desired projection logical key must be a nonblank canonical string/);
        }
        const malformedPayloads: readonly JsonValue[] = [null, ["entry"], "text"];
        for (const payload of malformedPayloads) {
            expect(() => DesiredProjection.fromData(payload)).toThrow(
                /Desired projection must be an object/
            );
            expect(() => ActorPlan.fromData(payload)).toThrow(/Actor plan must be an object/);
            expect(() => MaterializationPlan.fromData(payload)).toThrow(
                /Materialization plan must be an object/
            );
        }
    });
});

const identityDeclarationCodecs = new BlueprintDeclarationCodecPort(
    (["agents", "environments", "slots"] as const).map((field) => ({
        field,
        canonicalize: (value: JsonValue): JsonValue => value
    }))
);

interface CustomDefinitionInit {
    readonly packageId?: string;
    readonly contributions?: Contributions;
    readonly slots?: readonly JsonValue[];
    readonly agents?: readonly JsonValue[];
    readonly environments?: readonly JsonValue[];
    readonly coreSlots?: readonly SlotDeclaration[];
}

function validatedCustom(init: CustomDefinitionInit): ValidatedBlueprint {
    const id = init.packageId ?? "alpha";
    const release = packageRelease(id, "1.0.0", init.contributions);
    const required: BlueprintInit = {
        meta: { name: "platform", version: new SemVer("1.0.0") },
        packages: [
            new PackageInstall({
                request: new PackageDependency(new PackageId(id), "1.0.0"),
                config: { enabled: true }
            })
        ],
        policies: PolicySet.empty(),
        agents: init.agents ?? []
    };
    const slotted: BlueprintInit =
        init.slots === undefined ? required : { ...required, slots: init.slots };
    const source = new Blueprint(
        init.environments === undefined
            ? slotted
            : { ...slotted, environments: init.environments }
    );
    return ValidatedBlueprint.validate(source, {
        lock: packageLock([release]),
        releases: [release],
        target,
        placement: placementSource,
        schemaValidator: { validate: () => true },
        declarationCodecs: identityDeclarationCodecs,
        ...(init.coreSlots === undefined ? {} : { coreSlots: init.coreSlots })
    });
}

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

function packageRelease(
    id: string,
    version: string,
    contributions: Contributions = new Contributions([])
): PackageRelease {
    const manifests = requireNonempty([
        new FacetManifest({
            id: new FacetPackageId(`${id}.facet`),
            version: new SemVer(version),
            compat: CompatRange.any(),
            isolation: ["dynamic"],
            bindings: [],
            contributions
        })
    ], "Facet manifests");
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

/** One desired-state payload a projection must reject, with the diagnostic it must name. */
interface MalformedProjection {
    readonly label: string;
    readonly recordKind: string;
    readonly desired: JsonValue;
    readonly message: RegExp;
}

function digestOf(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

function forgeProjectionKind(projection: DesiredProjection, recordKind: string): DesiredProjection {
    return tamperedRecord(projection,
        { recordKind }
    );
}

function forgeActorPlanProjections(
    plan: ActorPlan,
    projections: readonly DesiredProjection[]
): ActorPlan {
    return tamperedRecord(plan, {
        projections: Object.freeze([...projections])
    });
}


function expectCodecError(action: () => void, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected codec error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}

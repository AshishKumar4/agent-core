import { describe, expect, test } from "vitest";
import { CompatRange, JsonSchema, SemVer, SecretRef, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import * as declarations from "../../src/facets-public";
import {
    Automation,
    BindingName,
    BindingRequirement,
    Command,
    Contribution,
    Contributions,
    EventDeclaration,
    EventKind,
    EventPattern,
    FacetManifest,
    FacetPackageId,
    FieldMapping,
    FieldMove,
    IngressDeclaration,
    IngressVerification,
    InterceptorDeclaration,
    InterceptorId,
    OperationDescriptor,
    OperationName,
    OperationPattern,
    OperationRef,
    OperationSelector,
    PayloadMapping,
    Prompt,
    PromptContribution,
    ProvenanceMapping,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotEntry,
    SlotName,
    SurfaceDescriptor,
    SurfaceId,
    canonicalFacetData,
    isFacetData,
    isFacetDataMap,
    type FacetDataMap
} from "../../src/facets-public";
import {
    claimHonorsEnforcementFloor,
    enforcementFloor,
    type Impact
} from "../../src/facets/contribution";
import { FacetRef } from "../../src/facets/id";
import { BoundOperationRef, FacetOperationRef } from "../../src/facets/operation";

const objectSchema = new JsonSchema({ type: "object" });

describe("Declarative facet vocabulary", () => {
    test(
        "exports W3-owned Facet, Operation, and Surface contracts without host constructors",
        { tags: "p2" },
        () => {
            expect("Facet" in declarations).toBe(true);
            expect("Operation" in declarations).toBe(true);
            expect("Surface" in declarations).toBe(true);
            expect("FacetRuntimeHost" in declarations).toBe(false);
            expect("InternalProfileFacetRuntime" in declarations).toBe(false);
            expect("FacetManifest" in declarations).toBe(true);
            expect("OperationDescriptor" in declarations).toBe(true);
            expect("SlotAuthorityEvaluator" in declarations).toBe(false);
            expect("SlotCatalog" in declarations).toBe(false);
            expect("SlotStore" in declarations).toBe(false);
            expect("MemorySlotStore" in declarations).toBe(false);
        }
    );

    test(
        "accepts only canonical JSON facet data and freezes canonical copies",
        { tags: "p0" },
        () => {
            const source = { z: [{ b: 2, a: 1 }], a: true };
            const canonical = canonicalFacetData(source);
            const sourceNested = source.z[0];
            if (sourceNested === undefined) throw new TypeError("Expected source data");
            sourceNested.a = 9;

            expect(canonical).toEqual({ a: true, z: [{ a: 1, b: 2 }] });
            expect(Object.isFrozen(canonical)).toBe(true);
            if (!isFacetDataMap(canonical)) throw new TypeError("Expected canonical data map");
            const nestedValues = canonical["z"];
            if (!Array.isArray(nestedValues)) throw new TypeError("Expected nested data array");
            expect(Object.isFrozen(nestedValues[0])).toBe(true);
            expect(isFacetData(new Date())).toBe(false);
            expect(isFacetData(Object.create(null))).toBe(false);
            expect(isFacetData(Number.POSITIVE_INFINITY)).toBe(false);
        }
    );

    test("models operation, surface, event, prompt, and slot declarations", { tags: "p1" }, () => {
        const operation = new OperationDescriptor(
            new OperationName("deploy.run"),
            "externalSend",
            objectSchema,
            objectSchema,
            "Deploy an application.",
            true
        );
        const surface = new SurfaceDescriptor(
            new SurfaceId("deploy.panel"),
            "Deployments",
            "Inspect deployment state."
        );
        const event = new EventDeclaration(
            new EventKind("deploy.completed"),
            "A deployment completed.",
            objectSchema,
            "workspace"
        );
        const prompt = new Prompt("Deployments", "Prefer staged rollouts.", 20);
        const slot = new SlotDeclaration(
            new SlotName("dashboard.card"),
            objectSchema,
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );

        expect(OperationDescriptor.decode(OperationDescriptor.encode(operation)).toData()).toEqual(
            operation.toData()
        );
        expect(SurfaceDescriptor.decode(SurfaceDescriptor.encode(surface)).toData()).toEqual(
            surface.toData()
        );
        expect(EventDeclaration.decode(EventDeclaration.encode(event)).toData()).toEqual(
            event.toData()
        );
        expect(Prompt.decode(Prompt.encode(prompt)).toData()).toEqual(prompt.toData());
        expect(SlotDeclaration.decode(SlotDeclaration.encode(slot)).toData()).toEqual(
            slot.toData()
        );
        expect(new TextDecoder().decode(SlotAuthorityPolicy.encode(slot.authority))).toBe(
            '{"kind":"facet.slot-authority-policy","payload":{"contribute":["installed"],"visibility":["scope.read"]},"version":{"major":1,"minor":0}}'
        );
        expect(new TextDecoder().decode(SlotDeclaration.encode(slot))).toBe(
            '{"kind":"facet.slot-declaration","payload":{"authority":{"contribute":["installed"],"visibility":["scope.read"]},"entrySchema":{"type":"object"},"name":"dashboard.card"},"version":{"major":1,"minor":0}}'
        );
        expect(slot.name.value).toBe("dashboard.card");
        expect(Object.isFrozen(operation)).toBe(true);
        expect(Object.isFrozen(slot.authority.visibility)).toBe(true);
    });

    test(
        "[facet.slot-entry] preserves SlotEntry golden bytes and round-trips immutable canonical data",
        { tags: "p0" },
        () => {
            const source = { title: "Original", nested: { order: 1 } };
            const entry = new SlotEntry(
                new SlotName("core.card"),
                new FacetRef("workspace:codec.facet"),
                3,
                source
            );
            source.title = "Changed";
            source.nested.order = 2;

            const encoded = SlotEntry.encode(entry);
            expect(new TextDecoder().decode(encoded)).toBe(
                '{"kind":"facet.slot-entry","payload":{"contributor":"workspace:codec.facet","id":"slot:a8a45a0fab7448ba9c148525596550e706f224e94926e9041320cd8c10c6dab1","ordinal":3,"slot":"core.card","value":{"nested":{"order":1},"title":"Original"}},"version":{"major":2,"minor":0}}'
            );
            const decoded = SlotEntry.decode(encoded);
            expect(decoded.toData()).toEqual(entry.toData());
            expect(decoded.value).toEqual({ nested: { order: 1 }, title: "Original" });
            expect(decoded.id.equals(entry.id)).toBe(true);
            expect(Object.isFrozen(entry)).toBe(true);
            expect(Object.isFrozen(entry.value)).toBe(true);
            if (!isFacetDataMap(entry.value)) throw new TypeError("Expected slot-entry data map");
            expect(Object.isFrozen(entry.value["nested"])).toBe(true);
            expect(Object.isFrozen(decoded)).toBe(true);
            expect(Object.isFrozen(decoded.value)).toBe(true);
        }
    );

    test("requires exact SlotEntry payload fields", { tags: "p1" }, () => {
        expectCodecError(
            () =>
                SlotEntry.decode(
                    encodeCanonicalJson({
                        kind: "facet.slot-entry",
                        payload: {
                            contributor: "workspace:codec.facet",
                            ordinal: 3,
                            slot: "core.card"
                        },
                        version: { major: 2, minor: 0 }
                    })
                ),
            "codec.invalid"
        );
        expectCodecError(
            () =>
                SlotEntry.decode(
                    encodeCanonicalJson({
                        kind: "facet.slot-entry",
                        payload: {
                            contributor: "workspace:codec.facet",
                            extra: true,
                            id: "slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            ordinal: 3,
                            slot: "core.card",
                            value: {}
                        },
                        version: { major: 2, minor: 0 }
                    })
                ),
            "codec.invalid"
        );
    });

    test(
        "models commands, automations, ingress, and interceptors as codec data",
        { tags: "p1" },
        () => {
            const move = new FieldMove("/target", { from: "/input/target" });
            const command = new Command({
                name: "deploy",
                title: "Deploy the current slate",
                help: "Starts a staged deployment.",
                arguments: objectSchema,
                operation: new OperationRef("core.deploy:deploy.run"),
                binding: new BindingName("deploy"),
                mapping: new FieldMapping([move]),
                acceptedTrust: ["self", "owner", "authenticated"],
                completion: new OperationRef("core.deploy:deploy.complete"),
                surfaces: [new SlotName("palette"), new SlotName("chat.composer")]
            });
            const source = new EventPattern("schedule.daily", ["self"], "scheduler");
            const automation = new Automation({
                source,
                target: new OperationRef("core.deploy:deploy.run"),
                binding: new BindingName("deploy"),
                mapping: new PayloadMapping([new FieldMove("", { from: "" })]),
                dedupe: "event",
                authority: "delegated"
            });
            const ingress = new IngressDeclaration(
                "/hooks/deploy",
                new IngressVerification("hmac", new SecretRef("tenant", "vault", "deploy-hook")),
                new ProvenanceMapping([new FieldMove("/principal", { from: "/subject" })])
            );
            const interceptor = new InterceptorDeclaration(
                new InterceptorId("policy.urls"),
                "operation.before",
                "rewrite",
                new OperationSelector([
                    new OperationPattern("fetch*", new FacetPackageId("core.web")),
                    OperationPattern.own("deploy.*")
                ]),
                10
            );

            expect(Command.decode(Command.encode(command)).toData()).toEqual(command.toData());
            expect(Automation.decode(Automation.encode(automation)).toData()).toEqual(
                automation.toData()
            );
            expect(IngressDeclaration.decode(IngressDeclaration.encode(ingress)).toData()).toEqual(
                ingress.toData()
            );
            expect(
                InterceptorDeclaration.decode(InterceptorDeclaration.encode(interceptor)).toData()
            ).toEqual(interceptor.toData());
            expect(command.acceptedTrust).toEqual(["owner", "authenticated", "self"]);
            expect(command.surfaces.map((surface) => surface.value)).toEqual([
                "chat.composer",
                "palette"
            ]);
            expect(interceptor.appliesTo.patterns.map((pattern) => pattern.operation)).toEqual([
                "deploy.*",
                "fetch*"
            ]);
        }
    );

    test("keeps constructed and decoded interceptor declarations immutable", { tags: "p0" }, () => {
        const interceptor = new InterceptorDeclaration(
            new InterceptorId("immutable"),
            "operation.before",
            "rewrite",
            10
        );
        const decoded = InterceptorDeclaration.decode(InterceptorDeclaration.encode(interceptor));

        for (const declaration of [interceptor, decoded]) {
            expect(Object.isFrozen(declaration)).toBe(true);
            expect(() => {
                // @ts-expect-error Runtime mutation of a readonly declaration must fail.
                declaration.priority = 20;
            }).toThrow(TypeError);
            expect(declaration.priority).toBe(10);
        }
        expect(decoded.toData()).toEqual(interceptor.toData());
    });

    test(
        "[facet.automation] [facet.command] [facet.operation-descriptor] [facet.surface-descriptor] [facet.contribution] [facet.contributions] [facet.event-pattern] [facet.event-declaration] [facet.ingress-verification] [facet.ingress-declaration] [facet.interceptor-declaration] [facet.binding-requirement] [facet.manifest] [facet.field-move] [facet.field-mapping] [facet.payload-mapping] [facet.provenance-mapping] [facet.operation-pattern] [facet.operation-selector] [facet.prompt] [facet.prompt-contribution] [facet.slot-authority-policy] [facet.slot-declaration] round-trips every constituent declaration codec",
        { tags: "p1" },
        () => {
            const move = new FieldMove("/target", { from: "/source" });
            const fieldMapping = new FieldMapping([move]);
            const payloadMapping = new PayloadMapping([move]);
            const provenanceMapping = new ProvenanceMapping([move]);
            const pattern = OperationPattern.own("read.*");
            const selector = new OperationSelector([pattern]);
            const eventPattern = new EventPattern("task.*", ["authenticated", "owner"]);
            const verification = new IngressVerification(
                "signature",
                new SecretRef("tenant", "vault", "webhook")
            );
            const policy = new SlotAuthorityPolicy(["installed"], ["scope.read"]);
            const contribution = new Contribution(new SlotName("settings"), [{ enabled: true }]);
            const contributions = new Contributions([contribution]);
            const prompt = new PromptContribution([new Prompt("Rules", "Be precise.", 1)]);
            const requirement = new BindingRequirement(
                new BindingName("memory"),
                new FacetPackageId("core.memory"),
                CompatRange.any()
            );
            const defaultInterceptor = new InterceptorDeclaration(
                new InterceptorId("own-only"),
                "operation.before",
                "rewrite",
                5
            );

            expect(FieldMove.decode(FieldMove.encode(move)).toData()).toEqual(move.toData());
            expect(FieldMapping.decode(FieldMapping.encode(fieldMapping)).toData()).toEqual(
                fieldMapping.toData()
            );
            expect(PayloadMapping.decode(PayloadMapping.encode(payloadMapping)).toData()).toEqual(
                payloadMapping.toData()
            );
            expect(
                ProvenanceMapping.decode(ProvenanceMapping.encode(provenanceMapping)).toData()
            ).toEqual(provenanceMapping.toData());
            expect(OperationPattern.decode(OperationPattern.encode(pattern)).toData()).toEqual(
                pattern.toData()
            );
            expect(OperationSelector.decode(OperationSelector.encode(selector)).toData()).toEqual(
                selector.toData()
            );
            expect(EventPattern.decode(EventPattern.encode(eventPattern)).toData()).toEqual(
                eventPattern.toData()
            );
            expect(
                IngressVerification.decode(IngressVerification.encode(verification)).toData()
            ).toEqual(verification.toData());
            expect(SlotAuthorityPolicy.decode(SlotAuthorityPolicy.encode(policy)).toData()).toEqual(
                policy.toData()
            );
            expect(Contribution.decode(Contribution.encode(contribution)).toData()).toEqual(
                contribution.toData()
            );
            expect(Contributions.decode(Contributions.encode(contributions)).toData()).toEqual(
                contributions.toData()
            );
            expect(new TextDecoder().decode(Contributions.encode(contributions))).toBe(
                '{"kind":"facet.contributions","payload":{"settings":[{"enabled":true}]},"version":{"major":2,"minor":0}}'
            );
            expect(PromptContribution.decode(PromptContribution.encode(prompt)).toData()).toEqual(
                prompt.toData()
            );
            expect(
                BindingRequirement.decode(BindingRequirement.encode(requirement)).toData()
            ).toEqual(requirement.toData());
            expect(defaultInterceptor.appliesTo.toData()).toEqual([{ operation: "*" }]);
        }
    );

    test(
        "[C13-FACET-REF-CANONICAL] uses canonical instance, bound, and Facet operation references",
        { tags: "p1" },
        () => {
            const binding = new BindingName("deploy");
            const operation = new OperationName("run");
            const bound = new BoundOperationRef(binding, operation);
            const decodedBound = BoundOperationRef.fromData(bound.toData());
            const reference = new FacetOperationRef(new FacetRef("workspace:deploy"), operation);
            const decodedReference = FacetOperationRef.fromData(reference.toData());

            expect(decodedBound.equals(bound)).toBe(true);
            expect(decodedReference.equals(reference)).toBe(true);
            expect(new OperationRef("acme.deploy:run").operation.equals(operation)).toBe(true);
            expect(new OperationRef("acme.deploy:run").facet.value).toBe("acme.deploy");
            expect(() => new OperationRef("run")).toThrow(/facet-package-id/);
            expect(() => BoundOperationRef.fromData({ binding: "deploy" })).toThrow(/missing/);
            expect(() =>
                FacetOperationRef.fromData({ facet: "workspace:deploy", operation: 1 })
            ).toThrow(/string/);
        }
    );

    test(
        "[C13-FACET-MANIFEST] canonicalizes manifests without changing ordered mapping semantics",
        { tags: "p0" },
        () => {
            const firstMove = new FieldMove("/first", { from: "/z" });
            const secondMove = new FieldMove("/second", { literal: { b: 2, a: 1 } });
            const orderedMapping = new FieldMapping([firstMove, secondMove]);
            const prompt = new PromptContribution([
                new Prompt("Late", "last", 20),
                new Prompt("Early B", "second", 10),
                new Prompt("Early A", "first", 10)
            ]);
            const manifest = new FacetManifest({
                id: new FacetPackageId("acme.deploy"),
                version: new SemVer("1.2.3"),
                compat: new CompatRange("^1", ">=2"),
                isolation: ["bundled", "dynamic", "provider"],
                bindings: [
                    new BindingRequirement(
                        new BindingName("zeta"),
                        new FacetPackageId("core.zeta"),
                        CompatRange.any()
                    ),
                    new BindingRequirement(
                        new BindingName("alpha"),
                        new FacetPackageId("core.alpha"),
                        CompatRange.any()
                    )
                ],
                configSchema: objectSchema,
                contributions: new Contributions([
                    new Contribution(new SlotName("prompt"), [prompt.toData()]),
                    new Contribution(new SlotName("operations"), [{ name: "deploy.run" }])
                ])
            });

            expect(manifest.isolation).toEqual(["dynamic", "provider", "bundled"]);
            expect(manifest.bindings.map((binding) => binding.name.value)).toEqual([
                "alpha",
                "zeta"
            ]);
            expect(manifest.contributions.entries.map((entry) => entry.slot.value)).toEqual([
                "operations",
                "prompt"
            ]);
            const contributionData = manifest.contributions.toData();
            if (!isFacetDataMap(contributionData)) {
                throw new TypeError("Expected contribution data map");
            }
            expect(Object.keys(contributionData)).toEqual(["operations", "prompt"]);
            expect(Object.isFrozen(contributionData)).toBe(true);
            expect(prompt.sections.map((section) => section.title)).toEqual([
                "Early A",
                "Early B",
                "Late"
            ]);
            expect(orderedMapping.moves).toEqual([firstMove, secondMove]);
            expect(
                FacetManifest.encode(FacetManifest.decode(FacetManifest.encode(manifest)))
            ).toEqual(FacetManifest.encode(manifest));
        }
    );

    test(
        "rejects empty, duplicate, unknown, and ambiguous set-like declarations",
        { tags: "p1" },
        () => {
            expect(
                () =>
                    new FacetManifest({
                        id: new FacetPackageId("acme.invalid"),
                        version: new SemVer("1.0.0"),
                        compat: CompatRange.any(),
                        // @ts-expect-error Runtime manifests can contain an empty isolation list.
                        isolation: [],
                        bindings: [],
                        contributions: Contributions.empty()
                    })
            ).toThrow(TypeError);
            expect(
                () =>
                    new FacetManifest({
                        id: new FacetPackageId("acme.invalid"),
                        version: new SemVer("1.0.0"),
                        compat: CompatRange.any(),
                        isolation: ["dynamic", "dynamic"],
                        bindings: [],
                        contributions: Contributions.empty()
                    })
            ).toThrow(TypeError);
            expect(
                () =>
                    // @ts-expect-error Runtime event patterns can contain an empty trust list.
                    new EventPattern("event", [])
            ).toThrow(TypeError);
            expect(() => new EventPattern("event", ["self", "self"])).toThrow(TypeError);
            expect(() => new FieldMove("", { from: "", literal: true })).toThrow(TypeError);
            expect(
                () =>
                    new Contributions([
                        new Contribution(new SlotName("prompt"), [1]),
                        new Contribution(new SlotName("prompt"), [2])
                    ])
            ).toThrow(TypeError);
            expect(
                () =>
                    new OperationSelector([
                        OperationPattern.own("read.*"),
                        OperationPattern.own("read.*")
                    ])
            ).toThrow(TypeError);
        }
    );

    test(
        "rejects malformed event, interceptor, mapping, and slot declarations at decode boundaries",
        { tags: "p2" },
        () => {
            expect(() => EventPattern.fromData({ acceptedTrust: [], kind: "event" })).toThrow(
                /must not be empty/
            );
            expect(() =>
                EventPattern.fromData({ acceptedTrust: ["unknown"], kind: "event" })
            ).toThrow(/Trust tier/);
            for (const pattern of ["", " event", "event*child"]) {
                expect(() => new EventPattern(pattern, ["self"])).toThrow(/suffix-wildcard/);
            }
            expect(() => new EventPattern("event", ["self"], "source*child")).toThrow(
                /suffix-wildcard/
            );
            expect(() =>
                EventDeclaration.fromData({
                    description: "event",
                    kind: "event",
                    payload: [],
                    visibility: "workspace"
                })
            ).toThrow(/schema/);
            expect(() =>
                EventDeclaration.fromData({
                    description: "event",
                    kind: "event",
                    payload: true,
                    visibility: "unknown"
                })
            ).toThrow(/visibility/);
            for (const scheme of ["hmac", "signature", "oauth", "mtls"] as const) {
                expect(
                    IngressVerification.fromData({
                        scheme,
                        secret: { id: "id", provider: "provider", source: "source" }
                    }).scheme
                ).toBe(scheme);
            }
            expect(() =>
                IngressVerification.fromData({
                    scheme: "unknown",
                    secret: { id: "id", provider: "provider", source: "source" }
                })
            ).toThrow(/scheme/);

            expect(() => FieldMove.fromData({ to: "/target" })).toThrow(/exactly one/);
            expect(() =>
                FieldMove.fromData({ from: "/source", literal: true, to: "/target" })
            ).toThrow(/exactly one/);
            for (const pointer of ["target", "/bad~", "/bad~2", "/a~2b"]) {
                expect(() => new FieldMove(pointer, { literal: true })).toThrow(/JSON Pointer/);
                expect(() => new FieldMove("/valid", { from: pointer })).toThrow(/JSON Pointer/);
            }
            expect(new FieldMove("", { literal: null }).toData()).toEqual({
                literal: null,
                to: ""
            });
            expect(FieldMove.fromData({ literal: null, to: "" }).toData()).toEqual({
                literal: null,
                to: ""
            });
            expect(() => new OperationSelector([])).toThrow(/at least one/);
            for (const operation of ["", " read", "read*child"]) {
                expect(() => OperationPattern.own(operation)).toThrow(/suffix-wildcard/);
            }

            expect(
                () =>
                    new InterceptorDeclaration(
                        new InterceptorId("invalid-priority"),
                        "operation.before",
                        "rewrite",
                        // @ts-expect-error Runtime declarations can omit the priority.
                        undefined
                    )
            ).toThrow(/priority/);
            expect(() =>
                InterceptorDeclaration.fromData({
                    appliesTo: {},
                    cutPoint: "operation.before",
                    id: "invalid-selector",
                    mode: "rewrite",
                    priority: 0
                })
            ).toThrow(/selector/);
            for (const cutPoint of [
                "operation.before",
                "operation.after",
                "prompt.assemble",
                "input.submitted",
                "turn.step"
            ] as const) {
                expect(
                    InterceptorDeclaration.fromData({
                        cutPoint,
                        id: `interceptor.${cutPoint}`,
                        mode: "rewrite",
                        priority: 0
                    }).cutPoint
                ).toBe(cutPoint);
            }
            expect(() =>
                InterceptorDeclaration.fromData({
                    cutPoint: "unknown",
                    id: "invalid",
                    mode: "rewrite",
                    priority: 0
                })
            ).toThrow(/cut point/);

            expect(() => new SlotAuthorityPolicy([], ["read"])).toThrow(/must not be empty/);
            expect(() => new SlotAuthorityPolicy(["write"], ["read", "read"])).toThrow(/unique/);
            expect(
                SlotDeclaration.fromData({
                    authority: { contribute: ["write"], visibility: ["read"] },
                    entrySchema: false,
                    name: "boolean.schema"
                }).entrySchema.document
            ).toBe(false);
            expect(() =>
                // @ts-expect-error Canonical JSON cannot carry an undefined schema field.
                SlotDeclaration.fromData({
                    authority: { contribute: ["write"], visibility: ["read"] },
                    entrySchema: undefined,
                    name: "invalid.schema"
                })
            ).toThrow(/schema/);
            for (const entrySchema of [null, [], "invalid"] as const) {
                expect(() =>
                    SlotDeclaration.fromData({
                        authority: { contribute: ["write"], visibility: ["read"] },
                        entrySchema,
                        name: "invalid.schema"
                    })
                ).toThrow(/schema/);
            }
        }
    );

    test(
        "[C13-INTERCEPTOR-MODE-DECLARED] refuses an absent or unknown interceptor mode instead of defaulting one",
        { tags: "p0" },
        () => {
            // An omitted mode never reaches a default: the exact-field gate refuses the
            // declaration outright, the same way an omitted cut point or priority is refused.
            expect(() =>
                InterceptorDeclaration.fromData({
                    cutPoint: "operation.before",
                    id: "no-mode",
                    priority: 0
                })
            ).toThrow(/missing or unknown fields/);
            expect(() =>
                InterceptorDeclaration.fromData({
                    cutPoint: "operation.before",
                    id: "unknown-mode",
                    mode: "enrich",
                    priority: 0
                })
            ).toThrow(/Interceptor mode is invalid/);
            expect(
                () =>
                    new InterceptorDeclaration(
                        new InterceptorId("cast-mode"),
                        "operation.before",
                        // @ts-expect-error A mode outside the union reaches the constructor only by cast.
                        "enrich",
                        0
                    )
            ).toThrow(/Interceptor mode is invalid/);
            for (const mode of ["rewrite", "gate"] as const) {
                const declaration = InterceptorDeclaration.fromData({
                    cutPoint: "operation.before",
                    id: `interceptor.${mode}`,
                    mode,
                    priority: 0
                });
                expect(declaration.mode).toBe(mode);
                expect(declaration.toData()).toMatchObject({ mode });
            }
            expect(
                InterceptorDeclaration.fromData({
                    cutPoint: "operation.before",
                    id: "banded",
                    mode: "gate",
                    priority: 0
                }).modeRank
            ).toBeGreaterThan(
                InterceptorDeclaration.fromData({
                    cutPoint: "operation.before",
                    id: "banded",
                    mode: "rewrite",
                    priority: 0
                }).modeRank
            );
        }
    );

    test("rejects unknown codec fields and noncanonical record bytes", { tags: "p0" }, () => {
        expectCodecError(
            () =>
                OperationDescriptor.decode(
                    encodeCanonicalJson({
                        kind: "facet.operation-descriptor",
                        payload: {
                            impact: "observe",
                            input: {},
                            interceptable: false,
                            name: "read",
                            output: {},
                            extra: true
                        },
                        version: { major: 1, minor: 0 }
                    })
                ),
            "codec.invalid"
        );
        const canonical = new TextEncoder().encode(
            '{"version":{"minor":0,"major":1},"payload":{"title":"x","priority":1,"body":"x"},"kind":"facet.prompt"}'
        );
        expectCodecError(() => Prompt.decode(canonical), "codec.invalid");
    });

    test(
        "[facet.bound-operation-ref] [facet.operation-ref] covers strict W3 declaration constructor and codec branches",
        { tags: "p2" },
        () => {
            const operation = new OperationRef("acme.runtime:run");
            const binding = new BindingName("runtime");
            const minimalCommand = Command.fromData({
                arguments: {},
                binding: binding.value,
                name: "run",
                operation: operation.value,
                surfaces: ["palette"],
                title: "Run"
            });
            expect(minimalCommand.help).toBeUndefined();
            expect(minimalCommand.mapping).toBeUndefined();
            expect(minimalCommand.acceptedTrust).toBeUndefined();
            expect(minimalCommand.completion).toBeUndefined();

            const minimalAutomation = Automation.fromData({
                binding: binding.value,
                source: { acceptedTrust: ["self"], kind: "event" },
                target: operation.value
            });
            expect(minimalAutomation.mapping).toBeUndefined();
            expect(minimalAutomation.dedupe).toBeUndefined();
            expect(minimalAutomation.authority).toBeUndefined();
            expect(Automation.decode(Automation.encode(minimalAutomation)).toData()).toEqual(
                minimalAutomation.toData()
            );
            expect(Command.decode(Command.encode(minimalCommand)).toData()).toEqual(
                minimalCommand.toData()
            );

            expect(() =>
                Automation.fromData({
                    binding: binding.value,
                    dedupe: "bad",
                    source: { acceptedTrust: ["self"], kind: "event" },
                    target: operation.value
                })
            ).toThrow(/dedupe/);
            expect(() =>
                Automation.fromData({
                    authority: "bad",
                    binding: binding.value,
                    source: { acceptedTrust: ["self"], kind: "event" },
                    target: operation.value
                })
            ).toThrow(/authority/);
            expect(
                () =>
                    new Command({
                        name: "run",
                        title: "Run",
                        help: " ",
                        arguments: objectSchema,
                        operation,
                        binding,
                        surfaces: [new SlotName("palette")]
                    })
            ).toThrow(/nonblank/);
            expect(
                () =>
                    new Command({
                        name: "run",
                        title: "Run",
                        arguments: objectSchema,
                        operation,
                        binding,
                        surfaces: []
                    })
            ).toThrow(/must not be empty/);
            expect(
                () =>
                    new Command({
                        name: "run",
                        title: "Run",
                        arguments: objectSchema,
                        operation,
                        binding,
                        surfaces: [new SlotName("palette"), new SlotName("palette")]
                    })
            ).toThrow(/unique/);
            expect(() =>
                Command.fromData({
                    acceptedTrust: [],
                    arguments: {},
                    binding: binding.value,
                    name: "run",
                    operation: operation.value,
                    surfaces: ["palette"],
                    title: "Run"
                })
            ).toThrow(/must not be empty/);
            expect(() =>
                Command.fromData({
                    acceptedTrust: ["bogus"],
                    arguments: {},
                    binding: binding.value,
                    name: "run",
                    operation: operation.value,
                    surfaces: ["palette"],
                    title: "Run"
                })
            ).toThrow(/trust tier/);
            expect(() =>
                Command.fromData({
                    arguments: 1,
                    binding: binding.value,
                    name: "run",
                    operation: operation.value,
                    surfaces: ["palette"],
                    title: "Run"
                })
            ).toThrow(/schema/);
            expect(() =>
                Command.fromData({
                    arguments: {},
                    binding: binding.value,
                    name: "run",
                    operation: operation.value,
                    surfaces: "palette",
                    title: "Run"
                })
            ).toThrow(/array/);
            expect(() => new Contribution(new SlotName("empty"), [])).toThrow(/at least one/);
            expect(() =>
                OperationDescriptor.fromData({
                    impact: "invalid",
                    input: {},
                    interceptable: false,
                    name: "run",
                    output: {}
                })
            ).toThrow(/impact/);
            expect(() =>
                OperationDescriptor.fromData({
                    impact: "observe",
                    input: 1,
                    interceptable: false,
                    name: "run",
                    output: {}
                })
            ).toThrow(/schema/);
            expect(() =>
                OperationDescriptor.fromData({
                    impact: "observe",
                    input: {},
                    interceptable: "yes",
                    name: "run",
                    output: {}
                })
            ).toThrow(/boolean/);
            expect(
                () =>
                    new OperationDescriptor(
                        new OperationName("run"),
                        "observe",
                        objectSchema,
                        objectSchema,
                        " "
                    )
            ).toThrow(/nonblank/);
            expect(() => new SurfaceDescriptor(new SurfaceId("surface"), " ")).toThrow(/nonblank/);
            expect(
                () =>
                    new FacetManifest({
                        id: new FacetPackageId("duplicate.binding"),
                        version: new SemVer("1.0.0"),
                        compat: CompatRange.any(),
                        isolation: ["bundled"],
                        bindings: [
                            new BindingRequirement(
                                binding,
                                new FacetPackageId("a"),
                                CompatRange.any()
                            ),
                            new BindingRequirement(
                                binding,
                                new FacetPackageId("b"),
                                CompatRange.any()
                            )
                        ],
                        contributions: Contributions.empty()
                    })
            ).toThrow(/unique/);
            expect(
                () =>
                    new FacetManifest({
                        id: new FacetPackageId("bad.mode"),
                        version: new SemVer("1.0.0"),
                        compat: CompatRange.any(),
                        // @ts-expect-error Runtime manifests can contain unknown isolation modes.
                        isolation: ["bad"],
                        bindings: [],
                        contributions: Contributions.empty()
                    })
            ).toThrow(/known/);
            expect(() =>
                FacetManifest.fromData({
                    bindings: [],
                    compat: { host: "*", spec: "*" },
                    configSchema: 1,
                    contributions: {},
                    id: "bad.schema",
                    isolation: ["bundled"],
                    version: "1.0.0"
                })
            ).toThrow(/schema/);
            expect(() =>
                FacetManifest.fromData({
                    bindings: [],
                    compat: { host: "*", spec: "*" },
                    contributions: {},
                    id: "bad.mode",
                    isolation: ["unknown"],
                    version: "1.0.0"
                })
            ).toThrow(/mode/);
            expect(() =>
                FacetManifest.fromData({
                    bindings: [],
                    compat: { host: "*", spec: "*" },
                    contributions: {},
                    id: "empty.mode",
                    isolation: [],
                    version: "1.0.0"
                })
            ).toThrow(/must not be empty/);
            const booleanSchemaManifest = FacetManifest.fromData({
                bindings: [],
                compat: { host: "*", spec: "*" },
                configSchema: true,
                contributions: {},
                id: "boolean.schema",
                isolation: ["bundled"],
                version: "1.0.0"
            });
            expect(booleanSchemaManifest.configSchema?.document).toBe(true);
            expect(() =>
                Contributions.decode(
                    encodeCanonicalJson({
                        kind: "facet.contributions",
                        payload: [],
                        version: { major: 2, minor: 0 }
                    })
                )
            ).toThrow(/codec.invalid|object/);
            expect(() =>
                SlotEntry.fromData({
                    contributor: "workspace:facet",
                    id: "slot:bad",
                    ordinal: "zero",
                    slot: "slot",
                    value: null
                })
            ).toThrow(/integer/);
            expect(
                () => new SlotEntry(new SlotName("slot"), new FacetRef("workspace:facet"), -1, null)
            ).toThrow(/ordinal/);
            const entry = SlotEntry.create(new SlotName("slot"), "workspace:facet", 0, null);
            expect(
                () => new SlotEntry(entry.slot, entry.contributor, entry.ordinal, true, entry.id)
            ).toThrow(/ID/);
            for (const invalid of ["unscoped", ":missing", "missing:", "a:b:c", "a b:c"]) {
                expect(() => new FacetRef(invalid)).toThrow(/Facet reference/);
            }
            expect(() => new SlotName(" ")).toThrow(/nonblank/);

            const bound = new BoundOperationRef(binding, operation.operation);
            expect(
                BoundOperationRef.codec.decode(BoundOperationRef.codec.encode(bound)).equals(bound)
            ).toBe(true);
            const facetOperation = new FacetOperationRef(
                new FacetRef("workspace:runtime"),
                operation.operation
            );
            expect(
                FacetOperationRef.codec
                    .decode(FacetOperationRef.codec.encode(facetOperation))
                    .equals(facetOperation)
            ).toBe(true);
            expect(Object.isFrozen(BoundOperationRef.codec)).toBe(true);
            expect(Object.isFrozen(BoundOperationRef.codec.version)).toBe(true);
            expect(Object.isFrozen(FacetOperationRef.codec)).toBe(true);
            expect(Object.isFrozen(SlotEntry.codec)).toBe(true);
        }
    );

    test(
        "[facet.command] carries every optional field in canonical data and accepts all trust tiers",
        { tags: "p1" },
        () => {
            const command = new Command({
                name: "deploy",
                title: "Deploy",
                help: "Help text",
                arguments: objectSchema,
                operation: new OperationRef("core.deploy:run"),
                binding: new BindingName("deploy"),
                mapping: new FieldMapping([new FieldMove("/t", { from: "/s" })]),
                acceptedTrust: ["external"],
                completion: new OperationRef("core.deploy:done"),
                surfaces: [new SlotName("palette")]
            });
            expect(command.toData()).toEqual({
                acceptedTrust: ["external"],
                arguments: { type: "object" },
                binding: "deploy",
                completion: "core.deploy:done",
                help: "Help text",
                mapping: [{ from: "/s", to: "/t" }],
                name: "deploy",
                operation: "core.deploy:run",
                surfaces: ["palette"],
                title: "Deploy"
            });
            const decoded = Command.fromData(command.toData());
            expect(decoded.acceptedTrust).toEqual(["external"]);
            expect(decoded.toData()).toEqual(command.toData());

            expect(Command.fromData({ ...commandData(), arguments: true }).arguments.document).toBe(
                true
            );
            expect(() => Command.fromData({ ...commandData(), name: 7 })).toThrow(
                "Command name must be a string"
            );
            expect(() => Command.fromData({ ...commandData(), title: 7 })).toThrow(
                "Command title must be a string"
            );
            expect(() => Command.fromData({ ...commandData(), operation: 7 })).toThrow(
                "Command operation must be a string"
            );
            expect(() => Command.fromData({ ...commandData(), binding: 7 })).toThrow(
                "Command binding must be a string"
            );
            expect(() => Command.fromData({ ...commandData(), mapping: 5 })).toThrow(
                "Command mapping must be an array"
            );
            expect(() => Command.fromData({ ...commandData(), arguments: null })).toThrow(
                "Command arguments schema must be an object or boolean"
            );
            expect(() => Command.fromData({ ...commandData(), arguments: [] })).toThrow(
                "Command arguments schema must be an object or boolean"
            );
        }
    );

    test(
        "[facet.operation-descriptor] [facet.surface-descriptor] defaults interceptable to false and keeps help in canonical data",
        { tags: "p1" },
        () => {
            const descriptor = new OperationDescriptor(
                new OperationName("read"),
                "observe",
                objectSchema,
                objectSchema,
                "Read data."
            );
            expect(descriptor.interceptable).toBe(false);
            expect(descriptor.toData()).toEqual({
                help: "Read data.",
                impact: "observe",
                input: { type: "object" },
                interceptable: false,
                name: "read",
                output: { type: "object" }
            });

            const surface = new SurfaceDescriptor(new SurfaceId("panel"), "Panel", "Inspect.");
            expect(surface.toData()).toEqual({ help: "Inspect.", id: "panel", title: "Panel" });
            expect(() => new SurfaceDescriptor(new SurfaceId("panel"), "Panel", " ")).toThrow(
                "Surface help must be a nonblank canonical string"
            );

            const booleanSchemas = OperationDescriptor.fromData({
                impact: "observe",
                input: false,
                interceptable: false,
                name: "read",
                output: true
            });
            expect(booleanSchemas.input.document).toBe(false);
            expect(booleanSchemas.output.document).toBe(true);
            expect(() =>
                OperationDescriptor.fromData({
                    impact: "observe",
                    input: {},
                    interceptable: false,
                    name: 7,
                    output: {}
                })
            ).toThrow("Operation name must be a string");
            expect(() =>
                OperationDescriptor.fromData({
                    impact: "observe",
                    input: null,
                    interceptable: false,
                    name: "read",
                    output: {}
                })
            ).toThrow("Operation input schema must be an object or boolean");
            expect(() =>
                OperationDescriptor.fromData({
                    impact: "observe",
                    input: [],
                    interceptable: false,
                    name: "read",
                    output: {}
                })
            ).toThrow("Operation input schema must be an object or boolean");
            expect(() => SurfaceDescriptor.fromData({ id: 7, title: "Panel" })).toThrow(
                "Surface ID must be a string"
            );
            expect(() => SurfaceDescriptor.fromData({ id: "panel", title: 7 })).toThrow(
                "Surface title must be a string"
            );
        }
    );

    test(
        "[facet.contribution] [facet.contributions] orders slots canonically and rejects malformed maps",
        { tags: "p1" },
        () => {
            const contributions = new Contributions([
                new Contribution(new SlotName("beta"), [1]),
                new Contribution(new SlotName("alpha"), [2]),
                new Contribution(new SlotName("gamma"), [3])
            ]);
            expect(contributions.entries.map((entry) => entry.slot.value)).toEqual([
                "alpha",
                "beta",
                "gamma"
            ]);
            expect(contributions.get(new SlotName("beta"))).toEqual([1]);
            expect(() => Contribution.fromData({ entries: [1], slot: 7 })).toThrow(
                "Contribution slot must be a string"
            );
            expect(() =>
                Contributions.decode(
                    encodeCanonicalJson({
                        kind: "facet.contributions",
                        payload: { alpha: 5 },
                        version: { major: 2, minor: 0 }
                    })
                )
            ).toThrow("Contribution alpha must be an array");
        }
    );

    test(
        "[facet.event-pattern] [facet.event-declaration] [facet.ingress-declaration] validates trust, visibility, and schema boundaries",
        { tags: "p1" },
        () => {
            expect(() => EventPattern.fromData({ acceptedTrust: ["self"], kind: 7 })).toThrow(
                "Event pattern kind must be a string"
            );
            expect(() =>
                EventPattern.fromData({ acceptedTrust: ["self", "bogus"], kind: "event" })
            ).toThrow("Trust tier is invalid");
            expect(
                () =>
                    // @ts-expect-error Runtime event patterns can contain unknown trust tiers.
                    new EventPattern("event", ["self", "bogus"])
            ).toThrow("Trust tiers must contain known values");

            const declaration = EventDeclaration.fromData({
                description: "An event.",
                kind: "event",
                payload: {},
                visibility: "private"
            });
            expect(declaration.visibility).toBe("private");
            expect(
                () => new EventDeclaration(new EventKind("event"), " ", objectSchema, "workspace")
            ).toThrow("Event description must be a nonblank canonical string");
            expect(() =>
                EventDeclaration.fromData({
                    description: "x",
                    kind: 7,
                    payload: {},
                    visibility: "workspace"
                })
            ).toThrow("Event kind must be a string");
            expect(() =>
                EventDeclaration.fromData({
                    description: 7,
                    kind: "event",
                    payload: {},
                    visibility: "workspace"
                })
            ).toThrow("Event description must be a string");
            expect(() =>
                EventDeclaration.fromData({
                    description: "x",
                    kind: "event",
                    payload: null,
                    visibility: "workspace"
                })
            ).toThrow("Event payload schema must be an object or boolean");

            const verification = new IngressVerification(
                "hmac",
                new SecretRef("tenant", "vault", "hook")
            );
            expect(
                () => new IngressDeclaration(" ", verification, new ProvenanceMapping([]))
            ).toThrow("Ingress path must be a nonblank canonical string");
            expect(() =>
                IngressDeclaration.fromData({
                    path: 7,
                    provenance: [],
                    verification: verification.toData()
                })
            ).toThrow("Ingress path must be a string");
        }
    );

    test(
        "[facet.field-move] [facet.operation-pattern] [facet.operation-selector] enforces mapping and selector boundaries",
        { tags: "p1" },
        () => {
            expect(
                () =>
                    // @ts-expect-error Runtime field moves can contain unknown source fields.
                    new FieldMove("/t", { bad: true })
            ).toThrow("Field move requires exactly one of from or literal");
            expect(() => FieldMove.fromData({ literal: null, to: 7 })).toThrow(
                "Field move target must be a string"
            );
            expect(() => FieldMove.fromData({ from: 7, to: "/t" })).toThrow(
                "Field move source must be a string"
            );
            expect(() => FieldMapping.decode(objectPayloadRecord("facet.field-mapping"))).toThrow(
                "Field mapping must be an array"
            );
            expect(() =>
                PayloadMapping.decode(objectPayloadRecord("facet.payload-mapping"))
            ).toThrow("Payload mapping must be an array");
            expect(() =>
                ProvenanceMapping.decode(objectPayloadRecord("facet.provenance-mapping"))
            ).toThrow("Provenance mapping must be an array");

            expect(OperationPattern.own().operation).toBe("*");
            expect(() => OperationPattern.fromData({ operation: 7 })).toThrow(
                "Operation pattern operation must be a string"
            );
            expect(
                () =>
                    new OperationSelector([
                        OperationPattern.own("read.*"),
                        OperationPattern.own("read.*")
                    ])
            ).toThrow("Operation selector patterns must be unique");
            expect(
                new OperationSelector([
                    OperationPattern.own("b*"),
                    OperationPattern.own("a*")
                ]).patterns.map((pattern) => pattern.operation)
            ).toEqual(["a*", "b*"]);
            expect(() =>
                OperationSelector.decode(objectPayloadRecord("facet.operation-selector"))
            ).toThrow("Operation selector must be an array");
        }
    );

    test(
        "[facet.bound-operation-ref] [facet.operation-ref] freezes references and distinguishes unequal parts",
        { tags: "p1" },
        () => {
            const bound = new BoundOperationRef(
                new BindingName("deploy"),
                new OperationName("run")
            );
            expect(Object.isFrozen(bound)).toBe(true);
            expect(
                bound.equals(
                    new BoundOperationRef(new BindingName("deploy"), new OperationName("stop"))
                )
            ).toBe(false);
            expect(
                bound.equals(
                    new BoundOperationRef(new BindingName("other"), new OperationName("run"))
                )
            ).toBe(false);
            expect(() => BoundOperationRef.fromData({ binding: 7, operation: "run" })).toThrow(
                "Operation binding must be a string"
            );
            expect(() => BoundOperationRef.fromData({ binding: "deploy", operation: 7 })).toThrow(
                "Operation name must be a string"
            );

            const reference = new FacetOperationRef(
                new FacetRef("workspace:deploy"),
                new OperationName("run")
            );
            expect(Object.isFrozen(reference)).toBe(true);
            expect(
                reference.equals(
                    new FacetOperationRef(
                        new FacetRef("workspace:deploy"),
                        new OperationName("stop")
                    )
                )
            ).toBe(false);
            expect(
                reference.equals(
                    new FacetOperationRef(new FacetRef("workspace:other"), new OperationName("run"))
                )
            ).toBe(false);
            expect(() => FacetOperationRef.fromData({ facet: 7, operation: "run" })).toThrow(
                "Operation Facet reference must be a string"
            );
            expect(() =>
                FacetOperationRef.fromData({ facet: "workspace:deploy", operation: 7 })
            ).toThrow("Operation name must be a string");
        }
    );

    test(
        "[facet.automation] round-trips every dedupe policy and validates payload fields",
        { tags: "p1" },
        () => {
            for (const dedupe of ["none", "event", "causation", "payload"] as const) {
                expect(Automation.fromData({ ...automationData(), dedupe }).dedupe).toBe(dedupe);
            }
            expect(() => Automation.fromData({ ...automationData(), mapping: 5 })).toThrow(
                "Automation mapping must be an array"
            );
            expect(() => Automation.fromData({ ...automationData(), target: 7 })).toThrow(
                "Automation target must be a string"
            );
            expect(() => Automation.fromData({ ...automationData(), binding: 7 })).toThrow(
                "Automation binding must be a string"
            );
        }
    );

    test(
        "[facet.prompt] [facet.prompt-contribution] validates prompt fields and canonical ordering",
        { tags: "p1" },
        () => {
            expect(() => new Prompt("Title", "Body", 1.5)).toThrow(
                "Prompt priority must be a safe integer"
            );
            expect(() => new Prompt(" x", "Body", 1)).toThrow(
                "Prompt title must be a nonblank canonical string"
            );
            expect(() => new Prompt("", "Body", 1)).toThrow(
                "Prompt title must be a nonblank canonical string"
            );
            expect(() => Prompt.fromData({ body: "b", priority: 1, title: 7 })).toThrow(
                "Prompt title must be a string"
            );
            expect(() => Prompt.fromData({ body: 7, priority: 1, title: "t" })).toThrow(
                "Prompt body must be a string"
            );
            // The exact key matters: requireExactFields' default-parameter mutant admits it.
            expect(() =>
                Prompt.fromData({ body: "b", priority: 1, title: "t", ["Stryker was here"]: true })
            ).toThrow("Declaration contains missing or unknown fields");

            expect(PromptContribution.empty().sections).toEqual([]);
            expect(() =>
                PromptContribution.decode(objectPayloadRecord("facet.prompt-contribution"))
            ).toThrow("Prompt contribution must be an array");

            const byPriority = new PromptContribution([
                new Prompt("a", "x", 2),
                new Prompt("z", "x", 1)
            ]);
            expect(byPriority.sections.map((section) => section.title)).toEqual(["z", "a"]);
            for (const bodies of [
                ["a", "z"],
                ["z", "a"]
            ] as const) {
                const contribution = new PromptContribution(
                    bodies.map((body) => new Prompt("t", body, 1))
                );
                expect(contribution.sections.map((section) => section.body)).toEqual(["a", "z"]);
            }
        }
    );

    test(
        "[facet.prompt-contribution] breaks priority ties by title before body from any input order",
        { tags: "p1" },
        () => {
            const first = () => new Prompt("a", "z", 1);
            const second = () => new Prompt("b", "a", 1);
            for (const sections of [
                [first(), second()],
                [second(), first()]
            ]) {
                expect(
                    new PromptContribution(sections).sections.map((section) => section.title)
                ).toEqual(["a", "b"]);
            }
        }
    );

    test(
        "[facet.operation-selector] orders facet-scoped patterns by exact facet before operation",
        { tags: "p1" },
        () => {
            const parent = new OperationPattern("x", new FacetPackageId("core"));
            const scoped = new OperationPattern("x", new FacetPackageId("core.mail"));
            for (const patterns of [
                [parent, scoped],
                [scoped, parent]
            ]) {
                expect(new OperationSelector(patterns).toData()).toEqual([
                    { facet: "core", operation: "x" },
                    { facet: "core.mail", operation: "x" }
                ]);
            }
        }
    );

    test(
        "[facet.interceptor-declaration] [facet.slot-entry] validates priorities and ordinals as safe integers",
        { tags: "p1" },
        () => {
            expect(
                () =>
                    new InterceptorDeclaration(
                        new InterceptorId("x"),
                        "operation.before",
                        "rewrite",
                        1.5
                    )
            ).toThrow("Interceptor priority must be a safe integer");
            expect(() =>
                InterceptorDeclaration.fromData({
                    cutPoint: "operation.before",
                    id: 7,
                    mode: "rewrite",
                    priority: 0
                })
            ).toThrow("Interceptor ID must be a string");
            expect(() =>
                SlotEntry.fromData({
                    contributor: "workspace:facet",
                    id: "slot:bad",
                    ordinal: 1.5,
                    slot: "slot",
                    value: null
                })
            ).toThrow("Slot entry ordinal must be a safe integer");
        }
    );
});

function commandData(): FacetDataMap {
    return {
        arguments: {},
        binding: "run",
        name: "run",
        operation: "acme.run:run",
        surfaces: ["palette"],
        title: "Run"
    };
}

function automationData(): FacetDataMap {
    return {
        binding: "deploy",
        source: { acceptedTrust: ["self"], kind: "event" },
        target: "core.deploy:run"
    };
}

function objectPayloadRecord(kind: string): Uint8Array {
    return encodeCanonicalJson({ kind, payload: {}, version: { major: 1, minor: 0 } });
}

function expectCodecError(action: () => void, code: AgentCoreError["code"]): void {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        if (!(error instanceof AgentCoreError)) throw error;
        expect(error).toMatchObject({ code });
        return;
    }
    throw new TypeError("Expected codec to reject input");
}

describe("Impact is derived from the seam, not declared by the callee", () => {
    test(
        "[C13-FACET-IMPACT-BOUNDARY] admits a claim only where it never buys a tier the derived impact was denied",
        { tags: "p0" },
        () => {
            const impacts = [
                "observe",
                "execute",
                "mutate",
                "externalSend",
                "delegate",
                "administer"
            ] as const;

            // The conditions under which an impact reaches `direct` at all. Stating the
            // rule as containment of these sets is deliberately not how
            // claimHonorsEnforcementFloor computes it: re-deriving the implementation's
            // own boolean here would agree with any mutation of it.
            const reachesDirect = (impact: Impact): readonly boolean[] =>
                [true, false].filter(
                    (turnOwnedSession) =>
                        enforcementFloor(impact, turnOwnedSession, false) === "direct"
                );

            // A claim may raise the floor the seam derived and never lower it, so it is
            // admissible exactly when it reaches `direct` nowhere the derived impact does
            // not. Both Turn-owned-Session conditions are weighed because a claim recorded
            // once at discovery or install has to stay safe at every later call site.
            for (const claimed of impacts) {
                for (const derived of impacts) {
                    const permitted = reachesDirect(claimed).every((condition) =>
                        reachesDirect(derived).includes(condition)
                    );
                    expect(claimHonorsEnforcementFloor(claimed, derived, false)).toBe(permitted);
                }
            }

            // The two directions that carry the rule, named rather than left implicit.
            // `observe` is the only impact reaching `direct` under both conditions, so
            // claiming it against anything else is the escalation the host refuses, while
            // claiming anything else against it is the harmless tightening.
            expect(claimHonorsEnforcementFloor("observe", "externalSend", false)).toBe(false);
            expect(claimHonorsEnforcementFloor("externalSend", "observe", false)).toBe(true);

            // A Turn-owned Session lets `execute` reach `direct` too, so claiming it
            // against an impact that never does is still refused — otherwise the claim
            // buys `direct` at exactly the call sites where that condition holds.
            expect(claimHonorsEnforcementFloor("execute", "mutate", false)).toBe(false);
            expect(claimHonorsEnforcementFloor("mutate", "execute", false)).toBe(true);
        }
    );
});

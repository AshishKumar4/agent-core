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
    type FacetDataMap
} from "../../src/facets-public";
import { FacetRef } from "../../src/facets/id";
import { BoundOperationRef, FacetOperationRef } from "../../src/facets/operation";

const objectSchema = new JsonSchema({ type: "object" });

describe("Declarative facet vocabulary", () => {
    test("exports W3-owned Facet, Operation, and Surface contracts without host constructors", () => {
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
    });

    test("accepts only canonical JSON facet data and freezes canonical copies", () => {
        const source = { z: [{ b: 2, a: 1 }], a: true };
        const canonical = canonicalFacetData(source);
        source.z[0]!.a = 9;

        expect(canonical).toEqual({ a: true, z: [{ a: 1, b: 2 }] });
        expect(Object.isFrozen(canonical)).toBe(true);
        expect(Object.isFrozen((canonical as { z: readonly object[] }).z[0])).toBe(true);
        expect(isFacetData(new Date())).toBe(false);
        expect(isFacetData(Object.create(null))).toBe(false);
        expect(isFacetData(Number.POSITIVE_INFINITY)).toBe(false);
    });

    test("models operation, surface, event, prompt, and slot declarations", () => {
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

    test("[facet.slot-entry] preserves SlotEntry golden bytes and round-trips immutable canonical data", () => {
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
        expect(Object.isFrozen((entry.value as { nested: object }).nested)).toBe(true);
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(Object.isFrozen(decoded.value)).toBe(true);
    });

    test("requires exact SlotEntry payload fields", () => {
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

    test("models commands, automations, ingress, and interceptors as codec data", () => {
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
    });

    test("keeps constructed and decoded interceptor declarations immutable", () => {
        const interceptor = new InterceptorDeclaration(
            new InterceptorId("immutable"),
            "operation.before",
            10
        );
        const decoded = InterceptorDeclaration.decode(InterceptorDeclaration.encode(interceptor));

        for (const declaration of [interceptor, decoded]) {
            expect(Object.isFrozen(declaration)).toBe(true);
            expect(() => {
                (declaration as { priority: number }).priority = 20;
            }).toThrow(TypeError);
            expect(declaration.priority).toBe(10);
        }
        expect(decoded.toData()).toEqual(interceptor.toData());
    });

    test("[facet.automation] [facet.command] [facet.operation-descriptor] [facet.surface-descriptor] [facet.contribution] [facet.contributions] [facet.event-pattern] [facet.event-declaration] [facet.ingress-verification] [facet.ingress-declaration] [facet.interceptor-declaration] [facet.binding-requirement] [facet.manifest] [facet.field-move] [facet.field-mapping] [facet.payload-mapping] [facet.provenance-mapping] [facet.operation-pattern] [facet.operation-selector] [facet.prompt] [facet.prompt-contribution] [facet.slot-authority-policy] [facet.slot-declaration] round-trips every constituent declaration codec", () => {
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
        expect(BindingRequirement.decode(BindingRequirement.encode(requirement)).toData()).toEqual(
            requirement.toData()
        );
        expect(defaultInterceptor.appliesTo.toData()).toEqual([{ operation: "*" }]);
    });

    test("[C13-FACET-REF-CANONICAL] uses canonical instance, bound, and Facet operation references", () => {
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
    });

    test("[C13-FACET-MANIFEST] canonicalizes manifests without changing ordered mapping semantics", () => {
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
        expect(manifest.bindings.map((binding) => binding.name.value)).toEqual(["alpha", "zeta"]);
        expect(manifest.contributions.entries.map((entry) => entry.slot.value)).toEqual([
            "operations",
            "prompt"
        ]);
        expect(Object.keys(manifest.contributions.toData() as object)).toEqual([
            "operations",
            "prompt"
        ]);
        expect(Object.isFrozen(manifest.contributions.toData())).toBe(true);
        expect(prompt.sections.map((section) => section.title)).toEqual([
            "Early A",
            "Early B",
            "Late"
        ]);
        expect(orderedMapping.moves).toEqual([firstMove, secondMove]);
        expect(FacetManifest.encode(FacetManifest.decode(FacetManifest.encode(manifest)))).toEqual(
            FacetManifest.encode(manifest)
        );
    });

    test("rejects empty, duplicate, unknown, and ambiguous set-like declarations", () => {
        expect(
            () =>
                new FacetManifest({
                    id: new FacetPackageId("acme.invalid"),
                    version: new SemVer("1.0.0"),
                    compat: CompatRange.any(),
                    isolation: [] as unknown as ["dynamic"],
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
        expect(() => new EventPattern("event", [] as unknown as ["self"])).toThrow(TypeError);
        expect(() => new EventPattern("event", ["self", "self"])).toThrow(TypeError);
        expect(() => new FieldMove("", { from: "", literal: true } as never)).toThrow(TypeError);
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
    });

    test("rejects malformed event, interceptor, mapping, and slot declarations at decode boundaries", () => {
        expect(() => EventPattern.fromData({ acceptedTrust: [], kind: "event" })).toThrow(
            /must not be empty/
        );
        expect(() => EventPattern.fromData({ acceptedTrust: ["unknown"], kind: "event" })).toThrow(
            /Trust tier/
        );
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
        expect(() => FieldMove.fromData({ from: "/source", literal: true, to: "/target" })).toThrow(
            /exactly one/
        );
        for (const pointer of ["target", "/bad~", "/bad~2"]) {
            expect(() => new FieldMove(pointer, { literal: true })).toThrow(/JSON Pointer/);
        }
        expect(new FieldMove("", { literal: null }).toData()).toEqual({ literal: null, to: "" });
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
                    undefined as never
                )
        ).toThrow(/priority/);
        expect(() =>
            InterceptorDeclaration.fromData({
                appliesTo: {},
                cutPoint: "operation.before",
                id: "invalid-selector",
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
                    priority: 0
                }).cutPoint
            ).toBe(cutPoint);
        }
        expect(() =>
            InterceptorDeclaration.fromData({ cutPoint: "unknown", id: "invalid", priority: 0 })
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
        for (const entrySchema of [undefined, null, [], "invalid"] as const) {
            expect(() =>
                SlotDeclaration.fromData({
                    authority: { contribute: ["write"], visibility: ["read"] },
                    entrySchema: entrySchema as never,
                    name: "invalid.schema"
                })
            ).toThrow(/schema/);
        }
    });

    test("rejects unknown codec fields and noncanonical record bytes", () => {
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

    test("[facet.bound-operation-ref] [facet.operation-ref] covers strict W3 declaration constructor and codec branches", () => {
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
                        new BindingRequirement(binding, new FacetPackageId("a"), CompatRange.any()),
                        new BindingRequirement(binding, new FacetPackageId("b"), CompatRange.any())
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
                    isolation: ["bad" as "bundled"],
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
    });

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
                () => new EventPattern("event", ["self", "bogus"] as unknown as ["self"])
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
            expect(() => new IngressDeclaration(" ", verification, new ProvenanceMapping([]))).toThrow(
                "Ingress path must be a nonblank canonical string"
            );
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
            expect(() => new FieldMove("/t", { bad: true } as never)).toThrow(
                "Field move requires exactly one of from or literal"
            );
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
            const bound = new BoundOperationRef(new BindingName("deploy"), new OperationName("run"));
            expect(Object.isFrozen(bound)).toBe(true);
            expect(
                bound.equals(new BoundOperationRef(new BindingName("deploy"), new OperationName("stop")))
            ).toBe(false);
            expect(
                bound.equals(new BoundOperationRef(new BindingName("other"), new OperationName("run")))
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
                    new FacetOperationRef(new FacetRef("workspace:deploy"), new OperationName("stop"))
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
        "[facet.interceptor-declaration] [facet.slot-entry] validates priorities and ordinals as safe integers",
        { tags: "p1" },
        () => {
            expect(
                () => new InterceptorDeclaration(new InterceptorId("x"), "operation.before", 1.5)
            ).toThrow("Interceptor priority must be a safe integer");
            expect(() =>
                InterceptorDeclaration.fromData({
                    cutPoint: "operation.before",
                    id: 7,
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

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected codec to reject input");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}

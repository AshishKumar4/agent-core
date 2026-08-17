import { describe, expect, test, vi } from "vitest";
import { MediaHint } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SecretRef,
    SemVer,
    encodeCanonicalJson,
    strictJsonSchemaValidator,
    type JsonSchemaValidator,
    requireNonempty,
    type JsonValue
} from "../../src/core";
import { Blueprint, PackageInstall, type BlueprintInit } from "../../src/definition/blueprint";
import {
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule
} from "../../src/definition/code-manifest";
import { PlatformCompatibility } from "../../src/definition/compatibility";
import { BlueprintDeclarationCodecPort } from "../../src/definition/declaration";
import {
    BASE_CONFIG_SCHEMA,
    Config,
    SECRET_REF_SCHEMA,
    composeConfigSchema
} from "../../src/definition/config";
import { PackageId } from "../../src/definition/id";
import { PackageLock, PackagePin } from "../../src/definition/package-lock";
import {
    MetadataSnapshot,
    PackageDependency,
    PackageRelease,
    type PackageReleaseInit
} from "../../src/definition/package";
import {
    BlueprintValidator,
    ValidatedBlueprint,
    validateBlueprint as validateDefinition,
    type BlueprintValidatorOptions
} from "../../src/definition/validator";
import { PolicySet } from "../../src/definition/policy";
import { PLACEMENT_PREFERENCE, PlacementPolicy } from "../../src/definition/placement";
import { PlacementSourcePort } from "../../src/definition/validator";
import {
    Contribution,
    Contributions,
    Automation,
    BindingName,
    Command,
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
    ProvenanceMapping,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotName,
    SurfaceDescriptor,
    SurfaceId
} from "../../src/facets";

const encoder = new TextEncoder();

const schemaValidator = strictJsonSchemaValidator;
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });
const declarationCodecs = new BlueprintDeclarationCodecPort(
    (["scopes", "agents", "slots", "subscriptions", "environments", "surfaces"] as const).map(
        (field) => ({
            field,
            canonicalize: (value: JsonValue): JsonValue => value
        })
    )
);
const placement = new (class extends PlacementSourcePort {
    public substrateModes(_release: PackageRelease, _manifest: FacetManifest) {
        return ["dynamic", "provider", "bundled"] as const;
    }
})();

describe("Blueprint validation", () => {
    test("uses strict production validation by default, including uri formats", { tags: "p1" }, () => {
        const release = packageRelease("remote-api", {
            configSchema: new JsonSchema({
                additionalProperties: false,
                properties: { endpoint: { format: "uri", type: "string" } },
                required: ["endpoint"],
                type: "object"
            })
        });
        const lock = packageLock([release]);

        expect(() =>
            validateBlueprint(blueprint([install("remote-api", "^1", { endpoint: "not a uri" })]), {
                lock,
                releases: [release]
            })
        ).toThrow(/composed config schema/);
        expect(() =>
            validateBlueprint(
                blueprint([
                    install("remote-api", "^1", { endpoint: "https://api.example.com/v1" })
                ]),
                { lock, releases: [release] }
            )
        ).not.toThrow();
    });

    test("rejects remote package schema references before materialization", { tags: "p0" }, () => {
        const release = packageRelease("remote-ref", {
            configSchema: new JsonSchema({ $ref: "https://example.com/config.schema.json" })
        });

        expect(() =>
            validateBlueprint(blueprint([install("remote-ref", "^1")]), {
                lock: packageLock([release]),
                releases: [release]
            })
        ).toThrow(/Remote JSON Schema reference/);
    });

    test("validates config against exact locked metadata before loading code", { tags: "p0" }, () => {
        const release = packageRelease("acme.deploy", {
            configSchema: new JsonSchema({
                properties: { token: SECRET_REF_SCHEMA.document },
                required: ["token"],
                type: "object"
            })
        });
        const lock = packageLock([release]);
        const loader = vi.fn();
        const invalid = blueprint([install("acme.deploy", "^1", { token: "raw-credential" })]);

        expect(() => {
            const validated = validateBlueprint(invalid, {
                lock,
                releases: [release],
                schemaValidator
            });
            loader(validated);
        }).toThrow(/composed config schema/);
        expect(loader).not.toHaveBeenCalled();

        const valid = blueprint([
            install("acme.deploy", "^1", {
                token: new SecretRef("tenant", "vault", "deploy")
            })
        ]);
        const result = new BlueprintValidator({
            lock,
            releases: [release],
            target,
            declarationCodecs,
            placement,
            schemaValidator
        }).validate(valid);
        expect(result).toBeInstanceOf(ValidatedBlueprint);
        expect(result.lock).toBe(lock);
        expect(result.digest.equals(Digest.sha256(result.bytes()))).toBe(true);
        expect(Object.keys(result)).not.toContain("loader");
    });

    test("[C13-BLUEPRINT-RUN-PINS] requires the exact PackageLock closure and pin metadata", { tags: "p0" }, () => {
        const dependency = packageRelease("dep");
        const root = packageRelease("root", {
            dependencies: [new PackageDependency(new PackageId("dep"), "^1")]
        });
        const lock = packageLock([root, dependency], [new PackageDependency(root.id, "^1")]);
        const source = blueprint([install("root", "^1")]);

        const complete = validateBlueprint(source, {
            lock,
            releases: [root, dependency],
            schemaValidator
        });
        expect(complete.releases.map((release) => release.id.value)).toEqual(["dep", "root"]);

        expect(() =>
            validateBlueprint(source, {
                lock,
                releases: [root],
                schemaValidator
            })
        ).toThrow();
        expect(() =>
            validateBlueprint(source, {
                lock,
                releases: [root, packageRelease("dep", { codeDigest: digest("wrong") })],
                schemaValidator
            })
        ).toThrow();

        const extra = packageRelease("extra");
        expect(() =>
            validateBlueprint(source, {
                lock: packageLock([root, dependency, extra]),
                releases: [root, dependency, extra],
                schemaValidator
            })
        ).toThrow(/deterministic resolution/);
    });

    test("re-resolves exact snapshot metadata to reject cycles and prerelease bypasses", { tags: "p0" }, () => {
        const cyclicRoot = packageRelease("root", {
            dependencies: [new PackageDependency(new PackageId("dep"), "*")]
        });
        const cyclicDependency = packageRelease("dep", {
            dependencies: [new PackageDependency(new PackageId("root"), "*")]
        });
        expect(() =>
            validateBlueprint(blueprint([install("root", "*")]), {
                lock: packageLock(
                    [cyclicRoot, cyclicDependency],
                    [new PackageDependency(cyclicRoot.id, "*")]
                ),
                releases: [cyclicRoot, cyclicDependency],
                schemaValidator
            })
        ).toThrow(/cycle/);

        const prerelease = packageRelease("preview", { version: "2.0.0-beta.1" });
        expect(() =>
            validateBlueprint(blueprint([install("preview", ">=1.0.0")]), {
                lock: packageLock([prerelease], [new PackageDependency(prerelease.id, ">=1.0.0")]),
                releases: [prerelease],
                schemaValidator
            })
        ).toThrow(/No version/);
    });

    test("rejects a lock whose bytes differ from deterministic resolution", { tags: "p0" }, () => {
        const lower = packageRelease("app", { version: "1.0.0" });
        const higher = packageRelease("app", { version: "2.0.0" });
        const snapshot = new MetadataSnapshot({
            revision: new Revision(1),
            releases: [lower, higher]
        });
        const supplied = new PackageLock({
            target,
            roots: [new PackageDependency(lower.id, "*")],
            snapshotRevision: snapshot.revision,
            snapshotDigest: snapshot.digest,
            packages: [
                new PackagePin(lower.id, lower.version, lower.manifestDigest, lower.codeDigest)
            ]
        });

        expect(() =>
            validateBlueprint(blueprint([install("app", "*")]), {
                lock: supplied,
                releases: [lower, higher],
                schemaValidator
            })
        ).toThrow(/deterministic resolution/);
    });

    test("validates slot declarations, contribution schemas, and declaration targets", { tags: "p1" }, () => {
        const cardSlot = new SlotDeclaration(
            new SlotName("dashboard.card"),
            new JsonSchema({
                properties: { title: { type: "string" } },
                required: ["title"],
                type: "object"
            }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const release = packageRelease("cards", {
            contributions: new Contributions([
                new Contribution(new SlotName("dashboard.card"), [{ title: "Health" }])
            ])
        });
        const source = blueprint([install("cards", "^1")], { slots: [cardSlot] });

        const result = validateBlueprint(source, {
            lock: packageLock([release]),
            releases: [release],
            schemaValidator
        });
        expect(result.declarations).toEqual([
            {
                contributor: "cards.facet",
                index: 0,
                slot: "dashboard.card",
                value: { title: "Health" }
            }
        ]);

        expect(() =>
            validateBlueprint(blueprint([install("cards", "^1")]), {
                lock: packageLock([release]),
                releases: [release],
                schemaValidator
            })
        ).toThrow(/undeclared slot dashboard.card/);

        const invalidRelease = packageRelease("cards", {
            contributions: new Contributions([
                new Contribution(new SlotName("dashboard.card"), [{ title: 7 }])
            ])
        });
        expect(() =>
            validateBlueprint(source, {
                lock: packageLock([invalidRelease]),
                releases: [invalidRelease],
                schemaValidator
            })
        ).toThrow(/does not match slot dashboard.card/);
    });

    test("keeps unsupported executable-shaped contributions as inert declarations", { tags: "p1" }, () => {
        const futureSlot = new SlotDeclaration(
            new SlotName("future.executors"),
            new JsonSchema({
                properties: { codeRef: { type: "string" } },
                required: ["codeRef"],
                type: "object"
            }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const release = packageRelease("future", {
            contributions: new Contributions([
                new Contribution(new SlotName("slots"), [futureSlot.toData()]),
                new Contribution(new SlotName("future.executors"), [
                    { codeRef: "sha256:not-loaded" }
                ])
            ])
        });
        const result = validateBlueprint(blueprint([install("future", "^1")]), {
            lock: packageLock([release]),
            releases: [release],
            schemaValidator
        });

        expect(
            result.declarations.find((entry) => entry.slot === "future.executors")?.value
        ).toEqual({ codeRef: "sha256:not-loaded" });
        expect("activate" in result).toBe(false);
        expect("load" in result).toBe(false);
        expect(Object.isFrozen(result.declarations)).toBe(true);
    });

    test("[C13-BLUEPRINT-VALIDATE-BEFORE-LOAD] validates every core contribution kind before loading Package code", { tags: "p0" }, () => {
        const objectSchema = new JsonSchema({ type: "object" });
        const move = new FieldMove("", { from: "" });
        const command = new Command({
            name: "deploy",
            title: "Deploy",
            help: "Deploy safely.",
            arguments: objectSchema,
            operation: new OperationRef("core.deploy:run"),
            binding: new BindingName("deploy"),
            mapping: new FieldMapping([move]),
            acceptedTrust: ["self"],
            completion: new OperationRef("core.deploy:complete"),
            surfaces: [new SlotName("surfaces")]
        });
        const declarations = new Contributions([
            new Contribution(new SlotName("automations"), [
                new Automation({
                    source: new EventPattern("schedule.daily", ["self"]),
                    target: new OperationRef("core.deploy:run"),
                    binding: new BindingName("deploy"),
                    mapping: new PayloadMapping([move]),
                    dedupe: "event",
                    authority: "delegated"
                }).toData()
            ]),
            new Contribution(new SlotName("commands"), [command.toData()]),
            new Contribution(new SlotName("events"), [
                new EventDeclaration(
                    new EventKind("deploy.completed"),
                    "Completed.",
                    objectSchema,
                    "workspace"
                ).toData()
            ]),
            new Contribution(new SlotName("ingress"), [
                new IngressDeclaration(
                    "/deploy",
                    new IngressVerification("hmac", new SecretRef("tenant", "vault", "hook")),
                    new ProvenanceMapping([move])
                ).toData()
            ]),
            new Contribution(new SlotName("interceptors"), [
                new InterceptorDeclaration(
                    new InterceptorId("guard"),
                    "operation.before",
                    "rewrite",
                    new OperationSelector([OperationPattern.own("*")]),
                    1
                ).toData()
            ]),
            new Contribution(new SlotName("operations"), [
                new OperationDescriptor(
                    new OperationName("run"),
                    "execute",
                    objectSchema,
                    objectSchema,
                    "Run.",
                    true
                ).toData()
            ]),
            new Contribution(new SlotName("prompt"), [
                [new Prompt("Rules", "Be safe.", 1).toData()]
            ]),
            new Contribution(new SlotName("settings"), [true, { type: "object" }]),
            new Contribution(new SlotName("slots"), [
                new SlotDeclaration(
                    new SlotName("custom.slot"),
                    objectSchema,
                    new SlotAuthorityPolicy(["installed"], ["scope.read"])
                ).toData()
            ]),
            new Contribution(new SlotName("surfaces"), [
                new SurfaceDescriptor(
                    new SurfaceId("deploy.panel"),
                    "Deployments",
                    "Deployment status."
                ).toData()
            ])
        ]);
        const release = packageRelease("core-declarations", { contributions: declarations });
        const result = validateBlueprint(blueprint([install("core-declarations", "^1")]), {
            lock: packageLock([release]),
            releases: [release],
            schemaValidator
        });
        expect(result.declarations).toHaveLength(11);

        const badPrompt = packageRelease("bad-prompt", {
            contributions: new Contributions([
                new Contribution(new SlotName("prompt"), [{ title: "not-an-array" }])
            ])
        });
        expect(() =>
            validateBlueprint(blueprint([install("bad-prompt", "^1")]), {
                lock: packageLock([badPrompt]),
                releases: [badPrompt],
                schemaValidator
            })
        ).toThrow(/Prompt contribution must be an array/);
        const malformedSettings: readonly JsonValue[] = [7, null, []];
        for (const setting of malformedSettings) {
            const badSettings = packageRelease(`bad-settings-${String(setting)}`, {
                contributions: new Contributions([
                    new Contribution(new SlotName("settings"), [setting])
                ])
            });
            expect(() =>
                validateBlueprint(blueprint([install(badSettings.id.value, "^1")]), {
                    lock: packageLock([badSettings]),
                    releases: [badSettings],
                    schemaValidator
                })
            ).toThrow(/Settings contribution/);
        }
    });

    test("requires owner-published codecs for nonempty foreign declarations", { tags: "p1" }, () => {
        const release = packageRelease("agents");
        const source = new Blueprint({
            meta: { name: "test", version: new SemVer("1.0.0") },
            packages: [install("agents", "^1")],
            policies: PolicySet.empty(),
            agents: [{ name: "helper" }]
        });
        expect(() =>
            validateDefinition(source, {
                lock: packageLock([release]),
                releases: [release],
                target,
                placement,
                schemaValidator
            })
        ).toThrow(/owner-published declaration codec/);
        expect(() =>
            validateBlueprint(source, {
                lock: packageLock([release]),
                releases: [release],
                schemaValidator
            })
        ).not.toThrow();
    });

    test("rejects noncanonical owner declarations and nonpreferred placement claims", { tags: "p1" }, () => {
        const release = packageRelease("owner-codec");
        const source = new Blueprint({
            meta: { name: "test", version: new SemVer("1.0.0") },
            packages: [install("owner-codec", "^1")],
            policies: PolicySet.empty(),
            agents: [{ name: "helper" }]
        });
        const normalizing = new BlueprintDeclarationCodecPort([
            {
                field: "agents",
                canonicalize: () => ({ name: "different" })
            }
        ]);
        expect(() =>
            validateDefinition(source, {
                lock: packageLock([release]),
                releases: [release],
                target,
                declarationCodecs: normalizing,
                placement,
                schemaValidator
            })
        ).toThrow(/not canonical/);

        const forgedPlacement = new (class extends PlacementSourcePort {
            public substrateModes() {
                return ["provider"] as const;
            }
        })();
        expect(() =>
            validateDefinition(blueprint([install("owner-codec", "^1")]), {
                lock: packageLock([release]),
                releases: [release],
                target,
                placement: forgedPlacement,
                schemaValidator
            })
        ).toThrow(/No isolation mode/);

        const foreignManifestPlacement = new (class extends PlacementSourcePort {
            public substrateModes() {
                return ["provider"] as const;
            }
        })();
        expect(() =>
            validateDefinition(blueprint([install("owner-codec", "^1")]), {
                lock: packageLock([release]),
                releases: [release],
                target,
                placement: foreignManifestPlacement,
                schemaValidator
            })
        ).toThrow(/No isolation mode/);
        expect(() =>
            validateDefinition(blueprint([install("owner-codec", "^1")]), {
                lock: packageLock([release]),
                releases: [release],
                target: new PlatformCompatibility({
                    spec: new SemVer("2.0.0"),
                    host: new SemVer("1.0.0")
                }),
                placement,
                schemaValidator
            })
        ).toThrow(/compatibility target/);
    });

    test("rejects duplicate and core slot declarations plus unknown command surfaces", { tags: "p1" }, () => {
        const slot = new SlotDeclaration(
            new SlotName("duplicate.slot"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const release = packageRelease("slots");
        expect(() =>
            validateBlueprint(
                blueprint([install("slots", "^1")], {
                    slots: [slot, slot]
                }),
                {
                    lock: packageLock([release]),
                    releases: [release],
                    schemaValidator
                }
            )
        ).toThrow(/duplicates slot/);
        const core = new SlotDeclaration(
            new SlotName("commands"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        expect(() =>
            validateBlueprint(
                blueprint([install("slots", "^1")], {
                    slots: [core]
                }),
                {
                    lock: packageLock([release]),
                    releases: [release],
                    schemaValidator
                }
            )
        ).toThrow(/cannot be redefined/);

        const commandRelease = packageRelease("command-surface", {
            contributions: new Contributions([
                new Contribution(new SlotName("commands"), [
                    new Command({
                        name: "deploy",
                        title: "Deploy",
                        help: "Deploy.",
                        arguments: new JsonSchema({ type: "object" }),
                        operation: new OperationRef("core.deploy:run"),
                        binding: new BindingName("deploy"),
                        mapping: new FieldMapping([]),
                        acceptedTrust: ["self"],
                        completion: new OperationRef("core.deploy:complete"),
                        surfaces: [new SlotName("missing.surface")]
                    }).toData()
                ])
            ])
        });
        expect(() =>
            validateBlueprint(blueprint([install("command-surface", "^1")]), {
                lock: packageLock([commandRelease]),
                releases: [commandRelease],
                schemaValidator
            })
        ).toThrow(/undeclared surface slot/);
    });

    test("validates every optional Blueprint declaration through its owner codec", { tags: "p1" }, () => {
        const release = packageRelease("all-declarations");
        const source = new Blueprint({
            meta: { name: "all", version: new SemVer("1.0.0") },
            packages: [install("all-declarations", "^1")],
            policies: PolicySet.empty(),
            scopes: { project: "default" },
            agents: [{ name: "helper" }],
            slots: [
                new SlotDeclaration(
                    new SlotName("owner.slot"),
                    new JsonSchema({ type: "object" }),
                    new SlotAuthorityPolicy(["installed"], ["scope.read"])
                )
            ],
            subscriptions: [{ event: "task.created" }],
            environments: [{ name: "sandbox" }],
            surfaces: { primary: "owner.slot" }
        });
        expect(
            validateBlueprint(source, {
                lock: packageLock([release]),
                releases: [release],
                schemaValidator
            }).blueprint.agents
        ).toHaveLength(1);
    });

    test("derives deterministic validated bytes from Blueprint and exact lock", { tags: "p0" }, () => {
        const alpha = packageRelease("alpha");
        const zeta = packageRelease("zeta");
        const lock = packageLock([zeta, alpha]);
        const left = blueprint([install("zeta", "^1"), install("alpha", "^1")]);
        const right = blueprint([install("alpha", "^1"), install("zeta", "^1")]);

        const first = validateBlueprint(left, {
            lock,
            releases: [zeta, alpha],
            schemaValidator
        });
        const second = validateBlueprint(right, {
            lock,
            releases: [alpha, zeta],
            schemaValidator
        });
        expect(first.bytes()).toEqual(second.bytes());
        expect(first.digest.equals(second.digest)).toBe(true);
    });

    test("binds attestation digests to the exact validated content", { tags: "p0" }, () => {
        const cardSlot = new SlotDeclaration(
            new SlotName("dashboard.card"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const release = packageRelease("cards", {
            contributions: new Contributions([
                new Contribution(new SlotName("dashboard.card"), [{ title: "Health" }])
            ])
        });
        const lock = packageLock([release]);
        const result = validateBlueprint(blueprint([install("cards", "^1")], { slots: [cardSlot] }), {
            lock,
            releases: [release],
            schemaValidator
        });

        expect(result.digest.equals(result.attestation.definitionDigest)).toBe(true);
        expect(
            result.attestation.declarationDigest.equals(
                Digest.sha256(
                    encodeCanonicalJson(
                        result.declarations.map((declaration) => ({
                            contributor: declaration.contributor,
                            index: declaration.index,
                            slot: declaration.slot,
                            value: declaration.value
                        }))
                    )
                )
            )
        ).toBe(true);
        expect(
            result.attestation.placementDigest.equals(
                Digest.sha256(
                    encodeCanonicalJson(
                        result.placements.map((entry) => ({
                            facetId: entry.facetId,
                            facetVersion: entry.facetVersion,
                            packageId: entry.packageId,
                            selection: {
                                manifest: entry.selection.manifest,
                                policy: entry.selection.policy,
                                selected: entry.selection.selected,
                                substrate: entry.selection.substrate,
                                trust: entry.selection.trust
                            }
                        }))
                    )
                )
            )
        ).toBe(true);
        expect(result.configSchema.document).toEqual(
            composeConfigSchema(BASE_CONFIG_SCHEMA, [...result.releases]).document
        );

        const leaked = result.bytes();
        leaked.fill(0);
        expect(result.digest.equals(Digest.sha256(result.bytes()))).toBe(true);
        expect(
            Object.isFrozen(
                new BlueprintValidator({
                    lock,
                    releases: [release],
                    target,
                    declarationCodecs,
                    placement,
                    schemaValidator
                })
            )
        ).toBe(true);
    });

    test("honors the supplied schema validator as the config authority", { tags: "p0" }, () => {
        const rejectEverything: JsonSchemaValidator = { validate: () => false };
        const release = packageRelease("plain");
        expect(() =>
            validateBlueprint(blueprint([install("plain", "^1")]), {
                lock: packageLock([release]),
                releases: [release],
                schemaValidator: rejectEverything
            })
        ).toThrow(/composed config schema/);
    });

    test("registers platform core slots for contributions and rejects duplicates by source", { tags: "p1" }, () => {
        const hostSlot = new SlotDeclaration(
            new SlotName("host.panel"),
            new JsonSchema({
                properties: { title: { type: "string" } },
                required: ["title"],
                type: "object"
            }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const release = packageRelease("host-cards", {
            contributions: new Contributions([
                new Contribution(new SlotName("host.panel"), [{ title: "Status" }])
            ])
        });
        const options = {
            lock: packageLock([release]),
            releases: [release],
            target,
            declarationCodecs,
            placement,
            schemaValidator
        };
        const result = validateDefinition(blueprint([install("host-cards", "^1")]), {
            ...options,
            coreSlots: [hostSlot]
        });
        expect(result.declarations).toEqual([
            {
                contributor: "host-cards.facet",
                index: 0,
                slot: "host.panel",
                value: { title: "Status" }
            }
        ]);
        expect(() =>
            validateDefinition(blueprint([install("host-cards", "^1")]), {
                ...options,
                coreSlots: [hostSlot, hostSlot]
            })
        ).toThrow(/Core slot duplicates slot host.panel/);
        expect(() =>
            validateDefinition(
                blueprint([install("host-cards", "^1")], { slots: [hostSlot, hostSlot] }),
                options
            )
        ).toThrow(/Blueprint slot duplicates slot host.panel/);
    });

    test("matches every pin against full release identity, not shared content", { tags: "p0" }, () => {
        const shared = facetManifest("shared.facet", "1.0.0");
        const aaa = releaseWith("aaa", [shared], "twin-code");
        const bbb = releaseWith("bbb", [shared], "twin-code");
        expect(aaa.manifestDigest.equals(bbb.manifestDigest)).toBe(true);
        expect(aaa.codeDigest.equals(bbb.codeDigest)).toBe(true);

        const result = validateBlueprint(blueprint([install("aaa", "^1"), install("bbb", "^1")]), {
            lock: packageLock([aaa, bbb]),
            releases: [aaa, bbb],
            schemaValidator
        });
        expect(result.releases.map((release) => release.id.value)).toEqual(["aaa", "bbb"]);
    });

    test("orders validated placements by package, Facet, and version", { tags: "p1" }, () => {
        const alpha = releaseWith("alpha", [facetManifest("z.facet", "2.0.0")], "alpha-code");
        const zeta = releaseWith("zeta", [facetManifest("a.facet", "1.0.0")], "zeta-code");
        const result = validateBlueprint(blueprint([install("alpha", "^1"), install("zeta", "^1")]), {
            lock: packageLock([alpha, zeta]),
            releases: [alpha, zeta],
            schemaValidator
        });
        expect(
            result.placements.map((entry) => [entry.packageId, entry.facetId, entry.facetVersion])
        ).toEqual([
            ["alpha", "z.facet", "2.0.0"],
            ["zeta", "a.facet", "1.0.0"]
        ]);
    });

    test("[C13-PLACEMENT-UNTRUSTED-BUNDLED] derives trust from the Blueprint's own policy, not the substrate port", { tags: "p0" }, () => {
        const bundledOnly = new FacetManifest({
            id: new FacetPackageId("bundled-only.facet"),
            version: new SemVer("1.0.0"),
            compat: CompatRange.any(),
            isolation: ["bundled"],
            bindings: [],
            contributions: Contributions.empty()
        });
        const trustingPolicy = new PolicySet({
            placement: new PlacementPolicy(PLACEMENT_PREFERENCE, ["trusted.*"])
        });

        const trustedRelease = releaseWith("trusted.pkg", [bundledOnly], "trusted-code");
        const trusted = validateBlueprint(
            blueprint([install("trusted.pkg", "^1")], { policies: trustingPolicy }),
            { lock: packageLock([trustedRelease]), releases: [trustedRelease], schemaValidator }
        );
        expect(trusted.placements).toEqual([
            {
                packageId: "trusted.pkg",
                facetId: "bundled-only.facet",
                facetVersion: "1.0.0",
                selection: expect.objectContaining({ selected: "bundled" })
            }
        ]);

        const untrustedRelease = releaseWith("untrusted.pkg", [bundledOnly], "untrusted-code");
        expect(() =>
            validateBlueprint(
                blueprint([install("untrusted.pkg", "^1")], { policies: trustingPolicy }),
                { lock: packageLock([untrustedRelease]), releases: [untrustedRelease], schemaValidator }
            )
        ).toThrow(/No isolation mode/);
    });

    test("orders declarations by contributor, slot, and contribution index", { tags: "p1" }, () => {
        const orderedSlot = new SlotDeclaration(
            new SlotName("ordered.slot"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const multi = releaseWith(
            "multi",
            [
                facetManifest(
                    "multi.facet",
                    "1.0.0",
                    new Contributions([
                        new Contribution(new SlotName("ordered.slot"), [
                            { n: "v1-0" },
                            { n: "v1-1" }
                        ])
                    ])
                ),
                facetManifest(
                    "multi.facet",
                    "2.0.0",
                    new Contributions([
                        new Contribution(new SlotName("ordered.slot"), [
                            { n: "v2-0" },
                            { n: "v2-1" }
                        ])
                    ])
                )
            ],
            "multi-code"
        );
        const interleaved = validateBlueprint(
            blueprint([install("multi", "^1")], { slots: [orderedSlot] }),
            { lock: packageLock([multi]), releases: [multi], schemaValidator }
        );
        expect(interleaved.declarations).toEqual([
            { contributor: "multi.facet", index: 0, slot: "ordered.slot", value: { n: "v1-0" } },
            { contributor: "multi.facet", index: 0, slot: "ordered.slot", value: { n: "v2-0" } },
            { contributor: "multi.facet", index: 1, slot: "ordered.slot", value: { n: "v1-1" } },
            { contributor: "multi.facet", index: 1, slot: "ordered.slot", value: { n: "v2-1" } }
        ]);

        const aSlot = new SlotDeclaration(
            new SlotName("a.slot"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const zSlot = new SlotDeclaration(
            new SlotName("z.slot"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const apkg = releaseWith(
            "apkg",
            [
                facetManifest(
                    "a.facet",
                    "1.0.0",
                    new Contributions([new Contribution(new SlotName("z.slot"), [{ n: "za" }])])
                )
            ],
            "apkg-code"
        );
        const bpkg = releaseWith(
            "bpkg",
            [
                facetManifest(
                    "z.facet",
                    "1.0.0",
                    new Contributions([new Contribution(new SlotName("a.slot"), [{ n: "az" }])])
                )
            ],
            "bpkg-code"
        );
        const crossed = validateBlueprint(
            blueprint([install("apkg", "^1"), install("bpkg", "^1")], { slots: [aSlot, zSlot] }),
            { lock: packageLock([apkg, bpkg]), releases: [apkg, bpkg], schemaValidator }
        );
        expect(crossed.declarations).toEqual([
            { contributor: "a.facet", index: 0, slot: "z.slot", value: { n: "za" } },
            { contributor: "z.facet", index: 0, slot: "a.slot", value: { n: "az" } }
        ]);
    });

    test("attributes duplicate package slot declarations to the sorted later manifest", { tags: "p1" }, () => {
        const sharedSlot = new SlotDeclaration(
            new SlotName("shared.slot"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        ).toData();
        const apkg = releaseWith(
            "apkg",
            [
                facetManifest(
                    "z.facet",
                    "1.0.0",
                    new Contributions([new Contribution(new SlotName("slots"), [sharedSlot])])
                )
            ],
            "apkg-code"
        );
        const bpkg = releaseWith(
            "bpkg",
            [
                facetManifest(
                    "a.facet",
                    "1.0.0",
                    new Contributions([new Contribution(new SlotName("slots"), [sharedSlot])])
                )
            ],
            "bpkg-code"
        );
        expect(() =>
            validateBlueprint(blueprint([install("apkg", "^1"), install("bpkg", "^1")]), {
                lock: packageLock([apkg, bpkg]),
                releases: [apkg, bpkg],
                schemaValidator
            })
        ).toThrow(/Package z.facet slot duplicates slot shared.slot/);
    });

    test("validates malformed core contributions for every executable slot kind", { tags: "p1" }, () => {
        for (const slot of [
            "automations",
            "events",
            "ingress",
            "interceptors",
            "operations",
            "surfaces"
        ]) {
            const release = packageRelease(`bad-${slot}`, {
                contributions: new Contributions([
                    new Contribution(new SlotName(slot), [{ bogus: true }])
                ])
            });
            expect(() =>
                validateBlueprint(blueprint([install(release.id.value, "^1")]), {
                    lock: packageLock([release]),
                    releases: [release],
                    schemaValidator
                })
            ).toThrow(/Declaration contains missing or unknown fields/);
        }

        const badCommand = packageRelease("bad-command", {
            contributions: new Contributions([
                new Contribution(new SlotName("commands"), [{ bogus: true }]),
                new Contribution(new SlotName("zzz.slot"), [{}])
            ])
        });
        expect(() =>
            validateBlueprint(blueprint([install("bad-command", "^1")]), {
                lock: packageLock([badCommand]),
                releases: [badCommand],
                schemaValidator
            })
        ).toThrow(/Declaration contains missing or unknown fields/);
    });

    test("orders validated placements by Package, Facet, then Facet version", { tags: "p1" }, () => {
        const alpha = releaseWith("alpha", [facetManifest("alpha.z", "2.0.0")], "alpha-code");
        const beta = releaseWith(
            "beta",
            [facetManifest("beta.a", "1.0.0"), facetManifest("beta.b", "3.0.0")],
            "beta-code"
        );

        const validated = validateBlueprint(
            blueprint([install("beta", "^1"), install("alpha", "^1")]),
            { lock: packageLock([beta, alpha]), releases: [beta, alpha], schemaValidator }
        );

        expect(
            validated.placements.map((placement) => [
                placement.packageId,
                placement.facetId,
                placement.facetVersion
            ])
        ).toEqual([
            ["alpha", "alpha.z", "2.0.0"],
            ["beta", "beta.a", "1.0.0"],
            ["beta", "beta.b", "3.0.0"]
        ]);
    });

    test("canonicalizes placement order from unordered pins and manifests", { tags: "p0" }, () => {
        // Placement order feeds the attestation's placement digest, so it has to be a
        // property of the content rather than of the order a caller happened to supply.
        const zeta = releaseWith(
            "zeta.pkg",
            [
                facetManifest("zeta.z", "1.0.0"),
                facetManifest("zeta.a", "2.0.0"),
                facetManifest("zeta.a", "1.0.0")
            ],
            "zeta-code"
        );
        const alpha = releaseWith(
            "alpha.pkg",
            [facetManifest("alpha.only", "1.0.0")],
            "alpha-code"
        );

        const expected = [
            ["alpha.pkg", "alpha.only", "1.0.0"],
            ["zeta.pkg", "zeta.a", "1.0.0"],
            ["zeta.pkg", "zeta.a", "2.0.0"],
            ["zeta.pkg", "zeta.z", "1.0.0"]
        ];
        for (const order of [
            [zeta, alpha],
            [alpha, zeta]
        ]) {
            const validated = validateBlueprint(
                blueprint(order.map((release) => install(release.id.value, "^1"))),
                { lock: packageLock(order), releases: order, schemaValidator }
            );
            expect(
                validated.placements.map((placement) => [
                    placement.packageId,
                    placement.facetId,
                    placement.facetVersion
                ])
            ).toEqual(expected);
        }
    });

    test("orders declarations by contributor ahead of contribution index", { tags: "p1" }, () => {
        const entries = new SlotDeclaration(
            new SlotName("shared.entries"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        const apkg = releaseWith(
            "apkg",
            [
                facetManifest(
                    "a.facet",
                    "1.0.0",
                    new Contributions([
                        new Contribution(new SlotName("shared.entries"), [
                            { n: "a0" },
                            { n: "a1" }
                        ])
                    ])
                )
            ],
            "apkg-code"
        );
        const zpkg = releaseWith(
            "zpkg",
            [
                facetManifest(
                    "z.facet",
                    "1.0.0",
                    new Contributions([
                        new Contribution(new SlotName("shared.entries"), [{ n: "z0" }])
                    ])
                )
            ],
            "zpkg-code"
        );

        const validated = validateBlueprint(
            blueprint([install("apkg", "^1"), install("zpkg", "^1")], { slots: [entries] }),
            { lock: packageLock([apkg, zpkg]), releases: [apkg, zpkg], schemaValidator }
        );

        expect(
            validated.declarations.map((declaration) => [
                declaration.contributor,
                declaration.index
            ])
        ).toEqual([
            ["a.facet", 0],
            ["a.facet", 1],
            ["z.facet", 0]
        ]);
    });
});

interface ReleaseOverrides {
    readonly dependencies?: readonly PackageDependency[];
    readonly configSchema?: JsonSchema;
    readonly contributions?: Contributions;
    readonly codeDigest?: Digest;
    readonly version?: string;
}

interface BlueprintOverrides {
    readonly slots?: readonly SlotDeclaration[];
    readonly policies?: PolicySet;
}

function blueprint(
    packages: readonly PackageInstall[],
    overrides: BlueprintOverrides = {}
): Blueprint {
    const required: BlueprintInit = {
        meta: { name: "test", version: new SemVer("1.0.0") },
        packages,
        policies: overrides.policies ?? PolicySet.empty(),
        agents: []
    };
    return new Blueprint(
        overrides.slots === undefined ? required : { ...required, slots: overrides.slots }
    );
}

function install(
    id: string,
    range: string,
    config: { readonly [name: string]: import("../../src/definition/config").ConfigInput } = {}
): PackageInstall {
    return new PackageInstall({
        request: new PackageDependency(new PackageId(id), range),
        config: new Config(config)
    });
}

function packageRelease(id: string, overrides: ReleaseOverrides = {}): PackageRelease {
    const version = new SemVer(overrides.version ?? "1.0.0");
    const manifests = requireNonempty([
        new FacetManifest({
            id: new FacetPackageId(`${id}.facet`),
            version,
            compat: CompatRange.any(),
            isolation: ["dynamic"],
            bindings: [],
            contributions: overrides.contributions ?? Contributions.empty()
        })
    ], "Facet manifests");
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(overrides.codeDigest ?? digest(`code:${id}`)),
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
    const required: PackageReleaseInit = {
        id: new PackageId(id),
        version,
        compatibility: CompatRange.any(),
        dependencies: overrides.dependencies ?? [],
        manifests,
        codeManifest,
        provenance: { registry: "test" }
    };
    return new PackageRelease(
        overrides.configSchema === undefined
            ? required
            : { ...required, configSchema: overrides.configSchema }
    );
}

function facetManifest(
    id: string,
    version: string,
    contributions: Contributions = Contributions.empty()
): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId(id),
        version: new SemVer(version),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        contributions
    });
}

function releaseWith(
    id: string,
    manifests: readonly FacetManifest[],
    codeContent: string
): PackageRelease {
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digest(codeContent)),
                media: new MediaHint("application/javascript")
            })
        ],
        entrypoints: requireNonempty(
            manifests.map(
            (manifest) =>
                new PackageCodeEntrypoint({
                    facet: manifest.id,
                    version: manifest.version,
                    module: "./main.js"
                })
        ), "code entrypoints")
    });
    return new PackageRelease({
        id: new PackageId(id),
        version: new SemVer("1.0.0"),
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests: requireNonempty(manifests, "Facet manifests"),
        codeManifest,
        provenance: { registry: "test" }
    });
}

function packageLock(
    releases: readonly PackageRelease[],
    roots: readonly PackageDependency[] = releases.map(
        (release) => new PackageDependency(release.id, "^1")
    )
): PackageLock {
    const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases });
    return new PackageLock({
        target,
        roots,
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

function validateBlueprint(
    source: Blueprint,
    options: Omit<BlueprintValidatorOptions, "target" | "declarationCodecs" | "placement">
): ValidatedBlueprint {
    return validateDefinition(source, {
        ...options,
        target,
        declarationCodecs,
        placement
    });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

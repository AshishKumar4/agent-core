// @ts-nocheck
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
    strictJsonSchemaValidator,
    type JsonValue
} from "../../src/core";
import { Blueprint, PackageInstall } from "../../src/definition/blueprint";
import {
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule
} from "../../src/definition/code-manifest";
import { PlatformCompatibility } from "../../src/definition/compatibility";
import { BlueprintDeclarationCodecPort } from "../../src/definition/declaration";
import { Config, SECRET_REF_SCHEMA } from "../../src/definition/config";
import { PackageId } from "../../src/definition/id";
import { PackageLock, PackagePin } from "../../src/definition/package-lock";
import { MetadataSnapshot, PackageDependency, PackageRelease } from "../../src/definition/package";
import {
    BlueprintValidator,
    ValidatedBlueprint,
    validateBlueprint as validateDefinition,
    type BlueprintValidatorOptions
} from "../../src/definition/validator";
import { PolicySet } from "../../src/definition/policy";
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
    ["scopes", "agents", "slots", "subscriptions", "environments", "surfaces"].map((field) => ({
        field: field as import("../../src/definition/declaration").BlueprintDeclarationField,
        canonicalize: (value: JsonValue): JsonValue => value
    }))
);
const placement = new (class extends PlacementSourcePort {
    public sources(_release: PackageRelease, _manifest: FacetManifest) {
        return {
            substrate: ["dynamic", "provider", "bundled"],
            trust: ["dynamic", "provider", "bundled"]
        } as const;
    }
})();

describe("Blueprint validation", () => {
    test("uses strict production validation by default, including uri formats", () => {
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

    test("rejects remote package schema references before materialization", () => {
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

    test("validates config against exact locked metadata before loading code", () => {
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

    test("[C13-BLUEPRINT-RUN-PINS] requires the exact PackageLock closure and pin metadata", () => {
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

    test("re-resolves exact snapshot metadata to reject cycles and prerelease bypasses", () => {
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

    test("rejects a lock whose bytes differ from deterministic resolution", () => {
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

    test("validates slot declarations, contribution schemas, and declaration targets", () => {
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

    test("keeps unsupported executable-shaped contributions as inert declarations", () => {
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

    test("[C13-BLUEPRINT-VALIDATE-BEFORE-LOAD] validates every core contribution kind before loading Package code", () => {
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
        for (const setting of [7, null, []] as JsonValue[]) {
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

    test("requires owner-published codecs for nonempty foreign declarations", () => {
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

    test("rejects noncanonical owner declarations and nonpreferred placement claims", () => {
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
            public sources() {
                return { substrate: ["provider"], trust: ["provider"] } as const;
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
            public sources() {
                return { substrate: ["provider"], trust: ["provider"] } as const;
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

    test("rejects duplicate and core slot declarations plus unknown command surfaces", () => {
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

    test("validates every optional Blueprint declaration through its owner codec", () => {
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

    test("derives deterministic validated bytes from Blueprint and exact lock", () => {
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
    return new Blueprint({
        meta: { name: "test", version: new SemVer("1.0.0") },
        packages,
        policies: overrides.policies ?? PolicySet.empty(),
        agents: [],
        ...(overrides.slots === undefined ? {} : { slots: overrides.slots })
    });
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
    const manifests = [
        new FacetManifest({
            id: new FacetPackageId(`${id}.facet`),
            version,
            compat: CompatRange.any(),
            isolation: ["dynamic"],
            bindings: [],
            contributions: overrides.contributions ?? Contributions.empty()
        })
    ] as [FacetManifest];
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
    return new PackageRelease({
        id: new PackageId(id),
        version,
        compatibility: CompatRange.any(),
        dependencies: overrides.dependencies ?? [],
        manifests,
        codeManifest,
        provenance: { registry: "test" },
        ...(overrides.configSchema === undefined ? {} : { configSchema: overrides.configSchema })
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

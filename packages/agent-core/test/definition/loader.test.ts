import { describe, expect, test, vi } from "vitest";
import { MediaHint } from "../../src/content";
import { CompatRange, ContentRef, Digest, JsonSchema, Revision, SemVer } from "../../src/core";
import {
    Blueprint,
    BlueprintLoader,
    Config,
    MetadataSnapshot,
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule,
    PackageCorrespondencePort,
    PackageDependency,
    PackageId,
    PackageInstall,
    PackageModuleEvaluator,
    PackageModuleInspector,
    PackageRelease,
    PlacementSourcePort,
    PlatformCompatibility,
    PolicySet,
    resolvePackageLock,
    type VerifiedPackageModule
} from "../../src/definition";
import { Contributions, FacetManifest, FacetPackageId } from "../../src/facets";

const encoder = new TextEncoder();
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });

describe("production Blueprint validation-before-load", () => {
    test("does not resolve or evaluate code when config validation fails", async () => {
        const fixture = packageFixture();
        const get = vi.fn(async () => fixture.mainBytes);
        const evaluate = vi.fn(async () => "loaded");
        const loader = blueprintLoader(fixture, get, evaluate);

        await expect(loader.load(blueprint(fixture.release, { enabled: "wrong" }))).rejects.toThrow(
            /composed config schema/
        );
        expect(get).not.toHaveBeenCalled();
        expect(evaluate).not.toHaveBeenCalled();
    });

    test("rejects an inspected import outside the declared closure before evaluation", async () => {
        const fixture = packageFixture();
        const evaluate = vi.fn(async () => "loaded");
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                reference.equals(fixture.mainRef) ? fixture.mainBytes : fixture.dependencyBytes,
            evaluate,
            async (module) =>
                module.specifier === "./main.js" ? ["https://hostile.example/module.js"] : []
        );

        await expect(loader.load(blueprint(fixture.release, { enabled: true }))).rejects.toThrow(
            /Inspected imports/
        );
        expect(evaluate).not.toHaveBeenCalled();
    });

    test.each([
        [[]],
        [["./dependency.js", "./dependency.js"]],
        [["./dependency.js", "./extra.js"]]
    ])("rejects nonexact inspected import set %j", async (imports) => {
        const fixture = packageFixture();
        const evaluate = vi.fn(async () => "loaded");
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                reference.equals(fixture.mainRef) ? fixture.mainBytes : fixture.dependencyBytes,
            evaluate,
            async (module) => (module.specifier === "./main.js" ? imports : [])
        );
        await expect(loader.load(blueprint(fixture.release, { enabled: true }))).rejects.toThrow(
            /Inspected imports/
        );
        expect(evaluate).not.toHaveBeenCalled();
    });

    test("preflights every exact module byte before invoking the evaluator", async () => {
        const fixture = packageFixture();
        const get = vi.fn(async (reference: ContentRef) =>
            reference.equals(fixture.dependencyRef)
                ? fixture.dependencyBytes
                : encoder.encode("substituted")
        );
        const evaluate = vi.fn(async () => "loaded");
        const loader = blueprintLoader(fixture, get, evaluate);

        await expect(loader.load(blueprint(fixture.release, { enabled: true }))).rejects.toThrow(
            /Loaded module bytes do not match/
        );
        expect(get).toHaveBeenCalledTimes(2);
        expect(evaluate).not.toHaveBeenCalled();
    });

    test("rejects a non-byte content adapter result before inspection or evaluation", async () => {
        const fixture = packageFixture();
        const evaluate = vi.fn(async () => "loaded");
        const inspect = vi.fn(async (module: PackageCodeModule) => module.imports);
        const loader = blueprintLoader(
            fixture,
            async () => "not-bytes" as never,
            evaluate,
            inspect
        );

        await expect(loader.load(blueprint(fixture.release, { enabled: true }))).rejects.toThrow(
            /Loaded module bytes do not match/
        );
        expect(inspect).not.toHaveBeenCalled();
        expect(evaluate).not.toHaveBeenCalled();
    });

    test("[C13-PLACEMENT-ORDER] passes detached verified bytes to one selected evaluator in canonical order", async () => {
        const fixture = packageFixture();
        const source = new Map([
            [fixture.mainRef.value, fixture.mainBytes],
            [fixture.dependencyRef.value, fixture.dependencyBytes]
        ]);
        const evaluated: string[] = [];
        const disposed: string[] = [];
        const loader = blueprintLoader(
            fixture,
            async (reference) => source.get(reference.value)!.slice(),
            async (module) => {
                evaluated.push(module.module.specifier);
                expect(module.pin.id.equals(module.release.id)).toBe(true);
                expect(module.pin.version.equals(module.release.version)).toBe(true);
                expect(module.pin.manifestDigest.equals(module.release.manifestDigest)).toBe(true);
                expect(module.pin.codeDigest.equals(module.release.codeDigest)).toBe(true);
                module.bytes.fill(0);
                return module.module.specifier;
            },
            undefined,
            (module) => {
                disposed.push(module.module.specifier);
            }
        );

        const loaded = await loader.load(blueprint(fixture.release, { enabled: true }));

        expect(evaluated).toEqual(["./dependency.js", "./main.js"]);
        expect(loaded.modules.map((module) => module.value)).toEqual(evaluated);
        expect(source.get(fixture.mainRef.value)).toEqual(fixture.mainBytes);
        expect(
            loaded.validated.attestation.packageLockDigest.equals(loaded.validated.lock.digest)
        ).toBe(true);
        expect(loaded.modules.every((module) => module.value.length > 0)).toBe(true);
        await loaded.dispose();
        await loaded[Symbol.asyncDispose]();
        expect(disposed).toEqual(["./main.js", "./dependency.js"]);
    });

    test("does not fall back after evaluator failure and disposes completed handles", async () => {
        const fixture = packageFixture();
        const evaluated: string[] = [];
        const disposed: string[] = [];
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                reference.equals(fixture.mainRef) ? fixture.mainBytes : fixture.dependencyBytes,
            async (module) => {
                evaluated.push(`${module.selected}:${module.module.specifier}`);
                if (module.module.specifier === "./main.js") throw new TypeError("adapter failed");
                return module.module.specifier;
            },
            undefined,
            (module) => {
                disposed.push(module.module.specifier);
                throw new TypeError("cleanup failed");
            }
        );

        await expect(loader.load(blueprint(fixture.release, { enabled: true }))).rejects.toThrow(
            "adapter failed"
        );
        expect(evaluated).toEqual(["dynamic:./dependency.js", "dynamic:./main.js"]);
        expect(disposed).toEqual(["./dependency.js"]);
    });

    test("surfaces disposal failure and still closes the scope only once", async () => {
        const fixture = packageFixture();
        let disposals = 0;
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                reference.equals(fixture.mainRef) ? fixture.mainBytes : fixture.dependencyBytes,
            async (module) => module.module.specifier,
            undefined,
            () => {
                disposals += 1;
                throw new TypeError("dispose failed");
            }
        );
        const loaded = await loader.load(blueprint(fixture.release, { enabled: true }));

        await expect(loaded.dispose()).rejects.toThrow("dispose failed");
        await expect(loaded.dispose()).resolves.toBeUndefined();
        expect(disposals).toBe(2);
    });

    test("retains the verified snapshot when the source buffer mutates during inspection", async () => {
        const fixture = packageFixture();
        const sharedMain = fixture.mainBytes.slice();
        const seen: Uint8Array[] = [];
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                reference.equals(fixture.mainRef) ? sharedMain : fixture.dependencyBytes,
            async (module) => {
                seen.push(module.bytes.slice());
                return module.module.specifier;
            },
            async (module) => {
                if (module.specifier === "./main.js") sharedMain.fill(0);
                return module.imports;
            }
        );
        await loader.load(blueprint(fixture.release, { enabled: true }));
        expect(
            seen.find((bytes) => new TextDecoder().decode(bytes).includes("export { value }"))
        ).toBeDefined();
    });

    test("rejects a transitive module shared across incompatible placement modes", async () => {
        const fixture = packageFixture();
        const dynamic = fixture.release.manifests[0]!;
        const providerBytes = encoder.encode("export { value } from './dependency.js';");
        const providerRef = ContentRef.fromDigest(Digest.sha256(providerBytes));
        const provider = new FacetManifest({
            id: new FacetPackageId("provider.facet"),
            version: new SemVer("1.0.0"),
            compat: CompatRange.any(),
            isolation: ["provider"],
            bindings: [],
            contributions: Contributions.empty()
        });
        const codeManifest = new PackageCodeManifest({
            compatibilityDate: fixture.release.codeManifest.compatibilityDate,
            modules: [
                ...fixture.release.codeManifest.modules,
                new PackageCodeModule({
                    specifier: "./provider.js",
                    content: providerRef,
                    media: new MediaHint("application/javascript"),
                    imports: ["./dependency.js"]
                })
            ],
            entrypoints: [
                new PackageCodeEntrypoint({
                    facet: dynamic.id,
                    version: dynamic.version,
                    module: "./main.js"
                }),
                new PackageCodeEntrypoint({
                    facet: provider.id,
                    version: provider.version,
                    module: "./provider.js"
                })
            ]
        });
        const release = new PackageRelease({
            id: new PackageId("mixed"),
            version: new SemVer("1.0.0"),
            compatibility: CompatRange.any(),
            dependencies: [],
            manifests: [dynamic, provider],
            codeManifest,
            provenance: { registry: "test" }
        });
        const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases: [release] });
        const root = new PackageDependency(release.id, "1.0.0");
        const content = new Map([
            [fixture.mainRef.value, fixture.mainBytes],
            [fixture.dependencyRef.value, fixture.dependencyBytes],
            [providerRef.value, providerBytes]
        ]);
        const loader = new BlueprintLoader({
            lock: resolvePackageLock(snapshot, [root], target),
            releases: [release],
            target,
            placement: new (class extends PlacementSourcePort {
                public sources() {
                    return {
                        substrate: ["dynamic", "provider"],
                        trust: ["dynamic", "provider"]
                    } as const;
                }
            })(),
            content: { get: async (reference) => content.get(reference.value)!.slice() },
            inspector: new (class extends PackageModuleInspector {
                public async imports(module: PackageCodeModule) {
                    return module.imports;
                }
            })(),
            evaluator: new (class extends PackageModuleEvaluator<string> {
                public async evaluate(module: VerifiedPackageModule) {
                    return module.module.specifier;
                }
                public dispose() {}
            })(),
            correspondence: new (class extends PackageCorrespondencePort<string> {
                public async validate() {}
            })()
        });
        const source = new Blueprint({
            meta: { name: "mixed", version: new SemVer("1.0.0") },
            packages: [new PackageInstall({ request: root })],
            policies: PolicySet.empty(),
            agents: []
        });
        await expect(loader.load(source)).rejects.toThrow(/spans incompatible placement modes/);
    });
});

describe("Blueprint loader byte custody and placement selection", () => {
    test("rejects byte-like content that is not an exact Uint8Array", { tags: "p0" }, async () => {
        const fixture = packageFixture();
        const evaluate = vi.fn(async () => "loaded");
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                ({
                    slice: () =>
                        reference.equals(fixture.mainRef)
                            ? fixture.mainBytes.slice()
                            : fixture.dependencyBytes.slice()
                }) as never,
            evaluate
        );

        await expect(loader.load(blueprint(fixture.release, { enabled: true }))).rejects.toThrow(
            /Loaded module bytes do not match/
        );
        expect(evaluate).not.toHaveBeenCalled();
    });

    test("isolates inspector access from the verified byte snapshot", { tags: "p0" }, async () => {
        const fixture = packageFixture();
        const seen = new Map<string, Uint8Array>();
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                reference.equals(fixture.mainRef)
                    ? fixture.mainBytes.slice()
                    : fixture.dependencyBytes.slice(),
            async (module) => {
                seen.set(module.module.specifier, module.bytes.slice());
                return module.module.specifier;
            },
            async (module, bytes) => {
                bytes.fill(0);
                return module.imports;
            }
        );

        const loaded = await loader.load(blueprint(fixture.release, { enabled: true }));
        await loaded.dispose();

        expect(seen.get("./main.js")).toEqual(fixture.mainBytes);
        expect(seen.get("./dependency.js")).toEqual(fixture.dependencyBytes);
    });

    test("accepts inspected imports in any order", { tags: "p1" }, async () => {
        const release = multiImportRelease();
        const loader = releaseLoader(release, async (module) =>
            module.specifier === "./main.js" ? ["./b.js", "./a.js"] : module.imports
        );

        const loaded = await loader.load(installOnly(release));
        expect(loaded.modules.map((module) => module.module.specifier)).toEqual([
            "./a.js",
            "./b.js",
            "./main.js"
        ]);
        await loaded.dispose();
    });

    test("validates correspondence per release with only its own modules", { tags: "p1" }, async () => {
        const fixture = packageFixture();
        const second = singleModuleRelease("second", "export const second = 1;", ["dynamic"]);
        const snapshot = new MetadataSnapshot({
            revision: new Revision(1),
            releases: [fixture.release, second.release]
        });
        const roots = [
            new PackageDependency(fixture.release.id, "1.0.0"),
            new PackageDependency(second.release.id, "1.0.0")
        ];
        const store = contentStore([
            [fixture.mainRef, fixture.mainBytes],
            [fixture.dependencyRef, fixture.dependencyBytes],
            ...second.content
        ]);
        const observed: [string, readonly string[], boolean][] = [];
        const loader = new BlueprintLoader({
            lock: resolvePackageLock(snapshot, roots, target),
            releases: [fixture.release, second.release],
            target,
            placement: allModePlacement(),
            content: { get: store },
            inspector: new (class extends PackageModuleInspector {
                public async imports(module: PackageCodeModule) {
                    return module.imports;
                }
            })(),
            evaluator: new (class extends PackageModuleEvaluator<string> {
                public async evaluate(module: VerifiedPackageModule) {
                    return module.module.specifier;
                }
                public dispose() {}
            })(),
            correspondence: new (class extends PackageCorrespondencePort<string> {
                public async validate(
                    release: PackageRelease,
                    modules: readonly import("../../src/definition").LoadedPackageModule<string>[]
                ) {
                    observed.push([
                        release.id.value,
                        modules.map((module) => module.module.specifier).sort(),
                        modules.every((module) => module.release === release)
                    ]);
                }
            })()
        });
        const source = new Blueprint({
            meta: { name: "pair", version: new SemVer("1.0.0") },
            packages: [
                new PackageInstall({
                    request: roots[0] ?? new PackageDependency(fixture.release.id, "1.0.0"),
                    config: new Config({ enabled: true })
                }),
                new PackageInstall({
                    request: roots[1] ?? new PackageDependency(second.release.id, "1.0.0")
                })
            ],
            policies: PolicySet.empty(),
            agents: []
        });

        const loaded = await loader.load(source);
        await loaded.dispose();

        expect(observed).toEqual([
            ["second", ["./second.js"], true],
            ["test", ["./dependency.js", "./main.js"], true]
        ]);
    });

    test("selects each module's placement from its own Package alone", { tags: "p0" }, async () => {
        const alpha = releaseWithContent(
            "alpha",
            [{ specifier: "./alpha.js", source: "export const alpha = 1;" }],
            [{ facet: "shared.facet", isolation: "dynamic", module: "./alpha.js" }]
        );
        const beta = releaseWithContent(
            "beta",
            [{ specifier: "./beta.js", source: "export const beta = 1;" }],
            [{ facet: "shared.facet", isolation: "provider", module: "./beta.js" }]
        );
        const snapshot = new MetadataSnapshot({
            revision: new Revision(1),
            releases: [alpha.release, beta.release]
        });
        const roots = [
            new PackageDependency(alpha.release.id, "1.0.0"),
            new PackageDependency(beta.release.id, "1.0.0")
        ];
        const selected: [string, string][] = [];
        const loader = new BlueprintLoader({
            lock: resolvePackageLock(snapshot, roots, target),
            releases: [alpha.release, beta.release],
            target,
            placement: allModePlacement(),
            content: { get: contentStore([...alpha.content, ...beta.content]) },
            inspector: new (class extends PackageModuleInspector {
                public async imports(module: PackageCodeModule) {
                    return module.imports;
                }
            })(),
            evaluator: new (class extends PackageModuleEvaluator<string> {
                public async evaluate(module: VerifiedPackageModule) {
                    selected.push([module.module.specifier, module.selected]);
                    return module.module.specifier;
                }
                public dispose() {}
            })(),
            correspondence: new (class extends PackageCorrespondencePort<string> {
                public async validate() {}
            })()
        });
        const source = new Blueprint({
            meta: { name: "shared", version: new SemVer("1.0.0") },
            packages: roots.map((request) => new PackageInstall({ request })),
            policies: PolicySet.empty(),
            agents: []
        });

        const loaded = await loader.load(source);
        await loaded.dispose();

        expect(selected).toEqual([
            ["./alpha.js", "dynamic"],
            ["./beta.js", "provider"]
        ]);
    });

    test("propagates correspondence failure after disposing evaluated modules", { tags: "p1" }, async () => {
        const fixture = packageFixture();
        const disposed: string[] = [];
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                reference.equals(fixture.mainRef) ? fixture.mainBytes : fixture.dependencyBytes,
            async (module) => module.module.specifier,
            undefined,
            (module) => {
                disposed.push(module.module.specifier);
            },
            async () => {
                throw new TypeError("correspondence failed");
            }
        );

        const failure = await loader
            .load(blueprint(fixture.release, { enabled: true }))
            .then(() => "resolved", (error: unknown) => error);

        expect(failure).toBeInstanceOf(TypeError);
        expect(failure).toMatchObject({ message: "correspondence failed" });
        expect(disposed).toEqual(["./main.js", "./dependency.js"]);
    });

    test("disposes modules exactly once through async disposal", { tags: "p1" }, async () => {
        const fixture = packageFixture();
        const disposed: string[] = [];
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                reference.equals(fixture.mainRef) ? fixture.mainBytes : fixture.dependencyBytes,
            async (module) => module.module.specifier,
            undefined,
            (module) => {
                disposed.push(module.module.specifier);
            }
        );
        const loaded = await loader.load(blueprint(fixture.release, { enabled: true }));

        await loaded[Symbol.asyncDispose]();
        expect(disposed).toEqual(["./main.js", "./dependency.js"]);
        await loaded[Symbol.asyncDispose]();
        expect(disposed).toEqual(["./main.js", "./dependency.js"]);
    });

    test("captures the first disposal failure as the thrown error", { tags: "p1" }, async () => {
        const fixture = packageFixture();
        const loader = blueprintLoader(
            fixture,
            async (reference) =>
                reference.equals(fixture.mainRef) ? fixture.mainBytes : fixture.dependencyBytes,
            async (module) => module.module.specifier,
            undefined,
            () => {
                throw new TypeError("dispose failed");
            }
        );
        const loaded = await loader.load(blueprint(fixture.release, { enabled: true }));

        const failure = await loaded.dispose().then(() => "resolved", (error: unknown) => error);
        expect(failure).toBeInstanceOf(TypeError);
        expect(failure).toMatchObject({ message: "dispose failed" });
        await expect(loaded.dispose()).resolves.toBeUndefined();
    });

    test("selects the placement mode of the single reaching Facet per module", { tags: "p0" }, async () => {
        const release = dualFacetRelease(false);
        const selections = new Map<string, string>();
        const loader = releaseLoader(release, undefined, (module) => {
            selections.set(module.module.specifier, module.selected);
        });

        const loaded = await loader.load(installOnly(release));
        await loaded.dispose();

        expect(selections.get("./a.js")).toBe("dynamic");
        expect(selections.get("./b.js")).toBe("provider");
    });

    test("terminates reachability analysis across cyclic module imports", { tags: "p1" }, async () => {
        const release = dualFacetRelease(true);
        const selections = new Map<string, string>();
        const loader = releaseLoader(release, undefined, (module) => {
            selections.set(module.module.specifier, module.selected);
        });

        const loaded = await loader.load(installOnly(release));
        await loaded.dispose();

        expect(selections.get("./a.js")).toBe("dynamic");
        expect(selections.get("./a2.js")).toBe("dynamic");
        expect(selections.get("./b.js")).toBe("provider");
    });
});

interface PackageFixture {
    readonly release: PackageRelease;
    readonly snapshot: MetadataSnapshot;
    readonly mainBytes: Uint8Array;
    readonly dependencyBytes: Uint8Array;
    readonly mainRef: ContentRef;
    readonly dependencyRef: ContentRef;
}

function packageFixture(): PackageFixture {
    const mainBytes = encoder.encode("export { value } from './dependency.js';");
    const dependencyBytes = encoder.encode("export const value = 1;");
    const mainRef = ContentRef.fromDigest(Digest.sha256(mainBytes));
    const dependencyRef = ContentRef.fromDigest(Digest.sha256(dependencyBytes));
    const manifest = new FacetManifest({
        id: new FacetPackageId("test.facet"),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        contributions: Contributions.empty()
    });
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: mainRef,
                media: new MediaHint("application/javascript"),
                imports: ["./dependency.js"]
            }),
            new PackageCodeModule({
                specifier: "./dependency.js",
                content: dependencyRef,
                media: new MediaHint("application/javascript")
            })
        ],
        entrypoints: [
            new PackageCodeEntrypoint({
                facet: manifest.id,
                version: manifest.version,
                module: "./main.js"
            })
        ]
    });
    const release = new PackageRelease({
        id: new PackageId("test"),
        version: new SemVer("1.0.0"),
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests: [manifest],
        codeManifest,
        configSchema: new JsonSchema({
            additionalProperties: false,
            properties: { enabled: { type: "boolean" } },
            required: ["enabled"],
            type: "object"
        }),
        provenance: { registry: "test" }
    });
    return {
        release,
        snapshot: new MetadataSnapshot({ revision: new Revision(1), releases: [release] }),
        mainBytes,
        dependencyBytes,
        mainRef,
        dependencyRef
    };
}

function blueprint(
    release: PackageRelease,
    config: { readonly enabled: boolean | string }
): Blueprint {
    return new Blueprint({
        meta: { name: "loader", version: new SemVer("1.0.0") },
        packages: [
            new PackageInstall({
                request: new PackageDependency(release.id, release.version.toString()),
                config: new Config(config)
            })
        ],
        policies: PolicySet.empty(),
        agents: []
    });
}

function blueprintLoader(
    fixture: PackageFixture,
    get: (reference: ContentRef) => Promise<Uint8Array>,
    evaluate: (module: VerifiedPackageModule) => Promise<string>,
    inspect:
        | ((module: PackageCodeModule, bytes: Uint8Array) => Promise<readonly string[]>)
        | undefined = undefined,
    dispose: (
        module: import("../../src/definition").LoadedPackageModule<string>
    ) => void | Promise<void> = () => undefined,
    validate: (
        release: PackageRelease,
        modules: readonly import("../../src/definition").LoadedPackageModule<string>[]
    ) => Promise<void> = async (release, modules) => {
        expect(release.codeManifest.modules).toHaveLength(modules.length);
    }
): BlueprintLoader<string> {
    const root = new PackageDependency(fixture.release.id, fixture.release.version.toString());
    const lock = resolvePackageLock(fixture.snapshot, [root], target);
    return new BlueprintLoader({
        lock,
        releases: [fixture.release],
        target,
        placement: allModePlacement(),
        content: { get },
        inspector: new (class extends PackageModuleInspector {
            public imports(module: PackageCodeModule, bytes: Uint8Array): Promise<readonly string[]> {
                return (inspect ?? ((candidate) => Promise.resolve(candidate.imports)))(
                    module,
                    bytes
                );
            }
        })(),
        evaluator: new (class extends PackageModuleEvaluator<string> {
            public evaluate(module: VerifiedPackageModule): Promise<string> {
                return evaluate(module);
            }

            public dispose(
                module: import("../../src/definition").LoadedPackageModule<string>
            ): void | Promise<void> {
                return dispose(module);
            }
        })(),
        correspondence: new (class extends PackageCorrespondencePort<string> {
            public validate(
                release: PackageRelease,
                modules: readonly import("../../src/definition").LoadedPackageModule<string>[]
            ): Promise<void> {
                return validate(release, modules);
            }
        })()
    });
}

function allModePlacement(): PlacementSourcePort {
    return new (class extends PlacementSourcePort {
        public sources(_release: PackageRelease, _manifest: FacetManifest) {
            return {
                substrate: ["dynamic", "provider", "bundled"],
                trust: ["dynamic", "provider", "bundled"]
            } as const;
        }
    })();
}

interface ReleaseWithContent {
    readonly release: PackageRelease;
    readonly content: readonly (readonly [ContentRef, Uint8Array])[];
}

interface ModuleSource {
    readonly specifier: string;
    readonly source: string;
    readonly imports?: readonly string[];
}

interface FacetEntry {
    readonly facet: string;
    readonly isolation: "dynamic" | "provider" | "bundled";
    readonly module: string;
}

function releaseWithContent(
    id: string,
    moduleSources: readonly ModuleSource[],
    facets: readonly FacetEntry[]
): ReleaseWithContent {
    const content = moduleSources.map(
        (module) => [module, encoder.encode(module.source)] as const
    );
    const manifests = facets.map(
        (entry) =>
            new FacetManifest({
                id: new FacetPackageId(entry.facet),
                version: new SemVer("1.0.0"),
                compat: CompatRange.any(),
                isolation: [entry.isolation],
                bindings: [],
                contributions: Contributions.empty()
            })
    );
    const [firstManifest] = manifests;
    const [firstFacet] = facets;
    if (firstManifest === undefined || firstFacet === undefined) {
        throw new TypeError("Release requires at least one Facet");
    }
    const release = new PackageRelease({
        id: new PackageId(id),
        version: new SemVer("1.0.0"),
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests: [firstManifest, ...manifests.slice(1)],
        codeManifest: new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: content.map(
                ([module, bytes]) =>
                    new PackageCodeModule({
                        specifier: module.specifier,
                        content: ContentRef.fromDigest(Digest.sha256(bytes)),
                        media: new MediaHint("application/javascript"),
                        imports: module.imports ?? []
                    })
            ) as [PackageCodeModule, ...PackageCodeModule[]],
            entrypoints: facets.map(
                (entry, index) =>
                    new PackageCodeEntrypoint({
                        facet: manifests[index]?.id ?? firstManifest.id,
                        version: new SemVer("1.0.0"),
                        module: entry.module
                    })
            ) as [PackageCodeEntrypoint, ...PackageCodeEntrypoint[]]
        }),
        provenance: { registry: "test" }
    });
    return {
        release,
        content: content.map(([module, bytes]) => [
            ContentRef.fromDigest(Digest.sha256(encoder.encode(module.source))),
            bytes
        ])
    };
}

function multiImportRelease(): ReleaseWithContent {
    return releaseWithContent(
        "multi",
        [
            {
                specifier: "./main.js",
                source: "import './a.js'; import './b.js';",
                imports: ["./a.js", "./b.js"]
            },
            { specifier: "./a.js", source: "export const a = 1;" },
            { specifier: "./b.js", source: "export const b = 1;" }
        ],
        [{ facet: "multi.facet", isolation: "dynamic", module: "./main.js" }]
    );
}

function singleModuleRelease(
    id: string,
    source: string,
    isolation: readonly ["dynamic" | "provider" | "bundled"]
): ReleaseWithContent {
    return releaseWithContent(
        id,
        [{ specifier: `./${id}.js`, source }],
        [{ facet: `${id}.facet`, isolation: isolation[0], module: `./${id}.js` }]
    );
}

function dualFacetRelease(cyclic: boolean): ReleaseWithContent {
    const aModules: readonly ModuleSource[] = cyclic
        ? [
              { specifier: "./a.js", source: "import './a2.js';", imports: ["./a2.js"] },
              { specifier: "./a2.js", source: "import './a.js';", imports: ["./a.js"] }
          ]
        : [{ specifier: "./a.js", source: "export const a = 1;" }];
    return releaseWithContent(
        "duo",
        [...aModules, { specifier: "./b.js", source: "export const b = 1;" }],
        [
            { facet: "duo.a", isolation: "dynamic", module: "./a.js" },
            { facet: "duo.b", isolation: "provider", module: "./b.js" }
        ]
    );
}

function contentStore(
    entries: readonly (readonly [ContentRef, Uint8Array])[]
): (reference: ContentRef) => Promise<Uint8Array> {
    const store = new Map(entries.map(([reference, bytes]) => [reference.value, bytes]));
    return async (reference) => {
        const bytes = store.get(reference.value);
        if (bytes === undefined) {
            throw new TypeError(`Unknown content ${reference.value}`);
        }
        return bytes.slice();
    };
}

function installOnly(entry: ReleaseWithContent): Blueprint {
    return new Blueprint({
        meta: { name: "install", version: new SemVer("1.0.0") },
        packages: [
            new PackageInstall({
                request: new PackageDependency(entry.release.id, "1.0.0")
            })
        ],
        policies: PolicySet.empty(),
        agents: []
    });
}

function releaseLoader(
    entry: ReleaseWithContent,
    inspect:
        | ((module: PackageCodeModule, bytes: Uint8Array) => Promise<readonly string[]>)
        | undefined = undefined,
    onEvaluate: (module: VerifiedPackageModule) => void = () => undefined
): BlueprintLoader<string> {
    const snapshot = new MetadataSnapshot({ revision: new Revision(1), releases: [entry.release] });
    const root = new PackageDependency(entry.release.id, "1.0.0");
    return new BlueprintLoader({
        lock: resolvePackageLock(snapshot, [root], target),
        releases: [entry.release],
        target,
        placement: allModePlacement(),
        content: { get: contentStore(entry.content) },
        inspector: new (class extends PackageModuleInspector {
            public imports(module: PackageCodeModule, bytes: Uint8Array): Promise<readonly string[]> {
                return (inspect ?? ((candidate) => Promise.resolve(candidate.imports)))(
                    module,
                    bytes
                );
            }
        })(),
        evaluator: new (class extends PackageModuleEvaluator<string> {
            public async evaluate(module: VerifiedPackageModule): Promise<string> {
                onEvaluate(module);
                return module.module.specifier;
            }
            public dispose(): void {}
        })(),
        correspondence: new (class extends PackageCorrespondencePort<string> {
            public async validate(): Promise<void> {}
        })()
    });
}

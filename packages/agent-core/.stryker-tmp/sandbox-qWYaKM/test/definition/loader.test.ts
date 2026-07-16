// @ts-nocheck
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
    inspect: ((module: PackageCodeModule) => Promise<readonly string[]>) | undefined = undefined,
    dispose: (
        module: import("../../src/definition").LoadedPackageModule<string>
    ) => void | Promise<void> = () => undefined
): BlueprintLoader<string> {
    const root = new PackageDependency(fixture.release.id, fixture.release.version.toString());
    const lock = resolvePackageLock(fixture.snapshot, [root], target);
    return new BlueprintLoader({
        lock,
        releases: [fixture.release],
        target,
        placement: new (class extends PlacementSourcePort {
            public sources(_release: PackageRelease, _manifest: FacetManifest) {
                return {
                    substrate: ["dynamic", "provider", "bundled"],
                    trust: ["dynamic", "provider", "bundled"]
                } as const;
            }
        })(),
        content: { get },
        inspector: new (class extends PackageModuleInspector {
            public imports(module: PackageCodeModule): Promise<readonly string[]> {
                return (inspect ?? ((candidate) => Promise.resolve(candidate.imports)))(module);
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
            public async validate(
                release: PackageRelease,
                modules: readonly import("../../src/definition").LoadedPackageModule<string>[]
            ): Promise<void> {
                expect(release.codeManifest.modules).toHaveLength(modules.length);
            }
        })()
    });
}

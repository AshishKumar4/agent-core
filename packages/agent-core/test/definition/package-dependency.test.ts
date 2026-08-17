import { describe, expect, test, vi, type Mock } from "vitest";
import { MediaHint } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    Revision,
    SemVer,
    isJsonObject,
    requireNonempty,
    type JsonValue
} from "../../src/core";
import {
    Blueprint,
    BlueprintLoader,
    MetadataSnapshot,
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule,
    PackageCorrespondencePort,
    PackageDependency,
    PackageId,
    PackageInstall,
    PackageLock,
    PackageModuleEvaluator,
    PackageModuleInspector,
    PackagePin,
    PackageRelease,
    PlacementSourcePort,
    PlatformCompatibility,
    PolicySet,
    ValidatedBlueprint,
    resolvePackageLock,
    type DefinitionPinSet
} from "../../src/definition";
import {
    BindingName,
    BindingRequirement,
    Contributions,
    FacetManifest,
    FacetPackageId,
    type IsolationMode
} from "../../src/facets";

const encoder = new TextEncoder();
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });

describe("§9.1 declared Package dependencies", () => {
    test(
        "[C13-PACKAGE-DEPENDENCY-DECLARED] carries the declared relation as data through the codec and refuses a repeated id",
        { tags: "p0" },
        () => {
            const release = releaseOf("app", "1.0.0", [
                dependency("lib", "^1"),
                dependency("core", "^2")
            ]);

            const restored = PackageRelease.decode(PackageRelease.encode(release));
            expect(
                restored.dependencies.map((entry) => [entry.id.value, entry.range])
            ).toEqual([
                ["core", ">=2.0.0 <3.0.0-0"],
                ["lib", ">=1.0.0 <2.0.0-0"]
            ]);

            const payload = release.toData();
            if (!isJsonObject(payload)) throw new TypeError("Package release payload");
            const repeated: JsonValue = {
                ...payload,
                dependencies: [
                    dependency("lib", "^1").toData(),
                    dependency("lib", "^2").toData()
                ]
            };
            expect(() => PackageRelease.fromData(repeated)).toThrow(
                "Package dependency IDs must be unique"
            );
            expect(() =>
                PackageDependency.fromData({ id: "lib", range: "^1" })
            ).toThrow("Package dependency range must be canonical");
        }
    );

    test(
        "[C13-PACKAGE-DEPENDENCY-DECLARED] rejects a dependency the Blueprint does not install before any package code loads",
        { tags: "p0" },
        async () => {
            const app = releaseOf("app", "1.0.0", [dependency("absent", "^1")]);
            const probe = codeProbe();
            const loader = loaderFor(lockOf(app, [app]), [app], probe);

            await expect(loader.load(blueprintFor(app))).rejects.toThrow("Missing package absent");
            expect(probe.get).not.toHaveBeenCalled();
            expect(probe.inspect).not.toHaveBeenCalled();
            expect(probe.evaluate).not.toHaveBeenCalled();
        }
    );

    test(
        "[C13-PACKAGE-DEPENDENCY-DECLARED] rejects an unsatisfiable dependency range before any package code loads",
        { tags: "p0" },
        async () => {
            const lib = releaseOf("lib", "1.0.0", []);
            const app = releaseOf("app", "1.0.0", [dependency("lib", "^2")]);
            const probe = codeProbe();
            const loader = loaderFor(lockOf(app, [app, lib]), [app, lib], probe);

            await expect(loader.load(blueprintFor(app))).rejects.toThrow(
                "No version of package lib satisfies >=2.0.0 <3.0.0-0"
            );
            expect(probe.get).not.toHaveBeenCalled();
            expect(probe.inspect).not.toHaveBeenCalled();
            expect(probe.evaluate).not.toHaveBeenCalled();
        }
    );

    test(
        "[C13-PACKAGE-DEPENDENCY-DECLARED] refuses a complete-looking lock that is not the closure of the declared relation",
        { tags: "p0" },
        async () => {
            const lib = releaseOf("lib", "1.0.0", []);
            const spare = releaseOf("spare", "1.0.0", []);
            const app = releaseOf("app", "1.0.0", [dependency("lib", "^1")]);
            const releases = [app, lib, spare];
            const closure = resolvePackageLock(snapshotOf(releases), [rootOf(app)], target);
            expect(closure.packages.map((pin) => pin.id.value)).toEqual(["app", "lib"]);

            // Each forged lock is complete by a different superficial measure: the right
            // members minus one, the right count with a member no declared dependency
            // reaches, and the exact member ids at a release resolution never selects.
            const truncated = relock(closure, [pinOf(app)]);
            const substituted = relock(closure, [pinOf(app), pinOf(spare)]);
            const detached = relock(closure, [pinOf(app), pinOf(lib), pinOf(spare)]);
            for (const forged of [truncated, substituted, detached]) {
                const probe = codeProbe();
                const loader = loaderFor(forged, releases, probe);
                await expect(loader.load(blueprintFor(app))).rejects.toThrow(
                    "PackageLock does not match deterministic resolution of its metadata snapshot"
                );
                expect(probe.evaluate).not.toHaveBeenCalled();
            }
        }
    );

    test(
        "[C13-PACKAGE-DEPENDENCY-DECLARED] admits exactly the declared closure as a pinned closure and names each divergence",
        { tags: "p0" },
        () => {
            const lib = releaseOf("lib", "1.0.0", []);
            const other = releaseOf("lib", "2.0.0", []);
            const spare = releaseOf("spare", "1.0.0", []);
            const app = releaseOf("app", "1.0.0", [dependency("lib", "^1")]);
            const validated = validate(app, [app, lib, other, spare]);
            const pins = pinSet(validated, validated.lock.packages);

            expect(() => validated.requirePinnedClosure(pins)).not.toThrow();

            expect(() =>
                validated.requirePinnedClosure(pinSet(validated, [...pins.packages, pinOf(spare)]))
            ).toThrow("Pinned Package spare is outside the declared closure");
            expect(() =>
                validated.requirePinnedClosure(pinSet(validated, [pinOf(app)]))
            ).toThrow("Declared closure member lib is absent from the pinned closure");
            expect(() =>
                validated.requirePinnedClosure(
                    pinSet(validated, [pinOf(app), pinOf(other)])
                )
            ).toThrow(
                "Pinned Package lib is pinned at a release the declared closure does not resolve"
            );
            expect(() =>
                validated.requirePinnedClosure(
                    pinSet(validated, [pinOf(app), pinOf(lib), pinOf(lib)])
                )
            ).toThrow("Pinned Package closure repeats a Package ID");
            expect(() =>
                validated.requirePinnedClosure({
                    blueprint: {
                        version: new SemVer("1.0.0"),
                        digest: Digest.sha256(encoder.encode("other"))
                    },
                    packages: validated.lock.packages
                })
            ).toThrow("Pinned Blueprint 1.0.0 is not the validated Blueprint 1.0.0");
        }
    );

    test(
        "[C13-PACKAGE-DEPENDENCY-DECLARED] resolves and pins a cyclic declared relation rather than refusing the Blueprint",
        { tags: "p0" },
        () => {
            // SPEC §9.1 makes the closure computable whether or not the declared relation is
            // acyclic; the cycle §13 rejects is §4.1 Facet reliance, C13-FACET-DEPENDENCY-ORDER.
            const app = releaseOf("app", "1.0.0", [dependency("lib", "^1")]);
            const lib = releaseOf("lib", "1.0.0", [dependency("app", "^1")]);
            const validated = validate(app, [app, lib]);

            expect(validated.lock.packages.map((pin) => pin.id.value)).toEqual(["app", "lib"]);
            expect(
                new Set(validated.lock.packages.map((pin) => pin.id.value)).size
            ).toBe(validated.lock.packages.length);
            expect(() =>
                validated.requirePinnedClosure(pinSet(validated, validated.lock.packages))
            ).not.toThrow();
        }
    );

    test(
        "[C13-PACKAGE-DEPENDENCY-DECLARED] never derives a dependency from a BindingRequirement or a requirement from a dependency",
        { tags: "p0" },
        () => {
            const requirement = new BindingRequirement(
                new BindingName("store"),
                new FacetPackageId("lib.facet"),
                CompatRange.any()
            );
            const declared = dependency("lib.facet", "^1");

            // The two planes name different identities, and the discipline is enforced at
            // COMPARISON rather than at assignment: both ids extend TextId and declare no
            // own private member, so TypeScript treats them as mutually assignable and only
            // TextId.equals refuses the pair. A host that derived one from the other by
            // string value therefore produces an id that matches nothing on either plane.
            expect(declared.id.value).toBe(requirement.facet.value);
            expect(declared.id.equals(requirement.facet)).toBe(false);
            expect(requirement.facet.equals(declared.id)).toBe(false);
            expect(new PackageId(requirement.facet.value).equals(declared.id)).toBe(true);

            // A requirement a manifest declares does not enter the closure: only the declared
            // dependency relation does, so a Package named only by a requirement is absent.
            const app = releaseOf("app", "1.0.0", [], [requirement]);
            const validated = validate(app, [app, releaseOf("lib.facet", "1.0.0", [])]);
            expect(validated.lock.packages.map((pin) => pin.id.value)).toEqual(["app"]);
        }
    );
});

function dependency(id: string, range: string): PackageDependency {
    return new PackageDependency(new PackageId(id), range);
}

function releaseOf(
    id: string,
    version: string,
    dependencies: readonly PackageDependency[],
    bindings: readonly BindingRequirement[] = []
): PackageRelease {
    const bytes = encoder.encode(`export const id = "${id}@${version}";`);
    const manifest = new FacetManifest({
        id: new FacetPackageId(`${id}.entry`),
        version: new SemVer(version),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings,
        contributions: Contributions.empty()
    });
    return new PackageRelease({
        id: new PackageId(id),
        version: new SemVer(version),
        compatibility: CompatRange.any(),
        dependencies,
        manifests: requireNonempty([manifest], "manifests"),
        codeManifest: new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: [
                new PackageCodeModule({
                    specifier: "./main.js",
                    content: ContentRef.fromDigest(Digest.sha256(bytes)),
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
        }),
        provenance: { registry: "test" }
    });
}

function snapshotOf(releases: readonly PackageRelease[]): MetadataSnapshot {
    return new MetadataSnapshot({ revision: new Revision(1), releases });
}

function rootOf(root: PackageRelease): PackageDependency {
    return new PackageDependency(root.id, root.version.toString());
}

function pinOf(release: PackageRelease): PackagePin {
    return new PackagePin(
        release.id,
        release.version,
        release.manifestDigest,
        release.codeDigest
    );
}

/** A lock the resolver would never produce, keeping every field the caller did not forge. */
function relock(lock: PackageLock, packages: readonly PackagePin[]): PackageLock {
    return new PackageLock({
        target: lock.target,
        roots: lock.roots,
        snapshotRevision: lock.snapshotRevision,
        snapshotDigest: lock.snapshotDigest,
        packages
    });
}

/**
 * A lock pinning only the root, over the snapshot the loader will rebuild. Validation
 * re-derives the closure from the declared relation, so the root-only pin is what makes
 * the unresolvable dependency the first thing that fails.
 */
function lockOf(root: PackageRelease, releases: readonly PackageRelease[]): PackageLock {
    return new PackageLock({
        target,
        roots: [rootOf(root)],
        snapshotRevision: new Revision(1),
        snapshotDigest: snapshotOf(releases).digest,
        packages: [pinOf(root)]
    });
}

function pinSet(
    validated: ValidatedBlueprint,
    packages: readonly PackagePin[]
): DefinitionPinSet {
    return {
        blueprint: {
            version: validated.blueprint.meta.version,
            digest: validated.attestation.blueprintDigest
        },
        packages
    };
}

function blueprintFor(root: PackageRelease): Blueprint {
    return new Blueprint({
        meta: { name: "closure", version: new SemVer("1.0.0") },
        packages: [new PackageInstall({ request: rootOf(root) })],
        policies: PolicySet.empty(),
        agents: []
    });
}

function validate(
    root: PackageRelease,
    releases: readonly PackageRelease[]
): ValidatedBlueprint {
    const snapshot = snapshotOf(releases);
    return ValidatedBlueprint.validate(blueprintFor(root), {
        lock: resolvePackageLock(snapshot, [rootOf(root)], target),
        releases,
        target,
        placement: dynamicPlacement()
    });
}

/** Every seam the loader would touch to resolve, inspect, or evaluate package code. */
interface CodeProbe {
    readonly get: Mock<(reference: ContentRef) => Promise<Uint8Array>>;
    readonly inspect: Mock<() => Promise<readonly string[]>>;
    readonly evaluate: Mock<() => Promise<string>>;
}

function codeProbe(): CodeProbe {
    return {
        get: vi.fn(async () => encoder.encode("unreachable")),
        inspect: vi.fn(async () => []),
        evaluate: vi.fn(async () => "unreachable")
    };
}

function loaderFor(
    lock: PackageLock,
    releases: readonly PackageRelease[],
    probe: CodeProbe
): BlueprintLoader<string> {
    return new BlueprintLoader({
        lock,
        releases,
        target,
        placement: dynamicPlacement(),
        content: { get: probe.get },
        inspector: new (class extends PackageModuleInspector {
            public imports(): Promise<readonly string[]> {
                return probe.inspect();
            }
        })(),
        evaluator: new (class extends PackageModuleEvaluator<string> {
            public evaluate(): Promise<string> {
                return probe.evaluate();
            }

            public dispose(): void {}
        })(),
        correspondence: new (class extends PackageCorrespondencePort<string> {
            public async validate(): Promise<void> {}
        })()
    });
}

function dynamicPlacement(): PlacementSourcePort {
    return new (class extends PlacementSourcePort {
        public substrateModes(): readonly IsolationMode[] {
            return ["dynamic"];
        }
    })();
}

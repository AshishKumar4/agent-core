import { describe, expect, test } from "vitest";
import { MediaHint } from "../../src/content";
import { CompatRange, ContentRef, Digest, Revision, SemVer } from "../../src/core";
import {
    MetadataSnapshot,
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule,
    PackageDependency,
    PackageId,
    PackageLock,
    PackageRelease,
    PackageResolver,
    PlatformCompatibility,
    resolvePackageLock as resolveWithTarget
} from "../../src/definition";
import { Contributions, FacetManifest, FacetPackageId } from "../../src/facets";

const encoder = new TextEncoder();
const resolver = new PackageResolver();
const target = new PlatformCompatibility({ spec: new SemVer("1.0.0"), host: new SemVer("1.0.0") });

describe("deterministic package resolution", () => {
    test("backtracks globally instead of accepting a greedy local maximum", () => {
        const snapshot = metadata([
            release("a", "2.0.0", [dependency("c", "^2")]),
            release("a", "1.0.0", [dependency("c", "^1")]),
            release("b", "1.0.0", [dependency("c", "^1")]),
            release("c", "2.0.0"),
            release("c", "1.5.0")
        ]);

        const lock = resolver.resolve(
            snapshot,
            [dependency("b", "*"), dependency("a", "*")],
            target
        );

        expect(versions(lock)).toEqual({ a: "1.0.0", b: "1.0.0", c: "1.5.0" });
    });

    test("excludes prereleases unless every accumulated range admits the same base", () => {
        const simple = metadata([release("app", "2.0.0-beta.2"), release("app", "1.9.0")]);
        expect(versions(resolvePackageLock(simple, [dependency("app", ">=1.0.0")]))).toEqual({
            app: "1.9.0"
        });
        expect(
            versions(resolvePackageLock(simple, [dependency("app", ">=2.0.0-beta.1 <2.0.0")]))
        ).toEqual({
            app: "2.0.0-beta.2"
        });

        const accumulated = metadata([
            release("a", "1.0.0", [dependency("shared", ">=2.0.0-beta.1 <2.0.0")]),
            release("b", "1.0.0", [dependency("shared", ">=1.0.0")]),
            release("shared", "2.0.0-beta.2")
        ]);
        expect(() =>
            resolvePackageLock(accumulated, [dependency("a", "*"), dependency("b", "*")])
        ).toThrow(/No version of package shared/);

        const admitted = metadata([
            release("a", "1.0.0", [dependency("shared", ">=2.0.0-beta.1 <2.0.0")]),
            release("b", "1.0.0", [dependency("shared", "2.0.0-beta.2")]),
            release("shared", "2.0.0-beta.2")
        ]);
        expect(
            versions(resolvePackageLock(admitted, [dependency("a", "*"), dependency("b", "*")]))
                .shared
        ).toBe("2.0.0-beta.2");
    });

    test("breaks equal-precedence build ties by ascending full canonical version", () => {
        const alphaFirst = metadata([release("app", "1.0.0+alpha"), release("app", "1.0.0+zeta")]);
        const zetaFirst = metadata([release("app", "1.0.0+zeta"), release("app", "1.0.0+alpha")]);

        const first = resolvePackageLock(alphaFirst, [dependency("app", "*")]);
        const second = resolvePackageLock(zetaFirst, [dependency("app", "*")]);
        expect(versions(first)).toEqual({ app: "1.0.0+alpha" });
        expect(alphaFirst.digest.equals(zetaFirst.digest)).toBe(true);
        expect(PackageLock.encode(first)).toEqual(PackageLock.encode(second));
    });

    test("resolves byte-identically across root, release, and dependency insertion orders", () => {
        const first = metadata(
            [
                release("root-b", "1.0.0", [dependency("z", "^1"), dependency("a", "^1")]),
                release("z", "1.0.0"),
                release("root-a", "1.0.0", [dependency("a", "^1")]),
                release("a", "1.1.0")
            ],
            9
        );
        const second = metadata(
            [
                release("a", "1.1.0"),
                release("root-a", "1.0.0", [dependency("a", "^1")]),
                release("z", "1.0.0"),
                release("root-b", "1.0.0", [dependency("a", "^1"), dependency("z", "^1")])
            ],
            9
        );

        const left = resolvePackageLock(first, [
            dependency("root-b", "*"),
            dependency("root-a", "*")
        ]);
        const right = resolvePackageLock(second, [
            dependency("root-a", "*"),
            dependency("root-b", "*")
        ]);
        expect(PackageLock.encode(left)).toEqual(PackageLock.encode(right));
        expect(left.packages.map((pin) => pin.id.value)).toEqual(["a", "root-a", "root-b", "z"]);
    });

    test("rejects duplicate roots, missing packages, and incompatible intersections", () => {
        const snapshot = metadata([
            release("a", "1.0.0", [dependency("shared", "^1")]),
            release("b", "1.0.0", [dependency("shared", "^2")]),
            release("shared", "1.0.0"),
            release("shared", "2.0.0")
        ]);
        expect(() =>
            resolvePackageLock(snapshot, [dependency("a", "*"), dependency("a", "^1")])
        ).toThrow("Duplicate root package ID a");
        expect(() => resolvePackageLock(snapshot, [dependency("missing", "*")])).toThrow(
            "Missing package missing"
        );
        expect(() =>
            resolvePackageLock(snapshot, [dependency("a", "*"), dependency("b", "*")])
        ).toThrow(/No version of package shared satisfies/);
    });

    test("rejects self and multi-package cycles with canonical paths", () => {
        const self = metadata([release("self", "1.0.0", [dependency("self", "*")])]);
        expect(() => resolvePackageLock(self, [dependency("self", "*")])).toThrow(
            "Package dependency cycle: self -> self"
        );

        const cycle = metadata([
            release("z", "1.0.0", [dependency("a", "*")]),
            release("a", "1.0.0", [dependency("m", "*")]),
            release("m", "1.0.0", [dependency("z", "*")])
        ]);
        expect(() => resolvePackageLock(cycle, [dependency("z", "*")])).toThrow(
            "Package dependency cycle: a -> m -> z -> a"
        );
    });

    test("backtracks away from a cyclic candidate when a complete closure exists", () => {
        const snapshot = metadata([
            release("a", "2.0.0", [dependency("b", "^2")]),
            release("a", "1.0.0", [dependency("b", "^1")]),
            release("b", "2.0.0", [dependency("a", "^2")]),
            release("b", "1.0.0")
        ]);

        expect(versions(resolvePackageLock(snapshot, [dependency("a", "*")]))).toEqual({
            a: "1.0.0",
            b: "1.0.0"
        });
    });

    test("filters Package and Facet compatibility before deterministic selection", () => {
        const snapshot = metadata([
            release("app", "3.0.0", [], new CompatRange(">=2", "*")),
            release("app", "2.0.0", [], CompatRange.any(), new CompatRange("*", ">=2")),
            release("app", "1.0.0")
        ]);
        expect(versions(resolvePackageLock(snapshot, [dependency("app", "*")]))).toEqual({
            app: "1.0.0"
        });

        const otherTarget = new PlatformCompatibility({
            spec: new SemVer("2.0.0"),
            host: new SemVer("2.0.0")
        });
        const other = resolveWithTarget(snapshot, [dependency("app", "*")], otherTarget);
        expect(versions(other)).toEqual({ app: "3.0.0" });
        expect(
            other.digest.equals(resolvePackageLock(snapshot, [dependency("app", "*")]).digest)
        ).toBe(false);
        const incompatible = metadata([release("only", "1.0.0", [], new CompatRange(">=2", "*"))]);
        expect(() => resolvePackageLock(incompatible, [dependency("only", "*")])).toThrow(
            /No version/
        );
    });
});

function metadata(releases: readonly PackageRelease[], revision = 1): MetadataSnapshot {
    return new MetadataSnapshot({ revision: new Revision(revision), releases });
}

function dependency(id: string, range: string): PackageDependency {
    return new PackageDependency(new PackageId(id), range);
}

function release(
    id: string,
    version: string,
    dependencies: readonly PackageDependency[] = [],
    compatibility: CompatRange = CompatRange.any(),
    manifestCompatibility: CompatRange = CompatRange.any()
): PackageRelease {
    const manifests = [manifest(`${id}.facet`, version, manifestCompatibility)] as [FacetManifest];
    return new PackageRelease({
        id: new PackageId(id),
        version: new SemVer(version),
        compatibility,
        dependencies,
        manifests,
        codeManifest: codeManifest(manifests[0], digestOf(`code:${id}:${version}`)),
        provenance: { registry: "test" }
    });
}

function codeManifest(manifest: FacetManifest, digest: Digest): PackageCodeManifest {
    return new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digest),
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
}

function resolvePackageLock(
    snapshot: MetadataSnapshot,
    roots: readonly PackageDependency[]
): PackageLock {
    return resolveWithTarget(snapshot, roots, target);
}

function manifest(id: string, version: string, compatibility = CompatRange.any()): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId(id),
        version: new SemVer(version),
        compat: compatibility,
        isolation: ["dynamic"],
        bindings: [],
        contributions: new Contributions([])
    });
}

function versions(lock: PackageLock): Record<string, string> {
    return Object.fromEntries(lock.packages.map((pin) => [pin.id.value, pin.version.toString()]));
}

function digestOf(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

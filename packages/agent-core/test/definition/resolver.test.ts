import { describe, expect, test } from "vitest";
import { MediaHint } from "../../src/content";
import { CompatRange, ContentRef, Digest, Revision, SemVer, requireNonempty } from "../../src/core";
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
    test("backtracks globally instead of accepting a greedy local maximum", { tags: "p1" }, () => {
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

    test(
        "excludes prereleases unless every accumulated range admits the same base",
        { tags: "p1" },
        () => {
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
                versions(
                    resolvePackageLock(admitted, [dependency("a", "*"), dependency("b", "*")])
                )["shared"]
            ).toBe("2.0.0-beta.2");
        }
    );

    test(
        "breaks equal-precedence build ties by ascending full canonical version",
        { tags: "p1" },
        () => {
            const alphaFirst = metadata([
                release("app", "1.0.0+alpha"),
                release("app", "1.0.0+zeta")
            ]);
            const zetaFirst = metadata([
                release("app", "1.0.0+zeta"),
                release("app", "1.0.0+alpha")
            ]);

            const first = resolvePackageLock(alphaFirst, [dependency("app", "*")]);
            const second = resolvePackageLock(zetaFirst, [dependency("app", "*")]);
            expect(versions(first)).toEqual({ app: "1.0.0+alpha" });
            expect(alphaFirst.digest.equals(zetaFirst.digest)).toBe(true);
            expect(PackageLock.encode(first)).toEqual(PackageLock.encode(second));
        }
    );

    test(
        "resolves byte-identically across root, release, and dependency insertion orders",
        { tags: "p1" },
        () => {
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
            expect(left.packages.map((pin) => pin.id.value)).toEqual([
                "a",
                "root-a",
                "root-b",
                "z"
            ]);
        }
    );

    test(
        "rejects duplicate roots, missing packages, and incompatible intersections",
        { tags: "p1" },
        () => {
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
        }
    );

    test("rejects self and multi-package cycles with canonical paths", { tags: "p1" }, () => {
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

    test("a wildcard range skips prerelease candidates instead of crashing", { tags: "p1" }, () => {
        const snapshot = metadata([release("app", "2.0.0-beta.2"), release("app", "1.0.0")]);

        expect(versions(resolvePackageLock(snapshot, [dependency("app", "*")]))).toEqual({
            app: "1.0.0"
        });
    });

    test(
        "backtracks away from a cyclic candidate when a complete closure exists",
        { tags: "p1" },
        () => {
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
        }
    );

    test(
        "re-checks earlier selections when later dependencies narrow their ranges",
        { tags: "p1" },
        () => {
            const snapshot = metadata([
                release("a", "2.0.0"),
                release("a", "1.0.0"),
                release("b", "1.0.0", [dependency("a", "^1")])
            ]);

            const lock = resolvePackageLock(snapshot, [dependency("a", "*"), dependency("b", "*")]);

            expect(versions(lock)).toEqual({ a: "1.0.0", b: "1.0.0" });
        }
    );

    test(
        "selects unresolved packages in lexicographic order independent of root order",
        { tags: "p1" },
        () => {
            const snapshot = metadata([
                release("a", "2.0.0", [dependency("x", "^1")]),
                release("a", "1.0.0", [dependency("x", "^2")]),
                release("b", "2.0.0", [dependency("x", "^2")]),
                release("b", "1.0.0", [dependency("x", "^1")]),
                release("x", "2.0.0"),
                release("x", "1.0.0")
            ]);

            const lock = resolvePackageLock(snapshot, [dependency("b", "*"), dependency("a", "*")]);

            expect(versions(lock)).toEqual({ a: "2.0.0", b: "1.0.0", x: "1.0.0" });
        }
    );

    test(
        "excludes a release when any of its Facet manifests is incompatible",
        { tags: "p1" },
        () => {
            const manifests = requireNonempty([
                manifest("dual.compatible", "1.0.0"),
                manifest("dual.incompatible", "1.0.0", new CompatRange("*", ">=2"))
            ], "Facet manifests");
            const dual = new PackageRelease({
                id: new PackageId("dual"),
                version: new SemVer("1.0.0"),
                compatibility: CompatRange.any(),
                dependencies: [],
                manifests,
                codeManifest: new PackageCodeManifest({
                    compatibilityDate: "2026-07-10",
                    modules: [
                        new PackageCodeModule({
                            specifier: "./main.js",
                            content: ContentRef.fromDigest(digestOf("code:dual")),
                            media: new MediaHint("application/javascript")
                        })
                    ],
                    entrypoints: requireNonempty(
                        manifests.map(
                        (facet) =>
                            new PackageCodeEntrypoint({
                                facet: facet.id,
                                version: facet.version,
                                module: "./main.js"
                            })
                    ), "code entrypoints")
                }),
                provenance: { registry: "test" }
            });

            expect(() => resolvePackageLock(metadata([dual]), [dependency("dual", "*")])).toThrow(
                /No version of package dual/
            );
        }
    );

    test(
        "admits prereleases only through an explicitly matching comparator clause",
        { tags: "p1" },
        () => {
            const cases: readonly {
                readonly range: string;
                readonly prerelease: string;
                readonly stable: string;
                readonly expected: string;
            }[] = [
                {
                    range: ">=1.0.0 <1.5.0 || 2.0.0-beta.2",
                    prerelease: "2.0.0-beta.2",
                    stable: "1.0.0",
                    expected: "2.0.0-beta.2"
                },
                {
                    range: ">=1.0.0 || >=2.0.0-beta.1 <2.0.0-beta.3",
                    prerelease: "2.0.0-beta.5",
                    stable: "1.2.0",
                    expected: "1.2.0"
                },
                {
                    range: "<=2.0.0",
                    prerelease: "2.0.0-beta.2",
                    stable: "1.0.0",
                    expected: "1.0.0"
                },
                {
                    range: ">=1.0.0-beta.1",
                    prerelease: "2.0.0-beta.2",
                    stable: "1.0.0",
                    expected: "1.0.0"
                },
                {
                    range: "<=2.1.0-beta.1",
                    prerelease: "2.0.0-beta.2",
                    stable: "1.0.0",
                    expected: "1.0.0"
                },
                {
                    range: "<=2.0.1-beta.1",
                    prerelease: "2.0.0-beta.2",
                    stable: "1.0.0",
                    expected: "1.0.0"
                }
            ];
            for (const candidate of cases) {
                const snapshot = metadata([
                    release("app", candidate.prerelease),
                    release("app", candidate.stable)
                ]);
                const lock = resolvePackageLock(snapshot, [dependency("app", candidate.range)]);
                expect({ range: candidate.range, versions: versions(lock) }).toEqual({
                    range: candidate.range,
                    versions: { app: candidate.expected }
                });
            }
        }
    );

    test("reports conflict constraints as a sorted unique conjunction", { tags: "p2" }, () => {
        const incompatible = metadata([release("only", "1.0.0", [], new CompatRange(">=2", "*"))]);
        expect(() => resolvePackageLock(incompatible, [dependency("only", "*")])).toThrow(
            "No version of package only satisfies *"
        );

        const conflicting = metadata([
            release("a", "1.0.0", [dependency("shared", "^2")]),
            release("b", "1.0.0", [dependency("shared", "^1")]),
            release("shared", "1.0.0"),
            release("shared", "2.0.0")
        ]);
        expect(() =>
            resolvePackageLock(conflicting, [dependency("a", "*"), dependency("b", "*")])
        ).toThrow("No version of package shared satisfies >=1.0.0 <2.0.0-0 && >=2.0.0 <3.0.0-0");
    });

    test("reports the canonical rotation of the detected cycle", { tags: "p2" }, () => {
        const entered = metadata([
            release("a", "1.0.0", [dependency("m", "*")]),
            release("m", "1.0.0", [dependency("z", "*")]),
            release("z", "1.0.0", [dependency("m", "*")])
        ]);
        expect(() => resolvePackageLock(entered, [dependency("a", "*")])).toThrow(
            "Package dependency cycle: m -> z -> m"
        );

        const reversed = metadata([
            release("a", "1.0.0", [dependency("z", "*")]),
            release("z", "1.0.0", [dependency("b", "*")]),
            release("b", "1.0.0", [dependency("z", "*")])
        ]);
        expect(() => resolvePackageLock(reversed, [dependency("a", "*")])).toThrow(
            "Package dependency cycle: b -> z -> b"
        );

        const prefixed = metadata([
            release("a", "1.0.0", [dependency("a-b", "*")]),
            release("a-b", "1.0.0", [dependency("a", "*")])
        ]);
        expect(() => resolvePackageLock(prefixed, [dependency("a", "*")])).toThrow(
            "Package dependency cycle: a -> a-b -> a"
        );

        const outerEntry = metadata([
            release("0", "1.0.0", [dependency("a-b", "*")]),
            release("a-b", "1.0.0", [dependency("a", "*")]),
            release("a", "1.0.0", [dependency("a-b", "*")])
        ]);
        expect(() => resolvePackageLock(outerEntry, [dependency("0", "*")])).toThrow(
            "Package dependency cycle: a -> a-b -> a"
        );

        const detached = metadata([
            release("a", "1.0.0"),
            release("m", "1.0.0", [dependency("z", "*")]),
            release("z", "1.0.0", [dependency("m", "*")])
        ]);
        expect(() =>
            resolvePackageLock(detached, [dependency("a", "*"), dependency("m", "*")])
        ).toThrow("Package dependency cycle: m -> z -> m");
    });

    test(
        "canonicalizes NUL-bearing PackageId cycles by structured sequence identity",
        { tags: "p0" },
        () => {
            const enteredAtCollidingRotation = metadata([
                release("0", "1.0.0", [dependency("a\0b", "*")]),
                release("a\0b", "1.0.0", [dependency("c", "*")]),
                release("c", "1.0.0", [dependency("a", "*")]),
                release("a", "1.0.0", [dependency("b\0c", "*")]),
                release("b\0c", "1.0.0", [dependency("a\0b", "*")])
            ]);

            expect(() =>
                resolvePackageLock(enteredAtCollidingRotation, [dependency("0", "*")])
            ).toThrow("Package dependency cycle: a -> b\0c -> a\0b -> c -> a");
        }
    );

    test("reports each cycle rotation exactly once", { tags: "p1" }, () => {
        const self = metadata([release("self", "1.0.0", [dependency("self", "*")])]);
        expect(() => resolvePackageLock(self, [dependency("self", "*")])).toThrow(
            /^Package dependency cycle: self -> self$/
        );

        const pair = metadata([
            release("b", "1.0.0", [dependency("z", "*")]),
            release("z", "1.0.0", [dependency("b", "*")])
        ]);
        expect(() => resolvePackageLock(pair, [dependency("b", "*")])).toThrow(
            /^Package dependency cycle: b -> z -> b$/
        );

        const triple = metadata([
            release("a", "1.0.0", [dependency("m", "*")]),
            release("m", "1.0.0", [dependency("z", "*")]),
            release("z", "1.0.0", [dependency("a", "*")])
        ]);
        expect(() => resolvePackageLock(triple, [dependency("a", "*")])).toThrow(
            /^Package dependency cycle: a -> m -> z -> a$/
        );
    });

    test(
        "resolves multi-dependency graphs without reporting spurious cycles",
        { tags: "p1" },
        () => {
            const snapshot = metadata([
                release("a", "1.0.0", [dependency("b", "*"), dependency("c", "*")]),
                release("b", "1.0.0"),
                release("c", "1.0.0"),
                release("z", "1.0.0", [dependency("a", "*")])
            ]);

            expect(versions(resolvePackageLock(snapshot, [dependency("z", "*")]))).toEqual({
                a: "1.0.0",
                b: "1.0.0",
                c: "1.0.0",
                z: "1.0.0"
            });
        }
    );

    test(
        "resolves a deep shared-dependency lattice without revisiting subgraphs",
        { tags: "p1" },
        () => {
            // kills src/definition/resolver.ts:188 (cycle detection's visited guard:
            // without it the 2-wide lattice below is re-traversed once per path, which
            // is exponential in depth and can never finish inside the test timeout)
            const levels = 30;
            const releases: PackageRelease[] = [];
            for (let level = 0; level < levels; level += 1) {
                const next = String(level + 1).padStart(2, "0");
                const deps =
                    level === levels - 1
                        ? []
                        : [dependency(`n${next}a`, "1.0.0"), dependency(`n${next}b`, "1.0.0")];
                const current = String(level).padStart(2, "0");
                releases.push(release(`n${current}a`, "1.0.0", deps));
                releases.push(release(`n${current}b`, "1.0.0", deps));
            }
            const lock = resolvePackageLock(metadata(releases), [
                dependency("n00a", "1.0.0"),
                dependency("n00b", "1.0.0")
            ]);
            expect(lock.packages).toHaveLength(2 * levels);
            expect(lock.packages.every((pin) => pin.version.toString() === "1.0.0")).toBe(true);
        }
    );

    test(
        "filters Package and Facet compatibility before deterministic selection",
        { tags: "p1" },
        () => {
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
            const incompatible = metadata([
                release("only", "1.0.0", [], new CompatRange(">=2", "*"))
            ]);
            expect(() => resolvePackageLock(incompatible, [dependency("only", "*")])).toThrow(
                /No version/
            );
        }
    );
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
    const manifests = requireNonempty(
        [manifest(`${id}.facet`, version, manifestCompatibility)],
        "manifests"
    );
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

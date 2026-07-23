import { describe, expect, test } from "vitest";
import { MediaHint } from "../../src/content";
import { ContentRef, Digest, SemVer } from "../../src/core";
import {
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule
} from "../../src/definition";
import { FacetPackageId } from "../../src/facets";

const encoder = new TextEncoder();

describe("PackageCodeManifest", () => {
    test("[definition.package-code-manifest] canonicalizes and round-trips a complete content-addressed closure", () => {
        const main = module("./main.js", "main", ["./dependency.js"]);
        const dependency = module("./dependency.js", "dependency");
        const entrypoint = entry("facet", "./main.js");
        const first = new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: [main, dependency],
            entrypoints: [entrypoint]
        });
        const second = new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: [dependency, main],
            entrypoints: [entrypoint],
            digest: first.digest
        });

        expect(PackageCodeManifest.encode(first)).toEqual(PackageCodeManifest.encode(second));
        expect(first.digest.equals(second.digest)).toBe(true);
        expect(first.modules.map((value) => value.specifier)).toEqual([
            "./dependency.js",
            "./main.js"
        ]);
        expect(
            PackageCodeManifest.encode(
                PackageCodeManifest.decode(PackageCodeManifest.encode(first))
            )
        ).toEqual(PackageCodeManifest.encode(first));
    });

    test("rejects missing imports entrypoints orphan modules and forged digests", () => {
        const entrypoint = entry("facet", "./main.js");
        expect(
            () =>
                new PackageCodeManifest({
                    compatibilityDate: "2026-07-10",
                    modules: [module("./main.js", "main", ["./missing.js"])],
                    entrypoints: [entrypoint]
                })
        ).toThrow(/imports missing module/);
        expect(
            () =>
                new PackageCodeManifest({
                    compatibilityDate: "2026-07-10",
                    modules: [module("./main.js", "main"), module("./orphan.js", "orphan")],
                    entrypoints: [entrypoint]
                })
        ).toThrow(/outside its entrypoint closure/);
        expect(
            () =>
                new PackageCodeManifest({
                    compatibilityDate: "2026-07-10",
                    modules: [module("./main.js", "main")],
                    entrypoints: [entry("facet", "./missing.js")]
                })
        ).toThrow(/entrypoint references missing/);
        expect(
            () =>
                new PackageCodeManifest({
                    compatibilityDate: "2026-07-10",
                    modules: [module("./main.js", "main")],
                    entrypoints: [entrypoint],
                    digest: digest("forged")
                })
        ).toThrow(/code digest/);
        expect(
            () =>
                new PackageCodeManifest({
                    compatibilityDate: "2026-07-10",
                    modules: [module("./main.js", "main")],
                    entrypoints: [] as never
                })
        ).toThrow(/requires modules and entrypoints/);
    });

    test("rejects duplicate identities and noncanonical module syntax", () => {
        const main = module("./main.js", "main");
        const entrypoint = entry("facet", "./main.js");
        expect(
            () =>
                new PackageCodeManifest({
                    compatibilityDate: "2026-07-10",
                    modules: [main, main],
                    entrypoints: [entrypoint]
                })
        ).toThrow(/module specifiers must be unique/);
        expect(
            () =>
                new PackageCodeManifest({
                    compatibilityDate: "2026-07-10",
                    modules: [main],
                    entrypoints: [entrypoint, entrypoint]
                })
        ).toThrow(/entrypoints must be unique/);
        expect(() => module(" padded ", "main")).toThrow(/canonical/);
        expect(
            () =>
                new PackageCodeEntrypoint({
                    facet: new FacetPackageId("facet"),
                    version: new SemVer("1.0.0"),
                    module: "./main.js",
                    exportName: "not-valid-name!"
                })
        ).toThrow(/JavaScript identifier/);
        expect(
            () =>
                new PackageCodeModule({
                    specifier: "./main.js",
                    content: ContentRef.fromDigest(digest("main")),
                    media: new MediaHint("application/javascript"),
                    imports: ["./same.js", "./same.js"]
                })
        ).toThrow(/imports must be unique/);
        expect(
            () =>
                new PackageCodeModule({
                    specifier: "./main.js",
                    content: ContentRef.fromDigest(digest("main")),
                    media: new MediaHint("Application/Javascript")
                })
        ).toThrow(/canonical media type/);
        expect(
            () =>
                new PackageCodeManifest({
                    compatibilityDate: "2026-02-30",
                    modules: [main],
                    entrypoints: [entrypoint]
                })
        ).toThrow(/valid calendar date/);
    });

    test("binds media and compatibility date into the derived code digest", () => {
        const main = module("./main.js", "main");
        const entrypoint = entry("facet", "./main.js");
        const baseline = new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: [main],
            entrypoints: [entrypoint]
        });
        const changedMedia = new PackageCodeManifest({
            compatibilityDate: baseline.compatibilityDate,
            modules: [
                new PackageCodeModule({
                    specifier: main.specifier,
                    content: main.content,
                    media: new MediaHint("application/wasm")
                })
            ],
            entrypoints: [entrypoint]
        });
        const changedDate = new PackageCodeManifest({
            compatibilityDate: "2026-07-11",
            modules: [main],
            entrypoints: [entrypoint]
        });

        expect(changedMedia.digest.equals(baseline.digest)).toBe(false);
        expect(changedDate.digest.equals(baseline.digest)).toBe(false);
    });

    test("strictly decodes constituent data and supports exact module lookup", () => {
        const manifest = new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: [module("./main.js", "main")],
            entrypoints: [entry("facet", "./main.js")]
        });
        expect(manifest.module("./main.js")?.content.value).toBe(
            module("./main.js", "main").content.value
        );
        expect(manifest.module("./missing.js")).toBeUndefined();
        expect(() => PackageCodeManifest.fromData(null)).toThrow(/object/);
        expect(() =>
            PackageCodeManifest.fromData({
                ...(manifest.toData() as object),
                unknown: true
            })
        ).toThrow(/missing or unknown/);
        expect(() =>
            PackageCodeManifest.fromData({ ...(manifest.toData() as object), modules: [] })
        ).toThrow(/requires modules/);
        expect(() => PackageCodeModule.fromData(null)).toThrow(/object/);
        expect(() =>
            PackageCodeModule.fromData({
                specifier: "./main.js",
                content: 7,
                media: "application/javascript",
                imports: []
            })
        ).toThrow(/must be a string/);
        expect(() =>
            PackageCodeModule.fromData({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digest("main")).value,
                media: "application/javascript",
                imports: "bad"
            })
        ).toThrow(/array/);
        expect(() =>
            PackageCodeEntrypoint.fromData({
                facet: "facet",
                version: "1.0.0",
                module: "./main.js"
            } as never)
        ).toThrow(/missing or unknown/);
        expect(() =>
            PackageCodeEntrypoint.fromData({
                facet: "facet",
                version: "1.0.0",
                module: "./main.js",
                exportName: 7
            })
        ).toThrow(/must be a string/);
        const cyclic = new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: [module("./a.js", "a", ["./b.js"]), module("./b.js", "b", ["./a.js"])],
            entrypoints: [entry("cycle", "./a.js")]
        });
        expect(cyclic.modules).toHaveLength(2);
    });

    test("derives one pinned content digest for the canonical golden closure", { tags: "p1" }, () => {
        const manifest = new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: [
                new PackageCodeModule({
                    specifier: "./main.js",
                    content: ContentRef.fromDigest(digest("golden-module")),
                    media: new MediaHint("application/javascript")
                })
            ],
            entrypoints: [
                new PackageCodeEntrypoint({
                    facet: new FacetPackageId("golden.facet"),
                    version: new SemVer("1.0.0"),
                    module: "./main.js"
                })
            ]
        });
        expect(manifest.digest.value).toBe(
            "9344545257f4bdc258674206733f9b953ec79f524027f182938b128ba98d9882"
        );
    });

    test("sorts module imports and names nonblank specifier subjects", { tags: "p1" }, () => {
        const sorted = new PackageCodeModule({
            specifier: "./main.js",
            content: ContentRef.fromDigest(digest("main")),
            media: new MediaHint("application/javascript"),
            imports: ["./z.js", "./a.js"]
        });
        expect(sorted.imports).toEqual(["./a.js", "./z.js"]);
        expect(() => module("", "main")).toThrow(
            /Code module specifier must be a nonblank canonical string/
        );
        expect(() => module("./main.js", "main", [" x"])).toThrow(
            /Code module import must be a nonblank canonical string/
        );
        expect(
            () =>
                new PackageCodeEntrypoint({
                    facet: new FacetPackageId("facet"),
                    version: new SemVer("1.0.0"),
                    module: ""
                })
        ).toThrow(/Code entrypoint module must be a nonblank canonical string/);
        const named = new PackageCodeEntrypoint({
            facet: new FacetPackageId("facet"),
            version: new SemVer("1.0.0"),
            module: "./main.js",
            exportName: "run2"
        });
        expect(named.exportName).toBe("run2");
        expect(
            () =>
                new PackageCodeEntrypoint({
                    facet: new FacetPackageId("facet"),
                    version: new SemVer("1.0.0"),
                    module: "./main.js",
                    exportName: "1abc"
                })
        ).toThrow(/JavaScript identifier/);
    });

    test("rejects noncanonical media hints in every malformed shape", { tags: "p1" }, () => {
        const build = (media: MediaHint): PackageCodeModule =>
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digest("main")),
                media
            });
        expect(() => build(new MediaHint("@application/javascript"))).toThrow(
            /canonical media type without parameters/
        );
        expect(() => build(new MediaHint("application/javascript@@@"))).toThrow(
            /canonical media type without parameters/
        );
        expect(() => build(new MediaHint("application/javascript; charset=utf-8"))).toThrow(
            /canonical media type without parameters/
        );
        expect(() => build(null as never)).toThrow(/Code module media must be a MediaHint/);
        expect(() => build({ mediaType: 7 } as never)).toThrow(
            /Code module media must be a MediaHint/
        );
        expect(() =>
            build(Object.assign(() => undefined, { mediaType: "text/plain" }) as never)
        ).toThrow(/Code module media must be a MediaHint/);
    });

    test("anchors and bounds the compatibility calendar date", { tags: "p1" }, () => {
        const build = (compatibilityDate: string): PackageCodeManifest =>
            new PackageCodeManifest({
                compatibilityDate,
                modules: [module("./main.js", "main")],
                entrypoints: [entry("facet", "./main.js")]
            });
        for (const malformed of ["x2026-07-10", "2026-07-10x", "not-a-date"]) {
            expect(() => build(malformed)).toThrow(
                /Package code compatibility date must be YYYY-MM-DD/
            );
        }
        for (const impossible of ["2026-13-01", "2026-00-10", "2026-04-31", "0000-01-01"]) {
            expect(() => build(impossible)).toThrow(/valid calendar date/);
        }
        expect(
            () =>
                new PackageCodeManifest({
                    compatibilityDate: "2026-07-10",
                    modules: [] as never,
                    entrypoints: [entry("facet", "./main.js")]
                })
        ).toThrow(/requires modules and entrypoints/);
    });

    test("names each decoded field subject and rejects nonobject payloads", { tags: "p2" }, () => {
        const validModule = {
            content: ContentRef.fromDigest(digest("main")).value,
            imports: [],
            media: "application/javascript",
            specifier: "./main.js"
        };
        expect(() => PackageCodeModule.fromData({ ...validModule, specifier: 7 })).toThrow(
            /Code module specifier must be a string/
        );
        expect(() => PackageCodeModule.fromData({ ...validModule, content: 7 })).toThrow(
            /Code module content must be a string/
        );
        expect(() => PackageCodeModule.fromData({ ...validModule, media: 7 })).toThrow(
            /Code module media must be a string/
        );
        expect(() => PackageCodeModule.fromData([])).toThrow(/Code module must be an object/);
        expect(() => PackageCodeModule.fromData("text")).toThrow(/Code module must be an object/);
        expect(() => PackageCodeModule.fromData(null)).toThrow(/Code module must be an object/);

        const validEntrypoint = {
            exportName: "default",
            facet: "facet",
            module: "./main.js",
            version: "1.0.0"
        };
        expect(() => PackageCodeEntrypoint.fromData({ ...validEntrypoint, facet: 7 })).toThrow(
            /Code entrypoint Facet must be a string/
        );
        expect(() => PackageCodeEntrypoint.fromData({ ...validEntrypoint, version: 7 })).toThrow(
            /Code entrypoint version must be a string/
        );
        expect(() => PackageCodeEntrypoint.fromData({ ...validEntrypoint, module: 7 })).toThrow(
            /Code entrypoint module must be a string/
        );
        expect(() =>
            PackageCodeEntrypoint.fromData({ ...validEntrypoint, exportName: 7 })
        ).toThrow(/Code entrypoint export must be a string/);

        const manifest = new PackageCodeManifest({
            compatibilityDate: "2026-07-10",
            modules: [module("./main.js", "main")],
            entrypoints: [entry("facet", "./main.js")]
        });
        expect(() =>
            PackageCodeManifest.fromData({ ...(manifest.toData() as object), digest: 7 })
        ).toThrow(/Package code digest must be a string/);
    });
});

function module(
    specifier: string,
    content: string,
    imports: readonly string[] = []
): PackageCodeModule {
    return new PackageCodeModule({
        specifier,
        content: ContentRef.fromDigest(digest(content)),
        media: new MediaHint("application/javascript"),
        imports
    });
}

function entry(facet: string, target: string): PackageCodeEntrypoint {
    return new PackageCodeEntrypoint({
        facet: new FacetPackageId(facet),
        version: new SemVer("1.0.0"),
        module: target
    });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

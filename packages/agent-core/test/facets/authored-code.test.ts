import { describe, expect, test } from "vitest";
import { ContentRef, Digest } from "../../src/core";
import { AuthoredCodeSource, isFacetDataMap, type FacetDataMap } from "../../src/facets";

describe("Agent-authored code source", () => {
    test("carries its modules in canonical name order", { tags: "p1" }, () => {
        const source = new AuthoredCodeSource(
            "main.js",
            new Map([
                ["zeta.js", contentRef("zeta")],
                ["main.js", contentRef("main")],
                ["alpha.js", contentRef("alpha")]
            ])
        );

        expect([...source.modules.keys()]).toEqual(["alpha.js", "main.js", "zeta.js"]);
        expect(Object.keys(requireModules(source))).toEqual(["alpha.js", "main.js", "zeta.js"]);
    });

    test("names the empty module set apart from an unresolvable entry", { tags: "p1" }, () => {
        expect(() => new AuthoredCodeSource("main.js", new Map())).toThrow(
            "Agent-authored code must carry at least one module"
        );
        expect(
            () => new AuthoredCodeSource("main.js", new Map([["other.js", contentRef("other")]]))
        ).toThrow("Agent-authored code entry must name one of its own modules");
    });

    test("rejects blank and noncanonical module names", { tags: "p1" }, () => {
        const message = "Agent-authored code module names must be nonblank and canonical";
        expect(
            () =>
                new AuthoredCodeSource(
                    "main.js",
                    new Map([
                        ["main.js", contentRef("main")],
                        ["", contentRef("blank")]
                    ])
                )
        ).toThrow(message);
        expect(
            () =>
                new AuthoredCodeSource(
                    "main.js",
                    new Map([
                        ["main.js", contentRef("main")],
                        [" leading.js", contentRef("leading")]
                    ])
                )
        ).toThrow(message);
        expect(
            () =>
                new AuthoredCodeSource(
                    "main.js",
                    new Map([
                        ["main.js", contentRef("main")],
                        ["trailing.js ", contentRef("trailing")]
                    ])
                )
        ).toThrow(message);
    });

    test("rejects modules that are not content-addressed", { tags: "p1" }, () => {
        expect(
            () =>
                new AuthoredCodeSource(
                    "main.js",
                    // The map is typed, so only an untyped caller reaches this guard —
                    // which is the caller it exists for.
                    new Map([["main.js", contentRef("main").value as unknown as ContentRef]])
                )
        ).toThrow("Agent-authored code modules must be content-addressed");
    });

    test(
        "names the offending field when decoded source is not string-shaped",
        { tags: "p1" },
        () => {
            expect(() =>
                AuthoredCodeSource.fromData({
                    entry: 7,
                    modules: { "main.js": contentRef("main").value }
                })
            ).toThrow("Agent-authored code entry must be a string");
            expect(() =>
                AuthoredCodeSource.fromData({ entry: "main.js", modules: { "main.js": 7 } })
            ).toThrow("Agent-authored code module main.js must be a string");
        }
    );
});

function requireModules(source: AuthoredCodeSource): FacetDataMap {
    const data = source.toData();
    if (!isFacetDataMap(data) || !isFacetDataMap(data["modules"])) {
        throw new TypeError("Agent-authored code source data must carry a module object");
    }
    return data["modules"];
}

function contentRef(text: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(text)));
}

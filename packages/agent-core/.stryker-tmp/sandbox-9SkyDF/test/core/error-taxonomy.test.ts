// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
    anchorKey,
    constructionKey,
    duplicateKeys,
    scanSource,
    siteKey,
    type ErrorTaxonomy,
    type TypeErrorClassification
} from "./w1-scanner";

const taxonomyUrl = new URL(
    "../../artifacts/integration/request-archive/W1/error-taxonomy.json",
    import.meta.url
);
const packageUrl = new URL("../../", import.meta.url);
const coverage = readFileSync(
    new URL("../../artifacts/integration/request-archive/W1/coverage.md", import.meta.url),
    "utf8"
);
const coverageInventory = [...coverage.matchAll(/^src\/[^\n]+\.ts$/gm)].map((match) => match[0]);
const taxonomy = JSON.parse(readFileSync(taxonomyUrl, "utf8")) as ErrorTaxonomy;

const classifications = new Set<TypeErrorClassification>([
    "constructor-shape",
    "codec-input-shape",
    "programmer-contract"
]);

describe("W1 error taxonomy", { timeout: 30_000 }, () => {
    test("classifies every remaining TypeError construction exactly once", () => {
        expect(taxonomy.schemaVersion).toBe("agent-core.error-taxonomy/v3");
        expect(taxonomy.sources).toEqual(coverageInventory);
        expect(new Set(taxonomy.sources).size).toBe(taxonomy.sources.length);
        expect(taxonomy.sources.every((source) => existsSync(new URL(source, packageUrl)))).toBe(
            true
        );

        const scans = taxonomy.sources.map((source) =>
            scanSource(source, readFileSync(new URL(source, packageUrl), "utf8"))
        );
        const actual = scans.flatMap((scan) => scan.typeErrors);
        const classified = taxonomy.entries.map((entry) => ({
            source: entry.source,
            sourceAnchor: entry.sourceAnchor
        }));
        const actualSites = actual.map(({ file, line }) => ({ file, line }));
        const classifiedSites = taxonomy.entries.map(({ file, line }) => ({ file, line }));
        const duplicateLiveSites = duplicateKeys(actualSites.map(siteKey));

        expect(scans.flatMap((scan) => scan.unresolved)).toEqual([]);
        expect(new Set(taxonomy.entries.map((entry) => entry.id)).size).toBe(
            taxonomy.entries.length
        );
        expect(duplicateLiveSites, "multiple live TypeError sites share one source line").toEqual(
            []
        );
        expect(
            taxonomy.entries.every((entry) => entry.file !== undefined && entry.line !== undefined)
        ).toBe(true);
        expect(
            taxonomy.entries.every(
                (entry) =>
                    entry.file === entry.source && Number.isInteger(entry.line) && entry.line > 0
            )
        ).toBe(true);
        expect(new Set(classifiedSites.map(siteKey)).size).toBe(classifiedSites.length);
        expect(classifiedSites.map(siteKey).sort()).toEqual(actualSites.map(siteKey).sort());
        expect(new Set(classified.map(anchorKey)).size).toBe(classified.length);
        expect(classified.map(anchorKey).sort()).toEqual(actual.map(anchorKey).sort());
        expect(taxonomy.entries.map(constructionKey).sort()).toEqual(
            actual.map(constructionKey).sort()
        );
        expect(taxonomy.entries.every((entry) => taxonomy.sources.includes(entry.source))).toBe(
            true
        );
        expect(taxonomy.entries.every((entry) => classifications.has(entry.classification))).toBe(
            true
        );
        expect(taxonomy.entries.every((entry) => entry.rationale.trim().length > 0)).toBe(true);
        expect(taxonomy.entries.every((entry) => entry.testedBy.length > 0)).toBe(true);
        expect(
            taxonomy.entries
                .flatMap((entry) => entry.testedBy)
                .every((path) => existsSync(new URL(path, packageUrl)))
        ).toBe(true);
        expect(Object.keys(taxonomy.testCases).sort()).toEqual(
            [...new Set(taxonomy.entries.map((entry) => entry.source))].sort()
        );
        expect(Object.values(taxonomy.testCases).every((references) => references.length > 0)).toBe(
            true
        );
        expect(Object.values(taxonomy.testCases).flat().every(testCaseExists)).toBe(true);
        expect(
            Object.entries(taxonomy.testCases).every(([source, references]) => {
                const testedPaths = new Set(
                    taxonomy.entries
                        .filter((entry) => entry.source === source)
                        .flatMap((entry) => entry.testedBy)
                );
                return references.every((reference) =>
                    testedPaths.has(splitTestCase(reference).path)
                );
            })
        ).toBe(true);
    });

    test("contains no bare or unresolved Error construction in W1 runtime sources", () => {
        const scans = taxonomy.sources.map((source) =>
            scanSource(source, readFileSync(new URL(source, packageUrl), "utf8"))
        );
        expect(scans.flatMap((scan) => scan.bareErrors)).toEqual([]);
        expect(scans.flatMap((scan) => scan.unresolved)).toEqual([]);
    });

    test.each<readonly [string, string, number, number]>([
        ["direct new", "return new TypeError('direct')", 1, 0],
        ["direct calls", "TypeError('typed'); Error('bare')", 1, 1],
        [
            "globalThis properties",
            "new globalThis.TypeError('typed'); globalThis.Error('bare')",
            1,
            1
        ],
        [
            "computed globalThis properties",
            "globalThis['TypeError']('typed'); new globalThis[`Error`]('bare')",
            1,
            1
        ],
        ["aliases", "const Typed = TypeError; const Bare = Error; Typed(); new Bare()", 1, 1],
        [
            "conditional aliases",
            "const Failure = choose ? TypeError : Error; Failure('conditional')",
            1,
            1
        ],
        [
            "call and apply",
            "TypeError.call(undefined, 'typed'); Error.apply(undefined, ['bare'])",
            1,
            1
        ],
        [
            "computed call and apply",
            "TypeError['call'](undefined, 'typed'); Error[`apply`](undefined, ['bare'])",
            1,
            1
        ],
        [
            "aliased call and apply",
            "const Typed = globalThis.TypeError; const Bare = globalThis.Error; " +
                "Typed.apply(undefined, ['typed']); Bare.call(undefined, 'bare')",
            1,
            1
        ],
        [
            "Reflect.construct",
            "Reflect.construct(TypeError, ['typed']); " +
                "Reflect.construct(globalThis['Error'], ['bare'])",
            1,
            1
        ],
        [
            "computed Reflect construct",
            "Reflect['construct'](TypeError, ['typed']); " +
                "Reflect[`construct`](globalThis.Error, ['bare'])",
            1,
            1
        ],
        [
            "returned and factory errors",
            "function typed() { return TypeError('typed'); } " +
                "const bare = () => { return new Error('bare'); }",
            1,
            1
        ],
        [
            "destructured aliases",
            "const { TypeError: Typed, Error: Bare } = globalThis; Typed(); Bare()",
            1,
            1
        ]
    ])("detects %s", (_name, source, typeErrors, bareErrors) => {
        const scan = scanSource("fixture.ts", source);
        expect(scan.typeErrors).toHaveLength(typeErrors);
        expect(scan.bareErrors).toHaveLength(bareErrors);
        expect(scan.unresolved).toEqual([]);
    });

    test.each([
        "globalThis[name]('dynamic')",
        "const DynamicError = globalThis[name]; new DynamicError('dynamic')",
        "Reflect.construct(globalThis[name], ['dynamic'])"
    ])("rejects unresolved dynamic error constructor form: %s", (source) => {
        const scan = scanSource("fixture.ts", source);
        expect(scan.unresolved).toHaveLength(1);
    });

    test("intentionally ignores shadowed local error and host identifiers", () => {
        const scan = scanSource(
            "fixture.ts",
            `
            function local(
                TypeError: (message: string) => unknown,
                Error: new (message: string) => unknown
            ) {
                TypeError("local");
                return new Error("local");
            }
            {
                const globalThis = { TypeError: () => undefined, Error: () => undefined };
                globalThis.TypeError();
                globalThis["Error"]();
            }
            {
                const Reflect = { construct: () => undefined };
                Reflect.construct(TypeError, []);
            }
            {
                const TypeError = () => undefined;
                const Alias = condition ? TypeError : TypeError;
                Alias();
            }
        `
        );
        expect(scan.typeErrors).toEqual([]);
        expect(scan.bareErrors).toEqual([]);
        expect(scan.unresolved).toEqual([]);
    });

    test("keeps for and switch lexical error bindings inside their scopes", () => {
        const scan = scanSource(
            "fixture.ts",
            `
            for (const TypeError of []) {
                TypeError("local");
            }
            TypeError("global typed");
            switch (value) {
                case 1: {
                    const Error = () => undefined;
                    Error("local");
                    break;
                }
            }
            Error("global bare");
        `
        );
        expect(scan.typeErrors).toHaveLength(1);
        expect(scan.bareErrors).toHaveLength(1);
        expect(scan.unresolved).toEqual([]);
    });
});

const testNames = new Map<string, ReadonlySet<string>>();

function testCaseExists(reference: string): boolean {
    const { path, name } = splitTestCase(reference);
    if (!existsSync(new URL(path, packageUrl))) return false;
    let names = testNames.get(path);
    if (names === undefined) {
        names = declaredTestNames(path);
        testNames.set(path, names);
    }
    return names.has(name);
}

function splitTestCase(reference: string): { readonly path: string; readonly name: string } {
    const separator = reference.indexOf("#");
    return separator < 1
        ? { path: "", name: "" }
        : { path: reference.slice(0, separator), name: reference.slice(separator + 1) };
}

function declaredTestNames(path: string): ReadonlySet<string> {
    const sourceFile = ts.createSourceFile(
        path,
        readFileSync(new URL(path, packageUrl), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    const names = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isTestCall(node)) {
            const name = node.arguments[0];
            if (
                name !== undefined &&
                (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
            )
                names.add(name.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return names;
}

function isTestCall(node: ts.CallExpression): boolean {
    if (ts.isIdentifier(node.expression)) return node.expression.text === "test";
    if (!ts.isCallExpression(node.expression)) return false;
    const each = node.expression.expression;
    return (
        ts.isPropertyAccessExpression(each) &&
        ts.isIdentifier(each.expression) &&
        each.expression.text === "test" &&
        each.name.text === "each"
    );
}

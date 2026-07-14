import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";

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
        expect(taxonomy.schemaVersion).toBe("agent-core.error-taxonomy/v2");
        expect(taxonomy.baseCommit).toBe("058157571e1815840f8c6f7c53ff4e4c26827b54");
        expect(taxonomy.sources).toEqual(coverageInventory);
        expect(new Set(taxonomy.sources).size).toBe(taxonomy.sources.length);
        expect(taxonomy.sources.every((source) => existsSync(new URL(source, packageUrl)))).toBe(
            true
        );

        const scans = taxonomy.sources.map((source) =>
            scanSource(source, readFileSync(new URL(source, packageUrl), "utf8"))
        );
        const actual = scans.flatMap((scan) => scan.typeErrors);
        const baselineScans = taxonomy.sources.map((source) =>
            scanSource(source, sourceAtTaxonomyBase(source))
        );
        const baselineActual = baselineScans.flatMap((scan) => scan.typeErrors);
        const baselineSites = baselineActual.map(({ file, line }) => ({ file, line }));
        const classified = taxonomy.entries.map((entry) => ({
            source: entry.source,
            sourceAnchor: entry.sourceAnchor
        }));
        const actualSites = actual.map(({ file, line }) => ({ file, line }));
        const classifiedSites = taxonomy.entries.map(({ file, line }) => ({ file, line }));
        const duplicateLiveSites = duplicateKeys(actualSites.map(siteKey));

        expect(scans.flatMap((scan) => scan.unresolved)).toEqual([]);
        expect(baselineScans.flatMap((scan) => scan.unresolved)).toEqual([]);
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
        expect(classifiedSites.map(siteKey).sort()).toEqual(baselineSites.map(siteKey).sort());
        expect(new Set(classified.map(anchorKey)).size).toBe(classified.length);
        expect(classified.map(anchorKey).sort()).toEqual(baselineActual.map(anchorKey).sort());
        expect(actual.map(constructionKey).sort()).toEqual(
            baselineActual.map(constructionKey).sort()
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

function sourceAtTaxonomyBase(source: string): string {
    const result = spawnSync(
        "git",
        ["show", `${taxonomy.baseCommit}:packages/agent-core/${source}`],
        { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }
    );
    if (result.status !== 0) {
        throw new TypeError(`Taxonomy baseline source is unavailable: ${source}`);
    }
    return result.stdout;
}

type TypeErrorClassification = "constructor-shape" | "codec-input-shape" | "programmer-contract";

interface SourceAnchor {
    readonly container: string;
    readonly guard: string | null;
    readonly expression: string;
}

interface ErrorTaxonomyEntry {
    readonly id: string;
    readonly file: string;
    readonly line: number;
    readonly source: string;
    readonly sourceAnchor: SourceAnchor;
    readonly classification: TypeErrorClassification;
    readonly rationale: string;
    readonly testedBy: readonly string[];
}

interface ErrorTaxonomy {
    readonly schemaVersion: string;
    readonly baseCommit: string;
    readonly sources: readonly string[];
    readonly testCases: Readonly<Record<string, readonly string[]>>;
    readonly entries: readonly ErrorTaxonomyEntry[];
}

interface ErrorConstruction {
    readonly file: string;
    readonly line: number;
    readonly source: string;
    readonly sourceAnchor: SourceAnchor;
}

interface SourceScan {
    readonly typeErrors: readonly ErrorConstruction[];
    readonly bareErrors: readonly string[];
    readonly unresolved: readonly string[];
}

interface Binding {
    readonly initializer?: ts.Expression;
    readonly destructuredProperty?: string;
}

const TYPE_ERROR = 1;
const BARE_ERROR = 2;
const DYNAMIC_ERROR = 4;

function scanSource(source: string, text: string): SourceScan {
    const sourceFile = ts.createSourceFile(
        source,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    const bindings = collectBindings(sourceFile);
    const typeErrors: ErrorConstruction[] = [];
    const bareErrors: string[] = [];
    const unresolved: string[] = [];

    const record = (node: ts.NewExpression | ts.CallExpression, kinds: number): void => {
        const construction = {
            file: source,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            source,
            sourceAnchor: {
                container: declarationContainer(node, sourceFile),
                guard: nearestGuard(node, sourceFile),
                expression: normalize(node.getText(sourceFile))
            }
        };
        if ((kinds & TYPE_ERROR) !== 0) typeErrors.push(construction);
        if ((kinds & BARE_ERROR) !== 0) {
            bareErrors.push(`${source}: ${construction.sourceAnchor.expression}`);
        }
        if ((kinds & DYNAMIC_ERROR) !== 0) {
            unresolved.push(`${source}: ${construction.sourceAnchor.expression}`);
        }
    };

    const visit = (node: ts.Node): void => {
        if (ts.isNewExpression(node)) {
            record(node, resolveErrorConstructor(node.expression, node, bindings, new Set()));
        } else if (ts.isCallExpression(node)) {
            if (isUnshadowedReflectConstruct(node, bindings)) {
                const target = node.arguments[0];
                if (target !== undefined) {
                    const kinds = resolveErrorConstructor(target, node, bindings, new Set());
                    record(
                        node,
                        kinds === 0 && !isKnownLocalConstructor(target, node, bindings)
                            ? DYNAMIC_ERROR
                            : kinds
                    );
                }
            } else if (isCallOrApply(node.expression)) {
                record(
                    node,
                    resolveErrorConstructor(node.expression.expression, node, bindings, new Set())
                );
            } else {
                record(node, resolveErrorConstructor(node.expression, node, bindings, new Set()));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { typeErrors, bareErrors, unresolved };
}

function collectBindings(
    sourceFile: ts.SourceFile
): ReadonlyMap<ts.Node, ReadonlyMap<string, Binding>> {
    const scopes = new Map<ts.Node, Map<string, Binding>>();
    const scope = (node: ts.Node): Map<string, Binding> => {
        const existing = scopes.get(node);
        if (existing !== undefined) return existing;
        const created = new Map<string, Binding>();
        scopes.set(node, created);
        return created;
    };

    const registerName = (name: ts.BindingName, owner: ts.Node, binding: Binding): void => {
        if (ts.isIdentifier(name)) {
            scope(owner).set(name.text, binding);
            return;
        }
        for (const element of name.elements) {
            if (ts.isOmittedExpression(element)) continue;
            const property = ts.isObjectBindingPattern(name)
                ? bindingPropertyName(element.propertyName ?? element.name)
                : undefined;
            registerName(element.name, owner, {
                ...binding,
                ...(property === undefined ? {} : { destructuredProperty: property })
            });
        }
    };

    const visit = (node: ts.Node): void => {
        if (isScope(node)) scope(node);
        if (ts.isVariableDeclaration(node)) {
            const declarationList = node.parent;
            const blockScoped =
                ts.isVariableDeclarationList(declarationList) &&
                (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
            registerName(
                node.name,
                nearestScope(node.parent, blockScoped ? "lexical" : "function"),
                node.initializer === undefined ? {} : { initializer: node.initializer }
            );
        } else if (ts.isParameter(node)) {
            registerName(node.name, nearestScope(node.parent, "function"), {});
        } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
            scope(nearestScope(node.parent, "lexical")).set(node.name.text, {});
        } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
            scope(nearestScope(node.parent, "lexical")).set(node.name.text, {});
            scope(node).set(node.name.text, {});
        } else if (ts.isFunctionExpression(node) && node.name !== undefined) {
            scope(node).set(node.name.text, {});
        } else if (ts.isImportClause(node)) {
            if (node.name !== undefined) scope(sourceFile).set(node.name.text, {});
            const bindingsNode = node.namedBindings;
            if (bindingsNode !== undefined) {
                if (ts.isNamespaceImport(bindingsNode)) {
                    scope(sourceFile).set(bindingsNode.name.text, {});
                } else {
                    for (const element of bindingsNode.elements) {
                        scope(sourceFile).set(element.name.text, {});
                    }
                }
            }
        } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
            registerName(node.variableDeclaration.name, node, {});
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return scopes;
}

function resolveErrorConstructor(
    candidate: ts.Expression,
    reference: ts.Node,
    bindings: ReadonlyMap<ts.Node, ReadonlyMap<string, Binding>>,
    resolving: Set<Binding>
): number {
    const expression = unwrap(candidate);
    if (ts.isIdentifier(expression)) {
        const binding = lookupBinding(expression.text, reference, bindings);
        if (binding !== undefined) return resolveBinding(binding, bindings, resolving);
        if (expression.text === "TypeError") return TYPE_ERROR;
        if (expression.text === "Error") return BARE_ERROR;
        return 0;
    }
    if (ts.isPropertyAccessExpression(expression)) {
        if (isUnshadowedGlobalThis(expression.expression, reference, bindings)) {
            if (expression.name.text === "TypeError") return TYPE_ERROR;
            if (expression.name.text === "Error") return BARE_ERROR;
        }
        return 0;
    }
    if (
        ts.isElementAccessExpression(expression) &&
        isUnshadowedGlobalThis(expression.expression, reference, bindings)
    ) {
        const property =
            expression.argumentExpression === undefined
                ? undefined
                : staticPropertyName(expression.argumentExpression);
        if (property === "TypeError") return TYPE_ERROR;
        if (property === "Error") return BARE_ERROR;
        return DYNAMIC_ERROR;
    }
    if (ts.isConditionalExpression(expression)) {
        return (
            resolveErrorConstructor(expression.whenTrue, reference, bindings, resolving) |
            resolveErrorConstructor(expression.whenFalse, reference, bindings, resolving)
        );
    }
    if (
        ts.isBinaryExpression(expression) &&
        (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
        return (
            resolveErrorConstructor(expression.left, reference, bindings, resolving) |
            resolveErrorConstructor(expression.right, reference, bindings, resolving)
        );
    }
    return 0;
}

function resolveBinding(
    binding: Binding,
    bindings: ReadonlyMap<ts.Node, ReadonlyMap<string, Binding>>,
    resolving: Set<Binding>
): number {
    if (resolving.has(binding) || binding.initializer === undefined) return 0;
    resolving.add(binding);
    let resolved: number;
    if (
        binding.destructuredProperty !== undefined &&
        isUnshadowedGlobalThis(binding.initializer, binding.initializer, bindings)
    ) {
        resolved =
            binding.destructuredProperty === "TypeError"
                ? TYPE_ERROR
                : binding.destructuredProperty === "Error"
                  ? BARE_ERROR
                  : 0;
    } else {
        resolved = resolveErrorConstructor(
            binding.initializer,
            binding.initializer,
            bindings,
            resolving
        );
    }
    resolving.delete(binding);
    return resolved;
}

function lookupBinding(
    name: string,
    reference: ts.Node,
    bindings: ReadonlyMap<ts.Node, ReadonlyMap<string, Binding>>
): Binding | undefined {
    for (
        let current: ts.Node | undefined = reference;
        current !== undefined;
        current = current.parent
    ) {
        const binding = bindings.get(current)?.get(name);
        if (binding !== undefined) return binding;
    }
    return undefined;
}

function nearestScope(node: ts.Node, kind: "lexical" | "function"): ts.Node {
    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
        if (ts.isSourceFile(current) || ts.isFunctionLike(current)) return current;
        if (kind === "lexical" && isLexicalScope(current)) return current;
    }
    throw new TypeError("Taxonomy scanner declaration has no lexical scope");
}

function isScope(node: ts.Node): boolean {
    return ts.isSourceFile(node) || ts.isFunctionLike(node) || isLexicalScope(node);
}

function isLexicalScope(node: ts.Node): boolean {
    return (
        ts.isBlock(node) ||
        ts.isCatchClause(node) ||
        ts.isClassLike(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isSwitchStatement(node)
    );
}

function unwrap(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function isUnshadowedGlobalThis(
    expression: ts.Expression,
    reference: ts.Node,
    bindings: ReadonlyMap<ts.Node, ReadonlyMap<string, Binding>>
): boolean {
    const value = unwrap(expression);
    return (
        ts.isIdentifier(value) &&
        value.text === "globalThis" &&
        lookupBinding("globalThis", reference, bindings) === undefined
    );
}

function isUnshadowedReflectConstruct(
    node: ts.CallExpression,
    bindings: ReadonlyMap<ts.Node, ReadonlyMap<string, Binding>>
): boolean {
    const expression = node.expression;
    const property = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined
          ? staticPropertyName(expression.argumentExpression)
          : undefined;
    return (
        property === "construct" &&
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "Reflect" &&
        lookupBinding("Reflect", node, bindings) === undefined
    );
}

function isCallOrApply(
    expression: ts.LeftHandSideExpression
): expression is ts.PropertyAccessExpression | ts.ElementAccessExpression {
    const property = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined
          ? staticPropertyName(expression.argumentExpression)
          : undefined;
    return property === "call" || property === "apply";
}

function isKnownLocalConstructor(
    expression: ts.Expression,
    reference: ts.Node,
    bindings: ReadonlyMap<ts.Node, ReadonlyMap<string, Binding>>
): boolean {
    const value = unwrap(expression);
    return ts.isIdentifier(value) && lookupBinding(value.text, reference, bindings) !== undefined;
}

function bindingPropertyName(name: ts.PropertyName | ts.BindingName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    if (ts.isComputedPropertyName(name)) return staticPropertyName(name.expression);
    return undefined;
}

function staticPropertyName(expression: ts.Expression): string | undefined {
    const value = unwrap(expression);
    return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
        ? value.text
        : undefined;
}

function declarationContainer(node: ts.Node, sourceFile: ts.SourceFile): string {
    for (let current = node.parent; current !== undefined; current = current.parent) {
        if (ts.isConstructorDeclaration(current) && ts.isClassLike(current.parent)) {
            return `${className(current.parent, sourceFile)}.constructor`;
        }
        if (
            (ts.isMethodDeclaration(current) ||
                ts.isGetAccessorDeclaration(current) ||
                ts.isSetAccessorDeclaration(current)) &&
            ts.isClassLike(current.parent)
        ) {
            return `${className(current.parent, sourceFile)}.${current.name.getText(sourceFile)}`;
        }
        if (ts.isFunctionDeclaration(current)) {
            return current.name?.getText(sourceFile) ?? "<anonymous>";
        }
    }
    return "<module>";
}

function className(node: ts.ClassLikeDeclaration, sourceFile: ts.SourceFile): string {
    return node.name?.getText(sourceFile) ?? "<anonymous>";
}

function nearestGuard(node: ts.Node, sourceFile: ts.SourceFile): string | null {
    for (let current = node.parent; current !== undefined; current = current.parent) {
        if (ts.isIfStatement(current)) return normalize(current.expression.getText(sourceFile));
    }
    return null;
}

function normalize(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function anchorKey(value: {
    readonly source: string;
    readonly sourceAnchor: SourceAnchor;
}): string {
    return JSON.stringify({ source: value.source, sourceAnchor: value.sourceAnchor });
}

function constructionKey(value: {
    readonly source: string;
    readonly sourceAnchor: SourceAnchor;
}): string {
    return `${value.source}:${value.sourceAnchor.expression.replaceAll(/\s/gu, "")}`;
}

function siteKey(value: { readonly file: string; readonly line: number }): string {
    return `${value.file}:${value.line}`;
}

function duplicateKeys(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates].sort();
}

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

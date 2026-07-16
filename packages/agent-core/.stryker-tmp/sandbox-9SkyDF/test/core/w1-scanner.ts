// @ts-nocheck
// The W1 TypeError-taxonomy scanner: a TypeScript-AST census of every Error/TypeError
// construction in the audited sources. Shared by the conformance test and the
// taxonomy regenerator so the census semantics cannot drift between them.
import ts from "typescript";

export type TypeErrorClassification =
    "constructor-shape" | "codec-input-shape" | "programmer-contract";

export interface SourceAnchor {
    readonly container: string;
    readonly guard: string | null;
    readonly expression: string;
}

export interface ErrorTaxonomyEntry {
    readonly id: string;
    readonly file: string;
    readonly line: number;
    readonly source: string;
    readonly sourceAnchor: SourceAnchor;
    readonly classification: TypeErrorClassification;
    readonly rationale: string;
    readonly testedBy: readonly string[];
}

export interface ErrorTaxonomy {
    readonly schemaVersion: string;
    readonly sources: readonly string[];
    readonly testCases: Readonly<Record<string, readonly string[]>>;
    readonly entries: readonly ErrorTaxonomyEntry[];
}

export interface ErrorConstruction {
    readonly file: string;
    readonly line: number;
    readonly source: string;
    readonly sourceAnchor: SourceAnchor;
}

export interface SourceScan {
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

export function scanSource(source: string, text: string): SourceScan {
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

export function anchorKey(value: {
    readonly source: string;
    readonly sourceAnchor: SourceAnchor;
}): string {
    return JSON.stringify({ source: value.source, sourceAnchor: value.sourceAnchor });
}

export function constructionKey(value: {
    readonly source: string;
    readonly sourceAnchor: SourceAnchor;
}): string {
    return `${value.source}:${value.sourceAnchor.expression.replaceAll(/\s/gu, "")}`;
}

export function siteKey(value: { readonly file: string; readonly line: number }): string {
    return `${value.file}:${value.line}`;
}

export function duplicateKeys(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates].sort();
}

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

export type RootIdentifier = (
    sourceCode: SourceCode,
    identifier: ESTree.IdentifierReference
) => boolean;

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
    let current = expression;
    while (
        current.type === "ParenthesizedExpression" ||
        current.type === "ChainExpression" ||
        current.type === "TSAsExpression" ||
        current.type === "TSSatisfiesExpression" ||
        current.type === "TSTypeAssertion" ||
        current.type === "TSNonNullExpression"
    ) {
        current = current.expression;
    }
    return current;
}

export function resolveVariable(
    sourceCode: SourceCode,
    identifier: ESTree.IdentifierReference
): Variable | null {
    let scope: Scope | null = sourceCode.getScope(identifier);
    while (scope !== null) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) return variable;
        scope = scope.upper;
    }
    return null;
}

function stableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
    if (variable.defs.length !== 1) return null;
    const definition = variable.defs[0];
    if (
        definition?.type !== "Variable" ||
        definition.node.type !== "VariableDeclarator" ||
        definition.node.parent.type !== "VariableDeclaration" ||
        definition.node.parent.kind !== "const" ||
        variable.references.some((reference) => reference.isWrite() && !reference.init)
    ) {
        return null;
    }
    return definition.node;
}

function propertyName(property: ESTree.MemberExpression): string | null {
    if (property.computed) {
        return property.property.type === "Literal" && property.property.value !== null
            ? String(property.property.value)
            : null;
    }
    return property.property.type === "Identifier" ? property.property.name : null;
}

function bindingPropertyName(property: ESTree.BindingProperty): string | null {
    if (property.computed) return null;
    if (property.key.type === "Identifier") return property.key.name;
    return property.key.type === "Literal" && property.key.value !== null
        ? String(property.key.value)
        : null;
}

function bindingPropertyForVariable(
    pattern: ESTree.ObjectPattern,
    variable: Variable
): ESTree.BindingProperty | null {
    for (const property of pattern.properties) {
        if (
            property.type === "Property" &&
            property.value.type === "Identifier" &&
            property.value.name === variable.name
        ) {
            return property;
        }
    }
    return null;
}

function objectComesFromRoot(
    sourceCode: SourceCode,
    expression: ESTree.Expression,
    isRoot: RootIdentifier,
    visited: ReadonlySet<Variable>
): boolean {
    const unwrapped = unwrapExpression(expression);
    if (unwrapped.type !== "Identifier") return false;
    if (isRoot(sourceCode, unwrapped)) return true;
    const variable = resolveVariable(sourceCode, unwrapped);
    if (variable === null || visited.has(variable)) return false;
    const declarator = stableDeclarator(variable);
    if (declarator === null || declarator.id.type !== "Identifier" || declarator.init === null) {
        return false;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(variable);
    return objectComesFromRoot(sourceCode, declarator.init, isRoot, nextVisited);
}

function destructuredMethod(
    sourceCode: SourceCode,
    variable: Variable,
    declarator: ESTree.VariableDeclarator,
    methodNames: ReadonlySet<string>,
    isRoot: RootIdentifier,
    visited: ReadonlySet<Variable>
): boolean {
    if (declarator.id.type !== "ObjectPattern" || declarator.init === null) return false;
    const property = bindingPropertyForVariable(declarator.id, variable);
    if (property === null) return false;
    const name = bindingPropertyName(property);
    return (
        name !== null &&
        methodNames.has(name) &&
        objectComesFromRoot(sourceCode, declarator.init, isRoot, visited)
    );
}

function expressionComesFromMethod(
    sourceCode: SourceCode,
    expression: ESTree.Expression,
    methodNames: ReadonlySet<string>,
    isRoot: RootIdentifier,
    visited: ReadonlySet<Variable>
): boolean {
    const unwrapped = unwrapExpression(expression);
    if (unwrapped.type === "MemberExpression") {
        const name = propertyName(unwrapped);
        return (
            name !== null &&
            methodNames.has(name) &&
            objectComesFromRoot(sourceCode, unwrapped.object, isRoot, visited)
        );
    }
    if (
        unwrapped.type === "CallExpression" &&
        unwrapped.callee.type === "MemberExpression" &&
        propertyName(unwrapped.callee) === "bind"
    ) {
        return expressionComesFromMethod(
            sourceCode,
            unwrapped.callee.object,
            methodNames,
            isRoot,
            visited
        );
    }
    if (unwrapped.type !== "Identifier") return false;
    const variable = resolveVariable(sourceCode, unwrapped);
    if (variable === null || visited.has(variable)) return false;
    const declarator = stableDeclarator(variable);
    if (declarator === null) return false;
    const nextVisited = new Set(visited);
    nextVisited.add(variable);
    if (destructuredMethod(sourceCode, variable, declarator, methodNames, isRoot, nextVisited)) {
        return true;
    }
    return (
        declarator.id.type === "Identifier" &&
        declarator.init !== null &&
        expressionComesFromMethod(sourceCode, declarator.init, methodNames, isRoot, nextVisited)
    );
}

export function isCallOfRootMethod(
    sourceCode: SourceCode,
    callee: ESTree.Expression,
    methodNames: ReadonlySet<string>,
    isRoot: RootIdentifier
): boolean {
    return expressionComesFromMethod(sourceCode, callee, methodNames, isRoot, new Set());
}

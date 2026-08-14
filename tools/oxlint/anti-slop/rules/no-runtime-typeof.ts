import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

type FunctionWithBody = ESTree.ArrowFunctionExpression | ESTree.Function;

function enclosingFunction(node: ESTree.Node): FunctionWithBody | null {
    let current: ESTree.Node | null = node.parent;
    while (current !== null && current.type !== "Program") {
        if (
            current.type === "ArrowFunctionExpression" ||
            current.type === "FunctionDeclaration" ||
            current.type === "FunctionExpression"
        ) {
            return current;
        }
        current = current.parent;
    }
    return null;
}

function predicateParameterName(node: ESTree.Node): string | null {
    const predicate = enclosingFunction(node)?.returnType?.typeAnnotation;
    return predicate?.type === "TSTypePredicate" && predicate.parameterName.type === "Identifier"
        ? predicate.parameterName.name
        : null;
}

function rootIdentifierName(expression: ESTree.Expression): string | null {
    let current = expression;
    while (true) {
        if (current.type === "Identifier") return current.name;
        if (
            current.type === "ParenthesizedExpression" ||
            current.type === "ChainExpression" ||
            current.type === "TSAsExpression" ||
            current.type === "TSSatisfiesExpression" ||
            current.type === "TSTypeAssertion" ||
            current.type === "TSNonNullExpression"
        ) {
            current = current.expression;
            continue;
        }
        if (current.type === "MemberExpression") {
            current = current.object;
            continue;
        }
        return null;
    }
}

function establishesTypeEvidence(node: ESTree.UnaryExpression): boolean {
    const parameter = predicateParameterName(node);
    return parameter !== null && rootIdentifierName(node.argument) === parameter;
}

function participatesInBranch(node: ESTree.Node): boolean {
    let current = node;
    while (true) {
        const parent = current.parent;
        if (parent === null) return false;
        if (
            parent.type === "ParenthesizedExpression" ||
            parent.type === "BinaryExpression" ||
            parent.type === "UnaryExpression" ||
            parent.type === "TSAsExpression" ||
            parent.type === "TSSatisfiesExpression" ||
            parent.type === "TSTypeAssertion"
        ) {
            current = parent;
            continue;
        }
        if (parent.type === "LogicalExpression") return true;
        return (
            (parent.type === "IfStatement" && parent.test === current) ||
            (parent.type === "ConditionalExpression" && parent.test === current) ||
            (parent.type === "WhileStatement" && parent.test === current) ||
            (parent.type === "DoWhileStatement" && parent.test === current) ||
            (parent.type === "ForStatement" && parent.test === current) ||
            (parent.type === "SwitchStatement" && parent.discriminant === current)
        );
    }
}

function variableForDeclarator(
    sourceCode: SourceCode,
    declarator: ESTree.VariableDeclarator
): Variable | null {
    for (const scope of sourceCode.scopeManager.scopes) {
        for (const variable of scope.variables) {
            if (
                variable.defs.some(
                    (definition) => definition.type === "Variable" && definition.node === declarator
                )
            ) {
                return variable;
            }
        }
    }
    return null;
}

function containingConstVariable(sourceCode: SourceCode, node: ESTree.Node): Variable | null {
    let current = node;
    while (true) {
        const parent = current.parent;
        if (parent === null) return null;
        if (
            parent.type === "ParenthesizedExpression" ||
            parent.type === "BinaryExpression" ||
            parent.type === "LogicalExpression" ||
            parent.type === "ConditionalExpression" ||
            parent.type === "UnaryExpression" ||
            parent.type === "TSAsExpression" ||
            parent.type === "TSSatisfiesExpression" ||
            parent.type === "TSTypeAssertion" ||
            parent.type === "TSNonNullExpression"
        ) {
            current = parent;
            continue;
        }
        if (
            parent.type !== "VariableDeclarator" ||
            parent.init !== current ||
            parent.id.type !== "Identifier" ||
            parent.parent.type !== "VariableDeclaration" ||
            parent.parent.kind !== "const"
        ) {
            return null;
        }
        return variableForDeclarator(sourceCode, parent);
    }
}

function reachesBranch(
    sourceCode: SourceCode,
    node: ESTree.Node,
    visited: ReadonlySet<Variable> = new Set()
): boolean {
    if (participatesInBranch(node)) return true;
    const variable = containingConstVariable(sourceCode, node);
    if (variable === null || visited.has(variable)) return false;
    const nextVisited = new Set(visited);
    nextVisited.add(variable);
    return variable.references.some(
        (reference) =>
            reference.isRead() &&
            !reference.init &&
            reachesBranch(sourceCode, reference.identifier, nextVisited)
    );
}

/** Disallow ad hoc typeof branches that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Disallow ad hoc typeof branches; type predicates may establish evidence at an I/O boundary."
        },
        messages: {
            runtimeTypeof:
                "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value."
        }
    },
    create(context) {
        return {
            UnaryExpression(node) {
                if (
                    node.operator === "typeof" &&
                    reachesBranch(context.sourceCode, node) &&
                    !establishesTypeEvidence(node)
                ) {
                    context.report({ node, messageId: "runtimeTypeof" });
                }
            }
        };
    }
});

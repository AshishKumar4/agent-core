import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

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

function establishesTypeEvidence(node: ESTree.Node): boolean {
    return enclosingFunction(node)?.returnType?.typeAnnotation.type === "TSTypePredicate";
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
                    participatesInBranch(node) &&
                    !establishesTypeEvidence(node)
                ) {
                    context.report({ node, messageId: "runtimeTypeof" });
                }
            }
        };
    }
});

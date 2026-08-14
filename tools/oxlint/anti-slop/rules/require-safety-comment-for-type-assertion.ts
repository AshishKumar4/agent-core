import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;
type SafetyComment = "missing" | "placeholder" | "specific";

const commentOwnerKinds = new Set([
    "ExpressionStatement",
    "PropertyDefinition",
    "ReturnStatement",
    "ThrowStatement",
    "VariableDeclaration"
]);

function isConstAssertion(node: TypeAssertion): boolean {
    return (
        node.typeAnnotation.type === "TSTypeReference" &&
        node.typeAnnotation.typeName.type === "Identifier" &&
        node.typeAnnotation.typeName.name === "const"
    );
}

function classifySafetyComment(comment: string): SafetyComment {
    const match = /\bSAFETY\s*:\s*(.*)/isu.exec(comment);
    if (match === null) return "missing";
    const reason = match[1]?.trim() ?? "";
    return reason.length === 0 ||
        /^(?:as above|same invariant|same reason|see above)\.?$/iu.test(reason)
        ? "placeholder"
        : "specific";
}

function safetyComment(sourceCode: SourceCode, node: TypeAssertion): SafetyComment {
    let current: ESTree.Node = node;
    while (true) {
        const comments = sourceCode.getCommentsBefore(current);
        for (let index = comments.length - 1; index >= 0; index -= 1) {
            const comment = comments[index];
            if (comment === undefined || comment.end > node.start) continue;
            const classification = classifySafetyComment(comment.value);
            if (classification !== "missing") return classification;
        }
        if (commentOwnerKinds.has(current.type) || current.parent.type === "Program")
            return "missing";
        current = current.parent;
    }
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions."
        },
        messages: {
            missingSafetyComment:
                "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
            placeholderSafetyComment:
                "This type assertion has a placeholder `SAFETY:` comment. State the concrete check and invariant that justify this assertion."
        }
    },
    create(context) {
        const checkAssertion = (node: TypeAssertion) => {
            if (isConstAssertion(node)) return;
            const classification = safetyComment(context.sourceCode, node);
            if (classification === "specific") return;
            context.report({
                node,
                messageId:
                    classification === "placeholder"
                        ? "placeholderSafetyComment"
                        : "missingSafetyComment"
            });
        };

        return {
            TSAsExpression: checkAssertion,
            TSTypeAssertion: checkAssertion
        };
    }
});

import { defineRule } from "@oxlint/plugins";

import type { Comment, ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;
type SafetyComment = "missing" | "placeholder" | "present";

const obviousPlaceholder =
    /^(?:as\s+above|same\s+(?:invariant|reason)|see\s+above|trust\s+me)[\p{P}\p{S}\s]*$/iu;

const commentOwnerKinds = new Set([
    "ExpressionStatement",
    "ExportDefaultDeclaration",
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

function classifySafetyComment(comment: Comment | undefined): SafetyComment {
    if (comment === undefined) return "missing";
    const match = /\bSAFETY\s*:\s*(.*)/isu.exec(comment.value);
    if (match === null) return "missing";
    const reason = match[1]?.trim() ?? "";
    return reason.length === 0 || obviousPlaceholder.test(reason) ? "placeholder" : "present";
}

function containingStatement(node: TypeAssertion): ESTree.Node {
    let current: ESTree.Node = node;
    while (!commentOwnerKinds.has(current.type) && current.parent.type !== "Program") {
        current = current.parent;
    }
    return current;
}

function assertionBoundaryStart(node: TypeAssertion): number {
    let current: ESTree.Node = node;
    while (current.parent.type === "ParenthesizedExpression") current = current.parent;
    return current.start;
}

function lastCommentBefore(
    sourceCode: SourceCode,
    position: number,
    lowerBound: number
): Comment | undefined {
    const comments = sourceCode
        .getAllComments()
        .filter((comment) => comment.start >= lowerBound && comment.end <= position);
    return comments.at(-1);
}

function inlineSafetyComment(
    sourceCode: SourceCode,
    statement: ESTree.Node,
    assertion: TypeAssertion
): SafetyComment {
    const start = assertionBoundaryStart(assertion);
    const comment = lastCommentBefore(sourceCode, start, statement.start);
    if (comment === undefined || sourceCode.text.slice(comment.end, start).trim().length > 0) {
        return "missing";
    }
    return classifySafetyComment(comment);
}

function precedingStatementSafetyComment(
    sourceCode: SourceCode,
    statement: ESTree.Node
): SafetyComment {
    const comment = sourceCode.getCommentsBefore(statement).at(-1);
    if (comment === undefined) return "missing";
    const gap = sourceCode.text.slice(comment.end, statement.start);
    if (!/^[\t ]*(?:\r?\n[\t ]*)?$/u.test(gap)) return "missing";
    return classifySafetyComment(comment);
}

/** Require every non-const type assertion to carry one structurally bound SAFETY rationale. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Require a nonempty, structurally bound SAFETY rationale for every TypeScript type assertion except const assertions."
        },
        messages: {
            missingSafetyComment:
                "This type assertion has no structurally bound `SAFETY:` rationale. Put one immediately before this assertion, or before a statement containing exactly one assertion.",
            placeholderSafetyComment:
                "This type assertion has an empty or placeholder `SAFETY:` rationale. State the invariant TypeScript cannot express."
        }
    },
    create(context) {
        const assertionsByStatement = new Map<ESTree.Node, TypeAssertion[]>();
        const coveredByStatementComment = new Set<TypeAssertion>();

        const report = (assertion: TypeAssertion, classification: SafetyComment) => {
            context.report({
                node: assertion,
                messageId:
                    classification === "placeholder"
                        ? "placeholderSafetyComment"
                        : "missingSafetyComment"
            });
        };

        const checkAssertion = (assertion: TypeAssertion) => {
            if (isConstAssertion(assertion)) return;
            const statement = containingStatement(assertion);
            const previousAssertions = assertionsByStatement.get(statement) ?? [];
            assertionsByStatement.set(statement, [...previousAssertions, assertion]);

            const inline = inlineSafetyComment(context.sourceCode, statement, assertion);
            if (inline !== "missing") {
                if (inline === "placeholder") report(assertion, inline);
                return;
            }
            if (previousAssertions.length === 0) {
                const preceding = precedingStatementSafetyComment(context.sourceCode, statement);
                if (preceding === "present") {
                    coveredByStatementComment.add(assertion);
                } else {
                    report(assertion, preceding);
                }
                return;
            }
            const first = previousAssertions[0];
            if (first !== undefined && coveredByStatementComment.delete(first)) {
                report(first, "missing");
            }
            report(assertion, "missing");
        };

        return {
            TSAsExpression: checkAssertion,
            TSTypeAssertion: checkAssertion
        };
    }
});

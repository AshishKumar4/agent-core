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

function classifySafetyCommentBlock(comments: readonly Comment[]): SafetyComment {
    const text = comments
        .flatMap((comment) => comment.value.split(/\r?\n/u))
        .map((line) => line.trim().replace(/^\*\s?/u, ""))
        .join("\n");
    const markers = [...text.matchAll(/\bSAFETY\s*:/giu)];
    if (markers.length === 0) return "missing";
    if (markers.length !== 1) return "placeholder";
    const marker = markers[0];
    const reasonStart = (marker?.index ?? 0) + (marker?.[0].length ?? 0);
    const reasons = text
        .slice(reasonStart)
        .split("\n")
        .map((reason) => reason.trim())
        .filter((reason) => reason.length > 0);
    return reasons.every((reason) => obviousPlaceholder.test(reason)) ? "placeholder" : "present";
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

function isContiguousGap(gap: string): boolean {
    return /^[\t ]*(?:\r?\n[\t ]*)?$/u.test(gap);
}

function contiguousCommentBlock(
    sourceCode: SourceCode,
    comments: readonly Comment[],
    position: number
): readonly Comment[] {
    const block: Comment[] = [];
    let boundary = position;
    for (let index = comments.length - 1; index >= 0; index -= 1) {
        const comment = comments[index];
        if (
            comment === undefined ||
            !isContiguousGap(sourceCode.text.slice(comment.end, boundary))
        ) {
            break;
        }
        block.unshift(comment);
        boundary = comment.start;
    }
    return block;
}

function inlineSafetyComment(
    sourceCode: SourceCode,
    statement: ESTree.Node,
    assertion: TypeAssertion
): SafetyComment {
    const start = assertionBoundaryStart(assertion);
    const comments = sourceCode
        .getAllComments()
        .filter((comment) => comment.start >= statement.start && comment.end <= start);
    return classifySafetyCommentBlock(contiguousCommentBlock(sourceCode, comments, start));
}

function precedingStatementSafetyComment(
    sourceCode: SourceCode,
    statement: ESTree.Node
): SafetyComment {
    return classifySafetyCommentBlock(
        contiguousCommentBlock(sourceCode, sourceCode.getCommentsBefore(statement), statement.start)
    );
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

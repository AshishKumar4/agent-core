import { defineRule } from "@oxlint/plugins";

import { createLexicalTypeEnvironment } from "../shared/dictionary-types.ts";
import { lexicalTypeParameterNames, resolvesToTopType } from "../shared/type-resolution.ts";

import type { ESTree } from "@oxlint/plugins";

type FunctionWithReturnType =
    | ESTree.ArrowFunctionExpression
    | ESTree.Function
    | ESTree.TSCallSignatureDeclaration
    | ESTree.TSConstructSignatureDeclaration
    | ESTree.TSConstructorType
    | ESTree.TSFunctionType
    | ESTree.TSMethodSignature;

const asyncValueTypes = new Set(["Promise", "PromiseLike"]);

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Disallow functions whose explicit return contract resolves to unknown or an async unknown value."
        },
        messages: {
            unknownReturn:
                "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type."
        }
    },
    create(context) {
        const checkReturnType = (node: FunctionWithReturnType) => {
            const annotation = node.returnType;
            if (annotation === null || annotation === undefined) return;
            if (
                !resolvesToTopType(
                    annotation.typeAnnotation,
                    "unknown",
                    createLexicalTypeEnvironment(node),
                    lexicalTypeParameterNames(node),
                    asyncValueTypes
                )
            ) {
                return;
            }
            context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
        };

        return {
            ArrowFunctionExpression: checkReturnType,
            FunctionDeclaration: checkReturnType,
            FunctionExpression: checkReturnType,
            TSCallSignatureDeclaration: checkReturnType,
            TSConstructSignatureDeclaration: checkReturnType,
            TSConstructorType: checkReturnType,
            TSDeclareFunction: checkReturnType,
            TSEmptyBodyFunctionExpression: checkReturnType,
            TSFunctionType: checkReturnType,
            TSMethodSignature: checkReturnType
        };
    }
});

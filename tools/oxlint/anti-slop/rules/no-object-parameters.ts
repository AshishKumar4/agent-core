import { defineRule } from "@oxlint/plugins";

import { createLexicalTypeEnvironment } from "../shared/dictionary-types.ts";
import { lexicalTypeParameterNames, resolvesToTopType } from "../shared/type-resolution.ts";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
    | ESTree.ArrowFunctionExpression
    | ESTree.Function
    | ESTree.TSCallSignatureDeclaration
    | ESTree.TSConstructSignatureDeclaration
    | ESTree.TSConstructorType
    | ESTree.TSFunctionType
    | ESTree.TSMethodSignature;

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
    if (parameter.type === "TSParameterProperty") {
        return parameterAnnotation(parameter.parameter);
    }
    if (parameter.type === "RestElement") {
        return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
    }
    if (parameter.type === "AssignmentPattern") {
        return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
    }
    return parameter.typeAnnotation;
}

function parameterName(parameter: Parameter, sourceCode: SourceCode): string {
    return parameter.type === "Identifier"
        ? parameter.name
        : sourceCode.getText(parameter).replace(/\s*:\s*object\s*$/u, "");
}

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParametersRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary."
        },
        messages: {
            objectParameter:
                "Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function."
        }
    },
    create(context) {
        const checkParameters = (node: ParameterOwner) => {
            const environment = createLexicalTypeEnvironment(node);
            const lexicalParameters = lexicalTypeParameterNames(node);
            for (const parameter of node.params) {
                const annotation = parameterAnnotation(parameter);
                if (annotation === null || annotation === undefined) continue;
                if (
                    !resolvesToTopType(
                        annotation.typeAnnotation,
                        "object",
                        environment,
                        lexicalParameters
                    )
                )
                    continue;
                context.report({
                    node: annotation.typeAnnotation,
                    messageId: "objectParameter",
                    data: { parameter: parameterName(parameter, context.sourceCode) }
                });
            }
        };

        return {
            ArrowFunctionExpression: checkParameters,
            FunctionDeclaration: checkParameters,
            FunctionExpression: checkParameters,
            TSCallSignatureDeclaration: checkParameters,
            TSConstructSignatureDeclaration: checkParameters,
            TSConstructorType: checkParameters,
            TSDeclareFunction: checkParameters,
            TSEmptyBodyFunctionExpression: checkParameters,
            TSFunctionType: checkParameters,
            TSMethodSignature: checkParameters
        };
    }
});

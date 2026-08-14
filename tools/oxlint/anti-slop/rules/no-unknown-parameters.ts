import { defineRule } from "@oxlint/plugins";

import { createTypeEnvironment, type TypeEnvironment } from "../shared/dictionary-types.ts";
import { resolvesToTopType } from "../shared/type-resolution.ts";

import type { ESTree } from "@oxlint/plugins";

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

function parameterName(parameter: Parameter, sourceText: string): string {
    if (parameter.type === "TSParameterProperty") {
        return parameterName(parameter.parameter, sourceText);
    }
    if (parameter.type === "AssignmentPattern") {
        return parameterName(parameter.left, sourceText);
    }
    if (parameter.type === "RestElement") {
        return parameterName(parameter.argument, sourceText);
    }
    return parameter.type === "Identifier"
        ? parameter.name
        : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}

function narrowedParameterName(node: ParameterOwner): string | null {
    const predicate = node.returnType?.typeAnnotation;
    return predicate?.type === "TSTypePredicate" && predicate.parameterName.type === "Identifier"
        ? predicate.parameterName.name
        : null;
}

/** Disallow unknown inputs except the subject of an explicit predicate or assertion. */
export const noUnknownParametersRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Disallow explicitly unknown function parameters unless the function proves that parameter's type."
        },
        messages: {
            unknownParameter:
                "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function."
        }
    },
    createOnce(context) {
        let environment: TypeEnvironment | null = null;
        const checkParameters = (node: ParameterOwner) => {
            if (environment === null) return;
            const narrowed = narrowedParameterName(node);
            for (const parameter of node.params) {
                const annotation = parameterAnnotation(parameter);
                if (
                    annotation === null ||
                    annotation === undefined ||
                    !resolvesToTopType(annotation.typeAnnotation, "unknown", environment)
                ) {
                    continue;
                }
                const name = parameterName(parameter, context.sourceCode.getText(parameter));
                if (name === narrowed) continue;
                context.report({
                    node: annotation.typeAnnotation,
                    messageId: "unknownParameter",
                    data: { parameter: name }
                });
            }
        };

        return {
            Program(node) {
                environment = createTypeEnvironment(node);
            },
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

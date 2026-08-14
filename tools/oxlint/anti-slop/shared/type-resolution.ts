import type { ESTree } from "@oxlint/plugins";

import type { TypeEnvironment } from "./dictionary-types.ts";

type TopType = "object" | "unknown";
type Substitutions = ReadonlyMap<string, ESTree.TSType>;

function unwrapType(type: ESTree.TSType): ESTree.TSType {
    let current = type;
    while (
        current.type === "TSParenthesizedType" ||
        (current.type === "TSTypeOperator" && current.operator === "readonly")
    ) {
        current = current.typeAnnotation;
    }
    return current;
}

function referenceName(type: ESTree.TSTypeReference): string | null {
    return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function substitutedArgument(
    type: ESTree.TSType,
    substitutions: Substitutions,
    visited: ReadonlySet<string> = new Set()
): ESTree.TSType {
    const unwrapped = unwrapType(type);
    if (unwrapped.type !== "TSTypeReference") return type;
    const name = referenceName(unwrapped);
    if (name === null || visited.has(name)) return type;
    const substitution = substitutions.get(name);
    if (substitution === undefined) return type;
    const nextVisited = new Set(visited);
    nextVisited.add(name);
    return substitutedArgument(substitution, substitutions, nextVisited);
}

function aliasSubstitutions(
    alias: ESTree.TSTypeAliasDeclaration,
    reference: ESTree.TSTypeReference,
    inherited: Substitutions
): Substitutions | null {
    const parameters = alias.typeParameters?.params ?? [];
    const arguments_ = reference.typeArguments?.params ?? [];
    const next = new Map(inherited);
    for (const [index, parameter] of parameters.entries()) {
        const argument = arguments_[index] ?? parameter.default;
        if (argument === null || argument === undefined) return null;
        next.set(parameter.name.name, substitutedArgument(argument, inherited));
    }
    return next;
}

function isTarget(type: ESTree.TSType, target: TopType): boolean {
    return target === "unknown"
        ? type.type === "TSUnknownKeyword"
        : type.type === "TSObjectKeyword";
}

function resolves(
    type: ESTree.TSType,
    target: TopType,
    environment: TypeEnvironment,
    transparentReferences: ReadonlySet<string>,
    lexicalTypeParameters: ReadonlySet<string>,
    substitutions: Substitutions,
    resolvingAliases: ReadonlySet<string>
): boolean {
    const unwrapped = unwrapType(type);
    if (isTarget(unwrapped, target)) return true;
    if (unwrapped.type === "TSUnionType") {
        return unwrapped.types.some((member) =>
            resolves(
                member,
                target,
                environment,
                transparentReferences,
                lexicalTypeParameters,
                substitutions,
                resolvingAliases
            )
        );
    }
    if (unwrapped.type === "TSIntersectionType") {
        return (
            unwrapped.types.length > 0 &&
            unwrapped.types.every((member) =>
                resolves(
                    member,
                    target,
                    environment,
                    transparentReferences,
                    lexicalTypeParameters,
                    substitutions,
                    resolvingAliases
                )
            )
        );
    }
    if (unwrapped.type !== "TSTypeReference") return false;
    const name = referenceName(unwrapped);
    if (name === null || lexicalTypeParameters.has(name)) return false;

    const substitution = substitutions.get(name);
    if (substitution !== undefined) {
        return resolves(
            substitution,
            target,
            environment,
            transparentReferences,
            lexicalTypeParameters,
            substitutions,
            resolvingAliases
        );
    }

    if (transparentReferences.has(name) && !environment.shadowedBuiltIns.has(name)) {
        const value = unwrapped.typeArguments?.params[0];
        return (
            value !== undefined &&
            resolves(
                value,
                target,
                environment,
                transparentReferences,
                lexicalTypeParameters,
                substitutions,
                resolvingAliases
            )
        );
    }

    const alias = environment.aliases.get(name);
    if (alias === undefined || resolvingAliases.has(name)) return false;
    const nextSubstitutions = aliasSubstitutions(alias, unwrapped, substitutions);
    if (nextSubstitutions === null) return false;
    const nextResolving = new Set(resolvingAliases);
    nextResolving.add(name);
    return resolves(
        alias.typeAnnotation,
        target,
        environment,
        transparentReferences,
        lexicalTypeParameters,
        nextSubstitutions,
        nextResolving
    );
}

export function lexicalTypeParameterNames(node: ESTree.Node): ReadonlySet<string> {
    const names = new Set<string>();
    let current: ESTree.Node | null = node;
    while (current !== null && current.type !== "Program") {
        if ("typeParameters" in current) {
            for (const parameter of current.typeParameters?.params ?? []) {
                names.add(parameter.name.name);
            }
        }
        if (current.type === "TSMappedType") names.add(current.key.name);
        if (current.type === "TSInferType") names.add(current.typeParameter.name.name);
        current = current.parent;
    }
    return names;
}

export function resolvesToTopType(
    type: ESTree.TSType,
    target: TopType,
    environment: TypeEnvironment,
    lexicalTypeParameters: ReadonlySet<string> = new Set(),
    transparentReferences: ReadonlySet<string> = new Set()
): boolean {
    return resolves(
        type,
        target,
        environment,
        transparentReferences,
        lexicalTypeParameters,
        new Map(),
        new Set()
    );
}

import { relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { hasModifier, sourceFiles } from "./compiler.mjs";
import { collectFiles } from "./project.mjs";

/**
 * Which classes in a source tree declare a durable record codec, and what kind each one
 * registers. Two gates ask this: the record registry asks it to hold the classified
 * denominator against the tree, and the digest-derivation gate asks it because a type
 * with no codec has no canonical serialised form and therefore cannot reach a durable
 * identity at all. One walk, one predicate — a second copy of "what counts as a codec"
 * would drift the moment either gate learned a new shape.
 *
 * `codecClassDeclarations` is the primitive and hands back the declaration nodes, so a
 * caller needing the checker's view of a class does not parse the tree a second time.
 */

/** Every class in `root` declaring a codec, with the AST it was found in. */
export async function codecClassDeclarations(root, prefix) {
    const found = [];
    const files = await collectFiles(
        root,
        (path) => /\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path)
    );
    for (const [path, parsed] of sourceFiles(files)) {
        for (const statement of parsed.statements) {
            if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
            const staticCodec = statement.members.some((member) => isStaticCodec(member, parsed));
            const methods = new Set(
                statement.members
                    .filter(
                        (member) =>
                            ts.isMethodDeclaration(member) &&
                            hasModifier(member, ts.SyntaxKind.StaticKeyword)
                    )
                    .map((member) => member.name.getText(parsed))
            );
            if (!(staticCodec || (methods.has("encode") && methods.has("decode")))) continue;
            const relativePath = relative(resolve(root, ".."), path).replaceAll("\\", "/");
            found.push({
                selector: `${prefix}${relativePath}#${statement.name.text}`,
                file: `${prefix}${relativePath}`,
                path,
                name: statement.name.text,
                declaration: statement,
                source: parsed
            });
        }
    }
    return found;
}

/** The record-registry view: one `{ source, kind }` row per codec-declaring class. */
export async function discoverCodecRecords(root, prefix) {
    return (await codecClassDeclarations(root, prefix)).map((record) => ({
        source: record.selector,
        kind: codecKind(record.source, record.declaration)
    }));
}

function codecKind(source, recordClass) {
    const codecMember = recordClass.members.find((member) => isStaticCodec(member, source));
    const codecExpression =
        codecMember !== undefined && ts.isPropertyDeclaration(codecMember)
            ? codecMember.initializer
            : codecMember?.body?.statements.find(ts.isReturnStatement)?.expression;
    if (codecExpression !== undefined) {
        return kindFromExpression(source, codecExpression, new Set());
    }
    const encode = recordClass.members.find(
        (member) =>
            ts.isMethodDeclaration(member) &&
            hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
            member.name.getText(source) === "encode"
    );
    const returned = encode?.body?.statements.find(ts.isReturnStatement)?.expression;
    if (
        returned !== undefined &&
        ts.isCallExpression(returned) &&
        ts.isPropertyAccessExpression(returned.expression) &&
        returned.expression.name.text === "encode"
    ) {
        return kindFromExpression(source, returned.expression.expression, new Set());
    }
    return undefined;
}

function kindFromExpression(source, expression, visited) {
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) {
        return kindFromExpression(source, expression.expression, visited);
    }
    if (ts.isNewExpression(expression)) {
        const directKind = expression.arguments?.[0];
        if (directKind !== undefined && ts.isStringLiteral(directKind)) {
            return directKind.text;
        }
        return kindFromCodecClass(source, expression.expression.getText(source), visited);
    }
    if (ts.isIdentifier(expression)) {
        if (visited.has(expression.text)) return undefined;
        visited.add(expression.text);
        const variable = source.statements
            .filter(ts.isVariableStatement)
            .flatMap((statement) => statement.declarationList.declarations)
            .find(
                (declaration) =>
                    ts.isIdentifier(declaration.name) && declaration.name.text === expression.text
            );
        if (variable?.initializer !== undefined) {
            return kindFromExpression(source, variable.initializer, visited);
        }
        return kindFromCodecClass(source, expression.text, visited);
    }
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === "codec") {
        const record = source.statements.find(
            (statement) =>
                ts.isClassDeclaration(statement) &&
                statement.name?.text === expression.expression.getText(source)
        );
        return record === undefined ? undefined : codecKind(source, record);
    }
    return undefined;
}

function kindFromCodecClass(source, className, visited) {
    if (visited.has(className)) return undefined;
    visited.add(className);
    const codecClass = source.statements.find(
        (statement) => ts.isClassDeclaration(statement) && statement.name?.text === className
    );
    const constructor = codecClass?.members.find(ts.isConstructorDeclaration);
    if (constructor === undefined) return undefined;
    for (const statement of constructor.body?.statements ?? []) {
        if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
            continue;
        }
        const call = statement.expression;
        if (call.expression.kind !== ts.SyntaxKind.SuperKeyword) continue;
        const kind = call.arguments[0];
        if (kind !== undefined && ts.isStringLiteral(kind)) return kind.text;
    }
    return undefined;
}

function isStaticCodec(member, source) {
    return (
        (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
        hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        member.name.getText(source) === "codec"
    );
}

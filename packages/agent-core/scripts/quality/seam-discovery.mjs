import { relative, resolve } from "node:path";
import ts from "typescript";
import { packageRoot } from "./project.mjs";

const CONTRACT_NAME = /(?:Port|Store|Persistence)$/u;

export function discoverNormativeSeams(program) {
    const contracts = new Map();
    const classes = new Map();
    for (const source of program.getSourceFiles()) {
        if (!isOwnedSource(source.fileName)) continue;
        for (const statement of source.statements) {
            if (
                (ts.isInterfaceDeclaration(statement) ||
                    (ts.isClassDeclaration(statement) && isAbstract(statement))) &&
                statement.name !== undefined &&
                isExported(statement) &&
                CONTRACT_NAME.test(statement.name.text)
            ) {
                contracts.set(statement.name.text, selector(source.fileName, statement.name.text));
            }
            if (
                ts.isClassDeclaration(statement) &&
                statement.name !== undefined &&
                isExported(statement) &&
                !isAbstract(statement)
            ) {
                classes.set(statement.name.text, {
                    declaration: statement,
                    selector: selector(source.fileName, statement.name.text)
                });
            }
        }
    }

    const discovered = [];
    for (const [name, contract] of contracts) {
        const implementations = [...classes.entries()]
            .filter(
                ([implementation, candidate]) =>
                    conventionalImplementation(implementation, name) ||
                    inherits(candidate.declaration, name, classes, new Set())
            )
            .map(([implementation, candidate]) => ({
                name: implementation,
                selector: candidate.selector
            }));
        if (
            !implementations.some((implementation) => implementation.name.startsWith("Memory")) ||
            !implementations.some((implementation) => !implementation.name.startsWith("Memory"))
        ) {
            continue;
        }
        discovered.push({
            id: kebab(name),
            contract,
            implementations: implementations.map((implementation) => implementation.selector).sort()
        });
    }
    return discovered.sort((left, right) => left.contract.localeCompare(right.contract));
}

function conventionalImplementation(implementation, contract) {
    return implementation === `Memory${contract}` || implementation === `Sqlite${contract}`;
}

function inherits(declaration, contract, classes, visited) {
    const name = declaration.name?.text;
    if (name === undefined || visited.has(name)) return false;
    visited.add(name);
    for (const clause of declaration.heritageClauses ?? []) {
        for (const type of clause.types) {
            const inherited = heritageName(type.expression);
            if (inherited === contract) return true;
            const parent = classes.get(inherited);
            if (parent !== undefined && inherits(parent.declaration, contract, classes, visited)) {
                return true;
            }
        }
    }
    return false;
}

function heritageName(expression) {
    return ts.isIdentifier(expression) ? expression.text : expression.getText().split(".").at(-1);
}

function selector(path, symbol) {
    return `${relative(packageRoot, path).replaceAll("\\", "/")}#${symbol}`;
}

function isOwnedSource(path) {
    const sourceRoot = resolve(packageRoot, "src");
    const offset = relative(sourceRoot, path);
    return offset !== ".." && !offset.startsWith("../") && !path.endsWith(".d.ts");
}

function isExported(node) {
    return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isAbstract(node) {
    return hasModifier(node, ts.SyntaxKind.AbstractKeyword);
}

function hasModifier(node, kind) {
    return (
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    );
}

function kebab(value) {
    return value
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replaceAll(/([A-Z])([A-Z][a-z])/g, "$1-$2")
        .toLowerCase();
}

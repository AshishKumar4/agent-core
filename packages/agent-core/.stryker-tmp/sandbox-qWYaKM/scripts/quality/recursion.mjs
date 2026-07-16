// @ts-nocheck
import { readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { collectFiles, packageRoot, portable } from "./project.mjs";

const forbidden =
    /(?:scripts\/(?:check-[^"'`\s]+|quality\/run\.mjs)|\bpnpm\b[^\n]*\bcheck(?::|\b))/u;
const checkerEntrypoints = new Set([
    "check-exports.mjs",
    "check-import-boundaries.mjs",
    "check-traceability.mjs",
    ...[
        "agents",
        "architecture",
        "attest",
        "coverage",
        "format",
        "governance",
        "integration",
        "invariants",
        "ledger",
        "migrations",
        "records",
        "requests",
        "seams"
    ].map((name) => `quality/${name}.mjs`)
]);

export function validateLeafSources(sources) {
    for (const [path, source] of Object.entries(sources)) {
        if (forbidden.test(source))
            throw new TypeError(`Quality leaf invokes another checker: ${path}`);
        const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        parsed.forEachChild((node) => {
            const target = importedModule(node);
            if (target === undefined || !target.startsWith(".")) return;
            const imported = portable(relative(".", resolve(dirname(path), target)));
            if (checkerEntrypoints.has(imported)) {
                throw new TypeError(`Quality leaf imports another checker: ${path} -> ${imported}`);
            }
        });
    }
}

export async function validateNonrecursiveQualityScripts() {
    const root = resolve(packageRoot, "scripts");
    const files = await collectFiles(root, (path) => path.endsWith(".mjs"));
    const sources = {};
    for (const path of files) {
        if (["run.mjs", "recursion.mjs"].includes(basename(path))) continue;
        sources[portable(relative(root, path))] = await readFile(path, "utf8");
    }
    validateLeafSources(sources);
}

function importedModule(node) {
    if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
    ) {
        return node.moduleSpecifier.text;
    }
    if (
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.expression.arguments.length === 1 &&
        ts.isStringLiteral(node.expression.arguments[0])
    ) {
        return node.expression.arguments[0].text;
    }
    return undefined;
}

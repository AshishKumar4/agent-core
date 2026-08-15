import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { dirname, normalize } from "node:path/posix";
import ts from "typescript";
import { collectFiles, packageRoot, portable } from "./project.mjs";

const forbiddenInvocation =
    /(?:scripts\/(?:check-[^"'`\s]+|quality\/run\.mjs)|\bpnpm\b[^\n]*\bcheck(?::|\b))/u;
const checkerEntrypoints = new Set([
    "check-exports.mjs",
    "check-import-boundaries.mjs",
    "check-normative.mjs",
    "check-traceability.mjs",
    ...[
        "agents",
        "architecture",
        "attest",
        "backlog",
        "claims",
        "coherence",
        "coverage",
        "discrimination",
        "doctrine",
        "format",
        "governance",
        "integration",
        "invariants",
        "ledger",
        "migrations",
        "records",
        "requests",
        "seams",
        "test-priorities"
    ].map((name) => `quality/${name}.mjs`)
]);

export function validateLeafSources(sources) {
    for (const [path, source] of Object.entries(sources)) {
        const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        if (parsed.parseDiagnostics.length > 0) {
            throw new TypeError(`Quality leaf is not valid JavaScript: ${path}`);
        }
        const visit = (node) => {
            if (
                ts.isCallExpression(node) &&
                forbiddenInvocation.test(literalText(node.arguments))
            ) {
                throw new TypeError(`Quality leaf invokes another checker: ${path}`);
            }
            const target = importedModule(node);
            if (target !== undefined && target.startsWith(".")) {
                const imported = normalize(`${dirname(path)}/${target}`);
                if (checkerEntrypoints.has(imported)) {
                    throw new TypeError(
                        `Quality leaf imports another checker: ${path} -> ${imported}`
                    );
                }
            }
            node.forEachChild(visit);
        };
        parsed.forEachChild(visit);
    }
}

function literalText(nodes) {
    const values = [];
    const visit = (node) => {
        if (ts.isStringLiteralLike(node)) values.push(node.text);
        node.forEachChild(visit);
    };
    for (const node of nodes) visit(node);
    return values.join(" ");
}

export async function validateNonrecursiveQualityScripts() {
    const root = resolve(packageRoot, "scripts");
    const files = await collectFiles(root, (path) => path.endsWith(".mjs"));
    const sources = {};
    for (const path of files) {
        const scriptPath = portable(relative(root, path));
        if (["quality/run.mjs", "quality/recursion.mjs"].includes(scriptPath)) continue;
        sources[scriptPath] = await readFile(path, "utf8");
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
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
    ) {
        return node.arguments[0].text;
    }
    return undefined;
}

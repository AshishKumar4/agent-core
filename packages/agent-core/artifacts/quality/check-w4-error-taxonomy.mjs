import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { SymbolFlags } from "typescript/unstable/sync";
import { configuredProject } from "../../scripts/quality/compiler.mjs";

const qualityRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(qualityRoot, "../..");
const evidence = await json("w4-error-taxonomy.json");
const inventory = await json("w4-source-inventory.json");
const files = inventory.sources.map((path) => resolve(packageRoot, path));
if (process.env.W4_TAXONOMY_FIXTURE !== undefined) {
    files.push(resolve(packageRoot, process.env.W4_TAXONOMY_FIXTURE));
}

const project = configuredProject(resolve(packageRoot, "tsconfig.json"));
const program = project.program;
const checker = project.checker;
const allowedTypeErrors = new Set(evidence.allowedTypeErrorSites);
const allowedRethrows = new Set(evidence.allowedPreservedRethrows);
const seenTypeErrors = new Set();
const seenRethrows = new Set();
const counts = {
    agentCoreOperationalThrows: 0,
    allowedTypeErrors: 0,
    preservedRethrows: 0,
    bareErrors: 0
};
const byCode = Object.fromEntries(Object.keys(evidence.operationalCodes).map((code) => [code, 0]));
const unclassified = [];
for (const path of files) {
    const file = program.getSourceFile(path);
    if (file === undefined) {
        throw new TypeError(`Integrated W4 taxonomy source is absent from TypeScript: ${path}`);
    }
    visit(file, file, path);
}
for (const site of allowedTypeErrors) {
    if (!seenTypeErrors.has(site)) unclassified.push(`${site} allowed TypeError site is stale`);
}
for (const site of allowedRethrows) {
    if (!seenRethrows.has(site)) unclassified.push(`${site} allowed preserved rethrow is stale`);
}

if (process.argv.includes("--measure")) {
    const measuredCounts = { ...counts, allowedTypeErrors: seenTypeErrors.size };
    console.log(
        JSON.stringify(
            {
                allowedTypeErrorSites: [...seenTypeErrors].sort(),
                allowedPreservedRethrows: [...seenRethrows].sort(),
                expected: measuredCounts,
                expectedOperationalByCode: byCode,
                unclassified
            },
            null,
            2
        )
    );
    process.exit(0);
}
if (unclassified.length > 0) {
    throw new TypeError(`Unclassified integrated W4 error sites:\n${unclassified.join("\n")}`);
}
if (JSON.stringify(counts) !== JSON.stringify(evidence.expected)) {
    throw new TypeError(`Integrated W4 error taxonomy counts changed: ${JSON.stringify(counts)}`);
}
if (JSON.stringify(byCode) !== JSON.stringify(evidence.expectedOperationalByCode)) {
    throw new TypeError(`Integrated W4 operational code counts changed: ${JSON.stringify(byCode)}`);
}
console.log(`Integrated W4 error taxonomy verified: ${JSON.stringify({ ...counts, byCode })}`);

function visit(node, file, path) {
    if (ts.isThrowStatement(node)) classify(node, file, path);
    node.forEachChild((child) => visit(child, file, path));
}

function classify(statement, file, path) {
    const expression = statement.expression;
    const line = file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1;
    const location = `${portable(path)}:${line}`;
    if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) {
        const name = expression.expression.text;
        if (name === "Error") {
            counts.bareErrors += 1;
            unclassified.push(`${location} bare Error`);
            return;
        }
        if (name === "TypeError") {
            requireGlobalTypeError(expression.expression, location);
            seenTypeErrors.add(location);
            if (allowedTypeErrors.has(location)) counts.allowedTypeErrors += 1;
            else unclassified.push(`${location} unreviewed TypeError`);
            return;
        }
        if (name === "AgentCoreError") {
            requireSymbolSource(expression.expression, "src/errors.ts", location);
            const code = stringArgument(expression.arguments?.[0]);
            if (code === undefined) {
                unclassified.push(`${location} dynamic AgentCoreError code`);
                return;
            }
            recordOperational(code, location);
            return;
        }
        if (name === "PlacementUnavailableError") {
            requireSymbolSource(expression.expression, "src/definition/placement.ts", location);
            recordOperational("operation.invalid-input", location);
            return;
        }
        if (name === "UnsupportedMaterializationKindError") {
            requireSymbolSource(
                expression.expression,
                "src/definition/materialization-kind.ts",
                location
            );
            recordOperational("codec.invalid", location);
            return;
        }
        if (name === "CommandPayloadMalformedError") {
            requireSymbolSource(expression.expression, "src/protocol/payload.ts", location);
            recordOperational("protocol.invalid-envelope", location);
            return;
        }
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        const helperCodes = {
            corruptDefinition: "codec.invalid",
            corruptMaterialization: "codec.invalid",
            corruptPackage: "codec.invalid",
            definitionRevisionConflict: "protocol.revision-conflict",
            invalidDefinition: "operation.invalid-input",
            invalidDefinitionState: "protocol.invalid-state",
            invalidMaterializationState: "protocol.invalid-state",
            materializationRevisionConflict: "protocol.revision-conflict",
            resetRequired: "codec.invalid"
        };
        const name = expression.expression.text;
        const code = helperCodes[name];
        if (code !== undefined) {
            requireHelperSource(expression.expression, name, location);
            recordOperational(code, location);
            return;
        }
    }
    if (ts.isIdentifier(expression) && expression.text === "failure") {
        seenRethrows.add(location);
        if (allowedRethrows.has(location) && enclosingName(statement) === "disposeModules") {
            counts.preservedRethrows += 1;
        } else {
            unclassified.push(`${location} unreviewed preserved rethrow`);
        }
        return;
    }
    unclassified.push(`${location} ${expression?.getText(file) ?? "empty throw"}`);
}

// TypeScript 7 ships the standard library inside its platform package
// (@typescript/typescript-<platform>/lib), not under `typescript/lib`, so the two files
// that declare TypeError are named by their own directory rather than by the package
// that happens to carry them.
function requireGlobalTypeError(identifier, location) {
    const symbol = checker.getSymbolAtLocation(identifier);
    const declarations = symbol?.declarations ?? [];
    if (
        !declarations.some((declaration) =>
            /\/lib\/lib\.(?:es5|es2015\.core)\.d\.ts$/u.test(declaration.path.replaceAll("\\", "/"))
        )
    ) {
        unclassified.push(`${location} TypeError does not resolve to the TypeScript global`);
    }
}

function requireSymbolSource(identifier, expected, location) {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (symbol?.flags & SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = symbol?.declarations ?? [];
    if (!declarations.some((declaration) => portable(declaration.path) === expected)) {
        unclassified.push(`${location} ${identifier.text} does not resolve to ${expected}`);
    }
}

function requireHelperSource(identifier, name, location) {
    const expected =
        name === "corruptPackage"
            ? ["src/definition/package-store.ts", "src/substrates/sqlite/package.ts"]
            : [
                    "corruptMaterialization",
                    "invalidMaterializationState",
                    "materializationRevisionConflict",
                    "resetRequired"
                ].includes(name)
              ? name === "corruptMaterialization"
                  ? [
                        "src/definition/materialization-store.ts",
                        "src/substrates/sqlite/materialization.ts"
                    ]
                  : ["src/substrates/sqlite/materialization.ts"]
              : ["src/definition/error.ts"];
    let symbol = checker.getSymbolAtLocation(identifier);
    if (symbol?.flags & SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = symbol?.declarations ?? [];
    if (!declarations.some((declaration) => expected.includes(portable(declaration.path)))) {
        unclassified.push(`${location} ${name} does not resolve to ${expected.join(" or ")}`);
    }
}

function recordOperational(code, location) {
    counts.agentCoreOperationalThrows += 1;
    if (!(code in evidence.operationalCodes)) {
        unclassified.push(`${location} unsupported operational code ${code}`);
        return;
    }
    byCode[code] += 1;
}

function stringArgument(value) {
    return value !== undefined && ts.isStringLiteral(value) ? value.text : undefined;
}

function enclosingName(node) {
    let current = node.parent;
    while (current !== undefined) {
        if (
            (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) &&
            current.name !== undefined
        ) {
            return current.name.getText();
        }
        current = current.parent;
    }
    return "module";
}

function portable(path) {
    return relative(packageRoot, path).replaceAll("\\", "/");
}

async function json(path) {
    return JSON.parse(await readFile(resolve(qualityRoot, path), "utf8"));
}

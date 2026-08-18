import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { SymbolFlags } from "typescript/unstable/sync";
import { configuredProject, parseSource } from "../../scripts/quality/compiler.mjs";
import {
    assertArray,
    assertExactKeys,
    assertString,
    parseCanonicalJson
} from "../../scripts/quality/project.mjs";

const qualityRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(qualityRoot, "../..");
const siteOccurrences = new Map();
const cliArguments = process.argv.slice(2);
if (cliArguments[0] === "--fingerprint-source") {
    if (cliArguments.length !== 2 || cliArguments[1] !== "-") {
        throw new TypeError("--fingerprint-source requires standard input");
    }
    const source = readFileSync(0, "utf8");
    const file = parseSource("w4-taxonomy-probe.ts", source);
    const sites = [];
    collectTaxonomySites(file, file, "probe.ts", sites);
    console.log(JSON.stringify(sites));
    process.exit(0);
}
if (cliArguments.length > 1 || (cliArguments.length === 1 && cliArguments[0] !== "--measure")) {
    throw new TypeError(`Unknown W4 taxonomy arguments: ${cliArguments.join(" ")}`);
}
const evidence = await json("w4-error-taxonomy.json");
const inventory = await json("w4-source-inventory.json");
const files = inventory.sources.map((path) => resolve(packageRoot, path));
if (process.env.W4_TAXONOMY_FIXTURE !== undefined) {
    files.push(resolve(packageRoot, process.env.W4_TAXONOMY_FIXTURE));
}

const project = configuredProject(resolve(packageRoot, "tsconfig.json"));
const program = project.program;
const checker = project.checker;
const measuring = cliArguments[0] === "--measure";
if (evidence.edition !== "3.0.0") throw new TypeError("W4 taxonomy edition must be 3.0.0");
const allowedTypeErrorSites = measuring
    ? []
    : canonicalSites(evidence.allowedTypeErrorSites, "allowedTypeErrorSites");
const allowedRethrowSites = measuring
    ? []
    : canonicalSites(evidence.allowedPreservedRethrows, "allowedPreservedRethrows");
const allowedTypeErrors = new Set(allowedTypeErrorSites.map(siteKey));
const allowedRethrows = new Set(allowedRethrowSites.map(siteKey));
const seenTypeErrors = new Map();
const seenRethrows = new Map();
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
for (const site of allowedTypeErrorSites) {
    if (!seenTypeErrors.has(siteKey(site)))
        unclassified.push(`${siteDisplay(site)} allowed TypeError site is stale`);
}
for (const site of allowedRethrowSites) {
    if (!seenRethrows.has(siteKey(site)))
        unclassified.push(`${siteDisplay(site)} allowed preserved rethrow is stale`);
}

if (measuring) {
    const measuredCounts = { ...counts, allowedTypeErrors: seenTypeErrors.size };
    console.log(
        JSON.stringify(
            {
                allowedTypeErrorSites: [...seenTypeErrors.values()].sort(compareSites),
                allowedPreservedRethrows: [...seenRethrows.values()].sort(compareSites),
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

function collectTaxonomySites(node, file, path, sites) {
    if (ts.isThrowStatement(node)) sites.push(taxonomySite(node, file, path));
    node.forEachChild((child) => collectTaxonomySites(child, file, path, sites));
}

function classify(statement, file, path) {
    const expression = statement.expression;
    const site = taxonomySite(statement, file, path);
    const key = siteKey(site);
    const location = siteDisplay(site);
    if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) {
        const name = expression.expression.text;
        if (name === "Error") {
            counts.bareErrors += 1;
            unclassified.push(`${location} bare Error`);
            return;
        }
        if (name === "TypeError") {
            requireGlobalTypeError(expression.expression, location);
            seenTypeErrors.set(key, site);
            if (measuring || allowedTypeErrors.has(key)) counts.allowedTypeErrors += 1;
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
        if (name === "UnknownMaterializationKindError") {
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
        seenRethrows.set(key, site);
        if (
            (measuring || allowedRethrows.has(key)) &&
            enclosingName(statement) === "disposeModules"
        ) {
            counts.preservedRethrows += 1;
        } else {
            unclassified.push(`${location} unreviewed preserved rethrow`);
        }
        return;
    }
    unclassified.push(`${location} ${expression?.getText(file) ?? "empty throw"}`);
}

// TypeScript 7's unstable AST ships no printer, so canonical text is the node's trivia-
// free token stream: comments and formatting never move a permit, any token change does.
function canonicalSha256(node, file) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
    scanner.setText(node.getText(file));
    const tokens = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFile; kind = scanner.scan()) {
        tokens.push(scanner.getTokenText());
    }
    return createHash("sha256").update(tokens.join(" ")).digest("hex");
}

function taxonomySite(statement, file, path) {
    const declaration = enclosingDeclaration(statement);
    const base = {
        declarationSha256: canonicalSha256(declaration, file),
        file: portable(path),
        symbol: enclosingSymbol(statement, file),
        statementSha256: canonicalSha256(statement, file)
    };
    const baseKey = JSON.stringify(base);
    const occurrence = (siteOccurrences.get(baseKey) ?? 0) + 1;
    siteOccurrences.set(baseKey, occurrence);
    return { ...base, occurrence };
}

function canonicalSites(value, field) {
    assertArray(value, field);
    const sites = value.map((site, index) => requireSite(site, `${field}[${index}]`));
    const ordered = [...sites].sort(compareSites);
    if (
        new Set(sites.map(siteKey)).size !== sites.length ||
        JSON.stringify(sites) !== JSON.stringify(ordered)
    ) {
        throw new TypeError(`${field} must be unique and canonically ordered`);
    }
    return sites;
}

function requireSite(value, field) {
    assertExactKeys(
        value,
        ["declarationSha256", "file", "occurrence", "statementSha256", "symbol"],
        field
    );
    const declarationSha256 = assertString(value.declarationSha256, `${field}.declarationSha256`);
    const file = assertString(value.file, `${field}.file`);
    const symbol = assertString(value.symbol, `${field}.symbol`);
    const statementSha256 = assertString(value.statementSha256, `${field}.statementSha256`);
    if (
        !/^src\/.+\.ts$/u.test(file) ||
        !/^[0-9a-f]{64}$/u.test(declarationSha256) ||
        !/^[0-9a-f]{64}$/u.test(statementSha256) ||
        !Number.isSafeInteger(value.occurrence) ||
        value.occurrence < 1
    ) {
        throw new TypeError(`${field} is invalid`);
    }
    return {
        declarationSha256,
        file,
        symbol,
        statementSha256,
        occurrence: value.occurrence
    };
}

function enclosingDeclaration(node) {
    let current = node.parent;
    while (current !== undefined) {
        if (
            ts.isConstructorDeclaration(current) ||
            ts.isFunctionDeclaration(current) ||
            ts.isMethodDeclaration(current) ||
            ts.isGetAccessorDeclaration(current) ||
            ts.isSetAccessorDeclaration(current) ||
            ts.isClassDeclaration(current)
        ) {
            return current;
        }
        if (
            (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
            ts.isVariableDeclaration(current.parent)
        ) {
            return current.parent;
        }
        current = current.parent;
    }
    throw new TypeError("W4 taxonomy site has no enclosing declaration");
}

function siteKey(site) {
    return JSON.stringify([
        site.file,
        site.symbol,
        site.declarationSha256,
        site.statementSha256,
        site.occurrence
    ]);
}

function siteDisplay(site) {
    return `${site.file}#${site.symbol}#${site.declarationSha256}#${site.statementSha256}${site.occurrence === 1 ? "" : `#${site.occurrence}`}`;
}

function compareSites(left, right) {
    const leftKey = siteKey(left);
    const rightKey = siteKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function enclosingSymbol(node, file) {
    const names = [];
    let current = node.parent;
    while (current !== undefined) {
        if (ts.isConstructorDeclaration(current)) names.push("constructor");
        else if (
            (ts.isClassDeclaration(current) ||
                ts.isFunctionDeclaration(current) ||
                ts.isMethodDeclaration(current) ||
                ts.isGetAccessorDeclaration(current) ||
                ts.isSetAccessorDeclaration(current)) &&
            current.name !== undefined
        ) {
            names.push(current.name.getText(file));
        } else if (
            (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
            ts.isVariableDeclaration(current.parent) &&
            ts.isIdentifier(current.parent.name)
        ) {
            names.push(current.parent.name.text);
        }
        current = current.parent;
    }
    return names.length === 0 ? "module" : names.reverse().join(".");
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
    return parseCanonicalJson(
        await readFile(resolve(qualityRoot, path), "utf8"),
        `artifacts/quality/${path}`
    );
}

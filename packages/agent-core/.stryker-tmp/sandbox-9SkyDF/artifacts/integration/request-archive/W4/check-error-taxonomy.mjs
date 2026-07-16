// @ts-nocheck
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const requestRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(requestRoot, "../../..");
const manifest = JSON.parse(await readFile(resolve(requestRoot, "error-taxonomy.manifest"), "utf8"));
const expectedRoots = [
  "src/definition/**/*.ts",
  "src/protocol/materialization-commands.ts",
  "src/substrates/sqlite/materialization.ts",
  "src/substrates/sqlite/package.ts"
];
if (JSON.stringify(manifest.sourceRoots) !== JSON.stringify(expectedRoots)) {
  throw new TypeError("W4 error taxonomy source roots changed");
}
const files = [
  ...(await sourceFiles(resolve(packageRoot, "src/definition"))),
  resolve(packageRoot, "src/protocol/materialization-commands.ts"),
  resolve(packageRoot, "src/substrates/sqlite/materialization.ts"),
  resolve(packageRoot, "src/substrates/sqlite/package.ts")
];
if (process.env.W4_TAXONOMY_FIXTURE !== undefined) {
  files.push(resolve(packageRoot, process.env.W4_TAXONOMY_FIXTURE));
}
const config = ts.readConfigFile(resolve(packageRoot, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new TypeError(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const allowedTypeErrors = new Set(manifest.allowedTypeErrorSites);
const seenTypeErrors = new Set();
const counts = {
  agentCoreOperationalThrows: 0,
  allowedTypeErrors: 0,
  bareErrors: 0
};
const byCode = Object.fromEntries(Object.keys(manifest.operationalCodes).map(code => [code, 0]));
const unclassified = [];
for (const path of files) {
  const file = program.getSourceFile(path);
  if (file === undefined) throw new TypeError(`W4 taxonomy source is absent from TypeScript: ${path}`);
  visit(file, file, path);
}
for (const site of allowedTypeErrors) {
  if (!seenTypeErrors.has(site)) unclassified.push(`${site} allowed TypeError site is stale`);
}
if (unclassified.length > 0) {
  throw new TypeError(`Unclassified W4 error sites:\n${unclassified.join("\n")}`);
}
if (JSON.stringify(counts) !== JSON.stringify(manifest.expected)) {
  throw new TypeError(`W4 error taxonomy counts changed: ${JSON.stringify(counts)}`);
}
if (JSON.stringify(byCode) !== JSON.stringify(manifest.expectedOperationalByCode)) {
  throw new TypeError(`W4 operational code counts changed: ${JSON.stringify(byCode)}`);
}
console.log(`W4 error taxonomy verified: ${JSON.stringify({ ...counts, byCode })}`);

function visit(node, file, path) {
  if (ts.isThrowStatement(node)) classify(node, file, path);
  ts.forEachChild(node, child => visit(child, file, path));
}

function classify(statement, file, path) {
  const expression = statement.expression;
  const line = file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1;
  const location = `${relative(packageRoot, path).replaceAll("\\", "/")}:${line}`;
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
      if (code === undefined && enclosingName(statement) !== "definitionError") {
        unclassified.push(`${location} dynamic AgentCoreError code`);
        return;
      }
      recordOperational(code ?? "dynamic", location);
      return;
    }
    if (name === "PlacementUnavailableError") {
      requireSymbolSource(expression.expression, "src/definition/placement.ts", location);
      recordOperational("operation.invalid-input", location);
      return;
    }
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const name = expression.expression.text;
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
    const code = helperCodes[name];
    if (code !== undefined) {
      const expectedSource = name === "corruptPackage"
        ? ["src/definition/package-store.ts", "src/substrates/sqlite/package.ts"]
        : ["corruptMaterialization", "invalidMaterializationState", "materializationRevisionConflict", "resetRequired"].includes(name)
          ? name === "corruptMaterialization"
            ? ["src/definition/materialization-store.ts", "src/substrates/sqlite/materialization.ts"]
            : ["src/substrates/sqlite/materialization.ts"]
          : ["src/definition/error.ts"];
      requireSymbolSource(expression.expression, expectedSource, location);
      recordOperational(code, location);
      return;
    }
  }
  unclassified.push(`${location} ${expression?.getText(file) ?? "empty throw"}`);
}

function requireGlobalTypeError(identifier, location) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declarations = symbol?.declarations ?? [];
  if (!declarations.some(declaration =>
      /typescript\/lib\/lib\.(?:es5|es2015\.core)\.d\.ts$/u.test(
        declaration.getSourceFile().fileName.replaceAll("\\", "/")
      ))) {
    unclassified.push(`${location} TypeError does not resolve to the TypeScript global`);
  }
}

function requireSymbolSource(identifier, expected, location) {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declarations = symbol?.declarations ?? [];
  const sources = Array.isArray(expected) ? expected : [expected];
  if (!declarations.some(declaration => sources.includes(portable(declaration.getSourceFile().fileName)))) {
    unclassified.push(`${location} ${identifier.text} does not resolve to ${sources.join(" or ")}`);
  }
}

function recordOperational(code, location) {
  counts.agentCoreOperationalThrows += 1;
  if (code === "dynamic") return;
  if (!(code in manifest.operationalCodes)) {
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
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current))
        && current.name !== undefined) return current.name.getText();
    current = current.parent;
  }
  return "module";
}

async function sourceFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (/\.ts$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name)) result.push(path);
  }
  return result;
}

function portable(path) {
  return relative(packageRoot, path).replaceAll("\\", "/");
}

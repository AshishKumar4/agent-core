import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CROSS_CONTEXT_RULE = "cross-context-import";
const RUNTIME_CYCLE_RULE = "runtime-import-cycle";
const UNVERIFIABLE_REFERENCE_RULE = "unverifiable-module-reference";
const BASELINE_VERSION = 1;
const BASELINE_WRITE_ENV = "AGENT_CORE_ALLOW_BASELINE_WRITE";
const TYPESCRIPT_EXTENSIONS = /\.(?:[cm]?ts|tsx)$/;

const scriptPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
    await main(process.argv.slice(2));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}

async function main(args) {
    const options = parseArguments(args);
    const packageRoot = options.packageRoot ?? scriptPackageRoot;
    const baselinePath =
        options.baselinePath ?? resolve(packageRoot, "artifacts/import-boundaries.json");
    const analysis = await analyze(packageRoot);
    const baseline = parseBaseline(await readFile(baselinePath, "utf8"), baselinePath);
    if (baseline.grandfatheredViolations.length !== 0) {
        throw new TypeError("Import boundary baseline must not grandfather violations");
    }

    if (options.writeBaseline) {
        if (process.env[BASELINE_WRITE_ENV] !== "1" || process.env.CI) {
            throw new TypeError(`--write-baseline requires ${BASELINE_WRITE_ENV}=1 outside CI`);
        }
        const previousViolations = new Set(baseline.grandfatheredViolations.map(baselineIdentity));
        const additions = analysis.violations.filter(
            (violation) => !previousViolations.has(baselineIdentity(violation))
        );
        if (additions.length > 0) {
            throw new TypeError(
                [
                    "Import boundary baselines are monotonic and cannot admit new violations:",
                    ...additions.map(formatViolation)
                ].join("\n")
            );
        }
        const nextBaseline = {
            version: BASELINE_VERSION,
            grandfatheredViolations: analysis.violations.map(toBaselineEntry)
        };
        await writeFile(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`, "utf8");
        console.log(
            `wrote ${nextBaseline.grandfatheredViolations.length} import boundary exceptions to ${displayPath(baselinePath, packageRoot)}`
        );
        return;
    }

    const actualByKey = new Map(
        analysis.violations.map((violation) => [baselineKey(violation), violation])
    );
    const baselineByKey = new Map();
    for (const exception of baseline.grandfatheredViolations) {
        const key = baselineKey(exception);
        if (baselineByKey.has(key))
            throw new TypeError(
                `Duplicate import boundary baseline entry: ${formatLocation(exception)}`
            );
        baselineByKey.set(key, exception);
    }

    const newViolations = analysis.violations.filter(
        (violation) => !baselineByKey.has(baselineKey(violation))
    );
    const staleExceptions = baseline.grandfatheredViolations.filter(
        (exception) => !actualByKey.has(baselineKey(exception))
    );
    if (newViolations.length > 0 || staleExceptions.length > 0) {
        const lines = ["import boundary check failed"];
        if (newViolations.length > 0) {
            lines.push("New violations (update the code, not the baseline):");
            lines.push(...newViolations.map(formatViolation));
        }
        if (staleExceptions.length > 0) {
            lines.push(
                "Stale grandfathered violations (file content, import, position, or cycle membership changed):"
            );
            lines.push(
                ...staleExceptions.map(
                    (exception) =>
                        `  ${formatLocation(exception)} ${exception.rule} ${JSON.stringify(exception.specifier)} sha256=${exception.sha256}`
                )
            );
        }
        throw new TypeError(lines.join("\n"));
    }

    console.log(
        `import boundaries verified: ${analysis.references.length} module references, ${analysis.violations.length} grandfathered violations`
    );
}

function parseArguments(args) {
    let packageRoot;
    let baselinePath;
    let writeBaseline = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--root") {
            packageRoot = resolve(requiredArgument(args, ++index, "--root"));
        } else if (argument === "--baseline") {
            baselinePath = resolve(requiredArgument(args, ++index, "--baseline"));
        } else if (argument === "--write-baseline") {
            writeBaseline = true;
        } else {
            throw new TypeError(`Unknown argument: ${argument}`);
        }
    }
    return { packageRoot, baselinePath, writeBaseline };
}

function requiredArgument(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}

async function analyze(packageRoot) {
    const srcRoot = resolve(packageRoot, "src");
    const testRoot = resolve(packageRoot, "test");
    const contextRoots = await discoverContextRoots(srcRoot);
    const moduleDirectories = await discoverModuleDirectories(srcRoot);
    const testContextByDirectory = inferTestContexts(testRoot, moduleDirectories, contextRoots);
    const filePaths = [
        ...(await collectTypeScriptFiles(srcRoot)),
        ...(await collectTypeScriptFiles(testRoot))
    ].sort();
    const sourceTexts = new Map();
    const hashes = new Map();
    for (const filePath of filePaths) {
        const sourceText = await readFile(filePath, "utf8");
        sourceTexts.set(filePath, sourceText);
        hashes.set(filePath, createHash("sha256").update(sourceText).digest("hex"));
    }

    const references = [];
    const unverifiable = [];
    for (const filePath of filePaths) {
        const sourceText = sourceTexts.get(filePath);
        const sourceFile = ts.createSourceFile(
            filePath,
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            scriptKind(filePath)
        );
        const sourceContext = contextForSource(
            filePath,
            srcRoot,
            testRoot,
            contextRoots,
            testContextByDirectory
        );
        visitSourceFile(
            sourceFile,
            (moduleSpecifier, runtime, syntax) => {
                const targetPath = resolveModule(moduleSpecifier.text, filePath);
                if (
                    targetPath === undefined ||
                    (!isWithin(targetPath, srcRoot) && !isWithin(targetPath, testRoot))
                )
                    return;
                const targetContext = contextForPath(targetPath, contextRoots);
                const position = sourceFile.getLineAndCharacterOfPosition(
                    moduleSpecifier.getStart(sourceFile)
                );
                references.push({
                    file: portablePath(relative(packageRoot, filePath)),
                    filePath,
                    sha256: hashes.get(filePath),
                    specifier: moduleSpecifier.text,
                    position: { line: position.line + 1, column: position.character + 1 },
                    runtime,
                    syntax,
                    sourceContext,
                    targetContext,
                    targetPath
                });
            },
            (node, syntax) => {
                const position = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                );
                unverifiable.push({
                    file: portablePath(relative(packageRoot, filePath)),
                    filePath,
                    sha256: hashes.get(filePath),
                    specifier: "<non-literal>",
                    position: { line: position.line + 1, column: position.character + 1 },
                    runtime: true,
                    syntax,
                    sourceContext,
                    targetContext: undefined,
                    targetPath: undefined,
                    rule: UNVERIFIABLE_REFERENCE_RULE
                });
            }
        );
    }

    const violations = [...unverifiable];
    for (const reference of references) {
        if (
            reference.targetContext === undefined ||
            reference.sourceContext === reference.targetContext
        )
            continue;
        const targetIndex = resolve(reference.targetContext, "index.ts");
        const targetInternal = resolve(reference.targetContext, "internal.ts");
        const compositionMayUseInternal =
            reference.sourceContext === resolve(srcRoot, "composition") &&
            reference.targetPath === targetInternal;
        if (reference.targetPath !== targetIndex && !compositionMayUseInternal) {
            violations.push({
                ...reference,
                rule: CROSS_CONTEXT_RULE,
                expectedTarget: portablePath(relative(packageRoot, targetIndex))
            });
        }
    }

    const runtimeSourceReferences = references.filter(
        (reference) =>
            reference.runtime &&
            reference.sourceContext !== undefined &&
            reference.targetContext !== undefined &&
            reference.sourceContext !== reference.targetContext &&
            isWithin(reference.filePath, srcRoot) &&
            isWithin(reference.targetPath, srcRoot)
    );
    const stronglyConnectedContexts = findStronglyConnectedContexts(runtimeSourceReferences);
    for (const reference of runtimeSourceReferences) {
        const component = stronglyConnectedContexts.get(reference.sourceContext);
        if (component !== undefined && component.has(reference.targetContext)) {
            violations.push({
                ...reference,
                rule: RUNTIME_CYCLE_RULE,
                cycle: [...component].map(contextName).sort()
            });
        }
    }

    violations.sort(compareViolations);
    return { references, violations };
}

function visitSourceFile(sourceFile, onReference, onUnverifiable) {
    const createdRequires = new Set(["require"]);
    const createRequireNames = new Set(["createRequire"]);
    const discoverRequires = (node) => {
        if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteralLike(node.moduleSpecifier) &&
            (node.moduleSpecifier.text === "node:module" ||
                node.moduleSpecifier.text === "module") &&
            node.importClause?.namedBindings !== undefined &&
            ts.isNamedImports(node.importClause.namedBindings)
        ) {
            for (const element of node.importClause.namedBindings.elements) {
                if ((element.propertyName ?? element.name).text === "createRequire") {
                    createRequireNames.add(element.name.text);
                }
            }
        }
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            createRequireNames.has(node.initializer.expression.text)
        ) {
            createdRequires.add(node.name.text);
        }
        ts.forEachChild(node, discoverRequires);
    };
    discoverRequires(sourceFile);

    const visit = (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
            onReference(node.moduleSpecifier, importDeclarationIsRuntime(node), "import");
        } else if (
            ts.isExportDeclaration(node) &&
            node.moduleSpecifier !== undefined &&
            ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
            onReference(node.moduleSpecifier, exportDeclarationIsRuntime(node), "re-export");
        } else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            node.moduleReference.expression !== undefined &&
            ts.isStringLiteralLike(node.moduleReference.expression)
        ) {
            onReference(node.moduleReference.expression, !node.isTypeOnly, "import-equals");
        } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
            const argument = node.arguments[0];
            if (argument !== undefined && ts.isStringLiteralLike(argument)) {
                onReference(argument, true, "dynamic-import");
            } else {
                onUnverifiable(node, "dynamic-import");
            }
        } else if (
            ts.isCallExpression(node) &&
            isRequireCall(node.expression, createdRequires, createRequireNames)
        ) {
            const argument = node.arguments[0];
            if (argument !== undefined && ts.isStringLiteralLike(argument)) {
                onReference(argument, true, "require");
            } else {
                onUnverifiable(node, "require");
            }
        } else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteralLike(node.argument.literal)
        ) {
            onReference(node.argument.literal, false, "import-type");
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
}

function isRequireCall(expression, createdRequires, createRequireNames) {
    if (ts.isIdentifier(expression)) return createdRequires.has(expression.text);
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        return createRequireNames.has(expression.expression.text);
    }
    return (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "resolve" &&
        ts.isIdentifier(expression.expression) &&
        createdRequires.has(expression.expression.text)
    );
}

function importDeclarationIsRuntime(declaration) {
    const clause = declaration.importClause;
    if (clause === undefined) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name !== undefined) return true;
    const bindings = clause.namedBindings;
    if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
    return (
        bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)
    );
}

function exportDeclarationIsRuntime(declaration) {
    if (declaration.isTypeOnly) return false;
    const clause = declaration.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return true;
    return clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly);
}

function resolveModule(specifier, sourceFile) {
    const resolvedModule = ts.resolveModuleName(
        specifier,
        sourceFile,
        {
            module: ts.ModuleKind.Preserve,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            allowImportingTsExtensions: true
        },
        ts.sys
    ).resolvedModule;
    return resolvedModule === undefined ? undefined : resolve(resolvedModule.resolvedFileName);
}

async function discoverContextRoots(srcRoot) {
    const contextRoots = [];
    for (const entry of await directoryEntries(srcRoot)) {
        if (!entry.isDirectory()) continue;
        const directory = resolve(srcRoot, entry.name);
        const entries = await directoryEntries(directory);
        if (entries.some((candidate) => candidate.isFile() && candidate.name === "index.ts")) {
            contextRoots.push(directory);
        }
    }

    return contextRoots.sort();
}

async function discoverModuleDirectories(srcRoot) {
    const moduleDirectories = [];
    const visit = async (directory) => {
        const entries = await directoryEntries(directory);
        if (entries.some((entry) => entry.isFile() && entry.name === "index.ts"))
            moduleDirectories.push(directory);
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => visit(resolve(directory, entry.name)))
        );
    };
    await visit(srcRoot);
    return moduleDirectories;
}

function inferTestContexts(testRoot, moduleDirectories, contextRoots) {
    const contextsByTestDirectory = new Map();
    for (const moduleDirectory of moduleDirectories) {
        const sourceContext = contextForPath(moduleDirectory, contextRoots);
        if (sourceContext === undefined) continue;
        const moduleName = moduleDirectory.slice(moduleDirectory.lastIndexOf(sep) + 1);
        const testDirectory = resolve(testRoot, moduleName);
        const existing = contextsByTestDirectory.get(testDirectory);
        if (existing === undefined) contextsByTestDirectory.set(testDirectory, sourceContext);
        else if (existing !== sourceContext) contextsByTestDirectory.delete(testDirectory);
    }
    return contextsByTestDirectory;
}

function contextForSource(filePath, srcRoot, testRoot, contextRoots, testContextByDirectory) {
    if (isWithin(filePath, srcRoot)) {
        const context = contextForPath(filePath, contextRoots);
        if (context !== undefined) return context;
        const relativePath = relative(srcRoot, filePath);
        if (relativePath.endsWith("-public.ts") && !relativePath.includes(sep)) {
            const contextName = relativePath.slice(0, -"-public.ts".length);
            return contextRoots.find((root) => root.endsWith(`${sep}${contextName}`));
        }
        return undefined;
    }
    if (!isWithin(filePath, testRoot)) return undefined;
    const testRelativePath = relative(testRoot, filePath);
    const firstDirectory = testRelativePath.split(sep)[0];
    if (firstDirectory === undefined || firstDirectory === testRelativePath) return undefined;
    return testContextByDirectory.get(resolve(testRoot, firstDirectory));
}

function contextForPath(filePath, contextRoots) {
    return contextRoots.find((contextRoot) => isWithin(filePath, contextRoot));
}

function findStronglyConnectedContexts(references) {
    const graph = new Map();
    for (const reference of references) {
        addGraphNode(graph, reference.sourceContext).add(reference.targetContext);
        addGraphNode(graph, reference.targetContext);
    }

    let nextIndex = 0;
    const indices = new Map();
    const lowLinks = new Map();
    const stack = [];
    const onStack = new Set();
    const cyclicComponentByContext = new Map();

    const connect = (context) => {
        const index = nextIndex;
        nextIndex += 1;
        indices.set(context, index);
        lowLinks.set(context, index);
        stack.push(context);
        onStack.add(context);

        for (const target of graph.get(context)) {
            if (!indices.has(target)) {
                connect(target);
                lowLinks.set(context, Math.min(lowLinks.get(context), lowLinks.get(target)));
            } else if (onStack.has(target)) {
                lowLinks.set(context, Math.min(lowLinks.get(context), indices.get(target)));
            }
        }

        if (lowLinks.get(context) !== indices.get(context)) return;
        const component = new Set();
        let member;
        do {
            member = stack.pop();
            onStack.delete(member);
            component.add(member);
        } while (member !== context);
        if (component.size > 1) {
            for (const componentContext of component)
                cyclicComponentByContext.set(componentContext, component);
        }
    };

    for (const context of graph.keys()) {
        if (!indices.has(context)) connect(context);
    }
    return cyclicComponentByContext;
}

function addGraphNode(graph, context) {
    let targets = graph.get(context);
    if (targets === undefined) {
        targets = new Set();
        graph.set(context, targets);
    }
    return targets;
}

async function collectTypeScriptFiles(root) {
    const files = [];
    const visit = async (directory) => {
        for (const entry of await directoryEntries(directory)) {
            const entryPath = resolve(directory, entry.name);
            if (entry.isDirectory()) await visit(entryPath);
            else if (entry.isFile() && TYPESCRIPT_EXTENSIONS.test(entry.name))
                files.push(entryPath);
        }
    };
    await visit(root);
    return files;
}

async function directoryEntries(directory) {
    try {
        return await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return [];
        throw error;
    }
}

function parseBaseline(source, baselinePath) {
    const parsed = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError(`Invalid import boundary baseline object: ${baselinePath}`);
    }
    if (parsed.version !== BASELINE_VERSION || !Array.isArray(parsed.grandfatheredViolations)) {
        throw new TypeError(
            `Import boundary baseline must have version ${BASELINE_VERSION} and a grandfatheredViolations array: ${baselinePath}`
        );
    }
    for (const entry of parsed.grandfatheredViolations) validateBaselineEntry(entry, baselinePath);
    return parsed;
}

function validateBaselineEntry(entry, baselinePath) {
    const validRule =
        entry?.rule === CROSS_CONTEXT_RULE ||
        entry?.rule === RUNTIME_CYCLE_RULE ||
        entry?.rule === UNVERIFIABLE_REFERENCE_RULE;
    const validPosition =
        Number.isInteger(entry?.position?.line) &&
        entry.position.line > 0 &&
        Number.isInteger(entry.position.column) &&
        entry.position.column > 0;
    if (
        !validRule ||
        typeof entry.file !== "string" ||
        !/^[a-f\d]{64}$/.test(entry.sha256) ||
        typeof entry.specifier !== "string" ||
        !validPosition
    ) {
        throw new TypeError(`Invalid import boundary baseline entry in ${baselinePath}`);
    }
}

function toBaselineEntry(violation) {
    return {
        rule: violation.rule,
        file: violation.file,
        sha256: violation.sha256,
        specifier: violation.specifier,
        position: violation.position
    };
}

function baselineKey(entry) {
    return [
        entry.rule,
        entry.file,
        entry.sha256,
        entry.specifier,
        entry.position.line,
        entry.position.column
    ].join("\0");
}

function baselineIdentity(entry) {
    return [
        entry.rule,
        entry.file,
        entry.specifier,
        entry.position.line,
        entry.position.column
    ].join("\0");
}

function compareViolations(left, right) {
    return (
        left.file.localeCompare(right.file) ||
        left.position.line - right.position.line ||
        left.position.column - right.position.column ||
        left.rule.localeCompare(right.rule) ||
        left.specifier.localeCompare(right.specifier)
    );
}

function formatViolation(violation) {
    if (violation.rule === CROSS_CONTEXT_RULE) {
        return `  ${formatLocation(violation)} [${violation.rule}] ${violation.syntax} ${JSON.stringify(violation.specifier)} crosses into ${contextName(violation.targetContext)}; target ${violation.expectedTarget}`;
    }
    if (violation.rule === UNVERIFIABLE_REFERENCE_RULE) {
        return `  ${formatLocation(violation)} [${violation.rule}] ${violation.syntax} must use a string literal`;
    }
    return `  ${formatLocation(violation)} [${violation.rule}] runtime ${violation.syntax} ${JSON.stringify(violation.specifier)} participates in context cycle: ${violation.cycle.join(" -> ")}`;
}

function formatLocation(entry) {
    return `${entry.file}:${entry.position.line}:${entry.position.column}`;
}

function contextName(contextRoot) {
    const portableContext = portablePath(contextRoot);
    const sourceMarker = "/src/";
    const sourceIndex = portableContext.lastIndexOf(sourceMarker);
    return sourceIndex === -1
        ? portableContext
        : portableContext.slice(sourceIndex + sourceMarker.length);
}

function displayPath(filePath, packageRoot) {
    const displayed = relative(packageRoot, filePath);
    return displayed.startsWith("..") ? filePath : portablePath(displayed);
}

function isWithin(filePath, directory) {
    const pathFromDirectory = relative(directory, filePath);
    return (
        pathFromDirectory === "" ||
        (!pathFromDirectory.startsWith(`..${sep}`) && pathFromDirectory !== "..")
    );
}

function portablePath(filePath) {
    return filePath.split(sep).join("/");
}

function scriptKind(filePath) {
    if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
    if (filePath.endsWith(".mts")) return ts.ScriptKind.TS;
    if (filePath.endsWith(".cts")) return ts.ScriptKind.TS;
    return ts.ScriptKind.TS;
}

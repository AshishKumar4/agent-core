import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { packageRoot, parseCanonicalJson, portablePath, reportRoot, repositoryRoot } from "./project.mjs";

export function createProgram() {
    const roots = [packageRoot, resolve(repositoryRoot, "packages/agent-core-cloudflare")];
    const parsed = roots.map((root) => {
        const configPath = resolve(root, "tsconfig.json");
        const config = ts.readConfigFile(configPath, ts.sys.readFile);
        if (config.error)
            throw new TypeError(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
        return ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    });
    return ts.createProgram([...new Set(parsed.flatMap((config) => config.fileNames))], {
        ...parsed[0].options,
        skipLibCheck: true
    });
}

export function resolveSourceSymbol(program, selector) {
    locateSourceSymbol(selector, (path) => program.getSourceFile(path));
}

/**
 * The 1-based line span of the declaration a source symbol selects — the member's span
 * when the selector names one, the whole declaration otherwise. Resolution and staleness
 * semantics are exactly resolveSourceSymbol's.
 */
export function sourceSymbolLines(selector, getSourceFile = () => undefined) {
    const { source, node } = locateSourceSymbol(selector, getSourceFile);
    return {
        startLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        endLine: source.getLineAndCharacterOfPosition(node.end).line + 1
    };
}

function locateSourceSymbol(selector, getSourceFile) {
    const separator = selector.indexOf("#");
    if (separator < 1) throw new TypeError(`Invalid source symbol ${selector}`);
    const selectedPath = selector.slice(0, separator);
    const cloudflare = selectedPath.startsWith("cloudflare/");
    const relativePath = cloudflare ? selectedPath.slice("cloudflare/".length) : selectedPath;
    if (
        (!relativePath.startsWith("src/") && !relativePath.startsWith("scripts/")) ||
        relativePath.includes("..")
    ) {
        throw new TypeError(`Source symbol must stay inside source roots: ${selector}`);
    }
    const selectedRoot = cloudflare
        ? resolve(repositoryRoot, "packages/agent-core-cloudflare")
        : packageRoot;
    const path = resolve(selectedRoot, relativePath);
    const sourceRoot = resolve(selectedRoot, relativePath.startsWith("src/") ? "src" : "scripts");
    const offset = relative(sourceRoot, path);
    if (offset === ".." || offset.startsWith(`..${sep}`)) {
        throw new TypeError(`Source symbol escapes its source root: ${selector}`);
    }
    const symbol = selector.slice(separator + 1);
    const parts = symbol.split(".");
    if (parts.length > 2 || parts.some((part) => part.length === 0)) {
        throw new TypeError(
            `Source symbol must identify one top-level declaration and optional member: ${selector}`
        );
    }
    const source =
        getSourceFile(path) ??
        (ts.sys.fileExists(path)
            ? ts.createSourceFile(
                  path,
                  ts.sys.readFile(path),
                  ts.ScriptTarget.Latest,
                  true,
                  path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS
              )
            : undefined);
    if (source === undefined) throw new TypeError(`Missing source file for ${selector}`);
    const declaration = source.statements.find(
        (node) =>
            (ts.isClassDeclaration(node) ||
                ts.isInterfaceDeclaration(node) ||
                ts.isFunctionDeclaration(node) ||
                ts.isTypeAliasDeclaration(node)) &&
            node.name?.text === parts[0]
    );
    const variable = source.statements
        .filter(ts.isVariableStatement)
        .flatMap((statement) => statement.declarationList.declarations)
        .find((node) => ts.isIdentifier(node.name) && node.name.text === parts[0]);
    const node =
        declaration !== undefined
            ? parts[1] === undefined
                ? declaration
                : "members" in declaration
                  ? declaration.members.find(
                        (candidate) => candidate.name?.getText(source) === parts[1]
                    )
                  : undefined
            : parts[1] === undefined
              ? variable
              : undefined;
    if (node === undefined) throw new TypeError(`Stale source symbol ${selector}`);
    return { source, node };
}

export async function executedTestSelectors(path) {
    const coreReport = resolve(reportRoot, "tests/vitest.json");
    const paths =
        path === undefined
            ? [
                  coreReport,
                  resolve(
                      packageRoot,
                      "../agent-core-cloudflare/reports/quality/tests/structural.json"
                  ),
                  resolve(
                      packageRoot,
                      "../agent-core-cloudflare/reports/quality/tests/workers.json"
                  )
              ]
            : Array.isArray(path)
              ? path
              : [path];
    const selectors = new Set();
    for (const reportPath of paths) {
        let report;
        try {
            report = parseCanonicalJson(await readFile(reportPath, "utf8"), portablePath(reportPath));
        } catch (error) {
            if (path === undefined && reportPath !== coreReport && error?.code === "ENOENT")
                continue;
            throw error;
        }
        validateTestReport(report, reportPath, false);
        for (const result of report.testResults ?? []) {
            const marker = result.name.includes("/packages/")
                ? result.name.slice(result.name.indexOf("/packages/") + 1)
                : result.name;
            const testPath = marker.startsWith("packages/agent-core/")
                ? marker.slice("packages/agent-core/".length)
                : marker.startsWith("packages/agent-core-cloudflare/")
                  ? `cloudflare/${marker.slice("packages/agent-core-cloudflare/".length)}`
                  : marker;
            for (const assertion of result.assertionResults ?? []) {
                if (["pending", "skipped", "todo"].includes(assertion.status)) {
                    throw new TypeError(`Evidence test is not executable: ${assertion.fullName}`);
                }
                if (assertion.status === "passed")
                    selectors.add(`${testPath}#${assertion.fullName}`);
            }
        }
    }
    return selectors;
}

export async function requireSuccessfulTestReport(path, requireTests = true) {
    const report = parseCanonicalJson(await readFile(path, "utf8"), portablePath(path));
    validateTestReport(report, path, requireTests);
    return report;
}

export function requirePassingTests(selectors, executed, owner) {
    for (const selector of selectors) {
        if (!executed.has(selector)) throw new TypeError(`${owner} test did not pass: ${selector}`);
    }
}

function validateTestReport(report, path, requireTests) {
    if (report.success !== true) throw new TypeError(`Test report is not successful: ${path}`);
    if (
        !Number.isSafeInteger(report.numTotalTests) ||
        report.numTotalTests < 0 ||
        !Number.isSafeInteger(report.numPassedTests) ||
        !Number.isSafeInteger(report.numFailedTests) ||
        !Number.isSafeInteger(report.numPendingTests) ||
        !Number.isSafeInteger(report.numTodoTests) ||
        report.numPassedTests !== report.numTotalTests ||
        report.numFailedTests !== 0 ||
        report.numPendingTests !== 0 ||
        report.numTodoTests !== 0 ||
        (requireTests && report.numPassedTests === 0)
    ) {
        throw new TypeError(`Test report is not completely executable and passing: ${path}`);
    }
}

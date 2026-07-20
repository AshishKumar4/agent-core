import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { collectFiles, packageRoot, portable, reportRoot, writeCanonicalJson } from "./project.mjs";
import { TEST_PRIORITIES as priorities } from "./test-priority-evidence.mjs";

export async function discoverPriorityTestFiles() {
    const files = await collectFiles(resolve(packageRoot, "test"), (path) => path.endsWith(".ts"));
    const discovered = Object.fromEntries(priorities.map((priority) => [priority, []]));
    const filePriorities = new Map();
    const imports = new Map();
    const knownFiles = new Set(files.map((path) => portable(relative(packageRoot, path))));
    for (const path of files) {
        const selectedPath = portable(relative(packageRoot, path));
        const source = ts.createSourceFile(
            path,
            await readFile(path, "utf8"),
            ts.ScriptTarget.Latest,
            true
        );
        const inFile = new Set();
        const dependencies = new Set();
        const visit = (node) => {
            if (ts.isCallExpression(node) && isTestDeclaration(node.expression)) {
                for (const priority of declaredPriorities(node.arguments[1])) inFile.add(priority);
            }
            if (
                ts.isImportDeclaration(node) &&
                ts.isStringLiteral(node.moduleSpecifier) &&
                node.moduleSpecifier.text.startsWith(".")
            ) {
                const target = posix.normalize(
                    posix.join(posix.dirname(selectedPath), node.moduleSpecifier.text)
                );
                for (const candidate of [`${target}.ts`, `${target}/index.ts`, target]) {
                    if (knownFiles.has(candidate)) dependencies.add(candidate);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        filePriorities.set(selectedPath, inFile);
        imports.set(selectedPath, dependencies);
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const [path, dependencies] of imports) {
            const selected = filePriorities.get(path);
            for (const dependency of dependencies) {
                for (const priority of filePriorities.get(dependency) ?? []) {
                    if (!selected.has(priority)) {
                        selected.add(priority);
                        changed = true;
                    }
                }
            }
        }
    }
    for (const [path, selected] of filePriorities) {
        if (!path.endsWith(".test.ts")) continue;
        for (const priority of selected) discovered[priority].push(path);
    }
    return discovered;
}

export function validatePriorityLanes(lanes) {
    requireExactLaneKeys(lanes);
    const selectors = new Set();
    const counts = {};
    for (const priority of priorities) {
        const assertions = reportAssertions(lanes[priority], priority);
        if (assertions.length === 0) {
            throw new TypeError(`${priority.toUpperCase()} lane is empty`);
        }
        for (const assertion of assertions) {
            const selected = assertionPriority(assertion);
            if (selected !== priority) {
                throw new TypeError(
                    `${priority.toUpperCase()} lane contains ${selected?.toUpperCase() ?? "unclassified"} evidence: ${assertion.selector}`
                );
            }
            if (selectors.has(assertion.selector)) {
                throw new TypeError(`Priority lanes overlap at ${assertion.selector}`);
            }
            selectors.add(assertion.selector);
        }
        counts[priority] = assertions.length;
    }
    return counts;
}

export function validatePriorityEvidence(fullReport, lanes, stage, options = {}) {
    if (stage !== "building" && stage !== "final") {
        throw new TypeError(`Unknown priority evidence stage ${stage}`);
    }
    const counts = validatePriorityLanes(lanes);
    const laneEvidence = new Map();
    for (const priority of priorities) {
        for (const assertion of reportAssertions(lanes[priority], priority)) {
            laneEvidence.set(assertion.selector, priority);
        }
    }

    let unclassified = 0;
    const fullSelectors = new Set();
    for (const assertion of reportAssertions(fullReport)) {
        if (fullSelectors.has(assertion.selector)) {
            throw new TypeError(`Full test evidence repeats selector ${assertion.selector}`);
        }
        fullSelectors.add(assertion.selector);
        const priority = assertionPriority(assertion);
        if (priority === undefined) {
            unclassified += 1;
            continue;
        }
        if (laneEvidence.get(assertion.selector) !== priority) {
            throw new TypeError(
                `Tagged test is absent from its ${priority.toUpperCase()} lane: ${assertion.selector}`
            );
        }
    }
    for (const selector of laneEvidence.keys()) {
        if (!fullSelectors.has(selector)) {
            throw new TypeError(`Priority lane evidence is absent from the full run: ${selector}`);
        }
    }
    if (stage === "final" && options.requireCompleteClassification !== false && unclassified > 0) {
        throw new TypeError(`Final test evidence contains ${unclassified} unclassified assertions`);
    }
    if (unclassified > 0) {
        console.log(`note: ${unclassified} assertions are not yet priority-classified`);
    }
    return { ...counts, unclassified };
}

function reportAssertions(report, selectedPriority) {
    if (
        report?.success !== true ||
        !Number.isSafeInteger(report.numTotalTests) ||
        !Number.isSafeInteger(report.numPassedTests) ||
        report.numFailedTests !== 0 ||
        report.numTodoTests !== 0 ||
        !Array.isArray(report.testResults)
    ) {
        throw new TypeError("Priority evidence report is not completely passing");
    }
    const assertions = [];
    let total = 0;
    let passed = 0;
    let pending = 0;
    for (const result of report.testResults) {
        if (typeof result?.name !== "string" || !Array.isArray(result.assertionResults)) {
            throw new TypeError("Priority evidence report has malformed test results");
        }
        const path = reportPath(result.name);
        for (const assertion of result.assertionResults) {
            total += 1;
            if (
                (assertion?.status !== "passed" && assertion?.status !== "skipped") ||
                typeof assertion.fullName !== "string" ||
                assertion.fullName.length === 0 ||
                !Array.isArray(assertion.tags) ||
                assertion.tags.some((tag) => !priorities.includes(tag)) ||
                new Set(assertion.tags).size !== assertion.tags.length
            ) {
                throw new TypeError(`Priority assertion is malformed: ${path}`);
            }
            if (assertion.status === "skipped") {
                pending += 1;
                if (selectedPriority === undefined || assertion.tags.includes(selectedPriority)) {
                    throw new TypeError(`Selected priority assertion did not execute: ${path}`);
                }
                continue;
            }
            passed += 1;
            assertions.push({
                selector: `${path}#${assertion.fullName}`,
                tags: assertion.tags
            });
        }
    }
    if (
        total !== report.numTotalTests ||
        passed !== report.numPassedTests ||
        pending !== report.numPendingTests
    ) {
        throw new TypeError("Priority report test count does not match its assertions");
    }
    return assertions;
}

function assertionPriority(assertion) {
    const selected = assertion.tags.filter((tag) => priorities.includes(tag));
    if (selected.length > 1) {
        throw new TypeError(`Test must have exactly one priority: ${assertion.selector}`);
    }
    return selected[0];
}

function reportPath(path) {
    const marker = path.includes("/packages/") ? path.slice(path.indexOf("/packages/") + 1) : path;
    return marker.startsWith("packages/agent-core/")
        ? marker.slice("packages/agent-core/".length)
        : marker;
}

function requireExactLaneKeys(lanes) {
    if (lanes === null || typeof lanes !== "object" || Array.isArray(lanes)) {
        throw new TypeError("Priority lanes must be an object");
    }
    const actual = Object.keys(lanes).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...priorities].sort())) {
        throw new TypeError("Priority lanes must contain exactly P0, P1, and P2 reports");
    }
}

function isTestDeclaration(expression) {
    if (ts.isIdentifier(expression))
        return expression.text === "test" || expression.text === "it" || expression.text === "describe";
    if (!ts.isPropertyAccessExpression(expression)) return false;
    return isTestDeclaration(expression.expression);
}

function declaredPriorities(options) {
    if (options === undefined || !ts.isObjectLiteralExpression(options)) return [];
    const property = options.properties.find(
        (candidate) =>
            ts.isPropertyAssignment(candidate) &&
            ((ts.isIdentifier(candidate.name) && candidate.name.text === "tags") ||
                (ts.isStringLiteral(candidate.name) && candidate.name.text === "tags"))
    );
    if (property === undefined || !ts.isPropertyAssignment(property)) return [];
    const value = property.initializer;
    const tags = ts.isStringLiteral(value)
        ? [value.text]
        : ts.isArrayLiteralExpression(value)
          ? value.elements.filter(ts.isStringLiteral).map((element) => element.text)
          : [];
    return tags.filter((tag) => priorities.includes(tag));
}

async function main() {
    const stage = parseStage(process.argv.slice(2));
    const tests = resolve(reportRoot, "tests");
    const full = await readJson(resolve(tests, "vitest.json"));
    const lanes = Object.fromEntries(
        await Promise.all(
            priorities.map(async (priority) => [
                priority,
                await readJson(resolve(tests, `priority-${priority}.json`))
            ])
        )
    );
    const counts = validatePriorityEvidence(full, lanes, stage, {
        // Complete tagging is a campaign: demanded only once the SPEC conformance
        // stage is declared final; until then the count is reported as a note.
        requireCompleteClassification:
            JSON.parse(
                readFileSync(resolve(packageRoot, "artifacts/conformance/stage.json"), "utf8")
            ).stage === "final"
    });
    await writeCanonicalJson(resolve(reportRoot, "test-priorities.json"), {
        edition: "1.0.0",
        stage,
        ...counts,
        selectors: Object.fromEntries(
            priorities.map((priority) => [
                priority,
                reportAssertions(lanes[priority], priority)
                    .map((assertion) => assertion.selector)
                    .sort()
            ])
        )
    });
    console.log(
        `Behavioral priority evidence: P0 ${counts.p0}, P1 ${counts.p1}, P2 ${counts.p2}, unclassified ${counts.unclassified}`
    );
}

async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}

function parseStage(args) {
    if (args.length !== 2 || args[0] !== "--stage") {
        throw new TypeError("test-priorities requires --stage building|final");
    }
    if (args[1] !== "building" && args[1] !== "final") {
        throw new TypeError(`Unknown priority evidence stage ${args[1]}`);
    }
    return args[1];
}

const invoked =
    process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) await main();

import { createHash } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const packageRoot = resolve(import.meta.dirname, "../..");
export const oracleEvidenceDirectoryEnvironment = "AGENT_CORE_ORACLE_EVIDENCE_DIRECTORY";
export const oracleEvidenceTestPathEnvironment = "AGENT_CORE_ORACLE_EVIDENCE_TEST_PATH";
export const contractEvidenceDirectoryEnvironment = "AGENT_CORE_CONTRACT_EVIDENCE_DIRECTORY";
export const contractEvidenceTestPathEnvironment = "AGENT_CORE_CONTRACT_EVIDENCE_TEST_PATH";

type JsonData = null | boolean | number | string | JsonData[] | JsonRecord;
type JsonRecord = { readonly [key: string]: JsonData };

export interface OracleExecutionEvidence {
    readonly testPath: string;
    readonly operations: ReadonlySet<string>;
}

export interface ContractExecutionEvidence {
    readonly edition: "1.0.0";
    readonly testPath: string;
    readonly suite: string;
    readonly backing: string;
}

function assertRecord(value: unknown, location: string): asserts value is JsonRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${location} must be an object`);
    }
}

function exactOperations(value: JsonData | undefined, location: string): string[] {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isNonemptyString)) {
        throw new TypeError(`${location} must be a nonempty operation array`);
    }
    const sorted = [...value].sort(codePointOrder);
    if (new Set(value).size !== value.length || JSON.stringify(value) !== JSON.stringify(sorted)) {
        throw new TypeError(`${location} must be unique and canonically ordered`);
    }
    return value;
}

export function oracleExecutionManifest(source: string, location: string): OracleExecutionEvidence {
    const decoded: unknown = JSON.parse(source);
    assertRecord(decoded, location);
    const keys = Object.keys(decoded).sort(codePointOrder);
    if (
        JSON.stringify(keys) !==
        JSON.stringify(["edition", "expectedOperations", "observedOperations", "testPath"])
    ) {
        throw new TypeError(`${location} has unexpected keys`);
    }
    if (decoded["edition"] !== "1.0.0") {
        throw new TypeError(`${location}.edition must be 1.0.0`);
    }
    const testPath = decoded["testPath"];
    if (!isDifferentialTestPath(testPath)) {
        throw new TypeError(`${location}.testPath must name a differential test`);
    }
    const expected = exactOperations(
        decoded["expectedOperations"],
        `${location}.expectedOperations`
    );
    const observed = exactOperations(
        decoded["observedOperations"],
        `${location}.observedOperations`
    );
    if (JSON.stringify(expected) !== JSON.stringify(observed)) {
        throw new TypeError(`${location} did not execute its exact oracle operations`);
    }
    return { testPath, operations: new Set(expected) };
}

export function contractExecutionManifest(
    source: string,
    location: string
): ContractExecutionEvidence {
    const decoded: unknown = JSON.parse(source);
    assertRecord(decoded, location);
    const keys = Object.keys(decoded).sort(codePointOrder);
    if (JSON.stringify(keys) !== JSON.stringify(["backing", "edition", "suite", "testPath"])) {
        throw new TypeError(`${location} has unexpected keys`);
    }
    if (decoded["edition"] !== "1.0.0") {
        throw new TypeError(`${location}.edition must be 1.0.0`);
    }
    const testPath = decoded["testPath"];
    if (!isTestPath(testPath)) {
        throw new TypeError(`${location}.testPath must name a test`);
    }
    const suite = canonicalLabel(decoded["suite"], `${location}.suite`);
    const backing = canonicalLabel(decoded["backing"], `${location}.backing`);
    return { edition: "1.0.0", testPath, suite, backing };
}

export function recordContractExecution(suite: string, backing: string): void {
    const directory = process.env[contractEvidenceDirectoryEnvironment];
    const testPath = process.env[contractEvidenceTestPathEnvironment];
    if (directory === undefined && testPath === undefined) return;
    if (directory === undefined || directory.length === 0 || !isTestPath(testPath)) {
        throw new TypeError("Contract execution evidence environment is incomplete");
    }
    const evidence: ContractExecutionEvidence = {
        edition: "1.0.0",
        testPath,
        suite: canonicalLabel(suite, "Contract suite"),
        backing: canonicalLabel(backing, "Contract backing")
    };
    const identity = `${testPath}\n${evidence.suite}\n${evidence.backing}`;
    const name = `${createHash("sha256").update(identity).digest("hex")}.json`;
    writeFileSync(resolve(directory, name), `${JSON.stringify(evidence)}\n`, {
        encoding: "utf8",
        flag: "wx"
    });
}

export function exactEvidencePath(root: string, path: string): string {
    const resolvedRoot = resolve(root);
    const resolved = resolve(resolvedRoot, path);
    if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${sep}`)) {
        throw new TypeError(`Evidence path escapes its root: ${path}`);
    }
    if (!existsSync(resolved)) {
        throw new TypeError(`Evidence path is missing: ${path}`);
    }
    if (realpathSync(resolved) !== resolved) {
        throw new TypeError(`Evidence path is a symbolic-link evidence path: ${path}`);
    }
    return resolved;
}

export function passingTestPaths(source: string, location: string): ReadonlySet<string> {
    const decoded: unknown = JSON.parse(source);
    assertRecord(decoded, location);
    if (
        decoded["success"] !== true ||
        !Number.isSafeInteger(decoded["numTotalTests"]) ||
        decoded["numTotalTests"] !== decoded["numPassedTests"] ||
        decoded["numFailedTests"] !== 0 ||
        decoded["numPendingTests"] !== 0 ||
        decoded["numTodoTests"] !== 0
    ) {
        throw new TypeError(`${location} must be a complete passing test report`);
    }
    const results = decoded["testResults"];
    if (!Array.isArray(results) || results.length === 0) {
        throw new TypeError(`${location}.testResults must be nonempty`);
    }
    const paths = new Set<string>();
    let assertions = 0;
    for (const [index, value] of results.entries()) {
        assertRecord(value, `${location}.testResults[${index}]`);
        const name = value["name"];
        const resultAssertions = value["assertionResults"];
        if (value["status"] !== "passed" || !isNonemptyString(name)) {
            throw new TypeError(`${location}.testResults[${index}] did not pass`);
        }
        if (!Array.isArray(resultAssertions) || resultAssertions.length === 0) {
            throw new TypeError(`${location}.testResults[${index}] has no assertions`);
        }
        for (const assertion of resultAssertions) {
            assertRecord(assertion, `${location}.testResults[${index}].assertion`);
            if (assertion["status"] !== "passed") {
                throw new TypeError(`${location}.testResults[${index}] has a failed assertion`);
            }
            assertions += 1;
        }
        const path = portable(relative(packageRoot, name));
        if (!isTestPath(path) || paths.has(path)) {
            throw new TypeError(`${location} has an invalid or duplicate test path`);
        }
        paths.add(path);
    }
    if (assertions !== decoded["numTotalTests"]) {
        throw new TypeError(`${location} test totals do not match its assertions`);
    }
    return paths;
}

export function isDifferentialTestPath(value: unknown): value is string {
    return isTestPath(value) && value.startsWith("test/differential/");
}

function canonicalLabel(value: JsonData | undefined, location: string): string {
    if (!isNonemptyString(value) || value.trim() !== value) {
        throw new TypeError(`${location} must be nonempty and canonical`);
    }
    return value;
}

function isTestPath(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.startsWith("test/") &&
        value.endsWith(".test.ts") &&
        !value.includes("\\") &&
        value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
    );
}

function isNonemptyString(value: JsonData | undefined): value is string {
    return typeof value === "string" && value.length > 0;
}

function portable(path: string): string {
    return path.replaceAll("\\", "/");
}

function codePointOrder(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

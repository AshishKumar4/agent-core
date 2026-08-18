import { isNonEmptyString } from "./project.mjs";

type JsonData = null | boolean | number | string | JsonData[] | JsonRecord;
type JsonRecord = { readonly [key: string]: JsonData };

function assertJsonRecord(value: unknown, location: string): asserts value is JsonRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${location} must be an object`);
    }
}

export function oracleOperationManifest(
    source: string,
    path: string
): ReadonlyMap<string, ReadonlySet<string>> {
    const decoded: unknown = JSON.parse(source);
    if (!Array.isArray(decoded) || decoded.length === 0) {
        throw new TypeError(`${path} must be a nonempty operation array`);
    }
    const manifest = new Map<string, ReadonlySet<string>>();
    for (const [index, value] of decoded.entries()) {
        assertJsonRecord(value, `${path}[${index}]`);
        const keys = Object.keys(value).sort();
        if (JSON.stringify(keys) !== JSON.stringify(["definitions", "op"])) {
            throw new TypeError(`${path}[${index}] keys must be exactly: definitions, op`);
        }
        const operation = value["op"];
        const definitions = value["definitions"];
        if (
            !isNonEmptyString(operation) ||
            !Array.isArray(definitions) ||
            definitions.length === 0
        ) {
            throw new TypeError(`${path}[${index}] must name an operation and definitions`);
        }
        if (!definitions.every(isNonEmptyString)) {
            throw new TypeError(`${path}[${index}].definitions must contain only names`);
        }
        const unique = new Set(definitions);
        if (unique.size !== definitions.length) {
            throw new TypeError(`${path}[${index}] repeats a definition`);
        }
        if (manifest.has(operation)) throw new TypeError(`${path} repeats operation ${operation}`);
        manifest.set(operation, unique);
    }
    return manifest;
}

export function deployedVersionIds(source: string, path: string): ReadonlySet<string> {
    const report: unknown = JSON.parse(source);
    assertJsonRecord(report, path);
    const deployments = report["deployments"];
    if (!Array.isArray(deployments)) throw new TypeError(`${path}.deployments must be an array`);
    const versions = new Set<string>();
    for (const [index, value] of deployments.entries()) {
        assertJsonRecord(value, `${path}.deployments[${index}]`);
        const version = value["versionId"];
        if (!isNonEmptyString(version)) {
            throw new TypeError(`${path}.deployments[${index}].versionId must be nonempty`);
        }
        if (versions.has(version)) throw new TypeError(`${path} repeats version ${version}`);
        versions.add(version);
    }
    return versions;
}

export function passingLiveAtoms(source: string, path: string): ReadonlySet<string> {
    const report: unknown = JSON.parse(source);
    assertJsonRecord(report, path);
    if (
        report["success"] !== true ||
        !Number.isSafeInteger(report["numTotalTests"]) ||
        report["numTotalTests"] !== report["numPassedTests"] ||
        report["numFailedTests"] !== 0 ||
        report["numPendingTests"] !== 0 ||
        report["numTodoTests"] !== 0
    ) {
        throw new TypeError(`${path} must be a complete passing test report`);
    }
    const results = report["testResults"];
    if (!Array.isArray(results)) throw new TypeError(`${path}.testResults must be an array`);
    const atoms = new Set<string>();
    let assertionCount = 0;
    for (const [resultIndex, value] of results.entries()) {
        assertJsonRecord(value, `${path}.testResults[${resultIndex}]`);
        const assertions = value["assertionResults"];
        if (!Array.isArray(assertions)) {
            throw new TypeError(
                `${path}.testResults[${resultIndex}].assertionResults must be an array`
            );
        }
        for (const [assertionIndex, assertionValue] of assertions.entries()) {
            assertionCount += 1;
            assertJsonRecord(
                assertionValue,
                `${path}.testResults[${resultIndex}].assertionResults[${assertionIndex}]`
            );
            if (assertionValue["status"] !== "passed") {
                throw new TypeError(`${path} contains an assertion that did not pass`);
            }
            const title = assertionValue["title"];
            if (!isNonEmptyString(title)) {
                throw new TypeError(`${path} contains a passing assertion without a title`);
            }
            const match = /^\[([A-Z][A-Z0-9-]+)\](?: |$)/u.exec(title);
            const atom = match?.[1];
            if (atom !== undefined) atoms.add(atom);
        }
    }
    if (assertionCount !== report["numTotalTests"]) {
        throw new TypeError(`${path} test totals do not match its assertions`);
    }
    return atoms;
}

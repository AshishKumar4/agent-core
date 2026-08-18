// Discrimination gate: conformance evidence must discriminate, not merely exist.
//
// The ledger proves a verified atom's cited tests exist and pass; it cannot tell a
// test that proves the rule from one that merely runs nearby. This gate demands the
// missing direction: for an atom citing source symbol S and test T, recorded evidence
// that T actually constrains S — at least one mutant of S that T killed.
//
// Evidence comes from the per-area attribution artifacts mutation.mjs writes at
// measure time (artifacts/quality/discrimination/<area>.json). Only kills are
// consumed: a kill is recorded because the test really failed under the mutant,
// whereas survival is unreliable — perTest coverage attribution provably produces
// phantom survivors (docs/MUTATION-SYSTEM-REVIEW.md). Absence of a kill therefore
// only leaves an atom in the ratcheted debt baseline; it never asserts that a test
// fails to discriminate.
//
// A kill counts at symbol tier when the mutated file still hashes to its measured
// content and a killed line falls inside the cited declaration; when the file has
// changed since measurement the recorded lines no longer locate symbols and the kill
// degrades to file tier — the cited test failed when the cited file was broken. A
// fresh file whose kills all fall outside the cited symbol is exactly the "nearby
// test" defect and counts for nothing.
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { sourceFile } from "./compiler.mjs";
import {
    artifactRoot,
    assertExactKeys,
    assertString,
    assertUniqueStrings,
    collectFiles,
    compareCanonicalText,
    packageRoot,
    portable,
    readCanonicalJson,
    reportRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";
import { sourceSymbolLines } from "./evidence.mjs";
import { mutationTestFiles, sourceAreas } from "./mutation-inputs.mjs";

const options = parseArguments(process.argv.slice(2));
const requirements = await conformanceRequirements(options.artifactRoot);
const attribution = await loadAttribution(resolve(options.artifactRoot, "quality/discrimination"));
const mutationLanes = new Set(
    mutationTestFiles().map((path) => portable(relative(packageRoot, path)))
);
const issues = [];
const kinds = { live: [], infrastructure: [], noMutants: [], unmutableTests: [], mutation: [] };
const discriminated = { symbol: [], file: [] };
const sourceHashes = new Map();
const symbolSpans = new Map();
const parsedSources = new Map();

for (const requirement of requirements.filter((item) => item.status === "verified")) {
    const kind = await classify(requirement);
    kinds[kind].push(requirement.id);
    if (kind === "unmutableTests") {
        issue(
            "DISC-LANE",
            requirement.fragment,
            requirement.id,
            `Verified ${requirement.id} cites only tests excluded from mutation runs; its evidence can never demonstrate discrimination`
        );
        continue;
    }
    if (kind !== "mutation") continue;
    const tier = await discriminationTier(requirement);
    if (tier === "unmeasured") {
        issue(
            "DISC-STALE",
            requirement.fragment,
            requirement.id,
            `Verified ${requirement.id} cites sources or tests with no attribution from the last mutation run; re-measure before judging its discrimination`
        );
    } else if (tier === undefined) {
        issue(
            "DISC-ATOM",
            requirement.fragment,
            requirement.id,
            `Verified ${requirement.id} has no recorded mutant of its sources killed by a cited test`
        );
    } else {
        discriminated[tier].push(requirement.id);
    }
}

issues.sort((left, right) => compareCanonicalText(left.fingerprint, right.fingerprint));
const baseline = await loadBaseline(options.baseline);
const baselineFingerprints = new Set(baseline.issues.map((item) => item.fingerprint));
const currentFingerprints = new Set(issues.map((item) => item.fingerprint));
const additions = issues.filter((item) => !baselineFingerprints.has(item.fingerprint));
const resolved = baseline.issues.filter((item) => !currentFingerprints.has(item.fingerprint));
const report = {
    stage: options.stage,
    atoms: {
        verified: Object.values(kinds).reduce((total, ids) => total + ids.length, 0),
        live: kinds.live.sort(),
        infrastructure: kinds.infrastructure.sort(),
        noMutants: kinds.noMutants.sort(),
        unmutableTests: kinds.unmutableTests.sort(),
        mutation: kinds.mutation.length
    },
    discriminated: { symbol: discriminated.symbol.sort(), file: discriminated.file.sort() },
    issues,
    additions,
    resolved,
    complete: issues.length === 0
};

if (options.writeBaseline) {
    if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
        throw new TypeError(
            "Writing the discrimination baseline requires QUALITY_WRITE_BASELINE=1 outside CI"
        );
    }
    await writeCanonicalJson(options.baseline, { edition: "1.0.0", issues });
} else {
    await writeCanonicalJson(resolve(reportRoot, "discrimination.json"), report);
    if (additions.length > 0) fail("New undiscriminated conformance evidence", additions);
    // The baseline is debt, not a permanent allowance: a finding that no longer
    // reproduces must leave it, or the gate silently re-accepts the defect when it
    // returns.
    if (resolved.length > 0) fail("Discrimination baseline retains resolved findings", resolved);
    if (options.stage === "final" && issues.length > 0)
        fail("Final discrimination violations", issues);
    console.log(
        `discrimination ${report.complete ? "complete" : "incomplete"}: ` +
            `${discriminated.symbol.length} symbol + ${discriminated.file.length} file tier ` +
            `of ${kinds.mutation.length} mutation-kind atoms, ${issues.length} issue(s)`
    );
}

/**
 * Exactly one computed evidence kind per verified atom, so exemptions are enumerable
 * and never silent: live substrate scenarios and cloudflare-lane tests have no core
 * mutants, checker infrastructure under scripts/ is never mutated, and freshly
 * measured files with zero mutants (re-export barrels) have nothing to kill.
 */
async function classify(requirement) {
    const coreTests = requirement.testSelectors.filter(
        (selector) => !selector.startsWith("cloudflare/")
    );
    if (requirement.checkerInvariants.includes("ACQ-LIVE") || coreTests.length === 0) {
        return "live";
    }
    const coreFiles = requirement.sourceSymbols
        .filter((symbol) => symbol.startsWith("src/"))
        .map((symbol) => symbol.slice(0, symbol.indexOf("#")));
    if (coreFiles.length === 0) return "infrastructure";
    if (coreTests.every((selector) => !mutationLanes.has(testPath(selector)))) {
        return "unmutableTests";
    }
    const measurements = await Promise.all(
        coreFiles.map(async (file) => {
            const measured = attribution.files.get(file);
            return (
                measured !== undefined &&
                measured.mutants === 0 &&
                measured.sha256 === (await currentHash(file))
            );
        })
    );
    return measurements.every(Boolean) ? "noMutants" : "mutation";
}

/**
 * The strongest tier any cited (symbol, test) pair supports: "symbol" when a killed
 * mutant lies inside the cited declaration of an unchanged file, "file" when the file
 * has drifted since measurement and only file-level attribution survives, "unmeasured"
 * when a cited source or test has no attribution to judge — the measurement predates
 * it — and undefined when the evidence was measured and killed nothing.
 *
 * The unmeasured case must stay distinct from undefined. Both mean "no kill found",
 * but only one of them is a claim about the tests: an atom whose test was added after
 * the last measurement has not been shown to lack discrimination, it has not been
 * asked. Reporting the two alike would put re-measurement debt into the baseline
 * beside real defects, and the baseline is the one place a real defect must not be
 * able to hide.
 */
async function discriminationTier(requirement) {
    let tier;
    let unmeasured = false;
    for (const symbol of requirement.sourceSymbols) {
        if (!symbol.startsWith("src/")) continue;
        const file = symbol.slice(0, symbol.indexOf("#"));
        const measured = attribution.files.get(file);
        if (measured === undefined) {
            unmeasured = true;
            continue;
        }
        const hash = await currentHash(file);
        // A kill in a file that no longer exists is evidence about nothing current.
        if (hash === "missing") continue;
        const fresh = measured.sha256 === hash;
        for (const selector of requirement.testSelectors) {
            const lines = attribution.kills.get(selector)?.get(file);
            if (lines === undefined) {
                // The selector carries no attribution at all: either the test post-dates
                // the measurement or the file drifted out from under it. Either way the
                // run never put this test to the question.
                if (!fresh || !attribution.kills.has(selector)) unmeasured = true;
                continue;
            }
            if (!fresh) {
                tier = tier ?? "file";
                continue;
            }
            const span = symbolLines(symbol);
            if (lines.some((line) => line >= span.startLine && line <= span.endLine)) {
                return "symbol";
            }
        }
    }
    return tier ?? (unmeasured ? "unmeasured" : undefined);
}

function symbolLines(symbol) {
    let span = symbolSpans.get(symbol);
    if (span === undefined) {
        span = sourceSymbolLines(symbol, parseSource);
        symbolSpans.set(symbol, span);
    }
    return span;
}

function parseSource(path) {
    let source = parsedSources.get(path);
    if (source === undefined) {
        source = sourceFile(path);
        if (source !== undefined) parsedSources.set(path, source);
    }
    return source;
}

async function currentHash(file) {
    let hash = sourceHashes.get(file);
    if (hash === undefined) {
        try {
            hash = `sha256:${sha256(await readFile(resolve(packageRoot, file), "utf8"))}`;
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            hash = "missing";
        }
        sourceHashes.set(file, hash);
    }
    return hash;
}

/**
 * The verified requirements across the seed and every active fragment, each tagged
 * with the fragment that owns it. Structural and SPEC validation is the ledger's;
 * this reads only the fields the discrimination join consumes.
 */
async function conformanceRequirements(root) {
    const index = await readCanonicalJson(resolve(root, "conformance/index.json"));
    const byId = new Map();
    for (const name of [...(index.fragments ?? []), index.seed]) {
        const fragment = await readCanonicalJson(resolve(root, "conformance", name));
        for (const requirement of fragment.requirements) {
            assertString(requirement.id, "Discrimination requirement id");
            assertString(requirement.status, `Requirement ${requirement.id} status`);
            assertUniqueStrings(
                requirement.sourceSymbols,
                `Requirement ${requirement.id} sourceSymbols`
            );
            assertUniqueStrings(
                requirement.testSelectors,
                `Requirement ${requirement.id} testSelectors`
            );
            assertUniqueStrings(
                requirement.checkerInvariants,
                `Requirement ${requirement.id} checkerInvariants`
            );
            if (!byId.has(requirement.id)) {
                byId.set(requirement.id, { ...requirement, fragment: name });
            }
        }
    }
    return [...byId.values()];
}

/**
 * The per-area attribution artifacts merged into one file-keyed view. Areas partition
 * src/, so a file recorded by two areas is a corrupted evidence store, not a merge.
 */
async function loadAttribution(root) {
    const areas = new Set(sourceAreas());
    const files = new Map();
    const kills = new Map();
    for (const path of await collectFiles(root, (candidate) => candidate.endsWith(".json"))) {
        const name = portable(relative(root, path));
        const artifact = await readCanonicalJson(path);
        assertExactKeys(
            artifact,
            ["edition", "area", "measuredAt", "fingerprint", "files", "killed"],
            `Discrimination evidence ${name}`
        );
        if (artifact.edition !== "1.0.0") {
            throw new TypeError(`Unsupported discrimination evidence edition: ${name}`);
        }
        if (name !== `${artifact.area}.json` || !areas.has(artifact.area)) {
            throw new TypeError(`Discrimination evidence names a foreign area: ${name}`);
        }
        for (const [file, measured] of Object.entries(artifact.files)) {
            assertExactKeys(measured, ["mutants", "sha256"], `${name} measurement of ${file}`);
            assertString(measured.sha256, `${name} source hash of ${file}`);
            if (
                !file.startsWith("src/") ||
                file.includes("..") ||
                !Number.isSafeInteger(measured.mutants) ||
                measured.mutants < 0
            ) {
                throw new TypeError(`${name} records an invalid measurement for ${file}`);
            }
            if (files.has(file)) {
                throw new TypeError(`${name} measures ${file} already measured by another area`);
            }
            files.set(file, measured);
        }
        for (const [selector, killedFiles] of Object.entries(artifact.killed)) {
            if (!selector.includes("#")) {
                throw new TypeError(`${name} records a kill for an invalid selector`);
            }
            for (const [file, lines] of Object.entries(killedFiles)) {
                const measured = artifact.files[file];
                if (measured === undefined || measured.mutants === 0) {
                    throw new TypeError(`${name} records a kill in an unmeasured file: ${file}`);
                }
                if (
                    !Array.isArray(lines) ||
                    lines.length === 0 ||
                    lines.some(
                        (line, index) =>
                            !Number.isSafeInteger(line) ||
                            line < 1 ||
                            (index > 0 && line <= lines[index - 1])
                    )
                ) {
                    throw new TypeError(`${name} records invalid killed lines for ${file}`);
                }
                const bySelector = kills.get(selector) ?? new Map();
                kills.set(selector, bySelector);
                if (bySelector.has(file)) {
                    throw new TypeError(`${name} records duplicate kills for ${file}`);
                }
                bySelector.set(file, lines);
            }
        }
    }
    return { files, kills };
}

function testPath(selector) {
    return selector.slice(0, selector.indexOf("#"));
}

function issue(rule, file, symbol, message) {
    issues.push({
        rule,
        file,
        symbol,
        message,
        fingerprint: `${rule}:${file}:${symbol}:${sha256(message).slice(0, 12)}`
    });
}

async function loadBaseline(path) {
    try {
        return await readCanonicalJson(path);
    } catch (error) {
        if (error?.code === "ENOENT") return { edition: "1.0.0", issues: [] };
        throw error;
    }
}

function fail(title, values) {
    throw new TypeError(
        `${title}:\n${values.map((item) => `  ${item.fingerprint} ${item.message}`).join("\n")}`
    );
}

function parseArguments(args) {
    let stage = "building";
    let selectedArtifactRoot = artifactRoot;
    let baseline;
    let writeBaseline = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--artifact-root")
            selectedArtifactRoot = resolve(required(args, ++index, argument));
        else if (argument === "--baseline") baseline = resolve(required(args, ++index, argument));
        else if (argument === "--write-baseline") writeBaseline = true;
        else throw new TypeError(`Unknown discrimination argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return {
        stage,
        artifactRoot: selectedArtifactRoot,
        baseline: baseline ?? resolve(selectedArtifactRoot, "quality/discrimination-baseline.json"),
        writeBaseline
    };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}

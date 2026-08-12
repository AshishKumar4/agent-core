// Per-area mutation measurement with an actionability ratchet.
//
//   node scripts/quality/mutation.mjs --area authority            measure + gate one area
//   node scripts/quality/mutation.mjs --area authority --update   re-pin the area baseline
//   node scripts/quality/mutation.mjs --gate                      gate every measured area
//
// Mutation testing is the objective adequacy signal: a test suite that cannot kill a
// behavior-changing mutant does not test that behavior. Full-tree mutation is far too
// slow for the default gates, so areas are measured one at a time and their results are
// pinned in artifacts/quality/mutation-baseline.json with a one-way ratchet: the count
// of actionable survivors in an area may only fall.
//
// Survivors are classified before they count:
//   actionable — behavior mutants (conditionals, operators, returns, literals that feed
//                identity such as codec field names and key namespaces). These indicate
//                missing behavioral assertions and ratchet toward zero.
//   tolerated  — mutants of human-facing message text inside throw sites. Tests assert
//                error codes and types, not prose; killing these would pin every message
//                string without adding behavioral confidence.
//   equivalent — mutants whose own entry in artifacts/quality/mutation-equivalence.json
//                proves no test can distinguish them. See mutation-equivalence.mjs; this
//                is the only way a survivor is excused, and there is no count-level
//                override. An actionable count that rises is closed by killing the
//                mutants or by proving them one at a time.
//
// The baseline holds counts, the register holds proofs, and neither restates the other:
// `mutants` counts every mutant Stryker ran, `killed + actionable + tolerated` counts the
// ones the register says nothing about, and the difference is exactly the entries the
// register carries for that area.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { mutationFingerprint, sourceAreas } from "./mutation-inputs.mjs";
import {
    auditEquivalenceAnchors,
    equivalenceArea,
    equivalenceKey,
    readEquivalenceRegister,
    reconcileEquivalence
} from "./mutation-equivalence.mjs";
import {
    artifactRoot,
    packageRoot,
    readCanonicalJson,
    sha256,
    writeCanonicalJson
} from "./project.mjs";

const options = parseArguments(process.argv.slice(2));
const baselinePath = options.baseline ?? resolve(artifactRoot, "quality/mutation-baseline.json");
const registerPath =
    options.registerArtifact ?? resolve(artifactRoot, "quality/mutation-equivalence.json");
const register = readEquivalenceRegister(await readCanonicalJson(registerPath));

if (options.gate) {
    // The gate follows the project's two-stage discipline. While the SPEC conformance
    // stage is `building`, the kill campaign is in flight: measured areas must be
    // fingerprint-fresh against current sources, and their actionable counts only
    // ratchet downward (enforced at measure time); unmeasured areas and nonzero
    // actionable counts are reported as notes. Declaring the stage `final` demands the
    // endgame: every source area measured fresh with zero actionable survivors.
    const stageArtifact = await readCanonicalJson(
        options.stageArtifact ?? resolve(artifactRoot, "conformance/stage.json")
    );
    const finalStage = stageArtifact.stage === "final";
    const baseline = await readCanonicalJson(baselinePath);
    const failures = [];
    const notes = [];
    const expectedAreas = sourceAreas();
    // Whether a registered mutant still survives is only knowable at measure time, and is
    // enforced there. What the gate can settle on every run is that each entry still
    // anchors exactly one site in the tree it claims to describe, so a proof cannot quietly
    // outlive the code it was written about.
    failures.push(
        ...auditEquivalenceAnchors(register, expectedAreas, (file) => {
            const path = resolve(packageRoot, file);
            return existsSync(path) ? readFileSync(path, "utf8") : undefined;
        })
    );
    const recordedAreas = Object.keys(baseline.areas).sort();
    const unmeasured = expectedAreas.filter((area) => baseline.areas[area] === undefined);
    if (unmeasured.length > 0) {
        (finalStage ? failures : notes).push(`unmeasured areas: ${unmeasured.join(", ")}`);
    }
    for (const area of recordedAreas) {
        if (!expectedAreas.includes(area)) {
            failures.push(`${area}: baseline records a nonexistent source area`);
        }
    }
    for (const area of expectedAreas) {
        const entry = baseline.areas[area];
        if (entry === undefined) continue;
        const proven = register.filter((item) => equivalenceArea(item.file) === area).length;
        console.log(
            `${area}: score ${entry.score}%, ${entry.actionable} actionable, ` +
                `${entry.tolerated} tolerated, ${proven} proven equivalent ` +
                `of ${entry.mutants} mutants`
        );
        if (entry.actionable > 0) {
            (finalStage ? failures : notes).push(`${area}: ${entry.actionable} actionable`);
        }
        const currentFingerprint = mutationFingerprint(area);
        if (entry.fingerprint !== currentFingerprint) {
            failures.push(`${area}: missing or stale mutation fingerprint`);
        }
    }
    for (const note of notes) console.log(`note: ${note}`);
    if (failures.length > 0) {
        throw new TypeError(`Mutation gate failed:\n${failures.join("\n")}`);
    }
    process.exit(0);
}

// An area is a src/ subdirectory, or a single root module such as errors.
if (!sourceAreas().includes(options.area)) {
    throw new TypeError(`Unknown source area: ${options.area}`);
}
const areaRoot = resolve(packageRoot, "src", options.area);
const areaFile = resolve(packageRoot, "src", `${options.area}.ts`);
const mutatePattern = existsSync(areaRoot)
    ? `src/${options.area}/**/*.ts`
    : existsSync(areaFile)
      ? `src/${options.area}.ts`
      : undefined;
if (mutatePattern === undefined) throw new TypeError(`Unknown source area: ${options.area}`);

const stryker = spawnSync(
    "node",
    [
        resolve(packageRoot, "node_modules/@stryker-mutator/core/bin/stryker.js"),
        "run",
        "--mutate",
        mutatePattern
    ],
    { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] }
);
if (stryker.status !== 0) throw new TypeError(`Stryker failed for area ${options.area}`);

const report = JSON.parse(
    readFileSync(resolve(packageRoot, "reports/quality/mutation/report.json"), "utf8")
);
// Kill attribution is the trustworthy direction of a perTest measurement: a test is
// recorded only because it actually failed while the mutant was applied. The JSON
// report indexes killedBy into its testFiles section; a test's selector rebuilt from
// it is byte-identical to the conformance ledger's testSelectors format.
const testSelectors = new Map();
for (const [testPath, testFile] of Object.entries(report.testFiles ?? {})) {
    for (const test of testFile.tests ?? []) {
        testSelectors.set(String(test.id), `${testPath}#${test.name}`);
    }
}
const { equivalent, refuted, stale, ambiguous } = reconcileEquivalence(report, register);
const registerFailures = [
    ...refuted.map(({ entry, mutant }) => {
        const by = killingTests(mutant);
        return (
            `refuted — ${equivalenceKey(entry)} is reported ${mutant.status}` +
            `${by.length === 0 ? "" : ` by ${by.join(", ")}`}; the proof is wrong`
        );
    }),
    ...stale.map((entry) => `stale — ${equivalenceKey(entry)} no longer anchors a live mutant`),
    ...ambiguous.map(
        ({ entry, matches }) =>
            `ambiguous — ${equivalenceKey(entry)} anchors ${matches.length} mutants; ` +
            "one proof excuses one mutant"
    )
];
if (registerFailures.length > 0) {
    throw new TypeError(`Mutation equivalence register failed:\n${registerFailures.join("\n")}`);
}

const summary = {
    mutants: 0,
    killed: 0,
    actionable: 0,
    tolerated: 0,
    equivalent: 0,
    survivors: []
};
const measuredFiles = new Map();
const kills = new Map();
const messageHelperCall = messageHelperPattern();
for (const [path, file] of Object.entries(report.files)) {
    const source = file.source.split("\n");
    const measured = { mutants: 0, sha256: `sha256:${sha256(file.source)}` };
    measuredFiles.set(path, measured);
    for (const mutant of file.mutants) {
        if (mutant.status === "Ignored") continue;
        measured.mutants += 1;
        summary.mutants += 1;
        const proven = equivalent.get(mutant.id);
        if (proven !== undefined) {
            summary.equivalent += 1;
            summary.survivors.push(
                survivorRecord(path, mutant, source, "equivalent", proven.proof)
            );
            continue;
        }
        if (mutant.status === "NoCoverage") {
            summary.actionable += 1;
            summary.survivors.push(survivorRecord(path, mutant, source, "actionable"));
            continue;
        }
        if (mutant.status !== "Survived") {
            summary.killed += 1;
            if (mutant.status === "Killed") recordKills(path, mutant);
            continue;
        }
        const classification = classify(mutant, source);
        summary[classification] += 1;
        summary.survivors.push(survivorRecord(path, mutant, source, classification));
    }
}
const score =
    summary.mutants === 0 ? 100 : Math.round((summary.killed / summary.mutants) * 1000) / 10;

const baseline = existsSync(baselinePath)
    ? await readCanonicalJson(baselinePath)
    : { edition: "1.0.0", areas: {} };
const previous = baseline.areas[options.area];
const entry = {
    measuredAt: gitHead(),
    fingerprint: mutationFingerprint(options.area),
    mutants: summary.mutants,
    killed: summary.killed,
    score,
    actionable: summary.actionable,
    tolerated: summary.tolerated
};

await writeCanonicalJson(resolve(packageRoot, `reports/mutation/${options.area}-survivors.json`), {
    edition: "1.0.0",
    area: options.area,
    ...entry,
    equivalent: summary.equivalent,
    survivors: summary.survivors
});
await writeCanonicalJson(resolve(artifactRoot, `quality/discrimination/${options.area}.json`), {
    edition: "1.0.0",
    area: options.area,
    measuredAt: entry.measuredAt,
    fingerprint: entry.fingerprint,
    files: sortedObject(measuredFiles),
    killed: sortedObject(
        new Map(
            [...kills].map(([selector, files]) => [
                selector,
                sortedObject(
                    new Map(
                        [...files].map(([path, lines]) => [
                            path,
                            [...lines].sort((left, right) => left - right)
                        ])
                    )
                )
            ])
        )
    )
});
console.log(
    `${options.area}: score ${score}%, ${summary.actionable} actionable + ` +
        `${summary.tolerated} tolerated + ${summary.equivalent} proven equivalent ` +
        `survivors of ${summary.mutants} mutants`
);

if (options.update) {
    requireCleanWorktree();
    // The ratchet has to bite here. It used to live only in the read-only branch below,
    // so --update — the one path that actually writes the floor — accepted any increase
    // silently, and a re-pin could raise the number it was supposed to hold down.
    if (previous !== undefined && summary.actionable > previous.actionable) {
        throw new TypeError(ratchetFailure(previous.actionable, summary.actionable));
    }
    baseline.areas[options.area] = entry;
    await writeCanonicalJson(baselinePath, baseline);
    console.log(`baseline ${previous === undefined ? "recorded" : "re-pinned"}`);
} else if (previous === undefined) {
    throw new TypeError(
        `Mutation area ${options.area} has no reviewed baseline; rerun with --update from a clean tree`
    );
} else if (summary.actionable > previous.actionable) {
    throw new TypeError(ratchetFailure(previous.actionable, summary.actionable));
} else if (summary.actionable < previous.actionable) {
    console.log(
        `mutation improved ${previous.actionable} -> ${summary.actionable}; ` +
            "review and re-run with --update from a clean tree"
    );
}

// There is one way out of a rising actionable count and it is per mutant. A count-level
// override would let one sentence absorb any number of genuine coverage gaps, and nothing
// could ever contradict it; a register entry names its mutant and dies the moment a test
// kills it.
function ratchetFailure(previous, actual) {
    return (
        `Mutation ratchet: ${options.area} actionable survivors rose ${previous} -> ${actual}. ` +
        "Kill them, or prove each equivalent mutant individually in " +
        "artifacts/quality/mutation-equivalence.json."
    );
}

function killingTests(mutant) {
    return (mutant.killedBy ?? [])
        .map((id) => testSelectors.get(String(id)))
        .filter((selector) => selector !== undefined);
}

function requireCleanWorktree() {
    const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: packageRoot,
        encoding: "utf8"
    });
    if (result.status !== 0) {
        throw new TypeError("Mutation baselines may be updated only from a clean worktree");
    }
    // The baseline and per-area discrimination attribution are this runner's own
    // outputs: a multi-area measurement sequence legitimately dirties them between
    // areas. Everything else must be clean so the recorded fingerprints describe
    // committed sources.
    const dirty = result.stdout
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(
            (path) =>
                path.length > 0 &&
                path !== "packages/agent-core/artifacts/quality/mutation-baseline.json" &&
                !path.startsWith("packages/agent-core/artifacts/quality/discrimination/")
        );
    if (dirty.length > 0) {
        throw new TypeError(
            `Mutation baselines may be updated only from a clean worktree; dirty: ${dirty.slice(0, 5).join(", ")}`
        );
    }
}

function classify(mutant, source) {
    if (mutant.mutatorName !== "StringLiteral") return "actionable";
    const line = source[mutant.location.start.line - 1] ?? "";
    // Message text inside a throw (or the subject label passed to a validator that
    // throws) does not carry behavior; identity strings (key namespaces, codec field
    // names, error codes) do and stay actionable.
    const messageContext =
        /throw new (?:TypeError|RangeError|Error)\(/.test(line) ||
        /^\s*(?:"|`)[^"`]*(?:"|`)\s*\)?;?\s*$/.test(line) ||
        /require[A-Z]\w*\([^)]*"[^"]+"\s*\)/.test(line) ||
        messageHelperCall.test(line);
    const identityContext =
        /Key\(|codec|new AgentCoreError\(\s*"[a-z]|fromData|toData|requireString\(object/.test(
            line
        );
    return messageContext && !identityContext ? "tolerated" : "actionable";
}

/**
 * Prose reaches its throw through this codebase's own error helpers — `invalidTurn`,
 * `corruptRecord`, `required` — far more often than through `throw new TypeError(`.
 * Their names are read back out of the sources rather than listed here, so the set
 * cannot drift as helpers are added or renamed.
 *
 * A helper qualifies only when one of its parameters is literally named `message`,
 * which is what makes the string it receives prose. That excludes the helpers which
 * take an identity instead — `invalidSqliteColumn(expected, column)`,
 * `malformedProviderOutcome(kind)`, `missingPointer(pointer)` — whose literals are
 * discriminants and must keep ratcheting. The failure to avoid is over-tolerating:
 * counting a behavior mutant as prose hides a real gap, so anything unrecognised
 * stays actionable.
 */
function messageHelperPattern() {
    const names = new Set();
    const declaration = /function\s+([a-z]\w*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/gu;
    for (const path of typescriptSources(resolve(packageRoot, "src"))) {
        const text = readFileSync(path, "utf8");
        for (const [, name, parameters] of text.matchAll(declaration)) {
            if (/\bmessage\s*[?:=]/u.test(parameters)) names.add(name);
        }
    }
    if (names.size === 0) return /$^/u;
    return new RegExp(`\\b(?:${[...names].sort().join("|")})\\(`, "u");
}

function typescriptSources(root) {
    const files = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) files.push(...typescriptSources(path));
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
    return files;
}

function recordKills(path, mutant) {
    for (const id of mutant.killedBy ?? []) {
        const selector = testSelectors.get(String(id));
        if (selector === undefined) continue;
        const files = kills.get(selector) ?? new Map();
        kills.set(selector, files);
        const lines = files.get(path) ?? new Set();
        files.set(path, lines);
        lines.add(mutant.location.start.line);
    }
}

function sortedObject(map) {
    return Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right, "en")));
}

// The exact span, not just the line. One line routinely carries several mutants: a
// short-circuiting condition yields one per operand plus one for the whole expression,
// and those have different coverage and different verdicts. A line plus a replacement
// cannot say which of them survived — reading `false` against
// `current === undefined || left < current`, triage cannot tell the surviving operand
// from the killed whole condition, and reproducing the wrong one invents a phantom.
function survivorRecord(path, mutant, source, classification, proof) {
    return {
        file: path,
        line: mutant.location.start.line,
        column: mutant.location.start.column,
        endLine: mutant.location.end.line,
        endColumn: mutant.location.end.column,
        mutator: mutant.mutatorName,
        classification,
        replacement: (mutant.replacement ?? "").slice(0, 120),
        source: (source[mutant.location.start.line - 1] ?? "").trim().slice(0, 160),
        ...(proof === undefined ? {} : { proof })
    };
}

function gitHead() {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: packageRoot,
        encoding: "utf8"
    });
    return result.status === 0 ? result.stdout.trim() : "unknown";
}

function parseArguments(args) {
    let area;
    let update = false;
    let gate = false;
    let baseline;
    let stageArtifact;
    let registerArtifact;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--area") area = args[++index];
        else if (args[index] === "--update") update = true;
        else if (args[index] === "--gate") gate = true;
        else if (args[index] === "--baseline") baseline = args[++index];
        else if (args[index] === "--stage-artifact") stageArtifact = args[++index];
        else if (args[index] === "--register") registerArtifact = args[++index];
        else throw new TypeError(`Unknown mutation argument ${args[index]}`);
    }
    if (!gate && area === undefined) throw new TypeError("--area or --gate is required");
    return { area, update, gate, baseline, stageArtifact, registerArtifact };
}

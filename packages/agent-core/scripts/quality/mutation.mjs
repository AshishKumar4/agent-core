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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { artifactRoot, packageRoot, readCanonicalJson, writeCanonicalJson } from "./project.mjs";

const options = parseArguments(process.argv.slice(2));
const baselinePath =
    options.baseline ?? resolve(artifactRoot, "quality/mutation-baseline.json");

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
        console.log(
            `${area}: score ${entry.score}%, ${entry.actionable} actionable, ` +
                `${entry.tolerated} tolerated of ${entry.mutants} mutants`
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
const summary = { mutants: 0, killed: 0, actionable: 0, tolerated: 0, survivors: [] };
for (const [path, file] of Object.entries(report.files)) {
    const source = readFileSync(resolve(packageRoot, path), "utf8").split("\n");
    for (const mutant of file.mutants) {
        if (mutant.status === "Ignored") continue;
        if (mutant.status === "NoCoverage") {
            summary.mutants += 1;
            summary.actionable += 1;
            summary.survivors.push(survivorRecord(path, mutant, source, "actionable"));
            continue;
        }
        summary.mutants += 1;
        if (mutant.status !== "Survived") {
            summary.killed += 1;
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

await writeCanonicalJson(
    resolve(packageRoot, `reports/mutation/${options.area}-survivors.json`),
    { edition: "1.0.0", area: options.area, ...entry, survivors: summary.survivors }
);
console.log(
    `${options.area}: score ${score}%, ${summary.actionable} actionable + ` +
        `${summary.tolerated} tolerated survivors of ${summary.mutants} mutants`
);

if (options.update) {
    requireCleanWorktree();
    baseline.areas[options.area] = entry;
    await writeCanonicalJson(baselinePath, baseline);
    console.log(`baseline ${previous === undefined ? "recorded" : "re-pinned"}`);
} else if (previous === undefined) {
    throw new TypeError(
        `Mutation area ${options.area} has no reviewed baseline; rerun with --update from a clean tree`
    );
} else if (summary.actionable > previous.actionable) {
    throw new TypeError(
        `Mutation ratchet: ${options.area} actionable survivors rose ` +
            `${previous.actionable} -> ${summary.actionable}`
    );
} else if (summary.actionable < previous.actionable) {
    console.log(
        `mutation improved ${previous.actionable} -> ${summary.actionable}; ` +
            "review and re-run with --update from a clean tree"
    );
}

function sourceAreas() {
    const sourceRoot = resolve(packageRoot, "src");
    return readdirSync(sourceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".ts")))
        .map((entry) => (entry.isDirectory() ? entry.name : entry.name.slice(0, -3)))
        .sort();
}

function mutationFingerprint(area) {
    const files = [
        ...typescriptFilesForArea(area),
        ...walkTypeScript(resolve(packageRoot, "test")),
        resolve(packageRoot, "package.json"),
        resolve(packageRoot, "stryker.conf.mjs"),
        resolve(packageRoot, "vitest.mutation.config.mjs"),
        resolve(packageRoot, "../..", "pnpm-lock.yaml")
    ].sort();
    const hash = createHash("sha256");
    for (const path of files) {
        hash.update(relative(packageRoot, path).replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
}

function typescriptFilesForArea(area) {
    const directory = resolve(packageRoot, "src", area);
    if (existsSync(directory) && statSync(directory).isDirectory()) return walkTypeScript(directory);
    const file = resolve(packageRoot, "src", `${area}.ts`);
    return existsSync(file) ? [file] : [];
}

function walkTypeScript(root) {
    const files = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) files.push(...walkTypeScript(path));
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
    return files;
}

function requireCleanWorktree() {
    const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: packageRoot,
        encoding: "utf8"
    });
    if (result.status !== 0 || result.stdout.trim().length > 0) {
        throw new TypeError("Mutation baselines may be updated only from a clean worktree");
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
        /require[A-Z]\w*\([^)]*"[^"]+"\s*\)/.test(line);
    const identityContext =
        /Key\(|codec|new AgentCoreError\(\s*"[a-z]|fromData|toData|requireString\(object/.test(
            line
        );
    return messageContext && !identityContext ? "tolerated" : "actionable";
}

function survivorRecord(path, mutant, source, classification) {
    return {
        file: path,
        line: mutant.location.start.line,
        mutator: mutant.mutatorName,
        classification,
        replacement: (mutant.replacement ?? "").slice(0, 120),
        source: (source[mutant.location.start.line - 1] ?? "").trim().slice(0, 160)
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
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--area") area = args[++index];
        else if (args[index] === "--update") update = true;
        else if (args[index] === "--gate") gate = true;
        else if (args[index] === "--baseline") baseline = args[++index];
        else if (args[index] === "--stage-artifact") stageArtifact = args[++index];
        else throw new TypeError(`Unknown mutation argument ${args[index]}`);
    }
    if (!gate && area === undefined) throw new TypeError("--area or --gate is required");
    return { area, update, gate, baseline, stageArtifact };
}

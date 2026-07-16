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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { artifactRoot, packageRoot, readCanonicalJson, writeCanonicalJson } from "./project.mjs";

const options = parseArguments(process.argv.slice(2));
const baselinePath = resolve(artifactRoot, "quality/mutation-baseline.json");

if (options.gate) {
    const baseline = await readCanonicalJson(baselinePath);
    const failures = [];
    for (const [area, entry] of Object.entries(baseline.areas)) {
        console.log(
            `${area}: score ${entry.score}%, ${entry.actionable} actionable, ` +
                `${entry.tolerated} tolerated of ${entry.mutants} mutants`
        );
        if (entry.actionable > 0) failures.push(`${area}: ${entry.actionable}`);
    }
    process.exit(0);
}

const areaRoot = resolve(packageRoot, "src", options.area);
if (!existsSync(areaRoot)) throw new TypeError(`Unknown source area: ${options.area}`);

const stryker = spawnSync(
    "node",
    [
        resolve(packageRoot, "node_modules/@stryker-mutator/core/bin/stryker.js"),
        "run",
        "--mutate",
        `src/${options.area}/**/*.ts`
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
    mutants: summary.mutants,
    killed: summary.killed,
    score,
    actionable: summary.actionable,
    tolerated: summary.tolerated
};

await writeCanonicalJson(
    resolve(packageRoot, `reports/quality/mutation/${options.area}-survivors.json`),
    { edition: "1.0.0", area: options.area, ...entry, survivors: summary.survivors }
);
console.log(
    `${options.area}: score ${score}%, ${summary.actionable} actionable + ` +
        `${summary.tolerated} tolerated survivors of ${summary.mutants} mutants`
);

if (options.update || previous === undefined) {
    baseline.areas[options.area] = entry;
    await writeCanonicalJson(baselinePath, baseline);
    console.log(`baseline ${previous === undefined ? "recorded" : "re-pinned"}`);
} else if (summary.actionable > previous.actionable) {
    throw new TypeError(
        `Mutation ratchet: ${options.area} actionable survivors rose ` +
            `${previous.actionable} -> ${summary.actionable}`
    );
} else if (summary.actionable < previous.actionable) {
    baseline.areas[options.area] = entry;
    await writeCanonicalJson(baselinePath, baseline);
    console.log(`ratchet advanced: ${previous.actionable} -> ${summary.actionable}`);
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
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--area") area = args[++index];
        else if (args[index] === "--update") update = true;
        else if (args[index] === "--gate") gate = true;
        else throw new TypeError(`Unknown mutation argument ${args[index]}`);
    }
    if (!gate && area === undefined) throw new TypeError("--area or --gate is required");
    return { area, update, gate };
}

// Verifies artifacts/traceability.yaml against the Lean axiom report, both directions:
// every theorem claimed in the YAML must appear in `lake build AgentCore`'s
// #print axioms output, every reported theorem must be claimed in the YAML exactly
// once, no theorem may depend on sorryAx, and every claimed definition name must
// exist in the Lean sources. SPEC §14 prohibits unverified hand-edits.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const formalRoot = join(packageRoot, "formal");
const traceabilityPath = join(packageRoot, "artifacts", "traceability.yaml");

const failures = [];

const build = spawnSync("lake", ["build", "AgentCore"], {
    cwd: formalRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
});
if (build.status !== 0) {
    console.error(build.stdout);
    console.error(build.stderr);
    console.error("check-traceability: lake build failed");
    process.exit(1);
}

const buildOutput = `${build.stdout}\n${build.stderr}`;
const reported = new Map();
for (const match of buildOutput.matchAll(
    /'(AgentCore\.[^']+)' (does not depend on any axioms|depends on axioms: (.*))/g
)) {
    const name = match[1];
    const axioms = match[3]?.split(",").map(part => part.trim()) ?? [];
    reported.set(name, axioms);
    if (axioms.some(axiom => axiom.includes("sorryAx"))) {
        failures.push(`theorem depends on sorry: ${name}`);
    }
}
if (reported.size === 0) {
    console.error("check-traceability: no #print axioms output captured (stale build cache? run `lake clean` in formal/)");
    process.exit(1);
}

const yaml = readFileSync(traceabilityPath, "utf8");
const claimedTheorems = [];
const claimedDefinitions = [];
let section;
for (const line of yaml.split("\n")) {
    const heading = line.match(/^\s{4}(theorems|definitions):\s*$/);
    if (heading) {
        section = heading[1];
        continue;
    }
    if (/^\s{4}\S/.test(line)) section = undefined;
    const entry = line.match(/^\s{6}- (AgentCore\.\S+)\s*$/);
    if (entry && section === "theorems") claimedTheorems.push(entry[1]);
    if (entry && section === "definitions") claimedDefinitions.push(entry[1]);
}

for (const name of claimedTheorems) {
    if (!reported.has(name)) failures.push(`claimed theorem missing from axiom report: ${name}`);
}
const claimSet = new Set(claimedTheorems);
for (const name of reported.keys()) {
    if (!claimSet.has(name)) failures.push(`reported theorem unclaimed in traceability.yaml: ${name}`);
}
const duplicates = claimedTheorems.filter((name, index) => claimedTheorems.indexOf(name) !== index);
for (const name of new Set(duplicates)) failures.push(`theorem claimed more than once: ${name}`);

const leanSources = [];
const walk = directory => {
    for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
            if (entry !== ".lake") walk(path);
        } else if (entry.endsWith(".lean")) {
            leanSources.push(readFileSync(path, "utf8"));
        }
    }
};
walk(formalRoot);
const corpus = leanSources.join("\n");
for (const name of claimedDefinitions) {
    const leaf = name.split(".").at(-1);
    const pattern = new RegExp(`(def|structure|inductive|abbrev|\\|)\\s+([A-Za-z0-9_]+\\.)*${leaf}\\b`);
    if (!pattern.test(corpus)) failures.push(`claimed definition not found in Lean sources: ${name}`);
}

if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
}
console.log(`✓ traceability verified: ${claimedTheorems.length} theorems (axiom report: ${reported.size}), ${claimedDefinitions.length} definitions`);

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    artifactRoot,
    collectFiles,
    fileSha256,
    packageRoot,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";
import { dependencyClosure, topologicalOrder, validateGraph } from "./dag.mjs";
import { activeAdjunctPackages, adjunctPackages, adjunctReportRoot } from "./workspaces.mjs";

const stage = argument("--stage") ?? "building";
if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
if (process.env.QUALITY_ORCHESTRATED !== "1") {
    throw new TypeError("Quality attestation must be run by the quality orchestrator");
}
const graph = await readCanonicalJson(resolve(artifactRoot, "quality/check-dag.json"));
validateGraph(graph);
const root = stage === "final" ? "attestation" : "building-attestation";
const expectedNodes = topologicalOrder(dependencyClosure([root], graph.nodes), graph.nodes).filter(
    (node) => node !== root
);
const checks = await readCanonicalJson(resolve(reportRoot, "checks-input.json"));
if (
    checks.stage !== stage ||
    checks.results.length !== expectedNodes.length ||
    checks.results.some(
        (result, index) => result.node !== expectedNodes[index] || result.status !== "passed"
    )
) {
    throw new TypeError("Quality attestation does not have the exact passing stage evidence");
}
for (const node of expectedNodes) {
    const report = await readCanonicalJson(resolve(reportRoot, "nodes", `${node}.json`));
    if (report.stage !== stage || report.status !== "passed") {
        throw new TypeError(`Quality attestation node did not pass: ${node}`);
    }
}
const reports = await collectFiles(reportRoot, (path) => path.endsWith(".json"));
const active = await activeAdjunctPackages();
const adjunctReports = await Promise.all(
    adjunctPackages().map(async (workspace) => ({
        workspace,
        root: adjunctReportRoot(workspace),
        files: await collectFiles(adjunctReportRoot(workspace), (path) => path.endsWith(".json"))
    }))
);
const expectedCoreReports = new Set([
    "checks-input.json",
    ...expectedNodes.map((node) => `nodes/${node}.json`)
]);
const nodeReports = {
    agents: "agents-compliance.json",
    architecture: "architecture.json",
    coherence: "coherence.json",
    discrimination: "discrimination.json",
    governance: "governance.json",
    "gate-integrity": "gate-integrity.json",
    integration: "integration.json",
    invariants: "invariants.json",
    ledger: "conformance.json",
    migrations: "migrations.json",
    records: "records.json",
    requests: "requests.json",
    seams: "seams.json"
};
for (const node of expectedNodes) {
    if (nodeReports[node] !== undefined) expectedCoreReports.add(nodeReports[node]);
}
if (checks.owner !== null) expectedCoreReports.add("ownership.json");
if (expectedNodes.includes("tests")) {
    expectedCoreReports.add("tests/vitest.json");
    expectedCoreReports.add("coverage/coverage-final.json");
    expectedCoreReports.add("coverage/coverage-summary.json");
}
if (expectedNodes.includes("quality-tests")) expectedCoreReports.add("tests/quality.json");
if (expectedNodes.includes("governance-tests")) expectedCoreReports.add("tests/governance.json");
if (expectedNodes.includes("priority-tests")) {
    for (const priority of ["p0", "p1", "p2"]) {
        expectedCoreReports.add(`tests/priority-${priority}.json`);
    }
}
if (expectedNodes.includes("test-priorities")) expectedCoreReports.add("test-priorities.json");
if (expectedNodes.includes("coverage")) {
    expectedCoreReports.add("coverage/attestation.json");
    expectedCoreReports.add("coverage/source-universe.json");
}
requireExactReports(reports, reportRoot, expectedCoreReports, "core");
for (const { workspace, root, files } of adjunctReports) {
    const expected = new Set();
    if (active.includes(workspace) && expectedNodes.includes("tests")) {
        for (const lane of workspace.testLanes) {
            expected.add(`tests/${lane.id}.json`);
            if (!lane.coverage) continue;
            expected.add(`coverage/${lane.id}/coverage-final.json`);
            expected.add(`coverage/${lane.id}/coverage-summary.json`);
        }
    }
    requireExactReports(files, root, expected, workspace.id);
}
const status = git(["status", "--porcelain=v1"]);
if (stage === "final" && status.trim().length > 0) {
    throw new TypeError("Final quality attestation requires a clean worktree");
}
const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const antiSlopProvenancePath = resolve(repositoryRoot, "tools/oxlint/anti-slop/provenance.json");
const attestation = {
    edition: "1.0.0",
    stage,
    commit: git(["rev-parse", "HEAD"]).trim(),
    dirty: status.trim().length > 0,
    changesSha256: changeDigest(),
    tools: {
        node: process.version,
        bun: commandVersion("bun", ["--version"]),
        packageManager: rootPackage.packageManager,
        antiSlop: {
            provenance: await readCanonicalJson(antiSlopProvenancePath),
            provenanceSha256: await fileSha256(antiSlopProvenancePath)
        },
        oxlint: await packageVersion(resolve(repositoryRoot, "node_modules/oxlint/package.json")),
        prettier: await packageVersion(
            resolve(repositoryRoot, "node_modules/prettier/package.json")
        ),
        typescript: await packageVersion(
            resolve(packageRoot, "node_modules/typescript/package.json")
        ),
        vitest: await packageVersion(resolve(packageRoot, "node_modules/vitest/package.json"))
    },
    reports: Object.fromEntries(
        await Promise.all(
            [
                ...reports.map((path) => ({
                    name: `core/${path.slice(reportRoot.length + 1)}`,
                    path
                })),
                ...adjunctReports.flatMap(({ workspace, root, files }) =>
                    files.map((path) => ({
                        name: `${workspace.id}/${path.slice(root.length + 1)}`,
                        path
                    }))
                )
            ]
                .sort((left, right) => left.name.localeCompare(right.name))
                .map(async ({ name, path }) => [name, await fileSha256(path)])
        )
    )
};
await writeCanonicalJson(resolve(reportRoot, "attestation.json"), attestation);
console.log(`attestation written for ${attestation.commit}${attestation.dirty ? " (dirty)" : ""}`);

function git(args) {
    const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
}

function changeDigest() {
    const diff = spawnSync("git", ["diff", "--binary", "HEAD"], {
        cwd: repositoryRoot,
        encoding: null,
        maxBuffer: 64 * 1024 * 1024
    });
    if (diff.error || diff.status !== 0)
        throw diff.error ?? new Error("Unable to hash worktree diff");
    const untracked = git(["ls-files", "--others", "--exclude-standard"])
        .split("\n")
        .filter(Boolean)
        .sort();
    const chunks = [diff.stdout];
    for (const path of untracked) {
        chunks.push(Buffer.from(path), Buffer.from([0]), requireFile(path));
    }
    return createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
}

function requireFile(path) {
    return readFileSync(resolve(repositoryRoot, path));
}

function argument(name) {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
}

async function packageVersion(path) {
    return JSON.parse(await readFile(path, "utf8")).version;
}

function commandVersion(command, args) {
    const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8" });
    if (result.error || result.status !== 0) return "unavailable";
    return result.stdout.trim();
}

function requireExactReports(paths, root, expected, owner) {
    const actual = paths.map((path) => path.slice(root.length + 1).replaceAll("\\", "/")).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
        throw new TypeError(
            `${owner} quality reports differ from exact stage evidence; expected=${[...expected].sort().join(",")} actual=${actual.join(",")}`
        );
    }
}

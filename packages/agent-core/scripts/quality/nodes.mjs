import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { dependencyClosure } from "./dag.mjs";
import { artifactRoot, readCanonicalJson, reportRoot, repositoryRoot } from "./project.mjs";

export async function requirePassingNodes(nodes, owner, stage) {
    const graph = await readCanonicalJson(resolve(artifactRoot, "quality/check-dag.json"));
    const fixedEvidenceNodes = ["coverage", "exports"];
    if (JSON.stringify(graph.evidenceNodes) !== JSON.stringify(fixedEvidenceNodes)) {
        throw new TypeError("Quality evidence node policy changed");
    }
    const requiredIntegrationDependencies = ["build", "tests", "coverage", "exports"];
    if (
        JSON.stringify(graph.nodes.integration) !== JSON.stringify(requiredIntegrationDependencies)
    ) {
        throw new TypeError("Integration evidence dependencies changed");
    }
    const evidenceNodes = new Set(fixedEvidenceNodes);
    const integrationDependencies = dependencyClosure(["integration"], graph.nodes);
    const commit = git(["rev-parse", "HEAD"]);
    const tree = git(["show", "-s", "--format=%T", "HEAD"]);
    for (const node of nodes) {
        if (
            !/^[a-z][a-z0-9-]*$/u.test(node) ||
            !evidenceNodes.has(node) ||
            !integrationDependencies.has(node)
        ) {
            throw new TypeError(`${owner} names an inadmissible quality evidence node: ${node}`);
        }
        const report = await readCanonicalJson(resolve(reportRoot, "nodes", `${node}.json`));
        if (
            report.status !== "passed" ||
            report.stage !== stage ||
            report.commit !== commit ||
            report.tree !== tree
        ) {
            throw new TypeError(`${owner} quality node did not pass: ${node}`);
        }
    }
}

function git(args) {
    const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
    if (result.status !== 0) throw new TypeError(`Git identity is unavailable: ${args.join(" ")}`);
    return result.stdout.trim();
}

// @ts-nocheck
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
    artifactRoot,
    collectFiles,
    packageRoot,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";
import { executedTestSelectors, requirePassingTests } from "./evidence.mjs";
import { requirePassingNodes } from "./nodes.mjs";

const stage = process.argv.includes("--stage")
    ? process.argv[process.argv.indexOf("--stage") + 1]
    : "building";
const roots = [resolve(packageRoot, "test/integration"), resolve(packageRoot, "test/conformance")];
const files = (
    await Promise.all(roots.map((root) => collectFiles(root, (path) => path.endsWith(".test.ts"))))
).flat();
const transitionIndex = await readCanonicalJson(
    resolve(artifactRoot, "integration/transitions/index.json")
);
const resolutions = await readCanonicalJson(resolve(artifactRoot, "integration/resolutions.json"));
const completedTransitions = [];
for (const name of transitionIndex.manifests) {
    const transition = await readCanonicalJson(
        resolve(artifactRoot, "integration/transitions", name)
    );
    if (transition.state === "completed") completedTransitions.push(transition);
}
if (completedTransitions.length > 0) {
    const executed = await executedTestSelectors();
    for (const transition of completedTransitions) {
        requirePassingTests(transition.completion.tests, executed, transition.id);
        await requirePassingNodes(transition.completion.checks ?? [], transition.id, stage);
    }
}
{
    const executed = await executedTestSelectors();
    for (const resolution of resolutions.entries) {
        if (stage === "final" && resolution.state === "external-gated") {
            throw new TypeError(`External resolution lacks remote evidence: ${resolution.source}`);
        }
        if (resolution.outcome === undefined) {
            if (stage === "final") {
                throw new TypeError(
                    `Resolution lacks state-specific outcome: ${resolution.source}`
                );
            }
            continue;
        }
        verifyCurrentOutcomeArtifacts(resolution);
        requirePassingTests(resolution.outcome.tests, executed, resolution.source);
        await requirePassingNodes(resolution.outcome.checks, resolution.source, stage);
    }
}
const report = {
    edition: "1.0.0",
    stage,
    files: files.map((path) => path.slice(packageRoot.length + 1)).sort(),
    completedTransitions: completedTransitions.map((transition) => transition.id).sort(),
    complete: files.length > 0
};
await writeCanonicalJson(resolve(reportRoot, "integration.json"), report);
if (stage === "final" && files.length === 0)
    throw new TypeError("Final integration suite is absent");
console.log(`integration ${report.complete ? "present" : "incomplete"}: ${files.length} file(s)`);

function verifyCurrentOutcomeArtifacts(resolution) {
    for (const artifact of resolution.outcome.artifacts) {
        const blob = spawnSync("git", ["rev-parse", `HEAD:${artifact.path}`], {
            cwd: repositoryRoot,
            encoding: "utf8"
        });
        if (blob.status !== 0 || blob.stdout.trim() !== artifact.blob) {
            throw new TypeError(
                `${resolution.source} outcome artifact differs from the current run: ${artifact.path}`
            );
        }
    }
}

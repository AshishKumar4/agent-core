import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
    artifactRoot,
    collectFiles,
    packageRoot,
    readCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";
import { executedTestSelectors, requirePassingTests } from "./evidence.mjs";
import { requirePassingNodes } from "./nodes.mjs";
import { updateOutcomeBaseline, verifyOutcomeLedger } from "./outcome-baseline.mjs";

const options = parseArguments(process.argv.slice(2));
const resolutions = await readCanonicalJson(resolve(artifactRoot, "integration/resolutions.json"));
const baselinePath = resolve(artifactRoot, "quality/outcome-baseline.json");

if (options.updateOutcomes) {
    const previous = existsSync(baselinePath) ? await readCanonicalJson(baselinePath) : undefined;
    const { baseline, additions, restorations, regressions } = updateOutcomeBaseline(
        resolutions,
        previous,
        options.acceptRewrite
    );
    await writeCanonicalJson(baselinePath, baseline);
    for (const source of additions) console.log(`recorded: ${source}`);
    for (const source of restorations) console.log(`restored: ${source}`);
    for (const regression of regressions) {
        console.log(`accepted: ${regression} (${options.acceptRewrite})`);
    }
    console.log(`outcome baseline ${previous === undefined ? "recorded" : "re-pinned"}`);
    process.exit(0);
}

const roots = [resolve(packageRoot, "test/integration"), resolve(packageRoot, "test/conformance")];
const files = (
    await Promise.all(roots.map((root) => collectFiles(root, (path) => path.endsWith(".test.ts"))))
).flat();
const transitionIndex = await readCanonicalJson(
    resolve(artifactRoot, "integration/transitions/index.json")
);
const completedTransitions = [];
for (const name of transitionIndex.manifests) {
    const transition = await readCanonicalJson(
        resolve(artifactRoot, "integration/transitions", name)
    );
    if (transition.state === "completed") completedTransitions.push(transition);
}
// Transition completions and resolution outcomes may cite the quality and
// governance harness suites beside the product and cloudflare runs.
const executed = await executedTestSelectors([
    resolve(reportRoot, "tests/vitest.json"),
    resolve(reportRoot, "tests/quality.json"),
    resolve(reportRoot, "tests/governance.json"),
    resolve(packageRoot, "../agent-core-cloudflare/reports/quality/tests/structural.json"),
    resolve(packageRoot, "../agent-core-cloudflare/reports/quality/tests/workers.json")
]);
if (completedTransitions.length > 0) {
    for (const transition of completedTransitions) {
        requirePassingTests(transition.completion.tests, executed, transition.id);
        await requirePassingNodes(transition.completion.checks ?? [], transition.id, options.stage);
    }
}
// Recorded outcomes are the immutable history of ratified reviews; how their artifacts
// have evolved since is governed by the live evidence, not by the record. What the gate
// enforces is the record itself: every pin bound to its own ratification commit where
// that commit resolves, every record fingerprint-matched against the outcome baseline,
// and every unverifiable ratification enumerated with a reason — never silently skipped.
if (!existsSync(baselinePath)) {
    throw new TypeError(
        "Outcome baseline is missing; record it with node scripts/quality/integration.mjs --update-outcomes"
    );
}
const provenance = verifyOutcomeLedger(resolutions, await readCanonicalJson(baselinePath));
for (const resolution of resolutions.entries) {
    if (options.stage === "final" && resolution.state === "external-gated") {
        throw new TypeError(`External resolution lacks remote evidence: ${resolution.source}`);
    }
    if (resolution.outcome === undefined) {
        if (options.stage === "final") {
            throw new TypeError(`Resolution lacks state-specific outcome: ${resolution.source}`);
        }
        continue;
    }
}
const report = {
    edition: "1.0.0",
    stage: options.stage,
    files: files.map((path) => path.slice(packageRoot.length + 1)).sort(),
    completedTransitions: completedTransitions.map((transition) => transition.id).sort(),
    outcomes: provenance,
    complete: files.length > 0
};
await writeCanonicalJson(resolve(reportRoot, "integration.json"), report);
if (options.stage === "final" && files.length === 0)
    throw new TypeError("Final integration suite is absent");
console.log(
    `integration ${report.complete ? "present" : "incomplete"}: ${files.length} file(s); ` +
        `outcomes: ${provenance.ratified} ratification-bound, ` +
        `${provenance.unverifiable} unverifiable (reasoned), ${provenance.signed} signed`
);

function parseArguments(args) {
    let stage = "building";
    let updateOutcomes = false;
    let acceptRewrite;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--stage") stage = args[++index];
        else if (args[index] === "--update-outcomes") updateOutcomes = true;
        else if (args[index] === "--accept-rewrite") acceptRewrite = args[++index];
        else throw new TypeError(`Unknown integration argument ${args[index]}`);
    }
    if (stage !== "building" && stage !== "final") {
        throw new TypeError(`Unknown integration stage ${stage}`);
    }
    if (acceptRewrite !== undefined && !updateOutcomes) {
        throw new TypeError("--accept-rewrite requires --update-outcomes");
    }
    return { stage, updateOutcomes, acceptRewrite };
}

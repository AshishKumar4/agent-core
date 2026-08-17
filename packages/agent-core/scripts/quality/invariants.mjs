// Invariant certification: every ACQ rule's checker node ran in this run and passed.
//
// The rule registry is the only place a rule names the checker that enforces it, so a
// rule naming a node the graph does not state, or one this node does not depend on, would
// be certified from a report the run never produced. Both are checked before the report
// is read, and graph membership is checked before the hermetic deferral below: otherwise
// an unknown node reads as `hermetic[node] !== true` and is reported as deferred to
// governance rather than failing.
//
// With --hermetic, rules whose checker is a process node (multi-agent change-review
// governance) defer to the governed stages: the hermetic closure never runs those
// checkers, so their rules are reported as deferred rather than silently dropped.
import { resolve } from "node:path";
import { dependencyClosure, hermeticEdges } from "./dag.mjs";
import {
    artifactRoot,
    assertUniqueIds,
    readCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";

const options = parseArguments(process.argv.slice(2));
const graph = await readCanonicalJson(resolve(options.artifactRoot, "quality/check-dag.json"));
const rules = await readCanonicalJson(resolve(options.artifactRoot, "quality/rules.json"));
assertUniqueIds(rules.rules, (rule) => rule.id, "quality/rules.json rules");
const certifiable = dependencyClosure(
    ["invariants"],
    options.hermetic ? hermeticEdges(graph) : graph.nodes
);
const passed = [];
const deferred = [];
for (const rule of rules.rules) {
    if (graph.nodes[rule.node] === undefined) {
        throw new TypeError(
            `${rule.id} names checker node ${rule.node}, which the quality graph omits`
        );
    }
    if (options.hermetic && graph.hermetic[rule.node] !== true) {
        deferred.push(rule.id);
        continue;
    }
    if (!certifiable.has(rule.node)) {
        throw new TypeError(
            `${rule.id} checker node ${rule.node} is not a dependency of invariants`
        );
    }
    const report = await nodeReport(rule);
    if (report.status !== "passed") {
        throw new TypeError(`${rule.id} checker node ${rule.node} did not pass`);
    }
    passed.push(rule.id);
}
const invariants = {
    edition: "1.0.0",
    stage: options.stage,
    passed: [...new Set(passed)].sort()
};
if (options.hermetic) invariants.deferredToGovernance = [...new Set(deferred)].sort();
await writeCanonicalJson(resolve(options.reportRoot, "invariants.json"), invariants);
console.log(
    `executed checker invariants verified: ${passed.length}` +
        (deferred.length > 0 ? ` (${deferred.length} deferred to governance)` : "")
);

async function nodeReport(rule) {
    try {
        return await readCanonicalJson(resolve(options.reportRoot, "nodes", `${rule.node}.json`));
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        throw new TypeError(`${rule.id} checker node ${rule.node} produced no report`);
    }
}

function parseArguments(args) {
    let stage = "building";
    let hermetic = false;
    let selectedArtifactRoot = artifactRoot;
    let selectedReportRoot = reportRoot;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--hermetic") hermetic = true;
        else if (argument === "--artifact-root")
            selectedArtifactRoot = resolve(required(args, ++index, argument));
        else if (argument === "--report-root")
            selectedReportRoot = resolve(required(args, ++index, argument));
        else throw new TypeError(`Unknown invariants argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return {
        stage,
        hermetic,
        artifactRoot: selectedArtifactRoot,
        reportRoot: selectedReportRoot
    };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}

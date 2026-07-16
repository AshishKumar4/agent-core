// @ts-nocheck
import { resolve } from "node:path";
import { artifactRoot, readCanonicalJson, reportRoot, writeCanonicalJson } from "./project.mjs";

// With --hermetic, rules whose checker is a process node (multi-agent change-review
// governance) defer to the governed stages: the hermetic closure never runs those
// checkers, so their rules are reported as deferred rather than silently dropped.
const hermetic = process.argv.includes("--hermetic");
const graph = await readCanonicalJson(resolve(artifactRoot, "quality/check-dag.json"));
const rules = await readCanonicalJson(resolve(artifactRoot, "quality/rules.json"));
const passed = [];
const deferred = [];
for (const rule of rules.rules) {
    if (hermetic && graph.hermetic[rule.node] !== true) {
        deferred.push(rule.id);
        continue;
    }
    const report = await readCanonicalJson(resolve(reportRoot, "nodes", `${rule.node}.json`));
    if (report.status !== "passed") {
        throw new TypeError(`${rule.id} checker node ${rule.node} did not pass`);
    }
    passed.push(rule.id);
}
await writeCanonicalJson(resolve(reportRoot, "invariants.json"), {
    edition: "1.0.0",
    passed: [...new Set(passed)].sort(),
    ...(hermetic ? { deferredToGovernance: [...new Set(deferred)].sort() } : {})
});
console.log(
    `executed checker invariants verified: ${passed.length}` +
        (deferred.length > 0 ? ` (${deferred.length} deferred to governance)` : "")
);

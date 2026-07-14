import { resolve } from "node:path";
import { artifactRoot, readCanonicalJson, reportRoot, writeCanonicalJson } from "./project.mjs";

const rules = await readCanonicalJson(resolve(artifactRoot, "quality/rules.json"));
const passed = [];
for (const rule of rules.rules) {
    const report = await readCanonicalJson(resolve(reportRoot, "nodes", `${rule.node}.json`));
    if (report.status !== "passed") {
        throw new TypeError(`${rule.id} checker node ${rule.node} did not pass`);
    }
    passed.push(rule.id);
}
await writeCanonicalJson(resolve(reportRoot, "invariants.json"), {
    edition: "1.0.0",
    passed: [...new Set(passed)].sort()
});
console.log(`executed checker invariants verified: ${passed.length}`);

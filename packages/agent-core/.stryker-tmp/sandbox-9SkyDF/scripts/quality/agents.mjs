// @ts-nocheck
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
    artifactRoot,
    packageRoot,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";
import { executedTestSelectors, requirePassingTests } from "./evidence.mjs";
import { requireCitedText } from "./citations.mjs";

const vocabulary = await readCanonicalJson(resolve(artifactRoot, "quality/rules.json"));
const compliance = await readCanonicalJson(resolve(artifactRoot, "quality/agents-compliance.json"));
const expected = new Set(vocabulary.rules.map((rule) => rule.id));
const actual = new Set();
const executed = await executedTestSelectors();
for (const rule of compliance.rules) {
    if (actual.has(rule.id)) throw new TypeError(`Duplicate AGENTS compliance rule ${rule.id}`);
    actual.add(rule.id);
    if (
        !Array.isArray(rule.instructions) ||
        rule.instructions.length === 0 ||
        !Array.isArray(rule.tests) ||
        rule.tests.length === 0
    ) {
        throw new TypeError(`AGENTS compliance rule ${rule.id} lacks instructions or tests`);
    }
    await requireCitedText(rule.instructions, rule.instructionContains, rule.id, repositoryRoot);
    await access(resolve(packageRoot, rule.checker));
    requirePassingTests(rule.tests, executed, rule.id);
}
const missing = [...expected].filter((id) => !actual.has(id));
const extra = [...actual].filter((id) => !expected.has(id));
if (missing.length > 0 || extra.length > 0) {
    throw new TypeError(
        `AGENTS compliance denominator mismatch; missing=${missing.join(",")} extra=${extra.join(",")}`
    );
}
await writeCanonicalJson(resolve(reportRoot, "agents-compliance.json"), {
    edition: "1.0.0",
    rules: [...actual].sort(),
    complete: true
});
console.log(`AGENTS compliance checks verified: ${actual.size}`);

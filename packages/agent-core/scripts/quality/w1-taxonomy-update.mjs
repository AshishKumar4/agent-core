// Regenerates artifacts/quality/w1-error-taxonomy.json (v4) from a
// live scan of the audited sources. Entries match by semantic anchor and keep their
// reviewed content. A new or vanished site fails until a reviewer updates the artifact;
// regeneration never classifies or removes evidence by itself.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCanonicalJson, portablePath } from "./project.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactPath = resolve(packageRoot, "artifacts/quality/w1-error-taxonomy.json");
const coverage = readFileSync(
    resolve(packageRoot, "artifacts/integration/request-archive/W1/coverage.md"),
    "utf8"
);
const sources = [...coverage.matchAll(/^src\/[^\n]+\.ts$/gm)].map((match) => match[0]);

// Node runs TypeScript directly, so the scanner is imported as written. It used to be
// transpiled into a temporary module with its compiler import rewritten to an absolute
// path, which TypeScript 7 could not do anyway: there is no in-process transpiler.
const { reconcileAnchors, scanSource } = await import(
    pathToFileURL(resolve(packageRoot, "test/core/w1-scanner.ts")).href
);

const taxonomy = parseCanonicalJson(readFileSync(artifactPath, "utf8"), portablePath(artifactPath));
if (taxonomy.schemaVersion !== "agent-core.error-taxonomy/v4") {
    throw new TypeError("W1 taxonomy must use schema agent-core.error-taxonomy/v4");
}
const live = sources.flatMap(
    (source) => scanSource(source, readFileSync(resolve(packageRoot, source), "utf8")).typeErrors
);
const reconciliation = reconcileAnchors(taxonomy.entries, live);
for (const [label, keys] of Object.entries(reconciliation)) {
    if (keys.length > 0) console.error(`${label}:\n${keys.join("\n")}`);
}
if (Object.values(reconciliation).some((keys) => keys.length > 0)) process.exit(1);
const entries = taxonomy.entries
    .map((entry) => ({
        id: entry.id,
        source: entry.source,
        sourceAnchor: entry.sourceAnchor,
        classification: entry.classification,
        rationale: entry.rationale,
        testedBy: entry.testedBy
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
writeFileSync(
    artifactPath,
    JSON.stringify(
        {
            schemaVersion: "agent-core.error-taxonomy/v4",
            sources,
            testCases: taxonomy.testCases,
            entries
        },
        null,
        4
    ) + "\n"
);
console.log(`W1 taxonomy reconciled: ${entries.length} entries across ${sources.length} sources`);

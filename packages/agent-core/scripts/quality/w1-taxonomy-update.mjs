// Regenerates artifacts/quality/w1-error-taxonomy.json (v4) from a
// live scan of the audited sources. Entries match by semantic anchor and keep their
// reviewed content. A new or vanished site fails until a reviewer updates the artifact;
// regeneration never classifies or removes evidence by itself.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseCanonicalJson, portablePath } from "./project.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactPath = resolve(packageRoot, "artifacts/quality/w1-error-taxonomy.json");
const coverage = readFileSync(
    resolve(packageRoot, "artifacts/integration/request-archive/W1/coverage.md"),
    "utf8"
);
const sources = [...coverage.matchAll(/^src\/[^\n]+\.ts$/gm)].map((match) => match[0]);

const scannerSource = readFileSync(resolve(packageRoot, "test/core/w1-scanner.ts"), "utf8");
const transpiled = ts
    .transpileModule(scannerSource, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    })
    .outputText.replace(
        'from "typescript"',
        `from ${JSON.stringify(resolve(packageRoot, "node_modules/typescript/lib/typescript.js"))}`
    );
const scannerDir = mkdtempSync(join(tmpdir(), "w1-scanner-"));
const scannerPath = join(scannerDir, "scanner.mjs");
writeFileSync(scannerPath, transpiled);
const { reconcileAnchors, scanSource } = await import(scannerPath);
rmSync(scannerDir, { recursive: true, force: true });

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
console.log(`W1 taxonomy regenerated: ${entries.length} entries across ${sources.length} sources`);

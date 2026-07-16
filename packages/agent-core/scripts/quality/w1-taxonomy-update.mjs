// Regenerates artifacts/integration/request-archive/W1/error-taxonomy.json (v3) from a
// live scan of the audited sources. Existing entries are matched by anchor identity and
// keep their id, classification, rationale, and testedBy; a scan site with no matching
// entry fails the run and must be classified by a reviewer before the artifact updates.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactPath = resolve(
    packageRoot,
    "artifacts/integration/request-archive/W1/error-taxonomy.json"
);
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
const { anchorKey, scanSource } = await import(scannerPath);
rmSync(scannerDir, { recursive: true, force: true });

const taxonomy = JSON.parse(readFileSync(artifactPath, "utf8"));
const previous = new Map(taxonomy.entries.map((entry) => [anchorKey(entry), entry]));
const byExpression = new Map();
for (const entry of taxonomy.entries) {
    const key = `${entry.source}\u0000${entry.sourceAnchor.container}\u0000${entry.sourceAnchor.expression}`;
    if (!byExpression.has(key)) byExpression.set(key, []);
    byExpression.get(key).push(entry);
}
const live = sources.flatMap(
    (source) => scanSource(source, readFileSync(resolve(packageRoot, source), "utf8")).typeErrors
);

const unmatched = [];
const entries = live.map((construction) => {
    let existing = previous.get(anchorKey(construction));
    if (existing === undefined) {
        const key = `${construction.source}\u0000${construction.sourceAnchor.container}\u0000${construction.sourceAnchor.expression}`;
        existing = (byExpression.get(key) ?? []).find((candidate) =>
            previous.has(anchorKey(candidate))
        );
        if (existing !== undefined) {
            console.error(
                `note: rematched ${construction.file}:${construction.line} by container+expression (guard drift)`
            );
        }
    }
    if (existing === undefined) {
        unmatched.push(construction);
        return undefined;
    }
    previous.delete(anchorKey(existing));
    return {
        ...existing,
        file: construction.file,
        line: construction.line,
        source: construction.source,
        sourceAnchor: construction.sourceAnchor
    };
});
if (unmatched.length > 0) {
    console.error("Unclassified TypeError sites require reviewed entries:");
    for (const construction of unmatched) {
        console.error(JSON.stringify(construction, null, 2));
    }
    process.exit(1);
}
for (const removed of previous.values()) {
    console.error(
        `note: removed entry for vanished site ${removed.file}:${removed.line} (${removed.id})`
    );
}
const sorted = entries
    .filter((entry) => entry !== undefined)
    .sort(
        (left, right) =>
            (left.file + left.line).localeCompare(right.file + right.line) || left.line - right.line
    );
const testCases = Object.fromEntries(
    Object.entries(taxonomy.testCases).filter(([source]) =>
        sorted.some((entry) => entry.source === source)
    )
);
writeFileSync(
    artifactPath,
    JSON.stringify(
        {
            schemaVersion: "agent-core.error-taxonomy/v3",
            sources,
            testCases,
            entries: sorted
        },
        null,
        4
    ) + "\n"
);
console.log(`W1 taxonomy regenerated: ${sorted.length} entries across ${sources.length} sources`);

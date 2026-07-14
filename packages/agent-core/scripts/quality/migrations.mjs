import { basename, resolve } from "node:path";
import {
    artifactRoot,
    collectFiles,
    readCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";
import {
    createProgram,
    executedTestSelectors,
    requirePassingTests,
    resolveSourceSymbol
} from "./evidence.mjs";

const stageIndex = process.argv.indexOf("--stage");
const stage = stageIndex < 0 ? "building" : process.argv[stageIndex + 1];
if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
const rootIndex = process.argv.indexOf("--artifact-root");
const selectedArtifactRoot = rootIndex < 0 ? artifactRoot : resolve(process.argv[rootIndex + 1]);
const index = await readCanonicalJson(resolve(selectedArtifactRoot, "migrations/index.json"));
const ownership = await readCanonicalJson(resolve(selectedArtifactRoot, "quality/ownership.json"));
const fragmentOwners = new Map(
    Object.entries(ownership.domainFragments).map(([owner, fragment]) => [
        `${fragment}.json`,
        owner
    ])
);
const conformanceIndex = await readCanonicalJson(
    resolve(selectedArtifactRoot, "conformance/index.json")
);
const conformanceFragments = await Promise.all(
    [conformanceIndex.seed, ...conformanceIndex.fragments].map((name) =>
        readCanonicalJson(resolve(selectedArtifactRoot, "conformance", name))
    )
);
const requirements = new Map(
    conformanceFragments
        .flatMap((fragment) => fragment.requirements)
        .map((requirement) => [requirement.id, requirement])
);
const fragments = await Promise.all(
    [index.seed, ...index.fragments].map(async (name) => ({
        name,
        value: await readCanonicalJson(resolve(selectedArtifactRoot, "migrations", name))
    }))
);
const actualFragments = (
    await collectFiles(resolve(selectedArtifactRoot, "migrations"), (path) =>
        path.endsWith(".json")
    )
)
    .map((path) => basename(path))
    .filter((name) => name !== "index.json")
    .sort();
if (JSON.stringify(actualFragments) !== JSON.stringify([index.seed, ...index.fragments].sort())) {
    throw new TypeError("Migration fragments differ from the exact index");
}
for (const fragment of fragments) {
    const expectedOwner =
        fragment.name === index.seed ? "W0-seed" : fragmentOwners.get(fragment.name);
    if (expectedOwner === undefined || fragment.value.owner !== expectedOwner) {
        throw new TypeError(`Migration fragment ${fragment.name} is owned by the wrong wave`);
    }
}
const migrationById = new Map();
const suppliedIds = new Set();
for (const fragment of fragments) {
    for (const migration of fragment.value.migrations) {
        const fields = [
            "id",
            "owner",
            "remainingEvidence",
            "sourceSymbols",
            "specRequirement",
            "status",
            "testSelectors"
        ];
        if (JSON.stringify(Object.keys(migration).sort()) !== JSON.stringify(fields.sort())) {
            throw new TypeError(
                `Migration ${migration.id ?? "<unknown>"} has missing or unknown fields`
            );
        }
        if (
            !Array.isArray(migration.sourceSymbols) ||
            !Array.isArray(migration.testSelectors) ||
            !Array.isArray(migration.remainingEvidence)
        ) {
            throw new TypeError(`Migration ${migration.id} has malformed evidence`);
        }
        if (!requirements.has(migration.specRequirement)) {
            throw new TypeError(`Migration ${migration.id} has missing SPEC requirement`);
        }
        if (fragment.name !== index.seed) {
            if (migration.owner !== fragment.value.owner) {
                throw new TypeError(
                    `Migration ${migration.id} is stored in another wave's fragment`
                );
            }
            if (suppliedIds.has(migration.id)) {
                throw new TypeError(`Duplicate migration ${migration.id}`);
            }
            suppliedIds.add(migration.id);
            migrationById.set(migration.id, migration);
        } else {
            if (migration.status !== "planned") {
                throw new TypeError(`Migration ${migration.id} seed status must remain planned`);
            }
            if (!migrationById.has(migration.id)) migrationById.set(migration.id, migration);
        }
    }
}
const migrations = [...migrationById.values()];
const ids = new Set(migrationById.keys());
const verified = migrations.filter((migration) => migration.status === "verified");
for (const migration of migrations) {
    const requirement = requirements.get(migration.specRequirement);
    if (migration.status === "verified") {
        if (
            migration.sourceSymbols.length === 0 ||
            migration.testSelectors.length === 0 ||
            migration.remainingEvidence.length > 0
        )
            throw new TypeError(`Migration ${migration.id} lacks durable evidence`);
        if (requirement.status !== "verified") {
            throw new TypeError(
                `Migration ${migration.id} cannot verify before ${migration.specRequirement}`
            );
        }
    } else if (migration.status !== "planned" && migration.status !== "implemented") {
        throw new TypeError(`Migration ${migration.id} has unknown status ${migration.status}`);
    }
}
if (verified.length > 0) {
    const program = createProgram();
    const executedTests = await executedTestSelectors();
    for (const migration of verified) {
        for (const selector of migration.sourceSymbols) resolveSourceSymbol(program, selector);
        requirePassingTests(migration.testSelectors, executedTests, migration.id);
    }
}
const incomplete = migrations.filter((migration) => migration.status !== "verified");
const missing = index.required.filter((id) => !ids.has(id));
const extra = [...ids].filter((id) => !index.required.includes(id));
await writeCanonicalJson(resolve(reportRoot, "migrations.json"), {
    edition: "1.0.0",
    stage,
    migrations: migrations.length,
    missing,
    extra,
    incomplete: incomplete.map((migration) => migration.id).sort(),
    complete: incomplete.length === 0 && missing.length === 0 && extra.length === 0
});
if (stage === "final" && (incomplete.length > 0 || missing.length > 0 || extra.length > 0))
    throw new TypeError(
        `Final migrations are incomplete: ${incomplete.map((item) => item.id).join(", ")} missing=${missing.join(",")} extra=${extra.join(",")}`
    );
console.log(
    `migrations ${incomplete.length === 0 ? "complete" : "incomplete"}: ${migrations.length - incomplete.length}/${migrations.length} verified`
);

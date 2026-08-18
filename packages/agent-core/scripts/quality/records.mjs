import { basename, relative, resolve } from "node:path";
import { discoverCodecRecords } from "./codec-records.mjs";
import {
    artifactRoot,
    assertFlatFragmentNames,
    collectFiles,
    isNonEmptyString,
    readCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";
import {
    executedTestSelectors,
    requirePassingTests,
    resolveSourceSymbol,
    sourceProject
} from "./evidence.mjs";
import { validateRecordContentRetention, validateRecordOwnership } from "./record-ownership.mjs";

const stage = stageArgument(process.argv.slice(2));
const selectedArtifactRoot = pathArgument(process.argv.slice(2), "--artifact-root") ?? artifactRoot;
const selectedSourceRoot = pathArgument(process.argv.slice(2), "--source-root");
const sourceRoots =
    selectedSourceRoot === undefined
        ? [
              { root: resolve(process.cwd(), "src"), prefix: "" },
              {
                  root: resolve(process.cwd(), "../agent-core-cloudflare/src"),
                  prefix: "cloudflare/"
              }
          ]
        : [{ root: selectedSourceRoot, prefix: "" }];
const discoveredCodecs = new Map(
    (
        await Promise.all(
            sourceRoots.map((source) => discoverCodecRecords(source.root, source.prefix))
        )
    )
        .flat()
        .map((record) => [record.source, record.kind])
);
const discovered = new Set(discoveredCodecs.keys());
const ownership = await readCanonicalJson(resolve(selectedArtifactRoot, "quality/ownership.json"));
const index = await readCanonicalJson(resolve(selectedArtifactRoot, "records/index.json"));
const activeFragmentNames = assertFlatFragmentNames(index.fragments ?? [], "Record fragments");
const pendingFragmentNames = assertFlatFragmentNames(
    index.pendingFragments ?? [],
    "Pending record fragments"
);
if (activeFragmentNames.some((name) => pendingFragmentNames.includes(name))) {
    throw new TypeError("Record fragment is both active and pending");
}
const fragmentOwners = new Map(
    Object.entries(ownership.domainFragments).map(([owner, fragment]) => [
        `${fragment}.json`,
        owner
    ])
);
const recordsRoot = resolve(selectedArtifactRoot, "records");
const files = (await collectFiles(recordsRoot, (path) => path.endsWith(".json"))).filter(
    (path) => relative(recordsRoot, path).replaceAll("\\", "/") !== "index.json"
);
const actualFragmentNames = files
    .map((path) => relative(recordsRoot, path).replaceAll("\\", "/"))
    .sort();
if (
    JSON.stringify(actualFragmentNames) !==
    JSON.stringify([...activeFragmentNames, ...pendingFragmentNames].sort())
) {
    throw new TypeError("Record fragments differ from the exact index");
}
const records = [];
const activeOwnershipRecords = [];
const ownershipRecords = [];
for (const path of files.filter((path) => activeFragmentNames.includes(basename(path)))) {
    const fragment = await readCanonicalJson(path);
    if (
        fragment.edition !== "1.0.0" ||
        !isNonEmptyString(fragment.owner) ||
        !Array.isArray(fragment.records)
    ) {
        throw new TypeError("Durable record fragment is malformed");
    }
    if (fragmentOwners.get(basename(path)) !== fragment.owner) {
        throw new TypeError(`Record fragment ${basename(path)} is owned by the wrong wave`);
    }
    for (const record of fragment.records) {
        activeOwnershipRecords.push(record);
        ownershipRecords.push(record);
        records.push({ ...record, fragmentOwner: fragment.owner });
    }
}
for (const path of files.filter((path) => pendingFragmentNames.includes(basename(path)))) {
    const fragment = await readCanonicalJson(path);
    if (
        fragment.edition !== "1.0.0" ||
        fragmentOwners.get(basename(path)) !== fragment.owner ||
        !Array.isArray(fragment.records) ||
        fragment.records.length === 0
    ) {
        throw new TypeError(`Pending record fragment ${basename(path)} is malformed`);
    }
    ownershipRecords.push(...fragment.records);
}
const project = sourceProject();
validateRecordOwnership(ownershipRecords);
validateRecordContentRetention(activeOwnershipRecords, project);
const missing = [...discovered].filter(
    (selector) => !records.some((record) => record.source === selector)
);
const extra = records
    .filter((record) => !discovered.has(record.source))
    .map((record) => record.source);
if (records.length > 0) {
    const executedTests = await executedTestSelectors();
    for (const record of records) {
        if (!discovered.has(record.source))
            throw new TypeError(`Record row has no discovered codec class ${record.source}`);
        if (discoveredCodecs.get(record.source) !== record.kind) {
            throw new TypeError(
                `Record ${record.source} kind ${record.kind} does not match its actual RecordCodec kind ${discoveredCodecs.get(record.source)}`
            );
        }
        for (const selector of [record.source, record.codec, record.store].filter(Boolean)) {
            resolveSourceSymbol(project, selector);
        }
        requirePassingTests(record.tests, executedTests, record.kind);
    }
}
await writeCanonicalJson(resolve(reportRoot, "records.json"), {
    edition: "1.0.0",
    stage,
    records,
    missing,
    extra,
    pendingFragments: pendingFragmentNames,
    complete: missing.length === 0 && extra.length === 0 && pendingFragmentNames.length === 0
});
if (
    stage === "final" &&
    (missing.length > 0 || extra.length > 0 || pendingFragmentNames.length > 0)
) {
    throw new TypeError(
        `Final record denominator mismatch; missing=${missing.join(",")} extra=${extra.join(",")} pending=${pendingFragmentNames.join(",")}`
    );
}
console.log(
    `record registry ${missing.length === 0 ? "complete" : "incomplete"}: ${records.length}/${discovered.size} classified`
);

function stageArgument(args) {
    const index = args.indexOf("--stage");
    const stage = index < 0 ? "building" : args[index + 1];
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return stage;
}

function pathArgument(args, name) {
    const index = args.indexOf(name);
    return index < 0 ? undefined : resolve(args[index + 1]);
}

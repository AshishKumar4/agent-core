import { relative, resolve } from "node:path";
import {
    artifactRoot,
    assertFlatFragmentNames,
    assertUniqueStrings,
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
import { discoverNormativeSeams } from "./seam-discovery.mjs";

const stage = stageArgument(process.argv.slice(2));
const selectedArtifactRoot = pathArgument(process.argv.slice(2), "--artifact-root") ?? artifactRoot;
const program = createProgram();
const discovered = discoverNormativeSeams(program);
const index = await readCanonicalJson(resolve(selectedArtifactRoot, "seams/index.json"));
assertUniqueStrings(index.required, "Required seams");
const ownership = await readCanonicalJson(resolve(selectedArtifactRoot, "quality/ownership.json"));
const fragmentOwners = new Map(
    Object.entries(ownership.domainFragments).map(([owner, fragment]) => [
        `${fragment}.json`,
        owner
    ])
);
const activeFragments = assertFlatFragmentNames(index.fragments ?? [], "Seam fragments");
const pendingFragments = assertFlatFragmentNames(
    index.pendingFragments ?? [],
    "Pending seam fragments"
);
if (activeFragments.some((name) => pendingFragments.includes(name))) {
    throw new TypeError("Seam fragment is both active and pending");
}
const files = activeFragments.map((name) => resolve(selectedArtifactRoot, "seams", name));
const pendingRequired = assertUniqueStrings(index.pendingRequired ?? [], "Pending required seams");
const discoveredDispositions = index.discoveredDispositions ?? {};
if (
    discoveredDispositions === null ||
    Array.isArray(discoveredDispositions) ||
    typeof discoveredDispositions !== "object" ||
    Object.entries(discoveredDispositions).some(
        ([contract, disposition]) =>
            !contract.startsWith("src/") ||
            typeof disposition !== "string" ||
            !index.required.includes(disposition)
    )
) {
    throw new TypeError("Discovered seam dispositions are malformed");
}
const allFragmentNames = [...activeFragments, ...pendingFragments];
const seamsRoot = resolve(selectedArtifactRoot, "seams");
const discoveredFragments = await collectFiles(seamsRoot, (path) => path.endsWith(".json"));
const actualFragments = discoveredFragments
    .map((path) => relative(seamsRoot, path).replaceAll("\\", "/"))
    .filter((name) => name !== "index.json")
    .sort();
if (JSON.stringify(actualFragments) !== JSON.stringify([...allFragmentNames].sort())) {
    throw new TypeError("Seam fragments differ from the exact index");
}
const pendingIds = new Set();
for (const name of pendingFragments) {
    const fragment = await readCanonicalJson(resolve(selectedArtifactRoot, "seams", name));
    if (
        fragment.edition !== "1.0.0" ||
        fragmentOwners.get(name) !== fragment.owner ||
        !Array.isArray(fragment.seams) ||
        fragment.seams.length === 0
    ) {
        throw new TypeError(`Pending seam fragment ${name} is malformed`);
    }
    for (const seam of fragment.seams) {
        validateSeamStructure(seam, pendingIds);
        pendingIds.add(seam.id);
    }
}
if (JSON.stringify([...pendingIds].sort()) !== JSON.stringify([...pendingRequired].sort())) {
    throw new TypeError("Pending seam requirements differ from their exact fragments");
}
const seamIds = new Set();
const seams = [];
for (const path of files) {
    const fragment = await readCanonicalJson(path);
    if (
        fragment.edition !== "1.0.0" ||
        typeof fragment.owner !== "string" ||
        !Array.isArray(fragment.seams)
    ) {
        throw new TypeError("Seam fragment is malformed");
    }
    if (fragmentOwners.get(path.split(/[\\/]/u).at(-1)) !== fragment.owner) {
        throw new TypeError("Seam fragment is owned by the wrong wave");
    }
    for (const seam of fragment.seams) {
        validateSeamStructure(seam, seamIds);
        if (pendingIds.has(seam.id)) throw new TypeError(`Seam ${seam.id} is active and pending`);
        seamIds.add(seam.id);
        seams.push({ ...seam, fragmentOwner: fragment.owner });
    }
}
const missing = index.required.filter((id) => !seamIds.has(id));
const extra = [...seamIds].filter((id) => !index.required.includes(id));
const discoveredMissing = discovered.filter((candidate) => classifiedSeam(candidate) === undefined);
const incompleteDiscoveries = discovered.filter((candidate) => {
    const seam = classifiedSeam(candidate);
    return (
        seam !== undefined &&
        candidate.implementations.some(
            (implementation) => !seam.implementations.includes(implementation)
        )
    );
});
const staleDispositions = Object.keys(discoveredDispositions).filter(
    (contract) => !discovered.some((candidate) => candidate.contract === contract)
);
if (seams.length > 0) {
    const executedTests = await executedTestSelectors();
    for (const seam of seams) {
        for (const selector of [seam.contract, seam.memoryReference, ...seam.implementations]) {
            resolveSourceSymbol(program, selector);
        }
        requirePassingTests([seam.contractTest], executedTests, seam.id);
    }
}
await writeCanonicalJson(resolve(reportRoot, "seams.json"), {
    edition: "1.0.0",
    stage,
    seams,
    missing,
    extra,
    discovered,
    discoveredMissing: discoveredMissing.map((candidate) => candidate.contract),
    incompleteDiscoveries: incompleteDiscoveries.map((candidate) => candidate.contract),
    staleDispositions,
    pendingFragments,
    complete:
        missing.length === 0 &&
        extra.length === 0 &&
        discoveredMissing.length === 0 &&
        incompleteDiscoveries.length === 0 &&
        staleDispositions.length === 0 &&
        pendingFragments.length === 0
});
if (
    stage === "final" &&
    (missing.length > 0 ||
        extra.length > 0 ||
        discoveredMissing.length > 0 ||
        incompleteDiscoveries.length > 0 ||
        staleDispositions.length > 0 ||
        pendingFragments.length > 0)
) {
    throw new TypeError(
        `Final seam denominator mismatch; missing=${missing.join(",")} extra=${extra.join(",")} discovered=${discoveredMissing.map((candidate) => candidate.contract).join(",")} incomplete=${incompleteDiscoveries.map((candidate) => candidate.contract).join(",")} stale=${staleDispositions.join(",")} pending=${pendingFragments.join(",")}`
    );
}
console.log(
    `seam registry ${missing.length === 0 && discoveredMissing.length === 0 && incompleteDiscoveries.length === 0 ? "complete" : "incomplete"}: ${seams.length}/${index.required.length} verified, ${discovered.length} independently discovered`
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

function validateSeamStructure(seam, ids) {
    const fields = [
        "id",
        "contract",
        "implementations",
        "memoryReference",
        "contractTest",
        "disposition"
    ];
    if (JSON.stringify(Object.keys(seam).sort()) !== JSON.stringify(fields.sort())) {
        throw new TypeError(`Seam ${seam.id ?? "<unknown>"} has missing or unknown fields`);
    }
    if (
        ids.has(seam.id) ||
        [seam.id, seam.contract].some((value) => typeof value !== "string" || value.length === 0) ||
        seam.disposition !== "verified" ||
        !Array.isArray(seam.implementations) ||
        seam.implementations.length === 0 ||
        new Set(seam.implementations).size !== seam.implementations.length ||
        seam.implementations.some((value) => typeof value !== "string" || value.length === 0)
    ) {
        throw new TypeError(`Seam ${seam.id ?? "<unknown>"} is duplicated or malformed`);
    }
    if (
        typeof seam.memoryReference !== "string" ||
        seam.memoryReference.length === 0 ||
        typeof seam.contractTest !== "string" ||
        seam.contractTest.length === 0
    ) {
        throw new TypeError(`Seam ${seam.id} lacks a memory reference or shared contract`);
    }
    if (!seam.implementations.includes(seam.memoryReference)) {
        throw new TypeError(`Seam ${seam.id} memory reference is not an implementation`);
    }
    if (!seam.contractTest.includes(`[${seam.id}]`)) {
        throw new TypeError(`Seam ${seam.id} contract test must include the seam ID`);
    }
}

function classifiedSeam(candidate) {
    return seams.find(
        (seam) =>
            seam.contract === candidate.contract ||
            seam.id === discoveredDispositions[candidate.contract]
    );
}

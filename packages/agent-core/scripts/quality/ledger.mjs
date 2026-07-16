import { relative, resolve } from "node:path";
import {
    artifactRoot,
    assertExactKeys,
    assertFlatFragmentNames,
    assertString,
    assertUniqueStrings,
    collectFiles,
    packageRoot,
    readCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";
import { specRequirements } from "./spec.mjs";
import {
    createProgram,
    executedTestSelectors,
    requirePassingTests,
    resolveSourceSymbol
} from "./evidence.mjs";
import { ownersForPath, patternsForOwnership } from "./ownership.mjs";

const options = parseArguments(process.argv.slice(2));
const ledgerArtifactRoot = options.artifactRoot;
const index = await readCanonicalJson(resolve(ledgerArtifactRoot, "conformance/index.json"));
const stageArtifact = await readCanonicalJson(
    resolve(ledgerArtifactRoot, "conformance/stage.json")
);
if (options.hermetic) {
    // Hermetic runs verify the ledger at the maturity it declares: conformance/stage.json
    // is the single place the project claims building vs final, and flipping it to final
    // automatically tightens this gate everywhere the hermetic closure runs.
    options.stage = stageArtifact.stage;
}
if (options.stage === "final" && stageArtifact.stage !== "final") {
    throw new TypeError("Final conformance requires conformance/stage.json to be final");
}
const expected = await specRequirements(options.spec);
const ownership = await readCanonicalJson(resolve(ledgerArtifactRoot, "quality/ownership.json"));
const ownershipPatterns = patternsForOwnership(ownership);
const fragmentOwners = new Map(
    Object.entries(ownership.domainFragments).map(([owner, fragment]) => [
        `${fragment}.json`,
        owner
    ])
);
const expectedById = new Map(expected.map((requirement) => [requirement.id, requirement]));
const externalGates = new Set(
    assertUniqueStrings(index.externalGates ?? [], "External conformance gates")
);
const pendingStale = [];
const activeFragmentNames = assertFlatFragmentNames(index.fragments ?? [], "Conformance fragments");
const pendingFragmentNames = assertFlatFragmentNames(
    index.pendingFragments ?? [],
    "Pending conformance fragments"
);
if (activeFragmentNames.some((name) => pendingFragmentNames.includes(name))) {
    throw new TypeError("Conformance fragment is both active and pending");
}
const fragmentNames = [index.seed, ...activeFragmentNames];
const conformanceRoot = resolve(ledgerArtifactRoot, "conformance");
const actualFragmentNames = (await collectFiles(conformanceRoot, (path) => path.endsWith(".json")))
    .map((path) => relative(conformanceRoot, path).replaceAll("\\", "/"))
    .filter((name) => !["index.json", "schema.json", "stage.json"].includes(name))
    .sort();
if (
    JSON.stringify(actualFragmentNames) !==
    JSON.stringify([...fragmentNames, ...pendingFragmentNames].sort())
) {
    throw new TypeError("Conformance fragments differ from the exact index");
}
const pendingRequirementIds = new Set();
for (const name of pendingFragmentNames) {
    const fragment = await readCanonicalJson(resolve(ledgerArtifactRoot, "conformance", name));
    const pending = validateFragment(fragment, name, index.seed, fragmentOwners);
    for (const requirement of pending) {
        if (pendingRequirementIds.has(requirement.id)) {
            throw new TypeError(`Duplicate pending conformance requirement ${requirement.id}`);
        }
        pendingRequirementIds.add(requirement.id);
        const spec = expectedById.get(requirement.id);
        if (
            spec === undefined ||
            requirement.owner !== spec.owner ||
            requirement.specAnchor !== requirement.id ||
            requirement.specTextSha256 !== spec.digest
        ) {
            pendingStale.push(requirement.id);
        }
        validateStatus(requirement);
    }
}
const fragments = await Promise.all(
    fragmentNames.map(async (name) => ({
        name,
        value: await readCanonicalJson(resolve(ledgerArtifactRoot, "conformance", name))
    }))
);
const seedRequirements = validateFragment(
    fragments[0].value,
    index.seed,
    index.seed,
    fragmentOwners
);
const fragmentRequirements = fragments.slice(1).flatMap(({ name, value }) =>
    validateFragment(value, name, index.seed, fragmentOwners).map((requirement) => ({
        ...requirement,
        fragment: name
    }))
);
const byId = new Map();
for (const requirement of fragmentRequirements) {
    if (byId.has(requirement.id))
        throw new TypeError(`Duplicate conformance requirement ${requirement.id}`);
    byId.set(requirement.id, requirement);
}
for (const requirement of seedRequirements) {
    if (!byId.has(requirement.id))
        byId.set(requirement.id, { ...requirement, fragment: index.seed });
}
const requirements = [...byId.values()];
const missing = expected
    .filter((requirement) => !byId.has(requirement.id))
    .map((requirement) => requirement.id);
const extra = requirements
    .filter((requirement) => !expectedById.has(requirement.id))
    .map((requirement) => requirement.id);
if (missing.length > 0 || extra.length > 0) {
    throw new TypeError(
        `Conformance denominator mismatch; missing=${missing.join(",")} extra=${extra.join(",")}`
    );
}

for (const requirement of requirements) {
    const spec = expectedById.get(requirement.id);
    if (requirement.owner !== spec.owner)
        throw new TypeError(`${requirement.id} must be owned by ${spec.owner}`);
    if (requirement.specAnchor !== requirement.id || requirement.specTextSha256 !== spec.digest) {
        throw new TypeError(`${requirement.id} has stale SPEC evidence`);
    }
    validateStatus(requirement);
    if (
        requirement.fragment !== index.seed &&
        (requirement.status === "external-gated") !== externalGates.has(requirement.id)
    ) {
        throw new TypeError(`${requirement.id} external gate status differs from the exact index`);
    }
    if (options.stage === "final" && requirement.fragment === index.seed) {
        throw new TypeError(`${requirement.id} lacks an owner-supplied conformance fragment`);
    }
    for (const prerequisite of requirement.prerequisites) {
        if (!byId.has(prerequisite))
            throw new TypeError(`${requirement.id} has missing prerequisite ${prerequisite}`);
        if (requirement.status === "verified" && byId.get(prerequisite).status !== "verified") {
            throw new TypeError(`${requirement.id} depends on unverified ${prerequisite}`);
        }
    }
}
validateAcyclic(requirements, byId);

for (const id of externalGates) {
    if (!byId.has(id)) throw new TypeError(`External conformance gate is unknown: ${id}`);
}
const verified = requirements.filter((requirement) => requirement.status === "verified");
const externallyGated = requirements.filter(
    (requirement) => requirement.status === "external-gated"
);
const evidenced = [...verified, ...externallyGated];
if (evidenced.length > 0) {
    const rules = await readCanonicalJson(resolve(ledgerArtifactRoot, "quality/rules.json"));
    const knownInvariants = new Set(rules.rules.map((rule) => rule.id));
    const executedInvariants = new Set((await readCanonicalJson(options.invariantsReport)).passed);
    const program = createProgram();
    const selectorOwners = new Map();
    for (const requirement of evidenced) {
        for (const source of requirement.sourceSymbols) {
            requireEvidenceOwner(
                sourcePath(source),
                requirement.owner,
                ownershipPatterns,
                requirement.id
            );
            resolveSourceSymbol(program, source);
        }
        for (const selector of requirement.testSelectors) {
            if (!selector.includes(`[${requirement.id}]`)) {
                throw new TypeError(
                    `${requirement.id} test selector must include its requirement ID`
                );
            }
            const previous = selectorOwners.get(selector);
            if (previous !== undefined) {
                throw new TypeError(
                    `Conformance test selector is shared by ${previous} and ${requirement.id}`
                );
            }
            selectorOwners.set(selector, requirement.id);
            const testPath = selector.slice(0, selector.indexOf("#"));
            const owners = ownersForPath(repositoryTestPath(testPath), ownershipPatterns);
            if (!owners.includes(requirement.owner) && !owners.includes("W9")) {
                throw new TypeError(`${requirement.id} test is owned by another wave: ${testPath}`);
            }
        }
        for (const invariant of requirement.checkerInvariants) {
            if (!knownInvariants.has(invariant))
                throw new TypeError(`${requirement.id} names unknown invariant ${invariant}`);
            if (!executedInvariants.has(invariant)) {
                throw new TypeError(`${requirement.id} invariant did not execute: ${invariant}`);
            }
        }
    }
    const executedTests = await executedTestSelectors(options.testReports);
    for (const requirement of evidenced) {
        requirePassingTests(requirement.testSelectors, executedTests, requirement.id);
    }
}

const incomplete = requirements.filter(
    (requirement) => requirement.status !== "verified" && requirement.status !== "external-gated"
);
const report = {
    edition: "1.0.0",
    stage: options.stage,
    total: requirements.length,
    verified: verified.length,
    localApplicable: requirements.length - externallyGated.length,
    localApplicableVerified: verified.length,
    externalGated: externallyGated.map((requirement) => requirement.id).sort(),
    incomplete: incomplete.map((requirement) => requirement.id).sort(),
    pendingFragments: pendingFragmentNames,
    pendingStale: pendingStale.sort(),
    complete:
        incomplete.length === 0 &&
        pendingFragmentNames.length === 0 &&
        (options.stage === "building" || externallyGated.length === 0)
};
await writeCanonicalJson(resolve(reportRoot, "conformance.json"), report);
if (
    options.stage === "final" &&
    (incomplete.length > 0 || pendingFragmentNames.length > 0 || externallyGated.length > 0)
) {
    throw new TypeError(
        `Final conformance has ${incomplete.length} incomplete requirement(s), ${externallyGated.length} external gate(s), and pending fragments=${pendingFragmentNames.join(",")}`
    );
}
console.log(
    `conformance ${report.complete ? "complete" : "incomplete"}: ${verified.length}/${requirements.length - externallyGated.length} local applicable verified, ${externallyGated.length} external gated`
);

function validateFragment(fragment, name, seed, fragmentOwners) {
    assertExactKeys(fragment, ["edition", "owner", "requirements"], "Conformance fragment");
    if (fragment.edition !== "1.0.0")
        throw new TypeError("Unsupported conformance fragment edition");
    assertString(fragment.owner, "Conformance owner");
    const expectedOwner = name === seed ? "W0-seed" : fragmentOwners.get(name);
    if (expectedOwner === undefined || fragment.owner !== expectedOwner) {
        throw new TypeError(
            `Conformance fragment ${name} must be owned by ${expectedOwner ?? "a registered wave"}`
        );
    }
    if (!Array.isArray(fragment.requirements))
        throw new TypeError("Conformance requirements must be an array");
    return fragment.requirements.map((requirement) => {
        const validated = validateRequirement(requirement);
        if (name === seed && validated.status !== "planned") {
            throw new TypeError(`${validated.id} seed status must remain planned`);
        }
        if (name !== seed && validated.owner !== fragment.owner) {
            throw new TypeError(`${validated.id} is stored in another wave's fragment`);
        }
        return validated;
    });
}

function sourcePath(selector) {
    const path = selector.slice(0, selector.indexOf("#"));
    return path.startsWith("cloudflare/")
        ? `packages/agent-core-cloudflare/${path.slice("cloudflare/".length)}`
        : `packages/agent-core/${path}`;
}

function repositoryTestPath(path) {
    if (path.startsWith("packages/")) return path;
    if (path.startsWith("cloudflare/")) {
        return `packages/agent-core-cloudflare/${path.slice("cloudflare/".length)}`;
    }
    return `packages/agent-core/${path}`;
}

function requireEvidenceOwner(path, owner, patterns, requirement) {
    const owners = ownersForPath(path, patterns);
    if (owners.length !== 1 || owners[0] !== owner) {
        throw new TypeError(`${requirement} source is not owned by ${owner}: ${path}`);
    }
}

function validateRequirement(requirement) {
    assertExactKeys(
        requirement,
        [
            "checkerInvariants",
            "id",
            "owner",
            "prerequisites",
            "remainingEvidence",
            "sourceSymbols",
            "specAnchor",
            "specTextSha256",
            "status",
            "testSelectors"
        ],
        `Requirement ${requirement?.id ?? "<unknown>"}`
    );
    for (const field of ["id", "owner", "specAnchor", "specTextSha256", "status"]) {
        assertString(requirement[field], `Requirement ${field}`);
    }
    for (const field of [
        "prerequisites",
        "sourceSymbols",
        "testSelectors",
        "checkerInvariants",
        "remainingEvidence"
    ]) {
        assertUniqueStrings(requirement[field], `Requirement ${requirement.id} ${field}`);
    }
    if (!/^(?:C13|P11)-[A-Z0-9.-]+$/.test(requirement.id))
        throw new TypeError(`Invalid requirement ID ${requirement.id}`);
    return requirement;
}

function validateStatus(requirement) {
    if (requirement.status === "planned") {
        if (
            requirement.sourceSymbols.length > 0 ||
            requirement.testSelectors.length > 0 ||
            requirement.checkerInvariants.length > 0 ||
            requirement.remainingEvidence.length === 0
        ) {
            throw new TypeError(`${requirement.id} has invalid planned evidence`);
        }
        return;
    }
    if (requirement.status === "implemented") {
        if (requirement.sourceSymbols.length === 0 || requirement.remainingEvidence.length === 0) {
            throw new TypeError(`${requirement.id} has invalid implemented evidence`);
        }
        return;
    }
    if (requirement.status === "verified") {
        if (
            requirement.sourceSymbols.length === 0 ||
            requirement.testSelectors.length === 0 ||
            requirement.checkerInvariants.length === 0 ||
            requirement.remainingEvidence.length > 0
        ) {
            throw new TypeError(`${requirement.id} has incomplete verified evidence`);
        }
        return;
    }
    if (requirement.status === "external-gated") {
        if (requirement.sourceSymbols.length === 0 || requirement.remainingEvidence.length === 0) {
            throw new TypeError(`${requirement.id} has invalid external-gated evidence`);
        }
        return;
    }
    throw new TypeError(`${requirement.id} has unknown status ${requirement.status}`);
}

function validateAcyclic(requirements, byId) {
    const visiting = new Set();
    const visited = new Set();
    const visit = (requirement) => {
        if (visiting.has(requirement.id))
            throw new TypeError(`Conformance dependency cycle at ${requirement.id}`);
        if (visited.has(requirement.id)) return;
        visiting.add(requirement.id);
        for (const id of requirement.prerequisites) visit(byId.get(id));
        visiting.delete(requirement.id);
        visited.add(requirement.id);
    };
    for (const requirement of requirements) visit(requirement);
}

function parseArguments(args) {
    let stage = "building";
    let selectedArtifactRoot = artifactRoot;
    let spec = resolve(packageRoot, "SPEC.md");
    const testReports = [];
    let invariantsReport = resolve(reportRoot, "invariants.json");
    let hermetic = false;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--stage") stage = args[++index];
        else if (args[index] === "--hermetic") hermetic = true;
        else if (args[index] === "--artifact-root") selectedArtifactRoot = resolve(args[++index]);
        else if (args[index] === "--spec") spec = resolve(args[++index]);
        else if (args[index] === "--test-report") testReports.push(resolve(args[++index]));
        else if (args[index] === "--invariants-report") invariantsReport = resolve(args[++index]);
        else throw new TypeError(`Unknown ledger argument ${args[index]}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return {
        stage,
        hermetic,
        artifactRoot: selectedArtifactRoot,
        spec,
        testReports: testReports.length === 0 ? undefined : testReports,
        invariantsReport
    };
}

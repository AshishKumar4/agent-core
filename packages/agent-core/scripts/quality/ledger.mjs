import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { relative, resolve } from "node:path";
import {
    artifactRoot,
    assertExactKeys,
    assertFlatFragmentNames,
    assertObject,
    assertString,
    assertUniqueIds,
    assertUniqueStrings,
    collectFiles,
    packageRoot,
    readCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";
import { specRequirements } from "./spec.mjs";
import {
    executedTestSelectors,
    requirePassingTests,
    resolveSourceSymbol,
    sourceProject
} from "./evidence.mjs";
import { ownersForPath, patternsForOwnership } from "./ownership.mjs";
import { requireNonP2ConformanceEvidence } from "./test-priority-evidence.mjs";
import { liveEvidenceSelectors } from "./live-substrate-evidence.mjs";

const options = parseArguments(process.argv.slice(2));
const ledgerArtifactRoot = options.artifactRoot;
const index = await readCanonicalJson(resolve(ledgerArtifactRoot, "conformance/index.json"));
// conformance/schema.json declared the fragment shape — the digest pattern, the status
// enum, the exact key set — while nothing read it, so none of it could ever fail. Every
// other schema artifact in this repository is compiled; this one is too now.
const fragmentAjv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const validateFragmentShape = fragmentAjv.compile(
    await readCanonicalJson(resolve(ledgerArtifactRoot, "conformance/schema.json"))
);
const stageArtifact = await readCanonicalJson(
    resolve(ledgerArtifactRoot, "conformance/stage.json")
);
assertExactKeys(stageArtifact, ["edition", "stage"], "Conformance stage");
if (stageArtifact.edition !== "1.0.0") {
    throw new TypeError("Unsupported conformance stage edition");
}
if (stageArtifact.stage !== "building" && stageArtifact.stage !== "final") {
    throw new TypeError("Conformance stage must be building or final");
}
// Hermetic runs validate at final strictness while the conformance campaign may still
// be building; campaign-completeness demands key to the declared conformance stage.
const campaignFinal =
    options.stage === "final" && (!options.hermetic || stageArtifact.stage === "final");
if (campaignFinal && stageArtifact.stage !== "final") {
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
    // live-evidence/ holds the live substrate lane's archived reports, validated by
    // their own checker; they are evidence, not conformance fragments.
    .filter(
        (name) =>
            !name.startsWith("live-evidence/") &&
            !["index.json", "schema.json", "stage.json"].includes(name)
    )
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
// Two examined sets, and the asymmetry between them is deliberate rather than incidental.
// `evidenced` is the set asked to prove a COMPLETED evidence run: every checker invariant it
// names actually executed, and its cited tests clear the non-P2 priority floor. `cited` adds
// `implemented`, which is asked only whether its CITATIONS ARE TRUE — a cited source symbol
// still resolves, a cited test exists and passed, and both live under the citing wave. Those
// three are answerable about a row that is honestly incomplete, and nothing examined them on
// an `implemented` row before, so a citation could name a test that had nothing to do with
// the atom and every gate stayed green. The completeness checks stay out because
// validateStatus REQUIRES an `implemented` row to carry remaining evidence: demanding
// executed invariants or an empty remainder of it asks the row to prove the completeness the
// status is defined not to have, which would collapse `implemented` into `verified` rather
// than check it. A row citing nothing stays clean here — an uncited `implemented` row is an
// honest declaration of incompleteness while a citation resolving to nothing is a false
// statement, and one verdict for both facts would hide the difference. The uncited rows are
// reported instead, below.
const evidenced = [...verified, ...externallyGated];
const cited = [
    ...evidenced,
    ...requirements.filter((requirement) => requirement.status === "implemented")
];
if (cited.length > 0) {
    const project = sourceProject();
    for (const requirement of cited) {
        for (const source of requirement.sourceSymbols) {
            requireEvidenceOwner(
                sourcePath(source),
                requirement.owner,
                ownershipPatterns,
                requirement.id
            );
            resolveSourceSymbol(project, source);
        }
        for (const selector of requirement.testSelectors) {
            const testPath = selector.slice(0, selector.indexOf("#"));
            const owners = ownersForPath(repositoryTestPath(testPath), ownershipPatterns);
            if (!owners.includes(requirement.owner) && !owners.includes("W9")) {
                throw new TypeError(`${requirement.id} test is owned by another wave: ${testPath}`);
            }
        }
    }
    const executedTests = await executedTestSelectors(options.testReports);
    // Live substrate scenarios are archived by the consented lane rather than re-run here, so
    // they are part of the passing set for an ACQ-LIVE row whatever status carries it.
    if (cited.some((requirement) => requirement.checkerInvariants.includes("ACQ-LIVE"))) {
        for (const selector of liveEvidenceSelectors(ledgerArtifactRoot)) {
            executedTests.add(selector);
        }
    }
    for (const requirement of cited) {
        requirePassingTests(requirement.testSelectors, executedTests, requirement.id);
    }
}
if (evidenced.length > 0) {
    const rules = await readCanonicalJson(resolve(ledgerArtifactRoot, "quality/rules.json"));
    assertUniqueIds(rules.rules, (rule) => rule.id, "quality/rules.json rules");
    const knownInvariants = new Set(rules.rules.map((rule) => rule.id));
    const executedInvariants = new Set((await readCanonicalJson(options.invariantsReport)).passed);
    const priorityEvidence =
        options.priorityReport === undefined
            ? undefined
            : await readCanonicalJson(options.priorityReport);
    for (const requirement of evidenced) {
        if (priorityEvidence !== undefined) {
            requireNonP2ConformanceEvidence(
                requirement.id,
                requirement.testSelectors,
                priorityEvidence.selectors
            );
        }
        for (const invariant of requirement.checkerInvariants) {
            if (!knownInvariants.has(invariant))
                throw new TypeError(`${requirement.id} names unknown invariant ${invariant}`);
            if (!executedInvariants.has(invariant)) {
                throw new TypeError(`${requirement.id} invariant did not execute: ${invariant}`);
            }
        }
    }
}

// The third outcome of the citation check, enumerated rather than failed: a row admitted at
// `implemented` while citing no test is exempt from the check above by construction, so the
// exemption is published instead of being left invisible.
const uncitedImplemented = requirements.filter(
    (requirement) => requirement.status === "implemented" && requirement.testSelectors.length === 0
);
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
    uncitedImplemented: uncitedImplemented.map((requirement) => requirement.id).sort(),
    complete:
        incomplete.length === 0 &&
        pendingFragmentNames.length === 0 &&
        (options.stage === "building" || externallyGated.length === 0)
};
await writeCanonicalJson(resolve(reportRoot, "conformance.json"), report);
if (
    campaignFinal &&
    (incomplete.length > 0 || pendingFragmentNames.length > 0 || externallyGated.length > 0)
) {
    throw new TypeError(
        `Final conformance has ${incomplete.length} incomplete requirement(s), ${externallyGated.length} external gate(s), and pending fragments=${pendingFragmentNames.join(",")}`
    );
}
console.log(
    `conformance ${report.complete ? "complete" : "incomplete"}: ${verified.length}/${requirements.length - externallyGated.length} local applicable verified, ${externallyGated.length} external gated, ${cited.length - evidenced.length} implemented citing evidence of which ${uncitedImplemented.length} cite no test`
);

function validateFragment(fragment, name, seed, fragmentOwners) {
    // Shape before semantics: a malformed digest or an unknown status is a shape error, and
    // reaching the stale-evidence comparison with one reports the wrong defect.
    if (!validateFragmentShape(fragment)) {
        throw new TypeError(
            `Invalid conformance fragment ${name}: ${fragmentAjv.errorsText(validateFragmentShape.errors)}`
        );
    }
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
    const sourceOwner = owners[0];
    const crossContextQualityEvidence = owner === "W0";
    if (
        owners.length !== 1 ||
        (!crossContextQualityEvidence && sourceOwner !== owner && sourceOwner !== "W9")
    ) {
        throw new TypeError(`${requirement} source is not owned by ${owner}: ${path}`);
    }
}

function validateRequirement(value) {
    // `bounds` is optional at every status, so it joins the exact key set only when present.
    // It records what the rule deliberately does NOT claim, which is a different fact from
    // `remainingEvidence`'s what-is-still-owed, and the two are deliberately not one field:
    // `verified` requires `remainingEvidence` empty, so promotion to `verified` is destructive
    // rather than additive — it erases a row's only prose channel, deleting what the row said
    // about its own scope. `bounds` survives promotion because nothing below reads it. Shape is
    // all that is checked here and all that is checked anywhere: the item floor lives in
    // conformance/schema.json beside the field's description, and no evidence check —
    // `requireEvidenceOwner`, `resolveSourceSymbol`, `requirePassingTests`, the
    // `checkerInvariants` execution check, the priority floor, or `validateStatus` — reads it.
    // A path, symbol or atom id inside a bound is therefore prose and never a citation.
    const requirement = assertObject(value, "Requirement");
    const carriesBounds = "bounds" in requirement;
    assertExactKeys(
        requirement,
        [
            ...(carriesBounds ? ["bounds"] : []),
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
        `Requirement ${requirement.id ?? "<unknown>"}`
    );
    for (const field of ["id", "owner", "specAnchor", "specTextSha256", "status"]) {
        assertString(requirement[field], `Requirement ${field}`);
    }
    for (const field of [
        "prerequisites",
        "sourceSymbols",
        "testSelectors",
        "checkerInvariants",
        "remainingEvidence",
        ...(carriesBounds ? ["bounds"] : [])
    ]) {
        assertUniqueStrings(requirement[field], `Requirement ${requirement.id} ${field}`);
    }
    if (!/^(?:C13|P11)-[A-Z0-9.-]+$/.test(requirement.id))
        throw new TypeError(`Invalid requirement ID ${requirement.id}`);
    return requirement;
}

// Every branch below reads `remainingEvidence` and none reads `bounds`, deliberately: a bound is
// a statement about what the rule does not claim, not evidence owed, so no status may require,
// forbid or bound it. Adding a `bounds` predicate to any branch here — in either direction —
// rebuilds the collapse the field exists to undo, and would make promotion lossy again by
// turning a recorded non-claim back into an obligation. The absence is the invariant; it is
// asserted in test/quality/ledger.test.ts rather than left to be inferred from this comment.
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
    let priorityReport;
    let hermetic = false;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--stage") stage = args[++index];
        else if (args[index] === "--hermetic") hermetic = true;
        else if (args[index] === "--artifact-root") selectedArtifactRoot = resolve(args[++index]);
        else if (args[index] === "--spec") spec = resolve(args[++index]);
        else if (args[index] === "--test-report") testReports.push(resolve(args[++index]));
        else if (args[index] === "--invariants-report") invariantsReport = resolve(args[++index]);
        else if (args[index] === "--priority-report") priorityReport = resolve(args[++index]);
        else throw new TypeError(`Unknown ledger argument ${args[index]}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return {
        stage,
        hermetic,
        artifactRoot: selectedArtifactRoot,
        spec,
        testReports: testReports.length === 0 ? undefined : testReports,
        invariantsReport,
        priorityReport
    };
}

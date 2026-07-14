import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const formalRoot = join(packageRoot, "formal");
const traceabilityPath = join(packageRoot, "artifacts", "traceability.yaml");
const lakeCommand = process.env.LEAN_LAKE?.trim() || "lake";

const allowedBuiltInAxioms = new Set(["propext", "Quot.sound", "Classical.choice"]);
const requirementStatuses = new Set(["proved-safety", "proved-component"]);
const assumptionStatuses = new Set(["operational-assumption", "refinement-non-goal"]);
const nonClaimStatuses = new Set([
    "component-shape-nonclaim",
    "specified-not-modeled",
    "refinement-non-goal"
]);
const statusVocabulary = [
    "proved-safety",
    "proved-component",
    "component-shape-nonclaim",
    "specified-not-modeled",
    "operational-assumption",
    "refinement-non-goal"
];
const requiredRequirementIds = [
    "AC-STRUCTURAL-001",
    "AC-AUTH-001",
    "AC-AUTH-RESOLUTION-001",
    "AC-MATERIALIZE-001",
    "AC-PLACEMENT-001",
    "AC-TRUST-001",
    "AC-LEASE-001",
    "AC-APPROVAL-001",
    "AC-EFFECT-001",
    "AC-EVENT-ROUTING-001",
    "AC-AUDIT-001",
    "AC-RUN-001",
    "AC-GRAPH-WRITER-001",
    "AC-COMPOSED-001"
];
const requiredNonClaimIds = [
    "AC-REP-GATEKEEPER",
    "AC-REP-CONSENT",
    "AC-REP-REACTION",
    "AC-REP-MOA",
    "NC-SURFACE-RUNTIME-ACTIONS",
    "NC-PROFILE-RUNTIME",
    "NC-RFC6902-PATCH",
    "NC-FACET-MANIFEST-RUNTIME",
    "NC-CONTRIBUTIONS-SLOTS",
    "NC-COMMANDS",
    "NC-INTERCEPTORS",
    "NC-ENVIRONMENT-LIFECYCLE",
    "NC-ENVIRONMENT-TURN-OWNED-DIRECT-EXECUTE",
    "NC-SLATE-RUNTIME",
    "NC-CONTENTSTORE",
    "NC-CODECS",
    "NC-PROTOCOL-DISPATCHER",
    "NC-BLUEPRINT-MATERIALIZATION",
    "NC-CLOUDFLARE-BEHAVIOR",
    "NC-TEMPORAL-LIVENESS",
    "NC-CRYPTOGRAPHIC-COLLISION-RESISTANCE",
    "NC-TYPESCRIPT-SUBSTRATE-REFINEMENT"
];
const requiredAssumptionIds = [
    "ASM-STRUCTURAL-DIGEST",
    "ASM-TRUTHFUL-VERIFICATION-INPUTS",
    "ASM-LIVENESS-TIME-INVALIDATION",
    "ASM-TRANSITION-ATOMICITY",
    "ASM-SOURCE-PROJECTION-AUTHENTICITY",
    "ASM-CLOSED-WORLD-TRANSITIONS",
    "ASM-IMPLEMENTATION-REFINEMENT-SEPARATE"
];
const requiredBoundaryAreaIds = [
    "L0_IDENTITY_AUTHORITY",
    "L1_FACET_MANIFEST_RUNTIME",
    "L1_CONTRIBUTIONS_SLOTS",
    "L1_COMMANDS",
    "L1_INTERCEPTORS",
    "L1_ENVIRONMENT_SESSION",
    "L1_SLATE",
    "L2_EXECUTION",
    "L3_INTERACTION",
    "L4_MEDIATION",
    "L5_SUBSTRATE",
    "L6_DEFINITION_PLANE",
    "CLOUDFLARE_PROFILE",
    "PROFILES_REPRESENTATIONS",
    "CONFORMANCE_REFINEMENT"
];
const requiredWitnessFamilyIds = [
    "WF-AUTH-RESOLUTION",
    "WF-LEASE-RUN-COMPOSED",
    "WF-TRUST-EVENT",
    "WF-EVENT-AUDIT-GRAPH",
    "WF-APPROVAL-COMPOSED"
];
const requiredNonClaimBoundaryAreas = new Map([
    ["NC-ENVIRONMENT-TURN-OWNED-DIRECT-EXECUTE", ["L1_ENVIRONMENT_SESSION", "L4_MEDIATION"]]
]);
const witnessPrefix = "AgentCore.Examples.nonvacuous_";
const qualifiedLeanName = /^AgentCore(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const failures = [];

function fail(message) {
    failures.push(message);
}

function reportFailures() {
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkExactKeys(value, expected, location) {
    if (!isObject(value)) {
        fail(`${location} must be an object`);
        return false;
    }
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        fail(`${location} keys must be exactly: ${wanted.join(", ")}`);
        return false;
    }
    return true;
}

function checkString(value, location) {
    if (typeof value !== "string" || value.length === 0) {
        fail(`${location} must be a nonempty string`);
        return false;
    }
    return true;
}

function checkStringArray(value, location, { nonempty = false } = {}) {
    if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string" || item.length === 0)
    ) {
        fail(`${location} must be an array of nonempty strings`);
        return [];
    }
    if (nonempty && value.length === 0) fail(`${location} must not be empty`);
    const duplicates = value.filter((item, index) => value.indexOf(item) !== index);
    for (const duplicate of new Set(duplicates))
        fail(`${location} contains duplicate ${duplicate}`);
    return value;
}

function checkExactIds(actual, expected, location) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    for (const id of expectedSet) {
        if (!actualSet.has(id)) fail(`${location} is missing reviewed id ${id}`);
    }
    for (const id of actualSet) {
        if (!expectedSet.has(id)) fail(`${location} contains unreviewed id ${id}`);
    }
    if (actual.length !== actualSet.size) fail(`${location} contains duplicate ids`);
}

function indexEntries(entries, location) {
    const index = new Map();
    for (const entry of entries) {
        if (!isObject(entry) || !checkString(entry.id, `${location} entry id`)) continue;
        if (index.has(entry.id)) fail(`${location} contains duplicate id ${entry.id}`);
        index.set(entry.id, entry);
    }
    return index;
}

function runLake(args, label) {
    const result = spawnSync(lakeCommand, args, {
        cwd: formalRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.error) {
        throw new Error(
            `check-traceability: unable to run ${lakeCommand}: ${result.error.message}`
        );
    }
    if (result.status !== 0) {
        const output = [result.stdout.trimEnd(), result.stderr.trimEnd()]
            .filter(Boolean)
            .join("\n");
        throw new Error(`${output}${output ? "\n" : ""}check-traceability: ${label} failed`);
    }
    return `${result.stdout}\n${result.stderr}`;
}

function runLakeOrExit(args, label) {
    try {
        return runLake(args, label);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

function checkLeanDefinitions(definitions) {
    const directory = mkdtempSync(join(tmpdir(), "agent-core-traceability-"));
    const checkPath = join(directory, "Definitions.lean");
    let checkError;
    try {
        const source = [
            "import AgentCore",
            "",
            ...definitions.map((name) => `#check ${name}`),
            ""
        ].join("\n");
        writeFileSync(checkPath, source, "utf8");
        runLake(["env", "lean", checkPath], "Lean definition checks");
    } catch (error) {
        checkError = error;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
    if (checkError) throw checkError;
}

const traceabilitySource = readFileSync(traceabilityPath, "utf8");
let traceability;
try {
    traceability = JSON.parse(traceabilitySource);
} catch (error) {
    console.error(
        `check-traceability: traceability.yaml must be JSON-compatible YAML: ${error.message}`
    );
    process.exit(1);
}

if (traceabilitySource !== `${JSON.stringify(traceability, null, 2)}\n`) {
    fail("traceability.yaml must use canonical two-space JSON formatting (valid YAML 1.2)");
}
checkExactKeys(
    traceability,
    [
        "edition",
        "formalScope",
        "checkerBoundary",
        "statusVocabulary",
        "crossRequirementWitnessFamilies",
        "requirements",
        "assumptions",
        "nonClaims",
        "formalBoundary"
    ],
    "traceability"
);
if (!isObject(traceability)) reportFailures();
checkString(traceability.edition, "edition");
checkString(traceability.checkerBoundary, "checkerBoundary");
if (traceability.formalScope !== "abstract-model-only")
    fail("formalScope must be abstract-model-only");

if (checkExactKeys(traceability.statusVocabulary, statusVocabulary, "statusVocabulary")) {
    for (const status of statusVocabulary) {
        checkString(traceability.statusVocabulary[status], `statusVocabulary.${status}`);
    }
}

if (!Array.isArray(traceability.requirements)) fail("requirements must be an array");
if (!Array.isArray(traceability.assumptions)) fail("assumptions must be an array");
if (!Array.isArray(traceability.nonClaims)) fail("nonClaims must be an array");
if (!Array.isArray(traceability.crossRequirementWitnessFamilies)) {
    fail("crossRequirementWitnessFamilies must be an array");
}
const requirements = Array.isArray(traceability.requirements) ? traceability.requirements : [];
const assumptions = Array.isArray(traceability.assumptions) ? traceability.assumptions : [];
const nonClaims = Array.isArray(traceability.nonClaims) ? traceability.nonClaims : [];
const witnessFamilies = Array.isArray(traceability.crossRequirementWitnessFamilies)
    ? traceability.crossRequirementWitnessFamilies
    : [];
const requirementIndex = indexEntries(requirements, "requirements");
const assumptionIndex = indexEntries(assumptions, "assumptions");
const nonClaimIndex = indexEntries(nonClaims, "nonClaims");
const witnessFamilyIndex = indexEntries(witnessFamilies, "crossRequirementWitnessFamilies");
checkExactIds([...requirementIndex.keys()], requiredRequirementIds, "requirements");
checkExactIds([...assumptionIndex.keys()], requiredAssumptionIds, "assumptions");
checkExactIds([...nonClaimIndex.keys()], requiredNonClaimIds, "nonClaims");
checkExactIds(
    [...witnessFamilyIndex.keys()],
    requiredWitnessFamilyIds,
    "crossRequirementWitnessFamilies"
);

const witnessFamilyMembers = [];
for (const family of witnessFamilies) {
    if (
        !checkExactKeys(
            family,
            ["id", "requirementIds"],
            `crossRequirementWitnessFamily ${family?.id ?? "<unknown>"}`
        )
    )
        continue;
    const requirementIds = checkStringArray(
        family.requirementIds,
        `crossRequirementWitnessFamily ${family.id}.requirementIds`,
        { nonempty: true }
    );
    if (requirementIds.length < 2) {
        fail(`crossRequirementWitnessFamily ${family.id} must contain at least two requirements`);
    }
    for (const id of requirementIds) {
        if (!requirementIndex.has(id)) {
            fail(`crossRequirementWitnessFamily ${family.id} references unknown requirement ${id}`);
        }
    }
    witnessFamilyMembers.push(new Set(requirementIds));
}

const theoremOwners = new Map();
const definitions = new Set();
const coverageRecords = [];
let substantiveTheoremCount = 0;
let witnessCount = 0;
let witnessCoverageCount = 0;

function ownTheorem(name, requirementId, field) {
    if (!qualifiedLeanName.test(name))
        fail(`${requirementId}.${field} contains invalid Lean name ${name}`);
    const owners = theoremOwners.get(name) ?? [];
    owners.push({ requirementId, field });
    theoremOwners.set(name, owners);
}

for (const requirement of requirements) {
    if (
        !checkExactKeys(
            requirement,
            [
                "id",
                "summary",
                "status",
                "boundary",
                "definitions",
                "theorems",
                "nonVacuity",
                "witnessCoverage",
                "remainingEvidence"
            ],
            `requirement ${requirement?.id ?? "<unknown>"}`
        )
    )
        continue;
    const location = `requirement ${requirement.id}`;
    checkString(requirement.summary, `${location}.summary`);
    checkString(requirement.boundary, `${location}.boundary`);
    if (!requirementStatuses.has(requirement.status)) {
        fail(`${location}.status must be proved-safety or proved-component`);
    }
    const entryDefinitions = checkStringArray(requirement.definitions, `${location}.definitions`, {
        nonempty: true
    });
    const theorems = checkStringArray(requirement.theorems, `${location}.theorems`, {
        nonempty: true
    });
    const witnesses = checkStringArray(requirement.nonVacuity, `${location}.nonVacuity`, {
        nonempty: true
    });
    checkStringArray(requirement.remainingEvidence, `${location}.remainingEvidence`, {
        nonempty: true
    });
    for (const definition of entryDefinitions) {
        if (!qualifiedLeanName.test(definition))
            fail(`${location}.definitions contains invalid Lean name ${definition}`);
        definitions.add(definition);
    }
    for (const theorem of theorems) {
        if (theorem.startsWith(witnessPrefix))
            fail(`${location}.theorems contains witness ${theorem}`);
        ownTheorem(theorem, requirement.id, "theorems");
        substantiveTheoremCount += 1;
    }
    for (const witness of witnesses) {
        if (!witness.startsWith(witnessPrefix)) {
            fail(`${location}.nonVacuity witness must start with ${witnessPrefix}: ${witness}`);
        }
        ownTheorem(witness, requirement.id, "nonVacuity");
        witnessCount += 1;
    }
    if (!isObject(requirement.witnessCoverage)) {
        fail(`${location}.witnessCoverage must be an object`);
        continue;
    }
    checkExactIds(
        Object.keys(requirement.witnessCoverage),
        theorems,
        `${location}.witnessCoverage`
    );
    for (const theorem of theorems) {
        const mappedWitnesses = checkStringArray(
            requirement.witnessCoverage[theorem],
            `${location}.witnessCoverage.${theorem}`,
            { nonempty: true }
        );
        coverageRecords.push({
            requirementId: requirement.id,
            theorem,
            witnesses: mappedWitnesses
        });
        witnessCoverageCount += mappedWitnesses.length;
    }
}

for (const assumption of assumptions) {
    if (
        !checkExactKeys(
            assumption,
            ["id", "summary", "status"],
            `assumption ${assumption?.id ?? "<unknown>"}`
        )
    ) {
        continue;
    }
    checkString(assumption.summary, `assumption ${assumption.id}.summary`);
    if (!assumptionStatuses.has(assumption.status)) {
        fail(
            `assumption ${assumption.id}.status must be operational-assumption or refinement-non-goal`
        );
    }
}

for (const nonClaim of nonClaims) {
    if (
        !checkExactKeys(
            nonClaim,
            ["id", "summary", "status"],
            `nonClaim ${nonClaim?.id ?? "<unknown>"}`
        )
    ) {
        continue;
    }
    checkString(nonClaim.summary, `nonClaim ${nonClaim.id}.summary`);
    if (!nonClaimStatuses.has(nonClaim.status)) {
        fail(`nonClaim ${nonClaim.id}.status is not an allowed non-claim status`);
    }
}

function witnessOwnerAllowed(requirementId, witnessOwnerId) {
    if (requirementId === witnessOwnerId) return true;
    return witnessFamilyMembers.some(
        (members) => members.has(requirementId) && members.has(witnessOwnerId)
    );
}

for (const [theorem, owners] of theoremOwners) {
    if (owners.length !== 1) {
        const labels = owners.map((owner) => `${owner.requirementId}.${owner.field}`);
        fail(`designated theorem has ${owners.length} owners: ${theorem} (${labels.join(", ")})`);
    }
}

const coveredWitnesses = new Set();
for (const coverage of coverageRecords) {
    for (const witness of coverage.witnesses) {
        if (!witness.startsWith(witnessPrefix)) {
            fail(`witnessCoverage for ${coverage.theorem} contains non-witness ${witness}`);
            continue;
        }
        const owners = theoremOwners.get(witness);
        if (!owners || owners.length === 0) {
            fail(`witnessCoverage for ${coverage.theorem} references unknown witness ${witness}`);
            continue;
        }
        if (owners.length !== 1) continue;
        const owner = owners[0];
        if (owner.field !== "nonVacuity") {
            fail(
                `witnessCoverage for ${coverage.theorem} references non-witness ownership ${witness}`
            );
        } else if (!witnessOwnerAllowed(coverage.requirementId, owner.requirementId)) {
            fail(
                `witnessCoverage for ${coverage.theorem} uses ${witness} owned by ${owner.requirementId} ` +
                    "without a reviewed cross-requirement family"
            );
        } else {
            coveredWitnesses.add(witness);
        }
    }
}
for (const [theorem, owners] of theoremOwners) {
    if (owners.length === 1 && owners[0].field === "nonVacuity" && !coveredWitnesses.has(theorem)) {
        fail(`owned witness has no theorem-specific witnessCoverage: ${theorem}`);
    }
}

const boundary = traceability.formalBoundary;
if (checkExactKeys(boundary, ["requiredAreaIds", "areas"], "formalBoundary")) {
    const declaredAreaIds = checkStringArray(
        boundary.requiredAreaIds,
        "formalBoundary.requiredAreaIds",
        { nonempty: true }
    );
    if (JSON.stringify(declaredAreaIds) !== JSON.stringify(requiredBoundaryAreaIds)) {
        fail(
            `formalBoundary.requiredAreaIds must exactly equal ${requiredBoundaryAreaIds.join(", ")}`
        );
    }
    if (!Array.isArray(boundary.areas)) {
        fail("formalBoundary.areas must be an array");
    } else {
        const areaIndex = indexEntries(boundary.areas, "formalBoundary.areas");
        checkExactIds([...areaIndex.keys()], requiredBoundaryAreaIds, "formalBoundary.areas");
        const coveredRequirements = new Set();
        const coveredAssumptions = new Set();
        const coveredNonClaims = new Set();
        for (const area of boundary.areas) {
            if (
                !checkExactKeys(
                    area,
                    ["id", "spec", "requirementIds", "nonClaimIds", "assumptionIds"],
                    `formalBoundary area ${area?.id ?? "<unknown>"}`
                )
            )
                continue;
            checkString(area.spec, `formalBoundary area ${area.id}.spec`);
            const requirementIds = checkStringArray(
                area.requirementIds,
                `formalBoundary area ${area.id}.requirementIds`
            );
            const assumptionIds = checkStringArray(
                area.assumptionIds,
                `formalBoundary area ${area.id}.assumptionIds`
            );
            const nonClaimIds = checkStringArray(
                area.nonClaimIds,
                `formalBoundary area ${area.id}.nonClaimIds`
            );
            if (requirementIds.length + assumptionIds.length + nonClaimIds.length === 0) {
                fail(`formalBoundary area ${area.id} has no disposition`);
            }
            for (const id of requirementIds) {
                if (!requirementIndex.has(id))
                    fail(`formalBoundary area ${area.id} references unknown requirement ${id}`);
                coveredRequirements.add(id);
            }
            for (const id of assumptionIds) {
                if (!assumptionIndex.has(id))
                    fail(`formalBoundary area ${area.id} references unknown assumption ${id}`);
                coveredAssumptions.add(id);
            }
            for (const id of nonClaimIds) {
                if (!nonClaimIndex.has(id))
                    fail(`formalBoundary area ${area.id} references unknown nonClaim ${id}`);
                coveredNonClaims.add(id);
            }
        }
        for (const id of requirementIndex.keys()) {
            if (!coveredRequirements.has(id))
                fail(`formalBoundary does not place requirement ${id}`);
        }
        for (const id of assumptionIndex.keys()) {
            if (!coveredAssumptions.has(id)) fail(`formalBoundary does not place assumption ${id}`);
        }
        for (const id of nonClaimIndex.keys()) {
            if (!coveredNonClaims.has(id)) fail(`formalBoundary does not place nonClaim ${id}`);
        }
        for (const [nonClaimId, areaIds] of requiredNonClaimBoundaryAreas) {
            for (const areaId of areaIds) {
                const area = areaIndex.get(areaId);
                if (!Array.isArray(area?.nonClaimIds) || !area.nonClaimIds.includes(nonClaimId)) {
                    fail(
                        `formalBoundary area ${areaId} must include reviewed nonClaim ${nonClaimId}`
                    );
                }
            }
        }
    }
}

if (failures.length > 0) reportFailures();

runLakeOrExit(["build", "AgentCore"], "lake build AgentCore");
const reportOutput = runLakeOrExit(
    ["env", "lean", "AgentCore/Axioms.lean"],
    "direct AgentCore/Axioms.lean execution"
);

const reported = new Map();
const observedAxioms = new Set();
let candidateReportLineCount = 0;
for (const rawLine of reportOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("'") || !line.includes("depend")) continue;
    candidateReportLineCount += 1;
    const match =
        /^'([^']+)' (?:does not depend on any axioms|depends on axioms: \[([^\]]*)\])$/.exec(line);
    if (!match) {
        fail(`unparsed #print axioms output: ${line}`);
        continue;
    }
    const name = match[1];
    const axioms = match[2]?.trim() ? match[2].split(",").map((axiom) => axiom.trim()) : [];
    if (reported.has(name)) fail(`direct axiom report contains duplicate theorem ${name}`);
    reported.set(name, axioms);
    for (const axiom of axioms) {
        observedAxioms.add(axiom);
        if (axiom.includes("sorryAx")) fail(`designated theorem depends on sorryAx: ${name}`);
        else if (!allowedBuiltInAxioms.has(axiom)) {
            fail(`designated theorem ${name} depends on disallowed axiom ${axiom}`);
        }
    }
}
if (reported.size === 0) fail("direct Axioms.lean execution produced no #print axioms output");
if (candidateReportLineCount !== reported.size) {
    fail(
        `parsed ${reported.size} of ${candidateReportLineCount} #print axioms output lines uniquely`
    );
}
for (const axiom of allowedBuiltInAxioms) {
    if (!observedAxioms.has(axiom))
        fail(`allowed built-in axiom is not used by the current report: ${axiom}`);
}

for (const name of theoremOwners.keys()) {
    if (!reported.has(name)) fail(`owned theorem is not designated by Axioms.lean: ${name}`);
}
for (const name of reported.keys()) {
    if (!theoremOwners.has(name)) fail(`Axioms.lean designated theorem has no owner: ${name}`);
}
const reportedWitnessCount = [...reported.keys()].filter((name) =>
    name.startsWith(witnessPrefix)
).length;
if (reportedWitnessCount !== witnessCount) {
    fail(
        `witness ownership count ${witnessCount} does not match designated witness count ${reportedWitnessCount}`
    );
}

if (failures.length === 0) {
    try {
        checkLeanDefinitions([...definitions].sort());
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
if (failures.length > 0) reportFailures();

console.log(
    `traceability verified: ${reported.size} designated (${substantiveTheoremCount} claims, ${witnessCount} witnesses), ` +
        `${witnessCoverageCount} witness links, ${definitions.size} definitions, ${observedAxioms.size} built-in axioms, ` +
        `${requirements.length} requirements, ` +
        `${nonClaims.length} non-claims, ${assumptions.length} assumptions, ${requiredBoundaryAreaIds.length} boundary areas`
);

// @ts-nocheck
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
    artifactRoot,
    collectFiles,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";
import { loadValidatedBom } from "./bom.mjs";
import {
    changedPaths,
    changedPathsBetween,
    loadOwnership,
    ownersForPath,
    validateArchivedRequestDeletions,
    validateClosureManifest,
    validateCandidateChangeManifest,
    validateCandidateWorktreeManifest,
    validateCompletedCandidateManifest,
    validateOwnershipPaths,
    validateRemediationManifest
} from "./ownership.mjs";
import { verifyCompletion } from "./completion.mjs";
import {
    loadValidatedRequestArchive,
    normalizeResolutions,
    validateFinalRequestArchive
} from "./request-archive.mjs";
import { specRequirements } from "./spec.mjs";

const stageIndex = process.argv.indexOf("--stage");
const stage = stageIndex < 0 ? "building" : process.argv[stageIndex + 1];
if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);

const integrationRoot = resolve(artifactRoot, "integration");
const scriptsRoot = "packages/agent-core/scripts";
const integrationIndex = await readCanonicalJson(resolve(integrationRoot, "index.json"));
const foundationPublicContractPaths = [
    "packages/agent-core/artifacts/integration/transition-schema.json",
    "packages/agent-core/artifacts/integration/transitions/foundation-public-contract.json",
    "packages/agent-core/artifacts/integration/transitions/index.json",
    "packages/agent-core/artifacts/quality/exports.json",
    "packages/agent-core/artifacts/quality/ownership.json",
    "packages/agent-core/package.json",
    `${scriptsRoot}/build.mjs`,
    `${scriptsRoot}/check-exports.mjs`,
    `${scriptsRoot}/quality/governance.mjs`,
    `${scriptsRoot}/quality/ownership.d.mts`,
    `${scriptsRoot}/quality/ownership.mjs`,
    `${scriptsRoot}/quality/run.mjs`,
    "packages/agent-core/src/index.ts",
    "packages/agent-core/src/substrates/sqlite/index.ts",
    "packages/agent-core/test/quality/governance.test.ts",
    "packages/agent-core/test/quality/ownership.test.ts"
];
const facetCapabilityIdentityPaths = [
    "packages/agent-core/src/facets/capability.ts",
    "packages/agent-core/src/facets/id.ts",
    "packages/agent-core/src/facets/index.ts",
    "packages/agent-core/src/facets/installation.ts",
    "packages/agent-core/src/facets/profile-runtime/contract.ts",
    "packages/agent-core/src/facets/profile-runtime/error.ts",
    "packages/agent-core/src/facets/profile-runtime/facet.ts",
    "packages/agent-core/src/facets/profile-runtime/index.ts",
    "packages/agent-core/src/facets/profile-runtime/manifest.ts",
    "packages/agent-core/src/facets/profile-runtime/runtime.ts",
    "packages/agent-core/src/facets/profile-runtime/schema.ts",
    "packages/agent-core/src/facets/profile-runtime/wire.ts",
    "packages/agent-core/src/facets/runtime.ts",
    "packages/agent-core/src/facets/slot-memory.ts",
    "packages/agent-core/src/operations/gateway.ts",
    "packages/agent-core/src/operations/interception.ts",
    "packages/agent-core/src/operations/lifecycle.ts",
    "packages/agent-core/src/operations/runtime.ts",
    "packages/agent-core/src/protocol/facet-commands.ts",
    "packages/agent-core/test/facets/declarations.test.ts",
    "packages/agent-core/test/facets/profile-runtime.test.ts",
    "packages/agent-core/test/facets/slot-memory.test.ts",
    "packages/agent-core/test/protocol/facet-commands.test.ts"
];
const expectedIntegrationIndex = {
    edition: "1.0.0",
    artifacts: [
        "bom.json",
        "dispositions.json",
        "owned-path-verification.json",
        "resolutions.json",
        ...(integrationIndex.artifacts.includes("request-archive.json")
            ? ["request-archive.json"]
            : []),
        "user-authorization-requests.json",
        "transitions/index.json"
    ],
    schemas: [
        "bom-schema.json",
        "disposition-schema.json",
        "owned-path-verification-schema.json",
        "request-archive-schema.json",
        "resolution-schema.json",
        "transition-schema.json",
        "user-authorization-request-schema.json"
    ]
};
if (JSON.stringify(integrationIndex) !== JSON.stringify(expectedIntegrationIndex)) {
    throw new TypeError("Integration artifact index differs from the fixed R1 denominator");
}
const expectedTransitions = new Map([
    [
        "environment-pin-identity.json",
        { id: "TRANSITION-ENVIRONMENT-PIN-IDENTITY", canonicalOwner: "W8", inputs: ["W5", "W8"] }
    ],
    [
        "facet-capability-identity.json",
        {
            id: "TRANSITION-FACET-CAPABILITY-IDENTITY",
            canonicalOwner: "W3",
            inputs: ["W2", "W3", "W5", "W6"],
            allowedForeignPaths: facetCapabilityIdentityPaths
        }
    ],
    [
        "foundation-public-contract.json",
        {
            id: "TRANSITION-FOUNDATION-PUBLIC-CONTRACT",
            canonicalOwner: "W0",
            inputs: ["W0", "W1"],
            allowedForeignPaths: foundationPublicContractPaths
        }
    ],
    [
        "interaction-identities.json",
        { id: "TRANSITION-INTERACTION-IDENTITIES", canonicalOwner: "W7", inputs: ["W6", "W7"] }
    ],
    [
        "w9-integration-candidate.json",
        {
            id: "TRANSITION-W9-INTEGRATION-CANDIDATE",
            canonicalOwner: "W9",
            inputs: expectedWaveOwners(),
            base: "aedf0d7f285483d986084883601481b697b723c7"
        }
    ]
]);
const dispositions = await validated("disposition-schema.json", "dispositions.json");
const resolutions = await validated("resolution-schema.json", "resolutions.json");
const userAuthorizationRequests = await validated(
    "user-authorization-request-schema.json",
    "user-authorization-requests.json"
);
const ownedPathVerification = await validated(
    "owned-path-verification-schema.json",
    "owned-path-verification.json"
);
const {
    bom,
    imports,
    missingSourceOwners,
    unreachableSourceOwners,
    unsignedInputs,
    verifiedSourceObjects
} = await loadValidatedBom(stage);
const archiveIndexed = integrationIndex.artifacts.includes("request-archive.json");
if (bom.stage === "final" && !archiveIndexed) {
    throw new TypeError("Final BOM requires an indexed request archive");
}
const transitionSchema = await readCanonicalJson(
    resolve(integrationRoot, "transition-schema.json")
);
const transitionIndex = await readCanonicalJson(resolve(integrationRoot, "transitions/index.json"));
if (JSON.stringify(transitionIndex.manifests) !== JSON.stringify([...expectedTransitions.keys()])) {
    throw new TypeError("Coordinated transition index differs from the fixed R1 denominator");
}
const transitionsRoot = resolve(integrationRoot, "transitions");
const actualTransitionFiles = (
    await collectFiles(transitionsRoot, (path) => path.endsWith(".json"))
)
    .map((path) => relative(transitionsRoot, path).replaceAll("\\", "/"))
    .filter((name) => name !== "index.json")
    .sort();
if (
    JSON.stringify(actualTransitionFiles) !== JSON.stringify([...transitionIndex.manifests].sort())
) {
    throw new TypeError("Coordinated transition files differ from their exact index");
}

const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const validateTransition = ajv.compile(transitionSchema);
const transitions = await Promise.all(
    transitionIndex.manifests.map(async (name) => {
        const value = await readCanonicalJson(resolve(integrationRoot, "transitions", name));
        if (!validateTransition(value)) {
            throw new TypeError(
                `Invalid coordinated transition ${name}: ${ajv.errorsText(validateTransition.errors)}`
            );
        }
        const expected = expectedTransitions.get(name);
        if (
            value.id !== expected.id ||
            value.canonicalOwner !== expected.canonicalOwner ||
            JSON.stringify(value.inputs.map((input) => input.owner)) !==
                JSON.stringify(expected.inputs) ||
            JSON.stringify(value.allowedForeignPaths) !==
                JSON.stringify(expected.allowedForeignPaths) ||
            (expected.base !== undefined && value.changeManifest?.base !== expected.base)
        ) {
            throw new TypeError(`Coordinated transition ${name} differs from its R1 identity`);
        }
        return value;
    })
);

const expectedOwners = expectedWaveOwners();
const expectedDecisionIds = [
    "W5-SOURCE-IDENTITY",
    "W5-FORCED-CANCELLATION",
    "W5-RETRY",
    "W5-SETTLEMENT-FRONTIER",
    "W8-ENVIRONMENT-PIN-IDENTITY",
    "W8-FILESYSTEM-RECEIPT-READONLY",
    "W8-SOURCE-EVENT-CAUSALITY",
    "W8-MCP-REPRODUCIBILITY",
    "W8-DEVICE-CONSENT-ADMISSION",
    "W8-SLATE-ROLLBACK",
    "W8-CLOUDFLARE-AUTHORITY-PERMIT"
];
const expectedDecisionObligations = new Map([
    [
        "W5-SOURCE-IDENTITY",
        "packages/agent-core/artifacts/requests/W5/clarifications.json::clarifications::W5-SOURCE-IDENTITY"
    ],
    [
        "W5-FORCED-CANCELLATION",
        "packages/agent-core/artifacts/requests/W5/clarifications.json::clarifications::W5-FORCED-CANCELLATION"
    ],
    [
        "W5-RETRY",
        "packages/agent-core/artifacts/requests/W5/clarifications.json::clarifications::W5-RETRY"
    ],
    [
        "W5-SETTLEMENT-FRONTIER",
        "packages/agent-core/artifacts/requests/W5/clarifications.json::clarifications::W5-SETTLEMENT-FRONTIER"
    ],
    [
        "W8-ENVIRONMENT-PIN-IDENTITY",
        "artifacts/requests/W8/normative-clarifications.md::decision::environment-pin-identity"
    ],
    [
        "W8-FILESYSTEM-RECEIPT-READONLY",
        "artifacts/requests/W8/normative-clarifications.md::decision::filesystem-mutation-evidence-and-readonly-wrappers"
    ],
    [
        "W8-SOURCE-EVENT-CAUSALITY",
        "artifacts/requests/W8/normative-clarifications.md::decision::source-event-audit-causality"
    ],
    [
        "W8-MCP-REPRODUCIBILITY",
        "artifacts/requests/W8/normative-clarifications.md::decision::mcp-reproducibility"
    ],
    [
        "W8-DEVICE-CONSENT-ADMISSION",
        "artifacts/requests/W8/normative-clarifications.md::decision::device-consent-admission"
    ],
    [
        "W8-SLATE-ROLLBACK",
        "artifacts/requests/W8/normative-clarifications.md::decision::slate-rollback"
    ],
    [
        "W8-CLOUDFLARE-AUTHORITY-PERMIT",
        "artifacts/requests/W8/normative-clarifications.md::decision::cloudflare-mediated-authority-linearization"
    ]
]);
const bomRequestSources = bom.entries
    .flatMap((entry) => entry.artifacts)
    .filter((artifact) => /(?:^|\/)artifacts\/requests\//u.test(artifact.source))
    .map((artifact) => [artifact.source, artifact.sourceSha256])
    .sort(([left], [right]) => left.localeCompare(right));
const normalizedResolutions = normalizeResolutions(resolutions);
const resolutionSources = normalizedResolutions
    .map(({ source, sourceSha256 }) => [source, sourceSha256])
    .sort(([left], [right]) => left.localeCompare(right));
if (
    new Set(normalizedResolutions.map(({ source }) => source)).size !==
        normalizedResolutions.length ||
    JSON.stringify(resolutionSources) !== JSON.stringify(bomRequestSources)
) {
    throw new TypeError("Request resolutions must correspond one-to-one with BOM request sources");
}
for (const resolution of normalizedResolutions) {
    if ((resolution.state === "pending") !== (resolution.completion === null)) {
        throw new TypeError(
            `${resolution.source} resolution state lacks exact completion evidence`
        );
    }
    if (!["pending", "applied", "rejected", "external-gated"].includes(resolution.state)) {
        throw new TypeError(`${resolution.source} has an invalid resolution state`);
    }
    if (resolution.completion !== null) {
        verifyCompletion(`Resolution ${resolution.source}`, resolution.completion);
    }
}
let requestArchiveBySource = new Map();
let archiveComplete = false;
if (archiveIndexed) {
    const archive = await loadValidatedRequestArchive();
    requestArchiveBySource = await validateFinalRequestArchive({
        archive,
        resolutions,
        bom,
        resolvePath: (path) => resolve(repositoryRoot, path),
        requireOutcome: stage === "final"
    });
    archiveComplete = true;
}
const trustedSigners = await readCanonicalJson(resolve(integrationRoot, "trusted-signers.json"));
const expectedSigningRequests = bom.entries.map((entry) => ({
    owner: entry.owner,
    commit: entry.commit,
    tree: entry.tree,
    currentStatus: entry.commitSignature.status
}));
if (
    JSON.stringify(userAuthorizationRequests.signing.commits) !==
        JSON.stringify(expectedSigningRequests) ||
    JSON.stringify(userAuthorizationRequests.signing.trustedFingerprintsByOwner) !==
        JSON.stringify(trustedSigners.owners)
) {
    throw new TypeError("User signing authorization request differs from the exact BOM trust gap");
}
const remoteArchive = requestArchiveBySource.get(userAuthorizationRequests.remoteConsent.source);
const remoteGates = await readCanonicalJson(resolve(repositoryRoot, remoteArchive.path));
const conformanceIndex = await readCanonicalJson(resolve(artifactRoot, "conformance/index.json"));
if (
    remoteArchive.sourceSha256 !== userAuthorizationRequests.remoteConsent.sourceSha256 ||
    JSON.stringify(userAuthorizationRequests.remoteConsent.gates) !==
        JSON.stringify(remoteGates.gates.map((gate) => gate.id).sort()) ||
    JSON.stringify(userAuthorizationRequests.remoteConsent.atoms) !==
        JSON.stringify([...conformanceIndex.externalGates].sort()) ||
    userAuthorizationRequests.remoteConsent.executionPerformed !== false ||
    userAuthorizationRequests.remoteConsent.localSubstitute !== false ||
    remoteGates.gates.some((gate) => gate.localSubstitute !== false) ||
    remoteGates.gates.some(
        (gate) => process.env[gate.requiredConsent.environmentVariable] !== undefined
    ) ||
    process.env["CLOUDFLARE_ACCOUNT_ID"] !== undefined
) {
    throw new TypeError("User remote consent request differs from the exact external gate gap");
}
for (const resolution of normalizedResolutions) {
    if (resolution.state !== "pending" && !requestArchiveBySource.has(resolution.source)) {
        throw new TypeError(`${resolution.source} resolution lacks indexed archive evidence`);
    }
}
if (
    JSON.stringify(resolutions.decisions.map((entry) => entry.id)) !==
    JSON.stringify(expectedDecisionIds)
) {
    throw new TypeError("SPEC/formal decision denominator changed");
}
const knownSpecAtoms = new Set((await specRequirements()).map((requirement) => requirement.id));
const resolutionSourceSet = new Set(normalizedResolutions.map(({ source }) => source));
for (const decision of resolutions.decisions) {
    if (!resolutionSourceSet.has(decision.source)) {
        throw new TypeError(`${decision.id} references a non-resolution source`);
    }
    if (decision.specAtoms.some((id) => !knownSpecAtoms.has(id))) {
        throw new TypeError(`${decision.id} references an unknown SPEC atom`);
    }
    const resolution = normalizedResolutions.find((entry) => entry.source === decision.source);
    const obligation = resolution?.outcome?.items.find(
        (item) => item.obligationId === decision.obligationId
    );
    if (
        obligation === undefined ||
        decision.obligationId !== expectedDecisionObligations.get(decision.id) ||
        obligation.anchor !== decision.anchor ||
        obligation.treatment !== (decision.disposition === "accepted" ? "accepted" : "rejected")
    ) {
        throw new TypeError(`${decision.id} differs from its atomic outcome obligation`);
    }
    await verifyDecisionAnchor(decision, requestArchiveBySource);
}
const retryResolution = resolutions.decisions.find((entry) => entry.id === "W5-RETRY");
if (
    retryResolution.disposition !== "rejected" ||
    !retryResolution.integrationAction.includes("must remove")
) {
    throw new TypeError("W5 Turn retry rejection is not integration-enforced");
}
const dispositionOwners = dispositions.waves.map((wave) => wave.owner);
if (JSON.stringify(dispositionOwners) !== JSON.stringify(expectedOwners)) {
    throw new TypeError("Integration dispositions must contain W0 through W9 in order");
}
const byOwner = new Map(dispositions.waves.map((wave) => [wave.owner, wave]));
for (const disposition of dispositions.waves) {
    if (disposition.state === "pending-final-head") {
        if (
            disposition.commit !== null ||
            disposition.tree !== null ||
            disposition.clean !== null ||
            disposition.blockers.length === 0
        ) {
            throw new TypeError(`${disposition.owner} pending disposition is malformed`);
        }
    } else if (disposition.state === "accepted-input") {
        if (
            disposition.commit === null ||
            disposition.tree === null ||
            disposition.clean !== true ||
            disposition.artifacts.length === 0 ||
            disposition.artifacts.some((artifact) => typeof artifact !== "string")
        ) {
            throw new TypeError(`${disposition.owner} accepted disposition is incomplete`);
        }
    } else if (disposition.state === "integration-candidate") {
        if (
            disposition.owner !== "W9" ||
            disposition.commit !== null ||
            disposition.tree !== null ||
            disposition.clean !== false ||
            disposition.artifacts.length === 0 ||
            disposition.blockers.length === 0
        ) {
            throw new TypeError(`${disposition.owner} candidate disposition is malformed`);
        }
    } else if (disposition.state === "completed") {
        if (
            disposition.owner !== "W9" ||
            disposition.commit === null ||
            disposition.tree === null ||
            disposition.clean !== true ||
            disposition.artifacts.length === 0 ||
            disposition.artifacts.some((artifact) => typeof artifact !== "object") ||
            disposition.blockers.length > 0
        ) {
            throw new TypeError(`${disposition.owner} completed disposition is malformed`);
        }
        verifyCompletion(`${disposition.owner} disposition`, {
            commit: disposition.commit,
            tree: disposition.tree,
            artifacts: disposition.artifacts
        });
    } else if (disposition.owner === "W0" && disposition.state === "governance") {
        if (
            disposition.commit === null ||
            disposition.tree === null ||
            disposition.clean !== true ||
            disposition.artifacts.length === 0 ||
            disposition.artifacts.some((artifact) => typeof artifact !== "string") ||
            disposition.blockers.length > 0
        ) {
            throw new TypeError("W0 governance disposition is incomplete");
        }
        verifyCommitTree("W0 governance", disposition.commit, disposition.tree);
    } else {
        throw new TypeError(`${disposition.owner} has an invalid governance disposition`);
    }
}

if (stage === "building" && bom.stage !== stage) {
    throw new TypeError(`The integration BOM stage ${bom.stage} does not match ${stage}`);
}
const bomStageMismatch = bom.stage !== stage;
const acceptedOwners = dispositions.waves
    .filter((wave) => wave.state === "accepted-input")
    .map((wave) => wave.owner);
const bomOwners = bom.entries.map((entry) => entry.owner);
if (JSON.stringify(bomOwners) !== JSON.stringify(acceptedOwners)) {
    throw new TypeError("The integration BOM owners differ from accepted dispositions");
}
for (const entry of bom.entries) {
    const disposition = byOwner.get(entry.owner);
    if (entry.commit !== disposition.commit || entry.tree !== disposition.tree) {
        throw new TypeError(`${entry.owner} BOM identity differs from its disposition`);
    }
}
verifyDispositionBomSets(stage, bom, byOwner, archiveComplete);
const sourceImports = new Map(
    bom.entries.flatMap((entry) =>
        entry.artifacts.map((artifact) => [artifact.source, { owner: entry.owner }])
    )
);
await verifyOwnedPaths(ownedPathVerification, imports, sourceImports);

const imported = [...imports.keys()].sort();

for (const transition of transitions) {
    const pendingInputs = transition.inputs.filter((input) => input.state === "pending-final-head");
    if (transition.allowedForeignPaths !== undefined) {
        const participants = transition.inputs.map((input) => input.owner);
        if (
            new Set(participants).size !== participants.length ||
            !participants.includes(transition.canonicalOwner)
        ) {
            throw new TypeError(`${transition.id} has invalid participants`);
        }
        const { patterns } = await loadOwnership();
        for (const path of transition.allowedForeignPaths) {
            const owners = ownersForPath(path, patterns);
            if (owners.length !== 1 || owners[0] !== transition.canonicalOwner) {
                throw new TypeError(
                    `${transition.id} foreign path is not canonically owned: ${path}`
                );
            }
        }
    }
    if (transition.state === "integration-candidate") {
        const { patterns } = await loadOwnership();
        validateCandidateChangeManifest(
            transition,
            changedPaths(transition.changeManifest.base),
            patterns,
            transition.changeManifest.base
        );
        validateCandidateWorktreeManifest(transition);
    } else if (
        transition.id === "TRANSITION-W9-INTEGRATION-CANDIDATE" &&
        transition.state === "completed"
    ) {
        const { patterns } = await loadOwnership();
        validateCompletedCandidateManifest(transition, patterns);
        const closureEntries = validateClosureManifest(transition, patterns);
        await validateArchivedRequestDeletions(
            closureEntries,
            patterns,
            bom,
            transition.closureManifest.commit
        );
        const remediationEntries = validateRemediationManifest(transition, patterns);
        const remediated = new Map(remediationEntries.map((entry) => [entry.path, entry]));
        const postClosureViolations = validateOwnershipPaths(
            "W0",
            changedPathsBetween(transition.closureManifest.commit, "HEAD"),
            patterns,
            {
                id: transition.id,
                canonicalOwner: transition.canonicalOwner,
                participants: new Set(transition.inputs.map((input) => input.owner)),
                allowedForeignPaths: new Set(remediationEntries.map((entry) => entry.path)),
                allowedForeignOwners: new Map(
                    remediationEntries.map((entry) => [entry.path, entry.owner])
                )
            }
        );
        for (const entry of remediationEntries.filter((item) => item.owner !== "W0")) {
            const current = spawnSync("git", ["rev-parse", `HEAD:${entry.path}`], {
                cwd: repositoryRoot,
                encoding: "utf8"
            });
            if (
                remediated.get(entry.path) !== entry ||
                current.status !== 0 ||
                current.stdout.trim() !== entry.candidateBlob
            ) {
                postClosureViolations.push({
                    path: entry.path,
                    owners: [entry.owner],
                    reason: "foreign remediation changed after its attested commit"
                });
            }
        }
        if (postClosureViolations.length > 0) {
            throw new TypeError(
                postClosureViolations
                    .map((item) => `${item.path}: post-closure ${item.reason}`)
                    .join("\n")
            );
        }
    }
    for (const input of transition.inputs) {
        const disposition = byOwner.get(input.owner);
        if (
            disposition === undefined ||
            input.state !== disposition.state ||
            input.commit !== disposition.commit
        ) {
            throw new TypeError(`${transition.id} input differs from ${input.owner} disposition`);
        }
    }
    if (transition.state === "pending-inputs") {
        if (
            pendingInputs.length === 0 ||
            transition.blockers.length === 0 ||
            transition.completion !== null
        ) {
            throw new TypeError(`${transition.id} pending state lacks exact blockers`);
        }
    } else if (transition.state === "ready-for-coordinated-integration") {
        if (
            pendingInputs.length > 0 ||
            transition.blockers.length > 0 ||
            transition.completion !== null
        ) {
            throw new TypeError(`${transition.id} is ready despite unresolved inputs`);
        }
    } else if (transition.state === "integration-candidate") {
        if (
            transition.canonicalOwner !== "W9" ||
            pendingInputs.length > 0 ||
            transition.blockers.length === 0 ||
            transition.completion !== null
        ) {
            throw new TypeError(`${transition.id} candidate state is malformed`);
        }
    } else {
        if (
            pendingInputs.length > 0 ||
            transition.blockers.length > 0 ||
            transition.completion === null
        ) {
            throw new TypeError(`${transition.id} completion lacks applied evidence`);
        }
        verifyTransitionCompletion(transition);
        if (transition.id === "TRANSITION-W9-INTEGRATION-CANDIDATE") {
            const disposition = byOwner.get("W9");
            if (
                disposition.state !== "completed" ||
                disposition.commit !== transition.closureManifest.commit ||
                disposition.tree !== transition.closureManifest.tree
            ) {
                throw new TypeError("W9 completion differs from its transition evidence");
            }
            verifyCompletion("W9 closure", {
                commit: disposition.commit,
                tree: disposition.tree,
                artifacts: disposition.artifacts
            });
        }
    }
}

const pendingDispositions = dispositions.waves
    .filter((wave) => wave.state === "pending-final-head" || wave.state === "integration-candidate")
    .map((wave) => wave.owner);
const pendingTransitions = transitions
    .filter((transition) => transition.state !== "completed")
    .map((transition) => transition.id);
const pendingResolutions = normalizedResolutions
    .filter((resolution) => resolution.state === "pending")
    .map((resolution) => resolution.source);
const externalGatedResolutions = normalizedResolutions
    .filter((resolution) => resolution.state === "external-gated")
    .map((resolution) => resolution.source);
const unprovenResolutions = normalizedResolutions
    .filter(
        (resolution) =>
            new Set(["applied", "rejected"]).has(resolution.state) &&
            resolution.outcome === undefined
    )
    .map((resolution) => resolution.source);
const pendingUserAuthorizations = [
    userAuthorizationRequests.signing,
    userAuthorizationRequests.remoteConsent
]
    .filter((request) => request.state.startsWith("awaiting-"))
    .map((request) => request.id);
await writeCanonicalJson(resolve(reportRoot, "governance.json"), {
    edition: "1.0.0",
    stage,
    importedArtifacts: imported,
    pendingDispositions,
    pendingTransitions,
    pendingResolutions,
    externalGatedResolutions,
    unprovenResolutions,
    pendingUserAuthorizations,
    unsignedInputs,
    missingSourceOwners,
    unreachableSourceOwners,
    verifiedSourceObjects,
    bomStageMismatch,
    archiveComplete,
    complete:
        !bomStageMismatch &&
        pendingDispositions.length === 0 &&
        pendingTransitions.length === 0 &&
        pendingResolutions.length === 0 &&
        externalGatedResolutions.length === 0 &&
        unprovenResolutions.length === 0 &&
        pendingUserAuthorizations.length === 0 &&
        (stage === "building" || archiveComplete) &&
        unsignedInputs.length === 0 &&
        missingSourceOwners.length === 0 &&
        unreachableSourceOwners.length === 0
});
if (
    stage === "final" &&
    (bomStageMismatch ||
        pendingDispositions.length > 0 ||
        pendingTransitions.length > 0 ||
        pendingResolutions.length > 0 ||
        externalGatedResolutions.length > 0 ||
        unprovenResolutions.length > 0 ||
        pendingUserAuthorizations.length > 0 ||
        !archiveComplete ||
        unsignedInputs.length > 0 ||
        missingSourceOwners.length > 0 ||
        unreachableSourceOwners.length > 0)
) {
    throw new TypeError(
        `Final governance is incomplete: bomStage=${bom.stage} archive=${archiveComplete} dispositions=${pendingDispositions.join(",")} transitions=${pendingTransitions.join(",")} resolutions=${pendingResolutions.length} external=${externalGatedResolutions.length} unproven=${unprovenResolutions.length} authorizations=${pendingUserAuthorizations.join(",")} unsigned=${unsignedInputs.join(",")} missing=${missingSourceOwners.join(",")} unreachable=${unreachableSourceOwners.join(",")}`
    );
}
console.log(
    `governance inputs verified: ${imported.length} artifact(s), ${verifiedSourceObjects} source object(s), ${pendingDispositions.length} pending disposition(s), ${pendingResolutions.length} pending resolution(s)`
);

async function validated(schemaName, documentName) {
    const validator = addFormats(new Ajv2020({ allErrors: true, strict: false }));
    const schema = await readCanonicalJson(resolve(integrationRoot, schemaName));
    const validate = validator.compile(schema);
    const document = await readCanonicalJson(resolve(integrationRoot, documentName));
    if (!validate(document)) {
        throw new TypeError(`Invalid ${documentName}: ${validator.errorsText(validate.errors)}`);
    }
    return document;
}

function verifyTransitionCompletion(transition) {
    verifyCompletion(transition.id, transition.completion);
}

function verifyCommitTree(label, commit, tree) {
    const result = spawnSync("git", ["show", "-s", "--format=%T", commit], {
        cwd: repositoryRoot,
        encoding: "utf8"
    });
    if (result.status !== 0 || result.stdout.trim() !== tree) {
        throw new TypeError(`${label} commit or tree is unavailable`);
    }
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
        cwd: repositoryRoot
    });
    if (ancestor.status !== 0) {
        throw new TypeError(`${label} commit is not an ancestor of HEAD`);
    }
}

function expectedWaveOwners() {
    return Array.from({ length: 10 }, (_, index) => `W${index}`);
}

async function verifyDecisionAnchor(decision, archiveBySource) {
    const sourcePath = archiveBySource.get(decision.source)?.path ?? decision.source;
    const source = await readFile(resolve(repositoryRoot, sourcePath), "utf8");
    if (decision.anchor.startsWith("#/")) {
        let value = JSON.parse(source);
        for (const raw of decision.anchor.slice(2).split("/")) {
            const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
            if (value === null || typeof value !== "object" || !(key in value)) {
                throw new TypeError(`${decision.id} JSON pointer does not resolve`);
            }
            value = value[key];
        }
        return;
    }
    const slug = decision.anchor.slice(1);
    const headings = source
        .split("\n")
        .filter((line) => /^#{1,6} /u.test(line))
        .map((line) =>
            line
                .replace(/^#{1,6} /u, "")
                .toLowerCase()
                .replaceAll(/[^a-z0-9]+/gu, "-")
                .replace(/^-|-$/gu, "")
        );
    if (!headings.includes(slug))
        throw new TypeError(`${decision.id} Markdown anchor does not resolve`);
}

function verifyDispositionBomSets(selectedStage, selectedBom, dispositionsByOwner, useArchive) {
    for (const entry of selectedBom.entries) {
        const disposition = dispositionsByOwner.get(entry.owner);
        const expected = entry.artifacts
            .map((artifact) =>
                useArchive || (selectedStage === "final" && selectedBom.stage === "final")
                    ? artifact.destination
                    : artifact.source
            )
            .sort();
        const actual = disposition.artifacts.map((artifact) =>
            typeof artifact === "string" ? artifact : artifact.path
        );
        if (useArchive || (selectedStage === "final" && selectedBom.stage === "final")) {
            if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) {
                throw new TypeError(
                    `${entry.owner} disposition artifacts differ from its BOM archive`
                );
            }
            continue;
        }
        if (
            actual.some((root) => !expected.some((path) => pathMatchesDisposition(root, path))) ||
            expected.some(
                (path) => actual.filter((root) => pathMatchesDisposition(root, path)).length !== 1
            )
        ) {
            throw new TypeError(`${entry.owner} disposition artifacts differ from its BOM sources`);
        }
    }
}

function pathMatchesDisposition(root, path) {
    return root === path || path.startsWith(`${root}/`);
}

async function verifyOwnedPaths(verification, imports, sourceImports) {
    const expectedOwners = Array.from({ length: 9 }, (_, index) => `W${index}`);
    if (
        verification.owner !== "W0" ||
        verification.baseline !== "f558d0ff3f7e93308481ea09c3bf369abbdd19ba" ||
        JSON.stringify(verification.waves.map((wave) => wave.owner)) !==
            JSON.stringify(expectedOwners) ||
        verification.violations.length > 0
    ) {
        throw new TypeError("Owned-path verification differs from the fixed R1 wave index");
    }

    const { ownership, patterns } = await loadOwnership();
    const fragmentOwners = new Map(
        Object.entries(ownership.domainFragments).map(([owner, fragment]) => [
            `${fragment}.json`,
            owner
        ])
    );
    const activeRegistryFragments = new Map();
    for (const registry of ["records", "seams", "conformance"]) {
        const index = await readCanonicalJson(resolve(artifactRoot, registry, "index.json"));
        for (const fragment of index.fragments ?? []) {
            const owner = fragmentOwners.get(fragment);
            if (owner === undefined) {
                throw new TypeError(`Active ${registry} fragment has no domain owner: ${fragment}`);
            }
            activeRegistryFragments.set(
                `packages/agent-core/artifacts/${registry}/${fragment}`,
                owner
            );
        }
    }
    if (
        JSON.stringify(
            ownersForPath(
                "packages/agent-core/artifacts/integration/owned-path-verification.json",
                patterns
            )
        ) !== JSON.stringify(["W0"])
    ) {
        throw new TypeError("Owned-path verification artifact must be exclusively W0-owned");
    }
    for (const wave of verification.waves) {
        const tree = spawnSync("git", ["show", "-s", "--format=%T", wave.commit], {
            cwd: repositoryRoot,
            encoding: "utf8"
        });
        if (tree.status !== 0 || tree.stdout.trim() !== wave.tree) {
            throw new TypeError(`${wave.owner} owned-path commit or tree is unavailable`);
        }
        const changed = spawnSync(
            "git",
            ["diff", "--name-only", verification.baseline, wave.commit],
            { cwd: repositoryRoot, encoding: "utf8" }
        );
        if (changed.status !== 0) {
            throw new TypeError(`${wave.owner} owned-path diff is unavailable`);
        }
        const paths = changed.stdout.split("\n").filter(Boolean);
        const splitPaths = new Map(wave.splitPaths.map((item) => [item.path, item.owner]));
        const violations = paths.filter((path) => {
            const expectedOwner =
                splitPaths.get(path) ??
                (wave.owner === "W0"
                    ? (sourceImports.get(path)?.owner ??
                      imports.get(path)?.owner ??
                      activeRegistryFragments.get(path) ??
                      wave.owner)
                    : wave.owner);
            const owners = ownersForPath(path, patterns);
            return owners.length !== 1 || owners[0] !== expectedOwner;
        });
        if (
            paths.length !== wave.checkedPathCount ||
            violations.length > 0 ||
            wave.violations.length > 0
        ) {
            throw new TypeError(`${wave.owner} owned-path verification is stale`);
        }
    }

    const w8 = verification.waves.at(-1);
    const expectedW8SplitPaths = [
        { path: "packages/agent-core-cloudflare/tsconfig.build.json", owner: "W0" },
        { path: "packages/agent-core-cloudflare/tsconfig.json", owner: "W0" }
    ];
    if (JSON.stringify(w8.splitPaths) !== JSON.stringify(expectedW8SplitPaths)) {
        throw new TypeError("W8 owned-path split differs from the supplied W0 paths");
    }
}

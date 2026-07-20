import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { artifactRoot, fileSha256, readCanonicalJson, repositoryRoot } from "./project.mjs";
import { verifyCompletionArtifacts } from "./completion.mjs";
import { extractRequestObligations } from "./request-obligations.mjs";

export const requestArchivePrefix = "packages/agent-core/artifacts/integration/request-archive/";

export function isRequestSource(path) {
    return /^(?:artifacts|packages\/agent-core\/artifacts)\/requests\//u.test(path);
}

export function normalizeResolutions(document) {
    return document.entries.map((entry) =>
        Array.isArray(entry)
            ? {
                  source: entry[0],
                  sourceSha256: entry[1],
                  archive: null,
                  archiveSha256: null,
                  state: entry[2],
                  completion: entry[3]
              }
            : entry
    );
}

export async function loadValidatedRequestArchive(selectedArtifactRoot = artifactRoot) {
    const integrationRoot = resolve(selectedArtifactRoot, "integration");
    const [schema, archive] = await Promise.all([
        readCanonicalJson(resolve(integrationRoot, "request-archive-schema.json")),
        readCanonicalJson(resolve(integrationRoot, "request-archive.json"))
    ]);
    const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
    const validate = ajv.compile(schema);
    if (!validate(archive)) {
        throw new TypeError(`Invalid request-archive.json: ${ajv.errorsText(validate.errors)}`);
    }
    return archive;
}

export async function validateFinalRequestArchive({
    archive,
    resolutions,
    bom,
    archiveFiles,
    resolvePath,
    completionRoot,
    verifyCompletionEvidence = verifyCompletionArtifacts,
    requireOutcome = false
}) {
    const expected = bom.entries
        .flatMap((entry) =>
            entry.artifacts
                .filter((artifact) => isRequestSource(artifact.source))
                .map((artifact) => ({ owner: entry.owner, ...artifact }))
        )
        .sort((left, right) => left.source.localeCompare(right.source));
    const archived = [...archive.entries].sort((left, right) =>
        left.source.localeCompare(right.source)
    );
    const finalized = normalizeResolutions(resolutions).sort((left, right) =>
        left.source.localeCompare(right.source)
    );
    assertUnique(
        archived.map((entry) => entry.source),
        "archive source"
    );
    assertUnique(
        archived.map((entry) => entry.path),
        "archive path"
    );
    assertUnique(
        finalized.map((entry) => entry.source),
        "resolution source"
    );

    if (
        expected.length === 0 ||
        archived.length !== expected.length ||
        finalized.length !== expected.length
    ) {
        throw new TypeError(
            "Final request archive, resolutions, and BOM have different denominators"
        );
    }
    for (let index = 0; index < expected.length; index += 1) {
        const artifact = expected[index];
        const archivedEntry = archived[index];
        const resolution = finalized[index];
        if (
            artifact.source !== archivedEntry.source ||
            artifact.source !== resolution.source ||
            artifact.owner !== archivedEntry.owner ||
            artifact.sourceSha256 !== archivedEntry.sourceSha256 ||
            artifact.sourceSha256 !== resolution.sourceSha256 ||
            artifact.destination !== archivedEntry.path ||
            artifact.destination !== resolution.archive ||
            artifact.sha256 !== archivedEntry.sha256 ||
            artifact.sha256 !== resolution.archiveSha256 ||
            !artifact.destination.startsWith(requestArchivePrefix) ||
            isRequestSource(artifact.destination)
        ) {
            throw new TypeError(
                `Final request archive differs from BOM source: ${artifact.source}`
            );
        }
        if (
            !new Set(["applied", "rejected", "external-gated"]).has(resolution.state) ||
            resolution.completion === null
        ) {
            throw new TypeError(`Final request resolution is incomplete: ${artifact.source}`);
        }
        if (
            resolvePath !== undefined &&
            (await fileSha256(resolvePath(archivedEntry.path))) !== archivedEntry.sha256
        ) {
            throw new TypeError(`Archived request bytes changed: ${archivedEntry.path}`);
        }
        if (resolution.outcome !== undefined) {
            const archivePath =
                resolvePath?.(archivedEntry.path) ?? resolve(repositoryRoot, archivedEntry.path);
            const archiveBytes = await readFile(archivePath, "utf8");
            await validateOutcome(resolution, completionRoot, archiveBytes);
        } else if (resolution.state === "external-gated") {
            const archivePath =
                resolvePath?.(archivedEntry.path) ?? resolve(repositoryRoot, archivedEntry.path);
            const archiveBytes = await readFile(archivePath, "utf8");
            validateExternalItems(resolution, archiveBytes);
        } else if (requireOutcome) {
            throw new TypeError(
                `Request resolution lacks state-specific outcome: ${resolution.source}`
            );
        }
        verifyCompletionEvidence(
            `Resolution ${artifact.source}`,
            resolution.completion,
            completionRoot
        );
        const completionArtifact = resolution.completion.artifacts.filter(
            (item) => item.path === archivedEntry.path && item.sha256 === archivedEntry.sha256
        );
        if (completionArtifact.length !== 1) {
            throw new TypeError(
                `Final request resolution lacks its archive artifact: ${artifact.source}`
            );
        }
    }
    if (
        archiveFiles !== undefined &&
        JSON.stringify([...archiveFiles].sort()) !==
            JSON.stringify(archived.map((entry) => entry.path).sort())
    ) {
        throw new TypeError("Request archive files differ from their exact index");
    }
    return new Map(archived.map((entry) => [entry.source, entry]));
}

function validateExternalItems(resolution, archiveBytes) {
    const obligations = extractRequestObligations(
        resolution.source,
        resolution.sourceSha256,
        archiveBytes
    );
    const items = resolution.externalItems ?? [];
    if (items.length !== obligations.length) {
        throw new TypeError(`External request outcome denominator changed: ${resolution.source}`);
    }
    for (const obligation of obligations) {
        const matches = items.filter((item) => item.obligationId === obligation.obligationId);
        if (
            matches.length !== 1 ||
            matches[0].source !== obligation.source ||
            matches[0].anchor !== obligation.anchor ||
            matches[0].atomSha256 !== obligation.atomSha256 ||
            matches[0].treatment !== "external-gated"
        ) {
            throw new TypeError(
                `External request outcome is incomplete: ${obligation.obligationId}`
            );
        }
    }
}

async function validateOutcome(resolution, completionRoot, archiveBytes) {
    if (resolution.state === "external-gated") {
        throw new TypeError(
            `External request resolution requires trusted remote evidence: ${resolution.source}`
        );
    }
    if (
        resolution.outcome?.kind !== resolution.state ||
        resolution.outcome.artifacts.length === 0 ||
        resolution.outcome.rationale.length === 0 ||
        (resolution.outcome.tests.length === 0 && resolution.outcome.checks.length === 0)
    ) {
        throw new TypeError(
            `Request resolution lacks state-specific outcome: ${resolution.source}`
        );
    }
    verifyCompletionArtifacts(
        `Outcome ${resolution.source}`,
        {
            commit: resolution.outcome.commit,
            tree: resolution.outcome.tree,
            artifacts: resolution.outcome.artifacts
        },
        completionRoot
    );
    const artifactPaths = new Set(resolution.outcome.artifacts.map((artifact) => artifact.path));
    for (const selector of resolution.outcome.tests) {
        const separator = selector.indexOf("#");
        const selectedPath = separator < 0 ? selector : selector.slice(0, separator);
        const artifactPath = selectedPath.startsWith("cloudflare/")
            ? `packages/agent-core-cloudflare/${selectedPath.slice("cloudflare/".length)}`
            : `packages/agent-core/${selectedPath}`;
        if (separator < 1 || !artifactPaths.has(artifactPath)) {
            throw new TypeError(
                `Request outcome test lacks an immutable test artifact: ${resolution.source} ${selector}`
            );
        }
    }
    const obligations = extractRequestObligations(
        resolution.source,
        resolution.sourceSha256,
        archiveBytes
    );
    const expected = new Map(obligations.map((item) => [item.obligationId, item]));
    const actual = new Map(
        resolution.outcome.items.map((item) => {
            if (actualHasDuplicate(resolution.outcome.items, item.obligationId)) {
                throw new TypeError(`Duplicate request outcome obligation: ${item.obligationId}`);
            }
            return [item.obligationId, item];
        })
    );
    if (expected.size !== actual.size) {
        throw new TypeError(`Request outcome denominator changed: ${resolution.source}`);
    }
    const parentTests = new Set(resolution.outcome.tests);
    const parentChecks = new Set(resolution.outcome.checks);
    for (const [id, obligation] of expected) {
        const item = actual.get(id);
        if (
            item === undefined ||
            item.source !== obligation.source ||
            item.anchor !== obligation.anchor ||
            item.atomSha256 !== obligation.atomSha256 ||
            item.artifactPaths.length === 0 ||
            item.artifactPaths.some((path) => !artifactPaths.has(path)) ||
            item.tests.some((selector) => !parentTests.has(selector)) ||
            item.checks.some((check) => !parentChecks.has(check)) ||
            (item.tests.length === 0 && item.checks.length === 0)
        ) {
            throw new TypeError(`Request outcome obligation is incomplete: ${id}`);
        }
    }
    const treatments = new Set(resolution.outcome.items.map((item) => item.treatment));
    const aggregateTreatment =
        treatments.size === 1
            ? treatments.has("accepted")
                ? "accepted"
                : treatments.has("superseded")
                  ? "superseded"
                  : "rejected"
            : "mixed";
    if (resolution.outcome.treatment !== aggregateTreatment) {
        throw new TypeError(`Request outcome aggregate treatment is stale: ${resolution.source}`);
    }
}

function actualHasDuplicate(items, id) {
    return items.filter((item) => item.obligationId === id).length !== 1;
}

function assertUnique(values, label) {
    if (new Set(values).size !== values.length) {
        throw new TypeError(`Duplicate final request ${label}`);
    }
}

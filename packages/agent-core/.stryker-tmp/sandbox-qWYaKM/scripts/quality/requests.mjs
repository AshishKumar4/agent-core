// @ts-nocheck
import { relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
    artifactRoot,
    assertExactKeys,
    assertString,
    collectFiles,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";
import { loadOwnership, ownersForPath } from "./ownership.mjs";
import { loadValidatedBom } from "./bom.mjs";
import { loadValidatedRequestArchive, validateFinalRequestArchive } from "./request-archive.mjs";

const stage = argument("--stage") ?? "building";
if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
const selectedArtifactRoot = argument("--artifact-root", true) ?? artifactRoot;
const selectedRepositoryRoot = argument("--repository-root", true);
const schema = await readCanonicalJson(
    resolve(selectedArtifactRoot, "quality/request-schema.json")
);
const evidenceSchema = await readCanonicalJson(
    resolve(selectedArtifactRoot, "quality/request-evidence-schema.json")
);
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const validateEvidence = ajv.compile(evidenceSchema);
const roots = [
    ...(selectedRepositoryRoot === undefined
        ? selectedArtifactRoot === artifactRoot
            ? [resolve(repositoryRoot, "artifacts/requests")]
            : []
        : [resolve(selectedRepositoryRoot, "artifacts/requests")]),
    resolve(selectedArtifactRoot, "requests")
];
const files = (await Promise.all(roots.map((root) => collectFiles(root)))).flat();
if (stage === "final" && files.length > 0) {
    throw new TypeError(`Final request roots must be empty: ${files.length} file(s)`);
}
const bomData =
    selectedArtifactRoot === artifactRoot
        ? await loadValidatedBom(stage)
        : await loadFixtureBom(selectedArtifactRoot, stage);
const imports = bomData?.imports ?? new Map();
const selectedBom = bomData?.bom;
const identities = new Set();
const requests = [];
const documents = [];
const { patterns } = await loadOwnership();
for (const path of files) {
    const root = roots.find((candidate) => path.startsWith(`${candidate}/`));
    if (root === undefined) throw new TypeError(`Request path is outside a request root: ${path}`);
    const directoryOwner = relative(root, path).split(/[\\/]/u)[0];
    const source = relative(repositoryRoot, path).replaceAll("\\", "/");
    const imported = imports.get(source);
    if (imported !== undefined) {
        if (imported.owner !== directoryOwner) {
            throw new TypeError(`BOM owner differs from request directory: ${source}`);
        }
        documents.push({
            owner: directoryOwner,
            source,
            kind: "pending-disposition-evidence",
            disposition: "accepted-input"
        });
        continue;
    }
    if (!path.endsWith(".json")) {
        throw new TypeError(`Non-JSON request artifact is not BOM-attested: ${source}`);
    }
    const document = await readCanonicalJson(path);
    if (document.schemaVersion === "agent-core.integration-request/v1") {
        validateIntegrationDocument(document, directoryOwner, source);
        for (const entry of document.requests) {
            addRequest(
                `integration:${entry.id}`,
                document.workstream,
                "integration",
                source,
                entry
            );
        }
        continue;
    }
    if (document.schemaVersion === "agent-core.consent-gate/v1") {
        validateConsentDocument(document, directoryOwner, source);
        for (const entry of document.gates) {
            addRequest(`consent:${entry.id}`, document.workstream, "consent", source, entry);
        }
        continue;
    }
    if (
        document.edition === "1.0.0" &&
        typeof document.request === "string" &&
        typeof document.status === "string"
    ) {
        if (directoryOwner !== document.request.slice(0, 2)) {
            throw new TypeError(
                `Legacy request ${document.request} is stored under ${directoryOwner}`
            );
        }
        addRequest(`legacy:${document.request}`, directoryOwner, "legacy", source, document);
        continue;
    }
    if (document.edition === "1.0.0" && document.status === "verified") {
        const imported = imports.get(source);
        if (
            imported?.owner !== directoryOwner ||
            !validateEvidence(document) ||
            Object.values(document.metrics).some(
                (metric) =>
                    metric.covered > metric.total ||
                    metric.covered * 100 < document.minimumPercent * metric.total ||
                    Math.abs(metric.percent - (metric.covered / metric.total) * 100) >= 0.01
            )
        ) {
            throw new TypeError(`Imported request evidence is malformed: ${source}`);
        }
        documents.push({ owner: directoryOwner, source, kind: "evidence", document });
        continue;
    }
    assertExactKeys(document, ["edition", "owner", "kind", "requests"], "Request fragment");
    if (document.edition !== "1.0.0") throw new TypeError("Unsupported request fragment edition");
    assertString(document.owner, "Request owner");
    if (directoryOwner !== document.owner) {
        throw new TypeError(
            `Request fragment owner ${document.owner} does not match directory ${directoryOwner}`
        );
    }
    const fields = schema.kinds[document.kind];
    if (fields === undefined) throw new TypeError(`Unknown request kind ${document.kind}`);
    if (!Array.isArray(document.requests)) throw new TypeError("Request entries must be an array");
    for (const entry of document.requests) {
        assertExactKeys(entry, fields, `${document.kind} request`);
        for (const field of fields) {
            if (field === "typeOnly") {
                if (typeof entry[field] !== "boolean")
                    throw new TypeError("typeOnly must be boolean");
            } else if (field === "tests") {
                if (
                    !Array.isArray(entry[field]) ||
                    entry[field].length === 0 ||
                    entry[field].some((test) => typeof test !== "string" || test.length === 0) ||
                    new Set(entry[field]).size !== entry[field].length
                )
                    throw new TypeError("Error/export requests require tests");
            } else assertString(entry[field], `${document.kind}.${field}`);
        }
        if (document.kind === "source-removals") {
            if (entry.owner !== document.owner)
                throw new TypeError("Source removal owner must match its fragment");
            const owners = ownersForPath(entry.path, patterns);
            if (owners.length !== 1 || owners[0] !== document.owner) {
                throw new TypeError(
                    `Source removal is not owned by ${document.owner}: ${entry.path}`
                );
            }
        }
        const identity = requestIdentity(document.kind, entry);
        addRequest(identity, document.owner, document.kind, source, entry);
    }
}
requests.sort((left, right) => left.identity.localeCompare(right.identity));
documents.sort((left, right) => left.source.localeCompare(right.source));
let archived = 0;
let integrationIndex;
if (selectedBom !== undefined) {
    try {
        integrationIndex = await readCanonicalJson(
            resolve(selectedArtifactRoot, "integration/index.json")
        );
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
}
const archiveRequired =
    stage === "final" || integrationIndex?.artifacts.includes("request-archive.json");
if (archiveRequired) {
    if (selectedBom === undefined) {
        throw new TypeError("Final request validation requires the repository integration BOM");
    }
    const [archive, resolutions] = await Promise.all([
        loadValidatedRequestArchive(selectedArtifactRoot),
        readCanonicalJson(resolve(selectedArtifactRoot, "integration/resolutions.json"))
    ]);
    const archiveRoot = resolve(selectedArtifactRoot, "integration/request-archive");
    const repository = selectedRepositoryRoot ?? repositoryRoot;
    const archiveFiles = (await collectFiles(archiveRoot)).map((path) =>
        relative(repository, path).replaceAll("\\", "/")
    );
    await validateFinalRequestArchive({
        archive,
        resolutions,
        bom: selectedBom,
        archiveFiles,
        resolvePath: (path) => resolve(repository, path),
        completionRoot: repository,
        requireOutcome: stage === "final"
    });
    archived = archive.entries.length;
}
await writeCanonicalJson(resolve(reportRoot, "requests.json"), {
    edition: "1.0.0",
    stage,
    requests,
    documents,
    archived,
    complete: files.length === 0 && (stage === "building" || archived > 0)
});
console.log(
    `shared ownership requests aggregated: ${requests.length}, pending disposition evidence: ${documents.length}, archived: ${archived}`
);

function addRequest(identity, owner, kind, source, request) {
    if (identities.has(identity)) throw new TypeError(`Duplicate shared request ${identity}`);
    identities.add(identity);
    requests.push({ owner, kind, identity, source, request });
}

function validateIntegrationDocument(document, directoryOwner, source) {
    if (
        document.workstream !== directoryOwner ||
        !/^[a-f0-9]{40}$/u.test(document.baseCommit) ||
        !Array.isArray(document.requests) ||
        document.requests.length === 0
    ) {
        throw new TypeError(`Integration request document is malformed: ${source}`);
    }
    for (const request of document.requests) {
        if (
            typeof request?.id !== "string" ||
            !request.id.startsWith(`${directoryOwner}-`) ||
            typeof request.owner !== "string" ||
            typeof request.kind !== "string" ||
            !["requested", "integration-dependent"].includes(request.state)
        ) {
            throw new TypeError(`Integration request entry is malformed: ${source}`);
        }
    }
}

function validateConsentDocument(document, directoryOwner, source) {
    if (
        document.workstream !== directoryOwner ||
        !Array.isArray(document.gates) ||
        document.gates.length === 0 ||
        document.gates.some(
            (gate) =>
                typeof gate?.id !== "string" ||
                !gate.id.startsWith(`${directoryOwner}-`) ||
                gate.status !== "consent-gated" ||
                gate.localSubstitute !== false
        )
    ) {
        throw new TypeError(`Consent gate document is malformed: ${source}`);
    }
}

function requestIdentity(kind, entry) {
    if (kind === "errors") return `${kind}:${entry.code}`;
    if (kind === "exports") return `${kind}:${entry.specifier}:${entry.symbol}`;
    if (kind === "source-removals") return `${kind}:${entry.path}`;
    return `${kind}:${entry.context}:${entry.symbol}`;
}

function argument(name, path = false) {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    if (value === undefined) throw new TypeError(`${name} requires a value`);
    return path ? resolve(value) : value;
}

async function loadFixtureBom(selectedRoot, selectedStage) {
    const path = resolve(selectedRoot, "integration/bom.json");
    try {
        const bom = await readCanonicalJson(path);
        if (bom.stage !== selectedStage) {
            throw new TypeError(
                `The integration BOM stage ${bom.stage} does not match ${selectedStage}`
            );
        }
        return { bom, imports: new Map() };
    } catch (error) {
        if (selectedStage === "building" && error?.code === "ENOENT") return undefined;
        throw error;
    }
}

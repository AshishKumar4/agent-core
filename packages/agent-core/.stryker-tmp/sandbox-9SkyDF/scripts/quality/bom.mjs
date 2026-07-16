// @ts-nocheck
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
    absoluteFromRepository,
    artifactRoot,
    fileSha256,
    readCanonicalJson,
    repositoryRoot,
    sha256
} from "./project.mjs";

const anchoredInputs = new Map([
    [
        "W1",
        {
            commit: "aef9246e02cf3f5ca54ea9b1f84524743d789d26",
            tree: "6544042f9953a83121f3bb987a9cdab695ef3780"
        }
    ],
    [
        "W2",
        {
            commit: "b4e1056368e6b4064c39669d469e44f3c5d7517a",
            tree: "5695314d1fea86ba594d2c10a30676b47800202e"
        }
    ],
    [
        "W3",
        {
            commit: "1daf42bf5ca1a71ddc619be78f6f23da213717d3",
            tree: "a15d6218311c739fb52d232fb11986d4b387f7f8"
        }
    ],
    [
        "W4",
        {
            commit: "e89dff315b2e55d6d092c24fc1888978b72cbebd",
            tree: "0384d71d927dceb8e25725c0f0d828025622ab5b"
        }
    ],
    [
        "W5",
        {
            commit: "0fcd7141898615b2234d875ce1018f11c89e354d",
            tree: "a90ce6a9b197dbc214f2fb25c2b4cd1c954649ec"
        }
    ],
    [
        "W6",
        {
            commit: "01a457f9207039ba41aabf1a94f6ab3aaddbfdd2",
            tree: "b8f7a6abe47a7dd1d7ee5c40e09a8c44ac561bf6"
        }
    ],
    [
        "W7",
        {
            commit: "96fbfc9b32ac0ee3705ccfe108ce04f22c83d18c",
            tree: "9de0bb8835b4818a32e805f7fdea0b3a719321d5"
        }
    ],
    [
        "W8",
        {
            commit: "a6753495cf0bcacc0ada8b76f3fef6b3f54c80f0",
            tree: "28117468fda9ba87da57e883ab9e763e5de531cd"
        }
    ]
]);

export async function loadValidatedBom(stage = "building") {
    const integrationRoot = resolve(artifactRoot, "integration");
    const schema = await readCanonicalJson(resolve(integrationRoot, "bom-schema.json"));
    const bom = await readCanonicalJson(resolve(integrationRoot, "bom.json"));
    const trustedSigners = await readCanonicalJson(
        resolve(integrationRoot, "trusted-signers.json")
    );
    if (
        trustedSigners.edition !== "1.0.0" ||
        JSON.stringify(Object.keys(trustedSigners.owners)) !==
            JSON.stringify([...anchoredInputs.keys()]) ||
        Object.values(trustedSigners.owners).some(
            (fingerprints) =>
                !Array.isArray(fingerprints) ||
                new Set(fingerprints).size !== fingerprints.length ||
                fingerprints.some((fingerprint) => !/^[A-F0-9]{40,64}$/u.test(fingerprint))
        )
    ) {
        throw new TypeError("Trusted integration signer policy is malformed");
    }
    const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
    const validate = ajv.compile(schema);
    if (!validate(bom)) {
        throw new TypeError(`Invalid bom.json: ${ajv.errorsText(validate.errors)}`);
    }
    if (bom.stage !== stage) {
        throw new TypeError(`The integration BOM stage ${bom.stage} does not match ${stage}`);
    }

    const imports = new Map();
    const pendingImmutableInputs = await pendingImmutableInputDestinations();
    const denominator = validateBomImportDenominator(bom.entries, pendingImmutableInputs);
    const missingSourceOwners = new Set();
    const unreachableSourceOwners = new Set();
    const unsignedInputs = [];
    let verifiedSourceObjects = 0;
    for (const entry of bom.entries) {
        const anchor = anchoredInputs.get(entry.owner);
        if (
            anchor !== undefined &&
            (entry.commit !== anchor.commit || entry.tree !== anchor.tree)
        ) {
            throw new TypeError(`${entry.owner} BOM identity differs from the anchored R1 input`);
        }
        const commit = inspectCommit(entry.commit);
        if (commit === undefined) {
            missingSourceOwners.add(entry.owner);
        } else if (commit.tree !== entry.tree) {
            throw new TypeError(`${entry.owner} BOM tree differs from ${entry.commit}^{tree}`);
        } else if (!isAncestor(entry.commit)) {
            unreachableSourceOwners.add(entry.owner);
        }
        if (entry.commitSignature.status === "verified") {
            verifyCommitSignature(entry, new Set(trustedSigners.owners[entry.owner] ?? []));
        } else {
            if (entry.commitSignature.keyFingerprint !== null) {
                throw new TypeError(`${entry.owner} unsigned BOM entry claims signature data`);
            }
            unsignedInputs.push(entry.owner);
        }
        for (const artifact of entry.artifacts) {
            if (imports.has(artifact.destination)) {
                throw new TypeError(`Duplicate BOM destination ${artifact.destination}`);
            }
            const destination = absoluteFromRepository(artifact.destination);
            if ((await fileSha256(destination)) !== artifact.sha256) {
                throw new TypeError(`BOM destination digest changed: ${artifact.destination}`);
            }
            if (artifact.normalization === "none" && artifact.sourceSha256 !== artifact.sha256) {
                throw new TypeError(
                    `Unnormalized BOM artifact changed bytes: ${artifact.destination}`
                );
            }
            if (commit !== undefined) {
                await verifySourceArtifact(entry.commit, artifact, destination);
                verifiedSourceObjects += 1;
            }
            imports.set(artifact.destination, { owner: entry.owner, sha256: artifact.sha256 });
        }
        if (commit !== undefined) verifyCompleteRequestImport(entry);
    }
    if (imports.size !== denominator.requestCount + denominator.pendingCount) {
        throw new TypeError("BOM import denominator changed during validation");
    }
    return {
        bom,
        imports,
        missingSourceOwners: [...missingSourceOwners].sort(),
        unreachableSourceOwners: [...unreachableSourceOwners].sort(),
        unsignedInputs,
        verifiedSourceObjects
    };
}

function isAncestor(commit) {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
        cwd: repositoryRoot
    });
    return result.status === 0;
}

export function validateBomImportDenominator(entries, pendingImmutableInputs) {
    const artifacts = entries.flatMap((entry) => entry.artifacts);
    const pending = artifacts
        .filter((artifact) => !isRequestSource(artifact.source))
        .map((artifact) => artifact.destination)
        .sort();
    const expectedPending = [...pendingImmutableInputs].sort();
    if (
        new Set(pending).size !== pending.length ||
        JSON.stringify(pending) !== JSON.stringify(expectedPending)
    ) {
        throw new TypeError(
            "BOM non-request imports must equal the exact pending immutable registry inputs"
        );
    }
    return {
        requestCount: artifacts.filter((artifact) => isRequestSource(artifact.source)).length,
        pendingCount: pending.length
    };
}

async function pendingImmutableInputDestinations() {
    const destinations = new Set();
    for (const registry of ["records", "seams", "conformance"]) {
        const index = await readCanonicalJson(resolve(artifactRoot, registry, "index.json"));
        for (const fragment of index.pendingFragments ?? []) {
            const destination = `packages/agent-core/artifacts/${registry}/${fragment}`;
            if (destinations.has(destination)) {
                throw new TypeError(`Duplicate pending immutable input ${destination}`);
            }
            destinations.add(destination);
        }
    }
    return destinations;
}

function isRequestSource(path) {
    return /^(?:artifacts|packages\/agent-core\/artifacts)\/requests\//u.test(path);
}

function verifyCompleteRequestImport(entry) {
    const requestRoot =
        entry.owner === "W8"
            ? `artifacts/requests/${entry.owner}`
            : `packages/agent-core/artifacts/requests/${entry.owner}`;
    const result = spawnSync(
        "git",
        ["ls-tree", "-r", "--name-only", entry.commit, "--", requestRoot],
        {
            cwd: repositoryRoot,
            encoding: "utf8"
        }
    );
    if (result.status !== 0) {
        throw new TypeError(`${entry.owner} request source tree is unavailable`);
    }
    const sourceRequests = result.stdout.split("\n").filter(Boolean).sort();
    const importedRequests = entry.artifacts
        .map((artifact) => artifact.source)
        .filter((source) => source === requestRoot || source.startsWith(`${requestRoot}/`))
        .sort();
    if (JSON.stringify(sourceRequests) !== JSON.stringify(importedRequests)) {
        throw new TypeError(
            `${entry.owner} BOM does not import every request file from its supplied head`
        );
    }
}

function inspectCommit(commit) {
    const result = spawnSync("git", ["show", "-s", "--format=%T", commit], {
        cwd: repositoryRoot,
        encoding: "utf8"
    });
    if (result.status !== 0) return undefined;
    return { tree: result.stdout.trim() };
}

function verifyCommitSignature(entry, trustedSigners) {
    const verification = spawnSync("git", ["verify-commit", entry.commit], {
        cwd: repositoryRoot,
        encoding: "utf8"
    });
    const fingerprint = spawnSync("git", ["show", "-s", "--format=%GF", entry.commit], {
        cwd: repositoryRoot,
        encoding: "utf8"
    });
    if (
        verification.status !== 0 ||
        fingerprint.status !== 0 ||
        fingerprint.stdout.trim() !== entry.commitSignature.keyFingerprint ||
        !trustedSigners.has(entry.commitSignature.keyFingerprint)
    ) {
        throw new TypeError(`${entry.owner} commit signature is not trusted`);
    }
}

async function verifySourceArtifact(commit, artifact, destination) {
    const result = spawnSync("git", ["show", `${commit}:${artifact.source}`], {
        cwd: repositoryRoot,
        encoding: null,
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0 || sha256(result.stdout) !== artifact.sourceSha256) {
        throw new TypeError(`BOM source digest differs from ${commit}:${artifact.source}`);
    }
    if (artifact.normalization === "canonical-json-v1") {
        const source = JSON.parse(result.stdout.toString("utf8"));
        const normalized = JSON.parse(await readFile(destination, "utf8"));
        if (JSON.stringify(source) !== JSON.stringify(normalized)) {
            throw new TypeError(
                `Canonical BOM normalization changed semantics: ${artifact.destination}`
            );
        }
    }
}

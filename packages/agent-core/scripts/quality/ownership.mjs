import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
    artifactRoot,
    globMatches,
    readCanonicalJson,
    repositoryRoot,
    sha256,
    writeCanonicalJson,
    reportRoot
} from "./project.mjs";
import { loadValidatedBom } from "./bom.mjs";
import { loadValidatedRequestArchive } from "./request-archive.mjs";

const ownershipPath = resolve(artifactRoot, "quality/ownership.json");
const transitionsRoot = resolve(artifactRoot, "integration/transitions");
const candidateTransitionPath =
    "packages/agent-core/artifacts/integration/transitions/w9-integration-candidate.json";

export async function loadOwnership() {
    const ownership = await readCanonicalJson(ownershipPath);
    return { ownership, patterns: patternsForOwnership(ownership) };
}

export function patternsForOwnership(ownership) {
    const patterns = new Map();
    for (const [owner, ownedPatterns] of Object.entries(ownership.owners)) {
        for (const pattern of ownedPatterns) add(patterns, pattern, owner);
        const fragment = ownership.domainFragments[owner];
        if (fragment !== undefined) {
            for (const template of ownership.fragmentPatterns) {
                add(
                    patterns,
                    template.replaceAll("{owner}", owner).replaceAll("{fragment}", fragment),
                    owner
                );
            }
        }
    }
    return patterns;
}

export function ownersForPath(path, patterns) {
    return [...patterns.entries()]
        .filter(([pattern]) => globMatches(pattern, path))
        .map(([, owner]) => owner);
}

export async function validateOwnershipDiff(owner, base, transitionId) {
    const { patterns } = await loadOwnership();
    const { bom, imports } = await loadValidatedBom("building");
    const paths = changedPaths(base);
    const authorization =
        transitionId === undefined
            ? undefined
            : await loadTransitionAuthorization(transitionId, owner, patterns, paths, base, bom);
    const ownedPaths = paths.filter((path) => !(owner === "W0" && imports.has(path)));
    const violations = validateOwnershipPaths(owner, ownedPaths, patterns, authorization);
    for (const path of paths) {
        const imported = imports.get(path);
        if (owner === "W0" && imported !== undefined) {
            const owners = ownersForPath(path, patterns);
            const closureAuthorized =
                owners.length === 1 &&
                owners[0] === owner &&
                authorization?.allowedForeignOwners.get(path) === owner &&
                authorization.allowedForeignPaths.has(path);
            if ((owners.length !== 1 || owners[0] !== imported.owner) && !closureAuthorized) {
                violations.push({ path, owners, reason: "BOM owner differs from path ownership" });
            }
        }
    }
    const report = { owner, base, transition: transitionId ?? null, paths, violations };
    await writeCanonicalJson(resolve(reportRoot, "ownership.json"), report);
    if (violations.length > 0) {
        throw new TypeError(violations.map((item) => `${item.path}: ${item.reason}`).join("\n"));
    }
    await validateStageTransition(base);
    return report;
}

export function validateOwnershipPaths(owner, paths, patterns, authorization) {
    const violations = [];
    for (const path of paths) {
        const owners = ownersForPath(path, patterns);
        if (owners.length !== 1) {
            violations.push({
                path,
                owners,
                reason: owners.length === 0 ? "unowned" : "overlapping ownership"
            });
        } else if (
            owners[0] !== owner &&
            !(
                authorization?.allowedForeignOwners.get(path) === owners[0] &&
                authorization.allowedForeignPaths.has(path) &&
                (!authorization.deletedPaths?.has(path) ||
                    authorization.allowedForeignDeletions?.has(path))
            )
        ) {
            violations.push({ path, owners, reason: `owned by ${owners[0]}, not ${owner}` });
        }
    }
    return violations;
}

export async function loadTransitionAuthorization(transitionId, owner, patterns, paths, base, bom) {
    const index = await readCanonicalJson(resolve(transitionsRoot, "index.json"));
    const transitions = await Promise.all(
        index.manifests.map((name) => readCanonicalJson(resolve(transitionsRoot, name)))
    );
    const matches = transitions.filter((transition) => transition.id === transitionId);
    if (matches.length !== 1) {
        throw new TypeError(`Unknown coordinated transition ${transitionId}`);
    }
    const transition = matches[0];
    const participants = transition.inputs.map((input) => input.owner);
    if (new Set(participants).size !== participants.length) {
        throw new TypeError(`Coordinated transition ${transitionId} has duplicate participants`);
    }
    if (!participants.includes(owner)) {
        throw new TypeError(`${owner} is not a participant in ${transitionId}`);
    }
    if (!participants.includes(transition.canonicalOwner)) {
        throw new TypeError(`${transitionId} excludes its canonical owner`);
    }
    if (transition.state === "integration-candidate") {
        if (owner !== transition.canonicalOwner) {
            throw new TypeError(`${owner} is not the candidate owner for ${transitionId}`);
        }
        if (paths === undefined || base === undefined) {
            throw new TypeError(`${transitionId} candidate authorization requires its base diff`);
        }
        const baseCommit = git(["rev-parse", `${base}^{commit}`])[0];
        const entries = validateCandidateChangeManifest(transition, paths, patterns, baseCommit);
        validateCandidateWorktreeManifest(transition);
        return {
            id: transition.id,
            canonicalOwner: transition.canonicalOwner,
            participants: new Set(participants),
            allowedForeignPaths: new Set(entries.map((entry) => entry.path)),
            allowedForeignOwners: new Map(entries.map((entry) => [entry.path, entry.owner]))
        };
    }
    if (
        transition.state === "completed" &&
        owner === "W0" &&
        transition.closureManifest !== undefined
    ) {
        if (paths === undefined || base === undefined) {
            throw new TypeError(
                `${transitionId} closure authorization requires its candidate diff`
            );
        }
        const baseCommit = git(["rev-parse", `${base}^{commit}`])[0];
        if (baseCommit === transition.closureManifest.commit) {
            const entries = validateRemediationManifest(transition, patterns);
            return {
                id: transition.id,
                canonicalOwner: transition.canonicalOwner,
                participants: new Set(participants),
                allowedForeignPaths: new Set(entries.map((entry) => entry.path)),
                allowedForeignOwners: new Map(entries.map((entry) => [entry.path, entry.owner]))
            };
        }
        if (baseCommit !== transition.closureManifest.base) {
            throw new TypeError(`${transitionId} closure authorization base is stale`);
        }
        const entries = validateClosureManifest(transition, patterns);
        const allowedForeignDeletions = await validateArchivedRequestDeletions(
            entries,
            patterns,
            bom ?? (await loadValidatedBom("building")).bom,
            transition.closureManifest.commit
        );
        return {
            id: transition.id,
            canonicalOwner: transition.canonicalOwner,
            participants: new Set(participants),
            allowedForeignPaths: new Set(entries.map((entry) => entry.path)),
            allowedForeignOwners: new Map(entries.map((entry) => [entry.path, entry.owner])),
            deletedPaths: new Set(
                entries
                    .filter((entry) => !existsSync(resolve(repositoryRoot, entry.path)))
                    .map((entry) => entry.path)
            ),
            allowedForeignDeletions
        };
    }
    if (!new Set(["ready-for-coordinated-integration", "completed"]).has(transition.state)) {
        throw new TypeError(`Coordinated transition ${transitionId} is not ready`);
    }
    if (
        !Array.isArray(transition.allowedForeignPaths) ||
        transition.allowedForeignPaths.length === 0 ||
        new Set(transition.allowedForeignPaths).size !== transition.allowedForeignPaths.length
    ) {
        throw new TypeError(`${transitionId} lacks exact foreign path authorization`);
    }
    for (const path of transition.allowedForeignPaths) {
        const pathOwners = ownersForPath(path, patterns);
        if (pathOwners.length !== 1 || pathOwners[0] !== transition.canonicalOwner) {
            throw new TypeError(`${transitionId} foreign path is not canonically owned: ${path}`);
        }
    }
    return {
        id: transition.id,
        canonicalOwner: transition.canonicalOwner,
        participants: new Set(participants),
        allowedForeignPaths: new Set(transition.allowedForeignPaths),
        allowedForeignOwners: new Map(
            transition.allowedForeignPaths.map((path) => [path, transition.canonicalOwner])
        )
    };
}

export function candidateManifestSha256(entries) {
    return sha256(JSON.stringify(entries));
}

export function validateClosureManifest(transition, patterns) {
    const manifest = transition.closureManifest;
    if (
        manifest === null ||
        typeof manifest !== "object" ||
        !Array.isArray(manifest.paths) ||
        manifest.base !== transition.completion?.commit ||
        candidateManifestSha256(manifest.paths) !== manifest.sha256
    ) {
        throw new TypeError(`${transition.id} closure manifest is stale`);
    }
    const manifestPaths = manifest.paths.map((entry) => entry?.path);
    if (
        manifest.paths.some(
            (entry) =>
                entry === null ||
                typeof entry !== "object" ||
                typeof entry.path !== "string" ||
                typeof entry.owner !== "string" ||
                typeof entry.sourceBlob !== "string" ||
                typeof entry.candidateBlob !== "string" ||
                !["added", "modified", "deleted"].includes(entry.disposition)
        ) ||
        new Set(manifestPaths).size !== manifestPaths.length ||
        JSON.stringify(manifestPaths) !== JSON.stringify([...manifestPaths].sort()) ||
        JSON.stringify(manifestPaths) !==
            JSON.stringify(changedPathsBetween(manifest.base, manifest.commit))
    ) {
        throw new TypeError(`${transition.id} closure paths differ from the candidate diff`);
    }
    const participants = new Set(transition.inputs.map((input) => input.owner));
    const tree = spawnSync("git", ["show", "-s", "--format=%T", manifest.commit], {
        cwd: repositoryRoot,
        encoding: "utf8"
    });
    if (tree.status !== 0 || tree.stdout.trim() !== manifest.tree) {
        throw new TypeError(`${transition.id} closure commit or tree is unavailable`);
    }
    const sourceBlobs = blobsAtCommit(manifest.base);
    const closureBlobs = blobsAtCommit(manifest.commit);
    for (const entry of manifest.paths) {
        validateCandidateDisposition(transition.id, entry);
        if (entry.sourceBlob !== (sourceBlobs.get(entry.path) ?? "absent")) {
            throw new TypeError(`${transition.id} closure source blob is stale: ${entry.path}`);
        }
        if (entry.candidateBlob !== (closureBlobs.get(entry.path) ?? "deleted")) {
            throw new TypeError(`${transition.id} closure commit blob is stale: ${entry.path}`);
        }
        const owners = ownersForPath(entry.path, patterns);
        if (owners.length !== 1 || owners[0] !== entry.owner || !participants.has(entry.owner)) {
            throw new TypeError(
                `${transition.id} closure path ownership is invalid: ${entry.path}`
            );
        }
    }
    return manifest.paths;
}

export function validateRemediationManifest(transition, patterns) {
    const manifest = transition.remediationManifest;
    const expected = {
        base: "5c288fa5dacf536c3ed3e57d6dadf4ace7d99fd2",
        commit: "3c4f4db6be759a14933addd7819cde4a67f05d71",
        sha256: "5451010d7fc1ddda9541383eed6d904a4b00bfd481b85966d0f7dbc95d074a85"
    };
    if (
        manifest === null ||
        typeof manifest !== "object" ||
        !Array.isArray(manifest.paths) ||
        candidateManifestSha256(manifest.paths) !== manifest.sha256 ||
        manifest.base !== expected.base ||
        manifest.commit !== expected.commit ||
        manifest.sha256 !== expected.sha256
    ) {
        throw new TypeError(`${transition.id} remediation manifest is stale`);
    }
    const manifestPaths = manifest.paths.map((entry) => entry?.path);
    if (
        manifest.paths.some(
            (entry) =>
                entry === null ||
                typeof entry !== "object" ||
                typeof entry.path !== "string" ||
                typeof entry.owner !== "string" ||
                typeof entry.sourceBlob !== "string" ||
                typeof entry.candidateBlob !== "string" ||
                !["added", "modified", "deleted"].includes(entry.disposition)
        ) ||
        new Set(manifestPaths).size !== manifestPaths.length ||
        JSON.stringify(manifestPaths) !== JSON.stringify([...manifestPaths].sort()) ||
        JSON.stringify(manifestPaths) !==
            JSON.stringify(changedPathsBetween(manifest.base, manifest.commit))
    ) {
        throw new TypeError(`${transition.id} remediation paths differ from the exact diff`);
    }
    const tree = spawnSync("git", ["show", "-s", "--format=%T", manifest.commit], {
        cwd: repositoryRoot,
        encoding: "utf8"
    });
    if (tree.status !== 0 || tree.stdout.trim() !== manifest.tree) {
        throw new TypeError(`${transition.id} remediation commit or tree is unavailable`);
    }
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", manifest.commit, "HEAD"], {
        cwd: repositoryRoot
    });
    if (ancestor.status !== 0) {
        throw new TypeError(`${transition.id} remediation commit is not an ancestor of HEAD`);
    }
    const participants = new Set(transition.inputs.map((input) => input.owner));
    const sourceBlobs = blobsAtCommit(manifest.base);
    const candidateBlobs = blobsAtCommit(manifest.commit);
    for (const entry of manifest.paths) {
        validateCandidateDisposition(transition.id, entry);
        if (
            entry.sourceBlob !== (sourceBlobs.get(entry.path) ?? "absent") ||
            entry.candidateBlob !== (candidateBlobs.get(entry.path) ?? "deleted")
        ) {
            throw new TypeError(`${transition.id} remediation blob is stale: ${entry.path}`);
        }
        const owners = ownersForPath(entry.path, patterns);
        if (owners.length !== 1 || owners[0] !== entry.owner || !participants.has(entry.owner)) {
            throw new TypeError(
                `${transition.id} remediation path ownership is invalid: ${entry.path}`
            );
        }
    }
    return manifest.paths;
}

export async function validateArchivedRequestDeletions(entries, patterns, bom, closureCommit) {
    const archive = await loadValidatedRequestArchive();
    const deleted = entries
        .filter((entry) => entry.disposition === "deleted")
        .map((entry) => entry.path)
        .sort();
    const expected = archive.entries.map((entry) => entry.source).sort();
    if (JSON.stringify(deleted) !== JSON.stringify(expected)) {
        throw new TypeError("Closure foreign deletions differ from the exact request archive");
    }
    const bomArtifacts = bom.entries.flatMap((entry) =>
        entry.artifacts.map((artifact) => ({ owner: entry.owner, ...artifact }))
    );
    const closureBlobs = blobsAtCommit(closureCommit);
    for (const archived of archive.entries) {
        const sourceOwners = ownersForPath(archived.source, patterns);
        const archiveOwners = ownersForPath(archived.path, patterns);
        const matches = bomArtifacts.filter(
            (artifact) =>
                artifact.owner === archived.owner &&
                artifact.source === archived.source &&
                artifact.sourceSha256 === archived.sourceSha256 &&
                artifact.destination === archived.path &&
                artifact.sha256 === archived.sha256
        );
        if (
            sourceOwners.length !== 1 ||
            sourceOwners[0] !== archived.owner ||
            archiveOwners.length !== 1 ||
            archiveOwners[0] !== archived.owner ||
            matches.length !== 1 ||
            closureBlobs.has(archived.source) ||
            closureBlobs.get(archived.path) === undefined ||
            (await fileSha256AtCommit(closureCommit, archived.path)) !== archived.sha256
        ) {
            throw new TypeError(`Archived request deletion proof is invalid: ${archived.source}`);
        }
    }
    return new Set(expected);
}

async function fileSha256AtCommit(commit, path) {
    const result = spawnSync("git", ["show", `${commit}:${path}`], {
        cwd: repositoryRoot,
        encoding: null,
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0) throw new TypeError(`Git blob is unavailable: ${commit}:${path}`);
    return sha256(result.stdout);
}

export function validateCandidateChangeManifest(transition, paths, patterns, base) {
    const manifest = transition.changeManifest;
    if (
        manifest === null ||
        typeof manifest !== "object" ||
        !Array.isArray(manifest.paths) ||
        typeof manifest.sha256 !== "string"
    ) {
        throw new TypeError(`${transition.id} lacks an exact candidate change manifest`);
    }
    if (manifest.base !== base) {
        throw new TypeError(`${transition.id} candidate base is stale`);
    }
    const entries = manifest.paths.map((entry) => {
        if (
            entry === null ||
            typeof entry !== "object" ||
            typeof entry.path !== "string" ||
            typeof entry.owner !== "string" ||
            typeof entry.sourceBlob !== "string" ||
            typeof entry.candidateBlob !== "string" ||
            !["added", "modified", "deleted"].includes(entry.disposition)
        ) {
            throw new TypeError(`${transition.id} candidate path binding is malformed`);
        }
        return entry;
    });
    const manifestPaths = entries.map((entry) => entry.path);
    const sortedPaths = [...manifestPaths].sort();
    if (
        entries.length === 0 ||
        new Set(manifestPaths).size !== manifestPaths.length ||
        JSON.stringify(manifestPaths) !== JSON.stringify(sortedPaths)
    ) {
        throw new TypeError(`${transition.id} candidate paths are not exact and sorted`);
    }
    if (candidateManifestSha256(entries) !== manifest.sha256) {
        throw new TypeError(`${transition.id} candidate manifest digest is stale`);
    }
    if (JSON.stringify(manifestPaths) !== JSON.stringify([...paths].sort())) {
        throw new TypeError(`${transition.id} candidate paths differ from the base diff`);
    }
    const participants = new Set(transition.inputs.map((input) => input.owner));
    const sourceBlobs = blobsAtCommit(base);
    for (const entry of entries) {
        validateCandidateDisposition(transition.id, entry);
        const sourceBlob = sourceBlobs.get(entry.path) ?? "absent";
        if (entry.sourceBlob !== sourceBlob) {
            throw new TypeError(`${transition.id} candidate source blob is stale: ${entry.path}`);
        }
        const owners = ownersForPath(entry.path, patterns);
        if (owners.length !== 1) {
            throw new TypeError(
                `${transition.id} candidate path must have one canonical owner: ${entry.path}`
            );
        }
        if (entry.owner !== owners[0]) {
            throw new TypeError(`${transition.id} candidate path has wrong owner: ${entry.path}`);
        }
        if (!participants.has(entry.owner)) {
            throw new TypeError(
                `${transition.id} candidate path owner is not a participant: ${entry.owner}`
            );
        }
    }
    return entries;
}

export function validateCompletedCandidateManifest(transition, patterns) {
    if (transition.completion === null || transition.completion === undefined) {
        throw new TypeError(`${transition.id} completed candidate lacks completion evidence`);
    }
    const paths = changedPathsBetween(transition.changeManifest.base, transition.completion.commit);
    const entries = validateCandidateChangeManifest(
        transition,
        paths,
        patterns,
        transition.changeManifest.base
    );
    const candidateBlobs = blobsAtCommit(transition.completion.commit);
    for (const entry of entries) {
        const candidateBlob = candidateBlobs.get(entry.path) ?? "deleted";
        if (entry.candidateBlob !== candidateBlob) {
            throw new TypeError(
                `${transition.id} candidate completion blob is stale: ${entry.path}`
            );
        }
    }
    return entries;
}

export function validateCandidateWorktreeManifest(transition) {
    const paths = transition.changeManifest.paths
        .map((entry) => entry.path)
        .filter((path) => path !== candidateTransitionPath);
    const existingPaths = paths.filter((path) => existsSync(resolve(repositoryRoot, path)));
    const result = spawnSync("git", ["hash-object", "--no-filters", "--", ...existingPaths], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0) {
        throw new TypeError("Candidate worktree blobs are unavailable");
    }
    const hashes = result.stdout.split("\n").filter(Boolean);
    if (hashes.length !== existingPaths.length) {
        throw new TypeError("Candidate worktree blob denominator changed while hashing");
    }
    const worktreeBlobs = new Map(existingPaths.map((path, index) => [path, hashes[index]]));
    const indexBlobs = new Map(
        paths.map((path) => {
            const indexed = spawnSync("git", ["rev-parse", `:${path}`], {
                cwd: repositoryRoot,
                encoding: "utf8"
            });
            return [path, indexed.status === 0 ? indexed.stdout.trim() : "deleted"];
        })
    );
    for (const entry of transition.changeManifest.paths) {
        if (entry.path === candidateTransitionPath) continue;
        const worktreeBlob = worktreeBlobs.get(entry.path) ?? "deleted";
        const indexBlob = indexBlobs.get(entry.path) ?? "deleted";
        if (entry.candidateBlob !== indexBlob || worktreeBlob !== indexBlob) {
            throw new TypeError(
                `${transition.id} candidate index or worktree blob is stale: ${entry.path}`
            );
        }
    }
}

function blobsAtCommit(commit) {
    const result = spawnSync("git", ["ls-tree", "-r", commit], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0) throw new TypeError(`Git tree is unavailable: ${commit}`);
    const entries = result.stdout.split("\n").filter(Boolean);
    const blobs = new Map();
    for (const line of entries) {
        const match = /^\d+ blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
        if (match !== null) blobs.set(match[2], match[1]);
    }
    return blobs;
}

export async function deriveOwner(base) {
    const { patterns } = await loadOwnership();
    const { imports } = await loadValidatedBom("building");
    const paths = changedPaths(base);
    const owners = new Set();
    for (const path of paths) {
        const imported = imports.get(path);
        if (imported !== undefined) {
            const matches = ownersForPath(path, patterns);
            if (matches.length !== 1 || matches[0] !== imported.owner) {
                throw new TypeError(`${path}: invalid BOM-attested ownership import`);
            }
            owners.add("W0");
            continue;
        }
        const matches = ownersForPath(path, patterns);
        if (matches.length !== 1) {
            throw new TypeError(
                `${path}: expected exactly one owner, found ${matches.join(", ") || "none"}`
            );
        }
        owners.add(matches[0]);
    }
    if (owners.size > 1) {
        throw new TypeError(
            `Change set crosses exclusive owners: ${[...owners].sort().join(", ")}`
        );
    }
    return [...owners][0];
}

export async function validateCompleteOwnership() {
    const { patterns } = await loadOwnership();
    const paths = [
        ...new Set([...git(["ls-files"]), ...git(["ls-files", "--others", "--exclude-standard"])])
    ].sort();
    const violations = paths.flatMap((path) => {
        const owners = ownersForPath(path, patterns);
        return owners.length === 1 ? [] : [{ path, owners }];
    });
    if (violations.length > 0) {
        throw new TypeError(
            violations
                .map(
                    (item) =>
                        `${item.path}: expected one owner, found ${item.owners.join(", ") || "none"}`
                )
                .join("\n")
        );
    }
    return paths.length;
}

export async function validateStageTransition(base) {
    const current = await readCanonicalJson(resolve(artifactRoot, "conformance/stage.json"));
    const previous = spawnSync(
        "git",
        ["show", `${base}:packages/agent-core/artifacts/conformance/stage.json`],
        { cwd: repositoryRoot, encoding: "utf8" }
    );
    if (previous.status !== 0) return;
    const priorStage = JSON.parse(previous.stdout).stage;
    if (priorStage === "final" && current.stage !== "final") {
        throw new TypeError("Conformance stage cannot move from final back to building");
    }
}

export function changedPaths(base) {
    const working = git(["diff", "--no-renames", "--name-only", base]);
    const staged = git(["diff", "--cached", "--no-renames", "--name-only", base]);
    const untracked = git(["ls-files", "--others", "--exclude-standard"]);
    return [...new Set([...working, ...staged, ...untracked].filter(Boolean))].sort();
}

export function changedPathsBetween(base, candidate) {
    return git(["diff", "--no-renames", "--name-only", base, candidate]).sort();
}

function validateCandidateDisposition(id, entry) {
    const expected =
        entry.sourceBlob === "absent"
            ? "added"
            : entry.candidateBlob === "deleted"
              ? "deleted"
              : "modified";
    if (
        (entry.sourceBlob === "absent" && entry.candidateBlob === "deleted") ||
        entry.disposition !== expected
    ) {
        throw new TypeError(`${id} candidate transformation is inconsistent: ${entry.path}`);
    }
}

function git(args) {
    const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.split("\n").filter(Boolean);
}

function add(patterns, pattern, owner) {
    const previous = patterns.get(pattern);
    if (previous !== undefined && previous !== owner) {
        throw new TypeError(`Ownership pattern ${pattern} is assigned to ${previous} and ${owner}`);
    }
    patterns.set(pattern, owner);
}

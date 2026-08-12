import { spawnSync } from "node:child_process";
import { repositoryRoot, sha256 } from "./project.mjs";

// A completion-shaped record ({commit, tree, artifacts}) is the immutable history of
// one ratified state. Every pinned blob must exist with its exact digest, and whenever
// the recorded commit still resolves, each pin must equal what that commit actually
// contained — a pin that disagrees with its own ratification commit is a rewritten
// record, not drift. Returns whether the ratification commit resolved, so callers can
// account for records whose lineage the published snapshot squashed away.
export function verifyCompletionArtifacts(label, completion, root = repositoryRoot) {
    const paths = completion.artifacts.map((artifact) => artifact.path);
    if (new Set(paths).size !== paths.length) {
        throw new TypeError(`${label} completion artifacts are duplicated`);
    }
    const ratified =
        spawnSync("git", ["cat-file", "-e", `${completion.commit}^{commit}`], { cwd: root })
            .status === 0;
    if (ratified) {
        const tree = spawnSync("git", ["show", "-s", "--format=%T", completion.commit], {
            cwd: root,
            encoding: "utf8"
        });
        if (tree.status !== 0 || tree.stdout.trim() !== completion.tree) {
            throw new TypeError(`${label} tree differs from its ratification commit`);
        }
    }
    for (const artifact of completion.artifacts) {
        const result = spawnSync("git", ["cat-file", "blob", artifact.blob], {
            cwd: root,
            encoding: null,
            maxBuffer: 16 * 1024 * 1024
        });
        if (result.status !== 0) {
            throw new TypeError(
                `${label} completion artifact blob is unavailable: ${artifact.path}`
            );
        }
        if (sha256(result.stdout) !== artifact.sha256) {
            throw new TypeError(`${label} completion artifact digest is stale: ${artifact.path}`);
        }
        if (ratified) {
            const pinned = spawnSync(
                "git",
                ["rev-parse", `${completion.commit}:${artifact.path}`],
                { cwd: root, encoding: "utf8" }
            );
            if (pinned.status !== 0 || pinned.stdout.trim() !== artifact.blob) {
                throw new TypeError(
                    `${label} artifact pin differs from its ratification commit: ${artifact.path}`
                );
            }
        }
    }
    return ratified;
}

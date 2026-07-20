import { spawnSync } from "node:child_process";
import { repositoryRoot, sha256 } from "./project.mjs";

export function verifyCompletionArtifacts(label, completion, root = repositoryRoot) {
    const paths = completion.artifacts.map((artifact) => artifact.path);
    if (new Set(paths).size !== paths.length) {
        throw new TypeError(`${label} completion artifacts are duplicated`);
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
    }
}

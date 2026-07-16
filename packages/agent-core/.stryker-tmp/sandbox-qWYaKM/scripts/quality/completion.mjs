// @ts-nocheck
import { spawnSync } from "node:child_process";
import { repositoryRoot, sha256 } from "./project.mjs";

export function verifyCompletion(label, completion, root = repositoryRoot) {
    const tree = spawnSync("git", ["show", "-s", "--format=%T", completion.commit], {
        cwd: root,
        encoding: "utf8"
    });
    if (tree.status !== 0 || tree.stdout.trim() !== completion.tree) {
        throw new TypeError(`${label} completion commit or tree is unavailable`);
    }
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", completion.commit, "HEAD"], {
        cwd: root
    });
    if (ancestor.status !== 0) {
        throw new TypeError(`${label} completion commit is not an ancestor of HEAD`);
    }
    const paths = completion.artifacts.map((artifact) => artifact.path);
    if (new Set(paths).size !== paths.length) {
        throw new TypeError(`${label} completion artifacts are duplicated`);
    }
    for (const artifact of completion.artifacts) {
        const blob = spawnSync("git", ["rev-parse", `${completion.commit}:${artifact.path}`], {
            cwd: root,
            encoding: "utf8"
        });
        const result = spawnSync("git", ["show", `${completion.commit}:${artifact.path}`], {
            cwd: root,
            encoding: null,
            maxBuffer: 16 * 1024 * 1024
        });
        if (
            blob.status !== 0 ||
            blob.stdout.trim() !== artifact.blob ||
            result.status !== 0 ||
            sha256(result.stdout) !== artifact.sha256
        ) {
            throw new TypeError(`${label} completion artifact is stale: ${artifact.path}`);
        }
    }
}

// @ts-nocheck
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { collectFiles, repositoryRoot } from "./project.mjs";

export const cloudflareRoot = resolve(repositoryRoot, "packages/agent-core-cloudflare");

export async function hasCloudflareSource() {
    return (
        (
            await collectFiles(
                resolve(cloudflareRoot, "src"),
                (path) => /\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path)
            )
        ).length > 0
    );
}

export async function cloudflareTestLanes() {
    const lanes = [
        { id: "structural", config: "test/vitest.config.mjs", coverage: true },
        { id: "workers", config: "test/cloudflare/vitest.config.ts", coverage: false }
    ];
    for (const lane of lanes) {
        try {
            await access(resolve(cloudflareRoot, lane.config));
        } catch (error) {
            if (error?.code === "ENOENT") {
                throw new TypeError(`Cloudflare source requires ${lane.config}`);
            }
            throw error;
        }
    }
    return lanes;
}

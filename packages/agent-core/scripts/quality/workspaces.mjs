import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { collectFiles, repositoryRoot } from "./project.mjs";

/**
 * Adjunct workspace packages: everything the quality DAG gates besides the kernel.
 * A package listed here is linted, typechecked, tested, and attested exactly like the
 * others; this registry is the single place that knows one exists.
 */
const registry = Object.freeze([
    Object.freeze({
        id: "cloudflare",
        directory: "packages/agent-core-cloudflare",
        typeProjects: Object.freeze([
            "tsconfig.json",
            "test/tsconfig.json",
            "test/cloudflare/tsconfig.json"
        ]),
        consumerCheck: "scripts/check-consumer.mjs",
        wranglerTypes: Object.freeze({
            declaration: "test/cloudflare/worker-configuration.d.ts",
            config: "wrangler.test.jsonc"
        }),
        testLanes: Object.freeze([
            Object.freeze({ id: "structural", config: "test/vitest.config.mjs", coverage: true }),
            Object.freeze({
                id: "workers",
                config: "test/cloudflare/vitest.config.ts",
                coverage: false
            })
        ])
    }),
    Object.freeze({
        id: "harness",
        directory: "packages/agent-core-harness",
        typeProjects: Object.freeze(["tsconfig.json", "test/tsconfig.json"]),
        consumerCheck: "scripts/check-consumer.mjs",
        testLanes: Object.freeze([
            Object.freeze({ id: "structural", config: "test/vitest.config.mjs", coverage: true })
        ])
    })
]);

export function adjunctPackageRoot(workspace) {
    return resolve(repositoryRoot, workspace.directory);
}

export function adjunctReportRoot(workspace) {
    return resolve(adjunctPackageRoot(workspace), "reports/quality");
}

async function hasSource(workspace) {
    const files = await collectFiles(
        resolve(adjunctPackageRoot(workspace), "src"),
        (path) => /\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path)
    );
    return files.length > 0;
}

/** Every adjunct package, whether or not it currently carries source. */
export function adjunctPackages() {
    return registry;
}

/** The adjunct packages that currently carry source, in registry order. */
export async function activeAdjunctPackages() {
    const active = [];
    for (const workspace of registry) {
        if (await hasSource(workspace)) active.push(workspace);
    }
    return active;
}

export function adjunctLintPaths(workspace) {
    return ["src", "test", "scripts"].map((segment) => `${workspace.directory}/${segment}`);
}

/**
 * A package that ships source must ship every test lane the registry declares for it,
 * so a lane cannot be silently dropped to make the gate pass.
 */
export async function adjunctTestLanes(workspace) {
    const root = adjunctPackageRoot(workspace);
    for (const lane of workspace.testLanes) {
        try {
            await access(resolve(root, lane.config));
        } catch (error) {
            if (error?.code === "ENOENT") {
                throw new TypeError(`${workspace.directory} source requires ${lane.config}`);
            }
            throw error;
        }
    }
    return workspace.testLanes;
}

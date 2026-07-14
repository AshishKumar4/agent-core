import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = resolve(packageRoot, "../..");
const archiveRoot = resolve(packageRoot, "artifacts/integration/request-archive");

describe("request outcome reconciliation", () => {
    test("supersedes W1 and W2 detached Vitest configs with aggregate exact-source coverage", () => {
        const w1 = readFileSync(resolve(archiveRoot, "W1/vitest.config.mjs"), "utf8");
        const w2 = readFileSync(resolve(archiveRoot, "W2/vitest.config.mjs"), "utf8");
        const integrated = readFileSync(resolve(packageRoot, "vitest.config.mjs"), "utf8");
        for (const config of [w1, w2, integrated]) {
            expect(config).toContain('provider: "v8"');
            expect(config).toContain("all: true");
        }
        expect(w1).toContain("exclude: []");
        expect(integrated).toContain('include: ["src/**/*.ts"]');
    });

    test("subsumes W2, W5, and W6 detached coverage evidence under owner-complete global coverage", () => {
        const policy = json("artifacts/quality/policy.json") as {
            coverage: { threshold: number; sourceUniverses: Array<{ id: string }> };
        };
        const w2 = JSON.parse(
            readFileSync(resolve(archiveRoot, "W2/coverage-manifest.json"), "utf8")
        ) as { sourceFiles: string[]; testFiles: string[] };
        const w5 = JSON.parse(readFileSync(resolve(archiveRoot, "W5/coverage.json"), "utf8")) as {
            minimumPercent: number;
            metrics: Record<string, { covered: number; total: number }>;
        };
        const w6 = readFileSync(resolve(archiveRoot, "W6/coverage.md"), "utf8");
        expect(policy.coverage.threshold).toBe(95);
        expect(policy.coverage.sourceUniverses.map(({ id }) => id)).toEqual(["node", "cloudflare"]);
        expect(w2.sourceFiles.length).toBeGreaterThan(30);
        expect(w2.testFiles.length).toBeGreaterThan(10);
        expect(
            Object.values(w5.metrics).every(
                ({ covered, total }) => covered * 100 >= w5.minimumPercent * total
            )
        ).toBe(true);
        expect(w6).toContain("covered * 100 >= 95 * total");
    });

    test("keeps interceptor public export closed until exact Turn-bound context exists", () => {
        const packageJson = json("package.json") as { exports: Record<string, unknown> };
        const exportsRegistry = json("artifacts/quality/exports.json") as {
            runtime: Record<string, string[]>;
            declarations: Record<string, string[]>;
        };
        expect(Object.keys(packageJson.exports)).not.toContain("./interceptors");
        expect(
            Object.values(exportsRegistry.runtime)
                .flat()
                .some((name) => name === "InterceptorContext")
        ).toBe(false);
        expect(
            Object.values(exportsRegistry.declarations)
                .flat()
                .some((name) => name === "InterceptorContext")
        ).toBe(false);
    });

    test("normalizes W8 package scripts into aggregate lanes while retaining exact dependencies", () => {
        const request = JSON.parse(
            readFileSync(resolve(archiveRoot, "W8/shared-integration.json"), "utf8")
        ) as {
            requests: Array<{
                id: string;
                exactDependencies?: Record<string, Record<string, string>>;
            }>;
        };
        const dependencyRequest = request.requests.find(({ id }) => id === "W8-W0-DEPENDENCIES");
        const packageJson = JSON.parse(
            readFileSync(
                resolve(repositoryRoot, "packages/agent-core-cloudflare/package.json"),
                "utf8"
            )
        ) as {
            dependencies: Record<string, string>;
            devDependencies: Record<string, string>;
            scripts: Record<string, string>;
        };
        expect(dependencyRequest?.exactDependencies).toEqual({
            dependencies: packageJson.dependencies,
            devDependencies: packageJson.devDependencies
        });
        expect(packageJson.scripts).toEqual(
            expect.objectContaining({
                build: expect.any(String),
                "check:cloudflare-types": expect.any(String),
                "check:coverage": expect.any(String),
                "check:consumer": expect.any(String),
                "check:exports": expect.any(String),
                "check:types": expect.any(String),
                lint: expect.any(String),
                test: expect.any(String),
                "test:structural": expect.any(String),
                "test:cloudflare": expect.any(String)
            })
        );
    });
});

function json(path: string): unknown {
    return JSON.parse(readFileSync(resolve(packageRoot, path), "utf8"));
}

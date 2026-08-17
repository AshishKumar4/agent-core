import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
    type QualitySubprocessResult,
    runQualitySubprocess,
    subprocessTestOptions
} from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/supply-chain.mjs");
const temporary: string[] = [];

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const CLEAN_WORKFLOW = [
    "name: verify",
    "jobs:",
    "  verify:",
    "    steps:",
    `      - uses: actions/checkout@${SHA}`,
    "      - run: pnpm install --frozen-lockfile"
].join("\n");

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe("supply-chain gate", subprocessTestOptions, () => {
    test("accepts a workspace whose install can run no unreviewed code", async () => {
        const result = run(await createFixture({}));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("supply-chain complete: 0 issue(s)");
    });

    // The finding this gate was built for: inheriting the package manager's default leaves
    // the policy undeclared, so nothing records the day it changes.
    test("rejects an undeclared build allowlist", async () => {
        const result = run(
            await createFixture({ "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n' })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("no build allowlist is declared");
    });

    test("names each dependency permitted to run install scripts", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml": "packages: []\nonlyBuiltDependencies:\n  - evil\n"
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("evil may run install scripts");
    });

    // pnpm 11 renamed the setting; an upgrade must not carry an allowlist past the gate.
    test("reads the allowlist under its later name too", async () => {
        const result = run(
            await createFixture({ "pnpm-workspace.yaml": "packages: []\nallowBuilds:\n  - evil\n" })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("evil may run install scripts");
    });

    test("rejects a blanket permission to build", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml":
                    "packages: []\nonlyBuiltDependencies: []\ndangerouslyAllowAllBuilds: true\n"
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("permits every dependency to execute");
    });

    test("rejects an npmrc that re-enables dependency scripts", async () => {
        const result = run(await createFixture({ ".npmrc": "ignore-scripts=false\n" }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("re-enables dependency lifecycle scripts");
    });

    test("rejects an npmrc carrying its own allowlist", async () => {
        const result = run(await createFixture({ ".npmrc": "onlyBuiltDependencies=evil\n" }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("outside the workspace policy");
    });

    // A manifest block and the workspace file are two places that can permit a build; the
    // gate refuses the second source of truth rather than reconciling them.
    test("rejects a manifest-level allowlist even when the workspace file is clean", async () => {
        const fixture = await createFixture({});
        await mkdir(resolve(fixture, "packages/one"), { recursive: true });
        await writeFile(
            resolve(fixture, "packages/one/package.json"),
            JSON.stringify({ name: "one", pnpm: { onlyBuiltDependencies: ["evil"] } }, null, 2),
            "utf8"
        );
        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("second source of truth");
    });

    test("rejects a package manager that is not an exact version", async () => {
        const result = run(await createFixture({ "package.json": manifest("pnpm@^10.13.1") }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("is not an exact version");
    });

    test("rejects a workspace with no committed lockfile", async () => {
        const fixture = await createFixture({});
        await rm(resolve(fixture, "pnpm-lock.yaml"));
        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("no committed lockfile");
    });

    // A tag is a mutable pointer: the action reviewed at `@v4` is not what runs at `@v4` later.
    test("rejects an action pinned to a tag rather than a commit", async () => {
        const result = run(
            await createFixture({
                ".github/workflows/verify.yml": CLEAN_WORKFLOW.replace(`@${SHA}`, "@v4")
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("mutable reference rather than a commit sha");
    });

    test("rejects an install that is not frozen to the lockfile", async () => {
        const result = run(
            await createFixture({
                ".github/workflows/verify.yml": CLEAN_WORKFLOW.replace(" --frozen-lockfile", "")
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("without --frozen-lockfile");
    });

    test("rejects a downloaded release artifact with no digest check", async () => {
        const result = run(
            await createFixture({
                ".github/workflows/verify.yml": `${CLEAN_WORKFLOW}\n      - run: curl -fL https://example.test/tool.tar.gz -o tool.tar.gz\n`
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("without checking it against a digest");
    });

    test("accepts a download the workflow verifies against a digest", async () => {
        const result = run(
            await createFixture({
                ".github/workflows/verify.yml": `${CLEAN_WORKFLOW}\n      - run: |\n          curl -fL https://example.test/tool.tar.gz -o tool.tar.gz\n          echo 'abc  tool.tar.gz' | sha256sum -c -\n`
            })
        );
        expect(result.status, result.stderr).toBe(0);
    });

    test("rejects a runtime pinned to a range", async () => {
        const result = run(await createFixture({ ".node-version": "22\n" }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("is not an exact version");
    });

    test("rejects a missing runtime pin", async () => {
        const fixture = await createFixture({});
        await rm(resolve(fixture, ".bun-version"));
        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(".bun-version is absent");
    });

    // A pattern the gate cannot enumerate would silently leave every package unchecked, so
    // it fails instead of reporting a clean empty universe.
    test("refuses a workspace pattern it cannot enumerate", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml":
                    'packages:\n  - "packages/**/nested"\nonlyBuiltDependencies: []\n'
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Unsupported workspace pattern");
    });
});

function manifest(packageManager: string): string {
    return `${JSON.stringify({ name: "fixture", private: true, packageManager }, null, 2)}\n`;
}

async function createFixture(overrides: Record<string, string>): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-supply-chain-"));
    temporary.push(root);
    const files = {
        "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\nonlyBuiltDependencies: []\n',
        "package.json": manifest("pnpm@10.13.1"),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        ".node-version": "22.22.3\n",
        ".bun-version": "1.3.12\n",
        ".github/workflows/verify.yml": CLEAN_WORKFLOW,
        ...overrides
    };
    for (const [path, source] of Object.entries(files)) {
        const target = resolve(root, path);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, source, "utf8");
    }
    return root;
}

function run(root: string): QualitySubprocessResult {
    return runQualitySubprocess(
        process.execPath,
        [checker, "--stage", "final", "--root", root],
        packageRoot
    );
}

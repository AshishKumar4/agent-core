import { dirname, resolve } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/check-import-boundaries.mjs");
const temporary: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe("cross-context import enforcement", subprocessTestOptions, () => {
    test("accepts type-only cycles through context barrels", async () => {
        const root = await fixture({
            "src/alpha/index.ts":
                "import type { Beta } from '../beta'; export interface Alpha { beta: Beta }\n",
            "src/beta/index.ts":
                "import type { Alpha } from '../alpha'; export interface Beta { alpha: Alpha }\n"
        });
        expect(run(root).status).toBe(0);
    });

    test("accepts composition imports through explicit internal barrels", async () => {
        const root = await fixture({
            "src/composition/index.ts":
                "import { value } from '../operations/internal'; export const composed = value;\n",
            "src/operations/index.ts": "export interface OperationContract {}\n",
            "src/operations/internal.ts": "export const value = 1;\n"
        });
        expect(run(root).status).toBe(0);
    });

    test("rejects deep imports and runtime context cycles", async () => {
        let root = await fixture({
            "src/alpha/index.ts": "export const alpha = 1;\n",
            "src/alpha/use.ts": "import { value } from '../beta/internal'; void value;\n",
            "src/beta/index.ts": "export { value } from './internal';\n",
            "src/beta/internal.ts": "export const value = 1;\n"
        });
        expect(output(run(root))).toContain("cross-context-import");

        root = await fixture({
            "src/alpha/index.ts": "import { beta } from '../beta'; export const alpha = beta;\n",
            "src/beta/index.ts": "import { alpha } from '../alpha'; export const beta = alpha;\n"
        });
        expect(output(run(root))).toContain("runtime-import-cycle");
    });

    test("rejects nonliteral module loading", async () => {
        const root = await fixture({
            "src/alpha/index.ts":
                "const target = '../beta'; export const loaded = import(target);\n",
            "src/beta/index.ts": "export const beta = 1;\n"
        });
        expect(output(run(root))).toContain("unverifiable-module-reference");
    });
});

async function fixture(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-imports-"));
    temporary.push(root);
    for (const [path, source] of Object.entries(files)) {
        const target = resolve(root, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, source, "utf8");
    }
    const baseline = resolve(root, "artifacts/import-boundaries.json");
    await mkdir(dirname(baseline), { recursive: true });
    await writeFile(baseline, '{\n  "version": 1,\n  "grandfatheredViolations": []\n}\n', "utf8");
    return root;
}

function run(root: string): ReturnType<typeof runQualitySubprocess> {
    return runQualitySubprocess(
        process.execPath,
        [checker, "--root", root, "--baseline", resolve(root, "artifacts/import-boundaries.json")],
        packageRoot
    );
}

function output(result: ReturnType<typeof runQualitySubprocess>): string {
    expect(result.status).toBe(1);
    return `${result.stdout}${result.stderr}`;
}

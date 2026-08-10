import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");

describe("integrated W4 coverage gate", () => {
    test(
        "generates fresh reports and verifies the locked raw manifest",
        { tags: "p2", timeout: 120_000 },
        () => {
            const result = spawnSync(
                process.execPath,
                [resolve(packageRoot, "artifacts/quality/check-w4-coverage.mjs")],
                { cwd: packageRoot, encoding: "utf8" }
            );
            expect(result.status).toBe(0);
            expect(result.stdout).toContain("Integrated W4 coverage verified");
        }
    );
});

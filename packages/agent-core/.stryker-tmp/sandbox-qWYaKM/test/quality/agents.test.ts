// @ts-nocheck
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { requireCitedText } from "../../scripts/quality/citations.mjs";
import { requireSuccessfulTestReport } from "../../scripts/quality/evidence.mjs";

describe("AGENTS instruction provenance", () => {
    test("binds a citation to the expected instruction text", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "agent-core-citation-"));
        try {
            await writeFile(
                resolve(root, "AGENTS.md"),
                "first\nRuntime failures use typed errors\n",
                "utf8"
            );
            await expect(
                requireCitedText(["AGENTS.md:2"], "typed errors", "ACQ-ERR", root)
            ).resolves.toBeUndefined();
            await expect(
                requireCitedText(["AGENTS.md:1"], "typed errors", "ACQ-ERR", root)
            ).rejects.toThrow(/do not contain/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("rejects a successful report whose tests were all skipped", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "agent-core-report-"));
        try {
            const path = resolve(root, "vitest.json");
            await writeFile(
                path,
                JSON.stringify({
                    success: true,
                    numTotalTests: 2,
                    numPassedTests: 0,
                    numFailedTests: 0,
                    numPendingTests: 2,
                    numTodoTests: 0,
                    testResults: []
                }),
                "utf8"
            );
            await expect(requireSuccessfulTestReport(path)).rejects.toThrow(/not completely/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

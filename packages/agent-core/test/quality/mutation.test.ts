import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { runQualitySubprocess } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/mutation.mjs");

function gateFixture(stage: "building" | "final", areas: Record<string, unknown>): string[] {
    const directory = mkdtempSync(join(tmpdir(), "mutation-gate-"));
    const baseline = join(directory, "baseline.json");
    const stageArtifact = join(directory, "stage.json");
    writeFileSync(baseline, JSON.stringify({ edition: "1.0.0", areas }));
    writeFileSync(stageArtifact, JSON.stringify({ edition: "1.0.0", stage }));
    return ["--gate", "--baseline", baseline, "--stage-artifact", stageArtifact];
}

const staleArea = {
    measuredAt: "0".repeat(40),
    mutants: 10,
    killed: 10,
    score: 100,
    actionable: 0,
    tolerated: 0,
    fingerprint: "sha256:stale"
};

describe("mutation adequacy gate", () => {
    test("rejects stale fingerprints at every stage", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, ...gateFixture("building", { authority: staleArea })],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Mutation gate failed");
        expect(result.stderr).toContain("authority: missing or stale mutation fingerprint");
    });

    test("reports unmeasured areas and survivors as notes while building, failures at final", () => {
        const building = runQualitySubprocess(
            process.execPath,
            [checker, ...gateFixture("building", {})],
            packageRoot
        );
        expect(building.status).toBe(0);
        expect(building.stdout).toContain("note: unmeasured areas:");

        const final = runQualitySubprocess(
            process.execPath,
            [checker, ...gateFixture("final", {})],
            packageRoot
        );
        expect(final.status).toBe(1);
        expect(final.stderr).toContain("unmeasured areas:");
    });

    test("rejects a baseline area outside the source universe", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, ...gateFixture("building", { phantom: staleArea })],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("phantom: baseline records a nonexistent source area");
    });

    test("rejects an area outside the exact source universe before running Stryker", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, "--area", "../outside"],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Unknown source area");
        expect(result.stderr).not.toContain("Stryker");
    });
});

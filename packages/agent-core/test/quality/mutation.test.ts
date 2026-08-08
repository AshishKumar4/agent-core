import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
    mutationFingerprint,
    mutationTestFiles,
    sourceAreas
} from "../../scripts/quality/mutation-inputs.mjs";
import { runQualitySubprocess } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/mutation.mjs");

function portable(path: string): string {
    return relative(packageRoot, path).replaceAll("\\", "/");
}

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

// A fingerprint that covers more than a run can read stales every area for a result that
// cannot have moved, which is how a ratchet stops being run. Both directions are pinned:
// the lanes the mutation vitest config excludes never execute, so they must not be
// hashed; the lanes it runs decide the result, so they must be.
describe("mutation staleness inputs", () => {
    const hashed = new Set(mutationTestFiles().map(portable));

    test("omits every lane the mutation run excludes", () => {
        const excludedLanes = [
            "test/quality/mutation.test.ts",
            "test/quality/subprocess.ts",
            "test/differential/policy.differential.test.ts",
            "test/differential/oracle.ts",
            "test/integration/stress/lease-fencing.test.ts",
            "test/core/error-taxonomy.test.ts",
            "test/definition/coverage-gate.test.ts"
        ];

        for (const path of excludedLanes) {
            expect(existsSync(resolve(packageRoot, path)), `${path} no longer exists`).toBe(true);
            expect(hashed.has(path), `${path} must not stale a mutation area`).toBe(false);
        }
    });

    test("covers the behavior lanes a mutation run executes", () => {
        const executedLanes = [
            "test/actors/actor.test.ts",
            "test/authority/hard-gates.test.ts",
            "test/agents/runs/acceptance.test.ts"
        ];

        for (const path of executedLanes) {
            expect(existsSync(resolve(packageRoot, path)), `${path} no longer exists`).toBe(true);
            expect(hashed.has(path), `${path} must stale a mutation area`).toBe(true);
        }
    });

    test("fingerprints an area from its own sources and is stable across calls", () => {
        const areas = sourceAreas();
        expect(areas).toContain("actors");
        expect(areas).toContain("authority");

        expect(mutationFingerprint("actors")).toBe(mutationFingerprint("actors"));
        expect(mutationFingerprint("actors")).not.toBe(mutationFingerprint("authority"));
    });
});

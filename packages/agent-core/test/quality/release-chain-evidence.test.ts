import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
    deployedVersionIds,
    oracleOperationManifest,
    passingLiveAtoms
} from "../../scripts/quality/release-chain-evidence.js";
import {
    contractExecutionManifest,
    exactEvidencePath,
    oracleExecutionManifest,
    passingTestPaths
} from "../../scripts/quality/oracle-execution-evidence.js";

const packageRoot = resolve(import.meta.dirname, "../..");

describe("release-chain evidence", () => {
    test("accepts only exact operations observed by an executed oracle suite", () => {
        const evidence = {
            edition: "1.0.0",
            testPath: "test/differential/persistence.differential.test.ts",
            expectedOperations: ["actor.activate", "actor.admits"],
            observedOperations: ["actor.activate", "actor.admits"]
        };

        expect(oracleExecutionManifest(JSON.stringify(evidence), "runtime.json")).toEqual({
            testPath: evidence.testPath,
            operations: new Set(evidence.expectedOperations)
        });
        expect(() =>
            oracleExecutionManifest(
                JSON.stringify({ ...evidence, observedOperations: ["actor.activate"] }),
                "runtime.json"
            )
        ).toThrow(/did not execute its exact oracle operations/u);
        expect(() =>
            oracleExecutionManifest(
                JSON.stringify({ ...evidence, testPath: "test/quality/forged.test.ts" }),
                "runtime.json"
            )
        ).toThrow(/must name a differential test/u);
    });

    test("accepts only complete passing differential test reports", () => {
        const path = resolve(packageRoot, "test/differential/persistence.differential.test.ts");
        const report = {
            success: true,
            numTotalTests: 1,
            numPassedTests: 1,
            numFailedTests: 0,
            numPendingTests: 0,
            numTodoTests: 0,
            testResults: [
                {
                    name: path,
                    status: "passed",
                    assertionResults: [{ status: "passed", title: "executes" }]
                }
            ]
        };

        expect(passingTestPaths(JSON.stringify(report), "vitest.json")).toEqual(
            new Set(["test/differential/persistence.differential.test.ts"])
        );
        expect(() =>
            passingTestPaths(JSON.stringify({ ...report, numFailedTests: 1 }), "vitest.json")
        ).toThrow(/complete passing test report/u);
    });

    test("accepts only exact runtime contract evidence", () => {
        const evidence = {
            edition: "1.0.0",
            testPath: "test/actors/actor.test.ts",
            suite: "ActorStore contract",
            backing: "Memory"
        };

        expect(contractExecutionManifest(JSON.stringify(evidence), "runtime.json")).toEqual(
            evidence
        );
        expect(() =>
            contractExecutionManifest(
                JSON.stringify({ ...evidence, testPath: "artifacts/forged.test.ts" }),
                "runtime.json"
            )
        ).toThrow(TypeError);
        expect(() =>
            contractExecutionManifest(
                JSON.stringify({ ...evidence, backing: " Memory" }),
                "runtime.json"
            )
        ).toThrow(TypeError);
    });

    test("rejects evidence paths that escape through symbolic links", () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-evidence-path-"));
        try {
            const root = join(directory, "root");
            const outside = join(directory, "outside.json");
            const link = join(root, "evidence.json");
            mkdirSync(root);
            writeFileSync(outside, "{}\n");
            symlinkSync(outside, link);

            expect(() => exactEvidencePath(root, "evidence.json")).toThrow(TypeError);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("binds runtime oracle operations to exact definition names", () => {
        const source = JSON.stringify([
            { op: "actor.activate", definitions: ["AgentCore.activateExec"] },
            { op: "actor.admits", definitions: ["AgentCore.admitsCommand"] }
        ]);

        expect(oracleOperationManifest(source, "oracle --operations")).toEqual(
            new Map([
                ["actor.activate", new Set(["AgentCore.activateExec"])],
                ["actor.admits", new Set(["AgentCore.admitsCommand"])]
            ])
        );
        expect(() =>
            oracleOperationManifest(
                JSON.stringify([{ op: "actor.activate", definitions: [] }]),
                "oracle --operations"
            )
        ).toThrow(/must name an operation and definitions/u);
    });

    test("reads deployment versions only from deployment records", () => {
        const source = JSON.stringify({
            note: "dead-version",
            deployments: [{ versionId: "live-version", url: "https://example.test" }]
        });

        expect(deployedVersionIds(source, "run.json")).toEqual(new Set(["live-version"]));
        expect(deployedVersionIds(source, "run.json")).not.toContain("dead-version");
    });

    test("reads live atoms only from exact passed assertion titles", () => {
        const source = JSON.stringify({
            success: true,
            numTotalTests: 2,
            numPassedTests: 2,
            numFailedTests: 0,
            numPendingTests: 0,
            numTodoTests: 0,
            testResults: [
                {
                    assertionResults: [
                        {
                            status: "passed",
                            title: "[P11-REAL] executes",
                            fullName: "suite [P11-DEAD] [P11-REAL] executes"
                        },
                        { status: "passed", title: "mentions [P11-INLINE] only" }
                    ]
                }
            ]
        });

        expect(passingLiveAtoms(source, "live.json")).toEqual(new Set(["P11-REAL"]));
        expect(() =>
            passingLiveAtoms(source.replace('"success":true', '"success":false'), "live.json")
        ).toThrow(/complete passing test report/u);
        expect(() =>
            passingLiveAtoms(source.replace('"status":"passed"', '"status":"failed"'), "live.json")
        ).toThrow(/assertion that did not pass/u);
    });
});

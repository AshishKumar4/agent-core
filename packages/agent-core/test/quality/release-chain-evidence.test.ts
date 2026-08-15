import { describe, expect, test } from "vitest";
import {
    declaredContractBackings,
    declaredOracleOperations,
    deployedVersionIds,
    oracleOperationManifest,
    passingLiveAtoms
} from "../../scripts/quality/release-chain-evidence.js";

describe("release-chain evidence", () => {
    test("accepts only the runtime-enforced oracle declaration", () => {
        const source = `
            // LeanOracle.start(["comment.operation"])
            const inert = 'LeanOracle.start(["string.operation"])';
            const request = { op: "object.operation" };
            const oracle = LeanOracle.start(["actor.activate", "actor.admits"]);
        `;

        expect(declaredOracleOperations(source, "suite.ts")).toEqual(
            new Set(["actor.activate", "actor.admits"])
        );
        expect(() =>
            declaredOracleOperations('const value = "actor.activate";', "suite.ts")
        ).toThrow(/exactly one nonempty Lean oracle declaration/u);
    });

    test("rejects ambiguous or nonliteral oracle declarations", () => {
        expect(() =>
            declaredOracleOperations(
                'LeanOracle.start(["actor.activate"]); LeanOracle.start(["actor.admits"]);',
                "suite.ts"
            )
        ).toThrow(/exactly one/u);
        expect(() =>
            declaredOracleOperations("LeanOracle.start([operation]);", "suite.ts")
        ).toThrow(/non-literal/u);
    });

    test("accepts only structural contract registrations", () => {
        const source = `
            // actorStoreContract("Comment", factory)
            const inert = 'actorStoreContract("String", factory)';
            actorStoreContract("Memory", memory);
            actorStoreContract("SQLite", sqlite);
        `;

        expect(declaredContractBackings(source, "contract.ts")).toEqual(
            new Set(["Memory", "SQLite"])
        );
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

// @ts-nocheck
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { dependencyClosure, topologicalOrder, validateGraph } from "../../scripts/quality/dag.mjs";
import { validateLeafSources } from "../../scripts/quality/recursion.mjs";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const stages = { building: ["building-attestation"], final: ["attestation"] } as const;

describe("quality DAG", subprocessTestOptions, () => {
    test("orders each dependency before its consumer", () => {
        const graph = {
            edition: "1.0.0",
            nodes: {
                "core-declarations": [],
                types: ["core-declarations"],
                tests: ["types"],
                coverage: ["tests"],
                "building-attestation": ["coverage"],
                attestation: ["coverage"]
            },
            stages
        };
        validateGraph(graph);
        const selected = dependencyClosure(["coverage"], graph.nodes);

        expect(topologicalOrder(selected, graph.nodes)).toEqual([
            "core-declarations",
            "types",
            "tests",
            "coverage"
        ]);
    });

    test("rejects cycles, missing dependencies, and self-dependencies", () => {
        expect(() =>
            validateGraph({ edition: "1.0.0", nodes: { a: ["b"], b: ["a"] }, stages })
        ).toThrow(/cycle/);
        expect(() =>
            validateGraph({ edition: "1.0.0", nodes: { a: ["missing"] }, stages })
        ).toThrow(/unknown dependency/);
        expect(() => validateGraph({ edition: "1.0.0", nodes: { a: ["a"] }, stages })).toThrow(
            /itself/
        );
    });

    test("rejects leaf checkers that invoke another checker", () => {
        expect(() =>
            validateLeafSources({
                "bad.mjs": "spawnSync(process.execPath, ['scripts/check-coverage.mjs']);"
            })
        ).toThrow(/invokes another checker/);
        expect(() =>
            validateLeafSources({
                "bad.mjs": "spawnSync('pnpm', ['check:types']);"
            })
        ).toThrow(/invokes another checker/);
        expect(() =>
            validateLeafSources({
                "check-wrapper.mjs": "import './quality/coverage.mjs';"
            })
        ).toThrow(/imports another checker/);
        expect(() => validateLeafSources({ "good.mjs": "export const value = 1;" })).not.toThrow();
    });

    test("rejects incomplete stage roots and partial final execution", () => {
        expect(() =>
            validateGraph({
                edition: "1.0.0",
                nodes: {
                    coverage: [],
                    "building-attestation": [],
                    attestation: []
                },
                stages
            })
        ).toThrow(/omits nodes/);

        const result = runQualitySubprocess(process.execPath, [
            resolve(import.meta.dirname, "../../scripts/quality/run.mjs"),
            "--stage",
            "final",
            "--target",
            "dag"
        ]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("cannot run a partial target");

        const attestation = runQualitySubprocess(process.execPath, [
            resolve(import.meta.dirname, "../../scripts/quality/attest.mjs"),
            "--stage",
            "building"
        ]);
        expect(attestation.status).toBe(1);
        expect(attestation.stderr).toContain("must be run by the quality orchestrator");
    });
});

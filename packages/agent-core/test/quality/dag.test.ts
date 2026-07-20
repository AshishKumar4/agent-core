import { resolve } from "node:path";
import { loadConfigFromFile } from "vite";
import { describe, expect, test } from "vitest";
import { dependencyClosure, topologicalOrder, validateGraph } from "../../scripts/quality/dag.mjs";
import {
    validateLeafSources,
    validateNonrecursiveQualityScripts
} from "../../scripts/quality/recursion.mjs";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const stages = { building: ["building-attestation"], final: ["attestation"] } as const;
const governanceTests = [
    "test/quality/governance.test.ts",
    "test/quality/ownership.test.ts",
    "test/quality/protocols.test.ts"
];

function graph(nodes: Record<string, readonly string[]>) {
    return {
        edition: "1.0.0",
        nodes,
        hermetic: Object.fromEntries(Object.keys(nodes).map((node) => [node, true])),
        stages
    };
}

describe("quality DAG", subprocessTestOptions, () => {
    test("orders each dependency before its consumer", () => {
        const value = graph({
            "core-declarations": [],
            types: ["core-declarations"],
            tests: ["types"],
            coverage: ["tests"],
            "building-attestation": ["coverage"],
            attestation: ["coverage"]
        });
        validateGraph(value);
        const selected = dependencyClosure(["coverage"], value.nodes);

        expect(topologicalOrder(selected, value.nodes)).toEqual([
            "core-declarations",
            "types",
            "tests",
            "coverage"
        ]);
    });

    test("rejects cycles, missing dependencies, and self-dependencies", () => {
        expect(() => validateGraph(graph({ a: ["b"], b: ["a"] }))).toThrow(/cycle/);
        expect(() => validateGraph(graph({ a: ["missing"] }))).toThrow(/unknown dependency/);
        expect(() => validateGraph(graph({ a: ["a"] }))).toThrow(/itself/);
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

    test("keeps every quality checker entrypoint an independent leaf", async () => {
        await expect(validateNonrecursiveQualityScripts()).resolves.toBeUndefined();
    });

    test("keeps process governance tests isolated from the hermetic quality suite", async () => {
        const loaded = await loadConfigFromFile(
            { command: "serve", mode: "test" },
            resolve(import.meta.dirname, "../../vitest.governance.config.mjs")
        );
        if (loaded === null) throw new TypeError("Governance Vitest config did not load");
        const testConfig: unknown = Reflect.get(loaded.config, "test");
        if (typeof testConfig !== "object" || testConfig === null) {
            throw new TypeError("Governance Vitest config lacks test settings");
        }

        expect(Reflect.get(testConfig, "include")).toEqual(governanceTests);
    });

    test("runs native priority lanes before the full product suite and classifies their evidence", () => {
        const value = graph({
            types: [],
            dag: [],
            "quality-tests": ["types", "dag"],
            "priority-tests": ["types", "dag"],
            tests: ["quality-tests", "priority-tests"],
            "test-priorities": ["tests", "priority-tests"],
            coverage: ["test-priorities"],
            "building-attestation": ["coverage"],
            attestation: ["coverage"]
        });

        validateGraph(value);
        const order = topologicalOrder(dependencyClosure(["coverage"], value.nodes), value.nodes);
        expect(order.indexOf("priority-tests")).toBeLessThan(order.indexOf("tests"));
        expect(order.indexOf("tests")).toBeLessThan(order.indexOf("test-priorities"));
        expect(order.indexOf("test-priorities")).toBeLessThan(order.indexOf("coverage"));
    });

    test("rejects incomplete stage roots and partial final execution", () => {
        expect(() =>
            validateGraph(
                graph({
                    coverage: [],
                    "building-attestation": [],
                    attestation: []
                })
            )
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

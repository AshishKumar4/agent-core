import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { objectAt, objectsAt, readArtifact, stringAt, stringsAt } from "./artifacts";
import { dependencyClosure } from "../../scripts/quality/dag.mjs";
import type { JsonObject } from "../../scripts/quality/project.mjs";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/invariants.mjs");
const temporary: string[] = [];

// The certifier of every quality rule reads three inputs: the graph, the rule registry,
// and one node report per rule. The committed graph is the real one in every fixture, so
// a case only ever changes the registry entry or the report the case is about.
const fixtureRule = "ACQ-FIXTURE";

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function run(
    rules: readonly JsonObject[],
    reports: Readonly<Record<string, JsonObject>>,
    extra: readonly string[] = []
) {
    const root = await mkdtemp(join(tmpdir(), "invariants-"));
    temporary.push(root);
    await mkdir(join(root, "artifacts/quality"), { recursive: true });
    await mkdir(join(root, "reports/nodes"), { recursive: true });
    await writeFile(
        join(root, "artifacts/quality/check-dag.json"),
        await readFile(resolve(packageRoot, "artifacts/quality/check-dag.json"), "utf8"),
        "utf8"
    );
    await writeFile(
        join(root, "artifacts/quality/rules.json"),
        `${JSON.stringify({ edition: "1.0.0", rules }, null, 2)}\n`,
        "utf8"
    );
    for (const [node, report] of Object.entries(reports)) {
        await writeFile(
            join(root, "reports/nodes", `${node}.json`),
            `${JSON.stringify(report, null, 2)}\n`,
            "utf8"
        );
    }
    const result = runQualitySubprocess(
        process.execPath,
        [
            checker,
            "--stage",
            "building",
            "--artifact-root",
            join(root, "artifacts"),
            "--report-root",
            join(root, "reports"),
            ...extra
        ],
        packageRoot
    );
    return { ...result, root };
}

function rule(node: string, id = fixtureRule): JsonObject {
    return { id, node, description: "A fixture rule certified by one checker node" };
}

describe("executed checker invariant certification", subprocessTestOptions, () => {
    test("certifies a rule whose checker node passed in this run", async () => {
        const result = await run([rule("coverage")], { coverage: { status: "passed" } });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("executed checker invariants verified: 1");
        expect(
            JSON.parse(await readFile(join(result.root, "reports/invariants.json"), "utf8"))
        ).toEqual({ edition: "1.0.0", stage: "building", passed: [fixtureRule] });
    });

    test("fails when a required rule's checker node produced no report", async () => {
        const result = await run([rule("coverage")], {});

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${fixtureRule} checker node coverage produced no report`);
    });

    test("fails when a required rule's checker node reported a non-passed status", async () => {
        const result = await run([rule("coverage")], { coverage: { status: "failed" } });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${fixtureRule} checker node coverage did not pass`);
    });

    test("fails when a rule names a checker node the graph omits", async () => {
        const result = await run([rule("not-a-node")], { "not-a-node": { status: "passed" } });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `${fixtureRule} names checker node not-a-node, which the quality graph omits`
        );
    });

    test("fails when a rule names a checker node this node does not depend on", async () => {
        const result = await run([rule("ledger")], { ledger: { status: "passed" } });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `${fixtureRule} checker node ledger is not a dependency of invariants`
        );
    });

    test("fails when the registry states one rule id twice", async () => {
        const result = await run([rule("coverage"), rule("imports")], {
            coverage: { status: "passed" },
            imports: { status: "passed" }
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `quality/rules.json rules contains duplicate id ACQ-FIXTURE`
        );
    });

    test("defers a process-node rule to governance instead of dropping it", async () => {
        const result = await run([rule("scope")], {}, ["--hermetic"]);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("(1 deferred to governance)");
        expect(
            JSON.parse(await readFile(join(result.root, "reports/invariants.json"), "utf8"))
        ).toEqual({
            edition: "1.0.0",
            stage: "building",
            passed: [],
            deferredToGovernance: [fixtureRule]
        });
    });

    test("keeps every committed rule certifiable by a node this run reaches", async () => {
        const graph = await readArtifact("artifacts/quality/check-dag.json");
        const registry = await readArtifact("artifacts/quality/rules.json");
        const declared = objectAt(graph, "nodes");
        const edges = Object.fromEntries(
            Object.keys(declared).map((node) => [node, stringsAt(declared, node)])
        );
        const closure = dependencyClosure(["invariants"], edges);

        const cited = objectsAt(registry, "rules").map((entry) => stringAt(entry, "node"));
        expect(cited.length).toBeGreaterThan(0);
        expect(cited.filter((node) => edges[node] === undefined)).toEqual([]);
        expect(cited.filter((node) => !closure.has(node))).toEqual([]);
    });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { objectsAt, readArtifact, stringAt, stringsAt } from "./artifacts";
import type { JsonObject } from "../../scripts/quality/project.mjs";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/gate-integrity.mjs");
const temporary: string[] = [];

// Real corpus, perturbed one field at a time: what is under test is the verdict the meta
// gate reaches, so every fixture keeps the committed gates, harnesses and mutations and
// changes exactly the thing the case is about. Two gates are enough because each fixture
// also names the rules it leaves unproven — measuring the whole committed corpus for one
// field's sake would clone the repository once per gate.
let coherenceGate: JsonObject;
let mutationGate: JsonObject;
let committedMutation: JsonObject;
let committedGates: number;
let committedDebt: readonly string[];
let committedMutations: number;
// Derived, never written down. A hardcoded rule total is a second source of truth for the
// registry's size, and it broke the moment a peer registered COH-LABEL-CITATION — a
// correct landing turning this suite red for a number that is not what any case is about.
let registeredRules: number;
// Every rule the two-gate fixture below does not register. A case about the debt list has
// to leave no rule unproven, or the gate fails on the unproven rule first and the case
// never reaches what it is about.
let fixtureDebt: readonly string[];

beforeAll(async () => {
    const corpusArtifact = await readArtifact("artifacts/quality/gate-corpus.json");
    const gates = objectsAt(corpusArtifact, "gates");
    const coherence = gates.find((gate) => stringAt(gate, "rule") === "ACQ-NORM");
    const mutation = gates.find((gate) => stringAt(gate, "rule") === "ACQ-EQUIV");
    if (coherence === undefined || mutation === undefined) {
        throw new TypeError("Committed gate corpus no longer registers ACQ-NORM and ACQ-EQUIV");
    }
    const first = objectsAt(coherence, "mutations")[0];
    if (first === undefined) throw new TypeError("Committed ACQ-NORM gate states no mutation");
    coherenceGate = coherence;
    mutationGate = mutation;
    committedMutation = first;
    committedMutations = gates.reduce(
        (total, gate) => total + objectsAt(gate, "mutations").length,
        0
    );
    committedDebt = stringsAt(corpusArtifact, "unregistered");
    committedGates = gates.length;
    const ruleIds = objectsAt(await readArtifact("artifacts/quality/rules.json"), "rules").map(
        (rule) => stringAt(rule, "id")
    );
    registeredRules = ruleIds.length;
    fixtureDebt = ruleIds.filter((id) => id !== "ACQ-NORM" && id !== "ACQ-EQUIV");
});

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

const harmlessId = "ACQ-NORM/heading-title-is-not-structure";

/** A mutation `coherence` accepts by design: heading titles carry no structure. */
const harmless: JsonObject = {
    id: harmlessId,
    find: "## 11. Profiles",
    replace: "## 11. Execution profiles",
    expects: "SPEC heading is malformed: 11. Execution profiles",
    diagnostic: "SPEC heading is malformed: ",
    defect: "A fixture mutation the gate accepts, standing in for a checker gone silent."
};

function corpus(gate: JsonObject = {}, unregistered?: readonly string[]): JsonObject {
    return {
        edition: "1.0.0",
        gates: [{ ...coherenceGate, mutations: [committedMutation], ...gate }, mutationGate],
        unregistered: unregistered ?? fixtureDebt
    };
}

async function run(value: JsonObject, stage = "building", rules?: JsonObject) {
    const root = await mkdtemp(join(tmpdir(), "gate-corpus-"));
    temporary.push(root);
    const path = join(root, "corpus.json");
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const registry: string[] = [];
    if (rules !== undefined) {
        const rulesPath = join(root, "rules.json");
        await writeFile(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
        registry.push("--rules", rulesPath);
    }
    return runQualitySubprocess(
        process.execPath,
        [checker, "--stage", stage, "--corpus", path, ...registry],
        packageRoot
    );
}

describe("gate integrity", subprocessTestOptions, () => {
    // The whole committed corpus, measured for real: every gate clones the repository and
    // spawns its checker, so this one case is minutes of work and needs its own budget.
    test(
        "turns every registered gate red on every committed mutation",
        { timeout: 900_000 },
        () => {
            const result = runQualitySubprocess(
                process.execPath,
                [checker, "--stage", "building"],
                packageRoot,
                600_000
            );

            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toContain(
                `gate integrity ${committedDebt.length === 0 ? "complete" : "incomplete"}: ` +
                    `${committedMutations} mutation(s) turned ${committedGates} of ` +
                    `${registeredRules} rule(s) red, ${committedDebt.length} unproven`
            );
        }
    );

    test("fails when a gate passes under a known-bad mutation of its own input", async () => {
        const result = await run(corpus({ mutations: [harmless] }));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Gate passed under a known-bad mutation of its own input");
        expect(result.stderr).toContain(`coherence survived ${harmlessId}`);
    });

    test("fails when a gate goes red for a reason the corpus did not claim", async () => {
        const result = await run(
            corpus({
                mutations: [
                    {
                        ...committedMutation,
                        expects: "SPEC strikethrough hides prose: prose this mutation never struck",
                        diagnostic: "SPEC strikethrough hides prose: "
                    }
                ]
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Gate went red for the wrong reason");
        expect(result.stderr).toContain("must appear exactly once outside §13");
    });

    test("fails when a quality rule has neither a corpus nor recorded debt", async () => {
        const result = await run(corpus({}, []));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Quality rule has no mutation corpus and no recorded debt");
        expect(result.stderr).toContain("ACQ-TYPE");
        expect(result.stderr).not.toContain("  ACQ-NORM\n");
        expect(result.stderr).not.toContain("  ACQ-EQUIV\n");
    });

    test("fails when the debt list retains a rule the corpus now proves", async () => {
        const result = await run(corpus({}, [...fixtureDebt, "ACQ-NORM"]));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Gate corpus debt retains registered rules");
        expect(result.stderr).toContain("ACQ-NORM");
    });

    test("fails when the debt list names a rule the registry does not state", async () => {
        const result = await run(corpus({}, [...fixtureDebt, "ACQ-INVENTED"]));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Gate corpus debt names rules no rule registry states");
        expect(result.stderr).toContain("ACQ-INVENTED");
    });

    test("admits no unproven quality rule at the final stage", async () => {
        const result = await run(corpus({}), "final");

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Final gate integrity admits no unproven quality rule");
    });

    test("rejects a mutation that does not locate its own input", async () => {
        const result = await run(
            corpus({
                mutations: [{ ...committedMutation, find: "prose the SPEC does not carry" }]
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("locates 0 occurrences in SPEC.md");
    });

    test("rejects a mutation that changes nothing", async () => {
        const result = await run(
            corpus({
                mutations: [{ ...committedMutation, replace: stringAt(committedMutation, "find") }]
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("leaves its input unchanged");
    });

    test("rejects a mutation pinning a diagnostic no checker source states", async () => {
        const invented = "the checker never says this";
        const result = await run(
            corpus({
                mutations: [{ ...committedMutation, diagnostic: invented, expects: invented }]
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("pins a diagnostic no coherence checker source states");
    });

    test("rejects an expectation that does not carry its own pinned diagnostic", async () => {
        const result = await run(
            corpus({
                mutations: [{ ...committedMutation, diagnostic: "Malformed cross-reference " }]
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("expects prose that does not carry its pinned diagnostic");
    });

    test("rejects one mutation standing in for two gates", async () => {
        const result = await run(
            corpus({
                mutations: [committedMutation, { ...committedMutation, id: "ACQ-NORM/duplicate" }]
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ACQ-NORM/duplicate repeats another mutation");
    });

    test("rejects a gate bound to a node its rule registry does not name", async () => {
        const result = await run(corpus({ node: "architecture" }));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "Gate corpus binds ACQ-NORM to architecture, which is not its rule registry node"
        );
    });

    test("rejects a registered gate that mutates nothing", async () => {
        const result = await run(corpus({ mutations: [] }));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Gate ACQ-NORM registers no mutation of its own input");
    });

    // Every rule the committed registry states is now bound to a node with a harness, so
    // the guard is reachable only through a registry that states one that is not — which is
    // the landing it defends: a new rule on a checker nobody taught this gate to run.
    test("rejects a gate whose node has no mutation harness", async () => {
        const result = await run(
            {
                edition: "1.0.0",
                gates: [
                    { ...coherenceGate, mutations: [committedMutation] },
                    mutationGate,
                    { ...coherenceGate, rule: "ACQ-TRACE", node: "traceability" }
                ],
                unregistered: []
            },
            "building",
            {
                edition: "1.0.0",
                rules: [
                    { id: "ACQ-NORM", node: "coherence", description: "" },
                    { id: "ACQ-EQUIV", node: "mutation", description: "" },
                    { id: "ACQ-TRACE", node: "traceability", description: "" }
                ]
            }
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "Gate corpus registers traceability with no mutation harness"
        );
    });

    test("rejects a mutation harness no quality rule is bound to", async () => {
        const result = await run({ ...corpus(), unregistered: [] }, "building", {
            edition: "1.0.0",
            rules: [
                { id: "ACQ-NORM", node: "coherence", description: "" },
                { id: "ACQ-EQUIV", node: "mutation", description: "" }
            ]
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Mutation harness binds no quality rule");
        expect(result.stderr).toContain("architecture");
    });
});

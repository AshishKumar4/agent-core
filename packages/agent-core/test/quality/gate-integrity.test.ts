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
// changes exactly the thing the case is about. Both registered gates are carried in every
// fixture because `validateCorpus` refuses a harness no gate exercises — a corpus that
// dropped one would fail for that reason instead of the one the case is about.
let coherenceGate: JsonObject;
let mutationGate: JsonObject;
let committedMutation: JsonObject;
let committedDebt: readonly string[];
let committedMutations: number;

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
        unregistered: unregistered ?? committedDebt
    };
}

async function run(value: JsonObject, stage = "building") {
    const root = await mkdtemp(join(tmpdir(), "gate-corpus-"));
    temporary.push(root);
    const path = join(root, "corpus.json");
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return runQualitySubprocess(
        process.execPath,
        [checker, "--stage", stage, "--corpus", path],
        packageRoot
    );
}

describe("gate integrity", subprocessTestOptions, () => {
    test("turns every registered gate red on every committed mutation", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, "--stage", "building"],
            packageRoot
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
            `gate integrity incomplete: ${committedMutations} mutation(s) turned 2 of 18 rule(s) red`
        );
    });

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
        const result = await run(corpus({}, [...committedDebt, "ACQ-NORM"]));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Gate corpus debt retains registered rules");
        expect(result.stderr).toContain("ACQ-NORM");
    });

    test("fails when the debt list names a rule the registry does not state", async () => {
        const result = await run(corpus({}, [...committedDebt, "ACQ-INVENTED"]));

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

    test("rejects a gate whose node has no mutation harness", async () => {
        const result = await run(
            corpus(
                { rule: "ACQ-TYPE", node: "architecture" },
                committedDebt.filter((rule) => rule !== "ACQ-TYPE")
            )
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "Gate corpus registers architecture with no mutation harness"
        );
    });
});

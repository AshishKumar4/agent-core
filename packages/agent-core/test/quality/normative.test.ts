import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { generateNormativeLock } from "../../scripts/check-normative.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "../..");
const formalRoot = resolve(packageRoot, "formal");
const temporary: string[] = [];
const allowedAxiomTokens = ["Classical.choice", "Quot.sound", "propext"]
    .map((name) => JSON.stringify(`allowed:${name}`))
    .join(" ");

interface StructuralPackage {
    allowedAxioms: string[];
    encodingVersion: string;
    designations: {
        axioms: string[];
        closure: string[];
        kind: string;
        name: string;
        type: object;
    }[];
    declarations: { name: string; structure: object }[];
}

beforeAll(async () => {
    await execFileAsync("lake", ["build", "AgentCore", "AgentCore.Normative"], {
        cwd: formalRoot,
        encoding: "utf8"
    });
}, 120_000);

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { force: true, recursive: true }))
    );
});

async function runLean(source: string): Promise<{ output?: StructuralPackage; stderr: string }> {
    const directory = await mkdtemp(resolve(tmpdir(), "agent-core-normative-"));
    temporary.push(directory);
    const path = resolve(directory, "Fixture.lean");
    await writeFile(path, source, "utf8");
    const result = await new Promise<{ failed: boolean; stderr: string; stdout: string }>(
        (resolveResult) => {
            execFile(
                "lake",
                ["env", "lean", path],
                {
                    cwd: formalRoot,
                    encoding: "utf8",
                    maxBuffer: 64 * 1024 * 1024
                },
                (error, stdout, stderr) => {
                    resolveResult({ failed: error !== null, stderr, stdout });
                }
            );
        }
    );
    if (!result.failed) {
        const line = result.stdout
            .split(/\r?\n/u)
            .find((candidate) => candidate.startsWith('{"encodingVersion":'));
        return { output: line === undefined ? undefined : JSON.parse(line), stderr: result.stderr };
    }
    return { stderr: `${result.stdout}${result.stderr}` };
}

function fixture({
    helper,
    statement = "helper n = helper n",
    proof = "rfl",
    witness = "∃ n, helper n = helper n",
    witnessProof = "⟨0, rfl⟩",
    binder = "n",
    designations = [
        '"claim:AgentCore.NormativeFixture.claim"',
        '"witness:AgentCore.NormativeFixture.witness"'
    ]
}: {
    helper?: string;
    statement?: string;
    proof?: string;
    witness?: string;
    witnessProof?: string;
    binder?: string;
    designations?: string[];
} = {}): string {
    const helperBody = helper ?? `${binder} + 1`;
    return `
import AgentCore
import AgentCore.Normative

namespace AgentCore.NormativeFixture
def helper (${binder} : Nat) : Nat := ${helperBody}
theorem claim (${binder} : Nat) : ${statement} := by ${proof}
theorem witness : ${witness} := by exact ${witnessProof}
end AgentCore.NormativeFixture

#agent_core_normative ${allowedAxiomTokens} ${designations.join(" ")}
`;
}

function semanticFixture(declarations: string): string {
    return `
import AgentCore
import AgentCore.Normative

namespace AgentCore.NormativeFixture
${declarations}
end AgentCore.NormativeFixture

#agent_core_normative ${allowedAxiomTokens} "claim:AgentCore.NormativeFixture.claim"
`;
}

function proofCarryingFixture(proof: string): string {
    return semanticFixture(`
def carried (n : Nat) : { value : Nat // value = value } :=
  let evidence : ∀ value : Nat, value = value := fun value => ${proof}
  ⟨n, evidence n⟩
def project (n : Nat) : Nat := (carried n).val
theorem claim (n : Nat) : project n = n := rfl
`);
}

function privateHelperFixture(helper: string): string {
    return semanticFixture(`
private def hiddenHelper (n : Nat) : Nat := ${helper}
def project (n : Nat) : Nat := hiddenHelper n
theorem claim (n : Nat) : project n = project n := rfl
`);
}

function predicateFixture(predicate: string): string {
    return semanticFixture(`
def predicate (n : Nat) : Prop := ${predicate}
theorem claim (n : Nat) : predicate n ↔ predicate n := Iff.rfl
`);
}

function proofIndexedTypeFixture(proof: string): string {
    return semanticFixture(`
def proposition (_evidence : True) : Prop := True
def carrier (_evidence : True) : Type := Nat
def value : carrier (${proof}) := (0 : Nat)
theorem claim : proposition (${proof}) ∧ value = value := ⟨True.intro, rfl⟩
`);
}

describe("normative structural encoder", { timeout: 120_000 }, () => {
    test("regenerates the complete committed lock byte-identically", async () => {
        const first = generateNormativeLock();
        const second = generateNormativeLock();
        const committed = await readFile(resolve(packageRoot, "artifacts/normative.lock"), "utf8");

        expect(second).toBe(first);
        expect(committed).toBe(first);
    });

    test("emits byte-identical structural packages on repeated runs", async () => {
        const first = await runLean(fixture());
        const second = await runLean(fixture());

        expect(first.stderr).toBe("");
        expect(second.stderr).toBe("");
        expect(first.output).toEqual(second.output);
    });

    test("ignores whitespace, notation spelling, proof tactics, and binder names", async () => {
        const concise = await runLean(fixture());
        const rewritten = await runLean(
            fixture({
                binder: "value",
                proof: "exact Eq.refl (helper value)",
                statement: "Eq (helper value) (helper value)"
            })
        );

        expect(concise.output).toBeDefined();
        expect(rewritten.stderr).toBe("");
        expect(rewritten.output).toEqual(concise.output);
    });

    test("erases nested proof terms throughout reachable semantic values", async () => {
        const direct = await runLean(proofCarryingFixture("Eq.refl value"));
        const derived = await runLean(
            proofCarryingFixture("Eq.symm (Eq.trans (Eq.refl value) (Eq.refl value))")
        );

        expect(direct.stderr).toBe("");
        expect(direct.output).toBeDefined();
        expect(derived.stderr).toBe("");
        expect(derived.output).toEqual(direct.output);
    });

    test("retains propositions constructed by reachable semantic values", async () => {
        const reflexive = await runLean(predicateFixture("n = n"));
        const zero = await runLean(predicateFixture("n = 0"));

        expect(reflexive.stderr).toBe("");
        expect(zero.stderr).toBe("");
        expect(zero.output).not.toEqual(reflexive.output);
    });

    test("erases proof arguments nested inside designated and reachable definition types", async () => {
        const direct = await runLean(proofIndexedTypeFixture("True.intro"));
        const derived = await runLean(proofIndexedTypeFixture("And.left ⟨True.intro, True.intro⟩"));

        expect(direct.stderr).toBe("");
        expect(derived.stderr).toBe("");
        expect(derived.output).toEqual(direct.output);
    });

    test("erases expression metadata but retains binder information", async () => {
        const source = `
import AgentCore.Normative
open Lean
#eval IO.println (Json.compress (AgentCore.Normative.encodeExpression [] (.bvar 0)))
#eval IO.println (Json.compress (AgentCore.Normative.encodeExpression [] (.mdata MData.empty (.bvar 0))))
#eval IO.println (Json.compress (AgentCore.Normative.encodeExpression [] (.forallE \`x (.const \`Nat []) (.bvar 0) .default)))
#eval IO.println (Json.compress (AgentCore.Normative.encodeExpression [] (.forallE \`x (.const \`Nat []) (.bvar 0) .implicit)))
`;
        const directory = await mkdtemp(resolve(tmpdir(), "agent-core-normative-expr-"));
        temporary.push(directory);
        const path = resolve(directory, "Expression.lean");
        await writeFile(path, source, "utf8");
        const result = await execFileAsync("lake", ["env", "lean", path], {
            cwd: formalRoot,
            encoding: "utf8"
        });
        const lines = result.stdout.trim().split(/\r?\n/u);

        expect(lines[0]).toBe(lines[1]);
        expect(lines[2]).not.toBe(lines[3]);
    });

    test("changes for a theorem statement, reachable helper, witness type, or membership", async () => {
        const baseline = (await runLean(fixture())).output;
        const statement = (
            await runLean(
                fixture({
                    statement: "helper n = helper n ∧ True",
                    proof: "exact ⟨rfl, True.intro⟩"
                })
            )
        ).output;
        const helper = (await runLean(fixture({ helper: "n + 2" }))).output;
        const witness = (
            await runLean(
                fixture({
                    witness: "∃ n : Nat, ∃ m : Nat, helper n = helper n",
                    witnessProof: "⟨0, 0, rfl⟩"
                })
            )
        ).output;
        const membership = (
            await runLean(fixture({ designations: ['"claim:AgentCore.NormativeFixture.claim"'] }))
        ).output;

        expect(baseline).toBeDefined();
        expect(statement).toBeDefined();
        expect(helper).toBeDefined();
        expect(witness).toBeDefined();
        expect(membership).toBeDefined();
        expect(statement).not.toEqual(baseline);
        expect(helper).not.toEqual(baseline);
        expect(witness).not.toEqual(baseline);
        expect(membership).not.toEqual(baseline);
    });

    test("captures an AgentCore helper that is not itself designated", async () => {
        const result = await runLean(fixture());

        expect(result.output?.declarations.map(({ name }) => name)).toContain(
            "AgentCore.NormativeFixture.helper"
        );
        expect(
            result.output?.designations.every(({ closure }) =>
                closure.includes("AgentCore.NormativeFixture.helper")
            )
        ).toBe(true);
    });

    test("captures the computation of a reachable private project helper", async () => {
        const baseline = await runLean(privateHelperFixture("n + 1"));
        const changed = await runLean(privateHelperFixture("n + 2"));

        expect(baseline.stderr).toBe("");
        expect(changed.stderr).toBe("");
        expect(changed.output).not.toEqual(baseline.output);
    });

    test("fails closed on custom axioms and sorryAx", async () => {
        const custom = await runLean(`
import AgentCore
import AgentCore.Normative
namespace AgentCore.NormativeFixture
axiom poison : False
theorem claim : False := poison
end AgentCore.NormativeFixture
#agent_core_normative ${allowedAxiomTokens} "allowed:AgentCore.NormativeFixture.poison" "claim:AgentCore.NormativeFixture.claim"
`);
        const sorry = await runLean(`
import AgentCore
import AgentCore.Normative
namespace AgentCore.NormativeFixture
theorem claim : False := by sorry
end AgentCore.NormativeFixture
#agent_core_normative ${allowedAxiomTokens} "claim:AgentCore.NormativeFixture.claim"
`);

        expect(custom.output).toBeUndefined();
        expect(custom.stderr).toContain(
            "project declaration AgentCore.NormativeFixture.poison is a forbidden custom axiom"
        );
        expect(sorry.output).toBeUndefined();
        expect(sorry.stderr).toContain("sorryAx");
    });

    test("rejects an undesignated custom axiom anywhere in the project environment", async () => {
        const result = await runLean(`
import AgentCore
import AgentCore.Normative
namespace AgentCore.NormativeFixture
axiom unusedPoison : False
theorem claim : True := True.intro
end AgentCore.NormativeFixture
#agent_core_normative ${allowedAxiomTokens} "claim:AgentCore.NormativeFixture.claim"
`);

        expect(result.output).toBeUndefined();
        expect(result.stderr).toContain(
            "project declaration AgentCore.NormativeFixture.unusedPoison is a forbidden custom axiom"
        );
    });

    test("rejects private custom axioms outside the AgentCore namespace", async () => {
        const result = await runLean(`
import AgentCore
import AgentCore.Normative
namespace Other
private axiom hiddenPoison : False
end Other
namespace AgentCore.NormativeFixture
theorem claim : True := True.intro
end AgentCore.NormativeFixture
#agent_core_normative ${allowedAxiomTokens} "claim:AgentCore.NormativeFixture.claim"
`);

        expect(result.output).toBeUndefined();
        expect(result.stderr).toContain(
            "project declaration Other.hiddenPoison is a forbidden custom axiom"
        );
    });

    test("rejects custom axioms whose names resemble compiler auxiliaries", async () => {
        const result = await runLean(`
import AgentCore
import AgentCore.Normative
namespace AgentCore.NormativeFixture
axiom _elambda_123 : False
theorem claim : True := True.intro
end AgentCore.NormativeFixture
#agent_core_normative ${allowedAxiomTokens} "claim:AgentCore.NormativeFixture.claim"
`);

        expect(result.output).toBeUndefined();
        expect(result.stderr).toContain(
            "project declaration AgentCore.NormativeFixture._elambda_123 is a forbidden custom axiom"
        );
    });

    test("rejects undesignated unsafe and partial project definitions", async () => {
        const unsafe = await runLean(`
import AgentCore
import AgentCore.Normative
namespace AgentCore.NormativeFixture
unsafe def unusedDanger : Nat := 0
theorem claim : True := True.intro
end AgentCore.NormativeFixture
#agent_core_normative ${allowedAxiomTokens} "claim:AgentCore.NormativeFixture.claim"
`);
        const partial = await runLean(`
import AgentCore
import AgentCore.Normative
namespace AgentCore.NormativeFixture
partial def unusedLoop (_unit : Unit) : Nat := unusedLoop ()
theorem claim : True := True.intro
end AgentCore.NormativeFixture
#agent_core_normative ${allowedAxiomTokens} "claim:AgentCore.NormativeFixture.claim"
`);

        expect(unsafe.output).toBeUndefined();
        expect(unsafe.stderr).toContain(
            "project declaration AgentCore.NormativeFixture.unusedDanger is unsafe or partial"
        );
        expect(partial.output).toBeUndefined();
        expect(partial.stderr).toContain(
            "project declaration AgentCore.NormativeFixture.unusedLoop is unsafe or partial"
        );
    });

    test("rejects a nondesignated theorem proved by a forbidden kernel primitive", async () => {
        const result = await runLean(`
import AgentCore
import AgentCore.Normative
namespace AgentCore.NormativeFixture
theorem poisoned : 1 + 1 = 2 := by native_decide
theorem claim : True := True.intro
end AgentCore.NormativeFixture
#agent_core_normative ${allowedAxiomTokens} "allowed:Lean.ofReduceBool" "claim:AgentCore.NormativeFixture.claim"
`);

        expect(result.output).toBeUndefined();
        expect(result.stderr).toMatch(
            /project theorem set depends on disallowed axiom .*ofReduceBool/u
        );
    });
});

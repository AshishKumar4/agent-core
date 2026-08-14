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

#agent_core_normative ${designations.join(" ")}
`;
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

    test("fails closed on custom axioms and sorryAx", async () => {
        const custom = await runLean(`
import AgentCore
import AgentCore.Normative
namespace AgentCore.NormativeFixture
axiom poison : False
theorem claim : False := poison
end AgentCore.NormativeFixture
#agent_core_normative "claim:AgentCore.NormativeFixture.claim"
`);
        const sorry = await runLean(`
import AgentCore
import AgentCore.Normative
namespace AgentCore.NormativeFixture
theorem claim : False := by sorry
end AgentCore.NormativeFixture
#agent_core_normative "claim:AgentCore.NormativeFixture.claim"
`);

        expect(custom.output).toBeUndefined();
        expect(custom.stderr).toContain("disallowed axiom AgentCore.NormativeFixture.poison");
        expect(sorry.output).toBeUndefined();
        expect(sorry.stderr).toContain("sorryAx");
    });
});

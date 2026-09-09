import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
    assertArray,
    assertObject,
    assertString,
    parseCanonicalJson,
    type JsonObject,
    type JsonValue
} from "../../scripts/quality/project.mjs";
import { objectsAt, stringAt } from "./artifacts";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

/**
 * A validated artifact opened for one substitution. `JsonObject`'s index signature is
 * read-only, which is right for every reader of a committed artifact and wrong for a
 * fixture whose whole job is to hold one wrong claim.
 */
type MutableArtifact = { [key: string]: JsonValue };

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/check-substrate-contracts.mjs");
const artifactPath = resolve(packageRoot, "artifacts/substrate-contracts.json");
/**
 * The Lean files the artifact cites by name: the premise-to-channel table, the opcode
 * source, and the witness source. Every scratch tree carries their committed bytes,
 * because what a case substitutes is the artifact's claim about them, never the Lean text.
 */
const leanSources = ["dischargeSource", "premiseSource", "witnessSource"];
/**
 * The status a premise is demoted to: the ledger's own word for a row that is built and
 * not yet verified. Any disagreement with the ledger fails the gate; a demotion is the one
 * that reads as honest debt while the conformance row it cites still claims more.
 */
const demotedStatus = "implemented";
const temporary: string[] = [];
let committed: JsonObject;

beforeAll(async () => {
    committed = assertObject(
        parseCanonicalJson(
            await readFile(artifactPath, "utf8"),
            "artifacts/substrate-contracts.json"
        ),
        "artifacts/substrate-contracts.json"
    );
});

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

/**
 * The gate's own discrimination. `scripts/check-substrate-contracts.mjs` reads the three
 * things the substrate premise discharge map claims to agree with — Lean's own
 * `Premise.discharge` table, the conformance rows the indexed fragments carry today, and
 * the theorems `Witness.lean` declares — so the only thing that can show it is doing that
 * is a claim it refuses. Each case here substitutes exactly one wrong claim and asserts the
 * gate names it; the control asserts the committed map is green, because a checker that
 * rejects everything discriminates nothing.
 *
 * Mutations edit the parsed artifact rather than its text, and the premise and seam each
 * case bends are chosen out of the committed artifact rather than named here: a premise
 * renamed or re-channelled moves the case instead of silently emptying it.
 */
describe("substrate contract gate", subprocessTestOptions, () => {
    test("agrees with the committed discharge map", () => {
        const result = runQualitySubprocess(process.execPath, [checker], packageRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("discharge map agrees with the ledger");
    });

    test("refuses a premise whose discharge citation resolves to no conformance row", () => {
        const premise = atomPremise();
        const name = stringAt(premise, "premise");
        const retired = `${stringAt(premise, "atom")}-RETIRED`;

        const stale = mutate((artifact) => {
            rowOf(artifact, "premises", "premise", name)["atom"] = retired;
        });

        expect(stale.status).not.toBe(0);
        expect(stale.output).toContain(
            `premise ${name} cites ${retired}, which no indexed fragment carries`
        );
    });

    test("refuses a premise recorded below the status the ledger carries", () => {
        const premise = atomPremise();
        const name = stringAt(premise, "premise");
        const atom = stringAt(premise, "atom");
        const recorded = stringAt(premise, "atomStatus");

        const demoted = mutate((artifact) => {
            rowOf(artifact, "premises", "premise", name)["atomStatus"] = demotedStatus;
        });

        expect(demoted.status).not.toBe(0);
        expect(demoted.output).toContain(
            `premise ${name} records ${atom} as ${demotedStatus}; the ledger says ${recorded}`
        );
    });

    test("refuses a seam that drops its witness debt for a theorem Witness.lean lacks", () => {
        const name = stringAt(owedSeam(), "seam");
        // The name a reader would expect this seam's witness to carry, asserted absent from
        // the witness source so the case is about the claim and not about a name that
        // happens to exist.
        const claimed = `AgentCore.Substrate.Witness.${name}_laws`;
        const witnessSource = readFileSync(
            resolve(packageRoot, stringAt(committed, "witnessSource")),
            "utf8"
        );
        expect(witnessSource).not.toContain(`theorem ${name}_laws`);

        const unwitnessed = mutate((artifact) => {
            rowOf(artifact, "seams", "seam", name)["witness"] = claimed;
        });

        expect(unwitnessed.status).not.toBe(0);
        expect(unwitnessed.output).toContain(
            `seam ${name} claims witness ${claimed}, absent from Witness.lean`
        );
    });

    test("refuses a seam that owes a witness and stops saying what is missing", () => {
        const name = stringAt(owedSeam(), "seam");

        const silent = mutate((artifact) => {
            rowOf(artifact, "seams", "seam", name)["owed"] = "";
        });

        expect(silent.status).not.toBe(0);
        expect(silent.output).toContain(
            `seam ${name} owes a witness and does not say what is missing`
        );
    });
});

/**
 * The first premise the committed map discharges with a conformance atom. Its citation is
 * the one an indexed fragment has to carry and whose status the gate re-reads today, so it
 * is the premise both citation cases bend.
 */
function atomPremise(): JsonObject {
    const premise = objectsAt(committed, "premises").find(
        (candidate) => candidate["channel"] === "conformanceAtom"
    );
    if (premise === undefined) {
        throw new TypeError("The committed map discharges no premise with a conformance atom");
    }
    return premise;
}

/** The first seam whose satisfiability witness the committed map records as still owed. */
function owedSeam(): JsonObject {
    const seam = objectsAt(committed, "seams").find((candidate) => candidate["witness"] === "owed");
    if (seam === undefined) throw new TypeError("The committed map records no owed witness");
    return seam;
}

/**
 * One row of the cloned artifact, found by the field that names it. Lookup is by name and
 * not by index because each case picks its premise or seam out of the committed artifact:
 * a row that moved would otherwise quietly bend a different claim than the case describes.
 */
function rowOf(
    artifact: MutableArtifact,
    field: string,
    key: string,
    name: string
): MutableArtifact {
    // SAFETY: every entry is validated as a JSON object by assertObject; the only thing
    // widened is the index signature's mutability, on a clone this file owns.
    const rows = assertArray(artifact[field], field).map(
        (entry, index) => assertObject(entry, `${field}[${index}]`) as MutableArtifact
    );
    const row = rows.find((candidate) => assertString(candidate[key], key) === name);
    if (row === undefined) throw new TypeError(`The cloned artifact has no ${key} ${name}`);
    return row;
}

/**
 * The committed artifact with one wrong claim, judged by the real checker.
 *
 * The gate resolves every input from its own module location — the artifact, the
 * conformance index and its fragments, and the Lean files the artifact names — so a case
 * cannot hand it a fixture. The scratch tree is exactly those inputs: the gate's own
 * scripts, the committed conformance directory, and the committed bytes of every cited Lean
 * source, with the mutated artifact standing in for the committed one. Nothing here reads
 * or writes the worktree's own artifact.
 */
function mutate(apply: (artifact: MutableArtifact) => void) {
    // SAFETY: a structured clone of a JsonObject is JSON data of the same shape, and this
    // copy is the call's own — nothing else reads it and the committed artifact is
    // untouched — so dropping the read-only index signature cannot affect anything else.
    const artifact = structuredClone(committed) as MutableArtifact;
    apply(artifact);
    const root = mkdtempSync(join(tmpdir(), "agent-core-substrate-contracts-"));
    temporary.push(root);
    cpSync(resolve(packageRoot, "scripts"), join(root, "scripts"), { recursive: true });
    cpSync(resolve(packageRoot, "artifacts/conformance"), join(root, "artifacts/conformance"), {
        recursive: true
    });
    for (const field of leanSources) {
        const declared = stringAt(committed, field);
        const target = join(root, declared);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(resolve(packageRoot, declared), target);
    }
    writeFileSync(
        join(root, "artifacts/substrate-contracts.json"),
        `${JSON.stringify(artifact, null, 2)}\n`,
        "utf8"
    );
    const result = runQualitySubprocess(
        process.execPath,
        [join(root, "scripts/check-substrate-contracts.mjs")],
        root
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

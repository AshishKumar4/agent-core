import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
    assertArray,
    assertObject,
    assertString,
    isNonEmptyString,
    parseCanonicalJson,
    type JsonObject,
    type JsonValue
} from "../../scripts/quality/project.mjs";
import { objectAt, objectsAt, stringAt } from "./artifacts";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

/**
 * A validated register opened for one substitution. `JsonObject`'s index signature is
 * read-only, which is right for every reader of a committed artifact and wrong for a
 * fixture whose whole job is to hold one wrong answer.
 */
type MutableRegister = { [key: string]: JsonValue };

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/heuristics.mjs");
const registerPath = resolve(packageRoot, "artifacts/quality/heuristic-register.json");
const archivePath = resolve(packageRoot, "artifacts/conformance/live-evidence/run.json");
/**
 * What a withheld row owes. Its wording is not what the archive case is about — the gate
 * only requires a withholding to state one — so it says the one thing every withheld
 * elimination in this register owes: the guess named and the naming asserted.
 */
const owedEdit = "Name the fact this row guesses at and assert the naming in its own test.";
const temporary: string[] = [];
let committed: JsonObject;
/** The source files the committed live-substrate archive fingerprints, and only those. */
let frozen: ReadonlySet<string>;

beforeAll(async () => {
    committed = assertObject(
        parseCanonicalJson(
            await readFile(registerPath, "utf8"),
            "artifacts/quality/heuristic-register.json"
        ),
        "artifacts/quality/heuristic-register.json"
    );
    const archive = assertObject(
        parseCanonicalJson(
            await readFile(archivePath, "utf8"),
            "artifacts/conformance/live-evidence/run.json"
        ),
        "artifacts/conformance/live-evidence/run.json"
    );
    frozen = new Set(Object.keys(objectAt(archive, "sourceFingerprints")));
});

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

/**
 * The gate's own discrimination. `scripts/quality/heuristics.mjs` runs four syntactic
 * detectors over both source universes and requires the register to answer every site they
 * find, exactly once, with an answer that can fail: a named premise carrying executable
 * evidence, a SPEC clause the SPEC still states, or a withholding the committed
 * live-substrate archive really freezes. The only thing that can show it is doing that is
 * an answer it refuses, so each case here substitutes exactly one wrong answer and asserts
 * the gate names it; the control asserts the committed register is green, because a
 * checker that rejects everything discriminates nothing.
 *
 * Cases edit the parsed register and point the real gate at the copy, so the detectors run
 * over the committed sources every time: what a case substitutes is the register's answer,
 * never the code it answers for. The row each case bends is chosen out of the committed
 * register rather than named here, so a fix that moves or retires a guess moves the case
 * instead of silently emptying it.
 */
describe("semantic heuristic register gate", subprocessTestOptions, () => {
    test("agrees with the committed register", () => {
        const result = judge(registerPath);

        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain("semantic heuristics registered");
        expect(result.output).toContain("0 unregistered");
    });

    test("refuses a detected heuristic the register leaves unanswered", () => {
        const site = answerable();
        const id = stringAt(site, "id");
        const file = stringAt(site, "file");
        const detector = stringAt(site, "detector");

        const unanswered = mutate((register) => {
            register["sites"] = rowsOf(register, "sites").filter(
                (row) => assertString(row["id"], "id") !== id
            );
        });

        expect(unanswered.status).not.toBe(0);
        expect(unanswered.output).toContain(
            `unregistered semantic heuristic at ${file}:${String(site["line"])} (${detector})`
        );
    });

    test("refuses a withholding the live archive does not freeze", () => {
        // The withheld disposition is the one answer that leaves a finding un-eliminated,
        // and the whole guarantee behind it is that the file's bytes really are frozen by
        // the committed archive: a withholding over a file the archive does not fingerprint
        // parks a finding nobody is stopping anyone from fixing today.
        const site = answerable();
        const id = stringAt(site, "id");
        const file = stringAt(site, "file");
        expect(frozen.has(file)).toBe(false);

        const unfrozen = mutate((register) => {
            const row = rowOf(register, "sites", "id", id);
            row["disposition"] = "withheld";
            row["frozenBy"] = file;
            row["owedEdit"] = owedEdit;
        });

        expect(unfrozen.status).not.toBe(0);
        expect(unfrozen.output).toContain(
            `heuristic site ${id} withholds behind ${file}, which the live archive does not fingerprint`
        );
    });

    test("refuses a premise the register states with no rationale", () => {
        const name = stringAt(namedPremise(), "premise");

        const unreasoned = mutate((register) => {
            rowOf(register, "premises", "premise", name)["statement"] = "";
        });

        expect(unreasoned.status).not.toBe(0);
        expect(unreasoned.output).toContain(
            "heuristic register premise statement must be a nonempty string"
        );
    });

    test("refuses a site the register answers with no rationale", () => {
        const id = stringAt(answerable(), "id");

        const unreasoned = mutate((register) => {
            rowOf(register, "sites", "id", id)["rationale"] = "";
        });

        expect(unreasoned.status).not.toBe(0);
        expect(unreasoned.output).toContain(
            `heuristic site ${id} rationale must be a nonempty string`
        );
    });
});

/**
 * The row every case bends: a detected guess, bound to a premise other rows also bind, in a
 * file the live archive does not fingerprint.
 *
 * Each condition keeps its case about the guard it names. Dropping the last row that binds
 * a premise refuses because the register would then state a premise no site binds, which is
 * a different finding; and a row inside the archive's fingerprint map cannot show the
 * archive check refusing a withholding, because that file's freeze is real.
 */
function answerable(): JsonObject {
    const sites = objectsAt(committed, "sites");
    const bindings = new Map<string, number>();
    for (const site of sites) {
        const premise = site["premise"];
        if (isNonEmptyString(premise)) bindings.set(premise, (bindings.get(premise) ?? 0) + 1);
    }
    const site = sites.find(
        (candidate) =>
            candidate["disposition"] === "bound" &&
            isNonEmptyString(candidate["detector"]) &&
            !frozen.has(stringAt(candidate, "file")) &&
            (bindings.get(stringAt(candidate, "premise")) ?? 0) > 1
    );
    if (site === undefined) {
        throw new TypeError("The register binds no detected site outside the live archive");
    }
    return site;
}

/** The premise the register states first, whose statement is the rationale case's target. */
function namedPremise(): JsonObject {
    const premise = objectsAt(committed, "premises")[0];
    if (premise === undefined) throw new TypeError("The register states no premise");
    return premise;
}

/** The same accessors `objectsAt` gives, on a register this test is about to mutate. */
function rowsOf(register: MutableRegister, field: string): MutableRegister[] {
    // SAFETY: every entry is validated as a JSON object by assertObject; the only thing
    // widened is the index signature's mutability, on a clone this file owns.
    return assertArray(register[field], field).map(
        (entry, index) => assertObject(entry, `${field}[${index}]`) as MutableRegister
    );
}

/**
 * One row of the cloned register, found by the field that names it. Lookup is by name and
 * not by index because each case picks its row out of the committed register: a row that
 * moved would otherwise quietly bend a different answer than the case describes.
 */
function rowOf(
    register: MutableRegister,
    field: string,
    key: string,
    name: string
): MutableRegister {
    const row = rowsOf(register, field).find(
        (candidate) => assertString(candidate[key], key) === name
    );
    if (row === undefined) throw new TypeError(`The cloned register has no ${key} ${name}`);
    return row;
}

/**
 * The real gate over one register, with its report written outside the worktree.
 *
 * `--register` is the gate's own option, so a case needs no scratch tree: the detectors,
 * the SPEC, the substrate premise table and the live archive are all the committed ones.
 * `--report-root` keeps a case from overwriting the report the gate itself publishes.
 */
function judge(register: string) {
    const reports = mkdtempSync(join(tmpdir(), "agent-core-heuristics-reports-"));
    temporary.push(reports);
    const result = runQualitySubprocess(
        process.execPath,
        [checker, "--stage", "building", "--register", register, "--report-root", reports],
        packageRoot
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The committed register with one wrong answer, judged by the real gate. */
function mutate(apply: (register: MutableRegister) => void) {
    // SAFETY: a structured clone of a JsonObject is JSON data of the same shape, and this
    // copy is the call's own — nothing else reads it and the committed register is
    // untouched — so dropping the read-only index signature cannot affect anything else.
    const register = structuredClone(committed) as MutableRegister;
    apply(register);
    const root = mkdtempSync(join(tmpdir(), "agent-core-heuristic-register-"));
    temporary.push(root);
    const path = join(root, "heuristic-register.json");
    writeFileSync(path, `${JSON.stringify(register, null, 2)}\n`, "utf8");
    return judge(path);
}

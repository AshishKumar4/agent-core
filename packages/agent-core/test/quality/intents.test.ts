import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

/**
 * Hostile tests for the ratified-intent gate (`scripts/quality/intents.mjs`).
 *
 * The language itself is hostile-tested inside Lean — `formal/SpecCnl/Intent/Hostile.lean`
 * fails the Lean build if an ambiguous intent is admitted, a negative sentence survives, a
 * verdict drifts from its record, or a surface acquires both a transition family and a
 * guard. What can only be tested here is the gate's own behaviour against a report: a
 * flipped verdict, a dropped witness, an unknown anchored atom, a stale SPEC digest, an
 * UNPROVED verdict reaching the artifact, an adversarial record that anchors, and a
 * snapshot that no longer matches what Lean emitted.
 *
 * Each case runs the real checker with `--artifact-root` pointed at a scratch copy of
 * `artifacts/intents`, so nothing here can damage the reviewed artifact. `LEAN_LAKE` points
 * at a stub whose report is the captured output of one real
 * `lake env lean SpecCnl/Intent/Report.lean` run — or a mutated one — so the cases exercise
 * exactly what the gate does with a report rather than re-running Lean per case.
 *
 * Every mutation below is one a green run cannot distinguish from a healthy tree without
 * the check it targets. That is the point: a gate whose refusals are unreachable looks
 * identical to a gate that works.
 */

const packageRoot = resolve(import.meta.dirname, "..", "..");
const checker = resolve(packageRoot, "scripts", "quality", "intents.mjs");
const artifactSource = resolve(packageRoot, "artifacts", "intents");

interface GateRun {
    status: number | null;
    stdout: string;
    stderr: string;
}

interface LedgerRecord {
    key: string;
    digest: string;
    expected: string;
    verdict: string;
    specAtoms: string[];
    witnessProof: string | null;
    refutationProof: string | null;
    witnesses: Array<{ permission: string; instance: string }>;
    core: string[];
}

interface Ledger {
    records: LedgerRecord[];
    adversarialRecords: LedgerRecord[];
    unexercisedEntries: string[];
    entries: Array<{ id: string }>;
    ledgers: Array<{ key: string; soundness: string; step: string }>;
}

async function prepareScratch(): Promise<string> {
    const scratch = await mkdtemp(resolve(tmpdir(), "agent-core-intents-"));
    await cp(artifactSource, resolve(scratch), { recursive: true });
    return scratch;
}

let previousLake: string | undefined;

/** Points `LEAN_LAKE` at a stub whose report is `stdout`, so a fixture mutation decides
 * what Lean "said" instead of re-running the elaborator per case. */
async function stubLake(scratch: string, stdout: string): Promise<void> {
    const bin = resolve(scratch, "fake-lake");
    const script = [
        "#!/bin/sh",
        "cat <<'INTENT_REPORT_EOF'",
        stdout.trimEnd(),
        "INTENT_REPORT_EOF"
    ].join("\n");
    await writeFile(bin, `${script}\n`, { mode: 0o755 });
    previousLake = process.env["LEAN_LAKE"];
    process.env["LEAN_LAKE"] = bin;
}

function runGate(root: string): GateRun {
    return runQualitySubprocess(
        process.execPath,
        [checker, "--artifact-root", root],
        packageRoot,
        subprocessTestOptions.timeout
    );
}

const recordedReport: string = (() => {
    const result = runQualitySubprocess(
        process.env["LEAN_LAKE"]?.trim() || "lake",
        ["env", "lean", join("SpecCnl", "Intent", "Report.lean")],
        resolve(packageRoot, "formal"),
        180_000
    );
    if (result.status !== 0) {
        throw new Error(`the real Lean intent report failed to run: ${result.stderr}`);
    }
    return result.stdout;
})();

function ledgerLine(output: string): string {
    const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith("intent-ledger "));
    if (line === undefined) throw new Error("the recorded report carries no intent-ledger line");
    return line.slice("intent-ledger ".length);
}

/** The recorded report's ledger, parsed fresh so each case mutates only its own copy. */
function parseLedger(): Ledger {
    // SAFETY: the recorded report's ledger line is the gate's own emitted JSON, and the
    // clean case below runs the gate over it unmodified before any fixture mutates a copy.
    // Each call parses fresh, which is the contract: a case must not see another's edits.
    return JSON.parse(ledgerLine(recordedReport)) as Ledger;
}

function reportOf(ledger: Ledger): string {
    const designations = recordedReport
        .split(/\r?\n/u)
        .filter((line) => !line.includes("intent-ledger "))
        .join("\n");
    return `${designations}\nintent-ledger ${JSON.stringify(ledger)}`;
}

/** The first element of a recorded list, or a failure naming what was absent. An empty list
 * would make the perturbation a no-op and the case would pass while testing nothing. */
function first<Element>(elements: readonly Element[], what: string): Element {
    const [element] = elements;
    if (element === undefined) throw new Error(`the recorded report carries no ${what}`);
    return element;
}

function recordNamed(ledger: Ledger, key: string): LedgerRecord {
    const found = [...ledger.records, ...ledger.adversarialRecords].find(
        (candidate) => candidate.key === key
    );
    if (found === undefined) throw new Error(`the recorded report carries no record ${key}`);
    return found;
}

describe("ratified intent gate", () => {
    let scratch: string;

    afterEach(async () => {
        if (previousLake !== undefined) {
            if (previousLake === "") delete process.env["LEAN_LAKE"];
            else process.env["LEAN_LAKE"] = previousLake;
            previousLake = undefined;
        }
        if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    });

    test("accepts the current tree and refuses a stale pin", async () => {
        scratch = await prepareScratch();
        await stubLake(scratch, recordedReport);
        const clean = runGate(scratch);
        expect(clean.status).toBe(0);
        expect(clean.stdout).toContain("ratified intents verified");
        expect(clean.stdout).toContain("1 inconsistent, 1 outside-model");

        const ledgerPath = resolve(scratch, "ledger.json");
        // SAFETY: the scratch snapshot is this test's own copy of an artifact the gate's own
        // byte comparison accepted one line above.
        const stale = JSON.parse(await readFile(ledgerPath, "utf8")) as {
            heads: Array<{ denotation: string }>;
        };
        first(stale.heads, "pinned heads").denotation = "sha256:0";
        await writeFile(ledgerPath, `${JSON.stringify(stale, null, 2)}\n`);
        const refused = runGate(scratch);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("artifacts/intents/ledger.json is stale");
        expect(refused.stderr).toContain("no longer matches what the instrument decides");
    });

    test("refuses a flipped verdict", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        // The inconsistent record now claims to be consistent. Lean would refuse the build,
        // because the search's proposal and the record's expectation disagree; this is the
        // gate's own copy of that rule, and without it a report could carry a verdict the
        // instrument never decided.
        const record = recordNamed(ledger, "INT_ADV_EARLY_LATE_RECLAIM");
        record.verdict = "CONSISTENT";
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("expects INCONSISTENT but the instrument decided CONSISTENT");
    });

    test("refuses a dropped witness", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        // A CONSISTENT verdict whose witness theorem is gone. This is the shape UNPROVED is
        // meant to have: the search still finds an instance, but nothing kernel-checked
        // stands behind it, so the verdict may not be reported as decided.
        const record = recordNamed(ledger, "INT_LEASE_RECLAIM");
        record.witnessProof = null;
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("is CONSISTENT but names no witnessProof");
        expect(run.stderr).toContain("kernel-checked witness or refutation");
    });

    test("refuses a CONSISTENT verdict with no exhibited instance", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        // A CONSISTENT verdict is an exhibited transition, never bounded exhaustion. A
        // report with no witness instance is a report claiming consistency from having
        // looked and not found a counterexample, which is the one thing this checker must
        // never accept.
        recordNamed(ledger, "INT_LEASE_RECLAIM").witnesses = [];
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("exhibits no witness transition");
        expect(run.stderr).toContain("never bounded exhaustion");
    });

    test("refuses a refutation with no minimal core", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        recordNamed(ledger, "INT_ADV_UNHELD_RECLAIM").core = [];
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("reports no minimal core");
    });

    test("refuses an unknown anchored atom", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        recordNamed(ledger, "INT_LEASE_RECLAIM").specAtoms = ["C13-NOT-AN-ATOM"];
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("anchors a non-reviewed atom: C13-NOT-AN-ATOM");
    });

    test("refuses a record whose SPEC digest went stale", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        const record = recordNamed(ledger, "INT_LEASE_RECLAIM");
        const { digest } = record;
        record.digest = `${digest.slice(0, 63)}${digest.endsWith("0") ? "1" : "0"}`;
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("is stale");
        expect(run.stderr).toContain("must be revisited against the new prose");
    });

    test("refuses UNPROVED reaching the artifact", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        // UNPROVED is the absence of a claim. Lean refuses a record that expects it, so the
        // only way to reach the gate's own copy of that rule is a report in which one
        // already holds it.
        const record = recordNamed(ledger, "INT_ADV_BOUNDED_RECLAIM");
        record.expected = "UNPROVED";
        record.verdict = "UNPROVED";
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("which is not a decided verdict");
    });

    test("refuses an adversarial record that anchors a conformance atom", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        recordNamed(ledger, "INT_ADV_UNHELD_RECLAIM").specAtoms = ["C13-TURN-LEASE-EXPIRY"];
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("anchors conformance atoms");
    });

    test("refuses a ledger row binding an undesignated theorem", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        // The manifest pins a theorem's statement under `designations[]`, not under
        // `declarations[]`, so a row naming a theorem nothing designates would otherwise
        // pass every other check here.
        first(ledger.ledgers, "ledger rows").soundness = "AgentCore.notATheorem";
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("binds theorem AgentCore.notATheorem");
        expect(run.stderr).toContain("have to be reviewed claims");
    });

    test("refuses an undemonstrated intent entry", async () => {
        scratch = await prepareScratch();
        const ledger = parseLedger();
        // Lean refuses the build outright when a paradigm cell no sentence uses ships, so
        // the only way to see the gate's own copy of that rule is a report in which one
        // already has.
        const orphan = first(ledger.entries, "intent entries").id;
        ledger.unexercisedEntries.push(orphan);
        await stubLake(scratch, reportOf(ledger));
        const run = runGate(scratch);
        expect([run.status, run.stderr]).toEqual([
            1,
            expect.stringContaining(`unexercised intent entries: ${orphan}`)
        ]);
    });

    test("refuses an absent snapshot unless an update is asked for", async () => {
        scratch = await prepareScratch();
        await stubLake(scratch, recordedReport);
        await rm(resolve(scratch, "ledger.json"));
        const absent = runGate(scratch);
        expect(absent.status).toBe(1);
        expect(absent.stderr).toContain("is absent");
        expect(absent.stderr).toContain("--update");

        const updated = runQualitySubprocess(
            process.execPath,
            [checker, "--artifact-root", scratch, "--update"],
            packageRoot,
            subprocessTestOptions.timeout
        );
        expect(updated.status).toBe(0);
        const restored = runGate(scratch);
        expect(restored.status).toBe(0);
    });
});

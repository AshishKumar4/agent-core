import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

/**
 * Hostile tests for the controlled-language gate (`scripts/quality/cnl.mjs`).
 *
 * The grammar itself is hostile-tested inside Lean — `formal/SpecCnl/Hostile.lean` fails
 * the Lean build if a negative case is admitted or a scramble survives. What can only be
 * tested here is the gate's own behaviour against its inputs: a stale rule-unit digest, a
 * shrunk denominator, an unjustified exclusion, an unaudited bridge, and a ledger
 * snapshot that no longer matches what Lean emitted.
 *
 * Following the house fixture pattern, each case runs the real checker with
 * `--artifact-root` pointed at a scratch copy of `artifacts/cnl`, so nothing here can
 * damage the reviewed artifacts. `LEAN_LAKE` points at a stub whose report is the captured
 * output of one real `lake env lean SpecCnl/Report.lean` run — or a mutated one — so the
 * cases exercise exactly what the gate does with a report rather than re-running Lean per
 * case.
 */

const packageRoot = resolve(import.meta.dirname, "..", "..");
const checker = resolve(packageRoot, "scripts", "quality", "cnl.mjs");
const artifactSource = resolve(packageRoot, "artifacts", "cnl");

interface GateRun {
    status: number | null;
    stdout: string;
    stderr: string;
}

async function prepareScratch(): Promise<string> {
    const scratch = await mkdtemp(resolve(tmpdir(), "agent-core-cnl-"));
    await cp(artifactSource, resolve(scratch), { recursive: true });
    return scratch;
}

let previousLake: string | undefined;

/** Points `LEAN_LAKE` at a stub whose report is `stdout`, so a fixture mutation decides
 * what Lean "said" instead of re-running the elaborator per case. */
async function stubLake(scratch: string, stdout: string): Promise<void> {
    const bin = resolve(scratch, "fake-lake");
    const script = ["#!/bin/sh", "cat <<'CNL_REPORT_EOF'", stdout.trimEnd(), "CNL_REPORT_EOF"].join(
        "\n"
    );
    await writeFile(bin, `${script}\n`, { mode: 0o755 });
    previousLake = process.env.LEAN_LAKE;
    process.env.LEAN_LAKE = bin;
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
        process.env.LEAN_LAKE?.trim() || "lake",
        ["env", "lean", join("SpecCnl", "Report.lean")],
        resolve(packageRoot, "formal"),
        120_000
    );
    if (result.status !== 0) {
        throw new Error(`the real Lean report failed to run: ${result.stderr}`);
    }
    return result.stdout;
})();

function ledgerLine(output: string): string {
    const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith("cnl-ledger "));
    if (line === undefined) throw new Error("the recorded report carries no cnl-ledger line");
    return line.slice("cnl-ledger ".length);
}

describe("controlled language gate", () => {
    let scratch: string;

    afterEach(async () => {
        if (previousLake !== undefined) {
            if (previousLake === "") delete process.env.LEAN_LAKE;
            else process.env.LEAN_LAKE = previousLake;
            previousLake = undefined;
        }
        if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    });

    test("accepts the current tree and refuses a stale snapshot", async () => {
        scratch = await prepareScratch();
        await stubLake(scratch, recordedReport);
        const clean = runGate(scratch);
        expect(clean.status).toBe(0);
        expect(clean.stdout).toContain("controlled language verified");

        const ledgerPath = resolve(scratch, "ledger.json");
        // SAFETY: the scratch ledger is this test's own copy of an artifact whose
        // canonical form check-normative-style parsing already validated on acceptance.
        const stale = JSON.parse(await readFile(ledgerPath, "utf8")) as {
            units: Array<{ sentence: string }>;
        };
        stale.units[0].sentence = "ancestry depends only on the heads";
        await writeFile(ledgerPath, `${JSON.stringify(stale, null, 2)}\n`);
        const refused = runGate(scratch);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("artifacts/cnl/ledger.json is stale");
    });

    test("refuses a unit whose SPEC digest went stale", async () => {
        scratch = await prepareScratch();
        // SAFETY: recordedReport is captured from a real Lean run at module load; its
        // ledger line parsed successfully inside the gate before any fixture runs.
        const parsed = JSON.parse(ledgerLine(recordedReport)) as {
            units: Array<{ key: string; digest: string }>;
        };
        const digest = parsed.units[0].digest;
        parsed.units[0].digest = `${digest.slice(0, 63)}${digest.endsWith("0") ? "1" : "0"}`;
        await stubLake(scratch, `cnl-ledger ${JSON.stringify(parsed)}`);
        const run = runGate(scratch);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("is stale");
        expect(run.stderr).toContain("must be revisited");
    });

    test("refuses a shrinking denominator and an unjustified exclusion", async () => {
        scratch = await prepareScratch();
        await stubLake(scratch, recordedReport);
        const path = resolve(scratch, "exclusions.json");
        // SAFETY: the scratch record is this test's own copy of exclusions.json, whose
        // exact-field shape the gate itself enforced when the tree was accepted.
        const record = JSON.parse(await readFile(path, "utf8")) as { reachableFloor: number };
        record.reachableFloor += 1;
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
        const shrunk = runGate(scratch);
        expect(shrunk.status).toBe(1);
        expect(shrunk.stderr).toContain("reachable denominator shrank");

        // SAFETY: same scratch record as above, re-read after this test's own write.
        const unjustified = JSON.parse(await readFile(path, "utf8")) as {
            exclusions: Array<{ atoms: string[]; reason: string }>;
            reachableFloor: number;
        };
        unjustified.exclusions.push({ atoms: ["C13-RUN-ANCESTRY"], reason: "embedded-table" });
        unjustified.reachableFloor -= 1;
        await writeFile(path, `${JSON.stringify(unjustified, null, 2)}\n`);
        const refused = runGate(scratch);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("is unjustified");
    });

    test("refuses an unaudited bridge and a sorry dependency", async () => {
        scratch = await prepareScratch();
        // SAFETY: recordedReport is captured from a real Lean run at module load; its
        // ledger line parsed successfully inside the gate before any fixture runs.
        const parsed = JSON.parse(ledgerLine(recordedReport)) as {
            units: Array<{ discharge: string }>;
            auditedNames: string[];
        };
        const discharge = parsed.units[0].discharge;
        parsed.auditedNames = parsed.auditedNames.filter((name) => name !== discharge);
        await stubLake(scratch, `cnl-ledger ${JSON.stringify(parsed)}`);
        const unaudited = runGate(scratch);
        expect(unaudited.status).toBe(1);
        expect(unaudited.stderr).toContain("is not audited");

        scratch = await prepareScratch();
        // SAFETY: recordedReport is captured from a real Lean run at module load; its
        // ledger line parsed successfully inside the gate before any fixture runs.
        const sorried = JSON.parse(ledgerLine(recordedReport)) as { auditedNames: string[] };
        const designated = sorried.auditedNames[0];
        await stubLake(
            scratch,
            `'${designated}' depends on axioms: [sorryAx]\ncnl-ledger ${ledgerLine(recordedReport)}`
        );
        const refused = runGate(scratch);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("non-reviewed axiom sorryAx");
    });

    test("refuses a bridge over an excluded rule unit and a silent adversarial decay", async () => {
        scratch = await prepareScratch();
        await stubLake(scratch, recordedReport);
        const path = resolve(scratch, "exclusions.json");
        // SAFETY: the scratch record is this test's own copy of exclusions.json, whose
        // exact-field shape the gate itself enforced when the tree was accepted.
        const record = JSON.parse(await readFile(path, "utf8")) as {
            exclusions: Array<{ atoms: string[]; reason: string }>;
            reachableFloor: number;
        };
        record.exclusions.push({ atoms: ["C13-RUN-ANCESTRY"], reason: "embedded-table" });
        record.reachableFloor -= 1;
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
        const run = runGate(scratch);
        expect([run.status, run.stderr]).toEqual([
            1,
            expect.stringContaining("bridges a hard-excluded rule unit")
        ]);

        scratch = await prepareScratch();
        // SAFETY: recordedReport is captured from a real Lean run at module load; its
        // ledger line parsed successfully inside the gate before any fixture runs.
        const parsed = JSON.parse(ledgerLine(recordedReport)) as {
            adversarial: { scramblesAdmitted: number };
        };
        parsed.adversarial.scramblesAdmitted = 1;
        await stubLake(scratch, `cnl-ledger ${JSON.stringify(parsed)}`);
        const decayed = runGate(scratch);
        expect(decayed.status).toBe(1);
        expect(decayed.stderr).toContain("scrambles were admitted");
    });
});

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { verifyCompletionArtifacts } from "../../scripts/quality/completion.mjs";
import {
    outcomeFingerprint,
    surveyOutcomes,
    updateOutcomeBaseline,
    verifyOutcomeLedger
} from "../../scripts/quality/outcome-baseline.mjs";
import type { OutcomeBaseline } from "../../scripts/quality/outcome-baseline.mjs";

// One real repository: a ratification commit pinning reviewed.txt, then a later commit
// that evolves the file — the exact shape in which pins get laundered.
const fixture = (() => {
    const root = mkdtempSync(join(tmpdir(), "outcome-baseline-"));
    const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
        return result.stdout.trim();
    };
    git("init");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("config", "commit.gpgsign", "false");
    const ratifiedContent = "ratified content\n";
    writeFileSync(join(root, "reviewed.txt"), ratifiedContent);
    git("add", "reviewed.txt");
    git("commit", "-m", "ratify");
    const ratification = git("rev-parse", "HEAD");
    const tree = git("show", "-s", "--format=%T", "HEAD");
    const blob = git("rev-parse", "HEAD:reviewed.txt");
    const evolvedContent = "evolved content\n";
    writeFileSync(join(root, "reviewed.txt"), evolvedContent);
    git("add", "reviewed.txt");
    git("commit", "-m", "evolve");
    const evolvedBlob = git("rev-parse", "HEAD:reviewed.txt");
    const digest = (content: string) => createHash("sha256").update(content).digest("hex");
    return {
        root,
        ratification,
        tree,
        pin: { path: "reviewed.txt", blob, sha256: digest(ratifiedContent) },
        evolvedPin: { path: "reviewed.txt", blob: evolvedBlob, sha256: digest(evolvedContent) },
        lostCommit: "a3f81b2c9d04e5f6a7b8c9d0e1f2a3b4c5d6e7f8"
    };
})();

function outcome(overrides: Record<string, unknown> = {}) {
    return {
        kind: "applied",
        treatment: "accepted",
        commit: fixture.ratification,
        tree: fixture.tree,
        rationale: "ratified review",
        tests: [],
        checks: [],
        artifacts: [fixture.pin],
        items: [],
        ...overrides
    };
}

function ledger(...outcomes: Array<Record<string, unknown>>) {
    return {
        entries: outcomes.map((value, index) => ({
            source: `requests/w${index}.json`,
            state: "applied",
            outcome: value
        }))
    };
}

describe("ratification-bound artifact pins", () => {
    test("accepts pins that match their ratification commit and reports them verifiable", () => {
        expect(verifyCompletionArtifacts("fixture", outcome(), fixture.root)).toBe(true);
    });

    test("accepts intact digests under a lost ratification and reports them unverifiable", () => {
        const lost = outcome({ commit: fixture.lostCommit });
        expect(verifyCompletionArtifacts("fixture", lost, fixture.root)).toBe(false);
    });

    test("rejects a pin re-pointed at later content while its ratification commit resolves", () => {
        const laundered = outcome({ artifacts: [fixture.evolvedPin] });
        expect(() => verifyCompletionArtifacts("fixture", laundered, fixture.root)).toThrow(
            /differs from its ratification commit: reviewed\.txt/
        );
    });

    test("rejects a record whose tree disagrees with its ratification commit", () => {
        const inconsistent = outcome({ tree: "b".repeat(40) });
        expect(() => verifyCompletionArtifacts("fixture", inconsistent, fixture.root)).toThrow(
            /tree differs from its ratification commit/
        );
    });

    test("rejects a pin whose path is absent from the ratification commit", () => {
        const phantom = outcome({ artifacts: [{ ...fixture.pin, path: "phantom.txt" }] });
        expect(() => verifyCompletionArtifacts("fixture", phantom, fixture.root)).toThrow(
            /differs from its ratification commit: phantom\.txt/
        );
    });

    test("rejects a stale digest even when the ratification commit is lost", () => {
        const stale = outcome({
            commit: fixture.lostCommit,
            artifacts: [{ ...fixture.pin, sha256: "c".repeat(64) }]
        });
        expect(() => verifyCompletionArtifacts("fixture", stale, fixture.root)).toThrow(
            /digest is stale/
        );
    });

    test("rejects a pinned blob absent from the object store", () => {
        const missing = outcome({
            commit: fixture.lostCommit,
            artifacts: [{ ...fixture.pin, blob: "d".repeat(40) }]
        });
        expect(() => verifyCompletionArtifacts("fixture", missing, fixture.root)).toThrow(
            /blob is unavailable/
        );
    });
});

describe("outcome ledger tamper evidence", () => {
    const reason = "lineage squashed by the published snapshot";
    const mixed = ledger(outcome(), outcome({ commit: fixture.lostCommit }));
    const baseline = updateOutcomeBaseline(mixed, undefined, reason, fixture.root).baseline;

    test("accepts a ledger that matches its baseline and surfaces the unverifiable count", () => {
        expect(verifyOutcomeLedger(mixed, baseline, fixture.root)).toEqual({
            recorded: 2,
            ratified: 1,
            unverifiable: 1,
            signed: 0
        });
    });

    test("rejects an unverifiable outcome whose record was rewritten", () => {
        const laundered = ledger(
            outcome(),
            outcome({ commit: fixture.lostCommit, artifacts: [fixture.evolvedPin] })
        );
        expect(() => verifyOutcomeLedger(laundered, baseline, fixture.root)).toThrow(
            /differs from its baseline fingerprint/
        );
    });

    test("rejects an outcome the baseline does not record", () => {
        const grown = ledger(outcome(), outcome({ commit: fixture.lostCommit }), outcome());
        expect(() => verifyOutcomeLedger(grown, baseline, fixture.root)).toThrow(
            /not in the outcome baseline/
        );
    });

    test("rejects a recorded outcome the ledger no longer contains", () => {
        const erased = ledger(outcome());
        expect(() => verifyOutcomeLedger(erased, baseline, fixture.root)).toThrow(
            /erasing ratified evidence/
        );
    });

    test("rejects a ratification recorded verifiable once its commit stops resolving", () => {
        const survey = surveyOutcomes(ledger(outcome({ commit: fixture.lostCommit })), fixture.root);
        const stale: OutcomeBaseline = {
            edition: "1.0.0",
            outcomes: [{ ...survey[0]!, ratification: "commit" }]
        };
        expect(() =>
            verifyOutcomeLedger(ledger(outcome({ commit: fixture.lostCommit })), stale, fixture.root)
        ).toThrow(/no longer resolves/);
    });

    test("rejects a ratification recorded lost once its commit resolves again", () => {
        const survey = surveyOutcomes(ledger(outcome()), fixture.root);
        const stale: OutcomeBaseline = {
            edition: "1.0.0",
            outcomes: [{ ...survey[0]!, ratification: "lost", reason }]
        };
        expect(() => verifyOutcomeLedger(ledger(outcome()), stale, fixture.root)).toThrow(
            /verifiable again/
        );
    });

    test("rejects an unverifiable outcome without a recorded reason", () => {
        const survey = surveyOutcomes(ledger(outcome({ commit: fixture.lostCommit })), fixture.root);
        const unreasoned: OutcomeBaseline = { edition: "1.0.0", outcomes: [survey[0]!] };
        expect(() =>
            verifyOutcomeLedger(
                ledger(outcome({ commit: fixture.lostCommit })),
                unreasoned,
                fixture.root
            )
        ).toThrow(/without a recorded reason/);
    });

    test("never accepts a pin that disagrees with a resolvable ratification, baseline or not", () => {
        const forged = ledger(outcome({ artifacts: [fixture.evolvedPin] }));
        const blessed: OutcomeBaseline = {
            edition: "1.0.0",
            outcomes: [
                {
                    source: "requests/w0.json",
                    commit: fixture.ratification,
                    sha256: outcomeFingerprint(forged.entries[0]!.outcome),
                    ratification: "commit"
                }
            ]
        };
        expect(() => verifyOutcomeLedger(forged, blessed, fixture.root)).toThrow(
            /differs from its ratification commit/
        );
    });
});

describe("reasoned baseline updates", () => {
    const reason = "why the evidence weakened";

    test("records new verifiable outcomes without a reason", () => {
        const update = updateOutcomeBaseline(ledger(outcome()), undefined, undefined, fixture.root);
        expect(update.additions).toEqual(["requests/w0.json"]);
        expect(update.regressions).toEqual([]);
        expect(update.baseline.outcomes[0]).toMatchObject({ ratification: "commit" });
        expect(update.baseline.outcomes[0]!.reason).toBeUndefined();
    });

    test("requires a reason to record an unverifiable outcome and stamps it on the entry", () => {
        const lost = ledger(outcome({ commit: fixture.lostCommit }));
        expect(() => updateOutcomeBaseline(lost, undefined, undefined, fixture.root)).toThrow(
            /--accept-rewrite/
        );
        const update = updateOutcomeBaseline(lost, undefined, reason, fixture.root);
        expect(update.regressions).toEqual([
            "requests/w0.json: recorded with an unresolvable ratification"
        ]);
        expect(update.baseline.outcomes[0]).toMatchObject({ ratification: "lost", reason });
    });

    test("refuses to rewrite a recorded outcome without a reason", () => {
        const original = ledger(outcome({ commit: fixture.lostCommit }));
        const previous = updateOutcomeBaseline(original, undefined, reason, fixture.root).baseline;
        const rewritten = ledger(
            outcome({ commit: fixture.lostCommit, artifacts: [fixture.evolvedPin] })
        );
        expect(() => updateOutcomeBaseline(rewritten, previous, undefined, fixture.root)).toThrow(
            /outcome record rewritten/
        );
        const accepted = updateOutcomeBaseline(rewritten, previous, "review redone", fixture.root);
        expect(accepted.baseline.outcomes[0]).toMatchObject({ reason: "review redone" });
    });

    test("refuses to remove a recorded outcome without a reason", () => {
        const previous = updateOutcomeBaseline(
            ledger(outcome(), outcome({ commit: fixture.lostCommit })),
            undefined,
            reason,
            fixture.root
        ).baseline;
        expect(() =>
            updateOutcomeBaseline(ledger(outcome()), previous, undefined, fixture.root)
        ).toThrow(/recorded outcome removed/);
        const accepted = updateOutcomeBaseline(ledger(outcome()), previous, reason, fixture.root);
        expect(accepted.baseline.outcomes).toHaveLength(1);
    });

    test("re-pins a restored ratification freely and drops its loss reason", () => {
        const survey = surveyOutcomes(ledger(outcome()), fixture.root);
        const previous: OutcomeBaseline = {
            edition: "1.0.0",
            outcomes: [{ ...survey[0]!, ratification: "lost", reason }]
        };
        const update = updateOutcomeBaseline(ledger(outcome()), previous, undefined, fixture.root);
        expect(update.restorations).toEqual(["requests/w0.json"]);
        expect(update.regressions).toEqual([]);
        expect(update.baseline.outcomes[0]).toMatchObject({ ratification: "commit" });
        expect(update.baseline.outcomes[0]!.reason).toBeUndefined();
    });

    test("carries recorded reasons forward while the record is unchanged", () => {
        const lost = ledger(outcome({ commit: fixture.lostCommit }));
        const previous = updateOutcomeBaseline(lost, undefined, reason, fixture.root).baseline;
        const update = updateOutcomeBaseline(lost, previous, undefined, fixture.root);
        expect(update.regressions).toEqual([]);
        expect(update.baseline.outcomes[0]).toMatchObject({ reason });
    });
});

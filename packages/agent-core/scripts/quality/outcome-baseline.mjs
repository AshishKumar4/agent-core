import { verifyCompletionArtifacts } from "./completion.mjs";
import { compareCanonicalText, isNonEmptyString, repositoryRoot, sha256 } from "./project.mjs";

// The outcome baseline makes the resolutions ledger tamper-evident. Every recorded
// outcome is the immutable history of one ratified review: its artifact pins are bound
// to its own ratification commit wherever that commit still resolves, and the whole
// record is fingerprinted here so an outcome cannot be rewritten, removed, or recorded
// beyond verification without an explicit, reason-bearing acknowledgment. Adding
// verifiable evidence is free; destroying or weakening it is not.
const updateCommand = "node scripts/quality/integration.mjs --update-outcomes";
const acknowledgeFlag = '--accept-rewrite "<reason>"';

export function outcomeFingerprint(outcome) {
    return sha256(JSON.stringify(outcome));
}

// Verifies every recorded outcome's artifact provenance and classifies its
// ratification: "commit" (resolves and every pin matches it), "lost" (the published
// snapshot squashed the lineage; the record's digests are the only surviving
// fingerprint), or "signature" (external waivers carry no commit). Throws on any pin
// that disagrees with a resolvable ratification commit — that state is never
// acknowledgeable, because the truth is derivable.
export function surveyOutcomes(resolutions, root = repositoryRoot) {
    const entries = [];
    const seen = new Set();
    for (const entry of resolutions.entries) {
        if (Array.isArray(entry) || entry.outcome === undefined) continue;
        if (seen.has(entry.source)) {
            throw new TypeError(`Resolution ledger records ${entry.source} twice`);
        }
        seen.add(entry.source);
        const outcome = entry.outcome;
        if (outcome.kind === "external-waiver") {
            entries.push({
                source: entry.source,
                commit: null,
                sha256: outcomeFingerprint(outcome),
                ratification: "signature"
            });
            continue;
        }
        const ratified = verifyCompletionArtifacts(`${entry.source} outcome`, outcome, root);
        entries.push({
            source: entry.source,
            commit: outcome.commit,
            sha256: outcomeFingerprint(outcome),
            ratification: ratified ? "commit" : "lost"
        });
    }
    return entries;
}

// The gate: the ledger must agree with its baseline exactly. An unverifiable outcome is
// louder than a violated one — it must be enumerated in the baseline with a recorded
// reason, never skipped.
export function verifyOutcomeLedger(resolutions, baseline, root = repositoryRoot) {
    if (baseline.edition !== "1.0.0" || !Array.isArray(baseline.outcomes)) {
        throw new TypeError("Outcome baseline is malformed");
    }
    const recorded = new Map();
    for (const pinned of baseline.outcomes) {
        if (recorded.has(pinned.source)) {
            throw new TypeError(`Outcome baseline records ${pinned.source} twice`);
        }
        recorded.set(pinned.source, pinned);
    }
    const actual = surveyOutcomes(resolutions, root);
    for (const entry of actual) {
        const pinned = recorded.get(entry.source);
        recorded.delete(entry.source);
        if (pinned === undefined) {
            throw new TypeError(
                `${entry.source} outcome is not in the outcome baseline; record it with ${updateCommand}`
            );
        }
        if (pinned.sha256 !== entry.sha256 || pinned.commit !== entry.commit) {
            throw new TypeError(
                `${entry.source} outcome differs from its baseline fingerprint; ` +
                    `a ratified review's record may only change through ${updateCommand} ${acknowledgeFlag}`
            );
        }
        if (pinned.ratification !== entry.ratification) {
            throw new TypeError(
                entry.ratification === "lost"
                    ? `${entry.source} ratification commit no longer resolves; ` +
                          `acknowledge the loss with ${updateCommand} ${acknowledgeFlag}`
                    : `${entry.source} ratification is verifiable again; ` +
                          `re-pin the baseline with ${updateCommand}`
            );
        }
        if (entry.ratification === "lost" && !isNonEmptyString(pinned.reason)) {
            throw new TypeError(
                `${entry.source} outcome is unverifiable without a recorded reason; ` +
                    `acknowledge it with ${updateCommand} ${acknowledgeFlag}`
            );
        }
    }
    for (const source of recorded.keys()) {
        throw new TypeError(
            `${source} outcome was removed from the resolution ledger; ` +
                `erasing ratified evidence requires ${updateCommand} ${acknowledgeFlag}`
        );
    }
    return {
        recorded: actual.length,
        ratified: actual.filter((entry) => entry.ratification === "commit").length,
        unverifiable: actual.filter((entry) => entry.ratification === "lost").length,
        signed: actual.filter((entry) => entry.ratification === "signature").length
    };
}

// Rebuilds the baseline from the ledger. New verifiable evidence and restored
// ratifications re-pin freely; every regression — a rewritten record, a removed
// record, or a ratification recorded or discovered beyond verification — is named
// individually and carries its reason on the record it degraded.
export function updateOutcomeBaseline(resolutions, previous, reason, root = repositoryRoot) {
    const before = new Map((previous?.outcomes ?? []).map((entry) => [entry.source, entry]));
    const regressions = [];
    const additions = [];
    const restorations = [];
    const outcomes = surveyOutcomes(resolutions, root).map((entry) => {
        const prior = before.get(entry.source);
        before.delete(entry.source);
        const lost = entry.ratification === "lost";
        if (prior === undefined) {
            if (lost) {
                regressions.push(`${entry.source}: recorded with an unresolvable ratification`);
                return { ...entry, reason };
            }
            additions.push(entry.source);
            return entry;
        }
        const rewritten = prior.sha256 !== entry.sha256 || prior.commit !== entry.commit;
        const newlyLost = lost && prior.ratification !== "lost";
        const restored = !lost && prior.ratification === "lost";
        if (rewritten) regressions.push(`${entry.source}: outcome record rewritten`);
        if (newlyLost) regressions.push(`${entry.source}: ratification commit no longer resolves`);
        if (restored) restorations.push(entry.source);
        if (rewritten || newlyLost) return { ...entry, reason };
        if (restored) return entry;
        return isNonEmptyString(prior.reason) ? { ...entry, reason: prior.reason } : entry;
    });
    for (const source of before.keys()) {
        regressions.push(`${source}: recorded outcome removed`);
    }
    if (regressions.length > 0 && !isNonEmptyString(reason)) {
        throw new TypeError(
            `Outcome baseline update destroys or weakens recorded evidence:\n` +
                `${regressions.join("\n")}\n` +
                `Re-run with ${acknowledgeFlag} to record why.`
        );
    }
    outcomes.sort((left, right) => compareCanonicalText(left.source, right.source));
    return { baseline: { edition: "1.0.0", outcomes }, additions, restorations, regressions };
}

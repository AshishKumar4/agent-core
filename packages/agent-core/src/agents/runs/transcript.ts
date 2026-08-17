import { AgentCoreError } from "../../errors";
import type { RunCommitId } from "../../execution-references";
import type { InvocationId } from "../../interaction-references";
import type { RunCommit } from "./commit";

/**
 * Resolves a commit identity to its record. A caller validating a commit it has not yet
 * inserted answers for that identity itself, so the same derivation decides a prospective
 * cut and an installed one.
 */
export type RunCommitLoader = (id: RunCommitId) => RunCommit | undefined;

/**
 * The ancestors of `base` including itself, every parent before its child, and a merge's
 * first-parent ancestry before the commits only its second parent reaches. Parent order is
 * recorded, so this order is a property of the graph rather than of the walk.
 */
export function orderedAncestry(base: RunCommit, load: RunCommitLoader): readonly RunCommit[] {
    const ordered: RunCommit[] = [];
    const walked = new Set<string>();
    const pending: { readonly commit: RunCommit; expanded: boolean }[] = [
        { commit: base, expanded: false }
    ];
    while (pending.length > 0) {
        const frame = pending[pending.length - 1]!;
        if (frame.expanded) {
            pending.pop();
            ordered.push(frame.commit);
            continue;
        }
        frame.expanded = true;
        if (walked.has(frame.commit.id.value)) {
            pending.pop();
            continue;
        }
        walked.add(frame.commit.id.value);
        for (let index = frame.commit.parents.length - 1; index >= 0; index -= 1) {
            const parent = frame.commit.parents[index]!;
            const record = load(parent);
            if (record === undefined || !record.run.equals(frame.commit.run)) {
                throw new AgentCoreError(
                    "codec.invalid",
                    "Run ancestry contains a missing or foreign parent"
                );
            }
            pending.push({ commit: record, expanded: false });
        }
    }
    return Object.freeze(ordered);
}

/**
 * The model-visible sequence a call reads at `base`: that commit's ancestry in commit
 * order with every shadowed commit omitted and each installed rewrite read where the
 * earliest commit it shadows stood. `base` is the effective state, already resolved
 * through any undo selection, so a rewrite appended later is a descendant and cannot
 * enter the derivation.
 */
export function effectiveTranscript(base: RunCommit, load: RunCommitLoader): readonly RunCommit[] {
    const ancestry = orderedAncestry(base, load);
    const shadowedBy = new Map<string, RunCommit>();
    for (const commit of ancestry) {
        if (commit.kind !== "rewrite") continue;
        for (const shadowed of commit.shadows ?? []) {
            const owner = shadowedBy.get(shadowed.value);
            if (owner !== undefined) {
                throw new AgentCoreError(
                    "run.invalid-state",
                    `Run commit ${shadowed.value} is shadowed by both ${owner.id.value} and ${commit.id.value}`
                );
            }
            shadowedBy.set(shadowed.value, commit);
        }
    }
    const transcript: RunCommit[] = [];
    const emitted = new Set<string>();
    for (const commit of ancestry) {
        const replacement = readInsteadOf(commit, shadowedBy);
        if (replacement !== undefined) {
            if (emitted.has(replacement.id.value)) continue;
            emitted.add(replacement.id.value);
            transcript.push(replacement);
            continue;
        }
        if (commit.kind === "rewrite") {
            // An installed rewrite was already read at its anchor; an abandoned one shadows
            // nothing and changes no transcript.
            if ((commit.shadows?.length ?? 0) > 0 && !emitted.has(commit.id.value)) {
                throw new AgentCoreError(
                    "run.invalid-state",
                    `Rewrite ${commit.id.value} shadows no commit its own ancestry reaches`
                );
            }
            continue;
        }
        emitted.add(commit.id.value);
        transcript.push(commit);
    }
    return Object.freeze(transcript);
}

/** Which Invocation a cut left half-recorded, and the half that survived it. */
export interface UnbalancedCut {
    readonly kind: "unanswered" | "orphaned";
    readonly invocation: InvocationId;
    readonly commit: RunCommitId;
}

/**
 * The first Invocation whose request and `invocation` commit the cut separated. Judged on
 * identity rather than on how many of each survived: a cut that drops one request and one
 * unrelated result leaves any count balanced and strands both surviving halves.
 */
export function unbalancedCut(
    before: readonly RunCommit[],
    after: readonly RunCommit[]
): UnbalancedCut | undefined {
    const retained = new Set(after.map((commit) => commit.id.value));
    const pairs = new Map<string, InvocationPair>();
    const order: InvocationPair[] = [];
    for (const commit of before) {
        for (const invocation of commit.requests ?? []) {
            pairedWith(pairs, order, invocation).requests.push(commit.id);
        }
        if (commit.kind === "invocation" && commit.invocation !== undefined) {
            pairedWith(pairs, order, commit.invocation).answers.push(commit.id);
        }
    }
    for (const pair of order) {
        if (pair.requests.length === 0 || pair.answers.length === 0) continue;
        const request = pair.requests.find((commit) => retained.has(commit.value));
        const answer = pair.answers.find((commit) => retained.has(commit.value));
        if (request !== undefined && answer === undefined) {
            return Object.freeze({
                kind: "unanswered" as const,
                invocation: pair.invocation,
                commit: request
            });
        }
        if (request === undefined && answer !== undefined) {
            return Object.freeze({
                kind: "orphaned" as const,
                invocation: pair.invocation,
                commit: answer
            });
        }
    }
    return undefined;
}

/** The message that asks for an Invocation and the commits that answer it. */
interface InvocationPair {
    readonly invocation: InvocationId;
    readonly requests: RunCommitId[];
    readonly answers: RunCommitId[];
}

function pairedWith(
    pairs: Map<string, InvocationPair>,
    order: InvocationPair[],
    invocation: InvocationId
): InvocationPair {
    const existing = pairs.get(invocation.value);
    if (existing !== undefined) return existing;
    const pair: InvocationPair = { invocation, requests: [], answers: [] };
    pairs.set(invocation.value, pair);
    order.push(pair);
    return pair;
}

/**
 * The rewrite whose content stands where `commit` did, following a chain when a later
 * rewrite shadows an earlier one. Undefined when the commit is read as itself.
 */
function readInsteadOf(
    commit: RunCommit,
    shadowedBy: Map<string, RunCommit>
): RunCommit | undefined {
    let current = shadowedBy.get(commit.id.value);
    if (current === undefined) return undefined;
    const walked = new Set([commit.id.value]);
    for (;;) {
        if (walked.has(current.id.value)) {
            throw new AgentCoreError(
                "run.invalid-state",
                `Run rewrite ${current.id.value} shadows its own replacement`
            );
        }
        walked.add(current.id.value);
        const next = shadowedBy.get(current.id.value);
        if (next === undefined) return current;
        current = next;
    }
}

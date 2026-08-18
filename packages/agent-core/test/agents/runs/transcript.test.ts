import { describe, expect, it } from "vitest";
import { Revision, type ContentRef } from "../../../src/core";
import {
    ContentStore,
    type ByteRange,
    type ContentPutResult,
    type MediaHint
} from "../../../src/content";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { InvocationId } from "../../../src/interaction-references";
import { ReceiptId } from "../../../src/invocations";
import { RunCommit, type RunCommitInit } from "../../../src/agents/runs/commit";
import { RunBranch } from "../../../src/agents/runs/run";
import { RunBranchId } from "../../../src/agents/runs/id";
import { Turn } from "../../../src/agents/runs/turn";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import {
    TurnExecutor,
    TurnExecutorHost,
    TurnModelInputReplay,
    TurnOmission,
    TurnPromptSection,
    TurnPromptSectionName,
    TurnShownContent,
    turnModelRequestBytes,
    type TurnContext,
    type TurnModelCall,
    type TurnOutcome
} from "../../../src/agents/runs/executor";
import {
    content,
    genesis,
    harness,
    ids,
    pins,
    refs,
    seedRunningTurn,
    thrownBy,
    type Assembled
} from "./fixture";

type Harness = ReturnType<typeof seedRunningTurn>;

const secondInvocation = new InvocationId("invocation-2");
const secondReceipt = new ReceiptId("receipt-2");
const rewriteReceipt = new ReceiptId("receipt-rewrite");

/** Runs one caller-supplied body inside the real seam, so the model call is a real one. */
class CallingExecutor extends TurnExecutor {
    public constructor(private readonly body: (context: TurnContext) => Promise<TurnOutcome>) {
        super();
    }

    public async execute(context: TurnContext): Promise<TurnOutcome> {
        return this.body(context);
    }
}

/**
 * A store whose Tenant retention policy can end custody of one ref, so a real retention
 * loss stays distinguishable from a rewrite superseding the commits that named it.
 */
class ReleasableContentStore extends ContentStore {
    readonly #released = new Set<string>();

    public constructor(private readonly inner: ContentStore) {
        super();
    }

    public release(ref: ContentRef): void {
        this.#released.add(ref.value);
    }

    public async put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult> {
        return hint === undefined ? this.inner.put(bytes) : this.inner.put(bytes, hint);
    }

    public async get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array> {
        if (this.#released.has(ref.value)) {
            throw new AgentCoreError("content.not-found", "Tenant retention policy released this");
        }
        return range === undefined ? this.inner.get(ref) : this.inner.get(ref, range);
    }

    public async stat(ref: ContentRef) {
        return this.#released.has(ref.value) ? undefined : this.inner.stat(ref);
    }
}

function branchRevision(value: Harness, branch = ids.branch): Revision {
    return value.repository.transaction(
        (tx) => value.repository.loadBranch(tx, branch)!.revision
    );
}

function runRevision(value: Harness): Revision {
    return value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run)!.revision);
}

function transcriptIds(value: Harness, base?: RunCommitId, branch = ids.branch): string[] {
    return value.runtime
        .effectiveTranscript(ids.run, branch, base)
        .map((commit) => commit.id.value);
}

function message(
    value: Harness,
    id: string,
    parent: RunCommitId,
    requests?: readonly InvocationId[],
    body?: ContentRef,
    branch = ids.branch,
    turn = ids.turn
): RunCommit {
    const init: Assembled<RunCommitInit> = {
        id: new RunCommitId(id),
        run: ids.run,
        branch,
        kind: "message",
        parents: [parent],
        pins: pins(),
        writer: { kind: "turn", token: { turn, holder: ids.holder, epoch: 1 } },
        subjectTurn: turn,
        content: body ?? content("1")
    };
    if (requests !== undefined) init.requests = requests;
    const commit = new RunCommit(init);
    value.runtime.appendTurnCommit(commit, branchRevision(value, branch), new Date(1100));
    return commit;
}

function answer(
    value: Harness,
    id: string,
    parent: RunCommitId,
    invocation: InvocationId,
    receipt: ReceiptId
): RunCommit {
    const commit = new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "invocation",
        parents: [parent],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "receipt", audit: refs.audit, receipt }
        },
        subjectTurn: ids.turn,
        invocation,
        receipt
    });
    value.evidence.receipts.set(`${receipt.value}:${refs.audit.value}`, {
        kind: "receipt",
        run: ids.run,
        receipt,
        audit: refs.audit,
        invocation,
        subjectTurn: ids.turn
    });
    value.runtime.appendSystemEvidenceCommit(commit, branchRevision(value), new Date(1200));
    return commit;
}

function finish(value: Harness, id: string, parent: RunCommitId): RunCommit {
    const commit = new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "result",
        parents: [parent],
        pins: pins(),
        writer: { kind: "turn", token: value.token },
        subjectTurn: ids.turn,
        content: content("2")
    });
    value.runtime.completeTurn({
        turn: ids.turn,
        expectedTurnRevision: value.running.revision,
        expectedBranchRevision: branchRevision(value),
        token: value.token,
        outcome: "succeeded",
        commit,
        now: new Date(1300)
    });
    return commit;
}

/** An undo commit selecting `selects`, with the control evidence that binds its proposal. */
function undo(value: Harness, id: string, parent: RunCommitId, selects: RunCommitId): RunCommit {
    const commit = new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "undo",
        parents: [parent],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
        },
        selects,
        receipt: refs.receipt
    });
    value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
        kind: "control",
        run: ids.run,
        receipt: refs.receipt,
        audit: refs.audit,
        proposalDigest: commit.proposalDigest.value
    });
    return commit;
}

/**
 * A rewrite proposal plus the evidence its form requires: a successful administer Receipt
 * when it installs a replacement, that attempt's failed Receipt when it is abandoned.
 */
function rewrite(
    value: Harness,
    id: string,
    parent: RunCommitId,
    shadows: readonly RunCommitId[],
    branch = ids.branch
): RunCommit {
    const init: Assembled<RunCommitInit> = {
        id: new RunCommitId(id),
        run: ids.run,
        branch,
        kind: "rewrite",
        parents: [parent],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "control", audit: refs.audit, receipt: rewriteReceipt }
        },
        shadows,
        receipt: rewriteReceipt
    };
    if (shadows.length > 0) init.content = content("9");
    const commit = new RunCommit(init);
    const key = `${rewriteReceipt.value}:${refs.audit.value}`;
    if (shadows.length === 0) {
        value.evidence.abandonedRewrites.set(key, {
            kind: "abandonedRewrite",
            run: ids.run,
            receipt: rewriteReceipt,
            audit: refs.audit,
            proposalDigest: commit.proposalDigest.value,
            outcome: "failed"
        });
    } else {
        value.evidence.controls.set(key, {
            kind: "control",
            run: ids.run,
            receipt: rewriteReceipt,
            audit: refs.audit,
            proposalDigest: commit.proposalDigest.value
        });
    }
    return commit;
}

/** root -> message requesting invocation-1 -> its invocation commit -> the Turn's result. */
function onePair() {
    const value = seedRunningTurn();
    const request = message(value, "message-one", ids.root, [refs.invocation]);
    const result = answer(value, "answer-one", request.id, refs.invocation, refs.receipt);
    const done = finish(value, "result-one", result.id);
    return { value, request, result, done };
}

/** Two independently paired Invocations, so a cut can strand one half of each. */
function twoPairs() {
    const value = seedRunningTurn();
    const firstRequest = message(value, "message-one", ids.root, [refs.invocation]);
    const firstAnswer = answer(value, "answer-one", firstRequest.id, refs.invocation, refs.receipt);
    const secondRequest = message(value, "message-two", firstAnswer.id, [secondInvocation]);
    const secondAnswer = answer(
        value,
        "answer-two",
        secondRequest.id,
        secondInvocation,
        secondReceipt
    );
    const done = finish(value, "result-two", secondAnswer.id);
    return { value, firstRequest, firstAnswer, secondRequest, secondAnswer, done };
}

/** A chain of plain messages, for shadow sets that are not intervals in any order. */
function chain(length: number, body?: ContentRef, value = seedRunningTurn()) {
    const commits: RunCommit[] = [];
    let parent = ids.root;
    for (let index = 1; index <= length; index += 1) {
        const commit = message(value, `chain-${index}`, parent, undefined, body);
        commits.push(commit);
        parent = commit.id;
    }
    return { value, commits };
}

function installed(value: Harness, commit: RunCommit, branch = ids.branch): void {
    value.runtime.reserveRunRewrite(ids.run, branch, commit.id, branchRevision(value, branch));
    value.runtime.rewriteRun(commit, branchRevision(value, branch), new Date(1400));
}

describe("Run effective transcript, rewrite bracket, and cut balance", () => {
    it(
        "[C13-RUN-CUT-BALANCE] rejects an undo and a fork that strand an Invocation, and admits ones that do not",
        { tags: "p0" },
        () => {
            const { value, request, result, done } = onePair();

            const stranding = undo(value, "undo-strands", done.id, request.id);
            const undoFailure = thrownBy(AgentCoreError, () =>
                value.runtime.undoRun(stranding, branchRevision(value), new Date(1400))
            );
            expect(undoFailure.code).toBe("run.invalid-state");
            expect(undoFailure.message).toContain("Undo selection");
            expect(undoFailure.message).toContain(refs.invocation.value);
            expect(undoFailure.message).toContain("unanswered");
            expect(
                value.repository.transaction((tx) =>
                    value.repository.loadCommit(tx, stranding.id)
                )
            ).toBeUndefined();

            const fork = new RunBranch(
                new RunBranchId("branch-fork"),
                ids.run,
                "fork",
                request.id,
                new Revision(0)
            );
            const forkFailure = thrownBy(AgentCoreError, () =>
                value.runtime.createBranch(ids.run, fork, runRevision(value))
            );
            expect(forkFailure.code).toBe("run.invalid-state");
            expect(forkFailure.message).toContain("Run branch creation");
            expect(forkFailure.message).toContain(refs.invocation.value);
            expect(forkFailure.message).toContain("unanswered");
            expect(
                value.repository.transaction((tx) => value.repository.loadBranch(tx, fork.id))
            ).toBeUndefined();

            // Both directions: a cut that keeps the whole pair, and one that drops it whole.
            const keepsPair = new RunBranch(
                new RunBranchId("branch-answered"),
                ids.run,
                "answered",
                result.id,
                new Revision(0)
            );
            value.runtime.createBranch(ids.run, keepsPair, runRevision(value));
            expect(transcriptIds(value, undefined, keepsPair.id)).toEqual([
                ids.root.value,
                request.id.value,
                result.id.value
            ]);

            const dropsPair = undo(value, "undo-drops-pair", done.id, ids.root);
            value.runtime.undoRun(dropsPair, branchRevision(value), new Date(1500));
            expect(value.runtime.effectiveCommit(ids.run, ids.branch).equals(ids.root)).toBe(true);
            expect(transcriptIds(value)).toEqual([ids.root.value]);
        }
    );

    it(
        "[C13-RUN-CUT-BALANCE] judges an asymmetric cut on which Invocation is stranded rather than on how many are",
        { tags: "p0" },
        () => {
            const { value, firstRequest, firstAnswer, secondRequest, secondAnswer, done } =
                twoPairs();

            // Dropping one request and one unrelated result leaves any counter balanced.
            const asymmetric = rewrite(value, "rewrite-asymmetric", done.id, [
                firstRequest.id,
                secondAnswer.id
            ]);
            value.runtime.reserveRunRewrite(
                ids.run,
                ids.branch,
                asymmetric.id,
                branchRevision(value)
            );
            const failure = thrownBy(AgentCoreError, () =>
                value.runtime.rewriteRun(asymmetric, branchRevision(value), new Date(1400))
            );
            expect(failure.code).toBe("run.invalid-state");
            expect(failure.message).toContain("Rewrite shadow set");
            expect(failure.message).toContain(refs.invocation.value);
            expect(failure.message).toContain("orphans");
            expect(failure.message).not.toContain(secondInvocation.value);

            // A counter would pass this proposal: it removes exactly one request commit and
            // exactly one invocation commit, so the retained counts of each stay equal while
            // both surviving halves are stranded.
            const removed = [firstRequest, secondAnswer];
            expect(removed.filter((commit) => commit.requests !== undefined)).toHaveLength(1);
            expect(removed.filter((commit) => commit.kind === "invocation")).toHaveLength(1);
            expect(transcriptIds(value)).toEqual([
                ids.root.value,
                firstRequest.id.value,
                firstAnswer.id.value,
                secondRequest.id.value,
                secondAnswer.id.value,
                done.id.value
            ]);

            // The bracket stays open, so the same reserved identity retries with whole pairs.
            const whole = rewrite(value, asymmetric.id.value, done.id, [
                firstRequest.id,
                firstAnswer.id,
                secondRequest.id,
                secondAnswer.id
            ]);
            value.runtime.rewriteRun(whole, branchRevision(value), new Date(1500));
            expect(transcriptIds(value)).toEqual([
                ids.root.value,
                whole.id.value,
                done.id.value
            ]);
        }
    );

    it(
        "[C13-RUN-CUT-BALANCE] rejects a rewrite that removes a request while keeping the commit answering it",
        { tags: "p0" },
        () => {
            const { value, request, result, done } = onePair();

            const halfPair = rewrite(value, "rewrite-half-pair", done.id, [request.id]);
            value.runtime.reserveRunRewrite(
                ids.run,
                ids.branch,
                halfPair.id,
                branchRevision(value)
            );
            const failure = thrownBy(AgentCoreError, () =>
                value.runtime.rewriteRun(halfPair, branchRevision(value), new Date(1400))
            );
            expect(failure.message).toContain("orphans");
            expect(failure.message).toContain(refs.invocation.value);
            expect(failure.message).toContain(result.id.value);
        }
    );

    it(
        "[C13-RUN-EFFECTIVE-TRANSCRIPT] equals the full ancestry replay when no rewrite exists",
        { tags: "p0" },
        () => {
            const { value, request, result, done } = onePair();
            expect(transcriptIds(value)).toEqual([
                ids.root.value,
                request.id.value,
                result.id.value,
                done.id.value
            ]);
            expect(
                value.repository
                    .transaction((tx) => value.repository.listCommits(tx))
                    .filter((commit) => commit.kind === "rewrite")
            ).toEqual([]);
        }
    );

    it(
        "[C13-RUN-EFFECTIVE-TRANSCRIPT] omits exactly the named identities and reads the rewrite where they stood",
        { tags: "p0" },
        () => {
            const { value, commits } = chain(4);
            const reduction = rewrite(value, "rewrite-middle", commits[3]!.id, [
                commits[1]!.id,
                commits[2]!.id
            ]);
            installed(value, reduction);

            expect(transcriptIds(value)).toEqual([
                ids.root.value,
                commits[0]!.id.value,
                reduction.id.value,
                commits[3]!.id.value
            ]);
            const read = value.runtime.effectiveTranscript(ids.run, ids.branch);
            expect(read[2]!.content?.value).toBe(content("9").value);
        }
    );

    it(
        "[C13-RUN-EFFECTIVE-TRANSCRIPT] removes the exact identities a second rewrite names though they are not an interval",
        { tags: "p0" },
        () => {
            const { value, commits } = chain(4);
            const first = rewrite(value, "rewrite-first", commits[3]!.id, [commits[1]!.id]);
            installed(value, first);
            expect(transcriptIds(value)).toEqual([
                ids.root.value,
                commits[0]!.id.value,
                first.id.value,
                commits[2]!.id.value,
                commits[3]!.id.value
            ]);

            const fifth = message(value, "chain-5", first.id);
            const second = rewrite(value, "rewrite-second", fifth.id, [
                commits[0]!.id,
                commits[2]!.id,
                fifth.id
            ]);
            installed(value, second);

            // chain-1, chain-3 and chain-5 are separated in the transcript by the first
            // rewrite and by chain-4, so no positional span names them.
            expect(transcriptIds(value)).toEqual([
                ids.root.value,
                second.id.value,
                first.id.value,
                commits[3]!.id.value
            ]);
        }
    );

    it(
        "[C13-RUN-EFFECTIVE-TRANSCRIPT] keeps a shadowed commit reachable, immutable, and named by its content",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const body = new TextEncoder().encode("what the shadowed commit said");
            const stored = await seeded.storage.content.put(body);
            const { value, commits } = chain(3, stored.ref, seeded);
            const before = value.repository.transaction((tx) =>
                value.repository.loadCommit(tx, commits[1]!.id)
            );
            const reduction = rewrite(value, "rewrite-retains", commits[2]!.id, [commits[1]!.id]);
            installed(value, reduction);

            const after = value.repository.transaction((tx) =>
                value.repository.loadCommit(tx, commits[1]!.id)
            );
            expect(after).toBeDefined();
            expect(RunCommit.codec.encode(after!)).toEqual(RunCommit.codec.encode(before!));
            expect(after!.parents.map((parent) => parent.value)).toEqual([commits[0]!.id.value]);
            expect(after!.content?.value).toBe(before!.content?.value);
            expect(
                value.repository.transaction((tx) =>
                    value.repository.isAncestor(tx, commits[1]!.id, reduction.id)
                )
            ).toBe(true);

            // A store that pruned the shadowed row would fail to reload after a restart.
            const restarted = harness(value.storage.snapshot());
            const reloaded = restarted.repository.transaction((tx) =>
                restarted.repository.loadCommit(tx, commits[1]!.id)
            );
            expect(reloaded?.content?.value).toBe(before!.content?.value);

            // Shadowing supersedes without releasing: nothing on the rewrite path touches
            // custody, so the content an earlier request named still resolves.
            expect(await value.storage.content.stat(stored.ref)).toBeDefined();
            expect(await value.storage.content.get(stored.ref)).toEqual(body);
            expect(transcriptIds(value)).not.toContain(commits[1]!.id.value);
        }
    );

    it(
        "[C13-RUN-EFFECTIVE-TRANSCRIPT] rejects a shadow that is not visible, is repeated, or is already shadowed",
        { tags: "p0" },
        () => {
            const { value, commits } = chain(3);

            expect(
                () =>
                    new RunCommit({
                        id: new RunCommitId("rewrite-repeated"),
                        run: ids.run,
                        branch: ids.branch,
                        kind: "rewrite",
                        parents: [commits[2]!.id],
                        pins: pins(),
                        writer: {
                            kind: "system",
                            cause: { kind: "control", audit: refs.audit, receipt: rewriteReceipt }
                        },
                        shadows: [commits[0]!.id, commits[0]!.id],
                        content: content("9"),
                        receipt: rewriteReceipt
                    })
            ).toThrow(/Rewrite commit fields are invalid/);

            // A real commit of the same Run that the rewrite's ancestry does not reach.
            const sibling = new RunBranch(
                new RunBranchId("branch-elsewhere"),
                ids.run,
                "elsewhere",
                ids.root,
                new Revision(0)
            );
            value.runtime.createBranch(ids.run, sibling, runRevision(value));
            const siblingTurn = new TurnId("turn-elsewhere");
            seedRunningTurn(value, {
                id: siblingTurn,
                branch: sibling.id,
                startHead: ids.root,
                effectiveInput: ids.root
            });
            const elsewhere = message(
                value,
                "elsewhere-1",
                ids.root,
                undefined,
                undefined,
                sibling.id,
                siblingTurn
            );
            expect(
                value.repository.transaction((tx) =>
                    value.repository.isAncestor(tx, elsewhere.id, commits[2]!.id)
                )
            ).toBe(false);
            const outside = rewrite(value, "rewrite-outside", commits[2]!.id, [elsewhere.id]);
            value.runtime.reserveRunRewrite(
                ids.run,
                ids.branch,
                outside.id,
                branchRevision(value)
            );
            expect(() =>
                value.runtime.rewriteRun(outside, branchRevision(value), new Date(1400))
            ).toThrow(/effective transcript does not contain/);

            const restarted = seedRunningTurn();
            const chained = [
                message(restarted, "again-1", ids.root),
                message(restarted, "again-2", new RunCommitId("again-1"))
            ];
            const first = rewrite(restarted, "rewrite-once", chained[1]!.id, [chained[0]!.id]);
            installed(restarted, first);
            const twice = rewrite(restarted, "rewrite-twice", first.id, [chained[0]!.id]);
            restarted.runtime.reserveRunRewrite(
                ids.run,
                ids.branch,
                twice.id,
                branchRevision(restarted)
            );
            expect(() =>
                restarted.runtime.rewriteRun(twice, branchRevision(restarted), new Date(1500))
            ).toThrow(/effective transcript does not contain/);
        }
    );

    it(
        "[C13-RUN-REWRITE-BRACKET] completes exactly the obligation it reserved and excludes a second attempt per branch",
        { tags: "p0" },
        () => {
            const { value, commits } = chain(2);
            const planned = new RunCommitId("rewrite-reserved");
            const reservation = value.runtime.reserveRunRewrite(
                ids.run,
                ids.branch,
                planned,
                branchRevision(value)
            );
            expect(reservation.obligation).toEqual({ kind: "systemCommit", commit: planned });
            const reserved = value.repository.transaction((tx) =>
                value.repository.loadAdmission(tx, ids.run)
            );
            expect(reserved?.reserved).toEqual([reservation.obligation]);
            expect(reserved?.completed).toEqual([]);

            expect(() =>
                value.runtime.reserveRunRewrite(
                    ids.run,
                    ids.branch,
                    new RunCommitId("rewrite-second"),
                    branchRevision(value)
                )
            ).toThrow(/uncompleted rewrite reservation/);

            // The exclusion is per branch, not per Run.
            const sibling = new RunBranch(
                new RunBranchId("branch-sibling"),
                ids.run,
                "sibling",
                commits[1]!.id,
                new Revision(0)
            );
            value.runtime.createBranch(ids.run, sibling, runRevision(value));
            const siblingPlanned = new RunCommitId("rewrite-sibling");
            value.runtime.reserveRunRewrite(
                ids.run,
                sibling.id,
                siblingPlanned,
                branchRevision(value, sibling.id)
            );

            // A rewrite closes only the identity its own branch reserved.
            const wrong = rewrite(value, "rewrite-unreserved", commits[1]!.id, [commits[0]!.id]);
            expect(() =>
                value.runtime.rewriteRun(wrong, branchRevision(value), new Date(1400))
            ).toThrow(/exact RunCommitId its branch reserved/);

            const closing = new RunCommit({
                id: planned,
                run: ids.run,
                branch: ids.branch,
                kind: "rewrite",
                parents: [commits[1]!.id],
                pins: pins(),
                writer: {
                    kind: "system",
                    cause: { kind: "control", audit: refs.audit, receipt: rewriteReceipt }
                },
                shadows: [commits[0]!.id],
                content: content("9"),
                receipt: rewriteReceipt
            });
            value.evidence.controls.set(`${rewriteReceipt.value}:${refs.audit.value}`, {
                kind: "control",
                run: ids.run,
                receipt: rewriteReceipt,
                audit: refs.audit,
                proposalDigest: closing.proposalDigest.value
            });
            value.runtime.rewriteRun(closing, branchRevision(value), new Date(1400));

            const closed = value.repository.transaction((tx) =>
                value.repository.loadAdmission(tx, ids.run)
            );
            expect(closed?.completed).toEqual([{ kind: "systemCommit", commit: planned }]);
            expect(
                closed?.reserved.some((obligation) =>
                    obligation.kind === "systemCommit" &&
                    obligation.commit.equals(siblingPlanned)
                )
            ).toBe(true);
            expect(
                value.repository.transaction((tx) => value.repository.loadBranch(tx, ids.branch))
                    ?.rewrite
            ).toBeUndefined();
        }
    );

    it(
        "[C13-RUN-REWRITE-BRACKET] records an abandoned attempt as the reserved commit on its failed Receipt",
        { tags: "p0" },
        () => {
            const { value, commits } = chain(2);
            const beforeAttempt = transcriptIds(value);

            const abandoned = rewrite(value, "rewrite-abandoned", commits[1]!.id, []);
            installed(value, abandoned);

            expect(transcriptIds(value)).toEqual(beforeAttempt);
            const stored = value.repository.transaction((tx) =>
                value.repository.listCommits(tx)
            ).filter((commit) => commit.id.equals(abandoned.id));
            expect(stored).toHaveLength(1);
            expect(stored[0]!.kind).toBe("rewrite");
            expect(stored[0]!.shadows).toEqual([]);
            expect(stored[0]!.content).toBeUndefined();
            expect(stored[0]!.receipt?.value).toBe(rewriteReceipt.value);
            expect(
                value.evidence.abandonedRewrites.get(
                    `${rewriteReceipt.value}:${refs.audit.value}`
                )?.outcome
            ).toBe("failed");
            expect(
                value.repository
                    .transaction((tx) => value.repository.loadAdmission(tx, ids.run))
                    ?.completed
            ).toEqual([{ kind: "systemCommit", commit: abandoned.id }]);
        }
    );

    it(
        "[C13-WRITER-MATRIX] admits a rewrite only on the evidence its form requires",
        { tags: "p0" },
        () => {
            const { value, commits } = chain(2);

            // An abandoned rewrite whose failed Receipt the host never recorded.
            const unrecorded = rewrite(value, "rewrite-unrecorded", commits[1]!.id, []);
            value.evidence.abandonedRewrites.clear();
            value.runtime.reserveRunRewrite(
                ids.run,
                ids.branch,
                unrecorded.id,
                branchRevision(value)
            );
            const missing = thrownBy(AgentCoreError, () =>
                value.runtime.rewriteRun(unrecorded, branchRevision(value), new Date(1400))
            );
            expect(missing.code).toBe("authority.denied");

            // An installed rewrite may not stand on the abandoned form's failed evidence.
            const second = chain(2);
            const installing = rewrite(second.value, "rewrite-installing", second.commits[1]!.id, [
                second.commits[0]!.id
            ]);
            second.value.evidence.controls.clear();
            second.value.evidence.abandonedRewrites.set(
                `${rewriteReceipt.value}:${refs.audit.value}`,
                {
                    kind: "abandonedRewrite",
                    run: ids.run,
                    receipt: rewriteReceipt,
                    audit: refs.audit,
                    proposalDigest: installing.proposalDigest.value,
                    outcome: "failed"
                }
            );
            second.value.runtime.reserveRunRewrite(
                ids.run,
                ids.branch,
                installing.id,
                branchRevision(second.value)
            );
            expect(() =>
                second.value.runtime.rewriteRun(
                    installing,
                    branchRevision(second.value),
                    new Date(1400)
                )
            ).toThrow(/Control writer evidence/);
        }
    );

    it(
        "[C13-TURN-TRANSCRIPT-RECONSTRUCTION] derives at the exact base commit, so a later rewrite cannot enter it",
        { tags: "p0" },
        () => {
            const { value, commits } = chain(3);
            const base = commits[2]!.id;
            const asRead = value.runtime.effectiveTranscript(ids.run, ids.branch, base);
            expect(asRead.map((commit) => commit.id.value)).toEqual([
                ids.root.value,
                commits[0]!.id.value,
                commits[1]!.id.value,
                commits[2]!.id.value
            ]);

            const reduction = rewrite(value, "rewrite-after-call", base, [
                commits[0]!.id,
                commits[1]!.id
            ]);
            installed(value, reduction);

            // The earlier call reconstructs to the same sequence and the same content.
            const again = value.runtime.effectiveTranscript(ids.run, ids.branch, base);
            expect(again.map((commit) => commit.id.value)).toEqual(
                asRead.map((commit) => commit.id.value)
            );
            expect(again.map((commit) => commit.content?.value)).toEqual(
                asRead.map((commit) => commit.content?.value)
            );

            // Forward, the next call carries the rewrite's content and not the shadowed
            // commits', so the reduction is visible to the model it was made for.
            const next = value.runtime.effectiveTranscript(ids.run, ids.branch);
            expect(next.map((commit) => commit.id.value)).toEqual([
                ids.root.value,
                reduction.id.value,
                commits[2]!.id.value
            ]);
            expect(next[1]!.content?.value).toBe(content("9").value);
        }
    );

    it(
        "[C13-RUN-EFFECTIVE-TRANSCRIPT] reads a merge's first-parent ancestry before what only its second parent reaches",
        { tags: "p1" },
        () => {
            const { value, commits } = chain(1);
            const source = new RunBranch(
                new RunBranchId("branch-source"),
                ids.run,
                "source",
                ids.root,
                new Revision(0)
            );
            value.runtime.createBranch(ids.run, source, runRevision(value));
            const sourceTurn = new TurnId("turn-source");
            seedRunningTurn(value, {
                id: sourceTurn,
                branch: source.id,
                startHead: ids.root,
                effectiveInput: ids.root
            });
            const sourceHead = message(
                value,
                "source-1",
                ids.root,
                undefined,
                undefined,
                source.id,
                sourceTurn
            );
            const merge = new RunCommit({
                id: new RunCommitId("merge-commit"),
                run: ids.run,
                branch: ids.branch,
                kind: "merge",
                parents: [commits[0]!.id, sourceHead.id],
                pins: pins(),
                writer: {
                    kind: "system",
                    cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
                },
                content: content("3"),
                resolution: { kind: "concat" },
                receipt: refs.receipt
            });
            value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
                kind: "control",
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                proposalDigest: merge.proposalDigest.value
            });
            value.runtime.mergeRun(merge, branchRevision(value), new Date(1400));

            expect(transcriptIds(value)).toEqual([
                ids.root.value,
                commits[0]!.id.value,
                sourceHead.id.value,
                merge.id.value
            ]);
        }
    );

    it(
        "[C13-RUN-EFFECTIVE-TRANSCRIPT] refuses a base commit the branch head does not reach",
        { tags: "p1" },
        () => {
            const value = harness();
            value.runtime.createRun(genesis());
            expect(
                value.runtime
                    .effectiveTranscript(ids.run, ids.branch)
                    .map((commit) => commit.id.value)
            ).toEqual([ids.root.value]);
            expect(() =>
                value.runtime.effectiveTranscript(
                    ids.run,
                    ids.branch,
                    new RunCommitId("absent-base")
                )
            ).toThrow(/not an ancestor of the branch head/);
        }
    );

    it(
        "[C13-TURN-TRANSCRIPT-RECONSTRUCTION] rebuilds an earlier call's request byte for byte across a rewrite that shadows what it read",
        { tags: "p0" },
        async () => {
            const value = seedRunningTurn();
            const store = new ReleasableContentStore(value.storage.content);
            const assembled = (await store.put(new TextEncoder().encode("assembled"))).ref;
            const output = (await store.put(new TextEncoder().encode("response"))).ref;
            const first = message(value, "read-1", ids.root);
            const second = message(value, "read-2", first.id);

            const shownRefs: ContentRef[] = [];
            const inputs: RunCommitId[] = [];
            const sent: Uint8Array[] = [];
            const hostFor = (body: (context: TurnContext) => Promise<TurnOutcome>) =>
                new TurnExecutorHost({
                    runtime: value.runtime,
                    executor: new CallingExecutor(body),
                    content: store,
                    operations: { resolve: async () => [] },
                    prompt: { assemble: async () => assembled },
                    invocations: { invoke: async () => ({ tier: "direct" as const, output: {} }) },
                    model: {
                        call: async (request: TurnModelCall) => {
                            sent.push(turnModelRequestBytes(request));
                            return { output, usage: { inputTokens: 1, outputTokens: 1 } };
                        }
                    },
                    stream: { publish: async () => undefined },
                    now: () => new Date(2000)
                });

            /**
             * Prompt assembly derives from the branch's effective transcript rather than from
             * the effective state commit alone, so the sections a call sends are exactly what
             * the transcript shows at the commit it reads.
             */
            const callReadingTranscript = (resultId: string) => async (context: TurnContext) => {
                const shown = value.runtime
                    .effectiveTranscript(context.turn.run, context.turn.branch)
                    .map((commit) => `${commit.kind}:${commit.content?.value ?? ""}`)
                    .join("\n");
                // Recorded by reference, so releasing that content is a retention event
                // separable from a rewrite superseding the commits it described.
                const ref = (await store.put(new TextEncoder().encode(shown))).ref;
                shownRefs.push(ref);
                const exchange = await context.model.call({
                    sections: [
                        new TurnPromptSection(
                            new TurnPromptSectionName("transcript"),
                            TurnShownContent.reference(ref),
                            TurnOmission.none
                        )
                    ],
                    catalog: [],
                    admitted: [],
                    covers: await context.modelInput.accountable()
                });
                inputs.push(exchange.input);
                return context.outcome.succeed(
                    new RunCommit({
                        id: new RunCommitId(resultId),
                        run: context.turn.run,
                        branch: context.turn.branch,
                        kind: "result",
                        parents: [exchange.input],
                        pins: context.turn.pins,
                        writer: { kind: "turn", token: context.token },
                        subjectTurn: context.turn.id,
                        content: output
                    })
                );
            };
            await expect(
                hostFor(callReadingTranscript("call-result")).execute(value.token)
            ).resolves.toMatchObject({ kind: "succeeded" });

            const input = inputs[0]!;
            const replay = new TurnModelInputReplay({
                repository: value.repository,
                content: store
            });
            const request = await replay.reconstruct(input);
            // The commit the call read is fixed by ancestry: the modelInput commit's parent.
            expect(request.baseCommit.equals(second.id)).toBe(true);
            expect(turnModelRequestBytes(request)).toEqual(sent[0]);
            const asRead = transcriptIds(value, request.baseCommit);
            expect(asRead).toEqual([ids.root.value, first.id.value, second.id.value]);

            const reduction = rewrite(
                value,
                "rewrite-after-the-call",
                new RunCommitId("call-result"),
                [first.id, second.id]
            );
            installed(value, reduction);

            // Backward: the earlier call rebuilds whole, byte for byte, and its transcript is
            // the one it read. Shadowing supersedes without releasing. A host deriving at the
            // branch head instead would fail here, because that transcript is a different one.
            const again = await replay.reconstruct(input);
            expect(turnModelRequestBytes(again)).toEqual(sent[0]);
            expect(transcriptIds(value, again.baseCommit)).toEqual(asRead);
            expect(transcriptIds(value)).not.toEqual(asRead);

            // Forward: the next call sends the reduced transcript, and reconstructability holds
            // over the reduced request rather than over the one the rewrite superseded.
            const secondTurn = new TurnId("turn-after-rewrite");
            const head = value.repository.transaction(
                (tx) => value.repository.loadBranch(tx, ids.branch)!.head
            );
            const placement = new TurnPlacementSnapshot(secondTurn, pins(), []);
            value.runtime.createTurn(
                {
                    turn: new Turn({
                        id: secondTurn,
                        run: ids.run,
                        branch: ids.branch,
                        startHead: head,
                        effectiveInput: head,
                        pins: pins(),
                        placement: placement.digest,
                        input: content("a"),
                        revision: new Revision(0)
                    }),
                    placement
                },
                branchRevision(value)
            );
            value.runtime.claimTurn(
                secondTurn,
                new Revision(0),
                ids.holder,
                new Date(1000),
                new Date(5000)
            );
            await expect(
                hostFor(callReadingTranscript("second-call-result")).execute({
                    turn: secondTurn,
                    holder: ids.holder,
                    epoch: 1
                })
            ).resolves.toMatchObject({ kind: "succeeded" });

            const reduced = await replay.reconstruct(inputs[1]!);
            expect(turnModelRequestBytes(reduced)).toEqual(sent[1]);
            expect(sent[1]).not.toEqual(sent[0]);
            const shownFirst = new TextDecoder().decode(request.sections[0]!.bytes);
            const shownSecond = new TextDecoder().decode(reduced.sections[0]!.bytes);
            expect(shownFirst).toContain(content("1").value);
            expect(shownSecond).not.toContain(content("1").value);
            expect(shownSecond).toContain(content("9").value);

            // The disjointness is a pair, not one arm. Shadowing left the earlier call
            // rebuildable above; ending custody of the content that call named is what makes
            // it fail typed, so Tenant retention policy stays the only thing that ends
            // custody and a reduction can never be mistaken for a loss.
            store.release(shownRefs[0]!);
            await expect(replay.reconstruct(inputs[0]!)).rejects.toBeInstanceOf(AgentCoreError);
            await expect(replay.reconstruct(inputs[0]!)).rejects.toMatchObject({
                code: "run.model-input-unrebuildable",
                message: expect.stringContaining(shownRefs[0]!.value)
            });
            // The reduced call, whose content was never released, still rebuilds.
            expect(turnModelRequestBytes(await replay.reconstruct(inputs[1]!))).toEqual(sent[1]);
        }
    );
});

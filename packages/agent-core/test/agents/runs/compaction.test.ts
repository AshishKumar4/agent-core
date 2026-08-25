import { describe, expect, it } from "vitest";
import { Revision, type ContentRef } from "../../../src/core";
import type { ContentStore } from "../../../src/content";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId } from "../../../src/execution-references";
import { InvocationId } from "../../../src/interaction-references";
import { ReceiptId } from "../../../src/invocations";
import { RunCommit, type RunCommitInit } from "../../../src/agents/runs/commit";
import { MemoryRunStorage, RunRepository } from "../../../src/agents/runs";
import {
    TurnCommitOmission,
    TurnExecutor,
    TurnExecutorHost,
    TurnModelInput,
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
    UncontributedCutPoints,
    ids,
    pins,
    refs,
    seedRunningTurn,
    type Assembled
} from "./fixture";

type Harness = ReturnType<typeof seedRunningTurn>;

const rewriteReceipt = new ReceiptId("receipt-rewrite");
const encoder = new TextEncoder();

class CallingExecutor extends TurnExecutor {
    public constructor(private readonly body: (context: TurnContext) => Promise<TurnOutcome>) {
        super();
    }

    public async execute(context: TurnContext): Promise<TurnOutcome> {
        return this.body(context);
    }
}

/** The typed failure a Turn refused with, so the code and the discrepancy are both asserted. */
async function refusedBy<Result>(execute: () => Promise<Result>): Promise<AgentCoreError> {
    try {
        await execute();
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw error;
    }
    throw new TypeError("Expected the Turn to refuse an unaccounted surface");
}

function branchRevision(value: Harness): Revision {
    return value.repository.transaction(
        (tx) => value.repository.loadBranch(tx, ids.branch)!.revision
    );
}

function message(
    value: Harness,
    id: string,
    parent: RunCommitId,
    body: ContentRef,
    requests?: readonly InvocationId[]
): RunCommit {
    const init: Assembled<RunCommitInit> = {
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "message",
        parents: [parent],
        pins: pins(),
        writer: { kind: "turn", token: { turn: ids.turn, holder: ids.holder, epoch: 1 } },
        subjectTurn: ids.turn,
        content: body
    };
    if (requests !== undefined) init.requests = requests;
    const commit = new RunCommit(init);
    value.runtime.appendTurnCommit(commit, branchRevision(value), new Date(1100));
    return commit;
}

/** The `invocation` commit answering one request: a graph fact that names no content. */
function answer(
    value: Harness,
    id: string,
    parent: RunCommitId,
    invocation: InvocationId
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
            cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
        },
        subjectTurn: ids.turn,
        invocation,
        receipt: refs.receipt
    });
    value.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
        kind: "receipt",
        run: ids.run,
        receipt: refs.receipt,
        audit: refs.audit,
        invocation,
        subjectTurn: ids.turn
    });
    value.runtime.appendSystemEvidenceCommit(commit, branchRevision(value), new Date(1200));
    return commit;
}

/** Settles the seeded Turn, so a control writer may append where a lease held the branch. */
function finish(value: Harness, id: string, parent: RunCommitId, body: ContentRef): void {
    value.runtime.completeTurn({
        turn: ids.turn,
        expectedTurnRevision: value.running.revision,
        expectedBranchRevision: branchRevision(value),
        token: value.token,
        outcome: "succeeded",
        commit: new RunCommit({
            id: new RunCommitId(id),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [parent],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: body
        }),
        now: new Date(1300)
    });
}

/** A compaction: the replacement content, plus the identities it removes from the surface. */
function compaction(
    value: Harness,
    id: string,
    parent: RunCommitId,
    shadows: readonly RunCommitId[],
    summary: ContentRef
): RunCommit {
    const init: Assembled<RunCommitInit> = {
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "rewrite",
        parents: [parent],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "control", audit: refs.audit, receipt: rewriteReceipt }
        },
        shadows,
        content: summary,
        receipt: rewriteReceipt
    };
    const commit = new RunCommit(init);
    value.evidence.controls.set(`${rewriteReceipt.value}:${refs.audit.value}`, {
        kind: "control",
        run: ids.run,
        receipt: rewriteReceipt,
        audit: refs.audit,
        proposalDigest: commit.proposalDigest.value
    });
    value.runtime.reserveRunRewrite(ids.run, ids.branch, commit.id, branchRevision(value));
    value.runtime.rewriteRun(commit, branchRevision(value), new Date(1400));
    return commit;
}

/**
 * A Run whose branch carries a root and three messages. Every body goes into the Run's own
 * content store, because that is the only plane a Run commit may name.
 */
async function seeded() {
    const value = seedRunningTurn();
    const store = value.storage.content;
    const bodies: ContentRef[] = [];
    for (const text of ["first", "second", "third"]) {
        bodies.push((await store.put(encoder.encode(text))).ref);
    }
    const commits = [
        message(value, "turn-1", ids.root, bodies[0]!),
        message(value, "turn-2", new RunCommitId("turn-1"), bodies[1]!),
        message(value, "turn-3", new RunCommitId("turn-2"), bodies[2]!)
    ];
    return { store, value, commits };
}

interface Dispatch {
    readonly host: (
        body: (context: TurnContext) => Promise<TurnOutcome>
    ) => TurnExecutorHost<object>;
    readonly sent: Uint8Array[];
}

function dispatcher(value: Harness, store: ContentStore, output: ContentRef): Dispatch {
    const sent: Uint8Array[] = [];
    return {
        sent,
        host: (body) =>
            new TurnExecutorHost({
                runtime: value.runtime,
                cutPoints: new UncontributedCutPoints(),
                executor: new CallingExecutor(body),
                content: store,
                operations: { resolve: async () => [] },
                prompt: { assemble: async () => output },
                invocations: { invoke: async () => ({ tier: "direct" as const, output: {} }) },
                model: {
                    call: async (request: TurnModelCall) => {
                        sent.push(turnModelRequestBytes(request));
                        return { output, usage: { inputTokens: 1, outputTokens: 1 } };
                    }
                },
                stream: { publish: async () => undefined },
                now: () => new Date(2000)
            })
    };
}

/**
 * Renders one section over the commits `covers` names, reading each commit's own content, so
 * the bytes the model observes and the coverage the record claims describe the same commits.
 */
function surface(
    context: TurnContext,
    store: ContentStore,
    covers: readonly RunCommitId[],
    omission: TurnOmission = TurnOmission.none,
    withheld: readonly TurnCommitOmission[] = []
) {
    return async (bytes: Uint8Array) => {
        const ref = (await store.put(bytes)).ref;
        return context.model.call({
            sections: [
                new TurnPromptSection(
                    new TurnPromptSectionName("transcript"),
                    TurnShownContent.reference(ref),
                    omission
                )
            ],
            catalog: [],
            admitted: [],
            covers,
            withheld
        });
    };
}

function resultCommit(context: TurnContext, id: string, parent: RunCommitId, body: ContentRef) {
    return new RunCommit({
        id: new RunCommitId(id),
        run: context.turn.run,
        branch: context.turn.branch,
        kind: "result",
        parents: [parent],
        pins: context.turn.pins,
        writer: { kind: "turn", token: context.token },
        subjectTurn: context.turn.id,
        content: body
    });
}

describe("Compaction as a policy over rewrite", () => {
    it(
        "[C13-TURN-SURFACE-ACCOUNTED] a compaction is a rewrite, and the call reconstructs the compacted surface rather than the ancestry",
        { tags: "p0" },
        async () => {
            const { store, value, commits } = await seeded();
            const summary = (await store.put(encoder.encode("summary of first..second"))).ref;
            const output = (await store.put(encoder.encode("response"))).ref;
            const installed = compaction(
                value,
                "compaction-1",
                commits[2]!.id,
                [commits[0]!.id, commits[1]!.id],
                summary
            );

            const dispatch = dispatcher(value, store, output);
            let accounted: readonly RunCommitId[] = [];
            let input: RunCommitId | undefined;
            const outcome = await dispatch
                .host(async (context) => {
                    accounted = await context.modelInput.accountable();
                    const bytes = encoder.encode(`root\nsummary of first..second\nthird`);
                    const exchange = await surface(context, store, accounted)(bytes);
                    input = exchange.input;
                    return context.outcome.succeed(
                        resultCommit(context, "compacted-result", exchange.input, output)
                    );
                })
                .execute(value.token);
            expect(outcome).toMatchObject({ kind: "succeeded" });

            // The surface the model read is the compacted one: the replacement stands where
            // the earliest commit it shadows stood, and neither shadowed commit is in it.
            expect(accounted.map((commit) => commit.value)).toEqual([
                ids.root.value,
                installed.id.value,
                commits[2]!.id.value
            ]);

            const replay = new TurnModelInputReplay({
                repository: value.repository,
                content: store
            });
            const rebuilt = await replay.reconstruct(input!);
            expect(turnModelRequestBytes(rebuilt)).toEqual(dispatch.sent[0]!);
            expect(rebuilt.covers.map((commit) => commit.value)).toEqual([
                ids.root.value,
                installed.id.value,
                commits[2]!.id.value
            ]);

            // Nothing was deleted to achieve it: both shadowed commits keep their identity and
            // still retain the content they name, so shadowing supersedes without releasing.
            for (const shadowed of [commits[0]!, commits[1]!]) {
                const stored = value.repository.transaction((tx) =>
                    value.repository.loadCommit(tx, shadowed.id)
                );
                expect(stored?.content?.value).toBe(shadowed.content!.value);
                await expect(store.get(shadowed.content!)).resolves.toBeInstanceOf(Uint8Array);
            }
        }
    );

    it(
        "[C13-TURN-SURFACE-ACCOUNTED] refuses the same reduction while it lives only in executor memory and admits it once the rewrite is a commit",
        { tags: "p0" },
        async () => {
            const { store, value, commits } = await seeded();
            const output = (await store.put(encoder.encode("response"))).ref;
            // Exactly what a host holding an in-memory shadow set would assemble and honestly
            // declare: the surviving commits, with the reduction recorded nowhere.
            const reduced = [ids.root, commits[2]!.id];

            const memory = dispatcher(value, store, output);
            const refusal = await refusedBy(() =>
                memory
                    .host(async (context) => {
                        const exchange = await surface(
                            context,
                            store,
                            reduced
                        )(encoder.encode("root\nthird"));
                        return context.outcome.succeed(
                            resultCommit(context, "memory-result", exchange.input, output)
                        );
                    })
                    .execute(value.token)
            );
            expect(refusal.code).toBe("turn.model-input-unaccounted");
            expect(refusal.message).toContain("carries 2 of the 4 commits");
            // Fail-closed on both planes: no model read it, and the false coverage claim
            // never became a record, so the branch stands exactly where it did.
            expect(memory.sent).toHaveLength(0);
            expect(
                value.repository.transaction(
                    (tx) => value.repository.loadBranch(tx, ids.branch)!.head
                ).value
            ).toBe(commits[2]!.id.value);

            // The identical reduction, once the branch itself carries it, is admitted.
            const summary = (await store.put(encoder.encode("summary"))).ref;
            compaction(
                value,
                "compaction-2",
                commits[2]!.id,
                [commits[0]!.id, commits[1]!.id],
                summary
            );
            const durable = dispatcher(value, store, output);
            const outcome = await durable
                .host(async (context) => {
                    const covers = await context.modelInput.accountable();
                    const exchange = await surface(
                        context,
                        store,
                        covers
                    )(encoder.encode("root\nsummary\nthird"));
                    return context.outcome.succeed(
                        resultCommit(context, "durable-result", exchange.input, output)
                    );
                })
                .execute(value.token);
            expect(outcome).toMatchObject({ kind: "succeeded" });
            expect(durable.sent).toHaveLength(1);
        }
    );

    it(
        "[C13-TURN-SURFACE-ACCOUNTED] refuses a surface that claims a commit its base transcript no longer holds",
        { tags: "p0" },
        async () => {
            const { store, value, commits } = await seeded();
            const output = (await store.put(encoder.encode("response"))).ref;
            const summary = (await store.put(encoder.encode("summary"))).ref;
            const installed = compaction(
                value,
                "compaction-3",
                commits[2]!.id,
                [commits[0]!.id, commits[1]!.id],
                summary
            );

            // A host abridging a shadowed commit to nothing rather than reading the
            // replacement: same length, and the position names a commit the surface cannot
            // carry, because the transcript reads the rewrite where that commit stood.
            const stale = [ids.root, commits[0]!.id, commits[2]!.id];
            const dispatch = dispatcher(value, store, output);
            const refusal = await refusedBy(() =>
                dispatch
                    .host(async (context) => {
                        const exchange = await surface(
                            context,
                            store,
                            stale
                        )(encoder.encode("root\nfirst\nthird"));
                        return context.outcome.succeed(
                            resultCommit(context, "stale-result", exchange.input, output)
                        );
                    })
                    .execute(value.token)
            );
            expect(refusal.code).toBe("turn.model-input-unaccounted");
            expect(refusal.message).toContain("position 1");
            expect(refusal.message).toContain(commits[0]!.id.value);
            expect(refusal.message).toContain(installed.id.value);
            expect(dispatch.sent).toHaveLength(0);
        }
    );

    it(
        "[C13-TURN-SURFACE-ACCOUNTED] composes a compaction with an abridgement and rebuilds exactly what was sent",
        { tags: "p0" },
        async () => {
            const { store, value, commits } = await seeded();
            const output = (await store.put(encoder.encode("response"))).ref;
            const summary = (await store.put(encoder.encode("summary"))).ref;
            compaction(
                value,
                "compaction-4",
                commits[2]!.id,
                [commits[0]!.id, commits[1]!.id],
                summary
            );

            const whole = encoder.encode("root\nsummary\nthird and a long tail nobody read");
            const shown = whole.slice(0, 20);
            const dispatch = dispatcher(value, store, output);
            let input: RunCommitId | undefined;
            let covered: readonly RunCommitId[] = [];
            const outcome = await dispatch
                .host(async (context) => {
                    covered = await context.modelInput.accountable();
                    const exchange = await surface(
                        context,
                        store,
                        covered,
                        TurnOmission.exact(whole.length - shown.length),
                        // The tail the abridgement dropped is the third message's rendering,
                        // so the attribution names that commit and accounts for all of it.
                        [
                            new TurnCommitOmission(
                                commits[2]!.id,
                                TurnOmission.exact(whole.length - shown.length)
                            )
                        ]
                    )(shown);
                    input = exchange.input;
                    return context.outcome.succeed(
                        resultCommit(context, "composed-result", exchange.input, output)
                    );
                })
                .execute(value.token);
            expect(outcome).toMatchObject({ kind: "succeeded" });

            const replay = new TurnModelInputReplay({
                repository: value.repository,
                content: store
            });
            const rebuilt = await replay.reconstruct(input!);
            expect(turnModelRequestBytes(rebuilt)).toEqual(dispatch.sent[0]!);

            // The two divergences stay separable in the record: which commits the surface
            // carries is the compaction, how many bytes of them it carries is the
            // abridgement, and neither field states the other's fact.
            expect(rebuilt.covers).toHaveLength(3);
            expect(rebuilt.covers.some((commit) => commit.equals(commits[0]!.id))).toBe(false);
            expect(rebuilt.sections[0]!.bytes).toEqual(shown);
            expect(rebuilt.sections[0]!.omission).toEqual(
                TurnOmission.exact(whole.length - shown.length)
            );
        }
    );

    it(
        "[C13-TURN-SURFACE-ACCOUNTED] an abridgement leaves the branch carrying what a compaction removes, so the next call re-expands",
        { tags: "p0" },
        async () => {
            const abridged = await seeded();
            const abridgedOutput = (await abridged.store.put(encoder.encode("response"))).ref;
            const dispatch = dispatcher(abridged.value, abridged.store, abridgedOutput);
            let after: readonly RunCommitId[] = [];
            await dispatch
                .host(async (context) => {
                    const covers = await context.modelInput.accountable();
                    // Withholding every byte of history is still an abridgement: the record
                    // keeps the commits, so the branch is unchanged by it.
                    const exchange = await surface(
                        context,
                        abridged.store,
                        covers,
                        TurnOmission.unknown,
                        // Every carried commit is rendered as no bytes at all, and the host
                        // never measured what that dropped, so every one is named as unknown.
                        covers.map((commit) => new TurnCommitOmission(commit, TurnOmission.unknown))
                    )(encoder.encode(""));
                    after = await context.modelInput.accountable();
                    return context.outcome.succeed(
                        resultCommit(context, "abridged-result", exchange.input, abridgedOutput)
                    );
                })
                .execute(abridged.value.token);

            // Every commit an abridgement withheld is still what the next call must carry.
            expect(after.map((commit) => commit.value)).toContain(abridged.commits[0]!.id.value);
            expect(after.map((commit) => commit.value)).toContain(abridged.commits[1]!.id.value);

            // A compaction is the other answer, and it is the one that changes the branch.
            const compacted = await seeded();
            const summary = (await compacted.store.put(encoder.encode("summary"))).ref;
            compaction(
                compacted.value,
                "compaction-5",
                compacted.commits[2]!.id,
                [compacted.commits[0]!.id, compacted.commits[1]!.id],
                summary
            );
            const reduced = compacted.value.runtime
                .effectiveTranscript(ids.run, ids.branch)
                .map((commit) => commit.id.value);
            expect(reduced).not.toContain(compacted.commits[0]!.id.value);
            expect(reduced).not.toContain(compacted.commits[1]!.id.value);
        }
    );

    it(
        "[C13-TURN-SURFACE-ACCOUNTED] a surface accounts for history and never for a graph fact or an earlier surface",
        { tags: "p0" },
        async () => {
            const value = seedRunningTurn();
            const store = value.storage.content;
            const output = (await store.put(encoder.encode("response"))).ref;
            const asked = message(
                value,
                "asks",
                ids.root,
                (await store.put(encoder.encode("q"))).ref,
                [refs.invocation]
            );
            const answered = answer(value, "answers", asked.id, refs.invocation);

            const dispatch = dispatcher(value, store, output);
            let first: readonly RunCommitId[] = [];
            let second: readonly RunCommitId[] = [];
            const outcome = await dispatch
                .host(async (context) => {
                    first = await context.modelInput.accountable();
                    await surface(context, store, first)(encoder.encode("q"));
                    second = await context.modelInput.accountable();
                    const two = await surface(context, store, second)(encoder.encode("q again"));
                    return context.outcome.succeed(
                        resultCommit(context, "domain-result", two.input, output)
                    );
                })
                .execute(value.token);
            expect(outcome).toMatchObject({ kind: "succeeded" });

            // An `invocation` commit names no content of its own: what the model reads about
            // that Invocation is the message that requested it, and §5.2 keeps the pairing in
            // the graph so no cut can strand either half.
            expect(first.map((commit) => commit.value)).toEqual([ids.root.value, asked.id.value]);
            expect(first.some((commit) => commit.equals(answered.id))).toBe(false);

            // The first call's own record is now an ancestor of the second's base, and it is
            // not history: a surface never accounts for an earlier surface.
            expect(second.map((commit) => commit.value)).toEqual(
                first.map((commit) => commit.value)
            );
            expect(dispatch.sent).toHaveLength(2);
        }
    );

    it(
        "[C13-TURN-SURFACE-ACCOUNTED] refuses on the way out a surface no seam refused on the way in",
        { tags: "p0" },
        async () => {
            const { store, value, commits } = await seeded();
            // A writer that bypassed the seam: a well-formed modelInput commit whose record
            // claims two of the four commits its base transcript holds.
            const record = new TurnModelInput({
                sections: [
                    new TurnPromptSection(
                        new TurnPromptSectionName("transcript"),
                        TurnShownContent.inline(encoder.encode("root\nthird"))
                    )
                ],
                catalog: [],
                admitted: [],
                admissionCut: 0,
                covers: [ids.root, commits[2]!.id]
            });
            const document = await store.put(TurnModelInput.encode(record));
            const forged = new RunCommit({
                id: new RunCommitId("forged-input"),
                run: ids.run,
                branch: ids.branch,
                kind: "modelInput",
                parents: [commits[2]!.id],
                pins: pins(),
                writer: { kind: "turn", token: value.token },
                subjectTurn: ids.turn,
                content: document.ref
            });
            value.runtime.appendTurnCommit(forged, branchRevision(value), new Date(1500));

            const replay = new TurnModelInputReplay({
                repository: value.repository,
                content: store
            });
            const refusal = await refusedBy(() => replay.reconstruct(forged.id));
            expect(refusal.code).toBe("turn.model-input-unaccounted");
            expect(refusal.message).toContain("carries 2 of the 4 commits");
        }
    );

    it(
        "[C13-TURN-SURFACE-ACCOUNTED] accounts against the effective state of the base rather than its raw commit",
        { tags: "p0" },
        async () => {
            const { store, value, commits } = await seeded();
            const done = (await store.put(encoder.encode("done"))).ref;
            finish(value, "settled", commits[2]!.id, done);
            const marker = new RunCommit({
                id: new RunCommitId("undo-to-first"),
                run: ids.run,
                branch: ids.branch,
                kind: "undo",
                parents: [new RunCommitId("settled")],
                pins: pins(),
                writer: {
                    kind: "system",
                    cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
                },
                selects: commits[0]!.id,
                receipt: refs.receipt
            });
            value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
                kind: "control",
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                proposalDigest: marker.proposalDigest.value
            });
            value.runtime.undoRun(marker, branchRevision(value), new Date(1500));

            const replay = new TurnModelInputReplay({
                repository: value.repository,
                content: store
            });
            // The undo marker's own ancestry still reaches turn-2, turn-3 and the Turn's
            // result; its selection does not, and the selection is what a call reads.
            expect(replay.accountable(marker.id).map((commit) => commit.value)).toEqual([
                ids.root.value,
                commits[0]!.id.value
            ]);
        }
    );

    it(
        "[C13-RUN-DISTINCTION-REPRESENTABLE] attributes an abridgement inside a multi-commit section to the commit it withheld, and rebuilds the request without reading it",
        { tags: "p0" },
        async () => {
            const { store, value, commits } = await seeded();
            const output = (await store.put(encoder.encode("response"))).ref;
            const dropped = commits[1]!;
            const withheldBytes = (await store.get(dropped.content!)).length;
            const rendered = encoder.encode("root\nfirst\nthird");
            const dispatch = dispatcher(value, store, output);
            let input: RunCommitId | undefined;
            let refusal: AgentCoreError | undefined;
            let covered: readonly RunCommitId[] = [];
            const outcome = await dispatch
                .host(async (context) => {
                    covered = await context.modelInput.accountable();
                    // One section renders the whole transcript and drops every byte of the
                    // second message. The attributed surface states which commit that was.
                    // The same surface without the attribution is the record the rule forbids,
                    // so the seam refuses it rather than recording it.
                    const attributed = await surface(
                        context,
                        store,
                        covered,
                        TurnOmission.exact(withheldBytes),
                        [new TurnCommitOmission(dropped.id, TurnOmission.exact(withheldBytes))]
                    )(rendered);
                    input = attributed.input;
                    try {
                        await surface(
                            context,
                            store,
                            await context.modelInput.accountable(),
                            TurnOmission.exact(withheldBytes)
                        )(rendered);
                    } catch (error) {
                        if (!(error instanceof AgentCoreError)) throw error;
                        refusal = error;
                    }
                    return context.outcome.succeed(
                        resultCommit(context, "attributed-result", attributed.input, output)
                    );
                })
                .execute(value.token);
            expect(outcome).toMatchObject({ kind: "succeeded" });

            // A reader could not tell `turn-2`, carried as no bytes, from the two commits the
            // section carried whole, so the unattributed surface is not a record this Run
            // holds. Fail-closed on both planes: no model read it and no record carries it.
            expect(covered).toHaveLength(4);
            expect(refusal?.code).toBe("turn.model-input-unaccounted");
            expect(refusal?.message).toContain("carries 4 commits");
            expect(dispatch.sent).toHaveLength(1);

            const stored = value.repository.transaction((tx) =>
                value.repository.loadCommit(tx, input!)
            );
            const record = TurnModelInput.decode(await store.get(stored!.content!));
            expect(
                record.withheld.map((entry) => [entry.commit.value, entry.omission.withheldBytes])
            ).toEqual([[dropped.id.value, withheldBytes]]);

            // The accounting is a separate fact from the bytes: the request rebuilds byte for
            // byte as it was sent, and those are the bytes of a request that states no
            // attribution at all, written out here rather than read back from the record.
            const replay = new TurnModelInputReplay({
                repository: value.repository,
                content: store
            });
            const rebuilt = await replay.reconstruct(input!);
            expect(turnModelRequestBytes(rebuilt)).toEqual(dispatch.sent[0]);
            expect(
                turnModelRequestBytes({
                    input: rebuilt.input,
                    baseCommit: rebuilt.baseCommit,
                    sections: [
                        {
                            name: new TurnPromptSectionName("transcript"),
                            bytes: rendered,
                            omission: TurnOmission.exact(withheldBytes)
                        }
                    ],
                    catalog: [],
                    admitted: [],
                    admissionCut: 0,
                    covers: covered
                })
            ).toEqual(dispatch.sent[0]);
        }
    );

    it(
        "[C13-RUN-DISTINCTION-REPRESENTABLE] carries a complete attribution over two commits in one section through a restart, and rebuilds bytes the attribution never reaches",
        { tags: "p0" },
        async () => {
            const { store, value, commits } = await seeded();
            const output = (await store.put(encoder.encode("response"))).ref;
            // One section renders the transcript and drops both middle messages whole.
            const firstBytes = (await store.get(commits[0]!.content!)).length;
            const secondBytes = (await store.get(commits[1]!.content!)).length;
            const rendered = encoder.encode("root\nthird");
            const dispatch = dispatcher(value, store, output);
            let input: RunCommitId | undefined;
            let covered: readonly RunCommitId[] = [];
            const outcome = await dispatch
                .host(async (context) => {
                    covered = await context.modelInput.accountable();
                    const exchange = await surface(
                        context,
                        store,
                        covered,
                        TurnOmission.exact(firstBytes + secondBytes),
                        // Stated later commit first, so the record's own order is the one the
                        // restart reads back rather than the one this host happened to list.
                        [
                            new TurnCommitOmission(commits[1]!.id, TurnOmission.exact(secondBytes)),
                            new TurnCommitOmission(commits[0]!.id, TurnOmission.exact(firstBytes))
                        ]
                    )(rendered);
                    input = exchange.input;
                    return context.outcome.succeed(
                        resultCommit(context, "two-commit-result", exchange.input, output)
                    );
                })
                .execute(value.token);
            expect(outcome).toMatchObject({ kind: "succeeded" });
            expect(covered).toHaveLength(4);

            // The restart discards every executor process and keeps the records, whose one
            // aggregate snapshot carries the Run's content custody with them.
            const reopened = new MemoryRunStorage(
                ids.holder.tenantId,
                ids.actor,
                value.storage.snapshot()
            );
            const repository = new RunRepository(reopened);
            const rebuilt = await new TurnModelInputReplay({
                repository,
                content: reopened.content
            }).reconstruct(input!);
            expect(turnModelRequestBytes(rebuilt)).toEqual(dispatch.sent[0]);
            expect(rebuilt.sections[0]!.bytes).toEqual(rendered);

            // Both withheld commits are named after the restart, ordered by commit, and the
            // two the section carried whole name no entry.
            const commit = repository.transaction((tx) => repository.loadCommit(tx, input!));
            const record = TurnModelInput.decode(await reopened.content.get(commit!.content!));
            expect(
                record.withheld.map((entry) => [entry.commit.value, entry.omission.withheldBytes])
            ).toEqual([
                [commits[0]!.id.value, firstBytes],
                [commits[1]!.id.value, secondBytes]
            ]);
            expect(record.covers).toHaveLength(4);

            // The request the restart rebuilds is the request a surface stating no attribution
            // at all would have sent, written out here rather than read back from the record.
            expect(
                turnModelRequestBytes({
                    input: rebuilt.input,
                    baseCommit: rebuilt.baseCommit,
                    sections: [
                        {
                            name: new TurnPromptSectionName("transcript"),
                            bytes: rendered,
                            omission: TurnOmission.exact(firstBytes + secondBytes)
                        }
                    ],
                    catalog: [],
                    admitted: [],
                    admissionCut: 0,
                    covers: covered
                })
            ).toEqual(dispatch.sent[0]);
        }
    );
});

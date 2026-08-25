import { describe, expect, it } from "vitest";
import type { ContentStore } from "../../../src/content";
import { ContentRef } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import {
    InterceptorDeclaration,
    InterceptorId,
    isFacetDataMap,
    type FacetData,
    type TurnBoundCutPoint
} from "../../../src/facets";
import { TurnId } from "../../../src/execution-references";
import {
    TurnCutPointPort,
    type TurnInterceptionResult,
    type TurnRewriteRule,
    type TurnStopRequest
} from "../../../src/operations";
import { RunCommitId } from "../../../src/execution-references";
import { RunCommit } from "../../../src/agents/runs/commit";
import {
    TurnCommitOmission,
    TurnExecutor,
    TurnModelInputReplay,
    TurnOmission,
    TurnPromptSection,
    TurnPromptSectionName,
    TurnShownContent,
    TurnStepAnnotation,
    TurnStepContext,
    TurnExecutorHost,
    turnModelRequestBytes,
    type TurnContext,
    type TurnModelCall,
    type TurnModelExchange,
    type TurnModelResult,
    type TurnOutcome
} from "../../../src/agents/runs/executor";
import { TurnInboxEntryId } from "../../../src/agents/runs/id";
import { TurnInboxEntry } from "../../../src/agents/runs/turn";
import { UncontributedCutPoints, content, harness, ids, pins, seedRunningTurn } from "./fixture";

const encoder = new TextEncoder();

/**
 * One scripted Turn-bound interceptor. The real schedule — ordering, protection-domain
 * confinement, gate fidelity, and the stop-versus-block distinction — is evidenced against
 * real contributed Facets in `test/operations/runtime.test.ts`; what these tests need is the
 * other half, which is where the executor fires each cut point and what it does with the
 * answer. So the schedule is scripted while the cut point's own rewrite rule is the real one:
 * the port hands each answer to the `admit` rule the host supplied, exactly as the runner
 * does, so a rule the host got wrong fails here rather than being mocked away.
 */
class ScriptedCutPoints extends TurnCutPointPort {
    public readonly seen: string[] = [];

    public constructor(
        private readonly script: Partial<
            Record<TurnBoundCutPoint, (value: FacetData, at: number) => FacetData | TurnStopRequest>
        >
    ) {
        super();
    }

    private counts: Record<string, number> = {};

    public override run(
        cutPoint: TurnBoundCutPoint,
        turn: TurnId,
        value: FacetData,
        admit: TurnRewriteRule
    ): TurnInterceptionResult {
        this.seen.push(`${cutPoint}@${turn.value}:${JSON.stringify(value)}`);
        const step = this.script[cutPoint];
        const at = (this.counts[cutPoint] = (this.counts[cutPoint] ?? 0) + 1) - 1;
        if (step === undefined) {
            return Object.freeze({ value, traces: Object.freeze([]), stop: undefined });
        }
        const answer = step(value, at);
        if (isStop(answer)) {
            // The runner's own split, mirrored so the caller under test sees what it would
            // really see: `turn.step` returns the request, and every other Turn-bound cut
            // point blocks outright.
            if (cutPoint !== "turn.step") {
                throw new AgentCoreError("authority.denied", answer.reason);
            }
            return Object.freeze({ value, traces: Object.freeze([]), stop: answer });
        }
        admit(value, answer, declarationFor(cutPoint));
        return Object.freeze({ value: answer, traces: Object.freeze([]), stop: undefined });
    }
}

function isStop(value: FacetData | TurnStopRequest): value is TurnStopRequest {
    return (
        isFacetDataMap(value) &&
        "reason" in value &&
        "interceptor" in value &&
        "contributor" in value
    );
}

function declarationFor(cutPoint: TurnBoundCutPoint): InterceptorDeclaration {
    return new InterceptorDeclaration(new InterceptorId("supervisor"), cutPoint, "rewrite", 0);
}

function section(
    name: string,
    body: string,
    omission: TurnOmission = TurnOmission.none
): TurnPromptSection {
    return new TurnPromptSection(
        new TurnPromptSectionName(name),
        TurnShownContent.inline(encoder.encode(body)),
        omission
    );
}

/** One `message` commit, so a call's coverage carries more than the root alone. */
function message(seeded: Fixture["seeded"], id: string, body: ContentRef): RunCommit {
    const commit = new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "message",
        parents: [ids.root],
        pins: pins(),
        writer: { kind: "turn", token: seeded.token },
        subjectTurn: ids.turn,
        content: body
    });
    seeded.runtime.appendTurnCommit(
        commit,
        seeded.repository.transaction(
            (tx) => seeded.repository.loadBranch(tx, ids.branch)!.revision
        ),
        new Date(1_100)
    );
    return commit;
}

class FunctionExecutor extends TurnExecutor {
    public constructor(private readonly body: (turn: TurnContext) => Promise<TurnOutcome>) {
        super();
    }

    public async execute(turn: TurnContext): Promise<TurnOutcome> {
        return this.body(turn);
    }
}

class RecordingModelPort {
    public readonly bytes: Uint8Array[] = [];

    public constructor(private readonly output: ContentRef) {}

    public readonly call = async (request: TurnModelCall): Promise<TurnModelResult> => {
        this.bytes.push(turnModelRequestBytes(request));
        return { output: this.output, usage: { inputTokens: 1, outputTokens: 1 } };
    };
}

function resultCommit(
    turn: TurnContext,
    id: string,
    parent: RunCommitId,
    result: ContentRef
): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: turn.turn.run,
        branch: turn.turn.branch,
        kind: "result",
        parents: [parent],
        pins: turn.turn.pins,
        writer: { kind: "turn", token: turn.token },
        subjectTurn: turn.turn.id,
        content: result
    });
}

interface Fixture {
    readonly seeded: ReturnType<typeof seedRunningTurn>;
    readonly store: ContentStore;
    readonly output: ContentRef;
    readonly port: RecordingModelPort;
    readonly host: (
        executor: TurnExecutor,
        cutPoints: TurnCutPointPort
    ) => TurnExecutorHost<object>;
}

async function fixture(
    cutPoints: TurnCutPointPort = new UncontributedCutPoints()
): Promise<Fixture> {
    const seeded = seedRunningTurn(harness(undefined, cutPoints));
    // The Run's own content store is the only plane its records may name, so the prompt and
    // the response go through it and the refs are the addresses that store derived.
    const store = seeded.storage.content;
    const prompt = (await store.put(encoder.encode("assembled"))).ref;
    const output = (await store.put(encoder.encode("response"))).ref;
    const port = new RecordingModelPort(output);
    return {
        seeded,
        store,
        output,
        port,
        host: (executor, ports) =>
            new TurnExecutorHost({
                runtime: seeded.runtime,
                cutPoints: ports,
                executor,
                content: store,
                operations: { resolve: async () => [] },
                prompt: { assemble: async () => prompt },
                invocations: { invoke: async () => ({ tier: "direct" as const, output: {} }) },
                model: { call: port.call },
                stream: { publish: async () => undefined },
                now: () => new Date(2_000)
            })
    };
}

describe("Turn-bound interceptor cut points", () => {
    it(
        "[C13-TURN-PROMPT-ASSEMBLE] records and reconstructs the rewritten sections, not the ones the executor assembled",
        { tags: "p0" },
        async () => {
            // A rewrite that reorders, removes, and adds — all three of §4.4's verbs in one
            // answer, so a host that honoured only some of them fails.
            const rewrittenSections: FacetData = [
                section("injected", "steering note").toData(),
                section("second", "second body").toData()
            ];
            const cutPoints = new ScriptedCutPoints({
                "prompt.assemble": () => rewrittenSections
            });
            const base = await fixture(cutPoints);
            let exchange: TurnModelExchange | undefined;
            const executor = new FunctionExecutor(async (turn) => {
                exchange = await turn.model.call({
                    covers: await turn.modelInput.accountable(),
                    sections: [section("first", "first body"), section("second", "second body")],
                    catalog: [],
                    admitted: []
                });
                return turn.outcome.succeed(
                    resultCommit(turn, "assemble-result", exchange.input, base.output)
                );
            });
            await expect(
                base.host(executor, cutPoints).execute(base.seeded.token)
            ).resolves.toMatchObject({
                kind: "succeeded"
            });
            // The cut point saw the executor's sections, and the record carries the rewrite.
            expect(cutPoints.seen).toEqual([
                `prompt.assemble@${base.seeded.token.turn.value}:` +
                    JSON.stringify([
                        section("first", "first body").toData(),
                        section("second", "second body").toData()
                    ])
            ]);
            const replay = new TurnModelInputReplay({
                repository: base.seeded.repository,
                content: base.store
            });
            const replayed = await replay.reconstruct(exchange!.input);
            expect(replayed.sections.map((entry) => entry.name.value)).toEqual([
                "injected",
                "second"
            ]);
            // §5.6's reconstruction stays byte-exact across the rewrite: the request the model
            // received is the one the record rebuilds, which is only true because the cut
            // point fires before the record is produced.
            expect(turnModelRequestBytes(replayed)).toEqual(base.port.bytes[0]);
        }
    );

    it(
        "[C13-TURN-PROMPT-ASSEMBLE] refuses a rewrite that is not a section list and one that leaves no section at all",
        { tags: "p0" },
        async () => {
            const outcomes: string[] = [];
            const answers: readonly FacetData[] = [
                { sections: "rewritten" },
                [{ name: "broken" }],
                []
            ];
            for (const answer of answers) {
                const cutPoints = new ScriptedCutPoints({ "prompt.assemble": () => answer });
                const base = await fixture(cutPoints);
                const executor = new FunctionExecutor(async (turn) => {
                    await turn.model.call({
                        covers: await turn.modelInput.accountable(),
                        sections: [section("first", "first body")],
                        catalog: [],
                        admitted: []
                    });
                    return turn.outcome.succeed(
                        resultCommit(turn, "unreached", ids.root, base.output)
                    );
                });
                try {
                    await base.host(executor, cutPoints).execute(base.seeded.token);
                    outcomes.push("ADMITTED");
                } catch (error) {
                    outcomes.push(error instanceof Error ? error.message : "non-Error refusal");
                }
                // Nothing was recorded: the refusal lands before the model input commit.
                expect(base.port.bytes).toEqual([]);
            }
            expect(outcomes).toEqual([
                "Assembled prompt sections must be an array",
                "Prompt section contains missing or unknown fields",
                "A model input records at least one prompt section"
            ]);
        }
    );

    it(
        "[C13-TURN-STEP-STOP] annotates a step, then withdraws the Turn's remaining steps and model calls when a gate requests a stop",
        { tags: "p0" },
        async () => {
            const stop: TurnStopRequest = {
                interceptor: "supervisor",
                contributor: "workspace:supervisor",
                reason: "the same command failed three times"
            };
            const cutPoints = new ScriptedCutPoints({
                "turn.step": (value, at) => {
                    if (at >= 2) return stop;
                    const step = TurnStepContext.fromData(value);
                    return new TurnStepContext(step.ordinal, step.head, step.inboxCut, [
                        ...step.annotations,
                        new TurnStepAnnotation(new InterceptorId("supervisor"), `saw step ${at}`)
                    ]).toData();
                }
            });
            const base = await fixture(cutPoints);
            const observed: string[] = [];
            const executor = new FunctionExecutor(async (turn) => {
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    let decision;
                    try {
                        decision = await turn.step.open();
                    } catch (error) {
                        observed.push(
                            `open refused: ${error instanceof AgentCoreError ? error.code : "?"} ` +
                                `${error instanceof Error ? error.message : ""}`
                        );
                        break;
                    }
                    observed.push(
                        `${decision.kind}#${decision.step.ordinal} ` +
                            `annotations=${decision.step.annotations
                                .map((entry) => `${entry.interceptor.value}:${entry.note}`)
                                .join("|")}`
                    );
                    if (decision.kind === "stopped") {
                        // The kill switch: the model call the Turn was about to make is
                        // refused, and so is the next step.
                        await expect(
                            turn.model.call({
                                covers: await turn.modelInput.accountable(),
                                sections: [section("first", "after the stop")],
                                catalog: [],
                                admitted: []
                            })
                        ).rejects.toMatchObject({
                            code: "authority.denied",
                            message:
                                "Interceptor supervisor stopped this Turn, so it may not call the model again: " +
                                "the same command failed three times"
                        });
                    }
                }
                return turn.outcome.succeed(
                    resultCommit(turn, "stop-result", ids.root, base.output)
                );
            });
            await expect(
                base.host(executor, cutPoints).execute(base.seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });
            // Annotations accumulate across the Turn's own steps, the stop arrives as a
            // returned decision naming its interceptor, and asking for another step after
            // being told to stop is refused rather than answered again.
            expect(observed).toEqual([
                "proceed#0 annotations=supervisor:saw step 0",
                "proceed#1 annotations=supervisor:saw step 0|supervisor:saw step 1",
                "stopped#2 annotations=supervisor:saw step 0|supervisor:saw step 1",
                "open refused: authority.denied Interceptor supervisor stopped this Turn, " +
                    "so it may not open another Turn step: the same command failed three times"
            ]);
            // Terminalizing is left open: a stopped Turn that could not record its own
            // transition would be a Turn nothing can settle.
            expect(base.port.bytes).toEqual([]);
        }
    );

    it(
        "[C13-TURN-STEP-STOP] refuses a step rewrite that restates a host fact, forges another interceptor's annotation, or drops one",
        { tags: "p0" },
        async () => {
            const other = new InterceptorId("neighbour");
            const answers: readonly ((step: TurnStepContext) => FacetData)[] = [
                (step) => new TurnStepContext(step.ordinal + 1, step.head, step.inboxCut).toData(),
                (step) =>
                    new TurnStepContext(
                        step.ordinal,
                        new RunCommitId("forged"),
                        step.inboxCut
                    ).toData(),
                (step) => new TurnStepContext(step.ordinal, step.head, step.inboxCut + 1).toData(),
                (step) =>
                    new TurnStepContext(step.ordinal, step.head, step.inboxCut, [
                        new TurnStepAnnotation(other, "signed by someone else")
                    ]).toData()
            ];
            const outcomes: string[] = [];
            for (const answer of answers) {
                const cutPoints = new ScriptedCutPoints({
                    "turn.step": (value) => answer(TurnStepContext.fromData(value))
                });
                const base = await fixture(cutPoints);
                const executor = new FunctionExecutor(async (turn) => {
                    try {
                        await turn.step.open();
                        outcomes.push("ADMITTED");
                    } catch (error) {
                        outcomes.push(error instanceof Error ? error.message : "non-Error refusal");
                    }
                    return turn.outcome.succeed(
                        resultCommit(turn, "rule-result", ids.root, base.output)
                    );
                });
                await base.host(executor, cutPoints).execute(base.seeded.token);
            }
            const restated = "A turn.step rewrite may annotate a step, not restate it";
            expect(outcomes).toEqual([
                restated,
                restated,
                restated,
                "A step annotation names the interceptor that appended it"
            ]);
        }
    );

    it(
        "[C13-TURN-STEP-STOP] scopes a step's annotations and its stop to the Turn that fired the cut point",
        { tags: "p0" },
        async () => {
            // Two Turns opening steps through the same schedule, in two Runs, which is the
            // easier instance of the rule. A step is an iteration of one Turn's loop (§5.3),
            // so the second Turn opens at ordinal zero with an empty annotation list and is
            // not stopped by the first Turn's stop. The narrower instance — two Turns of ONE
            // Run, on one branch — is the test below.
            const firstTurnStop: TurnStopRequest = {
                interceptor: "supervisor",
                contributor: "workspace:supervisor",
                reason: "first Turn only"
            };
            const cutPoints = new ScriptedCutPoints({
                "turn.step": (value, at) => {
                    const step = TurnStepContext.fromData(value);
                    return at === 0
                        ? firstTurnStop
                        : new TurnStepContext(step.ordinal, step.head, step.inboxCut, [
                              ...step.annotations,
                              new TurnStepAnnotation(new InterceptorId("supervisor"), "later Turn")
                          ]).toData();
                }
            });
            const base = await fixture(cutPoints);
            const observed: string[] = [];
            const executor = new FunctionExecutor(async (turn) => {
                const decision = await turn.step.open();
                observed.push(
                    `${turn.turn.id.value}: ${decision.kind}#${decision.step.ordinal} ` +
                        `annotations=${decision.step.annotations.length}`
                );
                return turn.outcome.succeed(
                    resultCommit(turn, `scoped-${turn.turn.id.value}`, ids.root, base.output)
                );
            });
            await base.host(executor, cutPoints).execute(base.seeded.token);
            const second = seedRunningTurn(harness(undefined, cutPoints), {
                id: new TurnId("turn-second")
            });
            // The second Turn belongs to a second Run, which owns its own content plane; the
            // same bytes written there resolve to the same address the first Run derived.
            const secondOutput = (await second.storage.content.put(encoder.encode("response"))).ref;
            await new TurnExecutorHost({
                runtime: second.runtime,
                cutPoints,
                executor,
                content: second.storage.content,
                operations: { resolve: async () => [] },
                prompt: { assemble: async () => secondOutput },
                invocations: { invoke: async () => ({ tier: "direct" as const, output: {} }) },
                model: { call: base.port.call },
                stream: { publish: async () => undefined },
                now: () => new Date(2_000)
            }).execute(second.token);
            expect(observed).toEqual([
                `${base.seeded.token.turn.value}: stopped#0 annotations=0`,
                "turn-second: proceed#0 annotations=1"
            ]);
        }
    );

    it(
        "[C13-TURN-INPUT-SUBMITTED] transforms a submission's payload, refuses one outright, and never offers a cancellation",
        { tags: "p0" },
        async () => {
            const replacement = content("f");
            const injectionStop: TurnStopRequest = {
                interceptor: "supervisor",
                contributor: "workspace:supervisor",
                reason: "prompt injection in the submission"
            };
            const cutPoints = new ScriptedCutPoints({
                "input.submitted": (value, at) => {
                    if (at === 1) return injectionStop;
                    if (!isFacetDataMap(value)) {
                        throw new TypeError("A submission envelope is an object");
                    }
                    return { ...value, payload: replacement.value };
                }
            });
            const seeded = seedRunningTurn(harness(undefined, cutPoints));
            const deliver = (event: string, key: string, payload: ContentRef, sequence: number) => {
                const entry = new TurnInboxEntry(
                    new TurnInboxEntryId(`${key}#${sequence}`),
                    seeded.token.turn,
                    sequence,
                    event,
                    payload,
                    payload.digest,
                    key,
                    event === "turn.cancel" ? seeded.token : undefined,
                    new Date(3_000)
                );
                const turn = seeded.repository.transaction((tx) =>
                    seeded.repository.loadTurn(tx, seeded.token.turn)
                );
                seeded.runtime.deliverEvent(
                    seeded.token.turn,
                    turn!.revision,
                    seeded.token,
                    entry,
                    new Date(3_000)
                );
            };

            deliver("user.message", "first", content("a"), 0);
            const stored = seeded.repository.transaction((tx) =>
                seeded.repository.listInbox(tx, seeded.token.turn)
            );
            // A transform substitutes content the interceptor already stored; the entry's
            // digest follows its reference, and its delivery identity is untouched.
            expect(stored.map((entry) => entry.payload.value)).toEqual([replacement.value]);
            expect(stored[0]?.payloadDigest.equals(replacement.digest)).toBe(true);
            expect(stored[0]?.event).toBe("user.message");
            expect(stored[0]?.idempotencyKey).toBe("first");

            // A block leaves no entry behind, because the cut point fires before the insert.
            expect(() => deliver("user.message", "second", content("b"), 1)).toThrowError(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "prompt injection in the submission"
                })
            );
            expect(
                seeded.repository.transaction((tx) =>
                    seeded.repository.listInbox(tx, seeded.token.turn)
                )
            ).toHaveLength(1);

            // The reserved cancellation is never offered to the cut point: a Facet that could
            // refuse it would suppress the fence that stops it.
            deliver("turn.cancel", "cancel", content("c"), 1);
            expect(cutPoints.seen.filter((entry) => entry.includes("turn.cancel"))).toEqual([]);
            expect(cutPoints.seen).toHaveLength(2);
        }
    );

    it(
        "[C13-TURN-INPUT-SUBMITTED] refuses a rewrite that changes the delivery identity or names an unresolvable payload",
        { tags: "p0" },
        async () => {
            const answers: readonly FacetData[] = [
                { event: "system.message", idempotencyKey: "first", payload: content("a").value },
                { event: "user.message", idempotencyKey: "forged", payload: content("a").value },
                { event: "user.message", idempotencyKey: "first", payload: "not-a-content-ref" },
                { event: "user.message", idempotencyKey: "first" }
            ];
            const outcomes: string[] = [];
            for (const answer of answers) {
                const cutPoints = new ScriptedCutPoints({ "input.submitted": () => answer });
                const seeded = seedRunningTurn(harness(undefined, cutPoints));
                const payload = content("a");
                const entry = new TurnInboxEntry(
                    new TurnInboxEntryId("first#0"),
                    seeded.token.turn,
                    0,
                    "user.message",
                    payload,
                    payload.digest,
                    "first",
                    undefined,
                    new Date(3_000)
                );
                const turn = seeded.repository.transaction((tx) =>
                    seeded.repository.loadTurn(tx, seeded.token.turn)
                );
                try {
                    seeded.runtime.deliverEvent(
                        seeded.token.turn,
                        turn!.revision,
                        seeded.token,
                        entry,
                        new Date(3_000)
                    );
                    outcomes.push("ADMITTED");
                } catch (error) {
                    outcomes.push(error instanceof Error ? error.message : "non-Error refusal");
                }
                expect(
                    seeded.repository.transaction((tx) =>
                        seeded.repository.listInbox(tx, seeded.token.turn)
                    )
                ).toEqual([]);
            }
            const identity =
                "An input.submitted rewrite may transform the payload, not the delivery identity";
            expect(outcomes).toEqual([
                identity,
                identity,
                "Content reference must be a SHA-256 content address",
                "Submitted input contains missing or unknown fields"
            ]);
        }
    );

    it(
        "[C13-TURN-STEP-STOP] scopes the ordinal, the annotations, and the stop to the Turn that fired the cut point, not to its Run",
        { tags: "p0" },
        async () => {
            // Two Turns of ONE Run, on one branch, through one schedule. The first is stopped
            // after two annotated steps. A step is an iteration of that Turn's loop (§5.3), so
            // its sibling opens at its own first step with no annotation and no stop.
            const stop: TurnStopRequest = {
                interceptor: "supervisor",
                contributor: "workspace:supervisor",
                reason: "this Turn's trajectory only"
            };
            const cutPoints = new ScriptedCutPoints({
                "turn.step": (value, at) => {
                    const step = TurnStepContext.fromData(value);
                    return at === 2
                        ? stop
                        : new TurnStepContext(step.ordinal, step.head, step.inboxCut, [
                              ...step.annotations,
                              new TurnStepAnnotation(
                                  new InterceptorId("supervisor"),
                                  `firing ${at}`
                              )
                          ]).toData();
                }
            });
            const base = await fixture(cutPoints);
            // The sibling is seeded on the same branch, at the head both Turns start from.
            const sibling = seedRunningTurn(base.seeded, { id: new TurnId("turn-sibling") });
            // The premise this test rests on, asserted rather than assumed: one Run, one
            // branch, two Turns.
            expect(sibling.running.run.value).toBe(base.seeded.running.run.value);
            expect(sibling.running.branch.value).toBe(base.seeded.running.branch.value);
            expect(sibling.token.turn.value).not.toBe(base.seeded.token.turn.value);
            const observed: string[] = [];

            const supervised = new FunctionExecutor(async (turn) => {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    const decision = await turn.step.open();
                    observed.push(
                        `${turn.turn.id.value}: ${decision.kind}#${decision.step.ordinal} ` +
                            `annotations=${decision.step.annotations.length}`
                    );
                    if (decision.kind === "stopped") break;
                }
                await expect(
                    turn.model.call({
                        covers: await turn.modelInput.accountable(),
                        sections: [section("body", "after the stop")],
                        catalog: [],
                        admitted: []
                    })
                ).rejects.toMatchObject({ code: "authority.denied" });
                return turn.outcome.succeed(
                    resultCommit(turn, "scoped-stopped", ids.root, base.output)
                );
            });
            await expect(
                base.host(supervised, cutPoints).execute(base.seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });

            const unaffected = new FunctionExecutor(async (turn) => {
                const decision = await turn.step.open();
                observed.push(
                    `${turn.turn.id.value}: ${decision.kind}#${decision.step.ordinal} ` +
                        `annotations=${decision.step.annotations.length}`
                );
                // The refusal aimed at the other Turn's trajectory reaches nothing here.
                const exchange = await turn.model.call({
                    covers: await turn.modelInput.accountable(),
                    sections: [section("body", "the sibling's own step")],
                    catalog: [],
                    admitted: []
                });
                return turn.outcome.succeed(
                    resultCommit(turn, "scoped-sibling", exchange.input, base.output)
                );
            });
            await expect(
                base.host(unaffected, cutPoints).execute(sibling.token)
            ).resolves.toMatchObject({ kind: "succeeded" });

            // The first Turn's ordinal and annotations accumulate across its own steps and
            // stop there; the sibling starts its count and its annotations again.
            expect(observed).toEqual([
                `${ids.turn.value}: proceed#0 annotations=1`,
                `${ids.turn.value}: proceed#1 annotations=2`,
                `${ids.turn.value}: stopped#2 annotations=2`,
                "turn-sibling: proceed#0 annotations=1"
            ]);

            // What the cut point saw at the sibling's first step: ordinal zero, no annotation,
            // and the head the first Turn left behind. The stop is not in the value at all.
            expect(
                cutPoints.seen.filter((entry) => entry.startsWith("turn.step@turn-sibling:"))
            ).toEqual([
                `turn.step@turn-sibling:${JSON.stringify(
                    new TurnStepContext(0, new RunCommitId("scoped-stopped"), 0).toData()
                )}`
            ]);
            // The sibling's model call is the one that landed a request; the stopped Turn's
            // was withdrawn before anything was recorded.
            expect(base.port.bytes).toHaveLength(1);
        }
    );

    it(
        "[C13-RUN-DISTINCTION-REPRESENTABLE] refuses a call whose prompt.assemble rewrite withholds more than the host attributed",
        { tags: "p0" },
        async () => {
            // The rewrite the interceptor answers with withholds five bytes more than the
            // host's own sections did. The host attributed all of its own withholding, and it
            // never saw this rewrite, so the five extra bytes belong to a commit no entry
            // names — the record is refused rather than committed.
            const widened: FacetData = [
                section("kept", "kept body", TurnOmission.exact(5)).toData(),
                section("dropped", "a stub", TurnOmission.exact(10)).toData()
            ];
            const cutPoints = new ScriptedCutPoints({ "prompt.assemble": () => widened });
            const base = await fixture(cutPoints);
            const carried = message(base.seeded, "carried-message", content("a"));
            let refusal: AgentCoreError | undefined;
            const executor = new FunctionExecutor(async (turn) => {
                const covers = await turn.modelInput.accountable();
                expect(covers).toHaveLength(2);
                try {
                    await turn.model.call({
                        covers,
                        sections: [
                            section("kept", "kept body"),
                            section("dropped", "a stub", TurnOmission.exact(10))
                        ],
                        catalog: [],
                        admitted: [],
                        withheld: [new TurnCommitOmission(carried.id, TurnOmission.exact(10))]
                    });
                } catch (error) {
                    if (!(error instanceof AgentCoreError)) throw error;
                    refusal = error;
                }
                return turn.outcome.succeed(
                    resultCommit(turn, "widened-result", carried.id, base.output)
                );
            });
            await expect(
                base.host(executor, cutPoints).execute(base.seeded.token)
            ).resolves.toMatchObject({ kind: "succeeded" });

            expect(refusal?.code).toBe("turn.model-input-unaccounted");
            expect(refusal?.message).toContain("attributes 10 of the 15 bytes");
            // Fail-closed: the model never read the rewritten surface.
            expect(base.port.bytes).toHaveLength(0);
        }
    );
});

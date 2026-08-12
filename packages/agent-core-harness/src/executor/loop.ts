import { RunCommit, TurnExecutor } from "@agent-core/core/agents/runs";
import type {
    TurnBoundOperation,
    TurnContext,
    TurnInboxEntry,
    TurnOutcome
} from "@agent-core/core/agents/runs";
import { RunCommitId } from "@agent-core/core/agents/runs";
import type { ContentRef } from "@agent-core/core/core";
import { OperationRequestKey } from "@agent-core/core/operations";
import type { FacetData } from "@agent-core/core/facets";
import { HarnessError } from "../error.js";
import { AssistantMessageCodec } from "../model/port.js";
import {
    AssistantMessage,
    ToolResultMessage,
    Transcript,
    TranscriptCodec,
    type ToolCall
} from "../transcript.js";

export interface AgentLoopOptions {
    /** Upper bound on model calls in one Turn. Reaching it fails the Turn explicitly. */
    readonly maximumSteps: number;
}

/**
 * The agent loop, hosted behind SPEC §5.6's executor seam.
 *
 * Every model reply becomes a message RunCommit before any tool runs, and every tool
 * call goes through `TurnInvocationHandle`, so nothing this loop does reaches a Facet
 * outside mediation.
 *
 * Request keys are derived from the Turn, the step, and the tool-call id rather than
 * generated, so a re-executed Turn replays a mediated Invocation it already made. That
 * holds only while the model reproduces the same tool-call ids: the seam gives the
 * executor no way to read back the commits it appended earlier in the same Turn, so
 * there is no durable record of prior steps to resume from, and persisting a step
 * boundary means suspending the Turn, which ends this execution.
 */
export class AgentLoopTurnExecutor extends TurnExecutor {
    public constructor(private readonly options: AgentLoopOptions) {
        super();
        if (!Number.isSafeInteger(options.maximumSteps) || options.maximumSteps < 1) {
            throw new TypeError("Agent loop step budget must be a positive safe integer");
        }
    }

    public async execute(turn: TurnContext): Promise<TurnOutcome> {
        let transcript = TranscriptCodec.decode(await turn.content.get(turn.prompt));
        let cursor = 0;
        // The context exposes the branch head only once, so the loop carries it
        // forward: every commit it appends becomes the parent of the next one.
        let head = turn.effectiveCommit.id;
        const append = async (id: string, content: ContentRef): Promise<void> => {
            const commit = messageCommit(turn, id, head, content);
            await turn.commit.append(commit);
            head = commit.id;
        };

        try {
            for (let step = 0; step < this.options.maximumSteps; step += 1) {
                const cancellation = await this.observedCancellation(turn, cursor);
                cursor = cancellation.cursor;
                if (cancellation.entry !== undefined) {
                    return await this.settle(turn, cancellation.entry, transcript, head);
                }

                const promptRef = (await turn.content.put(TranscriptCodec.encode(transcript))).ref;
                const reply = await turn.model.call({ prompt: promptRef });
                const message = AssistantMessageCodec.decode(await turn.content.get(reply.output));
                transcript = transcript.append(message);
                await turn.stream.publish({ kind: "usage", usage: reply.usage });

                if (message.toolCalls.length === 0) {
                    return await turn.outcome.succeed(
                        resultCommit(turn, `${turn.turn.id.value}-result`, head, reply.output)
                    );
                }
                await append(`${turn.turn.id.value}-assistant-${step}`, reply.output);

                const results = await this.runTools(turn, message, step);
                transcript = transcript.append(...results);
                const resultsRef = (
                    await turn.content.put(
                        TranscriptCodec.encode(new Transcript(transcript.instructions, results))
                    )
                ).ref;
                await append(`${turn.turn.id.value}-tools-${step}`, resultsRef);
            }
        } catch (error) {
            if (!turn.cancellation.aborted) throw error;
            const entry = (await turn.inbox.read(0)).find(
                (candidate) => candidate.event === "turn.cancel"
            );
            if (entry === undefined) throw error;
            return this.settle(turn, entry, transcript, head);
        }

        const exhausted = (
            await turn.content.put(
                TranscriptCodec.encode(
                    transcript.append(
                        new AssistantMessage(
                            `Step budget of ${this.options.maximumSteps} model calls was exhausted.`
                        )
                    )
                )
            )
        ).ref;
        return turn.outcome.fail(
            resultCommit(turn, `${turn.turn.id.value}-result`, head, exhausted)
        );
    }

    /**
     * The running -> cancelled transition (§5.3): commit the transcript the loop had
     * reached as the Turn result and name the exact cancellation entry that requested it.
     * A lease already fenced by takeover or timeout rejects this, and the host settles
     * from the cancellation it recovers instead.
     */
    private async settle(
        turn: TurnContext,
        cancellation: TurnInboxEntry,
        transcript: Transcript,
        head: RunCommitId
    ): Promise<TurnOutcome> {
        const partial = (await turn.content.put(TranscriptCodec.encode(transcript))).ref;
        return turn.outcome.cancel(
            resultCommit(turn, `${turn.turn.id.value}-result`, head, partial),
            cancellation
        );
    }

    private async runTools(
        turn: TurnContext,
        message: AssistantMessage,
        step: number
    ): Promise<readonly ToolResultMessage[]> {
        const results: ToolResultMessage[] = [];
        for (const call of message.toolCalls) {
            results.push(await this.runTool(turn, call, step));
        }
        return Object.freeze(results);
    }

    private async runTool(
        turn: TurnContext,
        call: ToolCall,
        step: number
    ): Promise<ToolResultMessage> {
        const operation = boundOperation(turn.operations, call);
        const requestKey = new OperationRequestKey(
            `${turn.turn.id.value}:${step}:${call.id.value}`
        );
        try {
            const result = await turn.invocation.invoke(operation, requestKey, call.input);
            return new ToolResultMessage(call.id, result.output, false);
        } catch (error) {
            if (turn.cancellation.aborted) throw error;
            return new ToolResultMessage(call.id, toolFailure(error), true);
        }
    }

    /**
     * The durable inbox is the queue: each step re-reads it and stops committing as
     * soon as a cancellation for this exact lease is present (§5.6). The loop then
     * performs the running -> cancelled transition itself, committing the transcript it
     * had reached; a lease already fenced by takeover or timeout rejects that commit and
     * the host settles from the cancellation it recovers instead.
     */
    private async observedCancellation(
        turn: TurnContext,
        cursor: number
    ): Promise<{ readonly cursor: number; readonly entry: TurnInboxEntry | undefined }> {
        const entries = await turn.inbox.read(cursor);
        const next = entries.reduce(
            (highest, entry) => Math.max(highest, entry.sequence + 1),
            cursor
        );
        return {
            cursor: next,
            entry: entries.find((entry) => entry.event === "turn.cancel")
        };
    }
}

function boundOperation(
    operations: readonly TurnBoundOperation[],
    call: ToolCall
): TurnBoundOperation {
    const operation = operations.find((candidate) => candidate.binding.equals(call.binding));
    if (operation === undefined) {
        throw new HarnessError(
            "model.unknown-tool",
            `Model requested undeclared tool ${call.binding.value}`
        );
    }
    return operation;
}

function toolFailure(error: unknown): FacetData {
    return { error: error instanceof Error ? error.message : String(error) };
}

function messageCommit(
    turn: TurnContext,
    id: string,
    parent: RunCommitId,
    content: ContentRef
): RunCommit {
    return commit(turn, id, "message", parent, content);
}

function resultCommit(
    turn: TurnContext,
    id: string,
    parent: RunCommitId,
    content: ContentRef
): RunCommit {
    return commit(turn, id, "result", parent, content);
}

function commit(
    turn: TurnContext,
    id: string,
    kind: "message" | "result",
    parent: RunCommitId,
    content: ContentRef
): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: turn.turn.run,
        branch: turn.turn.branch,
        kind,
        parents: [parent],
        pins: turn.turn.pins,
        writer: { kind: "turn", token: turn.token },
        subjectTurn: turn.turn.id,
        content
    });
}

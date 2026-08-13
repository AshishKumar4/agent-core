import { describe, expect, test } from "vitest";
import type { JsonValue } from "@agent-core/core/core";
import {
    TurnExecutorHost,
    TurnStreamPort,
    type TurnStreamPublication
} from "@agent-core/core/agents/runs";
import {
    AttemptReceipt,
    AuditRecord,
    PreparedInvocation,
    Receipt,
    type AuditKind,
    type EffectAttempt
} from "@agent-core/core/invocations";
import {
    leaseReference,
    mediationInvocationCodecs,
    mediationPreparedCodecs,
    type MediationLeaseReference
} from "@agent-core/core/mediation";
import {
    AgentLoopTurnExecutor,
    AssistantMessage,
    ModelProvider,
    PlacementOperationSource,
    ToolCall,
    ToolCallId,
    TranscriptPromptAssembler,
    TranscriptTurnModelPort,
    type ModelCompletion,
    type ModelRequest
} from "../src/index";
import { OperationRequestKey } from "@agent-core/core/operations";
import { boundOperation, ids, seedRunningTurn } from "./fixture";
import {
    demoAdmissionCodec,
    mediationHarness,
    owner,
    tenant,
    type DemoAdmissionReference,
    type MediationState
} from "./mediation";

class ScriptedModelProvider extends ModelProvider {
    public readonly requests: ModelRequest[] = [];

    public constructor(private readonly replies: readonly ModelCompletion[]) {
        super();
    }

    public async complete(request: ModelRequest): Promise<ModelCompletion> {
        this.requests.push(request);
        const reply = this.replies[this.requests.length - 1];
        if (reply === undefined) throw new TypeError("Scripted model ran out of replies");
        return reply;
    }
}

class SilentStreamPort extends TurnStreamPort {
    public async publish(_publication: TurnStreamPublication): Promise<void> {}
}

function reply(text: string, calls: readonly ToolCall[] = []): ModelCompletion {
    return {
        message: new AssistantMessage(text, calls),
        usage: { inputTokens: 9, outputTokens: 5 }
    };
}

const codecs = mediationInvocationCodecs(demoAdmissionCodec);

function decodeAll<Value>(
    map: ReadonlyMap<string, Uint8Array>,
    decode: (bytes: Uint8Array) => Value
): readonly Value[] {
    return [...map.values()].map((bytes) => decode(bytes));
}

describe("audit chain for one real conversation", () => {
    test(
        "links the Run, Turn, and commits to an Invocation, Receipt, and AuditRecord chain",
        { tags: "p0" },
        async () => {
            const fixture = await seedRunningTurn("Where did I park?");
            const recall = boundOperation("recall", "recall");
            const call = new ToolCall(new ToolCallId("call-1"), recall.binding, {
                query: "parking"
            });
            const harness = await mediationHarness(
                fixture.token,
                fixture.content,
                new Map([["parking", "level 3"]])
            );
            const provider = new ScriptedModelProvider([
                reply("Let me check.", [call]),
                reply("You parked on level 3.")
            ]);

            const outcome = await new TurnExecutorHost({
                runtime: fixture.runtime,
                executor: new AgentLoopTurnExecutor({ maximumSteps: 4 }),
                content: fixture.content,
                operations: new PlacementOperationSource([recall]),
                prompt: new TranscriptPromptAssembler("You are a helpful agent.", fixture.content),
                invocations: harness.pipeline.invocations,
                model: new TranscriptTurnModelPort(provider, fixture.content),
                stream: new SilentStreamPort(),
                now: () => new Date(2_000)
            }).execute(fixture.token);

            expect(outcome.kind).toBe("succeeded");

            // --- The Run/Turn half -------------------------------------------------
            const runState = fixture.repository.transaction((transaction) => ({
                run: fixture.repository.loadRun(transaction, ids.run),
                turn: fixture.repository.loadTurn(transaction, ids.turn),
                commits: fixture.repository.listCommits(transaction)
            }));
            expect(runState.run?.id.equals(ids.run)).toBe(true);
            expect(runState.turn?.status.kind).toBe("succeeded");
            const turnCommits = runState.commits
                .filter((commit) => commit.subjectTurn?.equals(ids.turn) === true)
                .map((commit) => `${commit.id.value}:${commit.kind}`)
                .sort();
            expect(turnCommits).toEqual([
                `${ids.turn.value}-assistant-0:message`,
                `${ids.turn.value}-result:result`,
                `${ids.turn.value}-tools-0:message`
            ]);

            // --- The Invocation/Receipt/AuditRecord half ---------------------------
            const state: MediationState = harness.transactions.read();
            const prepared = decodeAll(state.prepared, (bytes) =>
                PreparedInvocation.decode(bytes, mediationPreparedCodecs)
            );
            expect(prepared).toHaveLength(1);
            const invocation = prepared[0]!;
            const invocationId = invocation.header.id;

            // The Invocation is pinned to the exact Turn lease that made the tool call,
            // and to the Operation the placement snapshot admitted.
            expect(invocation.header.lease).toEqual<MediationLeaseReference>(
                leaseReference(fixture.token)
            );
            expect(invocation.header.actor.equals(owner)).toBe(true);
            expect(invocation.header.operation.target).toBe(ids.facet.value);
            expect(invocation.header.operation.operation.value).toBe("memory:recall");
            expect(invocation.header.operation.impact).toBe("observe");
            expect(invocation.header.operation.approvalRequired).toBe(false);
            expect(invocation.itemCount).toBe(1);
            expect(invocation.item(0).arguments).toEqual({ query: "parking" });

            const claims = decodeAll(state.claims, (bytes) => codecs.claim.decode(bytes));
            expect(claims).toHaveLength(1);
            const claim = claims[0]!;
            expect(claim.invocation.equals(invocationId)).toBe(true);
            expect(claim.owner.kind).toBe("executor");

            const attempts = decodeAll(state.attempts, (bytes) => codecs.attempt.decode(bytes));
            expect(attempts).toHaveLength(1);
            const attempt: EffectAttempt<MediationLeaseReference, DemoAdmissionReference> =
                attempts[0]!;
            expect(attempt.invocation.equals(invocationId)).toBe(true);
            expect(attempt.itemIndex).toBe(0);
            expect(attempt.ordinal).toBe(0);
            expect(attempt.idempotencyKey).toBe(invocation.item(0).idempotencyKey);
            expect(attempt.auditCause.equals(invocation.header.auditCause)).toBe(true);

            const receipts = decodeAll(state.receipts, (bytes) => Receipt.decode(bytes));
            expect(receipts).toHaveLength(1);
            const receipt = receipts[0]!;
            if (!(receipt instanceof AttemptReceipt)) {
                throw new TypeError("expected an attempted Receipt");
            }
            expect(receipt.outcome).toBe("succeeded");
            expect(receipt.attempt.equals(attempt.id)).toBe(true);
            expect(receipt.result).toBeDefined();

            // The Receipt's result content is the tool output the model actually saw.
            const stored: JsonValue = JSON.parse(
                new TextDecoder().decode(await fixture.content.get(receipt.result!))
            );
            expect(stored).toEqual({ answer: "level 3", attempt: attempt.id.value });

            // --- The chain ---------------------------------------------------------
            const audits = new Map(
                decodeAll(state.audits, (bytes) => AuditRecord.decode(bytes)).map((record) => [
                    record.id.value,
                    record
                ])
            );
            expect(audits.size).toBe(3);
            const chain = [...audits.values()].map(auditIdentity).sort();
            expect(chain).toEqual(
                [
                    `invocation:${invocationId.value}`,
                    `attempt:${attempt.id.value}`,
                    `receipt:${receipt.id.value}:succeeded`
                ].sort()
            );

            const invocationAudit = audits.get(invocation.header.auditCause.value)!;
            expect(invocationAudit.kind).toEqual({ kind: "invocation", id: invocationId });
            expect(invocationAudit.cause).toBeUndefined();
            expect(invocationAudit.tenant.equals(tenant)).toBe(true);
            expect(invocationAudit.actor.equals(owner)).toBe(true);

            const attemptAudit = [...audits.values()].find(
                (record) => record.kind.kind === "attempt"
            )!;
            expect(attemptAudit.cause?.equals(invocationAudit.id)).toBe(true);
            expect(attemptAudit.correlation.equals(invocationAudit.correlation)).toBe(true);

            const receiptAudit = [...audits.values()].find(
                (record) => record.kind.kind === "receipt"
            )!;
            expect(receiptAudit.cause?.equals(attemptAudit.id)).toBe(true);
            expect(receiptAudit.correlation.equals(invocationAudit.correlation)).toBe(true);

            // Every record in the chain was produced by the pipeline, not the demonstration.
            expect(harness.permits.issued).toBe(1);
            expect(harness.authority.staleObservations).toBe(0);

            // The Receipt observation reaches the Run through the durable outbox.
            await harness.pipeline.outbox.flush();
            expect(
                harness.observations.map((observation) => ({
                    invocation: observation.invocation.value,
                    receipt: observation.receipt.value,
                    audit: observation.audit.value
                }))
            ).toEqual([
                {
                    invocation: invocationId.value,
                    receipt: receipt.id.value,
                    audit: receiptAudit.id.value
                },
                {
                    invocation: invocationId.value,
                    receipt: receipt.id.value,
                    audit: receiptAudit.id.value
                }
            ]);

            await harness.pipeline.dispose();
        }
    );

    test(
        "replays the same Invocation and Receipt when a step is re-executed",
        { tags: "p0" },
        async () => {
            const fixture = await seedRunningTurn("Where did I park?");
            const recall = boundOperation("recall", "recall");
            const call = new ToolCall(new ToolCallId("call-1"), recall.binding, {
                query: "parking"
            });
            const harness = await mediationHarness(
                fixture.token,
                fixture.content,
                new Map([["parking", "level 3"]])
            );
            const request = {
                turn: fixture.repository.transaction((transaction) =>
                    fixture.repository.loadTurn(transaction, ids.turn)
                )!,
                token: fixture.token,
                operation: recall,
                requestKey: new OperationRequestKey(`${ids.turn.value}:0:${call.id.value}`),
                input: { query: "parking" },
                signal: new AbortController().signal
            };

            const first = await harness.pipeline.invocations.invoke(request);
            const second = await harness.pipeline.invocations.invoke(request);
            if (first.tier !== "mediated" || second.tier !== "mediated") {
                throw new TypeError("this demonstration configures only the mediated tier");
            }
            expect(second.output).toEqual(first.output);
            expect(second.evidence).toEqual(first.evidence);

            const state = harness.transactions.read();
            expect(state.prepared.size).toBe(1);
            expect(state.attempts.size).toBe(1);
            expect(state.receipts.size).toBe(1);
            expect(state.audits.size).toBe(3);
            expect(harness.permits.issued).toBe(1);

            await harness.pipeline.dispose();
        }
    );
});

function auditIdentity(record: AuditRecord): string {
    const kind: AuditKind = record.kind;
    switch (kind.kind) {
        case "invocation":
            return `invocation:${kind.id.value}`;
        case "attempt":
            return `attempt:${kind.id.value}`;
        case "receipt":
            return `receipt:${kind.id.value}:${kind.outcome}`;
        default:
            return kind.kind;
    }
}

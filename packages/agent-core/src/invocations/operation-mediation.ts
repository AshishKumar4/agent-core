import { Digest, decodeCanonicalJson, encodeCanonicalJson } from "../core";
import { AgentCoreError } from "../errors";
import type { FacetData, OperationContext } from "../facets";
import type {
    MediatedInvocationPreflight,
    MediatedInvocationPreparation,
    MediatedInvocationRequest,
    MediatedInvocationResult,
    MediatedPreflightResult,
    InterceptorTrace,
    OperationDispatchResult,
    OperationInterceptionEvidence,
    OperationInvocationPort,
    OperationPayloadShape,
    OperationRequestKey
} from "../operations";
import { InvocationId } from "../interaction-references";
import type { CanonicalBatchInvoker } from "./canonical-batch";
import type { InvocationReplayPersistence, InvocationTransactionPort } from "./ports";
import {
    MediatedReplayRecord,
    type InvocationInterceptorTrace,
    type MediatedReplayShape
} from "./replay";

export interface DirectOperationContextPort<Authorization> {
    context(
        requestKey: OperationRequestKey,
        itemIndex: number,
        shape: OperationPayloadShape,
        authorization: Authorization
    ): OperationContext;
}

export interface MediatedInvocationIdentityPort {
    invocation(request: MediatedInvocationPreflight<unknown>): InvocationId;
}

export class ReplayOperationInvocationPort<
    Transaction,
    DirectAuthorization,
    MediatedAuthorization
> implements OperationInvocationPort<DirectAuthorization, MediatedAuthorization> {
    public constructor(
        private readonly scope: string,
        private readonly transactions: InvocationTransactionPort<Transaction>,
        private readonly persistence: InvocationReplayPersistence<Transaction>,
        private readonly identities: MediatedInvocationIdentityPort,
        private readonly direct: DirectOperationContextPort<DirectAuthorization>,
        private readonly mediated: CanonicalBatchInvoker<MediatedAuthorization>
    ) {
        if (scope.trim().length === 0 || scope !== scope.trim()) {
            throw new TypeError("Invocation replay scope must be canonical");
        }
    }

    public directContext(
        requestKey: OperationRequestKey,
        itemIndex: number,
        shape: OperationPayloadShape,
        authorization: DirectAuthorization
    ): OperationContext {
        const context = this.direct.context(requestKey, itemIndex, shape, authorization);
        if (context.attempt !== undefined) {
            throw invalid("Direct Operation context cannot carry an EffectAttempt");
        }
        return context;
    }

    public async prepareMediated(
        request: MediatedInvocationPreflight<MediatedAuthorization>,
        prepare: () => MediatedInvocationPreparation
    ): Promise<MediatedPreflightResult> {
        const reserved = this.transactions.transact<MediatedPreflightResult | undefined>(
            (transaction) => {
                const existing = this.persistence.replay(
                    transaction,
                    this.scope,
                    request.requestKey.value
                );
                const reservation = replayReservation(this.scope, request);
                if (existing !== undefined) {
                    if (!existing.id.equals(MediatedReplayRecord.reserve(reservation).id)) {
                        throw invalid("OperationRequestKey replay changed its bound intent");
                    }
                    if (existing.complete) {
                        return { kind: "replay", result: replayResult(existing) };
                    }
                    if (existing.invocation !== undefined) {
                        return { kind: "new", preparation: preparation(existing) };
                    }
                    return undefined;
                }
                this.persistence.appendReplay(
                    transaction,
                    MediatedReplayRecord.reserve(reservation)
                );
                return undefined;
            }
        );
        if (reserved !== undefined) return reserved;

        const value = prepare();
        requirePreparation(value, request.inputs.length);
        return this.transactions.transact((transaction) => {
            const current = this.persistence.replay(
                transaction,
                this.scope,
                request.requestKey.value
            );
            if (current === undefined) {
                throw invalid("Replay reservation disappeared before preparation");
            }
            if (current.invocation !== undefined) {
                return { kind: "new", preparation: preparation(current) };
            }
            const prepared = current.prepare(
                this.identities.invocation(request),
                value.inputs,
                value.interceptions.map((item) => item.map(toInvocationTrace))
            );
            this.persistence.appendReplay(transaction, prepared);
            return { kind: "new", preparation: value };
        });
    }

    public async invoke(
        request: MediatedInvocationRequest<MediatedAuthorization>
    ): Promise<MediatedInvocationResult> {
        const replay = this.transactions.transact((transaction) =>
            this.persistence.replay(transaction, this.scope, request.requestKey.value)
        );
        if (replay?.invocation === undefined) {
            throw invalid("Mediated invocation has no reserved prepared replay identity");
        }
        if (
            request.replayBinding === undefined ||
            !replayBindingMatches(replay, request.replayBinding)
        ) {
            throw invalid("Mediated invocation changed its authenticated replay binding");
        }
        if (
            replay.items.every(
                (item) => item.effectOutput !== undefined && item.receipt !== undefined
            )
        ) {
            return Object.freeze({
                outputs: Object.freeze(replay.items.map((item) => item.effectOutput!)),
                evidence: replayEvidence(replay)
            });
        }
        if (replay.items.every((item) => item.receipt !== undefined)) {
            throw terminalInvocation();
        }
        const result = await this.mediated.invoke({ invocation: replay.invocation, request });
        if (
            !result.invocation.equals(replay.invocation) ||
            result.items.length !== replay.items.length ||
            result.items.some((item, itemIndex) => item.itemIndex !== itemIndex)
        ) {
            throw invalid("Canonical batch mediation returned substituted item evidence");
        }
        const recorded = this.transactions.transact((transaction) => {
            let current = this.persistence.replayById(transaction, replay.id);
            if (current === undefined) throw invalid("Mediated replay reservation disappeared");
            for (let itemIndex = 0; itemIndex < current.items.length; itemIndex += 1) {
                const item = current.items[itemIndex]!;
                const resultItem = result.items[itemIndex]!;
                if (item.receipt === undefined) {
                    current =
                        resultItem.kind === "succeeded"
                            ? current.recordEffect(
                                  itemIndex,
                                  resultItem.output,
                                  resultItem.receipt.id
                              )
                            : current.recordTerminal(itemIndex, resultItem.receipt.id);
                    this.persistence.appendReplay(transaction, current);
                } else if (
                    !item.receipt.equals(resultItem.receipt.id) ||
                    (resultItem.kind === "succeeded"
                        ? item.effectOutput === undefined ||
                          !sameData(item.effectOutput, resultItem.output)
                        : item.effectOutput !== undefined)
                ) {
                    throw invalid("Canonical batch replay changed a persisted effect output");
                }
            }
            return current;
        });
        if (result.items.some((item) => item.kind !== "succeeded")) {
            throw terminalInvocation();
        }
        return Object.freeze({
            outputs: Object.freeze(recorded.items.map((item) => item.effectOutput!)),
            evidence: replayEvidence(recorded)
        });
    }

    public recordDirectInterceptions(_evidence: OperationInterceptionEvidence): void {}

    public async presentMediated(
        evidence: FacetData,
        outputs: readonly FacetData[],
        present: (
            itemIndex: number,
            output: FacetData
        ) => {
            readonly value: FacetData;
            readonly traces: readonly InterceptorTrace[];
        },
        interceptions: Omit<OperationInterceptionEvidence, "traces">
    ): Promise<readonly FacetData[]> {
        const invocation = evidenceInvocation(evidence);
        return this.transactions.transact((transaction) => {
            let replay = this.persistence.replay(
                transaction,
                this.scope,
                interceptions.requestKey.value
            );
            if (
                replay?.invocation === undefined ||
                !replay.invocation.equals(invocation) ||
                replay.items.length !== outputs.length
            ) {
                throw invalid("Mediated presentation does not bind its replay evidence");
            }
            for (let itemIndex = 0; itemIndex < replay.items.length; itemIndex += 1) {
                const item = replay.items[itemIndex]!;
                if (
                    item.effectOutput === undefined ||
                    !sameData(item.effectOutput, outputs[itemIndex]!)
                ) {
                    throw invalid("Mediated presentation substituted an item output");
                }
                if (item.presentation === undefined) {
                    const presented = present(itemIndex, item.effectOutput);
                    replay = replay.present(
                        itemIndex,
                        presented.traces.map(toInvocationTrace),
                        presented.value
                    );
                    this.persistence.appendReplay(transaction, replay);
                }
            }
            return Object.freeze(replay.items.map((item) => item.presentation!));
        });
    }
}

function replayReservation(
    scope: string,
    request: MediatedInvocationPreflight<unknown>
): Parameters<typeof MediatedReplayRecord.reserve>[0] {
    return {
        scope,
        requestKey: request.requestKey.value,
        facet: request.facet.value,
        operation: request.descriptor.name.value,
        descriptorDigest: Digest.sha256(encodeCanonicalJson(request.descriptor.toData())),
        principal: request.replayBinding.principal,
        authorityIdentity: request.replayBinding.authorityIdentity,
        packageOperationPin: request.replayBinding.packageOperationPin,
        execution: request.replayBinding.execution,
        shape: request.shape as MediatedReplayShape,
        rawPayloadIdentities: request.inputs.map((input) =>
            Digest.sha256(encodeCanonicalJson(canonicalData(input)))
        )
    };
}

function replayBindingMatches(
    record: MediatedReplayRecord,
    binding: MediatedInvocationPreflight<unknown>["replayBinding"]
): boolean {
    return (
        record.principal.equals(binding.principal) &&
        record.authorityIdentity.equals(binding.authorityIdentity) &&
        record.packageOperationPin.equals(binding.packageOperationPin) &&
        record.execution.kind === binding.execution.kind &&
        record.execution.digest.equals(binding.execution.digest)
    );
}

function preparation(record: MediatedReplayRecord): MediatedInvocationPreparation {
    return Object.freeze({
        inputs: Object.freeze(record.items.map((item) => item.preparedArguments!)),
        interceptions: Object.freeze(
            record.items.map((item, itemIndex) =>
                Object.freeze(item.before!.map((trace) => fromInvocationTrace(trace, itemIndex)))
            )
        )
    });
}

function replayResult(record: MediatedReplayRecord): OperationDispatchResult {
    const presentations = record.items.map((item) => item.presentation!);
    return Object.freeze({
        kind: "mediated",
        output: record.shape.kind === "single" ? presentations[0]! : Object.freeze(presentations),
        evidence: replayEvidence(record)
    });
}

function replayEvidence(record: MediatedReplayRecord): FacetData {
    if (record.invocation === undefined) throw invalid("Replay evidence requires an Invocation");
    return canonicalData({
        invocation: record.invocation.value,
        receipts: record.items.map((item) => item.receipt!.value)
    });
}

function evidenceInvocation(evidence: FacetData): InvocationId {
    if (evidence === null || Array.isArray(evidence) || typeof evidence !== "object") {
        throw invalid("Mediated evidence does not identify its Invocation");
    }
    const invocation = (evidence as { readonly [key: string]: FacetData })["invocation"];
    if (typeof invocation !== "string") {
        throw invalid("Mediated evidence does not identify its Invocation");
    }
    return new InvocationId(invocation);
}

function requirePreparation(value: MediatedInvocationPreparation, itemCount: number): void {
    if (value.inputs.length !== itemCount || value.interceptions.length !== itemCount) {
        throw invalid("Mediated before phase changed the item count");
    }
}

function toInvocationTrace(trace: InterceptorTrace): InvocationInterceptorTrace {
    return Object.freeze({
        interceptor: trace.interceptor,
        contributor: trace.contributor,
        cutPoint: trace.cutPoint,
        before: trace.before,
        after: trace.after,
        outcome: trace.outcome
    });
}

function fromInvocationTrace(
    trace: InvocationInterceptorTrace,
    itemIndex: number
): InterceptorTrace {
    return Object.freeze({ ...trace, itemIndex });
}

function sameData(left: FacetData, right: FacetData): boolean {
    return Digest.sha256(encodeCanonicalJson(canonicalData(left))).equals(
        Digest.sha256(encodeCanonicalJson(canonicalData(right)))
    );
}

function canonicalData(value: FacetData): FacetData {
    return decodeCanonicalJson(encodeCanonicalJson(value)) as FacetData;
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}

function terminalInvocation(): AgentCoreError {
    return new AgentCoreError(
        "authority.denied",
        "Mediated Invocation completed without one successful output per item"
    );
}

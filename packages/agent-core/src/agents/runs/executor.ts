import type { ContentPutResult } from "../../content";
import { ContentStore, type ContentStat, type MediaHint } from "../../content";
import { encodeBase64, encodeCanonicalJson, type ContentRef, type JsonValue } from "../../core";
import type { RunCommitId } from "../../execution-references";
import { AgentCoreError } from "../../errors";
import {
    FacetPackageId,
    OperationDescriptor,
    canonicalFacetData,
    type BindingName,
    type FacetData,
    type FacetRef,
    type OperationRef
} from "../../facets";
import { OperationGateway, type OperationRequestKey } from "../../operations";
import { RunCommit } from "./commit";
import { leaseTokensEqual, type LeaseToken } from "./lease";
import type { TurnPlacementSnapshot } from "./placement";
import { bytesEqual } from "../record-data";
import type { RunBranch } from "./run";
import { RunRuntime } from "./runtime";
import { RunCheckpoint, Turn, TurnInboxEntry } from "./turn";

export class TurnBoundOperation {
    public constructor(
        public readonly binding: BindingName,
        public readonly facet: FacetRef,
        public readonly operation: OperationRef,
        public readonly descriptor: OperationDescriptor
    ) {
        const separator = facet.value.indexOf(":");
        const facetPackage = new FacetPackageId(facet.value.slice(0, separator));
        if (!operation.facet.equals(facetPackage) || !operation.operation.equals(descriptor.name)) {
            throw new TypeError(
                "A bound Operation Facet, reference, and descriptor must identify one operation"
            );
        }
        Object.freeze(this);
    }
}

export interface TurnExecutionScope {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly effectiveCommit: RunCommit;
    readonly placement: TurnPlacementSnapshot;
    readonly resumeCheckpoint: RunCheckpoint | undefined;
}

export abstract class TurnOperationSource {
    public abstract resolve(scope: TurnExecutionScope): Promise<readonly TurnBoundOperation[]>;
}

export interface TurnPromptAssembly extends TurnExecutionScope {
    readonly operations: readonly TurnBoundOperation[];
}

export abstract class TurnPromptAssembler {
    public abstract assemble(request: TurnPromptAssembly): Promise<ContentRef>;
}

export interface TurnInvocationRequest {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly operation: TurnBoundOperation;
    readonly requestKey: OperationRequestKey;
    readonly input: FacetData;
    readonly signal: AbortSignal;
}

/**
 * Which enforcement tier served the call (§7.2). Only `mediated` carries evidence: a
 * direct call performs its authority, lease, watermark, PathEpochEvidence, and deadline
 * checks in memory and writes nothing durable, so there is no Invocation for it to name.
 * The tier is on the result rather than the request because policy, not the executor,
 * decides it — the agent loop that §1.1 motivates the direct tier for makes an ordinary
 * `observe` call and is served by whichever tier the resolved authority admits.
 */
export type TurnInvocationResult =
    | { readonly tier: "direct"; readonly output: FacetData }
    | { readonly tier: "mediated"; readonly output: FacetData; readonly evidence: FacetData };

export abstract class TurnInvocationPort {
    public abstract invoke(request: TurnInvocationRequest): Promise<TurnInvocationResult>;
}

export interface TurnGatewayScope {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly signal: AbortSignal;
}

export abstract class TurnGatewaySource {
    public abstract open(scope: TurnGatewayScope): Promise<OperationGateway>;
}

export class GatewayTurnInvocationPort extends TurnInvocationPort {
    public constructor(private readonly gateways: TurnGatewaySource) {
        super();
    }

    public async invoke(request: TurnInvocationRequest): Promise<TurnInvocationResult> {
        requireNotCancelled(request.signal);
        const gateway = await this.gateways.open(
            Object.freeze({
                turn: request.turn,
                token: request.token,
                signal: request.signal
            })
        );
        requireNotCancelled(request.signal);
        const resolved = await gateway.resolve(request.operation.binding);
        try {
            const descriptor = resolved.descriptor(request.operation.descriptor.name);
            if (
                !resolved.facet.equals(request.operation.facet) ||
                !resolved.package.equals(request.operation.operation.facet) ||
                descriptor === undefined ||
                !bytesEqual(
                    OperationDescriptor.encode(descriptor),
                    OperationDescriptor.encode(request.operation.descriptor)
                )
            ) {
                throw new AgentCoreError(
                    "binding.invalid",
                    "Resolved operation does not match the exact bound Turn Operation"
                );
            }
            requireNotCancelled(request.signal);
            const result = await resolved.dispatch({
                requestKey: request.requestKey,
                operation: descriptor.name,
                payload: { kind: "single", input: canonicalFacetData(request.input) }
            });
            requireNotCancelled(request.signal);
            return canonicalInvocationResult(
                result.kind === "mediated"
                    ? { tier: "mediated", output: result.output, evidence: result.evidence }
                    : { tier: "direct", output: result.output }
            );
        } finally {
            resolved[Symbol.dispose]();
        }
    }
}

export interface TurnModelUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}

export interface TurnModelRequest {
    readonly prompt: ContentRef;
}

export interface TurnModelCall extends TurnModelRequest {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly operations: readonly TurnBoundOperation[];
    readonly signal: AbortSignal;
}

export interface TurnModelResult {
    readonly output: ContentRef;
    readonly usage: TurnModelUsage;
}

export abstract class TurnModelPort {
    public abstract call(request: TurnModelCall): Promise<TurnModelResult>;
}

export type TurnStreamEvent =
    | { readonly kind: "content"; readonly bytes: Uint8Array }
    | { readonly kind: "usage"; readonly usage: TurnModelUsage };

export interface TurnStreamPublication {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly event: TurnStreamEvent;
}

export abstract class TurnStreamPort {
    public abstract publish(publication: TurnStreamPublication): Promise<void>;
}

export type TurnOutcome =
    | {
          readonly kind: "succeeded";
          readonly result: ContentRef;
          readonly commit: RunCommitId;
      }
    | { readonly kind: "failed"; readonly result: ContentRef; readonly commit: RunCommitId }
    | {
          readonly kind: "suspended";
          readonly checkpoint: RunCheckpoint;
          readonly commit: RunCommitId;
      }
    | {
          readonly kind: "cancelled";
          readonly result?: ContentRef;
          readonly commit?: RunCommitId;
      };

export abstract class TurnContentHandle {
    public abstract put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult>;
    public abstract get(ref: ContentRef): Promise<Uint8Array>;
    public abstract stat(ref: ContentRef): Promise<ContentStat | undefined>;
}

export abstract class TurnModelHandle {
    public abstract call(request: TurnModelRequest): Promise<TurnModelResult>;
}

export abstract class TurnStreamHandle {
    public abstract publish(event: TurnStreamEvent): Promise<void>;
}

export abstract class TurnCommitHandle {
    public abstract append(commit: RunCommit): Promise<RunCommitId>;
}

export abstract class TurnCheckpointHandle {
    public abstract current(): Promise<RunCheckpoint | undefined>;
    public abstract persist(checkpoint: RunCheckpoint, commit: RunCommit): Promise<TurnOutcome>;
}

export abstract class TurnInvocationHandle {
    public abstract invoke(
        operation: TurnBoundOperation,
        requestKey: OperationRequestKey,
        input: FacetData
    ): Promise<TurnInvocationResult>;
}

export abstract class TurnInboxHandle {
    public abstract read(afterSequence: number): Promise<readonly TurnInboxEntry[]>;
}

export abstract class TurnOutcomeHandle {
    public abstract succeed(commit: RunCommit): Promise<TurnOutcome>;
    public abstract fail(commit: RunCommit): Promise<TurnOutcome>;
    public abstract cancel(commit: RunCommit, cancellation: TurnInboxEntry): Promise<TurnOutcome>;
    public abstract cancelled(): Promise<TurnOutcome>;
}

export interface TurnContext extends TurnExecutionScope {
    readonly operations: readonly TurnBoundOperation[];
    readonly prompt: ContentRef;
    readonly content: TurnContentHandle;
    readonly inbox: TurnInboxHandle;
    readonly commit: TurnCommitHandle;
    readonly checkpoint: TurnCheckpointHandle;
    readonly invocation: TurnInvocationHandle;
    readonly model: TurnModelHandle;
    readonly stream: TurnStreamHandle;
    readonly outcome: TurnOutcomeHandle;
    readonly cancellation: AbortSignal;
}

export abstract class TurnExecutor {
    public abstract execute(turn: TurnContext): Promise<TurnOutcome>;
}

export interface TurnExecutorHostInit<Transaction> {
    readonly runtime: RunRuntime<Transaction>;
    readonly executor: TurnExecutor;
    readonly content: ContentStore;
    readonly operations: TurnOperationSource;
    readonly prompt: TurnPromptAssembler;
    readonly invocations: TurnInvocationPort;
    readonly model: TurnModelPort;
    readonly stream: TurnStreamPort;
    readonly now: () => Date;
}

export class TurnExecutorHost<Transaction> {
    public constructor(private readonly init: TurnExecutorHostInit<Transaction>) {}

    public async execute(token: LeaseToken): Promise<TurnOutcome> {
        const scope = new LeaseScopedTurn(this.init, token);
        const recovered = scope.recover();
        if (recovered !== undefined) return recovered;
        const initial = scope.active();
        const operations = await scope.resolveOperations(initial);
        const prompt = await scope.assemblePrompt({ ...initial.scope, operations });
        const context = Object.freeze<TurnContext>({
            ...initial.scope,
            operations,
            prompt,
            content: new ScopedContentHandle(scope),
            inbox: new ScopedInboxHandle(scope),
            commit: new ScopedCommitHandle(scope),
            checkpoint: new ScopedCheckpointHandle(scope),
            invocation: new ScopedInvocationHandle(scope, operations),
            model: new ScopedModelHandle(scope, operations),
            stream: new ScopedStreamHandle(scope),
            outcome: new ScopedOutcomeHandle(scope),
            cancellation: scope.signal
        });
        let proposed: TurnOutcome;
        try {
            proposed = await this.init.executor.execute(context);
        } catch (error) {
            const committed = scope.recover();
            if (committed !== undefined) return committed;
            throw error;
        }
        const committed = scope.recover();
        if (committed === undefined || !outcomesEqual(proposed, committed)) {
            throw invalidTurn("Turn executor returned without its exact canonical transition");
        }
        return committed;
    }
}

interface ActiveTurnSnapshot {
    readonly scope: TurnExecutionScope;
    readonly branch: RunBranch;
    readonly head: RunCommit;
    readonly now: Date;
}

class LeaseScopedTurn<Transaction> {
    readonly #controller = new AbortController();
    public readonly signal = this.#controller.signal;

    public constructor(
        public readonly init: TurnExecutorHostInit<Transaction>,
        public readonly token: LeaseToken
    ) {}

    public active(): ActiveTurnSnapshot {
        const now = this.init.now();
        return this.init.runtime.repository.transaction((transaction) => {
            const repository = this.init.runtime.repository;
            const turn = required(
                repository.loadTurn(transaction, this.token.turn),
                "Turn executor target does not exist"
            );
            if (findCancellation(repository.listInbox(transaction, turn.id), this.token)) {
                this.#controller.abort();
            }
            const joined = repository.loadExecutionScope(transaction, this.token, now);
            return Object.freeze({
                scope: Object.freeze({
                    turn: joined.turn,
                    token: this.token,
                    effectiveCommit: joined.effectiveCommit,
                    placement: joined.placement,
                    resumeCheckpoint: joined.checkpoint
                }),
                branch: joined.branch,
                head: joined.head,
                now
            });
        });
    }

    public async resolveOperations(
        snapshot: ActiveTurnSnapshot
    ): Promise<readonly TurnBoundOperation[]> {
        const resolved = await this.init.operations.resolve(snapshot.scope);
        this.active();
        return validateOperations(snapshot.scope.placement, resolved);
    }

    public async assemblePrompt(request: TurnPromptAssembly): Promise<ContentRef> {
        const prompt = await this.init.prompt.assemble(Object.freeze(request));
        this.active();
        await this.requireContent(prompt);
        return prompt;
    }

    public async requireContent(ref: ContentRef): Promise<void> {
        const stat = await this.withActive(() => this.init.content.stat(ref));
        if (stat === undefined || !stat.ref.equals(ref) || !stat.digest.equals(ref.digest)) {
            throw new AgentCoreError("content.not-found", "Turn content is not available");
        }
    }

    public async withActive<Result>(operation: () => Promise<Result>): Promise<Result> {
        this.active();
        try {
            return await operation();
        } finally {
            this.active();
        }
    }

    public recover(): TurnOutcome | undefined {
        return this.init.runtime.repository.transaction((transaction) => {
            const repository = this.init.runtime.repository;
            const turn = repository.loadTurn(transaction, this.token.turn);
            if (turn === undefined) return undefined;
            const resultCommits = repository
                .listCommits(transaction)
                .filter(
                    (commit) =>
                        commit.isTurnAuthored("result", this.token) &&
                        commit.content !== undefined &&
                        turn.result?.equals(commit.content) === true
                );
            if (resultCommits.length > 1) {
                throw invalidTurn("Turn executor has multiple terminal commits for one token");
            }
            const resultCommit = resultCommits[0];
            if (turn.status.kind === "succeeded" || turn.status.kind === "failed") {
                if (resultCommit === undefined) return undefined;
                return Object.freeze({
                    kind: turn.status.kind,
                    result: required(turn.result, "Terminal Turn is missing its result"),
                    commit: resultCommit.id
                });
            }
            if (turn.status.kind === "suspended") {
                const checkpoint = required(
                    repository.loadCheckpoint(
                        transaction,
                        required(turn.checkpoint, "Suspended Turn is missing its checkpoint")
                    ),
                    "Suspended Turn checkpoint does not exist"
                );
                const commit = required(
                    repository.loadCommit(transaction, checkpoint.commit),
                    "Suspended Turn checkpoint commit does not exist"
                );
                if (
                    !commit.isTurnAuthored("checkpoint", this.token) ||
                    !commit.content?.equals(checkpoint.state)
                ) {
                    return undefined;
                }
                return Object.freeze({ kind: "suspended", checkpoint, commit: commit.id });
            }
            if (findCancellation(repository.listInbox(transaction, turn.id), this.token)) {
                this.#controller.abort();
                // A cancellation delivered against a lease this token still holds is a
                // request the holder must settle itself (§5.6); only a displaced or
                // fenced lease makes the cancellation the Turn's recorded outcome.
                if (holdsCurrentLease(turn, this.token)) return undefined;
                return Object.freeze({
                    kind: "cancelled",
                    ...(resultCommit?.content === undefined
                        ? {}
                        : { result: resultCommit.content }),
                    ...(resultCommit === undefined ? {} : { commit: resultCommit.id })
                });
            }
            return undefined;
        });
    }

    public readInbox(afterSequence: number): readonly TurnInboxEntry[] {
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
            throw new TypeError("Turn inbox cursor must be a non-negative safe integer");
        }
        return this.init.runtime.repository.transaction((transaction) => {
            const repository = this.init.runtime.repository;
            const turn = required(
                repository.loadTurn(transaction, this.token.turn),
                "Turn executor target does not exist"
            );
            const entries = repository
                .listInbox(transaction, turn.id)
                .filter((entry) => entry.sequence >= afterSequence);
            const cancellation = findCancellation(entries, this.token);
            if (cancellation !== undefined) {
                this.#controller.abort();
                return Object.freeze(entries);
            }
            turn.requireToken(this.token, this.init.now());
            return Object.freeze(entries);
        });
    }
}

class ScopedContentHandle<Transaction> extends TurnContentHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult> {
        const stored = await this.scope.withActive(() =>
            this.scope.init.content.put(bytes.slice(), hint)
        );
        if (!stored.ref.digest.equals(stored.digest)) {
            throw new AgentCoreError("codec.invalid", "Content store returned mismatched identity");
        }
        return Object.freeze({ ref: stored.ref, digest: stored.digest });
    }

    public async get(ref: ContentRef): Promise<Uint8Array> {
        const bytes = await this.scope.withActive(() => this.scope.init.content.get(ref));
        return bytes.slice();
    }

    public async stat(ref: ContentRef): Promise<ContentStat | undefined> {
        return this.scope.withActive(() => this.scope.init.content.stat(ref));
    }
}

class ScopedModelHandle<Transaction> extends TurnModelHandle {
    public constructor(
        private readonly scope: LeaseScopedTurn<Transaction>,
        private readonly operations: readonly TurnBoundOperation[]
    ) {
        super();
    }

    public async call(request: TurnModelRequest): Promise<TurnModelResult> {
        await this.scope.requireContent(request.prompt);
        const snapshot = this.scope.active();
        const result = await this.scope.withActive(() =>
            this.scope.init.model.call(
                Object.freeze({
                    turn: snapshot.scope.turn,
                    token: this.scope.token,
                    prompt: request.prompt,
                    operations: this.operations,
                    signal: this.scope.signal
                })
            )
        );
        requireUsage(result.usage);
        await this.scope.requireContent(result.output);
        // SPEC §5.2: the Run's token total advances where the model call commits.
        this.scope.init.runtime.recordModelTokens(
            snapshot.scope.turn.run,
            totalTokens(result.usage)
        );
        return Object.freeze({ output: result.output, usage: freezeUsage(result.usage) });
    }
}

class ScopedStreamHandle<Transaction> extends TurnStreamHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async publish(event: TurnStreamEvent): Promise<void> {
        const canonical = canonicalStreamEvent(event);
        const turn = this.scope.active().scope.turn;
        await this.scope.withActive(() =>
            this.scope.init.stream.publish(
                Object.freeze({ turn, token: this.scope.token, event: canonical })
            )
        );
    }
}

class ScopedInvocationHandle<Transaction> extends TurnInvocationHandle {
    public constructor(
        private readonly scope: LeaseScopedTurn<Transaction>,
        private readonly operations: readonly TurnBoundOperation[]
    ) {
        super();
    }

    public async invoke(
        requested: TurnBoundOperation,
        requestKey: OperationRequestKey,
        input: FacetData
    ): Promise<TurnInvocationResult> {
        if (!this.operations.includes(requested)) {
            throw new AgentCoreError(
                "operation.missing",
                "Turn invocation requires one exact bound Operation"
            );
        }
        const turn = this.scope.active().scope.turn;
        const result = await this.scope.withActive(() =>
            this.scope.init.invocations.invoke(
                Object.freeze({
                    turn,
                    token: this.scope.token,
                    operation: requested,
                    requestKey,
                    input: canonicalFacetData(input),
                    signal: this.scope.signal
                })
            )
        );
        return canonicalInvocationResult(result);
    }
}

class ScopedCommitHandle<Transaction> extends TurnCommitHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async append(commit: RunCommit): Promise<RunCommitId> {
        if (commit.kind !== "message" && commit.kind !== "verdict") {
            throw invalidTurn("Turn commit handle appends only message or verdict commits");
        }
        await this.scope.requireContent(required(commit.content, "Turn commit requires content"));
        const snapshot = this.scope.active();
        this.scope.init.runtime.appendTurnCommit(commit, snapshot.branch.revision, snapshot.now);
        this.scope.active();
        return commit.id;
    }
}

class ScopedCheckpointHandle<Transaction> extends TurnCheckpointHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async current(): Promise<RunCheckpoint | undefined> {
        return this.scope.active().scope.resumeCheckpoint;
    }

    public async persist(checkpoint: RunCheckpoint, commit: RunCommit): Promise<TurnOutcome> {
        await this.scope.requireContent(checkpoint.state);
        if (checkpoint.tree !== undefined) await this.scope.requireContent(checkpoint.tree);
        const snapshot = this.scope.active();
        this.scope.init.runtime.suspendTurn({
            turn: snapshot.scope.turn.id,
            expectedTurnRevision: snapshot.scope.turn.revision,
            expectedBranchRevision: snapshot.branch.revision,
            token: this.scope.token,
            checkpoint,
            commit,
            now: snapshot.now
        });
        return canonicalOutcome(this.scope);
    }
}

class ScopedInboxHandle<Transaction> extends TurnInboxHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async read(afterSequence: number): Promise<readonly TurnInboxEntry[]> {
        return this.scope.readInbox(afterSequence);
    }
}

class ScopedOutcomeHandle<Transaction> extends TurnOutcomeHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async succeed(commit: RunCommit): Promise<TurnOutcome> {
        return this.complete("succeeded", commit);
    }

    public async fail(commit: RunCommit): Promise<TurnOutcome> {
        return this.complete("failed", commit);
    }

    public async cancel(commit: RunCommit, cancellation: TurnInboxEntry): Promise<TurnOutcome> {
        await this.scope.requireContent(required(commit.content, "Turn result requires content"));
        await this.scope.requireContent(cancellation.payload);
        const snapshot = this.scope.active();
        this.scope.init.runtime.cancelHeldTurn(
            {
                turn: snapshot.scope.turn.id,
                expectedTurnRevision: snapshot.scope.turn.revision,
                expectedBranchRevision: snapshot.branch.revision,
                token: this.scope.token,
                outcome: "cancelled",
                commit,
                now: snapshot.now
            },
            cancellation
        );
        return canonicalOutcome(this.scope);
    }

    public async cancelled(): Promise<TurnOutcome> {
        const outcome = this.scope.recover();
        if (outcome?.kind !== "cancelled") {
            throw invalidTurn("Turn token has no settled cancellation outcome");
        }
        return outcome;
    }

    private async complete(
        outcome: "succeeded" | "failed",
        commit: RunCommit
    ): Promise<TurnOutcome> {
        await this.scope.requireContent(required(commit.content, "Turn result requires content"));
        const snapshot = this.scope.active();
        this.scope.init.runtime.completeTurn({
            turn: snapshot.scope.turn.id,
            expectedTurnRevision: snapshot.scope.turn.revision,
            expectedBranchRevision: snapshot.branch.revision,
            token: this.scope.token,
            outcome,
            commit,
            now: snapshot.now
        });
        return canonicalOutcome(this.scope);
    }
}

function validateOperations(
    placement: TurnPlacementSnapshot,
    operations: readonly TurnBoundOperation[]
): readonly TurnBoundOperation[] {
    const bindings = new Set<string>();
    const canonical = operations.map((operation) => {
        if (!(operation instanceof TurnBoundOperation)) {
            throw new TypeError("Turn Operations must use the canonical bound Operation contract");
        }
        if (bindings.has(operation.binding.value)) {
            throw new TypeError("Turn Operation bindings must be unique");
        }
        if (!placement.placements.some((pin) => pin.facet.equals(operation.facet))) {
            throw invalidTurn("Turn Operation is absent from the immutable placement snapshot");
        }
        bindings.add(operation.binding.value);
        return operation;
    });
    return Object.freeze(canonical);
}

function canonicalInvocationResult(result: TurnInvocationResult): TurnInvocationResult {
    return result.tier === "mediated"
        ? Object.freeze({
              tier: "mediated",
              output: canonicalFacetData(result.output),
              evidence: canonicalFacetData(result.evidence)
          })
        : Object.freeze({ tier: "direct", output: canonicalFacetData(result.output) });
}

function canonicalStreamEvent(event: TurnStreamEvent): TurnStreamEvent {
    if (event.kind === "content") {
        return Object.freeze({ kind: "content", bytes: event.bytes.slice() });
    }
    requireUsage(event.usage);
    return Object.freeze({ kind: "usage", usage: freezeUsage(event.usage) });
}

function requireUsage(usage: TurnModelUsage): void {
    for (const value of [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens
    ]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
            throw new TypeError("Turn model usage values must be non-negative safe integers");
        }
    }
}

function totalTokens(usage: TurnModelUsage): number {
    return (
        usage.inputTokens +
        usage.outputTokens +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0)
    );
}

function freezeUsage(usage: TurnModelUsage): TurnModelUsage {
    return Object.freeze({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: usage.cacheWriteTokens })
    });
}

function findCancellation(
    entries: readonly TurnInboxEntry[],
    token: LeaseToken
): TurnInboxEntry | undefined {
    // Carrying a cancellation token and being a turn.cancel entry are the same fact:
    // TurnInboxEntry's constructor rejects either without the other, and its codec
    // decodes through that constructor, so a matched entry cannot have another event.
    // Only duplication is left to reject.
    const matches = entries.filter(
        (entry) =>
            entry.cancellationToken !== undefined &&
            leaseTokensEqual(entry.cancellationToken, token)
    );
    if (matches.length > 1) {
        throw invalidTurn("Turn executor cancellation evidence is not canonical");
    }
    return matches[0];
}

function holdsCurrentLease(turn: Turn, token: LeaseToken): boolean {
    return (
        turn.status.kind === "running" &&
        turn.lease.holder !== undefined &&
        leaseTokensEqual(
            { turn: turn.id, holder: turn.lease.holder, epoch: turn.lease.epoch },
            token
        )
    );
}

function outcomesEqual(left: TurnOutcome, right: TurnOutcome): boolean {
    return bytesEqual(
        encodeCanonicalJson(outcomeIdentity(left)),
        encodeCanonicalJson(outcomeIdentity(right))
    );
}

function outcomeIdentity(outcome: TurnOutcome): JsonValue {
    switch (outcome.kind) {
        case "suspended":
            return [
                outcome.kind,
                encodeBase64(RunCheckpoint.codec.encode(outcome.checkpoint)),
                outcome.commit.value
            ];
        case "cancelled":
            return [outcome.kind, outcome.result?.value ?? null, outcome.commit?.value ?? null];
        default:
            return [outcome.kind, outcome.result.value, outcome.commit.value];
    }
}

function required<Value>(value: Value | undefined, message: string): Value {
    if (value === undefined) throw invalidTurn(message);
    return value;
}

function canonicalOutcome<Transaction>(scope: LeaseScopedTurn<Transaction>): TurnOutcome {
    return required(scope.recover(), "Turn transition was not durably recorded");
}

function invalidTurn(message: string): AgentCoreError {
    return new AgentCoreError("turn.invalid-state", message);
}

function requireNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new AgentCoreError("lease.invalid", "Turn execution is cancelled");
    }
}

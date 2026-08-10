import type { ContentPutResult } from "../../content";
import { ContentStore, type ContentStat, type MediaHint } from "../../content";
import type { ContentRef } from "../../core";
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
import type { LeaseToken } from "./lease";
import type { TurnPlacementSnapshot } from "./placement";
import type { RunBranch } from "./run";
import { RunRuntime } from "./runtime";
import { RunCheckpoint, Turn, TurnInboxEntry } from "./turn";

export class TurnBoundTool {
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
                "Bound tool Facet, Operation reference, and descriptor must identify one operation"
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

export abstract class TurnToolSource {
    public abstract resolve(scope: TurnExecutionScope): Promise<readonly TurnBoundTool[]>;
}

export interface TurnPromptAssembly extends TurnExecutionScope {
    readonly tools: readonly TurnBoundTool[];
}

export abstract class TurnPromptAssembler {
    public abstract assemble(request: TurnPromptAssembly): Promise<ContentRef>;
}

export interface TurnMediatedInvocationRequest {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly tool: TurnBoundTool;
    readonly requestKey: OperationRequestKey;
    readonly input: FacetData;
    readonly signal: AbortSignal;
}

export interface TurnMediatedInvocationResult {
    readonly output: FacetData;
    readonly evidence: FacetData;
}

export abstract class TurnMediatedInvocationPort {
    public abstract invoke(
        request: TurnMediatedInvocationRequest
    ): Promise<TurnMediatedInvocationResult>;
}

export interface TurnOperationGatewayScope {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly signal: AbortSignal;
}

export abstract class TurnOperationGatewayFactory {
    public abstract open(scope: TurnOperationGatewayScope): Promise<OperationGateway>;
}

export class OperationGatewayTurnInvocationPort extends TurnMediatedInvocationPort {
    public constructor(private readonly gateways: TurnOperationGatewayFactory) {
        super();
    }

    public async invoke(
        request: TurnMediatedInvocationRequest
    ): Promise<TurnMediatedInvocationResult> {
        requireNotCancelled(request.signal);
        const gateway = await this.gateways.open(
            Object.freeze({
                turn: request.turn,
                token: request.token,
                signal: request.signal
            })
        );
        requireNotCancelled(request.signal);
        const resolved = await gateway.resolve(request.tool.binding);
        try {
            const descriptor = resolved.descriptor(request.tool.descriptor.name);
            if (
                !resolved.facet.equals(request.tool.facet) ||
                !resolved.package.equals(request.tool.operation.facet) ||
                descriptor === undefined ||
                !bytesEqual(
                    OperationDescriptor.encode(descriptor),
                    OperationDescriptor.encode(request.tool.descriptor)
                )
            ) {
                throw new AgentCoreError(
                    "binding.invalid",
                    "Resolved operation does not match the exact bound Turn tool"
                );
            }
            requireNotCancelled(request.signal);
            const result = await resolved.dispatch({
                requestKey: request.requestKey,
                operation: descriptor.name,
                payload: { kind: "single", input: canonicalFacetData(request.input) }
            });
            requireNotCancelled(request.signal);
            if (result.kind !== "mediated") {
                throw new AgentCoreError(
                    "authority.denied",
                    "Turn tools require the mediated invocation path"
                );
            }
            return Object.freeze({
                output: canonicalFacetData(result.output),
                evidence: canonicalFacetData(result.evidence)
            });
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
    readonly tools: readonly TurnBoundTool[];
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
        tool: TurnBoundTool,
        requestKey: OperationRequestKey,
        input: FacetData
    ): Promise<TurnMediatedInvocationResult>;
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
    readonly tools: readonly TurnBoundTool[];
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
    readonly tools: TurnToolSource;
    readonly prompt: TurnPromptAssembler;
    readonly invocations: TurnMediatedInvocationPort;
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
        const tools = await scope.resolveTools(initial);
        const prompt = await scope.assemblePrompt({ ...initial.scope, tools });
        const context = Object.freeze<TurnContext>({
            ...initial.scope,
            tools,
            prompt,
            content: new ScopedContentHandle(scope),
            inbox: new ScopedInboxHandle(scope),
            commit: new ScopedCommitHandle(scope),
            checkpoint: new ScopedCheckpointHandle(scope),
            invocation: new ScopedInvocationHandle(scope, tools),
            model: new ScopedModelHandle(scope, tools),
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

    public constructor(
        public readonly init: TurnExecutorHostInit<Transaction>,
        public readonly token: LeaseToken
    ) {}

    public get signal(): AbortSignal {
        return this.#controller.signal;
    }

    public active(): ActiveTurnSnapshot {
        this.refreshCancellation();
        const now = this.init.now();
        return this.init.runtime.repository.transaction((transaction) => {
            const repository = this.init.runtime.repository;
            const turn = required(
                repository.loadTurn(transaction, this.token.turn),
                "Turn executor target does not exist"
            );
            turn.requireToken(this.token, now);
            const run = required(
                repository.loadRun(transaction, turn.run),
                "Turn executor Run does not exist"
            );
            const branch = required(
                repository.loadBranch(transaction, turn.branch),
                "Turn executor branch does not exist"
            );
            const head = required(
                repository.loadCommit(transaction, branch.head),
                "Turn executor branch head does not exist"
            );
            const effectiveCommit = required(
                repository.loadCommit(transaction, turn.effectiveInput),
                "Turn executor effective input does not exist"
            );
            const placement = required(
                repository.loadPlacement(transaction, turn.id),
                "Turn executor placement does not exist"
            );
            const checkpoint =
                turn.checkpoint === undefined
                    ? undefined
                    : required(
                          repository.loadCheckpoint(transaction, turn.checkpoint),
                          "Turn executor checkpoint does not exist"
                      );
            if (
                run.lifecycle.kind !== "active" ||
                !branch.run.equals(run.id) ||
                !head.run.equals(run.id) ||
                !head.pins.equals(turn.pins) ||
                !effectiveCommit.run.equals(run.id) ||
                !placement.turn.equals(turn.id) ||
                !placement.digest.equals(turn.placement) ||
                !placement.pins.equals(turn.pins) ||
                (checkpoint !== undefined && !checkpoint.turn.equals(turn.id)) ||
                !repository.isAncestor(transaction, turn.startHead, branch.head) ||
                !repository.isAncestor(transaction, turn.effectiveInput, turn.startHead)
            ) {
                throw invalidTurn("Turn executor scope does not match canonical Run state");
            }
            return Object.freeze({
                scope: Object.freeze({
                    turn,
                    token: this.token,
                    effectiveCommit,
                    placement,
                    resumeCheckpoint: checkpoint
                }),
                branch,
                head,
                now
            });
        });
    }

    public async resolveTools(snapshot: ActiveTurnSnapshot): Promise<readonly TurnBoundTool[]> {
        const resolved = await this.init.tools.resolve(snapshot.scope);
        this.active();
        return validateTools(snapshot.scope.placement, resolved);
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
            const result = await operation();
            this.active();
            return result;
        } catch (error) {
            this.refreshCancellation();
            throw error;
        }
    }

    public recover(): TurnOutcome | undefined {
        return this.init.runtime.repository.transaction((transaction) => {
            const repository = this.init.runtime.repository;
            const turn = repository.loadTurn(transaction, this.token.turn);
            if (turn === undefined) return undefined;
            const commits = repository.listCommits(transaction);
            const resultCommits = commits.filter(
                (commit) =>
                    commit.kind === "result" &&
                    commit.subjectTurn?.equals(turn.id) === true &&
                    commit.writer.kind === "turn" &&
                    tokensEqual(commit.writer.token, this.token) &&
                    commit.content !== undefined &&
                    turn.result?.equals(commit.content) === true
            );
            if (resultCommits.length > 1) {
                throw invalidTurn("Turn executor has multiple terminal commits for one token");
            }
            const resultCommit = resultCommits[0];
            if (turn.status.kind === "succeeded" || turn.status.kind === "failed") {
                if (resultCommit === undefined) return undefined;
                if (turn.result === undefined) {
                    throw invalidTurn("Terminal Turn is missing its exact result commit");
                }
                return Object.freeze({
                    kind: turn.status.kind,
                    result: turn.result,
                    commit: resultCommit.id
                });
            }
            if (turn.status.kind === "suspended" && turn.checkpoint !== undefined) {
                const checkpoint = required(
                    repository.loadCheckpoint(transaction, turn.checkpoint),
                    "Suspended Turn checkpoint does not exist"
                );
                const commit = required(
                    repository.loadCommit(transaction, checkpoint.commit),
                    "Suspended Turn checkpoint commit does not exist"
                );
                if (
                    commit.kind !== "checkpoint" ||
                    commit.writer.kind !== "turn" ||
                    !tokensEqual(commit.writer.token, this.token) ||
                    !commit.subjectTurn?.equals(turn.id) ||
                    !commit.content?.equals(checkpoint.state)
                ) {
                    return undefined;
                }
                return Object.freeze({ kind: "suspended", checkpoint, commit: commit.id });
            }
            const cancellations = repository
                .listInbox(transaction, turn.id)
                .filter(
                    (entry) =>
                        entry.event === "turn.cancel" &&
                        entry.cancellationToken !== undefined &&
                        tokensEqual(entry.cancellationToken, this.token)
                );
            if (cancellations.length > 1) {
                throw invalidTurn("Turn executor has multiple cancellations for one token");
            }
            if (cancellations.length === 1) {
                this.abort();
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
            const cancellation = entries.find(
                (entry) =>
                    entry.event === "turn.cancel" &&
                    entry.cancellationToken !== undefined &&
                    tokensEqual(entry.cancellationToken, this.token)
            );
            if (cancellation !== undefined) {
                this.abort();
                return Object.freeze(entries);
            }
            turn.requireToken(this.token, this.init.now());
            return Object.freeze(entries);
        });
    }

    public refreshCancellation(): void {
        if (this.signal.aborted) return;
        const cancellation = this.init.runtime.repository.transaction((transaction) =>
            this.init.runtime.repository
                .listInbox(transaction, this.token.turn)
                .some(
                    (entry) =>
                        entry.event === "turn.cancel" &&
                        entry.cancellationToken !== undefined &&
                        tokensEqual(entry.cancellationToken, this.token)
                )
        );
        if (cancellation) this.abort();
    }

    public abort(): void {
        if (!this.signal.aborted) this.#controller.abort();
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
        private readonly tools: readonly TurnBoundTool[]
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
                    tools: this.tools,
                    signal: this.scope.signal
                })
            )
        );
        requireUsage(result.usage);
        await this.scope.requireContent(result.output);
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
        private readonly tools: readonly TurnBoundTool[]
    ) {
        super();
    }

    public async invoke(
        requested: TurnBoundTool,
        requestKey: OperationRequestKey,
        input: FacetData
    ): Promise<TurnMediatedInvocationResult> {
        const tool = this.tools.find((candidate) => toolsEqual(candidate, requested));
        if (tool === undefined) {
            throw new AgentCoreError(
                "operation.missing",
                "Turn invocation requires one exact bound tool"
            );
        }
        const turn = this.scope.active().scope.turn;
        const result = await this.scope.withActive(() =>
            this.scope.init.invocations.invoke(
                Object.freeze({
                    turn,
                    token: this.scope.token,
                    tool,
                    requestKey,
                    input: canonicalFacetData(input),
                    signal: this.scope.signal
                })
            )
        );
        return Object.freeze({
            output: canonicalFacetData(result.output),
            evidence: canonicalFacetData(result.evidence)
        });
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
        requireExactCommit(snapshot, this.scope.token, commit);
        this.scope.init.runtime.appendCommit(commit, snapshot.branch.revision, snapshot.now);
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
        requireExactCommit(snapshot, this.scope.token, commit);
        this.scope.init.runtime.suspendTurn({
            turn: snapshot.scope.turn.id,
            expectedTurnRevision: snapshot.scope.turn.revision,
            expectedBranchRevision: snapshot.branch.revision,
            token: this.scope.token,
            checkpoint,
            commit,
            now: snapshot.now
        });
        return requiredOutcome(this.scope.recover(), "Turn suspension was not durably recorded");
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
        requireExactCommit(snapshot, this.scope.token, commit);
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
        return requiredOutcome(this.scope.recover(), "Turn cancellation was not durably recorded");
    }

    public async cancelled(): Promise<TurnOutcome> {
        this.scope.refreshCancellation();
        const outcome = this.scope.recover();
        if (outcome?.kind !== "cancelled") {
            throw invalidTurn("Turn token has no canonical cancellation evidence");
        }
        return outcome;
    }

    private async complete(
        outcome: "succeeded" | "failed",
        commit: RunCommit
    ): Promise<TurnOutcome> {
        await this.scope.requireContent(required(commit.content, "Turn result requires content"));
        const snapshot = this.scope.active();
        requireExactCommit(snapshot, this.scope.token, commit);
        this.scope.init.runtime.completeTurn({
            turn: snapshot.scope.turn.id,
            expectedTurnRevision: snapshot.scope.turn.revision,
            expectedBranchRevision: snapshot.branch.revision,
            token: this.scope.token,
            outcome,
            commit,
            now: snapshot.now
        });
        return requiredOutcome(this.scope.recover(), "Turn completion was not durably recorded");
    }
}

function validateTools(
    placement: TurnPlacementSnapshot,
    tools: readonly TurnBoundTool[]
): readonly TurnBoundTool[] {
    const bindings = new Set<string>();
    const canonical = tools.map((tool) => {
        if (!(tool instanceof TurnBoundTool)) {
            throw new TypeError("Turn tools must use the canonical bound tool contract");
        }
        if (bindings.has(tool.binding.value)) {
            throw new TypeError("Turn tool bindings must be unique");
        }
        if (!placement.placements.some((pin) => pin.facet.equals(tool.facet))) {
            throw invalidTurn("Turn tool is absent from the immutable placement snapshot");
        }
        bindings.add(tool.binding.value);
        return tool;
    });
    return Object.freeze(canonical);
}

function requireExactCommit(
    snapshot: ActiveTurnSnapshot,
    token: LeaseToken,
    commit: RunCommit
): void {
    if (
        !commit.run.equals(snapshot.scope.turn.run) ||
        !commit.branch.equals(snapshot.scope.turn.branch) ||
        commit.parents.length !== 1 ||
        !commit.parents[0]?.equals(snapshot.head.id) ||
        !commit.pins.equals(snapshot.scope.turn.pins) ||
        commit.writer.kind !== "turn" ||
        !tokensEqual(commit.writer.token, token) ||
        !commit.subjectTurn?.equals(snapshot.scope.turn.id)
    ) {
        throw invalidTurn("Turn commit does not match the exact token and current branch head");
    }
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

function toolsEqual(left: TurnBoundTool, right: TurnBoundTool): boolean {
    return (
        left.binding.equals(right.binding) &&
        left.facet.equals(right.facet) &&
        left.operation.equals(right.operation) &&
        bytesEqual(
            OperationDescriptor.encode(left.descriptor),
            OperationDescriptor.encode(right.descriptor)
        )
    );
}

function outcomesEqual(left: TurnOutcome, right: TurnOutcome): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "suspended" && right.kind === "suspended") {
        return left.checkpoint.id.equals(right.checkpoint.id) && left.commit.equals(right.commit);
    }
    if (left.kind === "cancelled" && right.kind === "cancelled") {
        return optionalContentEqual(left.result, right.result) && optionalCommitEqual(left, right);
    }
    if (
        (left.kind === "succeeded" || left.kind === "failed") &&
        (right.kind === "succeeded" || right.kind === "failed")
    ) {
        return left.result.equals(right.result) && left.commit.equals(right.commit);
    }
    return false;
}

function optionalCommitEqual(
    left: Extract<TurnOutcome, { readonly kind: "cancelled" }>,
    right: Extract<TurnOutcome, { readonly kind: "cancelled" }>
): boolean {
    return left.commit === undefined
        ? right.commit === undefined
        : right.commit !== undefined && left.commit.equals(right.commit);
}

function optionalContentEqual(
    left: ContentRef | undefined,
    right: ContentRef | undefined
): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function tokensEqual(left: LeaseToken, right: LeaseToken): boolean {
    return (
        left.turn.equals(right.turn) &&
        left.holder.equals(right.holder) &&
        left.epoch === right.epoch
    );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function required<Value>(value: Value | undefined, message: string): Value {
    if (value === undefined) throw invalidTurn(message);
    return value;
}

function requiredOutcome(value: TurnOutcome | undefined, message: string): TurnOutcome {
    if (value === undefined) throw invalidTurn(message);
    return value;
}

function invalidTurn(message: string): AgentCoreError {
    return new AgentCoreError("turn.invalid-state", message);
}

function requireNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new AgentCoreError("lease.invalid", "Turn execution is cancelled");
    }
}

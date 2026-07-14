import { ContentRef, Digest, RecordCodec, Revision, type JsonValue } from "../../core";
import { PrincipalId } from "../../identity";
import { RunCommitId, TurnId } from "../../execution-references";
import { AgentCoreError } from "../../errors";
import {
    CodecRecord,
    digestFromData,
    requireExactFields,
    requireInteger,
    requireObject,
    requireOptionalString,
    requireString,
    requireTimestamp,
    revisionData,
    revisionFromData
} from "../record-data";
import { RunBranchId, RunCheckpointId, RunId, TurnInboxEntryId } from "./id";
import { TurnLease, type LeaseToken } from "./lease";
import { requireTerminalOutcome, type TerminalOutcome } from "./outcome";
import { RunPins } from "./pins";

export type TurnTerminalStatus = TerminalOutcome;

export interface TurnCacheLineage {
    readonly turn: TurnId;
    readonly promptPrefix: Digest;
}

export abstract class TurnStatus {
    public static get queued(): TurnStatus {
        return queuedTurn;
    }
    public static get running(): TurnStatus {
        return runningTurn;
    }
    public static get suspended(): TurnStatus {
        return suspendedTurn;
    }
    public static get succeeded(): TurnStatus {
        return succeededTurn;
    }
    public static get failed(): TurnStatus {
        return failedTurn;
    }
    public static get cancelled(): TurnStatus {
        return cancelledTurn;
    }
    public abstract readonly kind: "queued" | "running" | "suspended" | TurnTerminalStatus;
    public claim(): TurnStatus {
        throw invalidTurn(`Cannot claim a ${this.kind} Turn`);
    }
    public suspend(): TurnStatus {
        throw invalidTurn(`Cannot suspend a ${this.kind} Turn`);
    }
    public complete(_outcome: TurnTerminalStatus): TurnStatus {
        throw invalidTurn(`Cannot complete a ${this.kind} Turn`);
    }
    public cancelUnheld(): TurnStatus {
        throw invalidTurn(`Cannot cancel a ${this.kind} Turn without a token`);
    }

    public static from(kind: TurnStatus["kind"]): TurnStatus {
        switch (kind) {
            case "queued":
                return TurnStatus.queued;
            case "running":
                return TurnStatus.running;
            case "suspended":
                return TurnStatus.suspended;
            case "succeeded":
                return TurnStatus.succeeded;
            case "failed":
                return TurnStatus.failed;
            case "cancelled":
                return TurnStatus.cancelled;
        }
    }
}

class QueuedTurn extends TurnStatus {
    public readonly kind = "queued" as const;
    public override claim(): TurnStatus {
        return TurnStatus.running;
    }
    public override cancelUnheld(): TurnStatus {
        return TurnStatus.cancelled;
    }
}

class RunningTurn extends TurnStatus {
    public readonly kind = "running" as const;
    public override suspend(): TurnStatus {
        return TurnStatus.suspended;
    }
    public override complete(outcome: TurnTerminalStatus): TurnStatus {
        return TurnStatus.from(outcome);
    }
}

class SuspendedTurn extends TurnStatus {
    public readonly kind = "suspended" as const;
    public override claim(): TurnStatus {
        return TurnStatus.running;
    }
    public override cancelUnheld(): TurnStatus {
        return TurnStatus.cancelled;
    }
}

class TerminalTurn extends TurnStatus {
    public constructor(public readonly kind: TurnTerminalStatus) {
        super();
    }
}

export interface TurnInit {
    readonly id: TurnId;
    readonly run: RunId;
    readonly branch: RunBranchId;
    readonly startHead: RunCommitId;
    readonly effectiveInput: RunCommitId;
    readonly pins: RunPins;
    readonly placement: Digest;
    readonly input: ContentRef;
    readonly status?: TurnStatus;
    readonly lease?: TurnLease;
    readonly checkpoint?: RunCheckpointId;
    readonly result?: ContentRef;
    readonly cacheLineage?: TurnCacheLineage;
    readonly revision: Revision;
}

export class Turn extends CodecRecord {
    public static get codec(): RecordCodec<Turn> {
        return TurnCodec;
    }
    public readonly id: TurnId;
    public readonly run: RunId;
    public readonly branch: RunBranchId;
    public readonly startHead: RunCommitId;
    public readonly effectiveInput: RunCommitId;
    public readonly pins: RunPins;
    public readonly placement: Digest;
    public readonly input: ContentRef;
    public readonly status: TurnStatus;
    public readonly lease: TurnLease;
    public readonly checkpoint: RunCheckpointId | undefined;
    public readonly result: ContentRef | undefined;
    public readonly cacheLineage: TurnCacheLineage | undefined;
    public readonly revision: Revision;

    public constructor(init: TurnInit) {
        super();
        this.id = init.id;
        this.run = init.run;
        this.branch = init.branch;
        this.startHead = init.startHead;
        this.effectiveInput = init.effectiveInput;
        this.pins = RunPins.fromData(init.pins.toData());
        this.placement = init.placement;
        this.input = init.input;
        this.status = init.status ?? TurnStatus.queued;
        this.lease = init.lease ?? TurnLease.unclaimed(init.id);
        this.checkpoint = init.checkpoint;
        this.result = init.result;
        this.cacheLineage =
            init.cacheLineage === undefined
                ? undefined
                : Object.freeze({
                      turn: init.cacheLineage.turn,
                      promptPrefix: init.cacheLineage.promptPrefix
                  });
        this.revision = init.revision;
        if (!this.lease.turn.equals(this.id))
            throw new TypeError("Turn lease belongs to another Turn");
        if (
            this.status.kind === "queued" &&
            (this.lease.holder !== undefined ||
                this.lease.epoch !== 0 ||
                this.lease.expiresAt !== undefined)
        ) {
            throw new TypeError("Queued Turns require an unheld epoch-zero lease");
        }
        if (this.status.kind === "running" && this.lease.holder === undefined) {
            throw new TypeError("Running Turns require a held lease");
        }
        if (
            (this.status.kind === "suspended" || isTerminal(this.status)) &&
            this.lease.holder !== undefined
        ) {
            throw new TypeError("Suspended and terminal Turns must be unheld");
        }
        if (this.status.kind === "suspended" && this.checkpoint === undefined) {
            throw new TypeError("Suspended Turns require a checkpoint");
        }
        if (
            (this.status.kind === "succeeded" || this.status.kind === "failed") &&
            this.result === undefined
        ) {
            throw new TypeError("Succeeded and failed Turns require a result");
        }
        Object.freeze(this);
    }

    public claim(holder: PrincipalId, now: Date, expiresAt: Date): Turn {
        return this.transition({
            status: this.status.claim(),
            lease: this.lease.claim(holder, now, expiresAt)
        });
    }

    public renew(token: LeaseToken, now: Date, expiresAt: Date): Turn {
        if (this.status.kind !== "running") throw invalidTurn("Only running Turns can renew");
        this.requireToken(token, now);
        return this.transition({
            lease: this.lease.renew(token.holder, token.epoch, now, expiresAt)
        });
    }

    public reclaim(holder: PrincipalId, now: Date, expiresAt: Date): Turn {
        if (this.status.kind !== "running")
            throw invalidTurn("Only running Turns can be reclaimed");
        return this.transition({ lease: this.lease.reclaim(holder, now, expiresAt) });
    }

    public suspend(token: LeaseToken, checkpoint: RunCheckpointId, now: Date): Turn {
        this.requireToken(token, now);
        return this.transition({
            status: this.status.suspend(),
            lease: this.lease.fence(),
            checkpoint
        });
    }

    public complete(
        token: LeaseToken,
        outcome: TurnTerminalStatus,
        result: ContentRef,
        now: Date
    ): Turn {
        this.requireToken(token, now);
        return this.transition({
            status: this.status.complete(outcome),
            lease: this.lease.fence(),
            result
        });
    }

    public cancelUnheld(): Turn {
        return this.transition({ status: this.status.cancelUnheld(), lease: this.lease.fence() });
    }

    public forceCancel(): Turn {
        if (isTerminal(this.status) && this.lease.holder === undefined) return this;
        return this.transition({ status: TurnStatus.cancelled, lease: this.lease.fence() });
    }

    public revise(): Turn {
        return this.transition({});
    }

    public requireToken(token: LeaseToken, now: Date): void {
        if (this.status.kind !== "running" || !this.lease.admits(token, now)) {
            throw new AgentCoreError(
                "lease.invalid",
                "Turn mutation requires the exact current lease token"
            );
        }
    }

    public toData(): JsonValue {
        return {
            branch: this.branch.value,
            cacheLineage:
                this.cacheLineage === undefined
                    ? null
                    : {
                          promptPrefix: this.cacheLineage.promptPrefix.value,
                          turn: this.cacheLineage.turn.value
                      },
            checkpoint: this.checkpoint?.value ?? null,
            effectiveInput: this.effectiveInput.value,
            id: this.id.value,
            input: this.input.value,
            lease: TurnLease.toData(this.lease),
            pins: this.pins.toData(),
            placement: this.placement.value,
            result: this.result?.value ?? null,
            revision: revisionData(this.revision),
            run: this.run.value,
            startHead: this.startHead.value,
            status: this.status.kind
        };
    }

    public static fromData(value: JsonValue): Turn {
        const object = requireObject(value, "Turn");
        requireExactFields(
            object,
            [
                "branch",
                "cacheLineage",
                "checkpoint",
                "effectiveInput",
                "id",
                "input",
                "lease",
                "pins",
                "placement",
                "result",
                "revision",
                "run",
                "startHead",
                "status"
            ],
            [],
            "Turn"
        );
        const checkpoint = requireOptionalString(object["checkpoint"], "Turn checkpoint");
        const result = requireOptionalString(object["result"], "Turn result");
        const cacheLineage =
            object["cacheLineage"] === null
                ? undefined
                : cacheLineageFromData(object["cacheLineage"]!);
        return new Turn({
            id: new TurnId(requireString(object["id"], "Turn ID")),
            run: new RunId(requireString(object["run"], "Turn Run")),
            branch: new RunBranchId(requireString(object["branch"], "Turn branch")),
            startHead: new RunCommitId(requireString(object["startHead"], "Turn start head")),
            effectiveInput: new RunCommitId(
                requireString(object["effectiveInput"], "Turn effective input")
            ),
            pins: RunPins.fromData(object["pins"]!),
            placement: digestFromData(object["placement"], "Turn placement"),
            input: new ContentRef(requireString(object["input"], "Turn input")),
            status: requireTurnStatus(object["status"]),
            lease: TurnLease.fromData(object["lease"]!),
            ...(checkpoint === undefined ? {} : { checkpoint: new RunCheckpointId(checkpoint) }),
            ...(result === undefined ? {} : { result: new ContentRef(result) }),
            ...(cacheLineage === undefined ? {} : { cacheLineage }),
            revision: revisionFromData(object["revision"], "Turn revision")
        });
    }

    private transition(
        changes: Partial<Pick<TurnInit, "status" | "lease" | "checkpoint" | "result">>
    ): Turn {
        const status = changes.status ?? this.status;
        const lease = changes.lease ?? this.lease;
        const checkpoint = changes.checkpoint ?? this.checkpoint;
        const result = changes.result ?? this.result;
        return new Turn({
            id: this.id,
            run: this.run,
            branch: this.branch,
            startHead: this.startHead,
            effectiveInput: this.effectiveInput,
            pins: this.pins,
            placement: this.placement,
            input: this.input,
            status,
            lease,
            ...(checkpoint === undefined ? {} : { checkpoint }),
            ...(result === undefined ? {} : { result }),
            ...(this.cacheLineage === undefined ? {} : { cacheLineage: this.cacheLineage }),
            revision: nextTurnRevision(this.revision)
        });
    }
}

class TurnRecordCodec extends RecordCodec<Turn> {
    public constructor() {
        super("turn.record", { major: 1, minor: 0 });
    }
    protected encodePayload(value: Turn): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): Turn {
        return Turn.fromData(value);
    }
}

export const TurnCodec: RecordCodec<Turn> = new TurnRecordCodec();

export class RunCheckpoint extends CodecRecord {
    public static get codec(): RecordCodec<RunCheckpoint> {
        return RunCheckpointCodec;
    }
    public constructor(
        public readonly id: RunCheckpointId,
        public readonly turn: TurnId,
        public readonly commit: RunCommitId,
        public readonly state: ContentRef,
        public readonly inboxCursor: number,
        public readonly tree: ContentRef | undefined
    ) {
        super();
        if (!Number.isSafeInteger(inboxCursor) || inboxCursor < 0) {
            throw new TypeError("Checkpoint inbox cursor must be non-negative");
        }
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            commit: this.commit.value,
            id: this.id.value,
            inboxCursor: this.inboxCursor,
            state: this.state.value,
            tree: this.tree?.value ?? null,
            turn: this.turn.value
        };
    }

    public static fromData(value: JsonValue): RunCheckpoint {
        const object = requireObject(value, "Run checkpoint");
        requireExactFields(
            object,
            ["commit", "id", "inboxCursor", "state", "tree", "turn"],
            [],
            "Run checkpoint"
        );
        const tree = requireOptionalString(object["tree"], "Checkpoint tree");
        return new RunCheckpoint(
            new RunCheckpointId(requireString(object["id"], "Checkpoint ID")),
            new TurnId(requireString(object["turn"], "Checkpoint Turn")),
            new RunCommitId(requireString(object["commit"], "Checkpoint commit")),
            new ContentRef(requireString(object["state"], "Checkpoint state")),
            requireInteger(object["inboxCursor"], "Checkpoint inbox cursor"),
            tree === undefined ? undefined : new ContentRef(tree)
        );
    }
}

class CheckpointCodec extends RecordCodec<RunCheckpoint> {
    public constructor() {
        super("run.checkpoint", { major: 1, minor: 0 });
    }
    protected encodePayload(value: RunCheckpoint): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): RunCheckpoint {
        return RunCheckpoint.fromData(value);
    }
}

export const RunCheckpointCodec: RecordCodec<RunCheckpoint> = new CheckpointCodec();

export class TurnInboxEntry extends CodecRecord {
    public static get codec(): RecordCodec<TurnInboxEntry> {
        return TurnInboxEntryCodec;
    }
    readonly #recordedAt: number;

    public constructor(
        public readonly id: TurnInboxEntryId,
        public readonly turn: TurnId,
        public readonly sequence: number,
        public readonly event: string,
        public readonly payload: ContentRef,
        public readonly payloadDigest: Digest,
        public readonly idempotencyKey: string,
        cancellationToken: LeaseToken | undefined,
        recordedAt: Date
    ) {
        super();
        if (!Number.isSafeInteger(sequence) || sequence < 0)
            throw new TypeError("Inbox sequence is invalid");
        if (event.length === 0 || idempotencyKey.length === 0)
            throw new TypeError("Inbox event and key are required");
        if ((event === "turn.cancel") !== (cancellationToken !== undefined)) {
            throw new TypeError("Only turn.cancel entries carry an exact cancellation token");
        }
        if (
            cancellationToken !== undefined &&
            (!cancellationToken.turn.equals(turn) ||
                !Number.isSafeInteger(cancellationToken.epoch) ||
                cancellationToken.epoch < 0)
        ) {
            throw new TypeError(
                "Inbox cancellation token must name the exact Turn and valid epoch"
            );
        }
        if (!payload.digest.equals(payloadDigest)) {
            throw new TypeError("Inbox payload digest must match its ContentRef");
        }
        this.cancellationToken =
            cancellationToken === undefined
                ? undefined
                : Object.freeze({
                      turn: cancellationToken.turn,
                      holder: cancellationToken.holder,
                      epoch: cancellationToken.epoch
                  });
        this.#recordedAt = recordedAt.getTime();
        if (!Number.isFinite(this.#recordedAt)) throw new TypeError("Inbox timestamp is invalid");
        Object.freeze(this);
    }

    public readonly cancellationToken: LeaseToken | undefined;

    public get recordedAt(): Date {
        return new Date(this.#recordedAt);
    }

    public toData(): JsonValue {
        return {
            cancellationToken:
                this.cancellationToken === undefined ? null : tokenData(this.cancellationToken),
            event: this.event,
            id: this.id.value,
            idempotencyKey: this.idempotencyKey,
            payload: this.payload.value,
            payloadDigest: this.payloadDigest.value,
            recordedAt: this.#recordedAt,
            sequence: this.sequence,
            turn: this.turn.value
        };
    }

    public static fromData(value: JsonValue): TurnInboxEntry {
        const object = requireObject(value, "Turn inbox entry");
        requireExactFields(
            object,
            [
                "cancellationToken",
                "event",
                "id",
                "idempotencyKey",
                "payload",
                "payloadDigest",
                "recordedAt",
                "sequence",
                "turn"
            ],
            [],
            "Turn inbox entry"
        );
        return new TurnInboxEntry(
            new TurnInboxEntryId(requireString(object["id"], "Inbox entry ID")),
            new TurnId(requireString(object["turn"], "Inbox Turn")),
            requireInteger(object["sequence"], "Inbox sequence"),
            requireString(object["event"], "Inbox event"),
            new ContentRef(requireString(object["payload"], "Inbox payload")),
            digestFromData(object["payloadDigest"], "Inbox payload digest"),
            requireString(object["idempotencyKey"], "Inbox idempotency key"),
            object["cancellationToken"] === null
                ? undefined
                : tokenFromData(object["cancellationToken"]!),
            requireTimestamp(object["recordedAt"], "Inbox timestamp")
        );
    }
}

class InboxCodec extends RecordCodec<TurnInboxEntry> {
    public constructor() {
        super("turn.inbox-entry", { major: 1, minor: 0 });
    }
    protected encodePayload(value: TurnInboxEntry): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): TurnInboxEntry {
        return TurnInboxEntry.fromData(value);
    }
}

export const TurnInboxEntryCodec: RecordCodec<TurnInboxEntry> = new InboxCodec();

function cacheLineageFromData(value: JsonValue): TurnCacheLineage {
    const object = requireObject(value, "Turn cache lineage");
    requireExactFields(object, ["promptPrefix", "turn"], [], "Turn cache lineage");
    return Object.freeze({
        turn: new TurnId(requireString(object["turn"], "Cache lineage Turn")),
        promptPrefix: digestFromData(object["promptPrefix"], "Cache lineage prompt prefix")
    });
}

function tokenData(token: LeaseToken): JsonValue {
    return { epoch: token.epoch, holder: token.holder.value, turn: token.turn.value };
}

function tokenFromData(value: JsonValue): LeaseToken {
    const object = requireObject(value, "Cancellation token");
    requireExactFields(object, ["epoch", "holder", "turn"], [], "Cancellation token");
    return Object.freeze({
        turn: new TurnId(requireString(object["turn"], "Cancellation Turn")),
        holder: new PrincipalId(requireString(object["holder"], "Cancellation holder")),
        epoch: requireInteger(object["epoch"], "Cancellation epoch")
    });
}

function requireTurnStatus(value: JsonValue | undefined): TurnStatus {
    if (value === "queued" || value === "running" || value === "suspended") {
        return TurnStatus.from(value);
    }
    return TurnStatus.from(requireTerminalOutcome(value, "Turn status"));
}

function isTerminal(status: TurnStatus): boolean {
    return status.kind === "succeeded" || status.kind === "failed" || status.kind === "cancelled";
}

function invalidTurn(message: string): AgentCoreError {
    return new AgentCoreError("turn.invalid-state", message);
}

function nextTurnRevision(revision: Revision): Revision {
    if (revision.value === Number.MAX_SAFE_INTEGER) {
        throw invalidTurn("Turn revision is exhausted");
    }
    return revision.next();
}

const queuedTurn = Object.freeze(new QueuedTurn());
const runningTurn = Object.freeze(new RunningTurn());
const suspendedTurn = Object.freeze(new SuspendedTurn());
const succeededTurn = Object.freeze(new TerminalTurn("succeeded"));
const failedTurn = Object.freeze(new TerminalTurn("failed"));
const cancelledTurn = Object.freeze(new TerminalTurn("cancelled"));

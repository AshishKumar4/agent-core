import {
    ContentRef,
    type ContentRetentionField,
    contentRetentionFields,
    Digest,
    type JsonValue,
    RecordCodec,
    Revision,
    SemVer,
    TextId
} from "../../core";
import { PackageId, PackagePin } from "../../definition";
import { EnvironmentId } from "../../environments";
import { PrincipalId, PrincipalRef, TenantId } from "../../identity";
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
import { AgentId, AgentPolicyId, ModelPolicyId } from "../id";
import { RunBranchId, RunCheckpointId, RunId, TurnInboxEntryId } from "./id";
import {
    ExactTurnLease,
    TurnLease,
    leaseTokenFromData,
    leaseTokenToData,
    type LeaseToken
} from "./lease";
import { requireTerminalOutcome } from "./outcome";
import { BlueprintPin, RunPins } from "./pins";
import {
    TurnStatus,
    ofTerminalOutcome,
    type Option,
    type TerminalOutcome
} from "./generated/turn-status/AgentCore/Extract/TurnStatus";

/**
 * The Turn status vocabulary and every transition it admits are lowered by the TSLean
 * compiler from `formal/AgentCore/Extract/TurnStatus.lean`, the module the Lean kernel
 * checks: the abstract base, the singleton per case, and the four moves. A move the table
 * refuses answers `none`, and `admittedStatus` turns that into this context's stable
 * `turn.invalid-state` refusal — the code and the message are runtime taxonomy, so they
 * stay here, while which moves exist is decided once, in Lean.
 */
export { TurnStatus };
export type TurnTerminalStatus = TerminalOutcome;

export interface TurnCacheLineage {
    readonly turn: TurnId;
    readonly promptPrefix: Digest;
}

function admittedStatus(next: Option<TurnStatus>, refusal: string): TurnStatus {
    if (next.kind === "some") return next.value;
    throw invalidTurn(refusal);
}

// Completion is two lowered facts: whether this status may complete at all, and which
// status an outcome lands on. Composing them here keeps the refusal's code and message in
// the host, where the taxonomy lives.
function completedStatus(status: TurnStatus, outcome: TerminalOutcome): TurnStatus {
    if (!status.completes()) throw invalidTurn(`Cannot complete a ${status.kind} Turn`);
    return ofTerminalOutcome(outcome);
}

// The lowering emits one singleton per case but does not freeze them, and a record this
// context hands out is frozen. Freezing here — where the lowered vocabulary enters the
// domain, not inside the generated tree a regeneration would overwrite — is what keeps
// `Object.isFrozen` true for every status a caller can reach.
for (const status of [
    TurnStatus.queued,
    TurnStatus.running,
    TurnStatus.suspended,
    TurnStatus.succeeded,
    TurnStatus.failed,
    TurnStatus.cancelled
]) {
    Object.freeze(status);
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
    readonly checkpoint?: RunCheckpointId | undefined;
    readonly result?: ContentRef | undefined;
    readonly cacheLineage?: TurnCacheLineage | undefined;
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
            (this.status.kind === "suspended" || this.status.terminal()) &&
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

    public claim(holder: PrincipalRef, now: Date, expiresAt: Date): Turn {
        return this.transition({
            status: admittedStatus(this.status.claim(), `Cannot claim a ${this.status.kind} Turn`),
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

    public reclaim(holder: PrincipalRef, now: Date, expiresAt: Date): Turn {
        if (this.status.kind !== "running")
            throw invalidTurn("Only running Turns can be reclaimed");
        return this.transition({ lease: this.lease.reclaim(holder, now, expiresAt) });
    }

    public suspend(token: LeaseToken, checkpoint: RunCheckpointId, now: Date): Turn {
        this.requireToken(token, now);
        return this.transition({
            status: admittedStatus(
                this.status.suspend(),
                `Cannot suspend a ${this.status.kind} Turn`
            ),
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
            status: completedStatus(this.status, outcome),
            lease: this.lease.fence(),
            result
        });
    }

    public cancelUnheld(): Turn {
        return this.transition({
            status: admittedStatus(
                this.status.cancelUnheld(),
                `Cannot cancel a ${this.status.kind} Turn without a token`
            ),
            lease: this.lease.fence()
        });
    }

    public forceCancel(): Turn {
        if (this.status.terminal() && this.lease.holder === undefined) return this;
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
                : cacheLineageFromData(object["cacheLineage"]);
        return new Turn({
            id: new TurnId(requireString(object["id"], "Turn ID")),
            run: new RunId(requireString(object["run"], "Turn Run")),
            branch: new RunBranchId(requireString(object["branch"], "Turn branch")),
            startHead: new RunCommitId(requireString(object["startHead"], "Turn start head")),
            effectiveInput: new RunCommitId(
                requireString(object["effectiveInput"], "Turn effective input")
            ),
            pins: RunPins.fromData(object["pins"]),
            placement: digestFromData(object["placement"], "Turn placement"),
            input: new ContentRef(requireString(object["input"], "Turn input")),
            status: requireTurnStatus(object["status"]),
            lease: TurnLease.fromData(object["lease"]),
            checkpoint: checkpoint === undefined ? undefined : new RunCheckpointId(checkpoint),
            result: result === undefined ? undefined : new ContentRef(result),
            cacheLineage,
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
            checkpoint,
            result,
            cacheLineage: this.cacheLineage,
            revision: nextTurnRevision(this.revision)
        });
    }
}

export function turnContentRetention(value: Turn): readonly ContentRetentionField[] {
    return contentRetentionFields([
        ["input", value.input],
        ["result", value.result]
    ]);
}

class TurnRecordCodec extends RecordCodec<Turn> {
    public constructor() {
        super(
            [
                Turn,
                Revision,
                TextId,
                TurnStatus,
                SemVer,
                TurnLease,
                RunPins,
                PackagePin,
                BlueprintPin,
                ContentRef,
                Digest,
                RunId,
                RunCommitId,
                TenantId,
                TurnId,
                RunBranchId,
                PrincipalId,
                AgentId,
                CodecRecord,
                RunCheckpointId,
                ModelPolicyId,
                EnvironmentId,
                ExactTurnLease,
                AgentPolicyId,
                PrincipalRef,
                PackageId
            ],
            "turn.record",
            { major: 2, minor: 0 }
        );
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

export function runCheckpointContentRetention(
    value: RunCheckpoint
): readonly ContentRetentionField[] {
    return contentRetentionFields([
        ["state", value.state],
        ["tree", value.tree]
    ]);
}

class CheckpointCodec extends RecordCodec<RunCheckpoint> {
    public constructor() {
        super(
            [
                RunCheckpoint,
                TextId,
                ContentRef,
                Digest,
                RunCommitId,
                RunCheckpointId,
                TurnId,
                CodecRecord
            ],
            "run.checkpoint",
            {
                major: 1,
                minor: 0
            }
        );
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
            (!(cancellationToken.turn instanceof TurnId) ||
                !(cancellationToken.holder instanceof PrincipalRef) ||
                !cancellationToken.turn.equals(turn) ||
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
                : tokenFromData(object["cancellationToken"]),
            requireTimestamp(object["recordedAt"], "Inbox timestamp")
        );
    }
}

export function turnInboxEntryContentRetention(
    value: TurnInboxEntry
): readonly ContentRetentionField[] {
    return contentRetentionFields([["payload", value.payload]]);
}

class InboxCodec extends RecordCodec<TurnInboxEntry> {
    public constructor() {
        super(
            [
                TurnInboxEntry,
                TextId,
                ContentRef,
                Digest,
                TurnInboxEntryId,
                TenantId,
                TurnId,
                PrincipalId,
                CodecRecord,
                PrincipalRef
            ],
            "turn.inbox-entry",
            {
                major: 2,
                minor: 0
            }
        );
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
    return leaseTokenToData(token);
}

function tokenFromData(value: JsonValue): LeaseToken {
    return leaseTokenFromData(value, "Cancellation token");
}

function requireTurnStatus(value: JsonValue | undefined): TurnStatus {
    if (value === "queued" || value === "running" || value === "suspended") {
        return TurnStatus.from(value);
    }
    return TurnStatus.from(requireTerminalOutcome(value, "Turn status"));
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

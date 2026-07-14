import type { SynchronousResultGuard } from "../../actors";
import { Revision, type RecordCodec } from "../../core";
import { AgentCoreError } from "../../errors";
import { RunCommit, RunCommitCodec } from "./commit";
import { RunConfigurationSnapshot, RunConfigurationSnapshotCodec } from "./pins";
import { Run, RunBranch, RunBranchCodec, RunCodec } from "./run";
import {
    RunCheckpoint,
    RunCheckpointCodec,
    Turn,
    TurnCodec,
    TurnInboxEntry,
    TurnInboxEntryCodec
} from "./turn";
import { TurnPlacementSnapshot, TurnPlacementSnapshotCodec } from "./placement";
import { SpawnReservation, SpawnReservationCodec } from "./spawn";
import type {
    RunBranchId,
    RunCheckpointId,
    RunId,
    SpawnReservationId,
    TurnInboxEntryId
} from "./id";
import type { RunCommitId, TurnId } from "../../execution-references";
import { RunAdmissionRegistry, RunAdmissionRegistryCodec } from "./admission";
import { ForcedTurnCancellation, ForcedTurnCancellationCodec } from "./forced-cancellation";

export const RUN_RECORD_KINDS = Object.freeze([
    "configuration",
    "run",
    "branch",
    "commit",
    "turn",
    "placement",
    "checkpoint",
    "inbox",
    "spawn",
    "admission",
    "forcedCancellation"
] as const);

export type RunRecordKind = (typeof RUN_RECORD_KINDS)[number];

export interface StoredRunRecord {
    readonly kind: RunRecordKind;
    readonly key: string;
    readonly revision: number | null;
    readonly bytes: Uint8Array;
}

export interface StoredRunParent {
    readonly commit: string;
    readonly ordinal: number;
    readonly parent: string;
}

export interface RunStoragePort<Transaction> {
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    get(transaction: Transaction, kind: RunRecordKind, key: string): StoredRunRecord | undefined;
    list(transaction: Transaction, kind: RunRecordKind): readonly StoredRunRecord[];
    insert(transaction: Transaction, record: StoredRunRecord): void;
    replace(transaction: Transaction, record: StoredRunRecord, expectedRevision: number): void;
    insertParent(transaction: Transaction, edge: StoredRunParent): void;
    parents(transaction: Transaction, commit: string): readonly StoredRunParent[];
}

export class RunRepository<Transaction> {
    public constructor(public readonly storage: RunStoragePort<Transaction>) {}

    public transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.storage.transaction(operation, ...guard);
    }

    public insertConfiguration(tx: Transaction, value: RunConfigurationSnapshot): void {
        this.insert(tx, "configuration", value.id.value, value, RunConfigurationSnapshotCodec);
    }

    public loadConfiguration(tx: Transaction, key: string): RunConfigurationSnapshot | undefined {
        return this.load(
            tx,
            "configuration",
            key,
            RunConfigurationSnapshotCodec,
            (value) => value.id.value
        );
    }

    public insertRun(tx: Transaction, value: Run): void {
        this.insert(tx, "run", value.id.value, value, RunCodec, value.revision);
    }

    public replaceRun(tx: Transaction, expected: Revision, value: Run): void {
        this.replace(tx, "run", value.id.value, value, RunCodec, expected, value.revision);
    }

    public loadRun(tx: Transaction, id: RunId): Run | undefined {
        return this.load(
            tx,
            "run",
            id.value,
            RunCodec,
            (value) => value.id.value,
            (value) => value.revision
        );
    }

    public listRuns(tx: Transaction): readonly Run[] {
        return this.list(
            tx,
            "run",
            RunCodec,
            (value) => value.id.value,
            (value) => value.revision
        );
    }

    public insertBranch(tx: Transaction, value: RunBranch): void {
        this.insert(tx, "branch", value.id.value, value, RunBranchCodec, value.revision);
    }

    public replaceBranch(tx: Transaction, expected: Revision, value: RunBranch): void {
        this.replace(tx, "branch", value.id.value, value, RunBranchCodec, expected, value.revision);
    }

    public loadBranch(tx: Transaction, id: RunBranchId): RunBranch | undefined {
        return this.load(
            tx,
            "branch",
            id.value,
            RunBranchCodec,
            (value) => value.id.value,
            (value) => value.revision
        );
    }

    public listBranches(tx: Transaction): readonly RunBranch[] {
        return this.list(
            tx,
            "branch",
            RunBranchCodec,
            (value) => value.id.value,
            (value) => value.revision
        );
    }

    public insertCommit(tx: Transaction, value: RunCommit): void {
        this.insert(tx, "commit", value.id.value, value, RunCommitCodec);
        value.parents.forEach((parent, ordinal) =>
            this.storage.insertParent(tx, {
                commit: value.id.value,
                ordinal,
                parent: parent.value
            })
        );
    }

    public loadCommit(tx: Transaction, id: RunCommitId): RunCommit | undefined {
        const commit = this.load(tx, "commit", id.value, RunCommitCodec, (value) => value.id.value);
        if (commit !== undefined) this.validateParents(tx, commit);
        return commit;
    }

    public listCommits(tx: Transaction): readonly RunCommit[] {
        const commits = this.list(tx, "commit", RunCommitCodec, (value) => value.id.value);
        commits.forEach((commit) => this.validateParents(tx, commit));
        return commits;
    }

    public insertTurn(tx: Transaction, value: Turn): void {
        this.insert(tx, "turn", value.id.value, value, TurnCodec, value.revision);
    }

    public replaceTurn(tx: Transaction, expected: Revision, value: Turn): void {
        this.replace(tx, "turn", value.id.value, value, TurnCodec, expected, value.revision);
    }

    public loadTurn(tx: Transaction, id: TurnId): Turn | undefined {
        return this.load(
            tx,
            "turn",
            id.value,
            TurnCodec,
            (value) => value.id.value,
            (value) => value.revision
        );
    }

    public listTurns(tx: Transaction): readonly Turn[] {
        return this.list(
            tx,
            "turn",
            TurnCodec,
            (value) => value.id.value,
            (value) => value.revision
        );
    }

    public insertPlacement(tx: Transaction, value: TurnPlacementSnapshot): void {
        this.insert(tx, "placement", value.turn.value, value, TurnPlacementSnapshotCodec);
    }

    public loadPlacement(tx: Transaction, id: TurnId): TurnPlacementSnapshot | undefined {
        return this.load(
            tx,
            "placement",
            id.value,
            TurnPlacementSnapshotCodec,
            (value) => value.turn.value
        );
    }

    public insertCheckpoint(tx: Transaction, value: RunCheckpoint): void {
        this.insert(tx, "checkpoint", value.id.value, value, RunCheckpointCodec);
    }

    public loadCheckpoint(tx: Transaction, id: RunCheckpointId): RunCheckpoint | undefined {
        return this.load(tx, "checkpoint", id.value, RunCheckpointCodec, (value) => value.id.value);
    }

    public insertInbox(tx: Transaction, value: TurnInboxEntry): void {
        this.insert(tx, "inbox", value.id.value, value, TurnInboxEntryCodec);
    }

    public loadInbox(tx: Transaction, id: TurnInboxEntryId): TurnInboxEntry | undefined {
        return this.load(tx, "inbox", id.value, TurnInboxEntryCodec, (value) => value.id.value);
    }

    public listInbox(tx: Transaction, turn: TurnId): readonly TurnInboxEntry[] {
        return this.list(tx, "inbox", TurnInboxEntryCodec, (value) => value.id.value)
            .filter((entry) => entry.turn.equals(turn))
            .sort((left, right) => left.sequence - right.sequence);
    }

    public insertSpawn(tx: Transaction, value: SpawnReservation): void {
        this.insert(tx, "spawn", value.id.value, value, SpawnReservationCodec);
    }

    public loadSpawn(tx: Transaction, id: SpawnReservationId): SpawnReservation | undefined {
        return this.load(tx, "spawn", id.value, SpawnReservationCodec, (value) => value.id.value);
    }

    public insertAdmission(tx: Transaction, value: RunAdmissionRegistry): void {
        this.insert(
            tx,
            "admission",
            value.run.value,
            value,
            RunAdmissionRegistryCodec,
            new Revision(admissionRevision(value))
        );
    }

    public replaceAdmission(
        tx: Transaction,
        expected: RunAdmissionRegistry,
        value: RunAdmissionRegistry
    ): void {
        if (!expected.run.equals(value.run)) {
            throw new AgentCoreError(
                "run.invalid-state",
                "Run admission registry identity changed"
            );
        }
        this.replace(
            tx,
            "admission",
            value.run.value,
            value,
            RunAdmissionRegistryCodec,
            new Revision(admissionRevision(expected)),
            new Revision(admissionRevision(value))
        );
    }

    public loadAdmission(tx: Transaction, id: RunId): RunAdmissionRegistry | undefined {
        return this.load(
            tx,
            "admission",
            id.value,
            RunAdmissionRegistryCodec,
            (value) => value.run.value,
            (value) => new Revision(admissionRevision(value))
        );
    }

    public insertForcedCancellation(tx: Transaction, value: ForcedTurnCancellation): void {
        this.insert(tx, "forcedCancellation", value.turn.value, value, ForcedTurnCancellationCodec);
    }

    public loadForcedCancellation(
        tx: Transaction,
        turn: TurnId
    ): ForcedTurnCancellation | undefined {
        return this.load(
            tx,
            "forcedCancellation",
            turn.value,
            ForcedTurnCancellationCodec,
            (value) => value.turn.value
        );
    }

    public listForcedCancellations(tx: Transaction, run: RunId): readonly ForcedTurnCancellation[] {
        return this.list(
            tx,
            "forcedCancellation",
            ForcedTurnCancellationCodec,
            (value) => value.turn.value
        ).filter((value) => value.run.equals(run));
    }

    public isAncestor(tx: Transaction, ancestor: RunCommitId, descendant: RunCommitId): boolean {
        const target = this.loadCommit(tx, ancestor);
        const child = this.loadCommit(tx, descendant);
        if (target === undefined || child === undefined || !target.run.equals(child.run))
            return false;
        const pending = [child];
        const visited = new Set<string>();
        while (pending.length > 0) {
            const current = pending.pop()!;
            if (current.id.equals(ancestor)) return true;
            if (visited.has(current.id.value)) continue;
            visited.add(current.id.value);
            for (const parent of current.parents) {
                const record = this.loadCommit(tx, parent);
                if (record === undefined || !record.run.equals(child.run)) {
                    throw new AgentCoreError(
                        "codec.invalid",
                        "Run ancestry contains a missing or foreign parent"
                    );
                }
                pending.push(record);
            }
        }
        return false;
    }

    private insert<Value>(
        tx: Transaction,
        kind: RunRecordKind,
        key: string,
        value: Value,
        codec: RecordCodec<Value>,
        revision?: Revision
    ): void {
        const bytes = codec.encode(value);
        const canonical = codec.decode(bytes);
        this.storage.insert(tx, {
            kind,
            key,
            revision: revision?.value ?? null,
            bytes: codec.encode(canonical)
        });
    }

    private replace<Value>(
        tx: Transaction,
        kind: RunRecordKind,
        key: string,
        value: Value,
        codec: RecordCodec<Value>,
        expected: Revision,
        revision: Revision
    ): void {
        const bytes = codec.encode(codec.decode(codec.encode(value)));
        this.storage.replace(tx, { kind, key, revision: revision.value, bytes }, expected.value);
    }

    private load<Value>(
        tx: Transaction,
        kind: RunRecordKind,
        key: string,
        codec: RecordCodec<Value>,
        keyOf: (value: Value) => string,
        revisionOf?: (value: Value) => Revision
    ): Value | undefined {
        const stored = this.storage.get(tx, kind, key);
        if (stored === undefined) return undefined;
        const value = codec.decode(stored.bytes.slice());
        if (
            keyOf(value) !== stored.key ||
            (revisionOf?.(value).value ?? null) !== stored.revision
        ) {
            throw new AgentCoreError(
                "codec.invalid",
                "Stored Run projection does not match codec bytes"
            );
        }
        return value;
    }

    private list<Value>(
        tx: Transaction,
        kind: RunRecordKind,
        codec: RecordCodec<Value>,
        keyOf: (value: Value) => string,
        revisionOf?: (value: Value) => Revision
    ): readonly Value[] {
        return this.storage.list(tx, kind).map((row) => {
            const value = codec.decode(row.bytes.slice());
            if (keyOf(value) !== row.key || (revisionOf?.(value).value ?? null) !== row.revision) {
                throw new AgentCoreError(
                    "codec.invalid",
                    "Stored Run list projection does not match codec bytes"
                );
            }
            return value;
        });
    }

    private validateParents(tx: Transaction, commit: RunCommit): void {
        const edges = this.storage.parents(tx, commit.id.value);
        if (
            edges.length !== commit.parents.length ||
            edges.some(
                (edge, ordinal) =>
                    edge.ordinal !== ordinal || edge.parent !== commit.parents[ordinal]?.value
            )
        ) {
            throw new AgentCoreError(
                "codec.invalid",
                "Stored Run parents do not match commit bytes"
            );
        }
    }
}

function admissionRevision(value: RunAdmissionRegistry): number {
    return value.reserved.length + value.completed.length + (value.accepting ? 0 : 1);
}

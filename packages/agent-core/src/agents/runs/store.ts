import type { ActorRef, SynchronousResultGuard } from "../../actors";
import { CodecRecord, isString, requireExactFields, requireObject } from "../record-data";
import {
    ByteRange,
    ContentOwnerEdge,
    ContentStat,
    ContentStore,
    MediaHint,
    requireOperationTime,
    type ContentPutResult
} from "../../content";
import { Revision, type ContentRef, type Digest, RecordCodec, type JsonValue, type JsonObject } from "../../core";
import { AgentCoreError } from "../../errors";
import type { TenantId } from "../../identity";
import {
    AcceptanceCriterion,
    AcceptanceCriterionCodec,
    AcceptanceVerdict,
    AcceptanceVerdictCodec
} from "./acceptance";
import { RunCommit, RunCommitCodec, runCommitContentRetention } from "./commit";
import { RunConfigurationSnapshot, RunConfigurationSnapshotCodec } from "./pins";
import { Run, RunBranch, RunBranchCodec, RunCodec } from "./run";
import {
    RunCheckpoint,
    RunCheckpointCodec,
    runCheckpointContentRetention,
    Turn,
    TurnCodec,
    turnContentRetention,
    TurnInboxEntry,
    TurnInboxEntryCodec,
    turnInboxEntryContentRetention
} from "./turn";
import { TurnPlacementSnapshot, TurnPlacementSnapshotCodec } from "./placement";
import { SpawnReservation, SpawnReservationCodec, spawnReservationContentRetention } from "./spawn";
import type {
    AcceptanceId,
    RunBranchId,
    RunCheckpointId,
    RunId,
    SpawnReservationId,
    TurnInboxEntryId
} from "./id";
import type { RunCommitId, TurnId } from "../../execution-references";
import { RunAdmissionRegistry, RunAdmissionRegistryCodec } from "./admission";
import { ForcedTurnCancellation, ForcedTurnCancellationCodec } from "./forced-cancellation";
import type { LeaseToken } from "./lease";
import type { ContentRetentionField } from "../record-data";

export interface RunExecutionScope {
    readonly run: Run;
    readonly turn: Turn;
    readonly branch: RunBranch;
    readonly head: RunCommit;
    readonly effectiveCommit: RunCommit;
    readonly placement: TurnPlacementSnapshot;
    readonly checkpoint: RunCheckpoint | undefined;
}

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
    "forcedCancellation",
    "acceptance",
    "verdict",
    "targetLeaseEvidence"
] as const);

export type RunRecordKind = (typeof RUN_RECORD_KINDS)[number];

class OpaqueRunTransaction {
    readonly #opaque = true;

    public constructor() {
        void this.#opaque;
        Object.freeze(this);
    }
}
Object.freeze(OpaqueRunTransaction.prototype);
Object.freeze(OpaqueRunTransaction);

export type RunTransaction = OpaqueRunTransaction;

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

interface RunStorageBackend<Transaction> {
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    get(transaction: Transaction, kind: RunRecordKind, key: string): StoredRunRecord | undefined;
    list(transaction: Transaction, kind: RunRecordKind): readonly StoredRunRecord[];
    validate(record: StoredRunRecord): void;
    poison(transaction: Transaction, failure: Error): never;
    insert(transaction: Transaction, record: StoredRunRecord): void;
    replace(transaction: Transaction, record: StoredRunRecord, expectedRevision: number): void;
    insertParent(transaction: Transaction, edge: StoredRunParent): void;
    parents(transaction: Transaction, commit: string): readonly StoredRunParent[];
    retain(transaction: Transaction, edge: ContentOwnerEdge, operationAt: Date): void;
    release(transaction: Transaction, edge: ContentOwnerEdge, operationAt: Date): void;
    verify(
        transaction: Transaction,
        ownerPrefixes: readonly string[],
        expected: readonly ContentOwnerEdge[]
    ): void;
}

const ownedRunStorageBackends = new WeakSet<object>();

export function ownRunStorageBackend<Transaction>(
    backend: RunStorageBackend<Transaction>
): RunStorageBackend<Transaction> {
    ownedRunStorageBackends.add(backend);
    return backend;
}

export abstract class RunStoragePort<Transaction> {
    readonly #backend: RunStorageBackend<Transaction>;
    readonly #clock: () => Date;
    #transactionActive = false;
    declare public readonly content: ContentStore;

    protected constructor(
        public readonly tenant: TenantId,
        public readonly owner: ActorRef,
        content: ContentStore,
        backend: RunStorageBackend<Transaction>,
        clock: () => Date = () => new Date()
    ) {
        if (!ownedRunStorageBackends.delete(backend)) {
            throw new TypeError("Run storage backends must be created by the owning context");
        }
        const contentFacade = Object.freeze(
            new RunContentStore(content, () => {
                if (this.#transactionActive) throw contentWriteDuringTransaction();
            })
        );
        Object.defineProperty(this, "content", {
            configurable: false,
            enumerable: true,
            value: contentFacade,
            writable: false
        });
        this.#backend = backend;
        this.#clock = clock;
        this.verifyContentCustody();
    }

    protected static createTransaction(): RunTransaction {
        return new OpaqueRunTransaction();
    }

    public transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        const alreadyActive = this.#transactionActive;
        this.#transactionActive = true;
        try {
            return this.#backend.transaction(operation, ...guard);
        } finally {
            this.#transactionActive = alreadyActive;
        }
    }

    public get(
        transaction: Transaction,
        kind: RunRecordKind,
        key: string
    ): StoredRunRecord | undefined {
        return this.#backend.get(transaction, kind, key);
    }

    public list(transaction: Transaction, kind: RunRecordKind): readonly StoredRunRecord[] {
        return this.#backend.list(transaction, kind);
    }

    public insert(transaction: Transaction, record: StoredRunRecord): void {
        this.mutate(transaction, () => {
            const previous = this.#backend.get(transaction, record.kind, record.key);
            this.#backend.validate(record);
            const before = previous === undefined ? [] : contentOwnerEdges(this, previous);
            const after = contentOwnerEdges(this, record);
            this.#backend.insert(transaction, record);
            this.reconcileContentCustody(transaction, before, after);
        });
    }

    public replace(
        transaction: Transaction,
        record: StoredRunRecord,
        expectedRevision: number
    ): void {
        this.mutate(transaction, () => {
            const previous = this.#backend.get(transaction, record.kind, record.key);
            this.#backend.validate(record);
            if (
                previous?.revision !== expectedRevision ||
                record.revision !== expectedRevision + 1
            ) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "Run record revision changed"
                );
            }
            const before = previous === undefined ? [] : contentOwnerEdges(this, previous);
            const after = contentOwnerEdges(this, record);
            this.#backend.replace(transaction, record, expectedRevision);
            this.reconcileContentCustody(transaction, before, after);
        });
    }

    public insertParent(transaction: Transaction, edge: StoredRunParent): void {
        this.mutate(transaction, () => this.#backend.insertParent(transaction, edge));
    }

    public parents(transaction: Transaction, commit: string): readonly StoredRunParent[] {
        return this.#backend.parents(transaction, commit);
    }

    private verifyContentCustody(): void {
        this.transaction((transaction) => {
            const expected = RUN_RECORD_KINDS.flatMap((kind) =>
                this.#backend
                    .list(transaction, kind)
                    .flatMap((record) => contentOwnerEdges(this, record))
            );
            this.#backend.verify(transaction, RUN_CONTENT_OWNER_PREFIXES, expected);
        });
    }

    private mutate(transaction: Transaction, operation: () => void): void {
        try {
            operation();
        } catch (error) {
            this.#backend.poison(
                transaction,
                error instanceof Error ? error : nonErrorCustodyFailure()
            );
        }
    }

    private reconcileContentCustody(
        transaction: Transaction,
        before: readonly ContentOwnerEdge[],
        after: readonly ContentOwnerEdge[]
    ): void {
        const removed = before.filter((edge) => !after.some((candidate) => candidate.equals(edge)));
        if (removed.length === 0 && after.length === 0) return;
        const operationAt = requireOperationTime(this.#clock(), "Run content retention time");
        for (const edge of removed) this.#backend.release(transaction, edge, operationAt);
        for (const edge of after) this.#backend.retain(transaction, edge, operationAt);
    }
}
Object.freeze(RunStoragePort.prototype);
Object.freeze(RunStoragePort);

class RunContentStore extends ContentStore {
    readonly #get: (ref: ContentRef, range?: ByteRange) => Promise<Uint8Array>;
    readonly #put: (bytes: Uint8Array, hint?: MediaHint) => Promise<ContentPutResult>;
    readonly #requireWrite: () => void;
    readonly #stat: (ref: ContentRef) => Promise<ContentStat | undefined>;

    public constructor(store: ContentStore, requireWrite: () => void) {
        super();
        this.#get = store.get.bind(store);
        this.#put = store.put.bind(store);
        this.#requireWrite = requireWrite;
        this.#stat = store.stat.bind(store);
    }

    public put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult> {
        this.#requireWrite();
        return this.#put(bytes, hint);
    }

    public async get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array> {
        return this.#get(ref, range);
    }

    public async stat(ref: ContentRef): Promise<ContentStat | undefined> {
        return this.#stat(ref);
    }
}
Object.freeze(RunContentStore.prototype);
Object.freeze(RunContentStore);

export class RunRepository<Transaction> {
    public constructor(public readonly storage: RunStoragePort<Transaction>) {
        Object.freeze(this);
    }

    public get content(): ContentStore {
        return this.storage.content;
    }

    public transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.storage.transaction(operation, ...guard);
    }

    public loadExecutionScope(tx: Transaction, token: LeaseToken, now: Date): RunExecutionScope {
        const turn = requireStored(
            this.loadTurn(tx, token.turn),
            "Turn executor target does not exist"
        );
        turn.requireToken(token, now);
        const run = requireStored(this.loadRun(tx, turn.run), "Turn executor Run does not exist");
        const branch = requireStored(
            this.loadBranch(tx, turn.branch),
            "Turn executor branch does not exist"
        );
        const head = requireStored(
            this.loadCommit(tx, branch.head),
            "Turn executor branch head does not exist"
        );
        const startHead = requireStored(
            this.loadCommit(tx, turn.startHead),
            "Turn executor start head does not exist"
        );
        const effectiveCommit = requireStored(
            this.loadCommit(tx, turn.effectiveInput),
            "Turn executor effective input does not exist"
        );
        const placement = requireStored(
            this.loadPlacement(tx, turn.id),
            "Turn executor placement does not exist"
        );
        const checkpoint =
            turn.checkpoint === undefined
                ? undefined
                : requireStored(
                      this.loadCheckpoint(tx, turn.checkpoint),
                      "Turn executor checkpoint does not exist"
                  );
        const checkpointCommit =
            checkpoint === undefined
                ? undefined
                : requireStored(
                      this.loadCommit(tx, checkpoint.commit),
                      "Turn executor checkpoint commit does not exist"
                  );
        const unpairedTransition = this.listCommits(tx).some(
            (commit) =>
                (commit.kind === "checkpoint" || commit.kind === "result") &&
                commit.writer.kind === "turn" &&
                commit.writer.token.turn.equals(token.turn) &&
                commit.writer.token.holder.equals(token.holder) &&
                commit.writer.token.epoch === token.epoch &&
                this.isAncestor(tx, commit.id, branch.head)
        );
        if (
            run.lifecycle.kind !== "active" ||
            turn.status.kind !== "running" ||
            !branch.run.equals(run.id) ||
            !head.run.equals(run.id) ||
            !head.branch.equals(branch.id) ||
            !head.pins.equals(turn.pins) ||
            !startHead.run.equals(run.id) ||
            !startHead.branch.equals(branch.id) ||
            !startHead.pins.equals(turn.pins) ||
            !effectiveCommit.run.equals(run.id) ||
            !effectiveCommit.branch.equals(branch.id) ||
            !effectiveCommit.pins.equals(turn.pins) ||
            !placement.turn.equals(turn.id) ||
            !placement.digest.equals(turn.placement) ||
            !placement.pins.equals(turn.pins) ||
            !this.isAncestor(tx, turn.startHead, branch.head) ||
            !this.isAncestor(tx, turn.effectiveInput, turn.startHead) ||
            unpairedTransition ||
            (checkpoint !== undefined &&
                (checkpointCommit === undefined ||
                    !checkpoint.turn.equals(turn.id) ||
                    checkpointCommit.kind !== "checkpoint" ||
                    !checkpointCommit.run.equals(run.id) ||
                    !checkpointCommit.branch.equals(branch.id) ||
                    !checkpointCommit.subjectTurn?.equals(turn.id) ||
                    !checkpointCommit.pins.equals(turn.pins) ||
                    !checkpointCommit.content?.equals(checkpoint.state) ||
                    !optionalContentRefsEqual(checkpointCommit.treeCheckpoint, checkpoint.tree) ||
                    !this.isAncestor(tx, checkpoint.commit, branch.head)))
        ) {
            throw invalidExecutionScope();
        }
        return Object.freeze({
            run,
            turn,
            branch,
            head,
            effectiveCommit,
            placement,
            checkpoint
        });
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

    // A Run is spawned at most once, so the reservation naming it as child is unique and
    // is where that Run's declared resource ceiling lives (SPEC §5.2).
    public loadSpawnForChild(tx: Transaction, child: RunId): SpawnReservation | undefined {
        const reservations = this.list(
            tx,
            "spawn",
            SpawnReservationCodec,
            (value) => value.id.value
        ).filter((value) => value.childRun.equals(child));
        if (reservations.length > 1) {
            throw new AgentCoreError(
                "run.invalid-state",
                "Run has more than one spawn reservation"
            );
        }
        return reservations[0];
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

    public insertAcceptanceCriterion(tx: Transaction, value: AcceptanceCriterion): void {
        this.insert(tx, "acceptance", value.id.value, value, AcceptanceCriterionCodec);
    }

    public loadAcceptanceCriterion(
        tx: Transaction,
        id: AcceptanceId
    ): AcceptanceCriterion | undefined {
        return this.load(
            tx,
            "acceptance",
            id.value,
            AcceptanceCriterionCodec,
            (value) => value.id.value
        );
    }

    public insertAcceptanceVerdict(tx: Transaction, value: AcceptanceVerdict): void {
        this.insert(tx, "verdict", acceptanceVerdictKey(value), value, AcceptanceVerdictCodec);
    }

    public loadAcceptanceVerdict(
        tx: Transaction,
        acceptance: AcceptanceId,
        subject: Digest
    ): AcceptanceVerdict | undefined {
        return this.load(
            tx,
            "verdict",
            `${acceptance.value}:${subject.value}`,
            AcceptanceVerdictCodec,
            acceptanceVerdictKey
        );
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
        const record = Object.freeze<StoredRunRecord>({
            kind,
            key,
            revision: revision?.value ?? null,
            bytes: codec.encode(canonical)
        });
        this.storage.insert(tx, record);
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
        const record = Object.freeze<StoredRunRecord>({
            kind,
            key,
            revision: revision.value,
            bytes
        });
        this.storage.replace(tx, record, expected.value);
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
        const value = codec.decode(stored.bytes);
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
            const value = codec.decode(row.bytes);
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
Object.freeze(RunRepository.prototype);
Object.freeze(RunRepository);

interface DecodedRunContentRecord {
    readonly key: string;
    readonly revision: number | null;
    readonly ownerKind: string;
    readonly fields: readonly ContentRetentionField[];
}

interface RunRecordDescriptorBase {
    readonly ownerKind: string;
    decodeContent(bytes: Uint8Array): DecodedRunContentRecord | undefined;
}

interface RunRecordDescriptor<Value extends CodecRecord> extends RunRecordDescriptorBase {
    readonly codec: RecordCodec<Value>;
    key(value: Value): string;
    revision(value: Value): number | null;
}

type ContentProjection<Value extends CodecRecord> = (
    value: Value
) => readonly ContentRetentionField[];

/**
 * One immutable target lease attestation stored under its idempotency key. The
 * canonical bytes are opaque to the runs plane: the authority plane owns their
 * shape, the runs plane owns the durable, co-transacted storage.
 */
export class TargetLeaseEvidenceRecord extends CodecRecord {
    public readonly key: string;
    public readonly evidence: string;

    public constructor(init: { readonly key: string; readonly evidence: string }) {
        super();
        if (init.key.length === 0 || init.key !== init.key.trim()) {
            throw new TypeError("Stored lease evidence key must be canonical and nonblank");
        }
        if (init.evidence.length === 0) {
            throw new TypeError("Stored lease evidence bytes must not be empty");
        }
        this.key = init.key;
        this.evidence = init.evidence;
        Object.freeze(this);
    }

    public static get codec(): RecordCodec<TargetLeaseEvidenceRecord> {
        return targetLeaseEvidenceRecordCodec;
    }

    public toData(): JsonObject {
        return { evidence: this.evidence, key: this.key };
    }

    public static fromData(payload: JsonValue): TargetLeaseEvidenceRecord {
        const object = requireObject(payload, "Stored lease evidence record");
        requireExactFields(object, ["evidence", "key"], [], "Stored lease evidence record");
        const key = object["key"];
        const evidence = object["evidence"];
        if (!isString(key) || !isString(evidence)) {
            throw new TypeError("Stored lease evidence fields must be strings");
        }
        return new TargetLeaseEvidenceRecord({ evidence, key });
    }
}

class TargetLeaseEvidenceRecordCodec extends RecordCodec<TargetLeaseEvidenceRecord> {
    public constructor() {
        super([TargetLeaseEvidenceRecord, CodecRecord], "runs.target-lease-evidence", { major: 1, minor: 0 });
    }

    protected encodePayload(record: TargetLeaseEvidenceRecord): JsonValue {
        return record.toData();
    }

    protected decodePayload(payload: JsonValue): TargetLeaseEvidenceRecord {
        return TargetLeaseEvidenceRecord.fromData(payload);
    }
}

export const targetLeaseEvidenceRecordCodec: RecordCodec<TargetLeaseEvidenceRecord> =
    new TargetLeaseEvidenceRecordCodec();

const RUN_RECORD_DESCRIPTORS = Object.freeze({
    configuration: recordDescriptor(RunConfigurationSnapshotCodec, (value) => value.id.value),
    run: recordDescriptor(
        RunCodec,
        (value) => value.id.value,
        (value) => value.revision.value
    ),
    branch: recordDescriptor(
        RunBranchCodec,
        (value) => value.id.value,
        (value) => value.revision.value
    ),
    commit: contentRecordDescriptor(
        RunCommitCodec,
        (value) => value.id.value,
        runCommitContentRetention
    ),
    turn: contentRecordDescriptor(
        TurnCodec,
        (value) => value.id.value,
        turnContentRetention,
        (value) => value.revision.value
    ),
    placement: recordDescriptor(TurnPlacementSnapshotCodec, (value) => value.turn.value),
    checkpoint: contentRecordDescriptor(
        RunCheckpointCodec,
        (value) => value.id.value,
        runCheckpointContentRetention
    ),
    inbox: contentRecordDescriptor(
        TurnInboxEntryCodec,
        (value) => value.id.value,
        turnInboxEntryContentRetention
    ),
    spawn: contentRecordDescriptor(
        SpawnReservationCodec,
        (value) => value.id.value,
        spawnReservationContentRetention
    ),
    admission: recordDescriptor(
        RunAdmissionRegistryCodec,
        (value) => value.run.value,
        admissionRevision
    ),
    forcedCancellation: recordDescriptor(ForcedTurnCancellationCodec, (value) => value.turn.value),
    acceptance: recordDescriptor(AcceptanceCriterionCodec, (value) => value.id.value),
    targetLeaseEvidence: recordDescriptor(targetLeaseEvidenceRecordCodec, (value) => value.key),
    verdict: recordDescriptor(AcceptanceVerdictCodec, acceptanceVerdictKey)
}) satisfies Readonly<Record<RunRecordKind, RunRecordDescriptorBase>>;

const RUN_CONTENT_OWNER_PREFIXES = Object.freeze([
    ...new Set(RUN_RECORD_KINDS.map((kind) => `record:${RUN_RECORD_DESCRIPTORS[kind].ownerKind}:`))
]);

function recordDescriptor<Value extends CodecRecord>(
    codec: RecordCodec<Value>,
    key: (value: Value) => string,
    revision: (value: Value) => number | null = () => null
): RunRecordDescriptor<Value> {
    return createRecordDescriptor(codec, key, revision);
}

function contentRecordDescriptor<Value extends CodecRecord>(
    codec: RecordCodec<Value>,
    key: (value: Value) => string,
    projection: ContentProjection<Value>,
    revision: (value: Value) => number | null = () => null
): RunRecordDescriptor<Value> {
    return createRecordDescriptor(codec, key, revision, projection);
}

function createRecordDescriptor<Value extends CodecRecord>(
    codec: RecordCodec<Value>,
    key: (value: Value) => string,
    revision: (value: Value) => number | null,
    projection?: ContentProjection<Value>
): RunRecordDescriptor<Value> {
    return Object.freeze({
        codec,
        key,
        revision,
        ownerKind: codec.kind,
        decodeContent(bytes: Uint8Array): DecodedRunContentRecord | undefined {
            if (projection === undefined) return undefined;
            const value = codec.decode(bytes);
            return {
                key: key(value),
                revision: revision(value),
                ownerKind: codec.kind,
                fields: projection(value)
            };
        }
    });
}

function contentOwnerEdges<Transaction>(
    storage: RunStoragePort<Transaction>,
    record: StoredRunRecord
): readonly ContentOwnerEdge[] {
    const descriptor: RunRecordDescriptorBase = RUN_RECORD_DESCRIPTORS[record.kind];
    const decoded = descriptor.decodeContent(record.bytes);
    if (decoded === undefined) return [];
    if (decoded.key !== record.key || decoded.revision !== record.revision) {
        throw new AgentCoreError(
            "codec.invalid",
            "Stored Run content projection does not match codec bytes"
        );
    }
    return Object.freeze(
        decoded.fields.map(
            ({ field, ref }) =>
                new ContentOwnerEdge(
                    storage.tenant,
                    storage.owner,
                    `record:${decoded.ownerKind}:${decoded.key.length}:${decoded.key}:${field}`,
                    ref
                )
        )
    );
}

function admissionRevision(value: RunAdmissionRegistry): number {
    return value.reserved.length + value.completed.length + (value.accepting ? 0 : 1);
}

function acceptanceVerdictKey(value: AcceptanceVerdict): string {
    return `${value.acceptance.value}:${value.subject.value}`;
}

function nonErrorCustodyFailure(): AgentCoreError {
    return new AgentCoreError(
        "protocol.invalid-state",
        "Run content custody failed with a non-Error value"
    );
}

function contentWriteDuringTransaction(): AgentCoreError {
    return new AgentCoreError(
        "run.invalid-state",
        "Run content writes are not allowed during a Run storage transaction"
    );
}

function requireStored<Value>(value: Value | undefined, message: string): Value {
    if (value === undefined) throw new AgentCoreError("turn.invalid-state", message);
    return value;
}

function optionalContentRefsEqual(
    left: ContentRef | undefined,
    right: ContentRef | undefined
): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function invalidExecutionScope(): AgentCoreError {
    return new AgentCoreError(
        "turn.invalid-state",
        "Turn executor scope does not match canonical Run state"
    );
}

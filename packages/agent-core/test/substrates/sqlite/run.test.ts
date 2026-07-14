import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorId, ActorRef } from "../../../src/actors";
import {
    ForcedTurnCancellation,
    MemoryRunStorage,
    Run,
    RunAdmissionRegistry,
    RunBranch,
    RunBranchId,
    RunCheckpoint,
    RunCheckpointId,
    RunCommit,
    RunConfigurationSnapshot,
    RunId,
    RunPins,
    RunRepository,
    RunRuntime,
    RepositoryTurnLeaseVerifier,
    type RunStoragePort,
    type LeaseToken,
    Turn,
    TurnId,
    TurnPlacementSnapshot
} from "../../../src/agents";
import { Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { PrincipalId } from "../../../src/identity";
import { RunCommitId } from "../../../src/execution-references";
import { ApprovalId, ReceiptId } from "../../../src/invocation-references";
import { AuditRecordId, EventId, InvocationId } from "../../../src/interaction-references";
import { SqliteRunStorage, type SqliteStoredRunRecord } from "../../../src/substrates/sqlite/run";
import { TransactionalSqlite, type SqliteRow, type SqliteValue } from "../../../src/substrates";
import type { SynchronousResultGuard } from "../../../src/actors";
import { FileSqlite, TestSqlite } from "../../helpers/sqlite";
import {
    TestEvidencePort,
    TestMergePort,
    TestSettlementPort,
    TestSourcePort,
    TestSpawnPort,
    configuration,
    content,
    digest,
    genesis,
    ids,
    pins,
    refs
} from "../../agents/runs/fixture";

const owner = new ActorRef("workspace", new ActorId("workspace-run-owner"));

class MutatingSqlite extends TransactionalSqlite {
    public mutate: (statement: string, rows: readonly SqliteRow[]) => readonly SqliteRow[] = (
        _statement,
        rows
    ) => rows;

    public constructor(private readonly base: TestSqlite) {
        super();
    }

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.mutate(statement, this.base.all(statement, bindings));
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.base.run(statement, bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.base.transaction(operation, ..._guard);
    }
}

function row(key: string, revision: number | null = null): SqliteStoredRunRecord {
    return {
        kind: "commit",
        key,
        revision,
        bytes: new TextEncoder().encode(`record:${key}:${revision}`)
    };
}

describe("SQLite Run storage", () => {
    it("[run-storage-port] memory and SQLite satisfy one shared transaction and record contract", () => {
        assertStorageContract(new MemoryRunStorage());
        assertStorageContract(new SqliteRunStorage(new TestSqlite(), owner));
    });

    it("[MIGRATE-RUN-PINS] survives SQLite close and reopen with old and new Turn pins", () => {
        const directory = mkdtempSync(join(tmpdir(), "run-migration-sqlite-"));
        const path = join(directory, "migration.sqlite");
        try {
            const firstDatabase = new FileSqlite(path);
            const first = sqliteRuntime(firstDatabase);
            first.runtime.createRun(genesis());
            const oldBranch = new RunBranch(
                new RunBranchId("sqlite-old-pins"),
                ids.run,
                "sqlite-old-pins",
                ids.root,
                new Revision(0)
            );
            first.runtime.createBranch(ids.run, oldBranch, new Revision(0));
            const oldTurnId = new TurnId("sqlite-pre-migration-turn");
            createPinnedTurn(first.runtime, oldTurnId, oldBranch.id, ids.root, pins(), 0);

            const current = configuration();
            const nextPins = new RunPins({
                ...current.pins,
                agent: {
                    ...current.pins.agent,
                    revision: current.pins.agent.revision.next(),
                    digest: digest("7")
                }
            });
            const target = new RunConfigurationSnapshot({ pins: nextPins });
            const migration = new RunCommit({
                id: new RunCommitId("sqlite-migration"),
                run: ids.run,
                branch: ids.branch,
                kind: "migration",
                parents: [ids.root],
                pins: nextPins,
                writer: {
                    kind: "system",
                    cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
                },
                receipt: refs.receipt,
                migration: { from: current.pins, to: nextPins }
            });
            first.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
                kind: "control",
                run: ids.run,
                receipt: refs.receipt,
                audit: refs.audit,
                proposalDigest: migration.proposalDigest.value
            });
            first.runtime.migrateRun(migration, target, new Revision(0), new Date(1000));
            const newTurnId = new TurnId("sqlite-post-migration-turn");
            createPinnedTurn(first.runtime, newTurnId, ids.branch, migration.id, nextPins, 1);
            firstDatabase.close();

            const reopenedDatabase = new FileSqlite(path);
            const reopened = sqliteRuntime(reopenedDatabase);
            expect(
                reopened.repository.transaction((transaction) =>
                    reopened.repository.loadTurn(transaction, oldTurnId)!.pins.equals(current.pins)
                )
            ).toBe(true);
            expect(
                reopened.repository.transaction((transaction) =>
                    reopened.repository.loadTurn(transaction, newTurnId)!.pins.equals(nextPins)
                )
            ).toBe(true);
            expect(
                reopened.repository.transaction((transaction) =>
                    reopened.repository
                        .loadCommit(transaction, migration.id)
                        ?.migration?.to.equals(nextPins)
                )
            ).toBe(true);
            expect(
                reopened.repository.transaction((transaction) =>
                    reopened.repository
                        .loadConfiguration(transaction, target.id.value)
                        ?.id.equals(target.id)
                )
            ).toBe(true);
            reopenedDatabase.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("binds a strict closed schema to one Run-owning Actor", () => {
        const database = new TestSqlite();
        new SqliteRunStorage(database, owner);
        const objects = database
            .all("SELECT name FROM sqlite_schema WHERE name LIKE 'agent_run_%' ORDER BY name", [])
            .map((value) => value["name"]);
        expect(objects).toEqual([
            "agent_run_commit_parent_reverse",
            "agent_run_commit_parents",
            "agent_run_records",
            "agent_run_storage_schema"
        ]);
        expect(
            () => new SqliteRunStorage(database, new ActorRef("run", new ActorId("different")))
        ).toThrow(/owner/);
        expect(
            () =>
                new SqliteRunStorage(
                    new TestSqlite(),
                    new ActorRef("tenant", new ActorId("tenant"))
                )
        ).toThrow(/Workspace/);
    });

    it("round-trips detached bytes and enforces revision CAS", () => {
        const database = new TestSqlite();
        const storage = new SqliteRunStorage(database, owner);
        const candidate = row("commit-1", 0);
        storage.transaction((tx) => storage.insert(tx, candidate));
        candidate.bytes.fill(0);
        const stored = storage.transaction((tx) => storage.get(tx, "commit", "commit-1"));
        expect(new TextDecoder().decode(stored?.bytes)).toBe("record:commit-1:0");

        storage.transaction((tx) => storage.replace(tx, row("commit-1", 1), 0));
        expect(storage.transaction((tx) => storage.get(tx, "commit", "commit-1"))?.revision).toBe(
            1
        );
        expect(() =>
            storage.transaction((tx) => storage.replace(tx, row("commit-1", 2), 0))
        ).toThrow(AgentCoreError);
        expect(storage.transaction((tx) => storage.list(tx, "commit"))).toHaveLength(1);
        storage.transaction((tx) => storage.insert(tx, row("commit-1", 1)));
        expect(() =>
            storage.transaction((tx) => storage.insert(tx, row("commit-1", 1)))
        ).not.toThrow();
        expect(() =>
            storage.transaction((tx) =>
                storage.insert(tx, {
                    ...row("commit-1", 1),
                    bytes: new Uint8Array([9])
                })
            )
        ).toThrow(/immutable/);
        expect(() =>
            storage.transaction((tx) => storage.replace(tx, row("missing", 1), 0))
        ).toThrow(/revision/);
    });

    it("preserves ordered parent edges and adapter recreation", () => {
        const database = new TestSqlite();
        const storage = new SqliteRunStorage(database, owner);
        storage.transaction((tx) => {
            storage.insertParent(tx, { commit: "merge", ordinal: 0, parent: "target" });
            storage.insertParent(tx, { commit: "merge", ordinal: 1, parent: "source" });
            storage.insertParent(tx, { commit: "merge", ordinal: 1, parent: "source" });
        });
        const restored = new SqliteRunStorage(database, owner);
        expect(
            restored.transaction((tx) => restored.parents(tx, "merge")).map((edge) => edge.parent)
        ).toEqual(["target", "source"]);
        expect(() =>
            restored.transaction((tx) =>
                restored.insertParent(tx, {
                    commit: "merge",
                    ordinal: 1,
                    parent: "different"
                })
            )
        ).toThrow(/immutable/);
    });

    it("rolls back records and edges together", () => {
        const database = new TestSqlite();
        const storage = new SqliteRunStorage(database, owner);
        const repository = new RunRepository(storage);
        const run = new RunId("atomic-cancellation-run");
        const terminalTurn = new TurnId("atomic-terminal-turn");
        const sibling = new Turn({
            id: new TurnId("atomic-sibling-turn"),
            run,
            branch: new RunBranchId("atomic-branch"),
            startHead: new RunCommitId("atomic-root"),
            effectiveInput: new RunCommitId("atomic-root"),
            pins: pins(),
            placement: digest("a"),
            input: content("a"),
            revision: new Revision(0)
        });
        const cancellation = new ForcedTurnCancellation({
            run,
            terminalTurn,
            turn: sibling.id,
            priorLeaseEpoch: 0,
            fencedLeaseEpoch: 1,
            controlReceipt: new ReceiptId("atomic-control-receipt"),
            controlAudit: new AuditRecordId("atomic-control-audit"),
            cancellationEvent: new EventId("atomic-cancellation-event"),
            cancellationAudit: new AuditRecordId("atomic-cancellation-audit")
        });
        repository.transaction((tx) => repository.insertTurn(tx, sibling));
        expect(() =>
            storage.transaction((tx) => {
                storage.insert(tx, row("commit-rollback"));
                storage.insertParent(tx, { commit: "commit-rollback", ordinal: 0, parent: "root" });
                repository.replaceTurn(tx, sibling.revision, sibling.forceCancel());
                repository.insertForcedCancellation(tx, cancellation);
                throw new Error("fault");
            })
        ).toThrow("fault");
        expect(
            storage.transaction((tx) => storage.get(tx, "commit", "commit-rollback"))
        ).toBeUndefined();
        expect(storage.transaction((tx) => storage.parents(tx, "commit-rollback"))).toEqual([]);
        expect(repository.transaction((tx) => repository.loadTurn(tx, sibling.id))).toEqual(
            sibling
        );
        expect(
            repository.transaction((tx) => repository.loadForcedCancellation(tx, sibling.id))
        ).toBeUndefined();
    });

    it("fails closed for unmarked protected state", () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE agent_run_unmarked (id TEXT) STRICT", []);
        expect(() => new SqliteRunStorage(database, owner)).toThrow(/Unmarked/);
        const rows = database.all(
            "SELECT name FROM sqlite_schema WHERE name = 'agent_run_unmarked'",
            []
        );
        expect(rows).toHaveLength(1);
    });

    it("rejects malformed records, kinds, and parent projections with codec.invalid", () => {
        const storage = new SqliteRunStorage(new TestSqlite(), owner);
        const malformed = [
            row(""),
            row("bad-revision", -1),
            { ...row("bad-bytes"), bytes: "bad" as never },
            { ...row("bad-kind"), kind: "unknown" as never }
        ];
        for (const record of malformed) {
            expect(() => storage.transaction((tx) => storage.insert(tx, record))).toThrow(
                /Stored Run record/
            );
        }
        for (const edge of [
            { commit: "", ordinal: 0, parent: "root" },
            { commit: "commit", ordinal: 2, parent: "root" },
            { commit: "commit", ordinal: 0, parent: "" }
        ]) {
            expect(() => storage.transaction((tx) => storage.insertParent(tx, edge))).toThrow(
                /parent edge/
            );
        }
    });

    it("rejects incomplete, extra, and empty-marker schemas", () => {
        const incomplete = new TestSqlite();
        incomplete.run(
            `CREATE TABLE agent_run_storage_schema (
            version INTEGER PRIMARY KEY,
            owner_kind TEXT NOT NULL,
            owner_id TEXT NOT NULL
        ) STRICT`,
            []
        );
        incomplete.run(
            "INSERT INTO agent_run_storage_schema (version, owner_kind, owner_id) VALUES (1, 'workspace', 'workspace-run-owner')",
            []
        );
        expect(() => new SqliteRunStorage(incomplete, owner)).toThrow(/incomplete/);

        const extra = new TestSqlite();
        new SqliteRunStorage(extra, owner);
        extra.run("CREATE TABLE agent_run_extra (id TEXT) STRICT", []);
        expect(() => new SqliteRunStorage(extra, owner)).toThrow(/unexpected/);

        const emptyMarker = new TestSqlite();
        new SqliteRunStorage(emptyMarker, owner);
        emptyMarker.run("DELETE FROM agent_run_storage_schema", []);
        expect(() => new SqliteRunStorage(emptyMarker, owner)).toThrow(/version or owner/);
    });

    it("rejects same-named unconstrained replacement objects", () => {
        const database = new TestSqlite();
        database.run(
            "CREATE TABLE agent_run_storage_schema (version INTEGER, owner_kind TEXT, owner_id TEXT)",
            []
        );
        database.run(
            "CREATE TABLE agent_run_records (kind TEXT, record_key TEXT, revision INTEGER, record BLOB)",
            []
        );
        database.run(
            "CREATE TABLE agent_run_commit_parents (commit_id TEXT, ordinal INTEGER, parent_id TEXT)",
            []
        );
        database.run(
            "CREATE INDEX agent_run_commit_parent_reverse ON agent_run_commit_parents (parent_id, commit_id)",
            []
        );
        database.run(
            "INSERT INTO agent_run_storage_schema (version, owner_kind, owner_id) VALUES (1, 'workspace', 'workspace-run-owner')",
            []
        );
        expect(() => new SqliteRunStorage(database, owner)).toThrow(/exact schema/);
    });

    it("rejects duplicated and corrupt rows returned by the SQLite substrate", () => {
        const base = new TestSqlite();
        const database = new MutatingSqlite(base);
        const storage = new SqliteRunStorage(database, owner);
        storage.transaction((tx) => storage.insert(tx, row("duplicate")));
        database.mutate = (statement, rows) =>
            statement.includes("WHERE kind = ? AND record_key = ?") && rows.length === 1
                ? [rows[0]!, rows[0]!]
                : rows;
        expect(() => storage.transaction((tx) => storage.get(tx, "commit", "duplicate"))).toThrow(
            /multiple rows/
        );

        database.mutate = (statement, rows) =>
            statement.includes("WHERE kind = ? ORDER BY record_key")
                ? rows.map((value) => ({ ...value, record_key: "" }))
                : rows;
        expect(() => storage.transaction((tx) => storage.list(tx, "commit"))).toThrow(/record_key/);
    });

    it("[run.forced-turn-cancellation] survives file-backed close and reopen with owner and bytes intact", () => {
        const directory = mkdtempSync(join(tmpdir(), "w5-run-sqlite-"));
        const path = join(directory, "run.sqlite");
        try {
            const firstDatabase = new FileSqlite(path);
            const first = new SqliteRunStorage(firstDatabase, owner);
            const run = new RunId("restart-run");
            const repository = new RunRepository(first);
            const reserved = RunAdmissionRegistry.initial(run).reserve({
                kind: "invocationItem",
                invocation: new InvocationId("restart-invocation"),
                itemIndex: 0,
                itemKey: "restart-item"
            });
            const cancellation = new ForcedTurnCancellation({
                run,
                terminalTurn: new TurnId("restart-terminal-turn"),
                turn: new TurnId("restart-sibling-turn"),
                priorLeaseEpoch: 2,
                fencedLeaseEpoch: 3,
                controlReceipt: new ReceiptId("restart-control-receipt"),
                controlAudit: new AuditRecordId("restart-control-audit"),
                cancellationEvent: new EventId("restart-cancellation-event"),
                cancellationAudit: new AuditRecordId("restart-cancellation-audit")
            });
            first.transaction((tx) => {
                first.insert(tx, row("restart", 0));
                first.insertParent(tx, { commit: "restart", ordinal: 0, parent: "root" });
                repository.insertAdmission(tx, reserved.registry);
                repository.insertForcedCancellation(tx, cancellation);
            });
            firstDatabase.close();

            const secondDatabase = new FileSqlite(path);
            const second = new SqliteRunStorage(secondDatabase, owner);
            const restartedRepository = new RunRepository(second);
            expect(second.transaction((tx) => second.get(tx, "commit", "restart"))?.revision).toBe(
                0
            );
            expect(second.transaction((tx) => second.parents(tx, "restart"))[0]?.parent).toBe(
                "root"
            );
            expect(
                restartedRepository.transaction((tx) =>
                    restartedRepository.loadAdmission(tx, run)?.frontier()
                )
            ).toEqual([reserved.reservation.obligation]);
            expect(
                restartedRepository.transaction((tx) =>
                    restartedRepository.loadForcedCancellation(tx, cancellation.turn)
                )
            ).toEqual(cancellation);
            secondDatabase.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("[C13-RUN-ADMISSION-REGISTRY] memory and SQLite durably reserve, complete, close, restart, and reject stale epoch and CAS", () => {
        assertAcrossRunStorages(assertAdmissionRegistryBehavior);
    });

    it("[C13-RUN-FORCED-CANCELLATION] memory and SQLite require exact administer evidence and CAS before persisting a sibling fence across restart", () => {
        assertAcrossRunStorages(assertForcedCancellationBehavior);
    });

    it("[C13-RUN-PINS-IMMUTABLE] memory and SQLite preserve immutable lifetime pins across caller mutation and restart", () => {
        assertAcrossRunStorages(assertRunPinsImmutabilityBehavior);
    });

    it("[C13-TURN-CHECKPOINT-WRITER] memory and SQLite admit only the exact live checkpoint writer across restart and CAS", () => {
        assertAcrossRunStorages(assertCheckpointWriterBehavior);
    });

    it("[C13-TURN-EXACT-LEASE] memory and SQLite admit only the exact durable Turn lease across restart, CAS, and terminal fencing", () => {
        assertAcrossRunStorages(assertExactLeaseBehavior);
    });

    it("[C13-TURN-TERMINAL-RESULT-WRITER] memory and SQLite admit only the exact live terminal result writer and reject reuse", () => {
        assertAcrossRunStorages(assertTerminalResultWriterBehavior);
    });
});

interface RuntimeHarness<Transaction> {
    readonly repository: RunRepository<Transaction>;
    readonly evidence: TestEvidencePort<Transaction>;
    readonly runtime: RunRuntime<Transaction>;
}

interface RunningHarness<Transaction> extends RuntimeHarness<Transaction> {
    readonly running: Turn;
    readonly token: LeaseToken;
}

function runtimeHarness<Transaction>(
    storage: RunStoragePort<Transaction>
): RuntimeHarness<Transaction> {
    const repository = new RunRepository(storage);
    const evidence = new TestEvidencePort<Transaction>();
    return {
        repository,
        evidence,
        runtime: new RunRuntime<Transaction>(
            repository,
            new TestSourcePort<Transaction>(),
            evidence,
            new TestSettlementPort<Transaction>(),
            new TestSpawnPort<Transaction>(),
            new TestMergePort<Transaction>()
        )
    };
}

function assertAcrossRunStorages(
    assertion: <Transaction>(
        value: RuntimeHarness<Transaction>,
        restart: () => RuntimeHarness<Transaction>
    ) => void
): void {
    const memory = new MemoryRunStorage();
    assertion(runtimeHarness(memory), () =>
        runtimeHarness(new MemoryRunStorage(memory.snapshot()))
    );

    const directory = mkdtempSync(join(tmpdir(), "w5-run-behavior-"));
    const path = join(directory, "run.sqlite");
    let database = new FileSqlite(path);
    try {
        assertion(runtimeHarness(new SqliteRunStorage(database, ids.actor)), () => {
            database.close();
            database = new FileSqlite(path);
            return runtimeHarness(new SqliteRunStorage(database, ids.actor));
        });
    } finally {
        database.close();
        rmSync(directory, { recursive: true, force: true });
    }
}

function seedRunning<Transaction>(value: RuntimeHarness<Transaction>): RunningHarness<Transaction> {
    value.runtime.createRun(genesis());
    const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
    value.runtime.createTurn(
        {
            turn: new Turn({
                id: ids.turn,
                run: ids.run,
                branch: ids.branch,
                startHead: ids.root,
                effectiveInput: ids.root,
                pins: pins(),
                placement: placement.digest,
                input: content("a"),
                revision: new Revision(0)
            }),
            placement
        },
        new Revision(0)
    );
    const running = value.runtime.claimTurn(
        ids.turn,
        new Revision(0),
        ids.holder,
        new Date(1000),
        new Date(5000)
    );
    return {
        ...value,
        running,
        token: Object.freeze({ turn: ids.turn, holder: ids.holder, epoch: running.lease.epoch })
    };
}

function resultCommit(id: string, token: LeaseToken, parent: RunCommitId = ids.root): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "result",
        parents: [parent],
        pins: pins(),
        writer: { kind: "turn", token },
        subjectTurn: ids.turn,
        content: content("b")
    });
}

function checkpointCommit(id: string, token: LeaseToken, parent: RunCommitId): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "checkpoint",
        parents: [parent],
        pins: pins(),
        writer: { kind: "turn", token },
        subjectTurn: ids.turn,
        content: content("c")
    });
}

function assertAdmissionRegistryBehavior<Transaction>(
    value: RuntimeHarness<Transaction>,
    restart: () => RuntimeHarness<Transaction>
): void {
    const running = seedRunning(value);
    const initial = value.repository.transaction((tx) =>
        value.repository.loadAdmission(tx, ids.run)
    )!;
    const completed = value.runtime.reserveRunObligation(ids.run, {
        kind: "approval",
        approval: new ApprovalId("admission-completed")
    });
    value.runtime.completeRunObligation(completed);
    const pending = value.runtime.reserveRunObligation(ids.run, {
        kind: "invocationItem",
        invocation: new InvocationId("admission-pending"),
        itemIndex: 0,
        itemKey: "pending-item"
    });
    const staleReplacement = initial.reserve({
        kind: "systemCommit",
        commit: new RunCommitId("stale-admission")
    }).registry;
    expectCode(
        () =>
            value.repository.transaction((tx) =>
                value.repository.replaceAdmission(tx, initial, staleReplacement)
            ),
        "protocol.revision-conflict"
    );

    const terminal = resultCommit("admission-terminal-result", running.token);
    value.runtime.terminalizeRun({
        run: ids.run,
        turn: ids.turn,
        expectedRunRevision: value.repository.transaction(
            (tx) => value.repository.loadRun(tx, ids.run)!.revision
        ),
        expectedTurnRevision: running.running.revision,
        expectedBranchRevision: new Revision(0),
        token: running.token,
        outcome: "succeeded",
        commit: terminal,
        siblingCancellations: new Map(),
        now: new Date(1500)
    });

    const restored = restart();
    const registry = restored.repository.transaction((tx) =>
        restored.repository.loadAdmission(tx, ids.run)
    )!;
    expect(registry.accepting).toBe(false);
    expect(registry.epoch).toBe(1);
    expect(registry.frontier()).toEqual([pending.obligation]);
    const staleEpoch = { ...pending, registryEpoch: pending.registryEpoch + 1 };
    expect(restored.runtime.acceptsRunAdmission(staleEpoch)).toBe(false);
    expectCode(() => restored.runtime.completeRunObligation(staleEpoch), "run.invalid-state");
    restored.runtime.completeRunObligation(completed);
    restored.runtime.completeRunObligation(pending);
    expect(
        restored.repository.transaction(
            (tx) => restored.repository.loadAdmission(tx, ids.run)!.frontier().length
        )
    ).toBe(0);
}

function assertForcedCancellationBehavior<Transaction>(
    value: RuntimeHarness<Transaction>,
    restart: () => RuntimeHarness<Transaction>
): void {
    const running = seedRunning(value);
    const siblingId = new TurnId("forced-behavior-sibling");
    const placement = new TurnPlacementSnapshot(siblingId, pins(), []);
    value.runtime.createTurn(
        {
            turn: new Turn({
                id: siblingId,
                run: ids.run,
                branch: ids.branch,
                startHead: ids.root,
                effectiveInput: ids.root,
                pins: pins(),
                placement: placement.digest,
                input: content("d"),
                revision: new Revision(0)
            }),
            placement
        },
        new Revision(0)
    );
    const sibling = value.runtime.claimTurn(
        siblingId,
        new Revision(0),
        ids.holder,
        new Date(1000),
        new Date(5000)
    );
    const receipt = new ReceiptId("forced-behavior-control-receipt");
    const controlAudit = new AuditRecordId("forced-behavior-control-audit");
    const event = new EventId("forced-behavior-event");
    const cancellationAudit = new AuditRecordId("forced-behavior-cancellation-audit");
    value.evidence.cancellations.set(`${event.value}:${cancellationAudit.value}`, {
        kind: "turnCancellation",
        eventKind: "turn.cancel",
        run: ids.run,
        terminalTurn: ids.turn,
        turn: siblingId,
        priorLeaseEpoch: sibling.lease.epoch,
        fencedLeaseEpoch: sibling.lease.epoch + 1,
        inboxLeaseEpoch: sibling.lease.epoch,
        controlReceipt: receipt,
        controlAudit,
        event,
        audit: cancellationAudit
    });
    const request = {
        run: ids.run,
        turn: ids.turn,
        expectedRunRevision: value.repository.transaction(
            (tx) => value.repository.loadRun(tx, ids.run)!.revision
        ),
        expectedTurnRevision: running.running.revision,
        expectedBranchRevision: new Revision(0),
        token: running.token,
        outcome: "failed" as const,
        commit: resultCommit("forced-behavior-result", running.token),
        forcedCancellationControl: { receipt, audit: controlAudit },
        siblingCancellations: new Map([[siblingId.value, { event, audit: cancellationAudit }]]),
        now: new Date(1500)
    };
    expectCode(() => value.runtime.terminalizeRun(request), "authority.denied");
    expect(
        value.repository.transaction((tx) => value.repository.loadTurn(tx, siblingId)!.status.kind)
    ).toBe("running");
    expect(
        value.repository.transaction((tx) => value.repository.loadCommit(tx, request.commit.id))
    ).toBeUndefined();

    value.evidence.administers.set(`${receipt.value}:${controlAudit.value}`, {
        kind: "administer",
        run: ids.run,
        terminalTurn: ids.turn,
        receipt,
        audit: controlAudit,
        outcome: "succeeded"
    });
    expectCode(
        () =>
            value.runtime.terminalizeRun({
                ...request,
                expectedTurnRevision: new Revision(0)
            }),
        "protocol.revision-conflict"
    );
    expect(
        value.repository.transaction((tx) => value.repository.loadForcedCancellation(tx, siblingId))
    ).toBeUndefined();
    expect(
        value.repository.transaction((tx) => value.repository.loadTurn(tx, siblingId)!.status.kind)
    ).toBe("running");
    expect(
        value.repository.transaction((tx) => value.repository.loadCommit(tx, request.commit.id))
    ).toBeUndefined();

    value.runtime.terminalizeRun(request);
    const restored = restart();
    const cancellation = restored.repository.transaction((tx) =>
        restored.repository.loadForcedCancellation(tx, siblingId)
    )!;
    expect(cancellation.controlReceipt.equals(receipt)).toBe(true);
    expect(cancellation.controlAudit.equals(controlAudit)).toBe(true);
    expect(cancellation.priorLeaseEpoch).toBe(1);
    expect(cancellation.fencedLeaseEpoch).toBe(2);
    expect(
        restored.repository
            .transaction((tx) => restored.repository.listCommits(tx))
            .some((commit) => commit.subjectTurn?.equals(siblingId))
    ).toBe(false);
}

function assertRunPinsImmutabilityBehavior<Transaction>(
    value: RuntimeHarness<Transaction>,
    restart: () => RuntimeHarness<Transaction>
): void {
    const original = pins();
    const packages = [...original.packages];
    const agent = { ...original.agent };
    const immutable = new RunPins({ ...original, packages, agent });
    const expectedDigest = immutable.digest.value;
    packages.splice(0, packages.length);
    agent.revision = agent.revision.next();
    expect(immutable.packages).toHaveLength(2);
    expect(immutable.agent.revision.value).toBe(3);
    expect(() => (immutable.packages as typeof packages).pop()).toThrow(TypeError);
    expect(Object.isFrozen(immutable.agent)).toBe(true);

    const snapshot = new RunConfigurationSnapshot({ pins: immutable });
    const root = new RunCommit({
        id: ids.root,
        run: ids.run,
        branch: ids.branch,
        kind: "root",
        parents: [],
        pins: immutable,
        writer: { kind: "root" },
        content: content("4")
    });
    value.runtime.createRun({
        run: new Run({
            id: ids.run,
            agent: ids.agent,
            configuration: snapshot.id,
            root: ids.root,
            initialBranch: ids.branch,
            revision: new Revision(0)
        }),
        configuration: snapshot,
        branch: new RunBranch(ids.branch, ids.run, "main", ids.root, new Revision(0)),
        root
    });
    const restored = restart();
    const restoredPins = restored.repository.transaction(
        (tx) => restored.repository.loadCommit(tx, ids.root)!.pins
    );
    expect(restoredPins.digest.value).toBe(expectedDigest);
    expect(restoredPins.equals(immutable)).toBe(true);
    expect(Object.isFrozen(restoredPins.packages)).toBe(true);
}

function assertCheckpointWriterBehavior<Transaction>(
    value: RuntimeHarness<Transaction>,
    restart: () => RuntimeHarness<Transaction>
): void {
    const running = seedRunning(value);
    const invalidTokens: readonly LeaseToken[] = [
        { ...running.token, turn: new TurnId("checkpoint-wrong-turn") },
        { ...running.token, holder: new PrincipalId("checkpoint-wrong-holder") },
        { ...running.token, epoch: running.token.epoch - 1 }
    ];
    invalidTokens.forEach((token, index) => {
        const commit = checkpointCommit(`rejected-checkpoint-${index}`, token, ids.root);
        expect(() =>
            value.runtime.suspendTurn({
                turn: ids.turn,
                expectedTurnRevision: running.running.revision,
                expectedBranchRevision: new Revision(0),
                token,
                checkpoint: new RunCheckpoint(
                    new RunCheckpointId(`rejected-checkpoint-state-${index}`),
                    ids.turn,
                    commit.id,
                    commit.content!,
                    0,
                    undefined
                ),
                commit,
                now: new Date(1500)
            })
        ).toThrow(AgentCoreError);
        expect(
            value.repository.transaction((tx) => value.repository.loadCommit(tx, commit.id))
        ).toBeUndefined();
    });
    const expired = checkpointCommit("expired-checkpoint", running.token, ids.root);
    expect(() =>
        value.runtime.suspendTurn({
            turn: ids.turn,
            expectedTurnRevision: running.running.revision,
            expectedBranchRevision: new Revision(0),
            token: running.token,
            checkpoint: new RunCheckpoint(
                new RunCheckpointId("expired-checkpoint-state"),
                ids.turn,
                expired.id,
                expired.content!,
                0,
                undefined
            ),
            commit: expired,
            now: new Date(5000)
        })
    ).toThrow(AgentCoreError);
    const staleCas = checkpointCommit("stale-cas-checkpoint", running.token, ids.root);
    expectCode(
        () =>
            value.runtime.suspendTurn({
                turn: ids.turn,
                expectedTurnRevision: new Revision(0),
                expectedBranchRevision: new Revision(0),
                token: running.token,
                checkpoint: new RunCheckpoint(
                    new RunCheckpointId("stale-cas-checkpoint-state"),
                    ids.turn,
                    staleCas.id,
                    staleCas.content!,
                    0,
                    undefined
                ),
                commit: staleCas,
                now: new Date(1500)
            }),
        "protocol.revision-conflict"
    );

    const commit = checkpointCommit("durable-checkpoint", running.token, ids.root);
    const checkpoint = new RunCheckpoint(
        new RunCheckpointId("durable-checkpoint-state"),
        ids.turn,
        commit.id,
        commit.content!,
        0,
        undefined
    );
    value.runtime.suspendTurn({
        turn: ids.turn,
        expectedTurnRevision: running.running.revision,
        expectedBranchRevision: new Revision(0),
        token: running.token,
        checkpoint,
        commit,
        now: new Date(1500)
    });
    const restored = restart();
    expect(
        restored.repository.transaction((tx) =>
            restored.repository.loadCheckpoint(tx, checkpoint.id)
        )
    ).toEqual(checkpoint);
    const suspended = restored.repository.transaction((tx) =>
        restored.repository.loadTurn(tx, ids.turn)
    )!;
    expect(suspended.status.kind).toBe("suspended");

    const resumed = restored.runtime.claimTurn(
        ids.turn,
        suspended.revision,
        ids.holder,
        new Date(1600),
        new Date(5000)
    );
    const resumedToken = {
        turn: ids.turn,
        holder: ids.holder,
        epoch: resumed.lease.epoch
    };
    const result = resultCommit("checkpoint-terminal-result", resumedToken, commit.id);
    restored.runtime.completeTurn({
        turn: ids.turn,
        expectedTurnRevision: resumed.revision,
        expectedBranchRevision: new Revision(1),
        token: resumedToken,
        outcome: "succeeded",
        commit: result,
        now: new Date(1700)
    });
    const terminal = restored.repository.transaction((tx) =>
        restored.repository.loadTurn(tx, ids.turn)
    )!;
    const rejected = checkpointCommit("terminal-checkpoint", resumedToken, result.id);
    expect(() =>
        restored.runtime.suspendTurn({
            turn: ids.turn,
            expectedTurnRevision: terminal.revision,
            expectedBranchRevision: new Revision(2),
            token: resumedToken,
            checkpoint: new RunCheckpoint(
                new RunCheckpointId("terminal-checkpoint-state"),
                ids.turn,
                rejected.id,
                rejected.content!,
                0,
                undefined
            ),
            commit: rejected,
            now: new Date(1800)
        })
    ).toThrow(AgentCoreError);
}

function assertExactLeaseBehavior<Transaction>(
    value: RuntimeHarness<Transaction>,
    restart: () => RuntimeHarness<Transaction>
): void {
    const running = seedRunning(value);
    expectCode(
        () =>
            value.runtime.renewTurn(
                ids.turn,
                new Revision(0),
                running.token,
                new Date(1500),
                new Date(6000)
            ),
        "protocol.revision-conflict"
    );
    const restored = restart();
    const verifier = new RepositoryTurnLeaseVerifier(restored.repository, () => new Date(1500));
    expect(verifier.permits(running.token)).toBe(true);
    expect(verifier.permits({ ...running.token, turn: new TurnId("lease-wrong-turn") })).toBe(
        false
    );
    expect(
        verifier.permits({ ...running.token, holder: new PrincipalId("lease-wrong-holder") })
    ).toBe(false);
    expect(verifier.permits({ ...running.token, epoch: running.token.epoch - 1 })).toBe(false);
    expect(
        new RepositoryTurnLeaseVerifier(restored.repository, () => new Date(5000)).permits(
            running.token
        )
    ).toBe(false);

    const result = resultCommit("lease-terminal-result", running.token);
    restored.runtime.completeTurn({
        turn: ids.turn,
        expectedTurnRevision: running.running.revision,
        expectedBranchRevision: new Revision(0),
        token: running.token,
        outcome: "succeeded",
        commit: result,
        now: new Date(1500)
    });
    expect(verifier.permits(running.token)).toBe(false);
}

function assertTerminalResultWriterBehavior<Transaction>(
    value: RuntimeHarness<Transaction>,
    restart: () => RuntimeHarness<Transaction>
): void {
    const running = seedRunning(value);
    const invalidTokens: readonly LeaseToken[] = [
        { ...running.token, turn: new TurnId("result-wrong-turn") },
        { ...running.token, holder: new PrincipalId("result-wrong-holder") },
        { ...running.token, epoch: running.token.epoch - 1 }
    ];
    invalidTokens.forEach((token, index) => {
        const commit = resultCommit(`rejected-terminal-result-${index}`, token);
        expect(() =>
            value.runtime.completeTurn({
                turn: ids.turn,
                expectedTurnRevision: running.running.revision,
                expectedBranchRevision: new Revision(0),
                token,
                outcome: "failed",
                commit,
                now: new Date(1500)
            })
        ).toThrow(AgentCoreError);
        expect(
            value.repository.transaction((tx) => value.repository.loadCommit(tx, commit.id))
        ).toBeUndefined();
    });
    const expired = resultCommit("expired-terminal-result", running.token);
    expect(() =>
        value.runtime.completeTurn({
            turn: ids.turn,
            expectedTurnRevision: running.running.revision,
            expectedBranchRevision: new Revision(0),
            token: running.token,
            outcome: "failed",
            commit: expired,
            now: new Date(5000)
        })
    ).toThrow(AgentCoreError);
    const staleCas = resultCommit("stale-cas-terminal-result", running.token);
    expectCode(
        () =>
            value.runtime.completeTurn({
                turn: ids.turn,
                expectedTurnRevision: new Revision(0),
                expectedBranchRevision: new Revision(0),
                token: running.token,
                outcome: "failed",
                commit: staleCas,
                now: new Date(1500)
            }),
        "protocol.revision-conflict"
    );

    const result = resultCommit("durable-terminal-result", running.token);
    value.runtime.completeTurn({
        turn: ids.turn,
        expectedTurnRevision: running.running.revision,
        expectedBranchRevision: new Revision(0),
        token: running.token,
        outcome: "succeeded",
        commit: result,
        now: new Date(1500)
    });
    const restored = restart();
    const terminal = restored.repository.transaction((tx) =>
        restored.repository.loadTurn(tx, ids.turn)
    )!;
    expect(terminal.status.kind).toBe("succeeded");
    expect(terminal.result?.equals(result.content!)).toBe(true);
    expect(
        restored.repository.transaction((tx) => restored.repository.loadCommit(tx, result.id))
    ).toEqual(result);

    const reused = resultCommit("reused-terminal-result", running.token, result.id);
    expect(() =>
        restored.runtime.completeTurn({
            turn: ids.turn,
            expectedTurnRevision: terminal.revision,
            expectedBranchRevision: new Revision(1),
            token: running.token,
            outcome: "succeeded",
            commit: reused,
            now: new Date(1600)
        })
    ).toThrow(AgentCoreError);
    expect(
        restored.repository.transaction((tx) => restored.repository.loadCommit(tx, reused.id))
    ).toBeUndefined();
}

function expectCode(operation: () => unknown, code: AgentCoreError["code"]): void {
    try {
        operation();
        throw new TypeError("Expected operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
    }
}

function assertStorageContract<Transaction>(storage: RunStoragePort<Transaction>): void {
    storage.transaction((transaction) => {
        storage.insert(transaction, row("shared", 0));
        storage.insert(transaction, row("shared", 0));
        storage.insertParent(transaction, { commit: "shared", ordinal: 0, parent: "root" });
    });
    expect(storage.transaction((transaction) => storage.list(transaction, "commit"))).toHaveLength(
        1
    );
    expect(storage.transaction((transaction) => storage.parents(transaction, "shared"))).toEqual([
        { commit: "shared", ordinal: 0, parent: "root" }
    ]);
    expect(() =>
        storage.transaction((transaction) => {
            storage.insert(transaction, row("rolled-back"));
            throw new TypeError("rollback");
        })
    ).toThrow(/rollback/);
    expect(
        storage.transaction((transaction) => storage.get(transaction, "commit", "rolled-back"))
    ).toBeUndefined();
}

function sqliteRuntime(database: TransactionalSqlite): RuntimeHarness<TransactionalSqlite> {
    const repository = new RunRepository(new SqliteRunStorage(database, ids.actor));
    const evidence = new TestEvidencePort<TransactionalSqlite>();
    return {
        repository,
        evidence,
        runtime: new RunRuntime<TransactionalSqlite>(
            repository,
            new TestSourcePort<TransactionalSqlite>(),
            evidence,
            new TestSettlementPort<TransactionalSqlite>(),
            new TestSpawnPort<TransactionalSqlite>(),
            new TestMergePort<TransactionalSqlite>()
        )
    };
}

function createPinnedTurn(
    runtime: RunRuntime<TransactionalSqlite>,
    id: TurnId,
    branch: RunBranchId,
    head: RunCommitId,
    turnPins: RunPins,
    expectedBranchRevision: number
): void {
    const placement = new TurnPlacementSnapshot(id, turnPins, []);
    runtime.createTurn(
        {
            turn: new Turn({
                id,
                run: ids.run,
                branch,
                startHead: head,
                effectiveInput: head,
                pins: turnPins,
                placement: placement.digest,
                input: content("7"),
                revision: new Revision(0)
            }),
            placement
        },
        new Revision(expectedBranchRevision)
    );
}

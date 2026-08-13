import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorId, Revision } from "@agent-core/core";
import {
    RunCommit,
    RunCommitId,
    RunConfigurationSnapshot,
    RunId,
    RunPins,
    type RunRecordKind
} from "@agent-core/core/agents/runs";
import {
    CloudflareRunHosting,
    CloudflareSqlite,
    DurableObjectRunStorage,
    SqliteApplicationMigrator,
    SqliteRunHostingIndex,
    cloudflareRuntimeMigrations,
    runHostingMigration,
    type RunHostingMode,
    type SqliteRow,
    type SqliteValue
} from "../src/index.js";
import { expectOperationalFailure, malformedInput } from "./assertions.js";
import { NodeDurableObjectStorage } from "./node-sqlite.js";
import {
    errors,
    genesis,
    ids,
    pins,
    resultCommit,
    runHarness,
    seedRunningTurn,
    TestSettlementPort
} from "./run-fixture.js";

const HOSTING_MIGRATIONS = [...cloudflareRuntimeMigrations, runHostingMigration(3)];
const READ_RUN_OBJECTS = "SELECT name FROM sqlite_schema WHERE name LIKE 'agent_run_%' ORDER BY name";

/**
 * The Workspace object and a Run object of its own, each with private storage, exactly as
 * the profile hosts them. Which one owns the Run is the hosting decision under test, so
 * both are always present and only the pin decides where the records land.
 */
class HostedWorkspace {
    readonly #directory: string;
    #workspaceStorage: NodeDurableObjectStorage;
    #runStorage: NodeDurableObjectStorage;

    public constructor() {
        this.#directory = mkdtempSync(join(tmpdir(), "cloudflare-run-hosting-"));
        this.#workspaceStorage = new NodeDurableObjectStorage(this.workspacePath);
        this.#runStorage = new NodeDurableObjectStorage(this.runPath);
        this.migrateWorkspace();
    }

    public get workspacePath(): string {
        return join(this.#directory, "workspace.sqlite");
    }

    public get runPath(): string {
        return join(this.#directory, "run.sqlite");
    }

    public get workspace(): CloudflareSqlite {
        return new CloudflareSqlite(this.#workspaceStorage, errors);
    }

    public get index(): SqliteRunHostingIndex {
        return new SqliteRunHostingIndex(this.workspace, errors);
    }

    public objectDatabase(hosting: CloudflareRunHosting): CloudflareSqlite {
        return hosting.mode === "dedicated"
            ? new CloudflareSqlite(this.#runStorage, errors)
            : this.workspace;
    }

    /** The object that must hold no Run records under this hosting. */
    public otherDatabase(hosting: CloudflareRunHosting): CloudflareSqlite {
        return hosting.mode === "dedicated"
            ? this.workspace
            : new CloudflareSqlite(this.#runStorage, errors);
    }

    /** Closes both objects and reopens them from disk, as an evicted object restarts. */
    public restart(): void {
        this.#workspaceStorage.close();
        this.#runStorage.close();
        this.#workspaceStorage = new NodeDurableObjectStorage(this.workspacePath);
        this.#runStorage = new NodeDurableObjectStorage(this.runPath);
    }

    public dispose(): void {
        this.#workspaceStorage.close();
        this.#runStorage.close();
        rmSync(this.#directory, { recursive: true, force: true });
    }

    private migrateWorkspace(): void {
        new SqliteApplicationMigrator(this.workspace, errors, HOSTING_MIGRATIONS).migrate();
    }
}

function runObjectNames(database: CloudflareSqlite): readonly unknown[] {
    return database.all(READ_RUN_OBJECTS, []).map((row) => row["name"]);
}

/** A Durable Object SQLite that returns rows its own schema could never produce. */
class MutatingSqlite extends CloudflareSqlite {
    public mutate: (statement: string, rows: readonly SqliteRow[]) => readonly SqliteRow[] = (
        _statement,
        rows
    ) => rows;

    public override all(
        statement: string,
        bindings: readonly SqliteValue[]
    ): readonly SqliteRow[] {
        return this.mutate(statement, super.all(statement, bindings));
    }
}

const HOSTINGS: readonly { readonly name: string; readonly mode: RunHostingMode }[] = [
    { name: "Workspace-owned by default", mode: "workspace" },
    { name: "pinned dedicated at start", mode: "dedicated" }
];

describe.each(HOSTINGS)("Cloudflare Run hosting, $name", ({ mode }) => {
    const other: RunHostingMode = mode === "workspace" ? "dedicated" : "workspace";

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] its owner retains RunPins, the active and terminal " +
            "outcome, the commit graph, and the derived Settled obligations across a restart",
        { tags: "p0" },
        () => {
            const objects = new HostedWorkspace();
            try {
                const hosting = objects.index.start(
                    new CloudflareRunHosting(ids.run, ids.workspace, mode)
                );
                const store = new DurableObjectRunStorage(
                    objects.objectDatabase(hosting),
                    hosting,
                    errors
                );
                const harness = runHarness(store);
                const { running, token } = seedRunningTurn(harness);

                expect(store.owner.kind).toBe(mode === "workspace" ? "workspace" : "run");
                expect(store.owner.id.value).toBe(
                    mode === "workspace" ? ids.workspace.value : ids.run.value
                );
                // Ownership is physical: only the owning object carries Run records.
                expect(runObjectNames(objects.objectDatabase(hosting))).toEqual([
                    "agent_run_commit_parent_reverse",
                    "agent_run_commit_parents",
                    "agent_run_records",
                    "agent_run_storage_schema"
                ]);
                expect(runObjectNames(objects.otherDatabase(hosting))).toEqual([]);
                expect(
                    harness.repository.transaction((tx) =>
                        harness.repository.loadRun(tx, ids.run)
                    )?.lifecycle.kind
                ).toBe("active");

                const reservation = harness.runtime.reserveRunObligation(ids.run, {
                    kind: "approval",
                    approval: ids.approval
                });
                const terminal = resultCommit("hosting-terminal-result", token);
                harness.runtime.terminalizeRun({
                    run: ids.run,
                    turn: ids.turn,
                    expectedRunRevision: harness.repository.transaction(
                        (tx) => harness.repository.loadRun(tx, ids.run)!.revision
                    ),
                    expectedTurnRevision: running.revision,
                    expectedBranchRevision: new Revision(0),
                    token,
                    outcome: "succeeded",
                    commit: terminal,
                    siblingCancellations: new Map(),
                    now: new Date(1500)
                });

                objects.restart();
                const restarted = objects.index.get(ids.run);
                expect(restarted?.equals(hosting)).toBe(true);
                const settlement = new TestSettlementPort();
                const reopened = runHarness(
                    new DurableObjectRunStorage(
                        objects.objectDatabase(restarted!),
                        restarted!,
                        errors
                    ),
                    settlement
                );
                const record = reopened.repository.transaction((tx) => ({
                    run: reopened.repository.loadRun(tx, ids.run)!,
                    configuration: reopened.repository.loadConfiguration(
                        tx,
                        genesis().configuration.id.value
                    )!,
                    root: reopened.repository.loadCommit(tx, ids.root)!,
                    result: reopened.repository.loadCommit(tx, terminal.id)!,
                    parents: reopened.storage.parents(tx, terminal.id.value),
                    ancestral: reopened.repository.isAncestor(tx, ids.root, terminal.id)
                }));

                // RunPins.
                expect(record.configuration.pins.equals(pins())).toBe(true);
                expect(record.root.pins.digest.value).toBe(pins().digest.value);
                expect(record.result.pins.equals(pins())).toBe(true);
                // Active and terminal outcome.
                expect(record.run.lifecycle.kind).toBe("terminal");
                expect(record.run.terminal?.outcome).toBe("succeeded");
                expect(record.run.terminal?.terminalCommit.equals(terminal.id)).toBe(true);
                // The commit graph.
                expect(record.parents).toEqual([
                    { commit: terminal.id.value, ordinal: 0, parent: ids.root.value }
                ]);
                expect(record.ancestral).toBe(true);
                // The derived Settled obligations.
                expect(record.run.terminal?.obligation.obligations).toEqual([
                    reservation.obligation
                ]);
                expect(reopened.runtime.settled(ids.run)).toBe(false);
                settlement.approvals.add(ids.approval.value);
                expect(reopened.runtime.settled(ids.run)).toBe(true);
            } finally {
                objects.dispose();
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] its owner is the only one that opens the Run store",
        { tags: "p0" },
        () => {
            const objects = new HostedWorkspace();
            try {
                const hosting = objects.index.start(
                    new CloudflareRunHosting(ids.run, ids.workspace, mode)
                );
                const database = objects.objectDatabase(hosting);
                const store = new DurableObjectRunStorage(database, hosting, errors);
                runHarness(store).runtime.createRun(genesis());

                const foreign = [
                    new CloudflareRunHosting(ids.run, ids.workspace, other),
                    mode === "workspace"
                        ? new CloudflareRunHosting(ids.run, new ActorId("another-workspace"), mode)
                        : new CloudflareRunHosting(new RunId("another-run"), ids.workspace, mode),
                    // Same Actor ID, other Actor kind: the marker binds both halves.
                    mode === "workspace"
                        ? new CloudflareRunHosting(
                              new RunId(ids.workspace.value),
                              ids.workspace,
                              "dedicated"
                          )
                        : new CloudflareRunHosting(ids.run, new ActorId(ids.run.value))
                ];
                for (const hijack of foreign) {
                    expectOperationalFailure(
                        () => new DurableObjectRunStorage(database, hijack, errors),
                        "codec.invalid"
                    );
                }
                expect(
                    store.transaction((tx) => store.get(tx, "run", ids.run.value))
                ).toBeDefined();

                // A store whose owner marker was deleted serves nobody.
                database.run("DELETE FROM agent_run_storage_schema", []);
                expectOperationalFailure(
                    () => new DurableObjectRunStorage(database, hosting, errors),
                    "codec.invalid"
                );
            } finally {
                objects.dispose();
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] pins hosting at Run start and refuses any later pin",
        { tags: "p0" },
        () => {
            const objects = new HostedWorkspace();
            try {
                const index = objects.index;
                expect(index.get(ids.run)).toBeUndefined();

                const started = new CloudflareRunHosting(ids.run, ids.workspace, mode);
                expect(index.start(started).equals(started)).toBe(true);
                // At-least-once delivery may replay the same start.
                expect(index.start(started).equals(started)).toBe(true);

                const late = new CloudflareRunHosting(ids.run, ids.workspace, other);
                expectOperationalFailure(
                    () => index.start(late),
                    "protocol.invalid-state"
                );
                expect(index.get(ids.run)?.mode).toBe(mode);
            } finally {
                objects.dispose();
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] migrates RunPins only through the SPEC section 5.2 " +
            "migration commit, and never the owner",
        { tags: "p0" },
        () => {
            const objects = new HostedWorkspace();
            try {
                const hosting = objects.index.start(
                    new CloudflareRunHosting(ids.run, ids.workspace, mode)
                );
                const harness = runHarness(
                    new DurableObjectRunStorage(objects.objectDatabase(hosting), hosting, errors)
                );
                harness.runtime.createRun(genesis());

                const target = new RunConfigurationSnapshot({ pins: pins(4) });
                const migration = migrationCommit("hosting-migration", pins(), target.pins);
                const divergent = migrationCommit("hosting-divergent", pins(5), target.pins);
                harness.evidence.controls.set(`${ids.receipt.value}:${ids.audit.value}`, {
                    kind: "control",
                    run: ids.run,
                    receipt: ids.receipt,
                    audit: ids.audit,
                    proposalDigest: migration.proposalDigest.value
                });

                // A migration whose `from` is not the parent's pins installs nothing.
                expectOperationalFailure(
                    () =>
                        harness.runtime.migrateRun(
                            divergent,
                            target,
                            new Revision(0),
                            new Date(2000)
                        ),
                    "run.invalid-state"
                );
                expect(
                    harness.repository.transaction((tx) =>
                        harness.repository.loadCommit(tx, divergent.id)
                    )
                ).toBeUndefined();

                harness.runtime.migrateRun(migration, target, new Revision(0), new Date(2000));
                const migrated = harness.repository.transaction((tx) => ({
                    run: harness.repository.loadRun(tx, ids.run)!,
                    root: harness.repository.loadCommit(tx, ids.root)!,
                    commit: harness.repository.loadCommit(tx, migration.id)!
                }));

                expect(migrated.commit.migration?.from.equals(pins())).toBe(true);
                expect(migrated.commit.migration?.to.equals(target.pins)).toBe(true);
                expect(migrated.commit.pins.equals(target.pins)).toBe(true);
                // Both pin generations stay readable from the same owner.
                expect(migrated.root.pins.equals(pins())).toBe(true);
                expect(migrated.run.configuration.equals(genesis().configuration.id)).toBe(true);
                expect(migrated.run.configurations.map((value) => value.value)).toEqual([
                    genesis().configuration.id.value,
                    target.id.value
                ]);
                // §5.2 rewrites pins; hosting is still the pin taken at Run start. The
                // migration commit and its edge land in that same owner, and migrating
                // does not reopen the start-time pin, so §5.2 is the only path that moves
                // a Run and it never moves the Run's owner.
                expect(objects.index.get(ids.run)?.equals(hosting)).toBe(true);
                expect(
                    harness.storage.transaction((tx) =>
                        harness.storage.parents(tx, migration.id.value)
                    )
                ).toEqual([
                    { commit: migration.id.value, ordinal: 0, parent: ids.root.value }
                ]);
                expect(runObjectNames(objects.otherDatabase(hosting))).toEqual([]);
                expectOperationalFailure(
                    () =>
                        objects.index.start(
                            new CloudflareRunHosting(ids.run, ids.workspace, other)
                        ),
                    "protocol.invalid-state"
                );
                expect(objects.index.get(ids.run)?.equals(hosting)).toBe(true);
            } finally {
                objects.dispose();
            }
        }
    );
});

function migrationCommit(id: string, from: RunPins, to: RunPins): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "migration",
        parents: [ids.root],
        pins: to,
        writer: {
            kind: "system",
            cause: { kind: "control", audit: ids.audit, receipt: ids.receipt }
        },
        receipt: ids.receipt,
        migration: { from, to }
    });
}

describe("Cloudflare Run record storage", () => {
    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] rejects a Run record past the Durable Object blob limit",
        { tags: "p1" },
        () => {
            const objects = new HostedWorkspace();
            try {
                const hosting = objects.index.start(
                    new CloudflareRunHosting(ids.run, ids.workspace)
                );
                const store = new DurableObjectRunStorage(
                    objects.objectDatabase(hosting),
                    hosting,
                    errors
                );
                expectOperationalFailure(
                    () =>
                        store.transaction((tx) =>
                            store.insert(tx, {
                                kind: "commit",
                                key: "oversized",
                                revision: null,
                                bytes: new Uint8Array(2_000_001)
                            })
                        ),
                    "operation.invalid-input"
                );
                expect(store.transaction((tx) => store.list(tx, "commit"))).toEqual([]);
            } finally {
                objects.dispose();
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] keeps records immutable, rolls back with its edges, " +
            "and fails closed on unmarked or malformed state",
        { tags: "p0" },
        () => {
            const objects = new HostedWorkspace();
            try {
                const hosting = objects.index.start(
                    new CloudflareRunHosting(ids.run, ids.workspace, "dedicated")
                );
                const database = objects.objectDatabase(hosting);
                const store = new DurableObjectRunStorage(database, hosting, errors);
                const stored = new TextEncoder().encode("record");
                const record = {
                    kind: "commit",
                    key: "immutable",
                    revision: 0,
                    bytes: stored.slice()
                } as const;

                store.transaction((tx) => {
                    store.insert(tx, record);
                    store.insertParent(tx, { commit: "immutable", ordinal: 0, parent: "root" });
                });
                // Detached bytes: a caller mutating its buffer cannot rewrite the record.
                record.bytes.fill(0);
                expect(
                    store.transaction((tx) => store.get(tx, "commit", "immutable"))?.bytes
                ).toEqual(stored);
                // Re-delivering the identical record is idempotent, not a conflict.
                store.transaction((tx) => store.insert(tx, { ...record, bytes: stored.slice() }));

                expectOperationalFailure(
                    () =>
                        store.transaction((tx) =>
                            store.insert(tx, {
                                ...record,
                                bytes: new TextEncoder().encode("rewritten")
                            })
                        ),
                    "run.invalid-state"
                );
                expectOperationalFailure(
                    () =>
                        store.transaction((tx) =>
                            store.insertParent(tx, {
                                commit: "immutable",
                                ordinal: 0,
                                parent: "other"
                            })
                        ),
                    "run.invalid-state"
                );
                expectOperationalFailure(
                    () =>
                        store.transaction((tx) =>
                            store.replace(tx, { ...record, revision: 2 }, 0)
                        ),
                    "protocol.revision-conflict"
                );
                for (const malformed of [
                    { kind: "commit", key: "", revision: null, bytes: new Uint8Array(1) },
                    { kind: "commit", key: "bad-revision", revision: -1, bytes: new Uint8Array(1) },
                    // The port is public API; a JavaScript caller can present any kind.
                    {
                        kind: malformedInput<RunRecordKind, string>("unknown"),
                        key: "bad-kind",
                        revision: null,
                        bytes: new Uint8Array(1)
                    }
                ] as const) {
                    expectOperationalFailure(
                        () => store.transaction((tx) => store.insert(tx, malformed)),
                        "codec.invalid"
                    );
                }

                expect(() =>
                    store.transaction((tx) => {
                        store.insert(tx, {
                            kind: "commit",
                            key: "rolled-back",
                            revision: null,
                            bytes: new Uint8Array([1])
                        });
                        store.insertParent(tx, {
                            commit: "rolled-back",
                            ordinal: 0,
                            parent: "root"
                        });
                        throw new TypeError("fault");
                    })
                ).toThrow("fault");
                expect(
                    store.transaction((tx) => store.get(tx, "commit", "rolled-back"))
                ).toBeUndefined();
                expect(store.transaction((tx) => store.parents(tx, "rolled-back"))).toEqual([]);
            } finally {
                objects.dispose();
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] refuses a Run store schema it did not create",
        { tags: "p0" },
        () => {
            const hosting = new CloudflareRunHosting(ids.run, ids.workspace);

            // Unmarked Run state is refused before the adapter writes anything, rather
            // than colliding with it halfway through creating its own tables.
            const unmarked = new CloudflareSqlite(new NodeDurableObjectStorage(), errors);
            unmarked.run("CREATE TABLE agent_run_records (id TEXT) STRICT", []);
            expectOperationalFailure(
                () => new DurableObjectRunStorage(unmarked, hosting, errors),
                "codec.invalid"
            );
            expect(unmarked.all(READ_RUN_OBJECTS, []).map((row) => row["name"])).toEqual([
                "agent_run_records"
            ]);

            const incomplete = new CloudflareSqlite(new NodeDurableObjectStorage(), errors);
            incomplete.run(
                `CREATE TABLE agent_run_storage_schema (
                    version INTEGER, owner_kind TEXT, owner_id TEXT
                )`,
                []
            );
            expectOperationalFailure(
                () => new DurableObjectRunStorage(incomplete, hosting, errors),
                "codec.invalid"
            );

            // Every object present under its expected name, none under its exact schema.
            const unconstrained = new CloudflareSqlite(new NodeDurableObjectStorage(), errors);
            for (const statement of [
                "CREATE TABLE agent_run_storage_schema (version INTEGER, owner_kind TEXT, owner_id TEXT)",
                "CREATE TABLE agent_run_records (kind TEXT, record_key TEXT, revision INTEGER, record BLOB)",
                "CREATE TABLE agent_run_commit_parents (commit_id TEXT, ordinal INTEGER, parent_id TEXT)",
                "CREATE INDEX agent_run_commit_parent_reverse ON agent_run_commit_parents (parent_id, commit_id)",
                `INSERT INTO agent_run_storage_schema (version, owner_kind, owner_id)
                 VALUES (1, 'workspace', '${ids.workspace.value}')`
            ]) {
                unconstrained.run(statement, []);
            }
            expectOperationalFailure(
                () => new DurableObjectRunStorage(unconstrained, hosting, errors),
                "codec.invalid"
            );

            // An object appearing beside, or missing from, a store the adapter did create
            // is equally fatal, even though every remaining object matches exactly.
            for (const damage of [
                "CREATE TABLE agent_run_extra (id TEXT) STRICT",
                "DROP INDEX agent_run_commit_parent_reverse"
            ]) {
                const damaged = new CloudflareSqlite(new NodeDurableObjectStorage(), errors);
                new DurableObjectRunStorage(damaged, hosting, errors);
                damaged.run(damage, []);
                expectOperationalFailure(
                    () => new DurableObjectRunStorage(damaged, hosting, errors),
                    "codec.invalid"
                );
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] keeps the commit graph's parent edges in ordinal order",
        { tags: "p0" },
        () => {
            const storage = new CloudflareSqlite(new NodeDurableObjectStorage(), errors);
            const store = new DurableObjectRunStorage(
                storage,
                new CloudflareRunHosting(ids.run, ids.workspace),
                errors
            );
            store.transaction((tx) => {
                store.insertParent(tx, { commit: "merge", ordinal: 1, parent: "source" });
                store.insertParent(tx, { commit: "merge", ordinal: 0, parent: "target" });
                // A redelivered edge is the edge that is already there.
                store.insertParent(tx, { commit: "merge", ordinal: 1, parent: "source" });
            });

            expect(
                store.transaction((tx) => store.parents(tx, "merge")).map((edge) => edge.parent)
            ).toEqual(["target", "source"]);
            for (const malformed of [
                { commit: "", ordinal: 0, parent: "root" },
                { commit: "merge", ordinal: 2, parent: "root" },
                { commit: "merge", ordinal: 0, parent: "" }
            ]) {
                expectOperationalFailure(
                    () => store.transaction((tx) => store.insertParent(tx, malformed)),
                    "codec.invalid"
                );
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] fails closed when the substrate returns rows its schema " +
            "cannot produce",
        { tags: "p0" },
        () => {
            const storage = new MutatingSqlite(new NodeDurableObjectStorage(), errors);
            const store = new DurableObjectRunStorage(
                storage,
                new CloudflareRunHosting(ids.run, ids.workspace),
                errors
            );
            const record = {
                kind: "commit",
                key: "mutated",
                revision: null,
                bytes: new Uint8Array([1])
            } as const;
            store.transaction((tx) => store.insert(tx, record));

            storage.mutate = (statement, rows) =>
                statement.includes("WHERE kind = ? AND record_key = ?") && rows.length === 1
                    ? [rows[0]!, rows[0]!]
                    : rows;
            expectOperationalFailure(
                () => store.transaction((tx) => store.get(tx, "commit", "mutated")),
                "codec.invalid"
            );

            // A row answering for a kind or key other than the one asked for is another
            // Run's record, so it is refused rather than returned under the asked-for name.
            for (const projection of [{ kind: "branch" }, { record_key: "elsewhere" }]) {
                storage.mutate = (statement, rows) =>
                    statement.includes("WHERE kind = ? AND record_key = ?")
                        ? rows.map((row) => ({ ...row, ...projection }))
                        : rows;
                expectOperationalFailure(
                    () => store.transaction((tx) => store.get(tx, "commit", "mutated")),
                    "codec.invalid"
                );
            }

            storage.mutate = (statement, rows) =>
                statement.includes("WHERE kind = ? ORDER BY record_key")
                    ? rows.map((row) => ({ ...row, revision: -1 }))
                    : rows;
            expectOperationalFailure(
                () => store.transaction((tx) => store.list(tx, "commit")),
                "codec.invalid"
            );
            // Reopening rereads every record and every edge, so a store whose contents
            // stopped matching its schema never serves a single request.
            expectOperationalFailure(
                () =>
                    new DurableObjectRunStorage(
                        storage,
                        new CloudflareRunHosting(ids.run, ids.workspace),
                        errors
                    ),
                "codec.invalid"
            );

            for (const edge of [
                { commit_id: "merge", ordinal: 4, parent_id: "root" },
                { commit_id: 7, ordinal: 0, parent_id: "root" },
                { commit_id: "merge", ordinal: "first", parent_id: "root" }
            ]) {
                storage.mutate = (statement, rows) =>
                    statement.includes("ORDER BY commit_id, ordinal") ? [edge] : rows;
                expectOperationalFailure(
                    () =>
                        new DurableObjectRunStorage(
                            storage,
                            new CloudflareRunHosting(ids.run, ids.workspace),
                            errors
                        ),
                    "codec.invalid"
                );
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] owns every Workspace-hosted Run of one Workspace side " +
            "by side, and pins one dedicated without moving the rest",
        { tags: "p0" },
        () => {
            const objects = new HostedWorkspace();
            try {
                // The default hosting is a shared one: a Workspace owns all the Runs that
                // took no pin, so the store has to hold more than one Run at a time.
                const second = new RunId("hosting-second-run");
                const first = objects.index.start(new CloudflareRunHosting(ids.run, ids.workspace));
                const shared = objects.index.start(new CloudflareRunHosting(second, ids.workspace));
                expect(shared.owner.id.value).toBe(first.owner.id.value);

                const store = new DurableObjectRunStorage(
                    objects.objectDatabase(shared),
                    shared,
                    errors
                );
                store.transaction((tx) => {
                    store.insert(tx, {
                        kind: "run",
                        key: ids.run.value,
                        revision: 0,
                        bytes: new Uint8Array([1])
                    });
                    store.insert(tx, {
                        kind: "run",
                        key: second.value,
                        revision: 0,
                        bytes: new Uint8Array([2])
                    });
                });

                // Record keys are Run-unique identities, so neither Run's records displace
                // the other's and each stays separately addressable in the shared owner.
                expect(store.transaction((tx) => store.get(tx, "run", ids.run.value))?.bytes).toEqual(
                    new Uint8Array([1])
                );
                expect(store.transaction((tx) => store.get(tx, "run", second.value))?.bytes).toEqual(
                    new Uint8Array([2])
                );
                expect(
                    store.transaction((tx) => store.list(tx, "run")).map((record) => record.key)
                ).toEqual([ids.run.value, second.value]);

                // Pinning a later Run dedicated moves that Run alone.
                const third = new RunId("hosting-third-run");
                expect(
                    objects.index.start(
                        new CloudflareRunHosting(third, ids.workspace, "dedicated")
                    ).owner.kind
                ).toBe("run");
                expect(objects.index.get(ids.run)?.equals(first)).toBe(true);
                expect(objects.index.get(second)?.equals(shared)).toBe(true);
            } finally {
                objects.dispose();
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] installs the Workspace Run index under its constraints",
        { tags: "p1" },
        () => {
            const objects = new HostedWorkspace();
            try {
                const database = objects.workspace;
                objects.index.start(new CloudflareRunHosting(ids.run, ids.workspace, "dedicated"));
                const insert =
                    "INSERT INTO agent_core_run_hosting (run_id, mode, workspace_id) VALUES (?, ?, ?)";

                for (const row of [
                    ["another-run", "shared", ids.workspace.value],
                    ["another-run", "workspace", ""],
                    [ids.run.value, "workspace", ids.workspace.value]
                ]) {
                    expectOperationalFailure(
                        () => database.run(insert, row),
                        "protocol.invalid-state"
                    );
                }
                expect(objects.index.get(ids.run)?.mode).toBe("dedicated");
            } finally {
                objects.dispose();
            }
        }
    );

    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] reports a corrupt hosting row instead of guessing an owner",
        { tags: "p1" },
        () => {
            // A hand-made table without the migration's constraints: the reader trusts the
            // row no more than it trusts the storage that produced it.
            const storage = new NodeDurableObjectStorage();
            const database = new CloudflareSqlite(storage, errors);
            database.run(
                "CREATE TABLE agent_core_run_hosting (run_id TEXT, mode TEXT, workspace_id TEXT)",
                []
            );
            const index = new SqliteRunHostingIndex(database, errors);
            const insert =
                "INSERT INTO agent_core_run_hosting (run_id, mode, workspace_id) VALUES (?, ?, ?)";

            database.run(insert, [ids.run.value, "shared", ids.workspace.value]);
            expectOperationalFailure(() => index.get(ids.run), "codec.invalid");

            const untyped = new RunId("hosting-untyped-owner");
            database.run(insert, [untyped.value, "workspace", new Uint8Array([1, 2])]);
            expectOperationalFailure(() => index.get(untyped), "codec.invalid");

            const overlong = new RunId("hosting-overlong-owner");
            database.run(insert, [overlong.value, "workspace", "w".repeat(257)]);
            expectOperationalFailure(() => index.get(overlong), "codec.invalid");
        }
    );
});

describe("Cloudflare Run hosting identity", () => {
    test(
        "[C13-CLOUDFLARE-RUN-HOSTING] names the Workspace object by default and a Run object " +
            "when pinned dedicated",
        { tags: "p1" },
        () => {
            const workspaceHosted = new CloudflareRunHosting(ids.run, ids.workspace);
            const dedicated = new CloudflareRunHosting(ids.run, ids.workspace, "dedicated");

            // Offering no pin at all is the Workspace-owned default, not an error and not
            // some third hosting: it is exactly the hosting an explicit `workspace` names.
            expect(workspaceHosted.mode).toBe("workspace");
            expect(workspaceHosted.owner.kind).toBe("workspace");
            expect(workspaceHosted.owner.id.value).toBe(ids.workspace.value);
            expect(
                workspaceHosted.equals(
                    new CloudflareRunHosting(ids.run, ids.workspace, "workspace")
                )
            ).toBe(true);
            expect(workspaceHosted.objectName).toBe(
                `agent-core:actor:v1:workspace:${ids.workspace.value}`
            );
            expect(dedicated.objectName).toBe(`agent-core:actor:v1:run:${ids.run.value}`);
            expect(workspaceHosted.equals(dedicated)).toBe(false);
            expect(
                workspaceHosted.equals(
                    new CloudflareRunHosting(new RunId("another-run"), ids.workspace)
                )
            ).toBe(false);
            expect(
                workspaceHosted.equals(
                    new CloudflareRunHosting(ids.run, new ActorId("another-workspace"))
                )
            ).toBe(false);
            expect(
                () =>
                    new CloudflareRunHosting(
                        ids.run,
                        ids.workspace,
                        malformedInput<RunHostingMode, string>("shared")
                    )
            ).toThrow(TypeError);
        }
    );
});

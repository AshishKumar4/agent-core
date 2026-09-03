import { describe, expect, test } from "vitest";
import {
    AdmittedInvocationItem,
    createDetachedEffectExecutionMemoryState,
    DetachedEffectExecution,
    EffectAttemptId,
    InvocationId,
    MemoryDetachedEffectExecutionPersistence,
    type DetachedEffectExecutionMemoryState,
    type DetachedEffectExecutionPersistence
} from "../../../../src/invocations";
import { SqliteDetachedEffectExecutionPersistence } from "../../../../src/substrates/sqlite/invocations";
import type { SqliteRow, SqliteValue } from "../../../../src/substrates";
import type { SynchronousResultGuard } from "../../../../src/actors";
import { TestSqlite } from "../../../helpers/sqlite";

/**
 * One contract, both implementations. The seam is what a Run's delivery and a restarted driver
 * both read through, so memory and SQLite must answer identically about which items are
 * released and which transition is next.
 */
function detachedContract<Transaction>(
    persistence: DetachedEffectExecutionPersistence<Transaction>,
    transact: <Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ) => Result,
    label: string
): void {
    const first = item("detached-sqlite-first", 0);
    const second = item("detached-sqlite-second", 1);

    transact((transaction) => {
        persistence.appendDetachedExecution(transaction, DetachedEffectExecution.awaiting(first));
        persistence.appendDetachedExecution(transaction, DetachedEffectExecution.awaiting(second));
    });

    expect(
        transact((transaction) => persistence.releasedDetachedExecutions(transaction, 8)),
        label
    ).toEqual([]);

    const stored = transact((transaction) =>
        persistence.detachedExecution(transaction, first.attempt)
    );
    expect(stored?.state.kind, label).toBe("awaitingPublication");
    expect(stored?.itemIndex, label).toBe(0);
    if (stored === undefined) throw new TypeError("Expected the stored detachment");

    transact((transaction) => persistence.appendDetachedExecution(transaction, stored.released()));
    const released = transact((transaction) =>
        persistence.releasedDetachedExecutions(transaction, 8)
    );
    expect(
        released.map((record) => record.attempt.value),
        label
    ).toEqual([first.attempt.value]);
    expect(released[0]?.revision.value, label).toBe(1);

    // Two released items are one bounded page in one order. The driver's batch limit decides
    // which of them runs this sweep, so a store whose page order is its own would run
    // different work on each substrate for the same durable set.
    const storedSecond = transact((transaction) =>
        persistence.detachedExecution(transaction, second.attempt)
    );
    if (storedSecond === undefined) throw new TypeError("Expected the second detachment");
    transact((transaction) =>
        persistence.appendDetachedExecution(transaction, storedSecond.released())
    );
    const page = transact((transaction) => persistence.releasedDetachedExecutions(transaction, 8));
    expect(
        page.map((record) => record.attempt.value),
        label
    ).toEqual([first.attempt.value, second.attempt.value]);
    expect(
        transact((transaction) => persistence.releasedDetachedExecutions(transaction, 1)).map(
            (record) => record.attempt.value
        ),
        label
    ).toEqual([first.attempt.value]);
    transact((transaction) =>
        persistence.appendDetachedExecution(
            transaction,
            storedSecond.released().cancellationRequested()
        )
    );

    // A stale transition names a revision the store has already moved past.
    expect(() =>
        transact((transaction) =>
            persistence.appendDetachedExecution(transaction, stored.released())
        )
    ).toThrowError(/next transition/);

    const current = transact((transaction) =>
        persistence.detachedExecution(transaction, first.attempt)
    );
    if (current === undefined) throw new TypeError("Expected the released detachment");
    transact((transaction) =>
        persistence.appendDetachedExecution(transaction, current.cancellationRequested())
    );
    expect(
        transact((transaction) => persistence.releasedDetachedExecutions(transaction, 8)),
        label
    ).toEqual([]);
    expect(
        transact((transaction) => persistence.detachedExecution(transaction, first.attempt))?.state
            .kind,
        label
    ).toBe("cancellationRequested");

    // A second row for the same attempt is the one thing the store must never hold.
    expect(() =>
        transact((transaction) =>
            persistence.appendDetachedExecution(
                transaction,
                DetachedEffectExecution.awaiting(first)
            )
        )
    ).toThrowError(/next transition/);

    expect(
        () => transact((transaction) => persistence.releasedDetachedExecutions(transaction, 0)),
        label
    ).toThrowError(/positive limit/);
}

describe("SqliteDetachedEffectExecutionPersistence", () => {
    test(
        "[C13-OWNERSHIP-SINGLE-OWNER] [detached-effect-execution-persistence] [invocation.detached-effect-execution] memory and SQLite satisfy one detached execution contract",
        { tags: "p1" },
        () => {
            const memoryState = createDetachedEffectExecutionMemoryState();
            detachedContract(
                new MemoryDetachedEffectExecutionPersistence(),
                <Result>(
                    operation: (transaction: DetachedEffectExecutionMemoryState) => Result,
                    ..._guard: SynchronousResultGuard<Result>
                ): Result => operation(memoryState),
                "memory"
            );

            const database = new TestSqlite();
            detachedContract(
                new SqliteDetachedEffectExecutionPersistence(database),
                (operation, ...guard) => database.transaction(() => operation(database), ...guard),
                "sqlite"
            );
        }
    );

    test(
        "[C13-CODEC-VERSIONING] [invocation.detached-effect-execution] a released record survives a rebuilt store over the same database",
        { tags: "p1" },
        () => {
            const database = new TestSqlite();
            const value = item("detached-sqlite-restart", 3);
            const store = new SqliteDetachedEffectExecutionPersistence(database);
            database.transaction(() => {
                store.appendDetachedExecution(database, DetachedEffectExecution.awaiting(value));
                const stored = store.detachedExecution(database, value.attempt);
                if (stored === undefined) throw new TypeError("Expected the stored detachment");
                store.appendDetachedExecution(database, stored.released());
            });

            // The additive CREATE TABLE IF NOT EXISTS runs again and finds its own rows.
            const rebuilt = new SqliteDetachedEffectExecutionPersistence(database);
            const released = database.transaction(() =>
                rebuilt.releasedDetachedExecutions(database, 8)
            );

            expect(released).toHaveLength(1);
            expect(released[0]?.attempt.equals(value.attempt)).toBe(true);
            expect(released[0]?.itemIndex).toBe(3);
            expect(released[0]?.state.executable).toBe(true);
        }
    );
});

describe("detached execution stores refuse what they did not write", () => {
    test(
        "[C13-OWNERSHIP-SINGLE-OWNER] a SQLite row whose projection disagrees with its codec bytes is refused by the read that meets it",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const store = new SqliteDetachedEffectExecutionPersistence(database);
            const value = item("detached-sqlite-projection", 2);
            database.transaction(() =>
                store.appendDetachedExecution(database, DetachedEffectExecution.awaiting(value))
            );
            const read = (): DetachedEffectExecution | undefined =>
                database.transaction(() => store.detachedExecution(database, value.attempt));
            const setColumn = (column: string, stored: SqliteValue): void => {
                database.run(`UPDATE ${TABLE} SET ${column} = ? WHERE attempt_id = ?`, [
                    stored,
                    value.attempt.value
                ]);
            };

            // The columns are a projection of the record, never a second source of truth. Each
            // of these is a row only something other than this store could have written, and
            // serving it would answer a Run's message from a state no transition produced.
            setColumn("item_index", 7);
            expect(read).toThrowError(/does not match codec bytes/);
            setColumn("item_index", 2);
            setColumn("state", "released");
            expect(read).toThrowError(/does not match codec bytes/);
            setColumn("state", "awaitingPublication");
            setColumn("invocation_id", "invocation:someone-elses");
            expect(read).toThrowError(/does not match codec bytes/);
            setColumn("invocation_id", value.invocation.value);
            setColumn("revision", 3);
            expect(read).toThrowError(/does not match codec bytes/);
            setColumn("revision", 0);

            // A column holding the wrong SQL type is the same refusal: the reader narrows every
            // value it reads instead of trusting the declared column type.
            setColumn("state", Uint8Array.of(1, 2));
            expect(read).toThrowError(/does not match codec bytes/);
            setColumn("state", "awaitingPublication");
            setColumn("item_index", "two");
            expect(read).toThrowError(/does not match codec bytes/);
            setColumn("item_index", 2);
            setColumn("record", "not-a-record");
            expect(read).toThrowError(/does not match codec bytes/);
            setColumn(
                "record",
                DetachedEffectExecution.encode(DetachedEffectExecution.awaiting(value))
            );

            expect(read()?.state.kind).toBe("awaitingPublication");
        }
    );

    test(
        "[C13-OWNERSHIP-SINGLE-OWNER] a driver row outside the query the store asked for is refused rather than served",
        { tags: "p1" },
        () => {
            const database = new ProjectedSqlite();
            const store = new SqliteDetachedEffectExecutionPersistence(database);
            const value = item("detached-sqlite-driver-row", 0);
            const other = item("detached-sqlite-driver-other", 1);
            database.transaction(() => {
                store.appendDetachedExecution(database, DetachedEffectExecution.awaiting(value));
                store.appendDetachedExecution(database, DetachedEffectExecution.awaiting(other));
            });

            const rowFor = (attempt: string): SqliteRow => {
                const row = database.transaction(() =>
                    database.all(`SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE attempt_id = ?`, [
                        attempt
                    ])
                )[0];
                if (row === undefined) throw new TypeError("Expected the stored row");
                return row;
            };
            const otherRow = rowFor(other.attempt.value);
            const awaitingRow = rowFor(value.attempt.value);

            // The row is coherent with its own bytes and belongs to another attempt: only the
            // read's own check that the row answers the key it asked for catches it.
            database.mapRows = (rows) => rows.map((row) => ("attempt_id" in row ? otherRow : row));
            expect(() =>
                database.transaction(() => store.detachedExecution(database, value.attempt))
            ).toThrowError(/does not match codec bytes/);

            // The released page is the driver's work list, so a row that is not executable
            // would hand a driver an item no Run has released.
            database.mapRows = (rows) => rows;
            database.transaction(() => {
                const stored = store.detachedExecution(database, other.attempt);
                if (stored === undefined) throw new TypeError("Expected the stored detachment");
                store.appendDetachedExecution(database, stored.released());
            });
            expect(
                database
                    .transaction(() => store.releasedDetachedExecutions(database, 8))
                    .map((record) => record.attempt.value)
            ).toEqual([other.attempt.value]);
            database.mapRows = (rows) =>
                rows.map((row) => ("attempt_id" in row ? awaitingRow : row));
            expect(() =>
                database.transaction(() => store.releasedDetachedExecutions(database, 8))
            ).toThrowError(/does not match codec bytes/);
        }
    );

    test(
        "[C13-OWNERSHIP-SINGLE-OWNER] a transition whose update replaced no row is refused instead of reported as stored",
        { tags: "p0" },
        () => {
            const database = new SwallowedUpdateSqlite();
            const store = new SqliteDetachedEffectExecutionPersistence(database);
            const value = item("detached-sqlite-lost-update", 0);
            database.transaction(() =>
                store.appendDetachedExecution(database, DetachedEffectExecution.awaiting(value))
            );
            const stored = database.transaction(() =>
                store.detachedExecution(database, value.attempt)
            );
            if (stored === undefined) throw new TypeError("Expected the stored detachment");

            // The update carries the previous revision, so a transition that lost the race
            // changes no row. Reporting success there would tell a Run its item is released
            // while the store still holds the state before it.
            database.swallowUpdates = true;
            expect(() =>
                database.transaction(() =>
                    store.appendDetachedExecution(database, stored.released())
                )
            ).toThrowError(/did not replace its exact previous revision/);
            database.swallowUpdates = false;
            expect(
                database.transaction(() => store.detachedExecution(database, value.attempt))?.state
                    .kind
            ).toBe("awaitingPublication");
        }
    );

    test(
        "[C13-OWNERSHIP-SINGLE-OWNER] a memory record filed under another attempt's key is refused",
        { tags: "p1" },
        () => {
            const state = createDetachedEffectExecutionMemoryState();
            const persistence = new MemoryDetachedEffectExecutionPersistence();
            const value = item("detached-memory-index", 0);
            const other = item("detached-memory-index-other", 1);
            persistence.appendDetachedExecution(state, DetachedEffectExecution.awaiting(value));
            const bytes = state.detachedExecutions.get(value.attempt.value);
            if (bytes === undefined) throw new TypeError("Expected the stored bytes");

            // The map key is the index this store answers by; bytes filed under a key that is
            // not their own attempt would answer one attempt's read with another's record.
            state.detachedExecutions.set(other.attempt.value, bytes);
            expect(() => persistence.detachedExecution(state, other.attempt)).toThrowError(
                /does not match codec bytes/
            );
            expect(persistence.detachedExecution(state, value.attempt)?.itemIndex).toBe(0);
        }
    );
});

/** The table and columns this store projects its records onto. */
const TABLE = "invocation_detached_executions";
const SELECT_COLUMNS = "attempt_id, invocation_id, item_index, state, revision, record";

/** A driver that hands back rows a suite chooses, the way a mismatched projection would. */
class ProjectedSqlite extends TestSqlite {
    public mapRows: (rows: readonly SqliteRow[]) => readonly SqliteRow[] = (rows) => rows;

    protected override query(
        statement: string,
        bindings: readonly SqliteValue[]
    ): readonly SqliteRow[] {
        return this.mapRows(super.query(statement, bindings));
    }
}

/** A driver whose UPDATE changes no row, the way a lost concurrency race leaves one. */
class SwallowedUpdateSqlite extends TestSqlite {
    public swallowUpdates = false;

    protected override execute(statement: string, bindings: readonly SqliteValue[]): void {
        if (this.swallowUpdates && statement.trimStart().startsWith("UPDATE")) return;
        super.execute(statement, bindings);
    }
}

function item(id: string, itemIndex: number): AdmittedInvocationItem {
    return new AdmittedInvocationItem({
        invocation: new InvocationId(`invocation:${id}`),
        itemIndex,
        itemKey: `key:${id}`,
        attempt: new EffectAttemptId(`attempt:${id}`)
    });
}

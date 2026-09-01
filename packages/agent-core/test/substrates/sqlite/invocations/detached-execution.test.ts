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

function item(id: string, itemIndex: number): AdmittedInvocationItem {
    return new AdmittedInvocationItem({
        invocation: new InvocationId(`invocation:${id}`),
        itemIndex,
        itemKey: `key:${id}`,
        attempt: new EffectAttemptId(`attempt:${id}`)
    });
}

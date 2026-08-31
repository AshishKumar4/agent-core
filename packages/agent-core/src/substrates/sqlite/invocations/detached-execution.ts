import { AgentCoreError } from "../../../errors";
import {
    DetachedEffectExecution,
    InvocationError,
    type DetachedEffectExecutionPersistence,
    type EffectAttemptId
} from "../../../invocations";
import { TransactionalSqlite, isSqliteNumber, isSqliteText, type SqliteRow } from "../sqlite";

const CREATE_DETACHED_EXECUTIONS = `CREATE TABLE IF NOT EXISTS invocation_detached_executions (
    attempt_id TEXT PRIMARY KEY,
    invocation_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    state TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL,
    UNIQUE (invocation_id, item_index, attempt_id)
)`;

const CREATE_RELEASED_INDEX = `CREATE INDEX IF NOT EXISTS invocation_detached_released
    ON invocation_detached_executions (state, attempt_id)`;

const RELEASED_STATE = "released";
const SELECT_COLUMNS = "attempt_id, invocation_id, item_index, state, revision, record";

/**
 * The SQLite store for detached execution records (§8.4's substrate implementation of one
 * Invocation-owned seam).
 *
 * The table is added rather than folded into the existing invocation tables: the record has no
 * reference type parameters, so it needs no projection callbacks, and no existing table's shape
 * changes. One row per EffectAttempt is the whole concurrency rule — an attempt is detached at
 * most once — so the primary key states it instead of a check in application code, and the
 * stored revision makes an out-of-order transition a refusal rather than a last write that
 * wins.
 */
export class SqliteDetachedEffectExecutionPersistence implements DetachedEffectExecutionPersistence<TransactionalSqlite> {
    public constructor(database: TransactionalSqlite) {
        database.transaction(() => {
            database.run(CREATE_DETACHED_EXECUTIONS, []);
            database.run(CREATE_RELEASED_INDEX, []);
        });
    }

    public detachedExecution(
        transaction: TransactionalSqlite,
        attempt: EffectAttemptId
    ): DetachedEffectExecution | undefined {
        const [row] = transaction.all(
            `SELECT ${SELECT_COLUMNS} FROM invocation_detached_executions WHERE attempt_id = ?`,
            [attempt.value]
        );
        if (row === undefined) return undefined;
        const record = decode(row);
        if (!record.attempt.equals(attempt)) corrupt();
        return record;
    }

    public releasedDetachedExecutions(
        transaction: TransactionalSqlite,
        limit: number
    ): readonly DetachedEffectExecution[] {
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Released detached execution query requires a positive limit"
            );
        }
        return Object.freeze(
            transaction
                .all(
                    `SELECT ${SELECT_COLUMNS} FROM invocation_detached_executions
                     WHERE state = ? ORDER BY attempt_id LIMIT ?`,
                    [RELEASED_STATE, limit]
                )
                .map((row) => {
                    const record = decode(row);
                    if (!record.state.executable) corrupt();
                    return record;
                })
        );
    }

    public appendDetachedExecution(
        transaction: TransactionalSqlite,
        record: DetachedEffectExecution
    ): void {
        const current = this.detachedExecution(transaction, record.attempt);
        if (
            (current === undefined && record.revision.value !== 0) ||
            (current !== undefined && !record.follows(current))
        ) {
            throw new InvocationError(
                "store.duplicate-record",
                "Detached execution revision is not the next transition"
            );
        }
        const bytes = DetachedEffectExecution.encode(record);
        if (current === undefined) {
            transaction.run(
                `INSERT INTO invocation_detached_executions
                 (attempt_id, invocation_id, item_index, state, revision, record)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    record.attempt.value,
                    record.invocation.value,
                    record.itemIndex,
                    record.state.kind,
                    record.revision.value,
                    bytes
                ]
            );
            return;
        }
        // The previous revision is part of the statement, so the write is its own concurrency
        // check: a transition that lost a race changes no row rather than overwriting a newer
        // state, and the read above stays in the same synchronous transaction as this write.
        transaction.run(
            `UPDATE invocation_detached_executions
             SET state = ?, revision = ?, record = ?
             WHERE attempt_id = ? AND revision = ?`,
            [
                record.state.kind,
                record.revision.value,
                bytes,
                record.attempt.value,
                current.revision.value
            ]
        );
        const stored = this.detachedExecution(transaction, record.attempt);
        if (stored === undefined || !stored.state.equals(record.state)) {
            throw new InvocationError(
                "store.duplicate-record",
                "Detached execution transition did not replace its exact previous revision"
            );
        }
    }
}

function decode(row: SqliteRow): DetachedEffectExecution {
    const record = DetachedEffectExecution.decode(bytes(row, "record"));
    if (
        record.attempt.value !== text(row, "attempt_id") ||
        record.invocation.value !== text(row, "invocation_id") ||
        record.itemIndex !== integer(row, "item_index") ||
        record.state.kind !== text(row, "state") ||
        record.revision.value !== integer(row, "revision")
    ) {
        corrupt();
    }
    return record;
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    return isSqliteText(value) ? value : corrupt();
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    return isSqliteNumber(value) && Number.isSafeInteger(value) ? value : corrupt();
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    return value instanceof Uint8Array ? value : corrupt();
}

function corrupt(): never {
    throw new AgentCoreError(
        "codec.invalid",
        "Stored detached execution projection does not match codec bytes"
    );
}

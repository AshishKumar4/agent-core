import { Database } from "bun:sqlite";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { requireSynchronousResult, type SynchronousResultGuard } from "../../src/actors";
import { TransactionalSqlite, type SqliteRow, type SqliteValue } from "../../src/substrates";

export class TestSqlite extends TransactionalSqlite {
    readonly #database = new Database(":memory:");

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.query<SqliteRow, SqliteValue[]>(statement).all(...bindings);
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.query<SqliteRow, SqliteValue[]>(statement).run(...bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#database.transaction(() => requireSynchronousResult(operation()))();
    }
}

export class FileSqlite extends TransactionalSqlite {
    readonly #database: DatabaseSync;

    public constructor(path: string) {
        super();
        this.#database = new DatabaseSync(path);
    }

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database
            .prepare(statement)
            .all(...bindings)
            .map((row) => parseSqliteRow(row));
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.prepare(statement).run(...bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        this.#database.exec("BEGIN");
        try {
            const result = requireSynchronousResult(operation());
            this.#database.exec("COMMIT");
            return result;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }

    public close(): void {
        this.#database.close();
    }
}

export function sqliteInteger(row: SqliteRow | undefined, column: string, subject: string): number {
    const value = row?.[column];
    if (!isSqliteInteger(value)) throw new TypeError(`Expected ${subject}`);
    return value;
}

function parseSqliteRow(row: Record<string, SQLOutputValue>): SqliteRow {
    const parsed: Record<string, SqliteValue> = {};
    for (const [column, value] of Object.entries(row)) {
        if (!isSqliteValue(value))
            throw new TypeError(`SQLite column ${column} is an unsafe integer`);
        parsed[column] = value;
    }
    return parsed;
}

function isSqliteValue(value: SQLOutputValue): value is Exclude<SQLOutputValue, bigint> {
    return (
        value === null ||
        typeof value === "number" ||
        typeof value === "string" ||
        value instanceof Uint8Array
    );
}

function isSqliteInteger(value: SqliteValue | undefined): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
}

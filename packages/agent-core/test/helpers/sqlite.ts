import { Database } from "bun:sqlite";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { requireSynchronousResult, type SynchronousResultGuard } from "../../src/actors";
import { TransactionalSqlite, type SqliteRow, type SqliteValue } from "../../src/substrates";

interface TestSqliteDispatch {
    target?: TestSqlite;
}

export class TestSqlite extends TransactionalSqlite {
    readonly #database: Database;

    public constructor() {
        const database = new Database(":memory:");
        const dispatch: TestSqliteDispatch = {};
        super({
            read: (statement, bindings) => requireTarget(dispatch).query(statement, bindings),
            write: (statement, bindings) => requireTarget(dispatch).execute(statement, bindings),
            identity: database
        });
        this.#database = database;
        dispatch.target = this;
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#database.transaction(() => requireSynchronousResult(operation()))();
    }

    protected query(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.query<SqliteRow, SqliteValue[]>(statement).all(...bindings);
    }

    protected execute(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.query<SqliteRow, SqliteValue[]>(statement).run(...bindings);
    }
}

export class FileSqlite extends TransactionalSqlite {
    readonly #database: DatabaseSync;

    public constructor(path: string) {
        const database = new DatabaseSync(path);
        super({
            read: (statement, bindings) =>
                database
                    .prepare(statement)
                    .all(...bindings)
                    .map((row) => parseSqliteRow(row)),
            write: (statement, bindings) => database.prepare(statement).run(...bindings),
            identity: database
        });
        this.#database = database;
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

function requireTarget(dispatch: TestSqliteDispatch): TestSqlite {
    if (dispatch.target === undefined) throw new TypeError("Test SQLite is not initialized");
    return dispatch.target;
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

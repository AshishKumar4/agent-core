import { DatabaseSync } from "node:sqlite";
import type {
    CloudflareDurableObjectStorage,
    CloudflareSqlBinding,
    CloudflareSqlCursor,
    CloudflareSqlStorage,
    CloudflareSqlValue,
    SqliteRow,
    SqliteValue,
    SynchronousResultGuard,
    SynchronousSqlitePort
} from "../src/index.js";
import { isFiniteNumber, isText } from "../src/platform-value.js";

type NodeSqliteRow = ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>[number];

/** Real SQLite semantics for structural tests, backed by an in-memory node:sqlite database. */
export class NodeSqlite implements SynchronousSqlitePort {
    readonly #database = new DatabaseSync(":memory:");

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database
            .prepare(statement)
            .all(...bindings)
            .map(storedRow);
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
            const result = operation();
            this.#database.exec("COMMIT");
            return result;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }
}

/**
 * Real SQLite semantics behind the Durable Object storage seam, so structural tests
 * exercise CloudflareSqlite itself rather than a scripted cursor. Backed by a file when
 * a path is given, which is what lets a test close a database and reopen it.
 */
export class NodeDurableObjectStorage implements CloudflareDurableObjectStorage {
    readonly #database: DatabaseSync;
    #depth = 0;

    public constructor(location = ":memory:") {
        this.#database = new DatabaseSync(location);
    }

    public readonly sql: CloudflareSqlStorage = {
        exec: (statement, ...bindings) => this.#exec(statement, bindings)
    };

    public transactionSync<Result>(operation: () => Result): Result {
        if (this.#depth > 0) throw new TypeError("node:sqlite transaction is nested");
        this.#depth += 1;
        this.#database.exec("BEGIN");
        try {
            const result = operation();
            this.#database.exec("COMMIT");
            return result;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        } finally {
            this.#depth -= 1;
        }
    }

    public close(): void {
        this.#database.close();
    }

    #exec(
        statement: string,
        bindings: readonly CloudflareSqlBinding[]
    ): CloudflareSqlCursor<Record<string, CloudflareSqlValue>> {
        const prepared = this.#database.prepare(statement);
        return prepared.all(...bindings.map(nodeBinding)).map(storedRow);
    }
}

function nodeBinding(value: CloudflareSqlBinding): string | number | Uint8Array | null {
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

/**
 * node:sqlite types a row by what SQLite can store, not by what this package accepts, so
 * both seams read one back the same way: a Uint8Array is what a BLOB comes out as, and
 * anything outside the column types this package declares is the substrate disagreeing
 * with the schema rather than data to carry.
 */
function storedRow(row: NodeSqliteRow): SqliteRow {
    const values: Record<string, SqliteValue> = {};
    for (const [column, value] of Object.entries(row)) {
        if (
            value !== null &&
            !isText(value) &&
            !isFiniteNumber(value) &&
            !(value instanceof Uint8Array)
        ) {
            throw new TypeError(`Unsupported SQLite value in column ${column}`);
        }
        values[column] = value;
    }
    return values;
}

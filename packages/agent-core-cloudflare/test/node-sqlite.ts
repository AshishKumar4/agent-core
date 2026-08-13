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

/** Real SQLite semantics for structural tests, backed by an in-memory node:sqlite database. */
export class NodeSqlite implements SynchronousSqlitePort {
    readonly #database = new DatabaseSync(":memory:");

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = this.#database.prepare(statement).all(...bindings);
        return rows.map((row) => {
            if (typeof row !== "object" || row === null) {
                throw new TypeError("node:sqlite returned a non-object row");
            }
            const values: Record<string, SqliteValue> = {};
            for (const [column, value] of Object.entries(row)) {
                if (
                    value !== null &&
                    typeof value !== "string" &&
                    typeof value !== "number" &&
                    !(value instanceof Uint8Array)
                ) {
                    throw new TypeError(`Unsupported SQLite value in column ${column}`);
                }
                values[column] = value;
            }
            return values;
        });
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
        const rows = prepared.all(...bindings.map(nodeBinding));
        return rows.map((row) => {
            if (typeof row !== "object" || row === null) {
                throw new TypeError("node:sqlite returned a non-object row");
            }
            const values: Record<string, CloudflareSqlValue> = {};
            for (const [column, value] of Object.entries(row)) {
                if (
                    value !== null &&
                    typeof value !== "string" &&
                    typeof value !== "number" &&
                    !(value instanceof Uint8Array)
                ) {
                    throw new TypeError(`Unsupported SQLite value in column ${column}`);
                }
                values[column] = value;
            }
            return values;
        });
    }
}

function nodeBinding(value: CloudflareSqlBinding): string | number | Uint8Array | null {
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

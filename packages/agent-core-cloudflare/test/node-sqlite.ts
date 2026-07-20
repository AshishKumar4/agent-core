import { DatabaseSync } from "node:sqlite";
import type {
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

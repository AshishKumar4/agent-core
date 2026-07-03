import { Database } from "bun:sqlite";
import {
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../src/substrates/sqlite";

export class TestSqlite extends TransactionalSqlite {
    readonly #database = new Database(":memory:");

    public all(
        statement: string,
        bindings: readonly SqliteValue[]
    ): readonly SqliteRow[] {
        return this.#database
            .query<SqliteRow, SqliteValue[]>(statement)
            .all(...bindings);
    }

    public run(
        statement: string,
        bindings: readonly SqliteValue[]
    ): void {
        this.#database
            .query<SqliteRow, SqliteValue[]>(statement)
            .run(...bindings);
    }

    public transaction<Result>(operation: () => Result): Result {
        return this.#database.transaction(operation)();
    }
}

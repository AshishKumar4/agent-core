import { expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../../src/actors";
import {
    hasSameSqliteProvenance,
    TransactionalSqlite
} from "../../../src/substrates/sqlite/sqlite";
import { TestSqlite } from "../../helpers/sqlite";

test("derived SQLite scopes inherit provenance without mutable transfer hooks", { tags: "p0" }, () => {
    const database = new TestSqlite();
    const scope = new SqliteScope(database);
    const unrelated = new TestSqlite();

    expect(hasSameSqliteProvenance(database, scope)).toBe(true);
    expect(hasSameSqliteProvenance(database, unrelated)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(database, "all")).toMatchObject({
        configurable: false,
        writable: false
    });
    expect(Object.getOwnPropertyDescriptor(database, "run")).toMatchObject({
        configurable: false,
        writable: false
    });
});

class SqliteScope extends TransactionalSqlite {
    public constructor(source: TransactionalSqlite) {
        super({ source });
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return operation();
    }
}

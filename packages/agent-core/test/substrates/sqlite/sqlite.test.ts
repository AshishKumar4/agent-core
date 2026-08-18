import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../../src/actors";
import { AgentCoreError } from "../../../src/errors";
import {
    hasSameSqliteProvenance,
    isSqliteNumber,
    isSqliteText,
    ownSqliteMutations,
    TransactionalSqlite,
    withExclusiveSqliteMutation,
    type SqliteRow
} from "../../../src/substrates/sqlite/sqlite";
import { TestSqlite } from "../../helpers/sqlite";

const CREATE_ROWS = "CREATE TABLE rows (id TEXT PRIMARY KEY)";
const INSERT_ROW = "INSERT INTO rows (id) VALUES (?)";
const SELECT_ROWS = "SELECT id FROM rows ORDER BY id";
const OUTSIDE_AUTHORITY = "SQLite access outside the active storage mutation authority is forbidden";
const UNOWNED_VIEW = "SQLite mutation authority is not owned by this database view";

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

test("SQLite column predicates admit exactly their own storage class", { tags: "p2" }, () => {
    expect(isSqliteText("value")).toBe(true);
    expect(isSqliteText(1)).toBe(false);
    expect(isSqliteText(null)).toBe(false);
    expect(isSqliteText(undefined)).toBe(false);
    expect(isSqliteNumber(1)).toBe(true);
    expect(isSqliteNumber("1")).toBe(false);
    expect(isSqliteNumber(null)).toBe(false);
    expect(isSqliteNumber(undefined)).toBe(false);
});

test("a derived SQLite view wraps its source reader and writer with its own hooks", { tags: "p1" }, () => {
    const database = new TestSqlite();
    database.transaction(() => database.run(CREATE_ROWS, []));
    const observed: string[] = [];
    const hooked = new HookedSqlite(database, observed);

    hooked.run(INSERT_ROW, ["hooked"]);
    expect(hooked.all(SELECT_ROWS, [])).toEqual([{ id: "hooked", projected: 1 }]);
    expect(observed).toEqual([`run:${INSERT_ROW}`, `read:${SELECT_ROWS}`]);

    const plain = new SqliteScope(database);
    plain.run(INSERT_ROW, ["plain"]);
    expect(plain.all(SELECT_ROWS, [])).toEqual([{ id: "hooked" }, { id: "plain" }]);
    expect(observed).toHaveLength(2);
});

describe("SQLite mutation authority", () => {
    test(
        "owning a database's mutations mints capability views of one shared arbiter",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const owned = ownSqliteMutations(database);

            expect(owned).not.toBe(database);
            expect(ownSqliteMutations(owned)).toBe(owned);
            expect(hasSameSqliteProvenance(database, owned)).toBe(true);

            const second = ownSqliteMutations(database);
            expect(second).not.toBe(owned);
            owned.transaction(() => owned.run(CREATE_ROWS, []));
            withExclusiveSqliteMutation(second, (scope) => {
                scope.run(INSERT_ROW, ["second-view"]);
            });
            expect(owned.all(SELECT_ROWS, [])).toEqual([{ id: "second-view" }]);
        }
    );

    test("an exclusive mutation refuses a view that does not hold the authority", { tags: "p0" }, () => {
        const unowned = new AnonymousSqlite();
        unowned.run("INSERT unowned", []);
        expect(unowned.written).toEqual(["INSERT unowned"]);
        expectRefusal(() => withExclusiveSqliteMutation(unowned, () => undefined), UNOWNED_VIEW);

        const database = new TestSqlite();
        ownSqliteMutations(database);
        expectRefusal(() => withExclusiveSqliteMutation(database, () => undefined), UNOWNED_VIEW);
    });

    test("a nested exclusive mutation is refused on both entry paths", { tags: "p0" }, () => {
        const nestedTransaction = ownSqliteMutations(new TestSqlite());
        expectRefusal(
            () =>
                withExclusiveSqliteMutation(nestedTransaction, (scope) =>
                    scope.transaction(() => undefined)
                ),
            "Nested exclusive SQLite mutations are not supported"
        );

        const reentered = ownSqliteMutations(new TestSqlite());
        expectRefusal(
            () =>
                withExclusiveSqliteMutation(reentered, () =>
                    withExclusiveSqliteMutation(reentered, () => undefined)
                ),
            "Nested exclusive SQLite mutations are not supported"
        );
    });

    test(
        "a raw view cannot write once the database owns its mutation authority",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const owned = ownSqliteMutations(database);
            owned.transaction(() => owned.run(CREATE_ROWS, []));

            expectRefusal(
                () => database.run(INSERT_ROW, ["forged"]),
                "SQLite mutation requires its database-owned authority"
            );
            expect(owned.all(SELECT_ROWS, [])).toEqual([]);
        }
    );

    test(
        "a write outside the active authority poisons the mutation with one recorded failure",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const owned = ownSqliteMutations(database);
            owned.transaction(() => owned.run(CREATE_ROWS, []));
            let poisoned: AgentCoreError | undefined;
            let rethrown: AgentCoreError | undefined;

            expectRefusal(
                () =>
                    withExclusiveSqliteMutation(owned, (scope) => {
                        scope.run(INSERT_ROW, ["admitted"]);
                        poisoned = captureFailure(() => database.run(INSERT_ROW, ["forged"]));
                        rethrown = captureFailure(() => scope.run(INSERT_ROW, ["after-poison"]));
                    }),
                OUTSIDE_AUTHORITY
            );

            expect(rethrown).toBe(poisoned);
            expect(database.all(SELECT_ROWS, [])).toEqual([]);
        }
    );

    test(
        "a read outside the active authority poisons the mutation for its own scope too",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const owned = ownSqliteMutations(database);
            owned.transaction(() => owned.run(CREATE_ROWS, []));
            let poisoned: AgentCoreError | undefined;
            let rethrown: AgentCoreError | undefined;

            expectRefusal(
                () =>
                    withExclusiveSqliteMutation(owned, (scope) => {
                        expect(scope.all(SELECT_ROWS, [])).toEqual([]);
                        poisoned = captureFailure(() => database.all(SELECT_ROWS, []));
                        rethrown = captureFailure(() => scope.all(SELECT_ROWS, []));
                    }),
                OUTSIDE_AUTHORITY
            );

            expect(rethrown).toBe(poisoned);
        }
    );

    test("a view with no registered provenance holds no authority at all", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const impostor = new Proxy(database, {});
        const uninitialized = "SQLite capability is not initialized";

        expectRefusal(() => ownSqliteMutations(impostor), uninitialized);
        expectRefusal(() => withExclusiveSqliteMutation(impostor, () => undefined), uninitialized);
        expect(hasSameSqliteProvenance(impostor, database)).toBe(false);
    });

    test("views of one physical database share exactly one mutation authority", { tags: "p0" }, () => {
        const shared: PhysicalDatabase = { name: "shared" };
        const first = new SharedIdentitySqlite(shared);
        const second = new SharedIdentitySqlite(shared);
        expect(hasSameSqliteProvenance(first, second)).toBe(true);
        expect(
            hasSameSqliteProvenance(first, new SharedIdentitySqlite({ name: "other" }))
        ).toBe(false);
        expect(hasSameSqliteProvenance(first, new AnonymousSqlite())).toBe(false);

        const owned = ownSqliteMutations(first);
        expectRefusal(() => withExclusiveSqliteMutation(second, () => undefined), UNOWNED_VIEW);
        withExclusiveSqliteMutation(owned, (scope) => {
            scope.run("INSERT shared", []);
        });
        expect(first.written).toEqual(["INSERT shared"]);
        expect(second.written).toEqual([]);
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

class HookedSqlite extends TransactionalSqlite {
    public constructor(source: TransactionalSqlite, observed: string[]) {
        super({
            source,
            view: {
                beforeRead: (statement) => {
                    observed.push(`read:${statement}`);
                },
                projectRows: (_statement, rows) => rows.map((row) => ({ ...row, projected: 1 })),
                beforeRun: (statement) => {
                    observed.push(`run:${statement}`);
                }
            }
        });
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return operation();
    }
}

/** A database view whose physical identity is not shared with any other view. */
class AnonymousSqlite extends TransactionalSqlite {
    public readonly written: string[] = [];

    public constructor() {
        const written: string[] = [];
        super({
            read: (): readonly SqliteRow[] => [],
            write: (statement: string): void => {
                written.push(statement);
            }
        });
        this.written = written;
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return operation();
    }
}

/**
 * The physical database two views are views of. Provenance is keyed by reference identity, so
 * the token carries no data: what matters is that both views name the same one.
 */
interface PhysicalDatabase {
    readonly name: string;
}

/** Two of these over one identity are two views of the same physical database. */
class SharedIdentitySqlite extends TransactionalSqlite {
    public readonly written: string[] = [];

    public constructor(identity: PhysicalDatabase) {
        const written: string[] = [];
        super({
            read: (): readonly SqliteRow[] => [],
            write: (statement: string): void => {
                written.push(statement);
            },
            identity
        });
        this.written = written;
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return operation();
    }
}

function captureFailure(operation: () => void): AgentCoreError {
    try {
        operation();
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw error;
    }
    throw new TypeError("Expected the SQLite authority to refuse this access");
}

function expectRefusal(operation: () => void, message: string): void {
    const error = captureFailure(operation);
    expect(error.code).toBe("protocol.invalid-state");
    expect(error.message).toBe(message);
}

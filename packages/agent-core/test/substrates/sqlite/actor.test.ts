import { describe, expect, test } from "vitest";
import { ActorId, ActorRecoveryState, ActorRef } from "../../../src/actors";
import {
    SqliteActorStore,
    TransactionalSqlite,
    type SqliteValue
} from "../../../src/substrates/sqlite";
import { TestSqlite } from "../../helpers/sqlite";

const actor = new ActorRef("run", new ActorId("sqlite-actor-store"));
const foreignActor = new ActorRef("run", new ActorId("sqlite-actor-foreign"));

const isolationError = expect.objectContaining({
    code: "protocol.invalid-state",
    message: "SQLite ActorStore is bound to a different Actor"
});

const nestedError = expect.objectContaining({
    code: "protocol.invalid-state",
    message: "Nested actor transactions are not supported"
});

describe("SQLite Actor store", () => {
    test("rebinding a different Actor reports the exact isolation error", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        store.bindActor(actor);

        expect(() => store.bindActor(foreignActor)).toThrow(isolationError);
        expect(database.all("SELECT actor_kind, actor_id FROM actor_identity", [])).toEqual([
            { actor_kind: "run", actor_id: "sqlite-actor-store" }
        ]);
    });

    test("fails closed when identity persistence is silently dropped", { tags: "p0" }, () => {
        const store = new SqliteActorStore(new DroppedIdentitySqlite());

        expect(() => store.bindActor(actor)).toThrow(isolationError);
    });

    test("names every nested-transaction rejection exactly", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        const sibling = new SqliteActorStore(database);
        store.bindActor(actor);

        store.transaction((transaction) => {
            expect(() => store.transaction(() => undefined)).toThrow(nestedError);
            expect(() => sibling.bindActor(actor)).toThrow(nestedError);
            expect(() => transaction.transaction(() => undefined)).toThrow(nestedError);
            return undefined;
        });
    });

    test("names stale-transaction rejections exactly", { tags: "p1" }, () => {
        const store = new SqliteActorStore(new TestSqlite());
        const foreignStore = new SqliteActorStore(new TestSqlite());
        store.bindActor(actor);
        foreignStore.bindActor(actor);

        store.transaction((transaction) => {
            expect(() => foreignStore.read(transaction, () => undefined)).toThrow(
                expect.objectContaining({
                    code: "actor.stale-callback",
                    message: "Protocol reads require the active SQLite actor transaction"
                })
            );
            expect(() => foreignStore.loadRecoveryState(transaction, actor)).toThrow(
                expect.objectContaining({
                    code: "actor.stale-callback",
                    message: "Actor recovery state requires the active SQLite transaction"
                })
            );
            return undefined;
        });
    });

    test("rejects recovery state saved for a foreign Actor", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        store.bindActor(actor);

        store.transaction((transaction) => {
            expect(() =>
                store.saveRecoveryState(transaction, ActorRecoveryState.initial(foreignActor))
            ).toThrow(isolationError);
            store.saveRecoveryState(transaction, ActorRecoveryState.initial(actor));
            return undefined;
        });

        expect(
            database
                .all("SELECT actor_id FROM actor_recovery_state ORDER BY actor_id", [])
                .map((row) => row["actor_id"])
        ).toEqual(["sqlite-actor-store"]);
    });

    test("closed Actor transaction scopes report their exact error", { tags: "p1" }, () => {
        const store = new SqliteActorStore(new TestSqlite());
        store.bindActor(actor);
        let escaped: TransactionalSqlite | undefined;
        store.transaction((transaction) => {
            escaped = transaction;
            return undefined;
        });

        expect(() => escaped?.all("SELECT 1", [])).toThrow(
            expect.objectContaining({
                code: "actor.closed",
                message: "Actor transaction is no longer active"
            })
        );
    });

    test("read scopes trim statements and reject non-SELECT exactly", { tags: "p0" }, () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE read_probe (value INTEGER NOT NULL)", []);
        database.run("INSERT INTO read_probe (value) VALUES (7)", []);
        const store = new SqliteActorStore(database);
        store.bindActor(actor);

        store.transaction((transaction) => {
            expect(
                store.read(
                    transaction,
                    (read) => read.all("  \n SELECT value FROM read_probe;", [])[0]?.["value"]
                )
            ).toBe(7);
            expect(() =>
                store.read(transaction, (read) =>
                    read.all("DELETE FROM read_probe WHERE value IN (SELECT value FROM read_probe)", [])
                )
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Actor read scopes accept one SELECT statement only"
                })
            );
            return undefined;
        });
        expect(database.all("SELECT value FROM read_probe", [])[0]?.["value"]).toBe(7);
    });

    test("activation without recovery state reports the exact codec error", { tags: "p1" }, () => {
        const store = new SqliteActorStore(new TestSqlite());
        store.bindActor(actor);

        expect(() => store.activateActor(actor, () => undefined)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Existing Actor storage is missing recovery state"
            })
        );
    });

    test("non-byte recovery state storage reports the exact codec error", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteActorStore(database);
        store.bindActor(actor);
        database.run(
            "INSERT INTO actor_recovery_state (actor_kind, actor_id, state) VALUES (?, ?, ?)",
            [actor.kind, actor.id.value, "not recovery bytes"]
        );

        expect(() =>
            store.transaction((transaction) => store.loadRecoveryState(transaction, actor))
        ).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Actor recovery state storage is malformed"
            })
        );
    });
});

class DroppedIdentitySqlite extends TestSqlite {
    public override run(statement: string, bindings: readonly SqliteValue[]): void {
        if (statement.includes("INSERT OR IGNORE INTO actor_identity")) return;
        super.run(statement, bindings);
    }
}

import { expect, test } from "vitest";
import {
    Actor,
    type ActorContext,
    type ActorFence,
    type ActorLocalStore,
    type ActorRef
} from "../../src/actors";
import type { ReadableSqlite, TransactionalSqlite } from "../../src/substrates";

abstract class TypedActor extends Actor<unknown> {
    public promiseCallbackMustFail(): Promise<unknown> {
        // @ts-expect-error Actor transaction callbacks must be synchronous.
        return this.execute(async () => Promise.resolve());
    }

    public customThenableCallbackMustFail(thenable: PromiseLike<string>): Promise<unknown> {
        // @ts-expect-error Actor transaction callbacks must be synchronous.
        return this.execute(() => thenable);
    }

    public unionCallbackMustFail(asynchronous: boolean): Promise<unknown> {
        // @ts-expect-error Actor transaction callbacks must be synchronous.
        return this.execute(() => (asynchronous ? Promise.resolve("async") : "sync"));
    }
}

function publicRawMutationMustFail(actor: Actor<unknown>): Promise<unknown> {
    // @ts-expect-error Actor command submission is protected.
    return actor.execute(() => undefined);
}

function genericLocalStoreNeedsNarrowing<TTransaction>(
    actor: ActorRef,
    store: ActorLocalStore<TTransaction>
): void {
    // @ts-expect-error ActorContext requires atomic activation storage.
    const context: ActorContext<TTransaction> = { actor, store };
    void context;
}

function publicFenceIsAsynchronous(actor: Actor<unknown>): Promise<ActorFence> {
    return actor.currentFence();
}

function sqlitePromiseCallbackMustFail(database: TransactionalSqlite): Promise<unknown> {
    // @ts-expect-error SQLite transaction callbacks must be synchronous.
    return database.transaction(async () => Promise.resolve());
}

function protocolReadCannotWrite(database: ReadableSqlite): void {
    // @ts-expect-error Protocol gate reads do not expose SQLite mutation.
    database.run("DELETE FROM records", []);
}

test("rejects all asynchronous callback result types at compile time", () => {
    expect(TypedActor.prototype.promiseCallbackMustFail).toBeTypeOf("function");
    expect(TypedActor.prototype.customThenableCallbackMustFail).toBeTypeOf("function");
    expect(TypedActor.prototype.unionCallbackMustFail).toBeTypeOf("function");
    expect(publicRawMutationMustFail).toBeTypeOf("function");
    expect(genericLocalStoreNeedsNarrowing).toBeTypeOf("function");
    expect(publicFenceIsAsynchronous).toBeTypeOf("function");
    expect(sqlitePromiseCallbackMustFail).toBeTypeOf("function");
    expect(protocolReadCannotWrite).toBeTypeOf("function");
});

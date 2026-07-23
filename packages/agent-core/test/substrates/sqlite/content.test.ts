import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../../src/actors";
import { ContentRef, Digest } from "../../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../../src/errors";
import {
    SqliteContentStore,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../../src/substrates/sqlite";
import { at, contentOwner } from "../../content/retention-contract";
import { TestSqlite } from "../../helpers/sqlite";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

class InterceptingSqlite extends TransactionalSqlite {
    public mutateRows:
        | ((statement: string, rows: readonly SqliteRow[]) => readonly SqliteRow[])
        | undefined;

    public constructor(public readonly inner: TestSqlite = new TestSqlite()) {
        super();
    }

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = this.inner.all(statement, bindings);
        return this.mutateRows?.(statement, rows) ?? rows;
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.inner.run(statement, bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.inner.transaction(operation, ...([] as SynchronousResultGuard<Result>));
    }
}

async function expectExactRejection(
    operation: Promise<unknown>,
    code: AgentCoreErrorCode,
    message: string
): Promise<void> {
    let failure: unknown;
    try {
        await operation;
    } catch (error) {
        failure = error;
    }
    expect(failure).toBeInstanceOf(AgentCoreError);
    expect(failure).toMatchObject({ code, message });
}

describe("SQLite content store", () => {
    test("reports the exact diagnostic for every malformed blob column", { tags: "p1" }, async () => {
        const corruptions: readonly [column: string, value: SqliteValue, message: string][] = [
            ["ref", 1, "Expected string column: ref"],
            ["media_type", 1, "Expected nullable string column: media_type"],
            ["bytes", "not-bytes", "Expected byte column: bytes"],
            ["size", -1, "Expected non-negative safe integer column: size"],
            ["size", "1", "Expected non-negative safe integer column: size"],
            ["size", 1.5, "Expected non-negative safe integer column: size"]
        ];
        for (const [name, value, message] of corruptions) {
            const database = new InterceptingSqlite();
            const store = new SqliteContentStore(database);
            const stored = await store.put(encode("column-shape"));
            database.mutateRows = (statement, rows) =>
                statement.includes("FROM content_blobs")
                    ? rows.map((row) => ({ ...row, [name]: value }))
                    : rows;
            await expectExactRejection(store.get(stored.ref), "codec.invalid", message);
        }
    });

    test("round-trips empty content with the exact address", { tags: "p2" }, async () => {
        const database = new TestSqlite();
        const store = new SqliteContentStore(database);
        const expectedRef = new ContentRef(`sha256:${EMPTY_SHA256}`);
        const stored = await store.put(new Uint8Array(0));
        expect(stored).toEqual({ ref: expectedRef, digest: new Digest(EMPTY_SHA256) });
        await expect(store.get(stored.ref)).resolves.toEqual(new Uint8Array(0));
        await expect(store.stat(stored.ref)).resolves.toEqual({
            ref: expectedRef,
            digest: new Digest(EMPTY_SHA256),
            size: 0,
            hint: undefined
        });
    });

    test("reports the exact missing-content message", { tags: "p1" }, async () => {
        const store = new SqliteContentStore(new TestSqlite());
        const missing = ContentRef.fromDigest(Digest.sha256(encode("absent")));
        await expectExactRejection(
            store.get(missing),
            "content.not-found",
            `Content not found: ${missing.value}`
        );
    });

    test("validates every stored blob during retention state checks", { tags: "p1" }, async () => {
        const database = new TestSqlite();
        const store = new SqliteContentStore(database);
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const stored = await store.put(encode("orphan-audit"));
        database.run("UPDATE content_blobs SET size = size + 1 WHERE ref = ?", [stored.ref.value]);
        let failure: unknown;
        try {
            database.transaction(() =>
                retention.collect(database, { allowsCollection: () => true }, at(10))
            );
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(AgentCoreError);
        expect(failure).toMatchObject({
            code: "codec.invalid",
            message: "Stored content is malformed"
        });
    });
});

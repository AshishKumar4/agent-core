import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import { InvalidationWatermark, ScopeEpoch, watermarkKey } from "../../../src/authority";
import { Revision } from "../../../src/core";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    TenantId,
    WorkspaceId
} from "../../../src/identity";
import { SqliteInvalidationWatermarkStore } from "../../../src/substrates/sqlite/watermark";
import type { SqliteRow, SqliteValue } from "../../../src/substrates/sqlite";
import { TestSqlite } from "../../helpers/sqlite";

const tenant = new TenantId("tenant-watermark-mutants");
const scope = ScopeRef.workspace(tenant, new WorkspaceId("workspace-watermark-mutants"));
const owner = new ActorRef("workspace", new ActorId("watermark-owner-actor"));
const holder = new PrincipalRef(tenant, new PrincipalId("principal-watermark-mutants"));
const watermark = InvalidationWatermark.empty(tenant, owner, holder);
const key = watermarkKey(watermark);

describe("SQLite watermark store exact failure and persistence behavior", () => {
    test("wraps schema bootstrap faults as an exact revision conflict", { tags: "p1" }, () => {
        const database = new FailingSchemaSqlite();

        expect(() => new SqliteInvalidationWatermarkStore(database, tenant, owner)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Watermark schema initialization failed"
            })
        );
    });

    test("wraps foreign insert faults as an exact watermark write failure", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteInvalidationWatermarkStore(database, tenant, owner);
        database.run(
            `CREATE TRIGGER fail_watermark_insert BEFORE INSERT ON actor_invalidation_watermarks
             BEGIN SELECT RAISE(ABORT, 'injected insert fault'); END`,
            []
        );

        expect(() => store.save(watermark)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Watermark write failed"
            })
        );
        expect(store.load(key)).toBeUndefined();
    });

    test("rejects watermarks of another Actor with the exact code", { tags: "p0" }, () => {
        const store = new SqliteInvalidationWatermarkStore(new TestSqlite(), tenant, owner);
        const foreign = InvalidationWatermark.empty(
            tenant,
            new ActorRef("workspace", new ActorId("other-watermark-actor")),
            holder
        );

        expect(() => store.save(foreign)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Watermark belongs to another Actor store"
            })
        );
    });

    test("requires revision zero for new watermarks", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteInvalidationWatermarkStore(database, tenant, owner);
        const advanced = new InvalidationWatermark(tenant, owner, holder, [], new Revision(1));

        expect(() => store.save(advanced)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "New watermarks require revision zero"
            })
        );
        expect(database.all("SELECT watermark_key FROM actor_invalidation_watermarks", [])).toEqual(
            []
        );
    });

    test("requires the exact next revision on watermark updates", { tags: "p0" }, () => {
        const store = new SqliteInvalidationWatermarkStore(new TestSqlite(), tenant, owner);
        store.save(watermark);
        const skipped = new InvalidationWatermark(
            tenant,
            owner,
            holder,
            [new ScopeEpoch(scope, 1)],
            new Revision(2)
        );

        expect(() => store.save(skipped)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Watermark updates require monotonic entries and the next revision"
            })
        );
        expect(store.load(key)?.revision.value).toBe(0);
    });

    test("reports a silently dropped insert as an exact concurrent change", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteInvalidationWatermarkStore(database, tenant, owner);
        database.run(
            `CREATE TRIGGER ignore_watermark_insert BEFORE INSERT ON actor_invalidation_watermarks
             BEGIN SELECT RAISE(IGNORE); END`,
            []
        );

        expect(() => store.save(watermark)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Watermark changed concurrently"
            })
        );
        expect(store.load(key)).toBeUndefined();
    });

    test("persists joins exactly once and keeps stale joins idempotent", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteInvalidationWatermarkStore(database, tenant, owner);
        store.save(watermark);

        const joined = store.join(key, [new ScopeEpoch(scope, 3)]);
        expect(joined.revision.value).toBe(1);
        expect(joined.epoch(scope)).toBe(3);

        const stale = store.join(key, [new ScopeEpoch(scope, 2)]);
        expect(stale.revision.value).toBe(1);
        expect(stale.epoch(scope)).toBe(3);

        const loaded = store.load(key);
        expect(loaded?.revision.value).toBe(1);
        expect(loaded?.epoch(scope)).toBe(3);
        const row = database.all(
            "SELECT revision FROM actor_invalidation_watermarks WHERE watermark_key = ?",
            [key]
        )[0];
        expect(row?.["revision"]).toBe(1);
    });

    test("requires initialization before join with the exact error", { tags: "p0" }, () => {
        const store = new SqliteInvalidationWatermarkStore(new TestSqlite(), tenant, owner);

        expect(() => store.join(key, [new ScopeEpoch(scope, 1)])).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Watermark must be initialized before join"
            })
        );
    });

    test("wraps foreign join faults as an exact join failure", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteInvalidationWatermarkStore(database, tenant, owner);
        store.save(watermark);
        database.run(
            `CREATE TRIGGER fail_watermark_update BEFORE UPDATE ON actor_invalidation_watermarks
             BEGIN SELECT RAISE(ABORT, 'injected update fault'); END`,
            []
        );

        expect(() => store.join(key, [new ScopeEpoch(scope, 5)])).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Watermark join failed"
            })
        );
        expect(store.load(key)?.revision.value).toBe(0);
        expect(store.load(key)?.epoch(scope)).toBe(0);
    });

    test("rejects every forged projection column as the exact malformed watermark", { tags: "p1" }, () => {
        const forgeries: readonly (readonly [string, SqliteValue])[] = [
            ["owner_tenant_id", "forged"],
            ["owner_kind", "run"],
            ["owner_id", "forged"],
            ["holder_tenant_id", "forged"],
            ["holder_principal_id", "forged"],
            ["revision", 7]
        ];

        for (const [column, value] of forgeries) {
            const database = new TestSqlite();
            const store = new SqliteInvalidationWatermarkStore(database, tenant, owner);
            store.save(watermark);
            database.run(`UPDATE actor_invalidation_watermarks SET ${column} = ?`, [value]);
            expect(() => store.load(key), column).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "Stored invalidation watermark is malformed"
                })
            );
        }
    });

    test("reports non-blob record bytes as the exact malformed watermark", { tags: "p1" }, () => {
        const database = new TamperedRecordSqlite();
        const store = new SqliteInvalidationWatermarkStore(database, tenant, owner);
        store.save(watermark);
        database.tampered = true;

        expect(() => store.load(key)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored invalidation watermark is malformed"
            })
        );
    });

    test("wraps raw read faults as the exact watermark read failure", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteInvalidationWatermarkStore(database, tenant, owner);
        database.run("DROP TABLE actor_invalidation_watermarks", []);

        expect(() => store.load(key)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Watermark read failed"
            })
        );
    });
});

class FailingSchemaSqlite extends TestSqlite {
    public run(statement: string, bindings: readonly SqliteValue[]): void {
        if (statement.includes("CREATE TABLE IF NOT EXISTS actor_invalidation_watermarks")) {
            throw new TypeError("injected schema fault");
        }
        super.run(statement, bindings);
    }
}

class TamperedRecordSqlite extends TestSqlite {
    public tampered = false;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        if (!this.tampered || !statement.includes("FROM actor_invalidation_watermarks")) {
            return rows;
        }
        return rows.map((row) => ({ ...row, record: "forged-record" }));
    }
}

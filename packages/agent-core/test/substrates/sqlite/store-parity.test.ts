import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import { ScopeEpoch } from "../../../src/authority";
import { PrincipalId, ScopeRef, TenantId, WorkspaceId } from "../../../src/identity";
import { PrincipalRef } from "../../identity/internal-fixture";
import {
    InvalidationWatermark,
    MemoryInvalidationWatermarkStore,
    watermarkKey,
    type InvalidationWatermarkStore
} from "../../authority/internal-fixture";
import { SqliteInvalidationWatermarkStore } from "../../../src/substrates/sqlite/watermark";
import { violating } from "../../helpers/malformed";
import { FileSqlite, TestSqlite } from "../../helpers/sqlite";

const tenant = new TenantId("tenant-store-parity");
const workspace = new WorkspaceId("workspace-store-parity");
const scope = ScopeRef.workspace(tenant, workspace);
const principal = new PrincipalRef(tenant, new PrincipalId("principal-store-parity"));
const owner = new ActorRef("workspace", new ActorId("workspace-actor"));
const holder = principal;
const watermark = InvalidationWatermark.empty(tenant, owner, holder);

describe.each([
    {
        name: "memory",
        watermarkStore: (): InvalidationWatermarkStore =>
            new MemoryInvalidationWatermarkStore(tenant, owner),
        write: (operation: () => void): void => operation()
    },
    {
        name: "SQLite",
        watermarkStore: (): InvalidationWatermarkStore =>
            new SqliteInvalidationWatermarkStore(new TestSqlite(), tenant, owner),
        write: (operation: () => void): void => operation()
    }
])("authority store parity: $name [invalidation-watermark-store]", (harness) => {
    test(
        "joins watermarks pointwise without decreasing or duplicating Scopes",
        { tags: "p0" },
        () => {
            const store = harness.watermarkStore();
            harness.write(() => store.save(watermark));
            const key = watermarkKey(watermark);
            harness.write(() => store.join(key, [new ScopeEpoch(scope, 3)]));
            harness.write(() => store.join(key, [new ScopeEpoch(scope, 2)]));

            expect(store.load(key)?.epoch(scope)).toBe(3);
            expect(store.load(key)?.revision.value).toBe(1);
            expect(() =>
                store.save(
                    InvalidationWatermark.empty(
                        tenant,
                        new ActorRef("workspace", new ActorId("other-actor")),
                        holder
                    )
                )
            ).toThrow(/another Actor/);
        }
    );
});

describe("memory invalidation watermark snapshot isolation", () => {
    test("detaches watermark bytes and rejects projection disagreement", { tags: "p0" }, () => {
        const watermarks = new MemoryInvalidationWatermarkStore(tenant, owner);
        expect(() => watermarks.save(watermark.join([new ScopeEpoch(scope, 1)]))).toThrow(
            /revision zero/
        );
        expect(() => watermarks.join(watermarkKey(watermark), [new ScopeEpoch(scope, 1)])).toThrow(
            /initialized/
        );
        watermarks.save(watermark);
        const advanced = watermarks.join(watermarkKey(watermark), [new ScopeEpoch(scope, 2)]);
        expect(() =>
            watermarks.save(
                new InvalidationWatermark(tenant, owner, holder, [], advanced.revision.next())
            )
        ).toThrow(/monotonic/);
        const watermarkSnapshot = watermarks.snapshot();
        const cleanWatermark = watermarks.snapshot();
        expect(
            () =>
                new MemoryInvalidationWatermarkStore(
                    tenant,
                    owner,
                    violating(cleanWatermark, { version: 2 })
                )
        ).toThrow(/malformed/);
        expect(
            () =>
                new MemoryInvalidationWatermarkStore(tenant, owner, {
                    ...cleanWatermark,
                    records: [cleanWatermark.records[0]!, cleanWatermark.records[0]!]
                })
        ).toThrow(/duplicate/);
        expect(
            () =>
                new MemoryInvalidationWatermarkStore(tenant, owner, {
                    ...cleanWatermark,
                    records: [{ ...cleanWatermark.records[0]!, key: "wrong-key" }]
                })
        ).toThrow(/does not match/);
        expect(
            () =>
                new MemoryInvalidationWatermarkStore(
                    tenant,
                    owner,
                    violating(cleanWatermark, { records: [null] })
                )
        ).toThrow(/record is malformed/);
        watermarkSnapshot.records[0]!.bytes.fill(0);
        expect(watermarks.load(watermarkKey(watermark))?.revision.value).toBe(
            advanced.revision.value
        );
        expect(
            () => new MemoryInvalidationWatermarkStore(tenant, owner, watermarkSnapshot)
        ).toThrow();
    });
});

describe("SQLite invalidation watermark corruption closure", () => {
    test("eagerly rejects a malformed watermark row on reopen", { tags: "p0" }, () => {
        const second = new TestSqlite();
        const watermarks = new SqliteInvalidationWatermarkStore(second, tenant, owner);
        watermarks.save(watermark);
        second.run("UPDATE actor_invalidation_watermarks SET record = ? WHERE watermark_key = ?", [
            Uint8Array.of(0),
            watermarkKey(watermark)
        ]);
        expect(() => new SqliteInvalidationWatermarkStore(second, tenant, owner)).toThrow(
            /malformed|canonical/
        );
    });
});

describe("SQLite invalidation watermark store restart", () => {
    test("reopens watermark codec bytes from a file", { tags: "p0" }, () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-w2-authority-"));
        const path = join(directory, "authority.sqlite");
        try {
            const first = new FileSqlite(path);
            const watermarks = new SqliteInvalidationWatermarkStore(first, tenant, owner);
            watermarks.save(watermark);
            watermarks.join(watermarkKey(watermark), [new ScopeEpoch(scope, 4)]);
            first.close();

            const reopened = new FileSqlite(path);
            expect(
                new SqliteInvalidationWatermarkStore(reopened, tenant, owner)
                    .load(watermarkKey(watermark))
                    ?.epoch(scope)
            ).toBe(4);
            reopened.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

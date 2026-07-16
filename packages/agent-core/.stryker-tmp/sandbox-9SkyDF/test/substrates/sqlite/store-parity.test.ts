// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import { Revision } from "../../../src/core";
import { BindingName, FacetRef, ProtectionDomain } from "../../../src/facets";
import { GrantId, ScopeEpoch } from "../../../src/authority";
import { PrincipalId, ScopeRef, SubjectRef, TenantId, WorkspaceId } from "../../../src/identity";
import { PrincipalRef } from "../../identity/internal-fixture";
import {
    Binding,
    InvalidationWatermark,
    MemoryBindingStore,
    MemoryInvalidationWatermarkStore,
    watermarkKey,
    type BindingStore,
    type InvalidationWatermarkStore
} from "../../authority/internal-fixture";
import { SqliteBindingStore } from "../../../src/substrates/sqlite/binding";
import { SqliteInvalidationWatermarkStore } from "../../../src/substrates/sqlite/watermark";
import { FileSqlite, TestSqlite } from "../../helpers/sqlite";

const tenant = new TenantId("tenant-store-parity");
const workspace = new WorkspaceId("workspace-store-parity");
const scope = ScopeRef.workspace(tenant, workspace);
const subject = SubjectRef.principal(new PrincipalId("principal-store-parity"));
const domain = new ProtectionDomain("backend", "parity", "no-secrets");
const binding = Binding.active(
    scope,
    subject,
    domain,
    new BindingName("mail"),
    new GrantId("grant"),
    new FacetRef("workspace:mail.instance")
);
const owner = new ActorRef("workspace", new ActorId("workspace-actor"));
const holder = new PrincipalRef(tenant, subject.principalId);
const watermark = InvalidationWatermark.empty(tenant, owner, holder);

describe.each([
    {
        name: "memory",
        bindingStore: (): BindingStore => new MemoryBindingStore(scope),
        watermarkStore: (): InvalidationWatermarkStore =>
            new MemoryInvalidationWatermarkStore(tenant, owner),
        write: (operation: () => void): void => operation()
    },
    {
        name: "SQLite",
        bindingStore: (): BindingStore => new SqliteBindingStore(new TestSqlite(), scope),
        watermarkStore: (): InvalidationWatermarkStore =>
            new SqliteInvalidationWatermarkStore(new TestSqlite(), tenant, owner),
        write: (operation: () => void): void => operation()
    }
])("authority store parity: $name [binding-store] [invalidation-watermark-store]", (harness) => {
    test("persists only monotonic Binding generations", () => {
        const store = harness.bindingStore();
        harness.write(() => store.save(binding));
        harness.write(() => store.save(binding));
        const replacement = binding.replace(
            new GrantId("grant-next"),
            new FacetRef("workspace:mail.next")
        );
        harness.write(() => store.save(replacement));

        expect(store.load(binding.key)?.generation).toBe(1);
        expect(store.list()).toHaveLength(1);
        expect(() =>
            store.save(
                new Binding(
                    scope,
                    subject,
                    domain,
                    binding.name,
                    binding.grantId,
                    binding.facet,
                    3,
                    "active",
                    new Revision(3)
                )
            )
        ).toThrow(/next generation|next generation and revision/);
        const otherScope = ScopeRef.workspace(tenant, new WorkspaceId("other-workspace"));
        expect(() =>
            store.save(
                Binding.active(
                    otherScope,
                    subject,
                    domain,
                    binding.name,
                    binding.grantId,
                    binding.facet
                )
            )
        ).toThrow(/another Workspace/);
    });

    test("joins watermarks pointwise without decreasing or duplicating Scopes", () => {
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
    });
});

describe("memory authority snapshot isolation", () => {
    test("detaches Binding and watermark bytes and rejects projection disagreement", () => {
        expect(() => new MemoryBindingStore(ScopeRef.tenant(tenant))).toThrow(TypeError);
        expect(() =>
            new MemoryBindingStore(scope).save(
                binding.replace(new GrantId("unstaged"), new FacetRef("workspace:unstaged"))
            )
        ).toThrow(/generation and revision zero/);
        const bindings = new MemoryBindingStore(scope);
        bindings.save(binding);
        const bindingSnapshot = bindings.snapshot();
        const cleanBinding = bindings.snapshot();
        expect(
            () =>
                new MemoryBindingStore(scope, {
                    ...cleanBinding,
                    records: [cleanBinding.records[0]!, cleanBinding.records[0]!]
                })
        ).toThrow(/duplicate/);
        expect(
            () =>
                new MemoryBindingStore(scope, {
                    ...cleanBinding,
                    records: [{ ...cleanBinding.records[0]!, key: "wrong-key" }]
                })
        ).toThrow(/does not match/);
        expect(
            () =>
                new MemoryBindingStore(scope, {
                    ...cleanBinding,
                    version: 2
                } as never)
        ).toThrow(/malformed/);
        expect(
            () =>
                new MemoryBindingStore(scope, {
                    version: 1,
                    records: [null as never]
                })
        ).toThrow(/record is malformed/);
        bindingSnapshot.records[0]!.bytes.fill(0);
        expect(bindings.load(binding.key)?.grantId.value).toBe("grant");
        expect(() => new MemoryBindingStore(scope, bindingSnapshot)).toThrow();

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
                new MemoryInvalidationWatermarkStore(tenant, owner, {
                    ...cleanWatermark,
                    version: 2
                } as never)
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
                new MemoryInvalidationWatermarkStore(tenant, owner, {
                    version: 1,
                    records: [null as never]
                })
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

describe("SQLite authority corruption closure", () => {
    test("eagerly rejects malformed Binding and watermark rows on reopen", () => {
        const database = new TestSqlite();
        const bindings = new SqliteBindingStore(database, scope);
        bindings.save(binding);
        database.run("UPDATE workspace_bindings SET record = ? WHERE binding_key = ?", [
            Uint8Array.of(0),
            binding.key
        ]);
        expect(() => new SqliteBindingStore(database, scope)).toThrow(/malformed|canonical/);

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

describe("SQLite authority store restart", () => {
    test("reopens Binding and watermark codec bytes from a file", () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-w2-authority-"));
        const path = join(directory, "authority.sqlite");
        try {
            const first = new FileSqlite(path);
            const bindings = new SqliteBindingStore(first, scope);
            const watermarks = new SqliteInvalidationWatermarkStore(first, tenant, owner);
            bindings.save(binding);
            watermarks.save(watermark);
            watermarks.join(watermarkKey(watermark), [new ScopeEpoch(scope, 4)]);
            first.close();

            const reopened = new FileSqlite(path);
            expect(new SqliteBindingStore(reopened, scope).load(binding.key)?.grantId.value).toBe(
                "grant"
            );
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

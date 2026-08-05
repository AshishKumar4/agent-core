import { describe, expect, test } from "vitest";
import { Binding, GrantId } from "../../../src/authority";
import { Revision } from "../../../src/core";
import { BindingName, FacetRef, ProtectionDomain } from "../../../src/facets";
import { PrincipalId, ScopeRef, SubjectRef, TenantId, WorkspaceId } from "../../../src/identity";
import { SqliteBindingStore } from "../../../src/substrates/sqlite/binding";
import type { SqliteRow, SqliteValue } from "../../../src/substrates/sqlite";
import { TestSqlite } from "../../helpers/sqlite";

const tenant = new TenantId("tenant-binding-mutants");
const scope = ScopeRef.workspace(tenant, new WorkspaceId("workspace-binding-mutants"));
const subject = SubjectRef.principal(new PrincipalId("principal-binding-mutants"));
const domain = new ProtectionDomain("backend", "mutants", "no-secrets");
const binding = Binding.active(
    scope,
    subject,
    domain,
    new BindingName("mail"),
    new GrantId("grant"),
    new FacetRef("workspace:mail.instance")
);

describe("SQLite Binding store exact failure and persistence behavior", () => {
    test("wraps schema bootstrap faults as an exact revision conflict", { tags: "p1" }, () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE workspace_binding_lookup (x INTEGER) STRICT", []);

        expect(() => new SqliteBindingStore(database, scope)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Binding schema initialization failed"
            })
        );
    });

    test("wraps foreign insert faults as an exact Binding write failure", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteBindingStore(database, scope);
        database.run(
            `CREATE TRIGGER fail_binding_insert BEFORE INSERT ON workspace_bindings
             BEGIN SELECT RAISE(ABORT, 'injected insert fault'); END`,
            []
        );

        expect(() => store.save(binding)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Binding write failed"
            })
        );
        expect(store.load(binding.key)).toBeUndefined();
    });

    test("rejects Bindings of another Workspace with the exact code", { tags: "p0" }, () => {
        const store = new SqliteBindingStore(new TestSqlite(), scope);
        const foreign = Binding.active(
            ScopeRef.workspace(tenant, new WorkspaceId("other-workspace")),
            subject,
            domain,
            binding.name,
            binding.grantId,
            binding.facet
        );

        expect(() => store.save(foreign)).toThrow(
            expect.objectContaining({
                code: "binding.invalid",
                message: "Binding belongs to another Workspace store"
            })
        );
        expect(store.list()).toEqual([]);
    });

    test("requires generation and revision zero independently for new Bindings", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteBindingStore(database, scope);
        const generationOne = new Binding(
            scope,
            subject,
            domain,
            binding.name,
            binding.grantId,
            binding.facet,
            1,
            "active",
            new Revision(0)
        );
        const revisionOne = new Binding(
            scope,
            subject,
            domain,
            binding.name,
            binding.grantId,
            binding.facet,
            0,
            "active",
            new Revision(1)
        );

        for (const candidate of [generationOne, revisionOne]) {
            expect(() => store.save(candidate), `generation ${candidate.generation}`).toThrow(
                expect.objectContaining({
                    code: "protocol.revision-conflict",
                    message: "New Bindings require generation and revision zero"
                })
            );
        }
        expect(store.list()).toEqual([]);
        expect(database.all("SELECT binding_key FROM workspace_bindings", [])).toEqual([]);
    });

    test("reports a silently dropped insert as an exact concurrent change", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteBindingStore(database, scope);
        database.run(
            `CREATE TRIGGER ignore_binding_insert BEFORE INSERT ON workspace_bindings
             BEGIN SELECT RAISE(IGNORE); END`,
            []
        );

        expect(() => store.save(binding)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Binding changed concurrently"
            })
        );
        expect(store.load(binding.key)).toBeUndefined();
    });

    test("reports a silently dropped update as an exact concurrent change", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteBindingStore(database, scope);
        store.save(binding);
        database.run(
            `CREATE TRIGGER ignore_binding_update BEFORE UPDATE ON workspace_bindings
             BEGIN SELECT RAISE(IGNORE); END`,
            []
        );
        const replacement = binding.replace(
            new GrantId("grant-next"),
            new FacetRef("workspace:mail.next")
        );

        expect(() => store.save(replacement)).toThrow(
            expect.objectContaining({
                code: "protocol.revision-conflict",
                message: "Binding changed concurrently"
            })
        );
        const kept = store.load(binding.key);
        expect(kept?.generation).toBe(0);
        expect(kept?.grantId.value).toBe("grant");
    });

    test("persists replacements with exact projected columns exactly once", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteBindingStore(database, scope);
        const replacement = binding.replace(
            new GrantId("grant-next"),
            new FacetRef("workspace:mail.next")
        );
        store.save(binding);
        store.save(replacement);
        store.save(replacement);

        const loaded = store.load(binding.key);
        expect(loaded?.generation).toBe(1);
        expect(loaded?.revision.value).toBe(1);
        expect(loaded?.grantId.value).toBe("grant-next");
        expect(loaded?.facet.value).toBe("workspace:mail.next");
        expect(loaded?.state).toBe("active");

        const rows = database.all(
            `SELECT grant_id, facet_ref, generation, revision, state
             FROM workspace_bindings`,
            []
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.["grant_id"]).toBe("grant-next");
        expect(rows[0]?.["facet_ref"]).toBe("workspace:mail.next");
        expect(rows[0]?.["generation"]).toBe(1);
        expect(rows[0]?.["revision"]).toBe(1);
        expect(rows[0]?.["state"]).toBe("active");
    });

    test("persists a same-length replacement instead of treating it as a no-op", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteBindingStore(database, scope);
        store.save(binding);
        const replacement = binding.replace(
            new GrantId("tnarg"),
            new FacetRef("workspace:mail.instance")
        );
        store.save(replacement);

        const loaded = store.load(binding.key);
        expect(loaded?.generation).toBe(1);
        expect(loaded?.revision.value).toBe(1);
        expect(loaded?.grantId.value).toBe("tnarg");
    });

    test("rejects every forged projection column as the exact malformed Binding", { tags: "p1" }, () => {
        const forgeries: readonly (readonly [string, SqliteValue])[] = [
            ["scope_key", "forged"],
            ["subject_key", "forged"],
            ["domain_key", "forged"],
            ["name", "forged"],
            ["grant_id", "forged"],
            ["facet_ref", "forged"],
            ["revision", 7],
            ["state", "inactive"]
        ];

        for (const [column, value] of forgeries) {
            const database = new TestSqlite();
            const store = new SqliteBindingStore(database, scope);
            store.save(binding);
            database.run(`UPDATE workspace_bindings SET ${column} = ?`, [value]);
            expect(() => store.load(binding.key), column).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "Stored Workspace Binding is malformed"
                })
            );
        }
    });

    test("fails closed on a text projection column that is not a string", { tags: "p1" }, () => {
        const database = new ProjectionTamperSqlite();
        const store = new SqliteBindingStore(database, scope);
        store.save(binding);
        database.replacement = ["state", null];

        expect(() => store.load(binding.key)).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test("detects a forged binding key through list", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteBindingStore(database, scope);
        store.save(binding);
        database.run("UPDATE workspace_bindings SET binding_key = 'forged-key'", []);

        expect(store.load(binding.key)).toBeUndefined();
        expect(() => store.list()).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored Workspace Binding is malformed"
            })
        );
    });

    test("reports non-blob record bytes as the exact malformed Binding", { tags: "p1" }, () => {
        const database = new TamperedRecordSqlite();
        const store = new SqliteBindingStore(database, scope);
        store.save(binding);
        database.tampered = true;

        expect(() => store.load(binding.key)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored Workspace Binding is malformed"
            })
        );
    });

    test("rejects a row fetched for another Binding key", { tags: "p0" }, () => {
        const database = new ProjectionTamperSqlite();
        const store = new SqliteBindingStore(database, scope);
        const sibling = Binding.active(
            scope,
            subject,
            domain,
            new BindingName("news"),
            binding.grantId,
            binding.facet
        );
        store.save(binding);
        store.save(sibling);
        database.redirectTo = sibling.key;

        expect(() => store.load(binding.key)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored Workspace Binding is malformed"
            })
        );
    });

    test("rejects a key column that drifts from the Binding it stores", { tags: "p0" }, () => {
        const database = new ProjectionTamperSqlite();
        const store = new SqliteBindingStore(database, scope);
        store.save(binding);
        database.replacement = ["binding_key", "drifted-key"];

        expect(() => store.load(binding.key)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored Workspace Binding is malformed"
            })
        );
    });

    test("fails closed on a text column that is not a string", { tags: "p1" }, () => {
        const database = new ProjectionTamperSqlite();
        const store = new SqliteBindingStore(database, scope);
        store.save(binding);
        database.replacement = ["scope_key", null];

        expect(() => store.load(binding.key)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored Workspace Binding is malformed"
            })
        );
    });

    test("persists a replacement that encodes to the previous byte length", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteBindingStore(database, scope);
        const replacement = binding.replace(new GrantId("grand"), binding.facet);
        expect(Binding.encode(replacement).byteLength).toBe(Binding.encode(binding).byteLength);
        store.save(binding);
        store.save(replacement);

        const loaded = store.load(binding.key);
        expect(loaded?.grantId.value).toBe("grand");
        expect(loaded?.generation).toBe(1);
        expect(loaded?.revision.value).toBe(1);
        const rows = database.all(
            "SELECT grant_id, generation, revision FROM workspace_bindings",
            []
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.["grant_id"]).toBe("grand");
        expect(rows[0]?.["generation"]).toBe(1);
        expect(rows[0]?.["revision"]).toBe(1);
    });

    test("wraps raw read faults as the exact Binding read failure", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = new SqliteBindingStore(database, scope);
        database.run("DROP TABLE workspace_bindings", []);

        expect(() => store.load(binding.key)).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Binding read failed"
            })
        );
    });
});

class ProjectionTamperSqlite extends TestSqlite {
    public redirectTo: string | undefined;
    public replacement: readonly [string, SqliteValue] | undefined;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const redirectTo = this.redirectTo;
        const rows = super.all(
            statement,
            redirectTo !== undefined && statement.includes("WHERE binding_key = ?")
                ? [redirectTo]
                : bindings
        );
        const replacement = this.replacement;
        if (replacement === undefined) return rows;
        return rows.map((row) => ({ ...row, [replacement[0]]: replacement[1] }));
    }
}

class TamperedRecordSqlite extends TestSqlite {
    public tampered = false;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        if (!this.tampered || !statement.includes("FROM workspace_bindings")) return rows;
        return rows.map((row) => ({ ...row, record: "forged-record" }));
    }
}

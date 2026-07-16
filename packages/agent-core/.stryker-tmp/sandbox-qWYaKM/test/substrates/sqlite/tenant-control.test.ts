// @ts-nocheck
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { Grant, GrantId } from "../../../src/authority";
import { CapabilitySpec } from "../../../src/facets";
import {
    ActorId,
    requireSynchronousResult,
    type SynchronousResultGuard
} from "../../../src/actors";
import { Revision } from "../../../src/core";
import { Principal, PrincipalId, ScopeRef, SubjectRef, TenantId } from "../../../src/identity";
import {
    SqliteIdentityReader,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../../src/substrates/sqlite";
import { createSqliteTenantControlStore } from "../../../src/substrates/sqlite/tenant";

const tenantId = new TenantId("tenant-control");
const principalId = new PrincipalId("principal-control");
const tenantScope = ScopeRef.tenant(tenantId);
const anchor = {
    actorId: new ActorId("tenant-control-actor"),
    tenantId,
    principalId,
    tenantKind: "organization" as const,
    trustAnchor: Uint8Array.of(3, 2, 1)
};

describe("SQLite Tenant control storage", () => {
    test("creates only the retained strict Tenant control schema", () => {
        const database = new TestSqlite();
        createSqliteTenantControlStore(database, anchor);
        const rows = database.all(
            `SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'tenant_%'
             ORDER BY name`,
            []
        );

        expect(rows.map((row) => row["name"])).toEqual([
            "tenant_bootstrap_anchor",
            "tenant_bootstrap_marker",
            "tenant_grants",
            "tenant_guest_trusts",
            "tenant_identities",
            "tenant_memberships",
            "tenant_principals",
            "tenant_projects",
            "tenant_roles",
            "tenant_scope_epochs",
            "tenant_teams",
            "tenant_workspaces"
        ]);
        for (const row of rows) {
            expect(row["sql"], String(row["name"])).toEqual(expect.stringMatching(/STRICT$/));
        }
        expect(tableNames(database)).not.toContain("tenant_authority_resolutions");
        expect(tableNames(database)).not.toContain("tenant_invalidation_watermarks");
        expect(tableNames(database)).not.toContain("workspace_binding_generations");
    });

    test("reopens a file with identity, Grant, epoch, anchor, and marker intact", () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-tenant-control-"));
        const path = join(directory, "tenant.sqlite");
        try {
            const firstDatabase = new FileSqlite(path);
            const first = createSqliteTenantControlStore(firstDatabase, anchor);
            const grant = allowGrant("file-grant");
            firstDatabase.transaction(() =>
                first.bootstrapTenant(firstDatabase, anchor, Revision.initial())
            );
            first.transaction(() => {
                first.putGrant(grant);
            });
            firstDatabase.close();

            const restartedDatabase = new FileSqlite(path);
            const restarted = createSqliteTenantControlStore(restartedDatabase);
            const reader = new SqliteIdentityReader(restartedDatabase);
            expect(reader.loadTenant(tenantId)?.kind).toBe("organization");
            expect(reader.loadPrincipal(principalId)?.kind).toBe("user");
            expect("savePrincipal" in reader).toBe(false);
            expect(restarted.grant(grant.id)?.isLive).toBe(true);
            expect(restarted.epoch(tenantScope).epoch).toBe(1);
            expect(restarted.bootstrapAnchor()?.actorId.equals(anchor.actorId)).toBe(true);
            expect(restarted.bootstrapMarker()?.ownerPrincipalId.equals(principalId)).toBe(true);
            expect(restarted.isBootstrapEligible()).toBe(false);
            restartedDatabase.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("rolls the complete resolver-input mutation back on failure", () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const addedPrincipal = new PrincipalId("rollback-principal");
        const grant = allowGrant("rollback-grant");

        expect(() =>
            store.transaction((transaction) => {
                transaction.putPrincipal(new Principal(addedPrincipal, "user", "active"));
                transaction.putGrant(grant);
                transaction.putEpoch(store.epoch(tenantScope).next());
                throw new TypeError("injected Tenant control fault");
            })
        ).toThrow("Tenant control write failed");

        expect(store.loadPrincipal(addedPrincipal)).toBeUndefined();
        expect(store.grant(grant.id)).toBeUndefined();
        expect(store.epoch(tenantScope).epoch).toBe(1);
        expect(store.isBootstrapEligible()).toBe(false);
    });

    test("rolls the complete bootstrap closure back when marker insertion fails", () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);

        expect(() =>
            database.transaction(() => {
                database.run(
                    `CREATE TRIGGER fail_tenant_bootstrap_marker
                 BEFORE INSERT ON tenant_bootstrap_marker
                 BEGIN SELECT RAISE(ABORT, 'injected marker fault'); END`,
                    []
                );
                store.bootstrapTenant(database, anchor, Revision.initial());
            })
        ).toThrow();

        expect(store.isBootstrapEligible()).toBe(true);
        expect(store.bootstrapMarker()).toBeUndefined();
        expect(store.loadTenant(tenantId)).toBeUndefined();
        expect(store.grants()).toEqual([]);
        expect(store.epoch(tenantScope).epoch).toBe(0);
    });

    test("rejects corrupted identity, authority, and bootstrap projections", () => {
        const identityDatabase = new TestSqlite();
        const identityStore = createSqliteTenantControlStore(identityDatabase, anchor);
        identityDatabase.transaction(() =>
            identityStore.bootstrapTenant(identityDatabase, anchor, Revision.initial())
        );
        identityDatabase.run("UPDATE tenant_principals SET status = 'disabled' WHERE id = ?", [
            principalId.value
        ]);
        expect(() => identityStore.loadPrincipal(principalId)).toThrow(
            expect.objectContaining({
                code: "codec.invalid"
            })
        );

        const authorityDatabase = new TestSqlite();
        const authorityStore = createSqliteTenantControlStore(authorityDatabase, anchor);
        authorityDatabase.transaction(() =>
            authorityStore.bootstrapTenant(authorityDatabase, anchor, Revision.initial())
        );
        const grant = allowGrant("corrupt-grant");
        authorityStore.transaction((store) => store.putGrant(grant));
        authorityDatabase.run("UPDATE tenant_grants SET state = 'revoked' WHERE id = ?", [
            grant.id.value
        ]);
        expect(() => authorityStore.grant(grant.id)).toThrow(
            expect.objectContaining({
                code: "codec.invalid"
            })
        );

        const anchorDatabase = new TestSqlite();
        const anchorStore = createSqliteTenantControlStore(anchorDatabase, anchor);
        anchorDatabase.run(
            "UPDATE tenant_bootstrap_anchor SET trust_anchor = ? WHERE singleton = 1",
            [Uint8Array.of(9)]
        );
        expect(() => anchorStore.bootstrapAnchor()).toThrow(
            expect.objectContaining({
                code: "codec.invalid"
            })
        );

        const relationDatabase = new TestSqlite();
        const relationStore = createSqliteTenantControlStore(relationDatabase, anchor);
        relationDatabase.transaction(() =>
            relationStore.bootstrapTenant(relationDatabase, anchor, Revision.initial())
        );
        const storedGrant = relationDatabase.all(
            "SELECT id, record FROM tenant_grants ORDER BY id LIMIT 1",
            []
        )[0]!;
        const decodedGrant = Grant.decode(storedGrant["record"] as Uint8Array);
        relationDatabase.run("UPDATE tenant_grants SET subject_key = ?, record = ? WHERE id = ?", [
            "principal:missing",
            Grant.encode(
                new Grant(
                    decodedGrant.id,
                    decodedGrant.scope,
                    SubjectRef.principal(new PrincipalId("missing-principal")),
                    decodedGrant.effect,
                    decodedGrant.capability,
                    decodedGrant.origin,
                    decodedGrant.attenuationOf
                )
            ),
            decodedGrant.id.value
        ]);
        expect(() => createSqliteTenantControlStore(relationDatabase)).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test("rejects a different anchor after restart", () => {
        const database = new TestSqlite();
        createSqliteTenantControlStore(database, anchor);

        expect(() =>
            createSqliteTenantControlStore(database, {
                ...anchor,
                trustAnchor: Uint8Array.of(9)
            })
        ).toThrow(expect.objectContaining({ code: "protocol.invalid-state" }));
    });
});

function allowGrant(id: string): Grant {
    return new Grant(
        new GrantId(id),
        tenantScope,
        SubjectRef.principal(principalId),
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        { kind: "direct" }
    );
}

function tableNames(database: TransactionalSqlite): readonly string[] {
    return database
        .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", [])
        .flatMap((row) => (typeof row["name"] === "string" ? [row["name"]] : []));
}

class TestSqlite extends TransactionalSqlite {
    readonly #database = new Database(":memory:");

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.query<SqliteRow, SqliteValue[]>(statement).all(...bindings);
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.query<SqliteRow, SqliteValue[]>(statement).run(...bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#database.transaction(() => requireSynchronousResult(operation()))();
    }
}

class FileSqlite extends TransactionalSqlite {
    readonly #database: DatabaseSync;

    public constructor(path: string) {
        super();
        this.#database = new DatabaseSync(path);
    }

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.prepare(statement).all(...bindings) as readonly SqliteRow[];
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.prepare(statement).run(...bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        this.#database.exec("BEGIN");
        try {
            const result = requireSynchronousResult(operation());
            this.#database.exec("COMMIT");
            return result;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }

    public close(): void {
        this.#database.close();
    }
}

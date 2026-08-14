import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
    AuthorityMutationService,
    Binding,
    BindingCredentialCustody,
    Grant,
    GrantId
} from "../../../src/authority";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../../src/facets";
import { ActorId } from "../../../src/actors";
import { Revision, SecretRef } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import {
    MembershipId,
    Principal,
    PrincipalId,
    PrincipalRef,
    Project,
    ProjectId,
    ScopeRef,
    SubjectRef,
    TenantId,
    Workspace,
    WorkspaceId
} from "../../../src/identity";
import {
    SqliteIdentityReader,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../../src/substrates/sqlite";
import { sqliteBytes, sqliteText } from "../../../src/substrates/sqlite/content";
import { createSqliteTenantControlStore } from "../../../src/substrates/sqlite/tenant";
import { FileSqlite, TestSqlite } from "../../helpers/sqlite";

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
    test("creates only the retained strict Tenant control schema", { tags: "p1" }, () => {
        const database = new TestSqlite();
        createSqliteTenantControlStore(database, anchor);
        const rows = database.all(
            `SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'tenant_%'
             ORDER BY name`,
            []
        );

        expect(rows.map((row) => row["name"])).toEqual([
            "tenant_bindings",
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

    test(
        "reopens a file with identity, Binding, Grant, epoch, anchor, and marker intact",
        { tags: "p0" },
        () => {
            const directory = mkdtempSync(join(tmpdir(), "agent-core-tenant-control-"));
            const path = join(directory, "tenant.sqlite");
            try {
                const firstDatabase = new FileSqlite(path);
                const first = createSqliteTenantControlStore(firstDatabase, anchor);
                firstDatabase.transaction(() =>
                    first.bootstrapTenant(firstDatabase, anchor, Revision.initial())
                );
                const service = new AuthorityMutationService(first);
                const workspace = new Workspace(
                    new WorkspaceId("file-workspace"),
                    tenantId,
                    undefined,
                    Revision.initial()
                );
                service.createWorkspace(workspace);
                const grant = new Grant(
                    new GrantId("file-grant"),
                    workspace.scope,
                    SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                    { kind: "direct" }
                );
                service.createGrant(grant);
                const binding = Binding.active(
                    workspace.scope,
                    grant.subject,
                    new ProtectionDomain("backend", "file", "no-secrets"),
                    new BindingName("file-binding"),
                    grant.id,
                    new FacetRef("core:file")
                );
                service.createBinding(binding);
                firstDatabase.close();

                const restartedDatabase = new FileSqlite(path);
                const restarted = createSqliteTenantControlStore(restartedDatabase);
                const reader = new SqliteIdentityReader(restartedDatabase);
                expect(reader.loadTenant(tenantId)?.kind).toBe("organization");
                expect(reader.loadPrincipal(principalId)?.kind).toBe("user");
                expect("savePrincipal" in reader).toBe(false);
                expect(restarted.grant(grant.id)?.isLive).toBe(true);
                expect(restarted.binding(binding.key)?.grantId.equals(grant.id)).toBe(true);
                expect(restarted.epoch(tenantScope).epoch).toBe(1);
                expect(restarted.bootstrapAnchor()?.actorId.equals(anchor.actorId)).toBe(true);
                expect(restarted.bootstrapMarker()?.ownerPrincipalId.equals(principalId)).toBe(
                    true
                );
                expect(restarted.isBootstrapEligible()).toBe(false);
                restartedDatabase.close();
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        }
    );

    test(
        "[C13-CONFIG-SECRET-CUSTODY] preserves Binding custody through replacement and file restart",
        { tags: "p0" },
        () => {
            const directory = mkdtempSync(join(tmpdir(), "agent-core-credential-custody-"));
            const path = join(directory, "tenant.sqlite");
            try {
                const firstDatabase = new FileSqlite(path);
                const first = createSqliteTenantControlStore(firstDatabase, anchor);
                firstDatabase.transaction(() =>
                    first.bootstrapTenant(firstDatabase, anchor, Revision.initial())
                );
                const service = new AuthorityMutationService(first);
                const workspace = new Workspace(
                    new WorkspaceId("credential-custody-file-workspace"),
                    tenantId,
                    undefined,
                    Revision.initial()
                );
                service.createWorkspace(workspace);
                const grant = new Grant(
                    new GrantId("credential-custody-file-grant"),
                    workspace.scope,
                    SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                    "allow",
                    new CapabilitySpec({ facetPattern: "*", impacts: ["externalSend"] }),
                    { kind: "direct" }
                );
                service.createGrant(grant);
                const credential = new SecretRef(tenantId.value, "vault", "file-token");
                const endpoint = "https://custody.example/v1/send";
                const binding = Binding.active(
                    workspace.scope,
                    grant.subject,
                    new ProtectionDomain("backend", "credential-custody-file", "may-hold-secrets"),
                    new BindingName("credential-custody-file"),
                    grant.id,
                    new FacetRef("core:credential-custody-file"),
                    [new BindingCredentialCustody(credential, endpoint)]
                );
                service.createBinding(binding);
                const preserved = service.replaceBinding(binding.key, grant.id, binding.facet);
                const beforeRollbackEpoch = first.epoch(workspace.scope);
                firstDatabase.run(
                    `CREATE TRIGGER fail_custody_epoch_update
                     BEFORE UPDATE ON tenant_scope_epochs
                     BEGIN SELECT RAISE(ABORT, 'injected custody epoch fault'); END`,
                    []
                );
                const rotated = new SecretRef(tenantId.value, "vault", "rotated-file-token");
                const rotatedEndpoint = "https://custody.example/v2/send";
                const rotatedCustody = [new BindingCredentialCustody(rotated, rotatedEndpoint)];
                let rollbackFailure: unknown;
                try {
                    service.replaceBinding(binding.key, grant.id, binding.facet, rotatedCustody);
                } catch (error) {
                    rollbackFailure = error;
                }
                expect(rollbackFailure).toBeInstanceOf(AgentCoreError);
                if (rollbackFailure instanceof AgentCoreError) {
                    expect(rollbackFailure.code).toBe("protocol.revision-conflict");
                }
                expect(first.binding(binding.key)?.toData()).toEqual(preserved.toData());
                expect(first.epoch(workspace.scope).equals(beforeRollbackEpoch)).toBe(true);
                firstDatabase.run("DROP TRIGGER fail_custody_epoch_update", []);
                const replacement = service.replaceBinding(
                    binding.key,
                    grant.id,
                    binding.facet,
                    rotatedCustody
                );
                expect(replacement.generation).toBe(preserved.generation + 1);
                expect(replacement.revision.value).toBe(preserved.revision.value + 1);
                expect(first.epoch(workspace.scope).epoch).toBe(beforeRollbackEpoch.epoch + 1);
                firstDatabase.close();

                const restartedDatabase = new FileSqlite(path);
                const restarted = createSqliteTenantControlStore(restartedDatabase);
                const restored = restarted.binding(binding.key);
                expect(restored?.toData()).toEqual(replacement.toData());
                expect(restored?.hasCredentialCustody(credential, endpoint)).toBe(false);
                expect(restored?.hasCredentialCustody(rotated, rotatedEndpoint)).toBe(true);
                restartedDatabase.close();
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        }
    );

    test("stores the same Binding identity independently in two Workspaces", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const service = new AuthorityMutationService(store);
        const subject = SubjectRef.principal(new PrincipalRef(tenantId, principalId));
        const domain = new ProtectionDomain("backend", "shared", "no-secrets");
        const name = new BindingName("shared-binding");
        const facet = new FacetRef("core:shared");

        for (const ordinal of [1, 2]) {
            const workspace = new Workspace(
                new WorkspaceId(`binding-workspace-${ordinal}`),
                tenantId,
                undefined,
                Revision.initial()
            );
            service.createWorkspace(workspace);
            const grant = new Grant(
                new GrantId(`binding-grant-${ordinal}`),
                workspace.scope,
                subject,
                "allow",
                new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                { kind: "direct" }
            );
            service.createGrant(grant);
            service.createBinding(
                Binding.active(workspace.scope, subject, domain, name, grant.id, facet)
            );
        }

        expect(store.bindings()).toHaveLength(2);
        expect(new Set(store.bindings().map((binding) => binding.key)).size).toBe(2);
    });

    test("rolls the complete resolver-input mutation back on failure", { tags: "p0" }, () => {
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

    test(
        "rolls the complete bootstrap closure back when marker insertion fails",
        { tags: "p0" },
        () => {
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
        }
    );

    test("rejects corrupted identity, authority, and bootstrap projections", { tags: "p0" }, () => {
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

        const bindingDatabase = new TestSqlite();
        const bindingStore = createSqliteTenantControlStore(bindingDatabase, anchor);
        bindingDatabase.transaction(() =>
            bindingStore.bootstrapTenant(bindingDatabase, anchor, Revision.initial())
        );
        const service = new AuthorityMutationService(bindingStore);
        const workspace = new Workspace(
            new WorkspaceId("corrupt-binding-workspace"),
            tenantId,
            undefined,
            Revision.initial()
        );
        service.createWorkspace(workspace);
        const bindingGrant = new Grant(
            new GrantId("corrupt-binding-grant"),
            workspace.scope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            { kind: "direct" }
        );
        service.createGrant(bindingGrant);
        const binding = Binding.active(
            workspace.scope,
            bindingGrant.subject,
            new ProtectionDomain("backend", "corrupt", "no-secrets"),
            new BindingName("corrupt-binding"),
            bindingGrant.id,
            new FacetRef("core:corrupt")
        );
        service.createBinding(binding);
        bindingDatabase.run("UPDATE tenant_bindings SET generation = 7 WHERE binding_key = ?", [
            binding.key
        ]);
        expect(() => bindingStore.binding(binding.key)).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
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
        const decodedGrant = Grant.decode(sqliteBytes(storedGrant, "record"));
        relationDatabase.run("UPDATE tenant_grants SET subject_key = ?, record = ? WHERE id = ?", [
            "principal:missing",
            Grant.encode(
                new Grant(
                    decodedGrant.id,
                    decodedGrant.scope,
                    SubjectRef.principal(
                        new PrincipalRef(tenantId, new PrincipalId("missing-principal"))
                    ),
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

    test("rejects a different anchor after restart", { tags: "p0" }, () => {
        const database = new TestSqlite();
        createSqliteTenantControlStore(database, anchor);

        expect(() =>
            createSqliteTenantControlStore(database, {
                ...anchor,
                trustAnchor: Uint8Array.of(9)
            })
        ).toThrow(expect.objectContaining({ code: "protocol.invalid-state" }));
    });

    test("reports a suppressed anchor insert as the exact invalid state", { tags: "p0" }, () => {
        const database = new TestSqlite();
        createSqliteTenantControlStore(database, anchor);
        database.run("DELETE FROM tenant_bootstrap_anchor", []);
        database.run(
            `CREATE TRIGGER ignore_anchor_insert BEFORE INSERT ON tenant_bootstrap_anchor
             BEGIN SELECT RAISE(IGNORE); END`,
            []
        );

        expect(() => createSqliteTenantControlStore(database, anchor)).toThrow(
            expect.objectContaining({ code: "protocol.invalid-state" })
        );
    });

    test("bootstraps with an anchor that omits the tenant kind", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const kindless = {
            actorId: new ActorId("tenant-control-actor"),
            tenantId,
            principalId,
            trustAnchor: Uint8Array.of(3, 2, 1)
        };
        const store = createSqliteTenantControlStore(database, kindless);
        database.transaction(() => store.bootstrapTenant(database, kindless, Revision.initial()));

        expect(store.bootstrapMarker()?.tenantId.equals(tenantId)).toBe(true);
        expect(store.loadTenant(tenantId)?.kind).toBe("personal");
    });

    test("fails closed on a null bootstrap marker projection column", { tags: "p1" }, () => {
        const database = new MarkerTamperSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        database.tampered = true;

        expect(() => store.bootstrapMarker()).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test("rejects Grants for a Project Scope that is not stored", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const grant = new Grant(
            new GrantId("project-scope-grant"),
            ScopeRef.project(tenantId, new ProjectId("missing-project")),
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
            { kind: "direct" }
        );

        expect(() => store.transaction((transaction) => transaction.putGrant(grant))).toThrow(
            expect.objectContaining({ code: "protocol.invalid-state" })
        );
        expect(store.grant(grant.id)).toBeUndefined();
    });

    test("reconstruction rejects an unreferenced corrupt principal row", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        database.run(
            `INSERT INTO tenant_principals (id, kind, status, record)
             VALUES ('ghost-principal', 'user', 'active', ?)`,
            [Uint8Array.of(1, 2, 3)]
        );

        expect(() => createSqliteTenantControlStore(database)).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test("reconstruction rejects an unreferenced corrupt role row", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        database.run("INSERT INTO tenant_roles (name, record) VALUES ('ghost-role', ?)", [
            Uint8Array.of(1, 2, 3)
        ]);

        expect(() => createSqliteTenantControlStore(database)).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test("reconstruction rejects a Project row of a foreign Tenant", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const foreign = new Project(
            new ProjectId("ghost-project"),
            new TenantId("foreign-tenant"),
            "Ghost",
            Revision.initial()
        );
        database.run(
            `INSERT INTO tenant_projects (id, tenant_id, revision, record)
             VALUES (?, ?, ?, ?)`,
            [foreign.id.value, foreign.tenantId.value, 0, Project.encode(foreign)]
        );

        expect(() => createSqliteTenantControlStore(database)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Project belongs to another Tenant"
            })
        );
    });

    test("reconstruction rejects an attenuation the parent cannot cover", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = createSqliteTenantControlStore(database, anchor);
        database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
        const parent = allowGrant("attenuation-parent");
        store.transaction((transaction) => transaction.putGrant(parent));
        const child = new Grant(
            new GrantId("attenuation-child"),
            tenantScope,
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
            "allow",
            new CapabilitySpec({ facetPattern: "*", impacts: ["observe", "mutate"] }),
            { kind: "direct" },
            parent.id
        );
        const parentRow = database.all(
            "SELECT scope_key, subject_key FROM tenant_grants WHERE id = ?",
            [parent.id.value]
        )[0]!;
        database.run(
            `INSERT INTO tenant_grants (id, scope_key, subject_key, effect, parent_grant_id, state, record)
             VALUES (?, ?, ?, 'allow', ?, 'active', ?)`,
            [
                child.id.value,
                parentRow["scope_key"]!,
                parentRow["subject_key"]!,
                parent.id.value,
                Grant.encode(child)
            ]
        );

        expect(() => createSqliteTenantControlStore(database)).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test(
        "reconstruction rejects an extra role Grant beyond the materialized set",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const store = createSqliteTenantControlStore(database, anchor);
            database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
            const membershipRow = database.all(
                "SELECT id, role_name FROM tenant_memberships LIMIT 1",
                []
            )[0]!;
            const grantRow = database.all(
                "SELECT scope_key, subject_key FROM tenant_grants LIMIT 1",
                []
            )[0]!;
            const extra = new Grant(
                new GrantId("forged-extra-grant"),
                tenantScope,
                SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
                "allow",
                new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
                {
                    kind: "role",
                    membershipId: new MembershipId(String(membershipRow["id"])),
                    roleName: String(membershipRow["role_name"]),
                    ruleOrdinal: 9999,
                    guest: false
                }
            );
            database.run(
                `INSERT INTO tenant_grants (id, scope_key, subject_key, effect, parent_grant_id, state, record)
             VALUES (?, ?, ?, 'allow', NULL, 'active', ?)`,
                [
                    extra.id.value,
                    grantRow["scope_key"]!,
                    grantRow["subject_key"]!,
                    Grant.encode(extra)
                ]
            );

            expect(() => createSqliteTenantControlStore(database)).toThrow(
                expect.objectContaining({ code: "codec.invalid" })
            );
        }
    );
});

function allowGrant(id: string): Grant {
    return new Grant(
        new GrantId(id),
        tenantScope,
        SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
        "allow",
        new CapabilitySpec({ facetPattern: "*", impacts: ["observe"] }),
        { kind: "direct" }
    );
}

function tableNames(database: TransactionalSqlite): readonly string[] {
    return database
        .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", [])
        .map((row) => sqliteText(row, "name"));
}

class MarkerTamperSqlite extends TestSqlite {
    public tampered = false;

    public override all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const rows = super.all(statement, bindings);
        if (!this.tampered || !statement.includes("FROM tenant_bootstrap_marker")) return rows;
        return rows.map((row) => ({ ...row, tenant_id: null }));
    }
}

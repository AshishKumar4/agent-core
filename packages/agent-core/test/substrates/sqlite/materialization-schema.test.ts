import { describe, expect, test } from "vitest";
import {
    Digest,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    ManagedOrigin,
    ManagedStateRecord,
    MaterializationGeneration,
    MaterializationGenerationPointer,
    MaterializationPlan,
    PolicySet,
    placementProjection,
    policyProjection,
    selectPlacement
} from "../../../src/definition";
import { TenantId } from "../../../src/identity";
import { SqliteMaterializationStore } from "../../../src/substrates";
import type { SqliteRow, SqliteValue } from "../../../src/substrates";
import { TestSqlite } from "../../helpers/sqlite";
import { actorRef, digestOf } from "../../definition/materialization-store-contract";

const MATERIALIZATION_TABLES = [
    "definition_blueprints",
    "definition_managed_state",
    "definition_materialization_generations",
    "definition_materialization_plans",
    "definition_materialization_pointers",
    "definition_materialization_schema"
];
const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));

describe("SQLite materialization schema", () => {
    test(
        "creates the exact marked schema with a closed managed-state kind constraint",
        { tags: "p1" },
        () => {
            const database = new TestSqlite();
            new SqliteMaterializationStore(database, actorRef("schema"));

            const tables = database.all(
                `SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'definition_%' ORDER BY name`,
                []
            );
            expect(tables.map((row) => row["name"])).toEqual(MATERIALIZATION_TABLES);
            expect(tables.map((row) => row["sql"])).toEqual(
                tables.map(() => expect.stringMatching(/STRICT$/))
            );
            expect(
                database
                    .all(
                        `SELECT name FROM sqlite_master
             WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
                        []
                    )
                    .map((row) => row["name"])
            ).toEqual([
                "definition_managed_state_generation",
                "definition_materialization_generations_actor"
            ]);
            expect(
                database.all(
                    `SELECT version, owner_kind, owner_id
             FROM definition_materialization_schema`,
                    []
                )
            ).toEqual([{ owner_id: "schema", owner_kind: "tenant", version: 2 }]);

            const schemaSql = normalizedSql(tables, "definition_materialization_schema");
            expect(schemaSql).toContain("version INTEGER PRIMARY KEY CHECK (version = 2)");
            expect(schemaSql).toContain(
                "owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')"
            );
            expect(schemaSql).toContain("owner_id TEXT NOT NULL CHECK (length(owner_id) > 0)");
            const stateSql = normalizedSql(tables, "definition_managed_state");
            expect(stateSql).toContain(
                "record_kind TEXT NOT NULL CHECK (record_kind IN ('agent-profile', 'environment', 'facet-install', 'facet-placement', 'policy-set', 'scope-scaffold', 'slot-entry', 'subscription', 'surface-layout'))"
            );
            expect(stateSql).not.toContain("CHECK (length(record_kind) > 0)");
            expect(stateSql).toContain("UNIQUE (generation_id, logical_key)");
        }
    );

    test(
        "rejects unsupported managed-state inserts and loads even if SQLite checks are bypassed",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("unsupported-row");
            const store = new SqliteMaterializationStore(database, actor);
            const closure = installSupportedClosure(store, actor, "unsupported-row");

            expect(() =>
                database.run(
                    "UPDATE definition_managed_state SET record_kind = 'binding' WHERE id = ?",
                    [closure.record.id.value]
                )
            ).toThrow();
            database.run("PRAGMA ignore_check_constraints = ON", []);
            database.run(
                "UPDATE definition_managed_state SET record_kind = 'binding' WHERE id = ?",
                [closure.record.id.value]
            );
            database.run("PRAGMA ignore_check_constraints = OFF", []);

            expect(() => store.getManagedState(closure.record.id)).toThrow(/reset.required/i);
            expect(() => store.getGeneration(closure.generation.id)).toThrow(/reset.required/i);
            expect(() => store.getGenerationPointer(actor, deploymentId)).toThrow(
                /reset.required/i
            );
            expect(() => new SqliteMaterializationStore(database, actor)).toThrow(
                /reset.required/i
            );
            expect(
                database.all("SELECT record_kind FROM definition_managed_state WHERE id = ?", [
                    closure.record.id.value
                ])
            ).toEqual([{ record_kind: "binding" }]);
        }
    );

    test(
        "requires reset through decoded managed-state, generation, and pointer closure",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("unsupported-closure");
            const store = new SqliteMaterializationStore(database, actor);
            const closure = installSupportedClosure(store, actor, "unsupported-closure");
            const legacyBytes = withLegacyManagedStateKind(
                ManagedStateRecord.encode(closure.record)
            );
            database.run("UPDATE definition_managed_state SET record = ? WHERE id = ?", [
                legacyBytes,
                closure.record.id.value
            ]);

            expect(() => store.getManagedState(closure.record.id)).toThrow(/reset.required/i);
            expect(() => store.getGeneration(closure.generation.id)).toThrow(/reset.required/i);
            expect(() => store.getGenerationPointer(actor, deploymentId)).toThrow(
                /reset.required/i
            );
            expect(() => new SqliteMaterializationStore(database, actor)).toThrow(
                /reset.required/i
            );
            expect(
                database.all("SELECT record FROM definition_managed_state WHERE id = ?", [
                    closure.record.id.value
                ])[0]?.["record"]
            ).toEqual(legacyBytes);
        }
    );

    test(
        "requires reset when stored plan bytes contain an unsupported closure",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("unsupported-plan");
            const store = new SqliteMaterializationStore(database, actor);
            const plan = supportedPlan(actor, "unsupported-plan");
            store.addPlan(plan);
            const legacyBytes = withLegacyPlanKind(MaterializationPlan.encode(plan));
            database.run("UPDATE definition_materialization_plans SET record = ?", [legacyBytes]);

            expect(() => store.getPlan(plan.id)).toThrow(/reset.required/i);
            expect(() => new SqliteMaterializationStore(database, actor)).toThrow(
                /reset.required/i
            );
            expect(
                database.all("SELECT record FROM definition_materialization_plans", [])[0]?.[
                    "record"
                ]
            ).toEqual(legacyBytes);
        }
    );

    test(
        "requires reset for an unsupported marker version without rewriting it",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("future-schema");
            new SqliteMaterializationStore(database, actor);
            database.run("PRAGMA ignore_check_constraints = ON", []);
            database.run("UPDATE definition_materialization_schema SET version = 3", []);
            database.run("PRAGMA ignore_check_constraints = OFF", []);

            expect(() => new SqliteMaterializationStore(database, actor)).toThrow(
                /reset.required/i
            );
            expect(
                database.all("SELECT version FROM definition_materialization_schema", [])
            ).toEqual([{ version: 3 }]);
        }
    );

    test(
        "binds the marked schema to one owning Tenant without rewriting it",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            new SqliteMaterializationStore(database, actorRef("tenant-a"));

            expect(() => new SqliteMaterializationStore(database, actorRef("tenant-b"))).toThrow(
                /reset.required/i
            );
            expect(
                database.all(
                    "SELECT owner_kind, owner_id FROM definition_materialization_schema",
                    []
                )
            ).toEqual([{ owner_id: "tenant-a", owner_kind: "tenant" }]);
        }
    );

    test(
        "requires reset for a malformed marked table without replacing its data",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("malformed-table");
            new SqliteMaterializationStore(database, actor);
            database.run("DROP TABLE definition_blueprints", []);
            database.run("CREATE TABLE definition_blueprints (sentinel TEXT) STRICT", []);
            database.run("INSERT INTO definition_blueprints VALUES ('keep')", []);

            expect(() => new SqliteMaterializationStore(database, actor)).toThrow(
                /reset.required/i
            );
            expect(database.all("SELECT sentinel FROM definition_blueprints", [])).toEqual([
                { sentinel: "keep" }
            ]);
        }
    );

    test("requires reset for a malformed marked index without replacing it", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("malformed-index");
        new SqliteMaterializationStore(database, actor);
        database.run("DROP INDEX definition_managed_state_generation", []);
        database.run(
            `CREATE INDEX definition_managed_state_generation
             ON definition_managed_state (logical_key)`,
            []
        );

        expect(() => new SqliteMaterializationStore(database, actor)).toThrow(/reset.required/i);
        expect(
            normalizedSql(
                database.all(
                    `SELECT name, sql FROM sqlite_master
             WHERE type = 'index' AND name = 'definition_managed_state_generation'`,
                    []
                ),
                "definition_managed_state_generation"
            )
        ).toContain("ON definition_managed_state (logical_key)");
    });

    test("requires reset for extra indexes targeting protected tables", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("extra-index");
        new SqliteMaterializationStore(database, actor);
        database.run(
            "CREATE INDEX hostile_materialization_index ON definition_blueprints (digest)",
            []
        );

        expect(() => new SqliteMaterializationStore(database, actor)).toThrow(/reset.required/i);
        expect(
            database.all(
                "SELECT name FROM sqlite_master WHERE name = 'hostile_materialization_index'",
                []
            )
        ).toEqual([{ name: "hostile_materialization_index" }]);
    });

    test("requires reset for triggers targeting protected tables", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("extra-trigger");
        new SqliteMaterializationStore(database, actor);
        database.run(
            `CREATE TRIGGER hostile_materialization_trigger
             AFTER INSERT ON definition_blueprints
             BEGIN
                 DELETE FROM definition_blueprints WHERE name != NEW.name;
             END`,
            []
        );

        expect(() => new SqliteMaterializationStore(database, actor)).toThrow(/reset.required/i);
        expect(
            database.all(
                "SELECT name FROM sqlite_master WHERE name = 'hostile_materialization_trigger'",
                []
            )
        ).toEqual([{ name: "hostile_materialization_trigger" }]);
    });

    test(
        "requires reset when definition materialization tables predate the marker",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            database.run("CREATE TABLE definition_blueprints (sentinel TEXT)", []);
            database.run("INSERT INTO definition_blueprints VALUES ('keep')", []);

            expect(() => new SqliteMaterializationStore(database, actorRef("unmarked"))).toThrow(
                /reset.required/i
            );
            expect(database.all("SELECT sentinel FROM definition_blueprints", [])).toEqual([
                { sentinel: "keep" }
            ]);
        }
    );

    test.each(["Definition_Blueprints", "DEFINITION_MATERIALIZATION_PLANS"])(
        "requires reset for case-variant unmarked %s without replacing it",
        { tags: "p0" },
        (table) => {
            const database = new TestSqlite();
            database.run(`CREATE TABLE ${table} (sentinel TEXT)`, []);
            database.run(`INSERT INTO ${table} VALUES ('keep')`, []);

            expect(
                () => new SqliteMaterializationStore(database, actorRef(`case:${table}`))
            ).toThrow(/reset.required/i);
            expect(database.all(`SELECT sentinel FROM ${table}`, [])).toEqual([
                { sentinel: "keep" }
            ]);
        }
    );

    test.each([
        "composition_slot_declarations",
        "composition_slot_entries",
        "composition_slot_shadow",
        "Composition_Slot_Entries"
    ])("requires reset for legacy %s without deleting its data", { tags: "p0" }, (table) => {
        const database = new TestSqlite();
        database.run(`CREATE TABLE ${table} (sentinel TEXT)`, []);
        database.run(`INSERT INTO ${table} VALUES ('keep')`, []);

        expect(() => new SqliteMaterializationStore(database, actorRef(`legacy:${table}`))).toThrow(
            /reset.required/i
        );
        expect(database.all(`SELECT sentinel FROM ${table}`, [])).toEqual([{ sentinel: "keep" }]);
    });

    test(
        "requires reset for a legacy Slot shadow without touching the shadow row",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("legacy-shadow");
            const record = supportedRecord("legacy-shadow");
            const legacyBytes = withLegacyManagedStateKind(ManagedStateRecord.encode(record));
            database.run(
                `CREATE TABLE definition_managed_state (
            id TEXT PRIMARY KEY,
            record_kind TEXT NOT NULL,
            record BLOB NOT NULL
        ) STRICT`,
                []
            );
            database.run(
                `INSERT INTO definition_managed_state (id, record_kind, record)
             VALUES (?, 'binding', ?)`,
                [record.id.value, legacyBytes]
            );

            expect(() => new SqliteMaterializationStore(database, actor)).toThrow(
                /reset.required/i
            );
            expect(
                database.all("SELECT id, record_kind, record FROM definition_managed_state", [])
            ).toEqual([
                {
                    id: record.id.value,
                    record_kind: "binding",
                    record: legacyBytes
                }
            ]);
        }
    );

    test("requires reset for orphan managed state without deleting it", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("orphan");
        new SqliteMaterializationStore(database, actor);
        const record = supportedRecord("orphan");
        database.run(
            `INSERT INTO definition_managed_state (
                id, generation_id, actor_kind, actor_id, logical_key,
                record_kind, desired_digest, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                record.id.value,
                record.generationId.value,
                record.actor.kind,
                record.actor.id.value,
                record.logicalKey,
                record.recordKind,
                record.desiredDigest.value,
                ManagedStateRecord.encode(record)
            ]
        );

        expect(() => new SqliteMaterializationStore(database, actor)).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );
        expect(database.all("SELECT id FROM definition_managed_state", [])).toEqual([
            { id: record.id.value }
        ]);
    });

    test(
        "rolls back standalone managed state that has no stored generation",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("standalone-orphan");
            const store = new SqliteMaterializationStore(database, actor);

            expect(() => store.addManagedState(supportedRecord("standalone-orphan"))).toThrow(
                /stored generation/
            );
            expect(database.all("SELECT id FROM definition_managed_state", [])).toEqual([]);
            expect(() => new SqliteMaterializationStore(database, actor)).not.toThrow();
        }
    );

    test("names the exact legacy and unmarked schema reset reasons", { tags: "p1" }, () => {
        const legacy = new TestSqlite();
        legacy.run("CREATE TABLE composition_slot_entries (sentinel TEXT)", []);
        expect(() => new SqliteMaterializationStore(legacy, actorRef("legacy-exact"))).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message:
                    "Materialization reset required (reset-required): legacy table composition_slot_entries exists"
            })
        );

        const unmarked = expect.objectContaining({
            code: "codec.invalid",
            message:
                "Materialization reset required (reset-required): definition materialization objects exist without a schema marker"
        });
        const unmarkedTable = new TestSqlite();
        unmarkedTable.run("CREATE TABLE definition_blueprints (sentinel TEXT)", []);
        expect(
            () => new SqliteMaterializationStore(unmarkedTable, actorRef("unmarked-table"))
        ).toThrowError(unmarked);

        const unmarkedIndex = new TestSqlite();
        unmarkedIndex.run("CREATE TABLE bystander (sentinel TEXT)", []);
        unmarkedIndex.run(
            "CREATE INDEX definition_managed_state_generation ON bystander (sentinel)",
            []
        );
        expect(
            () => new SqliteMaterializationStore(unmarkedIndex, actorRef("unmarked-index"))
        ).toThrowError(unmarked);
    });

    test(
        "names the exact incomplete-schema reset reason for missing tables and indexes",
        { tags: "p1" },
        () => {
            const incomplete = expect.objectContaining({
                code: "codec.invalid",
                message:
                    "Materialization reset required (reset-required): the marked definition materialization schema is incomplete"
            });
            const missingTable = new TestSqlite();
            new SqliteMaterializationStore(missingTable, actorRef("missing-table"));
            missingTable.run("DROP TABLE definition_blueprints", []);
            expect(
                () => new SqliteMaterializationStore(missingTable, actorRef("missing-table"))
            ).toThrowError(incomplete);

            const missingIndex = new TestSqlite();
            new SqliteMaterializationStore(missingIndex, actorRef("missing-index"));
            missingIndex.run("DROP INDEX definition_managed_state_generation", []);
            expect(
                () => new SqliteMaterializationStore(missingIndex, actorRef("missing-index"))
            ).toThrowError(incomplete);
        }
    );

    test("names the exact malformed marked object reset reasons", { tags: "p1" }, () => {
        const malformedTable = new TestSqlite();
        new SqliteMaterializationStore(malformedTable, actorRef("exact-malformed-table"));
        malformedTable.run("DROP TABLE definition_blueprints", []);
        malformedTable.run("CREATE TABLE definition_blueprints (sentinel TEXT) STRICT", []);
        expect(
            () => new SqliteMaterializationStore(malformedTable, actorRef("exact-malformed-table"))
        ).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message:
                    "Materialization reset required (reset-required): the marked definition materialization table definition_blueprints is malformed"
            })
        );

        const malformedIndex = new TestSqlite();
        new SqliteMaterializationStore(malformedIndex, actorRef("exact-malformed-index"));
        malformedIndex.run("DROP INDEX definition_managed_state_generation", []);
        malformedIndex.run(
            `CREATE INDEX definition_managed_state_generation
             ON definition_managed_state (logical_key)`,
            []
        );
        expect(
            () => new SqliteMaterializationStore(malformedIndex, actorRef("exact-malformed-index"))
        ).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message:
                    "Materialization reset required (reset-required): the marked definition materialization index definition_managed_state_generation is malformed"
            })
        );
    });

    test(
        "tolerates triggers and indexes on tables outside the materialization schema",
        { tags: "p2" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("bystander-trigger");
            new SqliteMaterializationStore(database, actor);
            database.run("CREATE TABLE bystander (sentinel TEXT)", []);
            database.run(
                `CREATE TRIGGER bystander_trigger AFTER INSERT ON bystander
             BEGIN SELECT 1; END`,
                []
            );
            database.run("CREATE INDEX bystander_index ON bystander (sentinel)", []);

            expect(() => new SqliteMaterializationStore(database, actor)).not.toThrow();
        }
    );

    test("accepts a stored table whose IF NOT EXISTS uses wider whitespace", { tags: "p2" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("whitespace-schema");
        new SqliteMaterializationStore(database, actor);
        const sql = database.all(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'definition_blueprints'",
            []
        )[0]?.["sql"];
        expect(typeof sql).toBe("string");
        database.run("DROP TABLE definition_blueprints", []);
        database.run(String(sql).replace("IF NOT EXISTS", "IF  NOT  EXISTS"), []);

        expect(() => new SqliteMaterializationStore(database, actor)).not.toThrow();
    });

    test("names the exact schema marker reset reasons", { tags: "p1" }, () => {
        const unsupported = expect.objectContaining({
            code: "codec.invalid",
            message:
                "Materialization reset required (reset-required): the definition materialization schema version is unsupported"
        });
        const missingRow = new TestSqlite();
        new SqliteMaterializationStore(missingRow, actorRef("missing-marker-row"));
        missingRow.run("DELETE FROM definition_materialization_schema", []);
        expect(
            () => new SqliteMaterializationStore(missingRow, actorRef("missing-marker-row"))
        ).toThrowError(unsupported);

        const wrongKind = new TestSqlite();
        new SqliteMaterializationStore(wrongKind, actorRef("marker-owner"));
        expect(
            () => new SqliteMaterializationStore(wrongKind, actorRef("marker-owner", "workspace"))
        ).toThrowError(unsupported);
    });

    test(
        "names exact unsupported managed-state reset reasons and keeps plain codec failures",
        { tags: "p1" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("exact-unsupported");
            const store = new SqliteMaterializationStore(database, actor);
            const closure = installSupportedClosure(store, actor, "exact-unsupported");

            database.run("PRAGMA ignore_check_constraints = ON", []);
            database.run(
                "UPDATE definition_managed_state SET record_kind = 'binding' WHERE id = ?",
                [closure.record.id.value]
            );
            database.run("PRAGMA ignore_check_constraints = OFF", []);
            expect(() => store.getManagedState(closure.record.id)).toThrowError(
                expect.objectContaining({
                    code: "codec.invalid",
                    message:
                        "Materialization reset required (reset-required): unsupported managed-state kind binding"
                })
            );

            database.run("UPDATE definition_managed_state SET record_kind = ? WHERE id = ?", [
                closure.record.recordKind,
                closure.record.id.value
            ]);
            database.run("UPDATE definition_managed_state SET record = ? WHERE id = ?", [
                withLegacyManagedStateKind(ManagedStateRecord.encode(closure.record)),
                closure.record.id.value
            ]);
            expect(() => store.getManagedState(closure.record.id)).toThrowError(
                expect.objectContaining({
                    code: "codec.invalid",
                    message:
                        "Materialization reset required (reset-required): stored codec bytes contain an unsupported materialization closure"
                })
            );

            database.run("UPDATE definition_managed_state SET record = ? WHERE id = ?", [
                Uint8Array.of(1, 2, 3),
                closure.record.id.value
            ]);
            expect(() => store.getManagedState(closure.record.id)).toThrowError(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: expect.not.stringContaining("reset-required")
                })
            );
        }
    );

    test("compares marked schema SQL under exact whitespace normalization", { tags: "p1" }, () => {
        const padded = new TestSqlite();
        const paddedActor = actorRef("normalize-padded");
        new SqliteMaterializationStore(padded, paddedActor);
        recreateTable(padded, "definition_blueprints", (sql) => `${sql}   `);
        expect(() => new SqliteMaterializationStore(padded, paddedActor)).not.toThrow();

        const collapsed = new TestSqlite();
        const collapsedActor = actorRef("normalize-collapsed");
        new SqliteMaterializationStore(collapsed, collapsedActor);
        recreateTable(collapsed, "definition_blueprints", (sql) => sql.replaceAll(/\s+/gu, " "));
        expect(() => new SqliteMaterializationStore(collapsed, collapsedActor)).not.toThrow();

        const stripped = new TestSqlite();
        const strippedActor = actorRef("normalize-stripped");
        new SqliteMaterializationStore(stripped, strippedActor);
        recreateTable(stripped, "definition_blueprints", (sql) => sql.replaceAll("> 0", ">0"));
        expect(() => new SqliteMaterializationStore(stripped, strippedActor)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message:
                    "Materialization reset required (reset-required): the marked definition materialization table definition_blueprints is malformed"
            })
        );
    });

    test(
        "requires exactly one schema marker row without rewriting the extra one",
        { tags: "p1" },
        () => {
            const database = new TestSqlite();
            const actor = actorRef("marker-duplicate");
            new SqliteMaterializationStore(database, actor);
            database.run("PRAGMA ignore_check_constraints = ON", []);
            database.run(
                `INSERT INTO definition_materialization_schema (version, owner_kind, owner_id)
             VALUES (?, ?, ?)`,
                [3, actor.kind, actor.id.value]
            );
            database.run("PRAGMA ignore_check_constraints = OFF", []);

            expect(() => new SqliteMaterializationStore(database, actor)).toThrowError(
                expect.objectContaining({
                    name: "AgentCoreError",
                    code: "codec.invalid",
                    message:
                        "Materialization reset required (reset-required): the definition materialization schema version is unsupported"
                })
            );
            expect(
                database.all(
                    "SELECT version FROM definition_materialization_schema ORDER BY version",
                    []
                )
            ).toEqual([{ version: 2 }, { version: 3 }]);
        }
    );

    test("names the marker as malformed when its row cannot be read", { tags: "p1" }, () => {
        const database = new MarkerReadFaultSqlite();
        const actor = actorRef("marker-unreadable");
        new SqliteMaterializationStore(database, actor);
        database.fault = true;

        expect(() => new SqliteMaterializationStore(database, actor)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message:
                    "Materialization reset required (reset-required): the definition materialization schema marker is malformed"
            })
        );
    });

    test("scopes legacy composition detection to tables only", { tags: "p2" }, () => {
        const database = new TestSqlite();
        const actor = actorRef("legacy-scope");
        new SqliteMaterializationStore(database, actor);
        database.run("CREATE TABLE bystander (sentinel TEXT)", []);
        database.run("CREATE INDEX composition_slot_bystander ON bystander (sentinel)", []);
        database.run(
            `CREATE TRIGGER composition_slot_bystander_trigger AFTER INSERT ON bystander
             BEGIN SELECT 1; END`,
            []
        );

        expect(() => new SqliteMaterializationStore(database, actor)).not.toThrow();
    });

    test("rejects a sqlite_master sql column that is neither text nor null", { tags: "p1" }, () => {
        const database = new SchemaRowFaultSqlite();
        const actor = actorRef("sql-projection");
        new SqliteMaterializationStore(database, actor);
        database.rows = database
            .all(
                `SELECT name, type, tbl_name, sql FROM sqlite_master
                 WHERE type IN ('table', 'index', 'trigger')`,
                []
            )
            .map((row) => (row["name"] === "definition_blueprints" ? { ...row, sql: 1 } : row));

        expect(() => new SqliteMaterializationStore(database, actor)).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "codec.invalid",
                message: "Stored materialization sql projection is malformed"
            })
        );
    });
});

class MarkerReadFaultSqlite extends TestSqlite {
    public fault = false;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (
            this.fault &&
            /FROM definition_materialization_schema ORDER BY version/u.test(statement)
        ) {
            throw new TypeError("Materialization schema marker is unreadable");
        }
        return super.all(statement, bindings);
    }
}

class SchemaRowFaultSqlite extends TestSqlite {
    public rows: readonly SqliteRow[] | undefined;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.rows !== undefined && /FROM sqlite_master/u.test(statement)
            ? this.rows
            : super.all(statement, bindings);
    }
}

function recreateTable(database: TestSqlite, table: string, edit: (sql: string) => string): void {
    const sql = database.all("SELECT sql FROM sqlite_master WHERE name = ?", [table])[0]?.["sql"];
    if (typeof sql !== "string") throw new TypeError(`Missing SQL for ${table}`);
    database.run(`DROP TABLE ${table}`, []);
    database.run(edit(sql), []);
}

function supportedPlan(actor: ReturnType<typeof actorRef>, seed: string): MaterializationPlan {
    const origin = managedOrigin(seed);
    return new MaterializationPlan({
        origin,
        actors: [
            new ActorPlan({
                actor,
                origin,
                projections: [
                    placementProjection(
                        `placement:${seed}`,
                        "filesystem",
                        selectPlacement({
                            manifest: ["dynamic", "provider", "bundled"],
                            policy: ["dynamic", "provider", "bundled"],
                            substrate: ["dynamic", "provider", "bundled"],
                            trust: ["dynamic", "provider", "bundled"]
                        })
                    ),
                    policyProjection(
                        `policy:${seed}`,
                        new PolicySet({ tiers: { execute: "mediated" } })
                    )
                ]
            })
        ]
    });
}

function supportedRecord(seed: string): ManagedStateRecord {
    const actor = actorRef(seed);
    const plan = supportedPlan(actor, seed);
    const projection = plan.actors[0]!.projections[0]!;
    return ManagedStateRecord.fromProjection(
        actor,
        plan.origin,
        Digest.sha256(new TextEncoder().encode(`generation:${seed}`)),
        projection
    );
}

function installSupportedClosure(
    store: SqliteMaterializationStore,
    actor: ReturnType<typeof actorRef>,
    seed: string
): {
    readonly generation: MaterializationGeneration;
    readonly record: ManagedStateRecord;
} {
    const plan = supportedPlan(actor, seed);
    const actorPlan = plan.actors[0]!;
    const generation = MaterializationGeneration.fromActorPlan(actorPlan);
    const records = actorPlan.projections.map((projection) =>
        ManagedStateRecord.fromProjection(actor, actorPlan.origin, generation.id, projection)
    );
    store.addPlan(plan);
    store.transaction((transaction) => {
        for (const record of records) store.insertManagedState(transaction, record);
        store.insertGeneration(transaction, generation);
        expect(
            store.compareAndSetGenerationPointer(
                transaction,
                actor,
                deploymentId,
                undefined,
                MaterializationGenerationPointer.initial(actor, deploymentId, generation.id)
            )
        ).toBe(true);
    });
    return { generation, record: records[0]! };
}

function managedOrigin(seed: string): ManagedOrigin {
    return new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: digestOf(`attestation:${seed}`),
        blueprintDigest: digestOf(`blueprint:${seed}`),
        packageLockDigest: digestOf(`lock:${seed}`),
        configDigest: digestOf(`config:${seed}`),
        generation: 1
    });
}

function withLegacyPlanKind(bytes: Uint8Array): Uint8Array {
    const envelope = decodeCanonicalJson(bytes) as unknown as MutablePlanEnvelope;
    envelope.payload.actors[0]!.projections[0]!.recordKind = "binding";
    return encodeCanonicalJson(envelope as unknown as JsonValue);
}

function withLegacyManagedStateKind(bytes: Uint8Array): Uint8Array {
    const envelope = decodeCanonicalJson(bytes) as unknown as MutableManagedStateEnvelope;
    envelope.payload.recordKind = "binding";
    return encodeCanonicalJson(envelope as unknown as JsonValue);
}

function normalizedSql(
    rows: readonly { readonly [column: string]: string | number | Uint8Array | null }[],
    table: string
): string {
    const sql = rows.find((row) => row["name"] === table)?.["sql"];
    if (typeof sql !== "string") throw new TypeError(`Missing SQL for ${table}`);
    return sql.replaceAll(/\s+/g, " ");
}

interface MutablePlanEnvelope {
    readonly kind: string;
    readonly version: { readonly major: number; readonly minor: number };
    readonly payload: {
        readonly actors: Array<{
            readonly projections: Array<{ recordKind: string }>;
        }>;
    };
}

interface MutableManagedStateEnvelope {
    readonly kind: string;
    readonly version: { readonly major: number; readonly minor: number };
    readonly payload: { recordKind: string };
}

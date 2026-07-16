// @ts-nocheck
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
    test("creates the exact marked schema with a closed managed-state kind constraint", () => {
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
    });

    test("rejects unsupported managed-state inserts and loads even if SQLite checks are bypassed", () => {
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
        database.run("UPDATE definition_managed_state SET record_kind = 'binding' WHERE id = ?", [
            closure.record.id.value
        ]);
        database.run("PRAGMA ignore_check_constraints = OFF", []);

        expect(() => store.getManagedState(closure.record.id)).toThrow(/reset.required/i);
        expect(() => store.getGeneration(closure.generation.id)).toThrow(/reset.required/i);
        expect(() => store.getGenerationPointer(actor, deploymentId)).toThrow(/reset.required/i);
        expect(() => new SqliteMaterializationStore(database, actor)).toThrow(/reset.required/i);
        expect(
            database.all("SELECT record_kind FROM definition_managed_state WHERE id = ?", [
                closure.record.id.value
            ])
        ).toEqual([{ record_kind: "binding" }]);
    });

    test("requires reset through decoded managed-state, generation, and pointer closure", () => {
        const database = new TestSqlite();
        const actor = actorRef("unsupported-closure");
        const store = new SqliteMaterializationStore(database, actor);
        const closure = installSupportedClosure(store, actor, "unsupported-closure");
        const legacyBytes = withLegacyManagedStateKind(ManagedStateRecord.encode(closure.record));
        database.run("UPDATE definition_managed_state SET record = ? WHERE id = ?", [
            legacyBytes,
            closure.record.id.value
        ]);

        expect(() => store.getManagedState(closure.record.id)).toThrow(/reset.required/i);
        expect(() => store.getGeneration(closure.generation.id)).toThrow(/reset.required/i);
        expect(() => store.getGenerationPointer(actor, deploymentId)).toThrow(/reset.required/i);
        expect(() => new SqliteMaterializationStore(database, actor)).toThrow(/reset.required/i);
        expect(
            database.all("SELECT record FROM definition_managed_state WHERE id = ?", [
                closure.record.id.value
            ])[0]?.["record"]
        ).toEqual(legacyBytes);
    });

    test("requires reset when stored plan bytes contain an unsupported closure", () => {
        const database = new TestSqlite();
        const actor = actorRef("unsupported-plan");
        const store = new SqliteMaterializationStore(database, actor);
        const plan = supportedPlan(actor, "unsupported-plan");
        store.addPlan(plan);
        const legacyBytes = withLegacyPlanKind(MaterializationPlan.encode(plan));
        database.run("UPDATE definition_materialization_plans SET record = ?", [legacyBytes]);

        expect(() => store.getPlan(plan.id)).toThrow(/reset.required/i);
        expect(() => new SqliteMaterializationStore(database, actor)).toThrow(/reset.required/i);
        expect(
            database.all("SELECT record FROM definition_materialization_plans", [])[0]?.["record"]
        ).toEqual(legacyBytes);
    });

    test("requires reset for an unsupported marker version without rewriting it", () => {
        const database = new TestSqlite();
        const actor = actorRef("future-schema");
        new SqliteMaterializationStore(database, actor);
        database.run("PRAGMA ignore_check_constraints = ON", []);
        database.run("UPDATE definition_materialization_schema SET version = 3", []);
        database.run("PRAGMA ignore_check_constraints = OFF", []);

        expect(() => new SqliteMaterializationStore(database, actor)).toThrow(/reset.required/i);
        expect(database.all("SELECT version FROM definition_materialization_schema", [])).toEqual([
            { version: 3 }
        ]);
    });

    test("binds the marked schema to one owning Tenant without rewriting it", () => {
        const database = new TestSqlite();
        new SqliteMaterializationStore(database, actorRef("tenant-a"));

        expect(() => new SqliteMaterializationStore(database, actorRef("tenant-b"))).toThrow(
            /reset.required/i
        );
        expect(
            database.all("SELECT owner_kind, owner_id FROM definition_materialization_schema", [])
        ).toEqual([{ owner_id: "tenant-a", owner_kind: "tenant" }]);
    });

    test("requires reset for a malformed marked table without replacing its data", () => {
        const database = new TestSqlite();
        const actor = actorRef("malformed-table");
        new SqliteMaterializationStore(database, actor);
        database.run("DROP TABLE definition_blueprints", []);
        database.run("CREATE TABLE definition_blueprints (sentinel TEXT) STRICT", []);
        database.run("INSERT INTO definition_blueprints VALUES ('keep')", []);

        expect(() => new SqliteMaterializationStore(database, actor)).toThrow(/reset.required/i);
        expect(database.all("SELECT sentinel FROM definition_blueprints", [])).toEqual([
            { sentinel: "keep" }
        ]);
    });

    test("requires reset for a malformed marked index without replacing it", () => {
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

    test("requires reset for extra indexes targeting protected tables", () => {
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

    test("requires reset for triggers targeting protected tables", () => {
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

    test("requires reset when definition materialization tables predate the marker", () => {
        const database = new TestSqlite();
        database.run("CREATE TABLE definition_blueprints (sentinel TEXT)", []);
        database.run("INSERT INTO definition_blueprints VALUES ('keep')", []);

        expect(() => new SqliteMaterializationStore(database, actorRef("unmarked"))).toThrow(
            /reset.required/i
        );
        expect(database.all("SELECT sentinel FROM definition_blueprints", [])).toEqual([
            { sentinel: "keep" }
        ]);
    });

    test.each(["Definition_Blueprints", "DEFINITION_MATERIALIZATION_PLANS"])(
        "requires reset for case-variant unmarked %s without replacing it",
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
    ])("requires reset for legacy %s without deleting its data", (table) => {
        const database = new TestSqlite();
        database.run(`CREATE TABLE ${table} (sentinel TEXT)`, []);
        database.run(`INSERT INTO ${table} VALUES ('keep')`, []);

        expect(() => new SqliteMaterializationStore(database, actorRef(`legacy:${table}`))).toThrow(
            /reset.required/i
        );
        expect(database.all(`SELECT sentinel FROM ${table}`, [])).toEqual([{ sentinel: "keep" }]);
    });

    test("requires reset for a legacy Slot shadow without touching the shadow row", () => {
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

        expect(() => new SqliteMaterializationStore(database, actor)).toThrow(/reset.required/i);
        expect(
            database.all("SELECT id, record_kind, record FROM definition_managed_state", [])
        ).toEqual([
            {
                id: record.id.value,
                record_kind: "binding",
                record: legacyBytes
            }
        ]);
    });

    test("requires reset for orphan managed state without deleting it", () => {
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

    test("rolls back standalone managed state that has no stored generation", () => {
        const database = new TestSqlite();
        const actor = actorRef("standalone-orphan");
        const store = new SqliteMaterializationStore(database, actor);

        expect(() => store.addManagedState(supportedRecord("standalone-orphan"))).toThrow(
            /stored generation/
        );
        expect(database.all("SELECT id FROM definition_managed_state", [])).toEqual([]);
        expect(() => new SqliteMaterializationStore(database, actor)).not.toThrow();
    });
});

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

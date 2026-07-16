// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { requireSynchronousResult, type SynchronousResultGuard } from "../../src/actors";
import { SemVer } from "../../src/core";
import {
    ActorPlan,
    Blueprint,
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
} from "../../src/definition";
import {
    SqliteActorStore,
    SqliteMaterializationStore,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import {
    actorRef,
    blueprint,
    digestOf,
    installGeneration,
    materializationState,
    materializationStoreContract,
    type MaterializationFixture
} from "./materialization-store-contract";
import { TenantId } from "../../src/identity";

const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));

materializationStoreContract(
    "SQLite",
    (owner) => new SqliteMaterializationStore(new TestSqlite(), owner)
);

describe("SqliteMaterializationStore persistence", () => {
    test("joins W1 Actor activation and W4 initialization in one SQLite transaction", () => {
        const database = new TestSqlite();
        const actor = actorRef("activation");
        const store = new SqliteMaterializationStore(database, actor);
        const actorStore = new SqliteActorStore(database);
        const fixture = materializationState(actor, 1, "activation");
        const initialize = (transaction: TransactionalSqlite): void => {
            for (const record of fixture.materialization.records) {
                store.insertManagedState(transaction, record);
            }
            store.insertGeneration(transaction, fixture.materialization.generation);
        };

        expect(() =>
            actorStore.activateActor(actor, (transaction) => {
                initialize(transaction);
                throw new TypeError("injected activation failure");
            })
        ).toThrow("injected activation failure");
        expect(database.all("SELECT id FROM definition_materialization_generations", [])).toEqual(
            []
        );
        expect(database.all("SELECT actor_id FROM actor_recovery_state", [])).toEqual([]);

        const recovery = actorStore.activateActor(actor, initialize);
        expect(recovery.recoveries).toBe(1);
        expect(store.getGeneration(fixture.materialization.generation.id)).toBeDefined();
        expect(database.all("SELECT actor_id FROM actor_recovery_state", [])).toEqual([
            { actor_id: actor.id.value }
        ]);
    });

    test("survives adapter recreation over one database", () => {
        const database = new TestSqlite();
        const actor = actorRef("workspace");
        const fixture = installComplete(new SqliteMaterializationStore(database, actor));

        const restarted = new SqliteMaterializationStore(database, actor);
        expect(restarted.getBlueprint("platform", new SemVer("1.0.0"))).toBeDefined();
        expect(MaterializationPlan.encode(restarted.getPlan(fixture.plan.id)!)).toEqual(
            MaterializationPlan.encode(fixture.plan)
        );
        expect(
            MaterializationGeneration.encode(
                restarted.getGeneration(fixture.materialization.generation.id)!
            )
        ).toEqual(MaterializationGeneration.encode(fixture.materialization.generation));
        expect(restarted.listManagedState()).toHaveLength(2);
        expect(
            restarted
                .getGenerationPointer(
                    fixture.actor,
                    fixture.materialization.generation.origin.deploymentId
                )
                ?.generationId.equals(fixture.materialization.generation.id)
        ).toBe(true);
    });

    test("survives closing and reopening a file-backed database", () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-materialization-"));
        const path = join(directory, "materialization.sqlite");
        try {
            const firstDatabase = new FileSqlite(path);
            const actor = actorRef("workspace");
            const fixture = installComplete(new SqliteMaterializationStore(firstDatabase, actor));
            firstDatabase.close();

            const reopenedDatabase = new FileSqlite(path);
            const reopened = new SqliteMaterializationStore(reopenedDatabase, actor);
            expect(reopened.getBlueprint("platform", new SemVer("1.0.0"))).toBeDefined();
            expect(reopened.getPlan(fixture.plan.id)).toBeDefined();
            expect(reopened.getGeneration(fixture.materialization.generation.id)).toBeDefined();
            expect(reopened.getManagedState(fixture.materialization.records[0]!.id)).toBeDefined();
            expect(
                reopened.getGenerationPointer(
                    fixture.actor,
                    fixture.materialization.generation.origin.deploymentId
                )?.revision.value
            ).toBe(0);
            reopenedDatabase.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("creates strict tables and persists authoritative codec blobs", () => {
        const database = new TestSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("workspace"));
        const fixture = installComplete(store);
        const candidateBlueprint = store.getBlueprint("platform", new SemVer("1.0.0"))!;

        const tables = database.all(
            `SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name IN (
                'definition_blueprints',
                'definition_materialization_plans',
                'definition_materialization_generations',
                'definition_managed_state',
                'definition_materialization_pointers'
             ) ORDER BY name`,
            []
        );
        expect(tables).toHaveLength(5);
        expect(tables.map((row) => row["sql"])).toEqual(
            tables.map(() => expect.stringMatching(/STRICT$/))
        );
        expect(record(database, "definition_blueprints")).toEqual(
            Blueprint.encode(candidateBlueprint)
        );
        expect(record(database, "definition_materialization_plans")).toEqual(
            MaterializationPlan.encode(fixture.plan)
        );
        expect(record(database, "definition_materialization_generations")).toEqual(
            MaterializationGeneration.encode(fixture.materialization.generation)
        );
        expect(record(database, "definition_managed_state")).toEqual(
            ManagedStateRecord.encode(fixture.materialization.records[0]!)
        );
        expect(record(database, "definition_materialization_pointers")).toEqual(
            MaterializationGenerationPointer.encode(
                store.getGenerationPointer(
                    fixture.actor,
                    fixture.materialization.generation.origin.deploymentId
                )!
            )
        );
    });

    test.each([
        ["Blueprint name", "definition_blueprints", "name", "other", "listBlueprints"],
        ["Blueprint version", "definition_blueprints", "version", "2.0.0", "listBlueprints"],
        ["Blueprint", "definition_blueprints", "digest", "0".repeat(64), "listBlueprints"],
        ["plan ID", "definition_materialization_plans", "id", "1".repeat(64), "listPlans"],
        [
            "plan Blueprint",
            "definition_materialization_plans",
            "blueprint_digest",
            "1".repeat(64),
            "listPlans"
        ],
        [
            "plan lock",
            "definition_materialization_plans",
            "package_lock_digest",
            "1".repeat(64),
            "listPlans"
        ],
        [
            "plan config",
            "definition_materialization_plans",
            "config_digest",
            "1".repeat(64),
            "listPlans"
        ],
        ["plan", "definition_materialization_plans", "generation", 9, "listPlans"],
        [
            "generation ID",
            "definition_materialization_generations",
            "id",
            "1".repeat(64),
            "listGenerations"
        ],
        [
            "generation Actor kind",
            "definition_materialization_generations",
            "actor_kind",
            "run",
            "listGenerations"
        ],
        [
            "generation",
            "definition_materialization_generations",
            "actor_id",
            "other",
            "listGenerations"
        ],
        [
            "generation Blueprint",
            "definition_materialization_generations",
            "blueprint_digest",
            "1".repeat(64),
            "listGenerations"
        ],
        [
            "generation lock",
            "definition_materialization_generations",
            "package_lock_digest",
            "1".repeat(64),
            "listGenerations"
        ],
        [
            "generation config",
            "definition_materialization_generations",
            "config_digest",
            "1".repeat(64),
            "listGenerations"
        ],
        [
            "generation ordinal",
            "definition_materialization_generations",
            "generation",
            9,
            "listGenerations"
        ],
        ["managed ID", "definition_managed_state", "id", "1".repeat(64), "listManagedState"],
        [
            "managed generation",
            "definition_managed_state",
            "generation_id",
            "1".repeat(64),
            "listManagedState"
        ],
        ["managed Actor kind", "definition_managed_state", "actor_kind", "run", "listManagedState"],
        ["managed Actor ID", "definition_managed_state", "actor_id", "other", "listManagedState"],
        ["managed state", "definition_managed_state", "logical_key", "other", "listManagedState"],
        [
            "managed kind",
            "definition_managed_state",
            "record_kind",
            "facet-placement",
            "listManagedState"
        ],
        [
            "managed digest",
            "definition_managed_state",
            "desired_digest",
            "1".repeat(64),
            "listManagedState"
        ],
        [
            "pointer Actor kind",
            "definition_materialization_pointers",
            "actor_kind",
            "run",
            "listGenerationPointers"
        ],
        [
            "pointer Actor ID",
            "definition_materialization_pointers",
            "actor_id",
            "other",
            "listGenerationPointers"
        ],
        [
            "pointer deployment",
            "definition_materialization_pointers",
            "deployment_id",
            "1".repeat(64),
            "listGenerationPointers"
        ],
        [
            "pointer generation",
            "definition_materialization_pointers",
            "generation_id",
            "1".repeat(64),
            "listGenerationPointers"
        ],
        ["pointer", "definition_materialization_pointers", "revision", 9, "listGenerationPointers"]
    ] as const)("rejects a corrupt %s projection", (_subject, table, column, value, reader) => {
        const database = new TestSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("workspace"));
        installComplete(store);
        database.run(
            `UPDATE ${table} SET ${column} = ?
                 WHERE rowid = (SELECT rowid FROM ${table} LIMIT 1)`,
            [value]
        );

        expect(() => store[reader]()).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test.each([
        ["Blueprint", "definition_blueprints", "listBlueprints"],
        ["plan", "definition_materialization_plans", "listPlans"],
        ["generation", "definition_materialization_generations", "listGenerations"],
        ["managed state", "definition_managed_state", "listManagedState"],
        ["pointer", "definition_materialization_pointers", "listGenerationPointers"]
    ] as const)("rejects corrupt %s codec bytes", (_subject, table, reader) => {
        const database = new TestSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("workspace"));
        installComplete(store);
        database.run(`UPDATE ${table} SET record = ?`, [new Uint8Array([0])]);

        expect(() => store[reader]()).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test.each([
        ["definition_blueprints", "name", "", "listBlueprints"],
        ["definition_materialization_plans", "generation", -1, "listPlans"],
        ["definition_materialization_generations", "actor_id", "", "listGenerations"],
        ["definition_materialization_generations", "generation", -1, "listGenerations"],
        ["definition_managed_state", "logical_key", "", "listManagedState"],
        ["definition_managed_state", "desired_digest", "", "listManagedState"],
        ["definition_materialization_pointers", "deployment_id", "", "listGenerationPointers"],
        ["definition_materialization_pointers", "revision", -1, "listGenerationPointers"]
    ] as const)("rejects malformed SQLite scalar %s.%s", (table, column, value, reader) => {
        const database = new TestSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("workspace"));
        installComplete(store);
        database.run("PRAGMA ignore_check_constraints = ON", []);
        database.run(
            `UPDATE ${table} SET ${column} = ?
             WHERE rowid = (SELECT rowid FROM ${table} LIMIT 1)`,
            [value]
        );
        database.run("PRAGMA ignore_check_constraints = OFF", []);
        expect(() => store[reader]()).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );
    });

    test("rejects missing generation state and a pointer retargeted outside its Actor", () => {
        const database = new TestSqlite();
        const store = new SqliteMaterializationStore(database, actorRef("workspace"));
        const fixture = installComplete(store);
        database.run("DELETE FROM definition_managed_state", []);

        expect(() => store.getGeneration(fixture.materialization.generation.id)).toThrowError(
            expect.objectContaining({ code: "codec.invalid" })
        );

        const secondDatabase = new TestSqlite();
        const secondStore = new SqliteMaterializationStore(secondDatabase, actorRef("workspace"));
        const second = installComplete(secondStore);
        secondDatabase.run("UPDATE definition_materialization_pointers SET generation_id = ?", [
            digestOf("missing-generation").value
        ]);
        expect(() =>
            secondStore.getGenerationPointer(
                second.actor,
                second.materialization.generation.origin.deploymentId
            )
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
    });
});

function installComplete(store: SqliteMaterializationStore): MaterializationFixture {
    const actor = actorRef("workspace");
    const fixture = supportedMaterializationState(actor, 1, "sqlite");
    store.addBlueprint(blueprint("platform", "1.0.0", { tier: "mediated" }));
    store.addPlan(fixture.plan);
    installGeneration(store, fixture);
    store.transaction((transaction) => {
        expect(
            store.compareAndSetGenerationPointer(
                transaction,
                actor,
                deploymentId,
                undefined,
                MaterializationGenerationPointer.initial(
                    actor,
                    deploymentId,
                    fixture.materialization.generation.id
                )
            )
        ).toBe(true);
    });
    return fixture;
}

function supportedMaterializationState(
    actor: MaterializationFixture["actor"],
    generation: number,
    seed: string
): MaterializationFixture {
    const origin = new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: digestOf(`attestation:${seed}`),
        blueprintDigest: digestOf(`blueprint:${seed}`),
        packageLockDigest: digestOf(`lock:${seed}`),
        configDigest: digestOf(`config:${seed}`),
        generation
    });
    const actorPlan = new ActorPlan({
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
            policyProjection(`policy:${seed}`, new PolicySet({ tiers: { mutate: "mediated" } }))
        ]
    });
    const materializationGeneration = MaterializationGeneration.fromActorPlan(actorPlan);
    return {
        actor,
        plan: new MaterializationPlan({ origin, actors: [actorPlan] }),
        materialization: {
            generation: materializationGeneration,
            records: actorPlan.projections.map((projection) =>
                ManagedStateRecord.fromProjection(
                    actor,
                    origin,
                    materializationGeneration.id,
                    projection
                )
            )
        }
    };
}

function record(database: TestSqlite, table: string): SqliteValue | undefined {
    return database.all(`SELECT record FROM ${table}`, [])[0]?.["record"];
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

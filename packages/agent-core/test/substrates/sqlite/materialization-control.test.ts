import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import { Digest, Revision, SemVer } from "../../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    DeploymentRecord,
    ManagedOrigin,
    MaterializationOutboxEntry,
    MaterializationPlanAdmissionPort,
    MaterializationPlan,
    MaterializationRollout,
    MaterializationRolloutController,
    PolicySet,
    PlatformCompatibility,
    ValidationAttestation,
    policyProjection
} from "../../../src/definition";
import { TenantId } from "../../../src/identity";
import { SqliteMaterializationStore, type TransactionalSqlite } from "../../../src/substrates";
import { TestSqlite } from "../../helpers/sqlite";
import type { SqliteRow, SqliteValue } from "../../../src/substrates";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const tenantActor = new ActorRef("tenant", new ActorId(tenantId.value));
const key = new DeploymentKey("platform");
const deploymentId = DeploymentId.derive(tenantId, key);

describe("SQLite materialization rollout control", () => {
    test("requires a Tenant owner and a complete marked schema", () => {
        expect(() =>
            SqliteMaterializationStore.control(
                new TestSqlite(),
                new ActorRef("workspace", new ActorId("workspace"))
            )
        ).toThrow(/Tenant Actor/);

        const partial = new TestSqlite();
        partial.run("CREATE TABLE definition_deployments (id TEXT)", []);
        expect(() => SqliteMaterializationStore.control(partial, tenantActor)).toThrow(
            /reset.required/
        );

        const missing = new TestSqlite();
        SqliteMaterializationStore.control(missing, tenantActor);
        missing.run("DROP TABLE definition_materialization_outbox", []);
        expect(() => SqliteMaterializationStore.control(missing, tenantActor)).toThrow(/missing/);

        const owned = new TestSqlite();
        SqliteMaterializationStore.control(owned, tenantActor);
        expect(() =>
            SqliteMaterializationStore.control(owned, new ActorRef("tenant", new ActorId("other")))
        ).toThrow(/owner or version/);

        const missingIndex = new TestSqlite();
        SqliteMaterializationStore.control(missingIndex, tenantActor);
        missingIndex.run("DROP INDEX definition_materialization_outbox_rollout", []);
        expect(() => SqliteMaterializationStore.control(missingIndex, tenantActor)).toThrow(
            /outbox index/
        );

        const trigger = new TestSqlite();
        SqliteMaterializationStore.control(trigger, tenantActor);
        trigger.run(
            `CREATE TRIGGER forbidden_control_trigger AFTER INSERT
             ON definition_materialization_outbox BEGIN SELECT 1; END`,
            []
        );
        expect(() => SqliteMaterializationStore.control(trigger, tenantActor)).toThrow(
            /must not contain triggers/
        );

        const extraIndex = new TestSqlite();
        SqliteMaterializationStore.control(extraIndex, tenantActor);
        extraIndex.run(
            "CREATE INDEX forbidden_control_index ON definition_deployments (revision)",
            []
        );
        expect(() => SqliteMaterializationStore.control(extraIndex, tenantActor)).toThrow(
            /unexpected index/
        );
    });

    test("validates deployment projections revisions and missing lookups", () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const controller = controllerFor(store);
        beginRollout(controller, plan(1));
        const deployment = store.transaction((transaction) =>
            store.loadDeployment(transaction, deploymentId)!
        );
        expect(
            store.transaction((transaction) =>
                store.loadDeployment(
                    transaction,
                    DeploymentId.derive(tenantId, new DeploymentKey("missing"))
                )
            )
        ).toBeUndefined();
        expect(
            store.transaction((transaction) =>
                store.compareAndSetDeployment(transaction, new Revision(99), deployment)
            )
        ).toBe(false);
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    deployment.revision,
                    new DeploymentRecord(
                        deployment.id,
                        deployment.tenantId,
                        deployment.key,
                        deployment.activePlanId,
                        deployment.pendingRolloutId,
                        deployment.nextGeneration,
                        deployment.revision.next().next()
                    )
                )
            )
        ).toThrow(/skipped revision/);
        const foreignTenant = new TenantId("foreign");
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    undefined,
                    DeploymentRecord.initial(foreignTenant, key)
                )
            )
        ).toThrow(/foreign owner/);

        database.run("UPDATE definition_deployments SET deployment_key = 'corrupt'", []);
        expect(() =>
            store.transaction((transaction) => store.loadDeployment(transaction, deploymentId))
        ).toThrow(/projection|codec bytes/);
    });

    test("persists and restores immutable validation attestations", () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const attestation = validationAttestation();
        store.transaction((transaction) => store.insertAttestation(transaction, attestation));
        expect(
            store.transaction((transaction) => store.loadAttestation(transaction, attestation.id))
        ).toEqual(attestation);
        expect(
            store.transaction((transaction) =>
                store.loadAttestation(transaction, digest("missing-attestation"))
            )
        ).toBeUndefined();
        store.transaction((transaction) => store.insertAttestation(transaction, attestation));
        expect(() => SqliteMaterializationStore.control(database, tenantActor)).not.toThrow();
        database.run("UPDATE definition_validation_attestations SET record = ?", [
            new Uint8Array([0])
        ]);
        expect(() => SqliteMaterializationStore.control(database, tenantActor)).toThrow();
    });

    test("requires rollout and outbox closure and exact outbox CAS", () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const materializationPlan = plan(1);
        const rollout = new MaterializationRollout({ plan: materializationPlan });
        const orphanEntry = MaterializationOutboxEntry.pending(
            rollout.id,
            materializationPlan.actors[0]!
        );
        expect(() =>
            store.transaction((transaction) => store.insertOutbox(transaction, orphanEntry))
        ).toThrow(/stored rollout/);
        expect(() =>
            store.transaction((transaction) => store.insertRollout(transaction, rollout))
        ).toThrow(/stored deployment/);

        const controller = controllerFor(store);
        const storedRollout = beginRollout(controller, materializationPlan);
        const entry = store.transaction(
            (transaction) => store.listOutbox(transaction, storedRollout.id)[0]!
        );
        expect(
            store.transaction((transaction) => store.loadOutbox(transaction, digest("missing")))
        ).toBeUndefined();
        expect(
            store.transaction((transaction) =>
                store.loadRollout(transaction, digest("missing-rollout"))
            )
        ).toBeUndefined();
        expect(
            store.transaction((transaction) =>
                store.listOutbox(transaction, digest("missing-rollout"))
            )
        ).toEqual([]);
        expect(
            store.transaction((transaction) =>
                store.compareAndSetOutbox(transaction, new Revision(99), entry.attempted())
            )
        ).toBe(false);
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetOutbox(
                    transaction,
                    entry.revision,
                    new MaterializationOutboxEntry(
                        entry.rolloutId,
                        entry.target,
                        entry.actorPlanId,
                        "pending",
                        entry.attempts,
                        undefined,
                        entry.revision.next().next(),
                        entry.id
                    )
                )
            )
        ).toThrow(/transition is invalid|transition history/);

        database.run("DELETE FROM definition_materialization_rollouts", []);
        expect(() => SqliteMaterializationStore.control(database, tenantActor)).toThrow(
            /no rollout/
        );
    });

    test.each(["rollout_id", "target_kind", "target_id", "status", "revision"] as const)(
        "rejects corrupt outbox %s projections",
        (projection) => {
            const database = new TestSqlite();
            const store = SqliteMaterializationStore.control(database, tenantActor);
            const rollout = beginRollout(controllerFor(store), plan(1));
            const entry = store.transaction(
                (transaction) => store.listOutbox(transaction, rollout.id)[0]!
            );
            const value =
                projection === "revision"
                    ? 7
                    : projection === "status"
                      ? "acknowledged"
                      : projection === "target_kind"
                        ? "run"
                        : projection === "rollout_id"
                          ? digest("other").value
                          : "other";
            database.run(
                `UPDATE definition_materialization_outbox SET ${projection} = ? WHERE id = ?`,
                [value, entry.id.value]
            );
            expect(() =>
                store.transaction((transaction) => store.loadOutbox(transaction, entry.id))
            ).toThrow(/projection/);
        }
    );

    test("rejects truncated target outbox closure on completion and restart", () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const controller = controllerFor(store);
        const rollout = beginRollout(controller, plan(1));
        database.run("DELETE FROM definition_materialization_outbox", []);
        expect(() => controller.complete(rollout.id)).toThrow(/exact target closure/);
        expect(() => SqliteMaterializationStore.control(database, tenantActor)).toThrow(
            /exact target closure/
        );
    });

    test("fails closed on missing or multiply returned control writes", () => {
        for (const fault of ["deployment-empty", "deployment-multiple"] as const) {
            const database = new FaultControlSqlite();
            const store = SqliteMaterializationStore.control(database, tenantActor);
            database.fault = fault;
            const deployment = DeploymentRecord.initial(tenantId, key);
            if (fault === "deployment-empty") {
                expect(
                    store.transaction((transaction) =>
                        store.compareAndSetDeployment(transaction, undefined, deployment)
                    )
                ).toBe(false);
                expect(
                    store.transaction((transaction) =>
                        store.loadDeployment(transaction, deployment.id)
                    )
                ).toBeUndefined();
            } else {
                expect(() =>
                    store.transaction((transaction) =>
                        store.compareAndSetDeployment(transaction, undefined, deployment)
                    )
                ).toThrow(/multiple rows/);
            }
        }

        for (const fault of ["rollout-drop", "outbox-drop"] as const) {
            const database = new FaultControlSqlite();
            const store = SqliteMaterializationStore.control(database, tenantActor);
            const deployment = DeploymentRecord.initial(tenantId, key);
            store.transaction((transaction) => {
                store.compareAndSetDeployment(transaction, undefined, deployment);
                store.insertAttestation(transaction, validationAttestation(1));
            });
            const rollout = new MaterializationRollout({ plan: plan(1) });
            database.fault = fault;
            if (fault === "rollout-drop") {
                expect(() =>
                    store.transaction((transaction) => store.insertRollout(transaction, rollout))
                ).toThrow(/immutable/);
            } else {
                database.fault = "none";
                store.transaction((transaction) => store.insertRollout(transaction, rollout));
                database.fault = fault;
                const entry = MaterializationOutboxEntry.pending(
                    rollout.id,
                    rollout.plan.actors[0]!
                );
                expect(() =>
                    store.transaction((transaction) => store.insertOutbox(transaction, entry))
                ).toThrow(/immutable/);
            }
        }
    });
});

class FaultControlSqlite extends TestSqlite {
    public fault:
        "none" | "deployment-empty" | "deployment-multiple" | "rollout-drop" | "outbox-drop" =
        "none";

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (
            this.fault === "deployment-empty" &&
            /INSERT INTO definition_deployments/u.test(statement)
        ) {
            return [];
        }
        const rows = super.all(statement, bindings);
        return this.fault === "deployment-multiple" &&
            /INSERT INTO definition_deployments/u.test(statement)
            ? [...rows, ...rows]
            : rows;
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        if (
            (this.fault === "rollout-drop" &&
                /INSERT INTO definition_materialization_rollouts/u.test(statement)) ||
            (this.fault === "outbox-drop" &&
                /INSERT INTO definition_materialization_outbox/u.test(statement))
        ) {
            return;
        }
        super.run(statement, bindings);
    }
}

function plan(generation: number): MaterializationPlan {
    const attestation = validationAttestation(generation);
    const origin = new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: attestation.id,
        blueprintDigest: attestation.blueprintDigest,
        packageLockDigest: attestation.packageLockDigest,
        configDigest: digest("config"),
        generation
    });
    return new MaterializationPlan({
        origin,
        actors: [
            new ActorPlan({
                actor: new ActorRef("workspace", new ActorId("workspace")),
                origin,
                projections: [policyProjection("policy", PolicySet.empty())]
            })
        ]
    });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

function validationAttestation(generation = 1): ValidationAttestation {
    return new ValidationAttestation({
        definitionDigest: digest("definition"),
        blueprintDigest: digest(`blueprint:${generation}`),
        packageLockDigest: digest(`lock:${generation}`),
        snapshotDigest: digest("snapshot"),
        configSchemaDigest: digest("schema"),
        declarationDigest: digest("declarations"),
        placementDigest: digest("placements"),
        target: new PlatformCompatibility({
            spec: new SemVer("1.0.0"),
            host: new SemVer("1.0.0")
        })
    });
}

function beginRollout(
    controller: MaterializationRolloutController<TransactionalSqlite>,
    materializationPlan: MaterializationPlan
): MaterializationRollout {
    return controller.begin(
        materializationPlan,
        key,
        undefined,
        undefined,
        validationAttestation(materializationPlan.generation)
    );
}

function controllerFor(
    store: import("../../../src/definition").MaterializationControlStore<TransactionalSqlite>
): MaterializationRolloutController<TransactionalSqlite> {
    return new MaterializationRolloutController(
        store,
        new (class extends MaterializationPlanAdmissionPort {
            public permits(): boolean {
                return true;
            }
        })()
    );
}

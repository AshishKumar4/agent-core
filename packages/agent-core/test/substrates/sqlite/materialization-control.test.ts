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

describe("SQLite materialization rollout control corruption and lineage", () => {
    test("rejects each drifted deployment projection with the exact corruption error", { tags: "p1" }, () => {
        const corruption = expect.objectContaining({
            code: "codec.invalid",
            message: "Stored deployment key or Tenant does not match codec bytes"
        });
        for (const [column, value] of [
            ["tenant_id", "other-tenant"],
            ["revision", 7],
            ["id", digest("swapped-deployment").value]
        ] as const) {
            const database = new TestSqlite();
            const store = SqliteMaterializationStore.control(database, tenantActor);
            beginRollout(controllerFor(store), plan(1));
            database.run(`UPDATE definition_deployments SET ${column} = ?`, [value]);
            const lookup = column === "id" ? digest("swapped-deployment") : deploymentId;
            expect(() =>
                store.transaction((transaction) =>
                    store.loadDeployment(transaction, new DeploymentId(lookup.value))
                )
            ).toThrowError(corruption);
            expect(() => SqliteMaterializationStore.control(database, tenantActor)).toThrowError(
                corruption
            );
        }
    });

    test("reports the exact immutable attestation identity when the insert row vanishes", { tags: "p1" }, () => {
        const database = new AttestationDropSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const attestation = validationAttestation(1);
        database.drop = true;
        expect(() =>
            store.transaction((transaction) => store.insertAttestation(transaction, attestation))
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: `Validation attestation ${attestation.id.value} is immutable`
            })
        );
    });

    test("rejects attestation rows whose key does not match their codec bytes", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const attestation = validationAttestation(1);
        const mismatch = expect.objectContaining({
            code: "codec.invalid",
            message: "Stored validation attestation key does not match codec bytes"
        });
        database.run("INSERT INTO definition_validation_attestations (id, record) VALUES (?, ?)", [
            digest("forged-attestation-key").value,
            ValidationAttestation.encode(attestation)
        ]);
        expect(() =>
            store.transaction((transaction) =>
                store.loadAttestation(transaction, digest("forged-attestation-key"))
            )
        ).toThrowError(mismatch);
        expect(() => SqliteMaterializationStore.control(database, tenantActor)).toThrowError(
            mismatch
        );
    });

    test("requires the stored validation attestation before accepting a rollout", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        store.transaction((transaction) => {
            expect(
                store.compareAndSetDeployment(
                    transaction,
                    undefined,
                    DeploymentRecord.initial(tenantId, key)
                )
            ).toBe(true);
        });
        expect(() =>
            store.transaction((transaction) =>
                store.insertRollout(transaction, new MaterializationRollout({ plan: plan(1) }))
            )
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Materialization rollout requires its stored validation attestation"
            })
        );
    });

    test("rejects drifted rollout and outbox key projections with exact corruption errors", { tags: "p1" }, () => {
        for (const [column, value] of [
            ["deployment_id", digest("drifted-deployment").value],
            ["generation", 5]
        ] as const) {
            const database = new TestSqlite();
            const store = SqliteMaterializationStore.control(database, tenantActor);
            const rollout = beginRollout(controllerFor(store), plan(1));
            database.run(`UPDATE definition_materialization_rollouts SET ${column} = ?`, [value]);
            expect(() =>
                store.transaction((transaction) => store.loadRollout(transaction, rollout.id))
            ).toThrowError(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: "Stored rollout projection does not match codec bytes"
                })
            );
        }

        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        beginRollout(controllerFor(store), plan(1));
        database.run("UPDATE definition_materialization_outbox SET id = ?", [
            digest("forged-outbox-id").value
        ]);
        expect(() =>
            store.transaction((transaction) =>
                store.loadOutbox(transaction, digest("forged-outbox-id"))
            )
        ).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored outbox projection does not match codec bytes"
            })
        );
    });

    test("resolves plans only by their exact identity across stored rollouts", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const rollout1 = beginRollout(controllerFor(store), plan(1));
        const secondPlan = plan(2);
        const rollout2 = new MaterializationRollout({ plan: secondPlan });
        store.transaction((transaction) => {
            store.insertAttestation(transaction, validationAttestation(2));
            store.insertRollout(transaction, rollout2);
        });

        const first = store.transaction((transaction) =>
            store.loadPlan(transaction, rollout1.plan.id)
        );
        const second = store.transaction((transaction) =>
            store.loadPlan(transaction, secondPlan.id)
        );
        expect(first?.id.value).toBe(rollout1.plan.id.value);
        expect(second?.id.value).toBe(secondPlan.id.value);
        expect(
            store.transaction((transaction) =>
                store.loadPlan(transaction, digest("missing-plan-id"))
            )
        ).toBeUndefined();
    });

    test("fails outbox CAS closed before validating an illegal transition", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const rollout = beginRollout(controllerFor(store), plan(1));
        const entry = store.transaction(
            (transaction) => store.listOutbox(transaction, rollout.id)[0]
        );
        expect(entry).toBeDefined();
        if (entry === undefined) return;
        const illegal = new MaterializationOutboxEntry(
            entry.rolloutId,
            entry.target,
            entry.actorPlanId,
            "acknowledged",
            entry.attempts + 1,
            digest("reply"),
            entry.revision.next().next(),
            entry.id
        );

        expect(
            store.transaction((transaction) =>
                store.compareAndSetOutbox(transaction, new Revision(99), illegal)
            )
        ).toBe(false);
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetOutbox(transaction, entry.revision, illegal)
            )
        ).toThrowError(
            expect.objectContaining({
                name: "AgentCoreError",
                code: "protocol.revision-conflict",
                message: "Materialization outbox transition is invalid"
            })
        );
        const persisted = store.transaction((transaction) =>
            store.loadOutbox(transaction, entry.id)
        );
        expect(persisted?.status).toBe("pending");
        expect(persisted?.revision.value).toBe(0);
    });

    test("fails outbox CAS closed on missing, duplicated, or tampered returned rows", { tags: "p0" }, () => {
        for (const fault of ["update-empty", "update-duplicate", "update-tamper"] as const) {
            const database = new OutboxCasFaultSqlite();
            const store = SqliteMaterializationStore.control(database, tenantActor);
            const rollout = beginRollout(controllerFor(store), plan(1));
            const entry = store.transaction(
                (transaction) => store.listOutbox(transaction, rollout.id)[0]
            );
            expect(entry).toBeDefined();
            if (entry === undefined) return;
            database.fault = fault;
            const attempt = (): boolean =>
                store.transaction((transaction) =>
                    store.compareAndSetOutbox(transaction, entry.revision, entry.attempted())
                );
            if (fault === "update-empty") {
                expect(attempt()).toBe(false);
            } else {
                expect(attempt).toThrowError(
                    expect.objectContaining({
                        code: "codec.invalid",
                        message: "Materialization outbox CAS returned malformed state"
                    })
                );
            }
        }
    });

    test("revalidates rollout closure dependencies on restart", { tags: "p1" }, () => {
        const missingDeployment = new TestSqlite();
        beginRollout(
            controllerFor(SqliteMaterializationStore.control(missingDeployment, tenantActor)),
            plan(1)
        );
        missingDeployment.run("DELETE FROM definition_deployments", []);
        expect(() =>
            SqliteMaterializationStore.control(missingDeployment, tenantActor)
        ).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored rollout has no deployment"
            })
        );

        const missingAttestation = new TestSqlite();
        beginRollout(
            controllerFor(SqliteMaterializationStore.control(missingAttestation, tenantActor)),
            plan(1)
        );
        missingAttestation.run("DELETE FROM definition_validation_attestations", []);
        expect(() =>
            SqliteMaterializationStore.control(missingAttestation, tenantActor)
        ).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Stored rollout has no validation attestation"
            })
        );
    });

    test("enforces deployment lineage against stored rollouts on CAS", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = SqliteMaterializationStore.control(database, tenantActor);
        const lineageConflict = expect.objectContaining({
            name: "AgentCoreError",
            code: "protocol.revision-conflict",
            message: "Deployment CAS has a foreign owner or skipped revision"
        });
        const initial = DeploymentRecord.initial(tenantId, key);
        store.transaction((transaction) => {
            expect(store.compareAndSetDeployment(transaction, undefined, initial)).toBe(true);
        });
        expect(
            store.transaction((transaction) =>
                store.compareAndSetDeployment(transaction, undefined, initial)
            )
        ).toBe(false);
        expect(
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    new Revision(0),
                    DeploymentRecord.initial(tenantId, new DeploymentKey("absent"))
                )
            )
        ).toBe(false);

        const rollout1 = new MaterializationRollout({ plan: plan(1) });
        const rollout2 = new MaterializationRollout({ plan: plan(2) });
        store.transaction((transaction) => {
            store.insertAttestation(transaction, validationAttestation(1));
            store.insertAttestation(transaction, validationAttestation(2));
            store.insertAttestation(transaction, validationAttestation(3));
            store.insertRollout(transaction, rollout1);
            store.insertRollout(transaction, rollout2);
        });
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    initial.revision,
                    initial.begin(digest("missing-rollout"), 1)
                )
            )
        ).toThrowError(lineageConflict);
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    initial.revision,
                    initial.begin(rollout2.id, 1)
                )
            )
        ).toThrowError(lineageConflict);

        store.transaction((transaction) => {
            expect(
                store.compareAndSetDeployment(
                    transaction,
                    initial.revision,
                    initial.begin(rollout1.id, 1)
                )
            ).toBe(true);
        });
        const pending = store.transaction((transaction) =>
            store.loadDeployment(transaction, deploymentId)
        );
        expect(pending?.pendingRolloutId?.value).toBe(rollout1.id.value);
        expect(pending?.nextGeneration).toBe(2);
        if (pending === undefined) return;

        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    pending.revision,
                    pending.complete(rollout1.id, digest("wrong-plan"))
                )
            )
        ).toThrowError(lineageConflict);
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    pending.revision,
                    pending.compensate(rollout1.id, rollout2.id, 2)
                )
            )
        ).toThrowError(lineageConflict);

        const rollout3 = new MaterializationRollout({ plan: plan(3), compensates: rollout1.id });
        store.transaction((transaction) => store.insertRollout(transaction, rollout3));
        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    pending.revision,
                    pending.compensate(rollout1.id, rollout3.id, 2)
                )
            )
        ).toThrowError(lineageConflict);

        expect(() =>
            store.transaction((transaction) =>
                store.compareAndSetDeployment(
                    transaction,
                    pending.revision,
                    new DeploymentRecord(
                        pending.id,
                        pending.tenantId,
                        pending.key,
                        rollout1.plan.id,
                        undefined,
                        pending.nextGeneration,
                        pending.revision.next().next()
                    )
                )
            )
        ).toThrowError(lineageConflict);

        store.transaction((transaction) => {
            expect(
                store.compareAndSetDeployment(
                    transaction,
                    pending.revision,
                    pending.complete(rollout1.id, rollout1.plan.id)
                )
            ).toBe(true);
        });
        const completed = store.transaction((transaction) =>
            store.loadDeployment(transaction, deploymentId)
        );
        expect(completed?.activePlanId?.value).toBe(rollout1.plan.id.value);
        expect(completed?.pendingRolloutId).toBeUndefined();
        expect(completed?.revision.value).toBe(2);
    });

    test("requires the exact control schema shape, marker row, and version", { tags: "p1" }, () => {
        const malformedTable = new TestSqlite();
        SqliteMaterializationStore.control(malformedTable, tenantActor);
        malformedTable.run("DROP TABLE definition_deployments", []);
        malformedTable.run("CREATE TABLE definition_deployments (sentinel TEXT) STRICT", []);
        expect(() => SqliteMaterializationStore.control(malformedTable, tenantActor)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message:
                    "Materialization reset required (reset-required): Materialization control schema is missing definition_deployments"
            })
        );

        const malformedIndex = new TestSqlite();
        SqliteMaterializationStore.control(malformedIndex, tenantActor);
        malformedIndex.run("DROP INDEX definition_materialization_outbox_rollout", []);
        malformedIndex.run(
            `CREATE INDEX definition_materialization_outbox_rollout
             ON definition_materialization_outbox (id)`,
            []
        );
        expect(() => SqliteMaterializationStore.control(malformedIndex, tenantActor)).toThrowError(
            expect.objectContaining({
                code: "codec.invalid",
                message:
                    "Materialization reset required (reset-required): Materialization control schema has a missing or malformed outbox index"
            })
        );

        const ownerOrVersion = expect.objectContaining({
            code: "codec.invalid",
            message:
                "Materialization reset required (reset-required): Materialization control schema owner or version is unsupported"
        });
        const missingMarkerRow = new TestSqlite();
        SqliteMaterializationStore.control(missingMarkerRow, tenantActor);
        missingMarkerRow.run("DELETE FROM definition_materialization_control_schema", []);
        expect(() =>
            SqliteMaterializationStore.control(missingMarkerRow, tenantActor)
        ).toThrowError(ownerOrVersion);

        const wrongVersion = new TestSqlite();
        SqliteMaterializationStore.control(wrongVersion, tenantActor);
        wrongVersion.run("PRAGMA ignore_check_constraints = ON", []);
        wrongVersion.run("UPDATE definition_materialization_control_schema SET version = 2", []);
        wrongVersion.run("PRAGMA ignore_check_constraints = OFF", []);
        expect(() => SqliteMaterializationStore.control(wrongVersion, tenantActor)).toThrowError(
            ownerOrVersion
        );
    });
});

class AttestationDropSqlite extends TestSqlite {
    public drop = false;

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        if (this.drop && /INSERT INTO definition_validation_attestations/u.test(statement)) {
            return;
        }
        super.run(statement, bindings);
    }
}

class OutboxCasFaultSqlite extends TestSqlite {
    public fault: "none" | "update-empty" | "update-duplicate" | "update-tamper" = "none";

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        const isOutboxUpdate = /UPDATE definition_materialization_outbox/u.test(statement);
        if (this.fault === "update-empty" && isOutboxUpdate) return [];
        const rows = super.all(statement, bindings);
        if (this.fault === "update-duplicate" && isOutboxUpdate) return [...rows, ...rows];
        if (this.fault === "update-tamper" && isOutboxUpdate) {
            return rows.map((row) => ({ ...row, record: Uint8Array.of(1) }));
        }
        return rows;
    }
}

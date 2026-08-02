import { describe, expect, test } from "vitest";
import { ContentRef, Digest } from "../../src/core";
import {
    AlarmReconciliationDriver,
    InvocationReconciler,
    type EffectAttemptId,
    type EffectReconciliationPort,
    type IndeterminateAttemptSource,
    type ReconciliationSchedulePort
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { OperationRequestKey } from "../../src/operations";
import { TestSqlite } from "../helpers/sqlite";
import {
    CanonicalBatchHarness,
    type CanonicalBatchHarnessState,
    canonicalBatchDescriptor,
    canonicalBatchFacet
} from "../integration/canonical-batch-harness";

const INTERVAL_MS = 30_000;

class DurableSchedule implements ReconciliationSchedulePort {
    public constructor(private readonly database: TestSqlite) {
        database.transaction(() =>
            database.run(
                `CREATE TABLE IF NOT EXISTS reconciliation_schedule (
                    driver TEXT PRIMARY KEY,
                    fire_at INTEGER NOT NULL
                ) STRICT`,
                []
            )
        );
    }

    public scheduled(): Date | undefined {
        const rows = this.database.transaction(() =>
            this.database.all("SELECT fire_at FROM reconciliation_schedule WHERE driver = ?", [
                "reconciliation"
            ])
        );
        const at = rows[0]?.fire_at;
        return typeof at === "number" ? new Date(at) : undefined;
    }

    public schedule(at: Date): void {
        this.database.transaction(() =>
            this.database.run(
                `INSERT INTO reconciliation_schedule (driver, fire_at) VALUES ('reconciliation', ?)
                 ON CONFLICT (driver) DO UPDATE SET fire_at = excluded.fire_at`,
                [at.getTime()]
            )
        );
    }

    public clear(): void {
        this.database.transaction(() =>
            this.database.run("DELETE FROM reconciliation_schedule WHERE driver = ?", [
                "reconciliation"
            ])
        );
    }
}

async function indeterminateFixture(id: string): Promise<{
    readonly harness: CanonicalBatchHarness;
    readonly attemptId: EffectAttemptId;
    readonly reconciler: (
        provider: EffectReconciliationPort<string, string>
    ) => InvocationReconciler<CanonicalBatchHarnessState, string, string, string, string, string>;
    readonly source: IndeterminateAttemptSource;
}> {
    const harness = new CanonicalBatchHarness(false);
    const invocation = new InvocationId(id);
    await harness.port.invoke({
        invocation,
        request: {
            requestKey: new OperationRequestKey(`request:${id}`),
            facet: canonicalBatchFacet,
            descriptor: canonicalBatchDescriptor,
            shape: { kind: "batch", itemCount: 1 },
            inputs: [{ value: 1 }],
            authorization: "authorization",
            interceptions: [[]],
            execute: async () => {
                throw new TypeError("provider response was lost");
            }
        }
    });
    const attempt = harness.transactions.transact(
        (transaction) => harness.persistence.attemptsForItem(transaction, invocation, 0)[0]!
    );
    const source: IndeterminateAttemptSource = {
        indeterminate: (limit) =>
            harness.transactions
                .transact((transaction) => {
                    const receipt = harness.ledger.currentReceipt(transaction, invocation, 0);
                    return receipt?.outcome === "indeterminate" ? [attempt.id] : [];
                })
                .slice(0, limit)
    };
    return {
        harness,
        attemptId: attempt.id,
        source,
        reconciler: (provider) =>
            new InvocationReconciler<
                CanonicalBatchHarnessState,
                string,
                string,
                string,
                string,
                string
            >(
                harness.transactions,
                harness.persistence,
                harness.ledger,
                provider,
                harness.records,
                harness.evidence,
                harness.now
            )
    };
}

function finalProvider(): EffectReconciliationPort<string, string> {
    return {
        query: async () => ({
            kind: "succeeded",
            result: ContentRef.fromDigest(Digest.sha256(new Uint8Array([7])))
        })
    };
}

function unknownProvider(): EffectReconciliationPort<string, string> {
    return { query: async () => ({ kind: "unknown" }) };
}

describe("reconciliation driver", () => {
    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] direct reconciler calls never establish scheduling",
        { tags: "p0" },
        async () => {
            const fixture = await indeterminateFixture("driver-direct");
            const schedule = new DurableSchedule(new TestSqlite());
            new AlarmReconciliationDriver(
                fixture.reconciler(finalProvider()),
                fixture.source,
                schedule,
                INTERVAL_MS,
                fixture.harness.now
            );

            const receipt = await fixture.reconciler(finalProvider()).reconcile(fixture.attemptId);
            expect(receipt?.outcome).toBe("succeeded");
            // The reconciler resolved the attempt, but scheduling belongs to the
            // named driver alone: nothing was armed.
            expect(schedule.scheduled()).toBeUndefined();
        }
    );

    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] the armed durable schedule survives restart and the sweep delivers reconciliation",
        { tags: "p0" },
        async () => {
            const fixture = await indeterminateFixture("driver-restart");
            const database = new TestSqlite();
            const armed = new AlarmReconciliationDriver(
                fixture.reconciler(finalProvider()),
                fixture.source,
                new DurableSchedule(database),
                INTERVAL_MS,
                fixture.harness.now
            ).arm();

            // Restart: a fresh driver and schedule port over the same durable
            // storage still sees the armed fire time.
            const restartedSchedule = new DurableSchedule(database);
            expect(restartedSchedule.scheduled()?.getTime()).toBe(armed.getTime());
            const restarted = new AlarmReconciliationDriver(
                fixture.reconciler(finalProvider()),
                fixture.source,
                restartedSchedule,
                INTERVAL_MS,
                fixture.harness.now
            );
            // arm() is idempotent against the persisted schedule.
            expect(restarted.arm().getTime()).toBe(armed.getTime());

            const report = await restarted.sweep();
            expect(report).toEqual({ queried: 1, reconciled: 1, remaining: false });
            expect(restartedSchedule.scheduled()).toBeUndefined();

            const receipt = fixture.harness.transactions.transact((transaction) =>
                fixture.harness.ledger.currentReceipt(
                    transaction,
                    new InvocationId("driver-restart"),
                    0
                )
            );
            expect(receipt?.outcome).toBe("succeeded");
        }
    );

    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] a sweep re-arms while attempts remain indeterminate",
        { tags: "p0" },
        async () => {
            const fixture = await indeterminateFixture("driver-rearm");
            const schedule = new DurableSchedule(new TestSqlite());
            const driver = new AlarmReconciliationDriver(
                fixture.reconciler(unknownProvider()),
                fixture.source,
                schedule,
                INTERVAL_MS,
                fixture.harness.now
            );
            driver.arm();

            const report = await driver.sweep();
            expect(report).toEqual({ queried: 1, reconciled: 0, remaining: true });
            expect(schedule.scheduled()).toBeDefined();
        }
    );
});

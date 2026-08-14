import { describe, expect, test } from "vitest";
import { ContentRef, Digest } from "../../src/core";
import {
    AlarmReconciliationDriver,
    AttemptReceipt,
    InvocationReconciler,
    type EffectAttemptId,
    type EffectReconciliationPort,
    type IndeterminateAttemptSource,
    type ReconciliationSchedulePort
} from "../../src/invocations";
import { InvocationId } from "../../src/interaction-references";
import { OperationRequestKey } from "../../src/operations";
import type { SqliteValue } from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import { expectAgentCoreError } from "../protocol/error-assertion";
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
        const [row] = rows;
        return row === undefined ? undefined : new Date(scheduledMillis(row["fire_at"]));
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
            cardinality: { kind: "batch", itemCount: 1 },
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

const untouchedReconciler = {
    async reconcile(): Promise<AttemptReceipt | undefined> {
        throw new TypeError("The reconciliation driver must not reconcile here");
    }
};

const emptyIndeterminateSource: IndeterminateAttemptSource = { indeterminate: () => [] };

/** Reads the schedule row's `fire_at` column, which the table declares INTEGER NOT NULL. */
function scheduledMillis(value: SqliteValue | undefined): number {
    // Number.isFinite answers true only for actual numbers, so the conversion is the identity.
    if (!Number.isFinite(value)) throw new TypeError("Scheduled fire_at must be an integer");
    return Number(value);
}

/** The reconciler seam the driver drives, narrowed to the one call the driver makes. */
interface DrivenReconciler {
    reconcile(): Promise<AttemptReceipt | undefined>;
}

function stalledReconciler(
    fixture: Awaited<ReturnType<typeof indeterminateFixture>>,
    invocation: InvocationId
): DrivenReconciler {
    return {
        async reconcile() {
            const receipt = fixture.harness.transactions.transact((transaction) =>
                fixture.harness.ledger.currentReceipt(transaction, invocation, 0)
            );
            if (!(receipt instanceof AttemptReceipt) || receipt.outcome !== "indeterminate") {
                throw new TypeError("The current Receipt must still be indeterminate");
            }
            return receipt;
        }
    };
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
        "[C13-EFFECT-RECONCILIATION-DRIVER] a failed sweep leaves the schedule armed for its attempts",
        { tags: "p0" },
        async () => {
            const fixture = await indeterminateFixture("driver-failed-sweep");
            const schedule = new DurableSchedule(new TestSqlite());
            const failing: EffectReconciliationPort<string, string> = {
                query: async () => {
                    throw new TypeError("provider unreachable");
                }
            };
            const driver = new AlarmReconciliationDriver(
                fixture.reconciler(failing),
                fixture.source,
                schedule,
                INTERVAL_MS,
                fixture.harness.now
            );
            driver.arm();

            await expect(driver.sweep()).rejects.toThrow();
            // Clearing before the work would strand the attempt with no armed schedule.
            expect(schedule.scheduled()).toBeDefined();
        }
    );

    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] restart repair arms only while attempts remain",
        { tags: "p0" },
        async () => {
            const fixture = await indeterminateFixture("driver-repair");
            const database = new TestSqlite();
            const schedule = new DurableSchedule(database);
            const driver = new AlarmReconciliationDriver(
                fixture.reconciler(finalProvider()),
                fixture.source,
                schedule,
                INTERVAL_MS,
                fixture.harness.now
            );

            // A schedule lost with work outstanding is reconstructed at startup.
            expect(driver.repair()).toBeDefined();
            expect(schedule.scheduled()).toBeDefined();

            await driver.sweep();
            expect(schedule.scheduled()).toBeUndefined();
            const restarted = new AlarmReconciliationDriver(
                fixture.reconciler(finalProvider()),
                fixture.source,
                new DurableSchedule(database),
                INTERVAL_MS,
                fixture.harness.now
            );
            expect(restarted.repair()).toBeUndefined();
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

    test("rejects a non-positive or unsafe sweep interval", { tags: "p1" }, () => {
        const schedule = new DurableSchedule(new TestSqlite());
        const now = (): Date => new Date(0);
        for (const intervalMs of [0, -INTERVAL_MS, 1.5, 2 ** 53]) {
            expectAgentCoreError(
                () =>
                    new AlarmReconciliationDriver(
                        untouchedReconciler,
                        emptyIndeterminateSource,
                        schedule,
                        intervalMs,
                        now
                    ),
                "protocol.invalid-state"
            );
        }
        expect(
            new AlarmReconciliationDriver(
                untouchedReconciler,
                emptyIndeterminateSource,
                schedule,
                1,
                now
            )
        ).toBeInstanceOf(AlarmReconciliationDriver);
    });

    test("rejects a non-positive or unsafe batch limit", { tags: "p1" }, () => {
        const schedule = new DurableSchedule(new TestSqlite());
        const now = (): Date => new Date(0);
        for (const batchLimit of [0, -8, 1.5, 2 ** 53]) {
            expectAgentCoreError(
                () =>
                    new AlarmReconciliationDriver(
                        untouchedReconciler,
                        emptyIndeterminateSource,
                        schedule,
                        INTERVAL_MS,
                        now,
                        batchLimit
                    ),
                "protocol.invalid-state"
            );
        }
        expect(
            new AlarmReconciliationDriver(
                untouchedReconciler,
                emptyIndeterminateSource,
                schedule,
                INTERVAL_MS,
                now,
                1
            )
        ).toBeInstanceOf(AlarmReconciliationDriver);
    });

    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] arm schedules the first sweep one interval after now",
        { tags: "p1" },
        () => {
            const schedule = new DurableSchedule(new TestSqlite());
            const epoch = 1_754_000_000_000;
            const armed = new AlarmReconciliationDriver(
                untouchedReconciler,
                emptyIndeterminateSource,
                schedule,
                INTERVAL_MS,
                () => new Date(epoch)
            ).arm();

            expect(armed.getTime()).toBe(epoch + INTERVAL_MS);
            expect(schedule.scheduled()?.getTime()).toBe(epoch + INTERVAL_MS);
        }
    );

    test(
        "[C13-EFFECT-RECONCILIATION-DRIVER] a sweep leaves a still-indeterminate attempt unreconciled and re-arms one interval after now",
        { tags: "p1" },
        async () => {
            const fixture = await indeterminateFixture("driver-stalled");
            const schedule = new DurableSchedule(new TestSqlite());
            const epoch = 1_754_000_000_000;
            const driver = new AlarmReconciliationDriver(
                stalledReconciler(fixture, new InvocationId("driver-stalled")),
                fixture.source,
                schedule,
                INTERVAL_MS,
                () => new Date(epoch)
            );

            const report = await driver.sweep();
            // The reconciler returned the still-indeterminate Receipt: the
            // attempt counts as queried but never as reconciled.
            expect(report).toEqual({ queried: 1, reconciled: 0, remaining: true });
            expect(schedule.scheduled()?.getTime()).toBe(epoch + INTERVAL_MS);
        }
    );
});

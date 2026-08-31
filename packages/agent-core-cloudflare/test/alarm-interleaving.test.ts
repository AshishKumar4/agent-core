import { AlarmOutboxReconciler, DurableAlarmClaims } from "../src/index.js";
import type { AlarmStorageLike } from "../src/index.js";
import { SqliteApplicationMigrator } from "../src/migration.js";
import { FakeReconciliationOutbox, fakeErrors } from "./fakes.js";
import { NodeSqlite } from "./node-sqlite.js";

const RUNTIME_OWNER = "agent-core.runtime";

/**
 * A physical alarm whose every await is a promise the test releases by hand. The race this
 * file exists for needs two tasks suspended inside the same storage call and resumed in a
 * chosen order, which a fake that settles immediately can never express.
 */
class ControllableAlarmStorage implements AlarmStorageLike {
    public scheduledAt: number | null = null;
    public readonly setCalls: number[] = [];
    public deleteCalls = 0;
    readonly #pending: Array<() => void> = [];

    /** Releases the oldest suspended storage call and lets its task resume. */
    public async release(): Promise<void> {
        const next = this.#pending.shift();
        if (next === undefined) throw new TypeError("No suspended alarm storage call to release");
        next();
        // Two microtask drains: one for the released promise, one for the continuation it
        // schedules. Awaiting a resolved promise is how a suspended task gets its turn back.
        await Promise.resolve();
        await Promise.resolve();
    }

    /** How many storage calls are currently suspended. */
    public get suspended(): number {
        return this.#pending.length;
    }

    public async getAlarm(): Promise<number | null> {
        await this.#suspend();
        return this.scheduledAt;
    }

    public async setAlarm(scheduledTime: number): Promise<void> {
        await this.#suspend();
        this.scheduledAt = scheduledTime;
        this.setCalls.push(scheduledTime);
    }

    public async deleteAlarm(): Promise<void> {
        await this.#suspend();
        this.scheduledAt = null;
        this.deleteCalls += 1;
    }

    async #suspend(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.#pending.push(resolve);
        });
    }
}

function reconciler() {
    const database = new NodeSqlite();
    new SqliteApplicationMigrator(database, fakeErrors).migrate();
    const physical = new ControllableAlarmStorage();
    const claims = new DurableAlarmClaims(database, fakeErrors);
    const outbox = new FakeReconciliationOutbox();
    const driver = new AlarmOutboxReconciler(
        claims.owner(RUNTIME_OWNER, physical),
        outbox,
        async () => undefined,
        fakeErrors
    );
    return { physical, claims, outbox, driver };
}

/** Lets every task that is not waiting on the controllable storage reach its next await. */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

/**
 * Drives `tasks` to completion, releasing a suspended storage call whenever one exists and
 * yielding when none does yet.
 *
 * Waiting for a suspension rather than requiring one up front is the whole point. A task
 * reaches its first storage call some number of microtask hops after it is started, and how
 * many is an implementation detail of the code under test — serializing synchronization added
 * one such hop. A helper that samples `suspended` once and stops when it reads zero
 * therefore stops before the work it was asked to drive has begun, and the caller then awaits
 * a task nothing will ever release. Bounded, so a genuine non-convergence fails here instead
 * of hanging the suite.
 */
async function driveToCompletion(
    physical: ControllableAlarmStorage,
    ...tasks: readonly Promise<void>[]
): Promise<void> {
    let outstanding = tasks.length;
    for (const task of tasks) {
        // Rejections are observed here only to keep the loop from spinning; `Promise.all`
        // below is what reports them, so a real failure is never swallowed.
        void task.then(
            () => {
                outstanding -= 1;
            },
            () => {
                outstanding -= 1;
            }
        );
    }
    for (let turn = 0; turn < 512 && outstanding > 0; turn += 1) {
        if (physical.suspended > 0) await physical.release();
        else await settle();
    }
    if (outstanding > 0) {
        throw new TypeError("Alarm synchronization did not converge within the drive budget");
    }
    await Promise.all(tasks);
}

async function firstDue(outbox: FakeReconciliationOutbox) {
    const due = await outbox.dueIds(Number.MAX_SAFE_INTEGER, 1);
    const entry = due[0];
    if (entry === undefined) throw new TypeError("Expected a due outbox entry");
    return entry.id;
}

describe("alarm synchronization under interleaving", () => {
    /**
     * The failure this guards: a sweep-end drain that observed an empty outbox racing a
     * request's enqueue and arm. The drain's decision is taken from a read before its first
     * await and applied after later ones, and both tasks write the same owner's claim, so an
     * unserialized pair could interleave into outbox-has-work with no claim and no alarm —
     * a durably accepted entry with no wakeup and nothing scheduled to repair it.
     */
    test(
        "a drain racing an arm leaves the newer wakeup armed, never a due entry with no alarm",
        { tags: "p0" },
        async () => {
            const { physical, claims, outbox, driver } = reconciler();

            // The state a just-finished sweep leaves: the claim row still holds the fired
            // time, and the platform has already consumed the physical alarm.
            claims.claim(RUNTIME_OWNER, 10);
            physical.scheduledAt = null;

            // Task A: the sweep-end repair, which will observe a drained outbox.
            const drain = driver.repairAlarm();
            await settle();

            // Task R: a request that durably enqueues due work and arms for it. The enqueue
            // is durable before the arm, which is the ordering the outbox contract promises.
            outbox.enqueue("accepted", 50);
            const arm = driver.armAlarm();
            await settle();

            // Drive both, releasing every suspended storage call, so neither task completes
            // a read-decide-write span without the other interleaved into it.
            await driveToCompletion(physical, drain, arm);

            // The invariant: a due entry implies an armed alarm.
            expect(await outbox.nextDueAt()).toBe(50);
            expect(physical.scheduledAt).toBe(50);
            expect(claims.claimed(RUNTIME_OWNER)).toBe(50);
            expect(claims.earliest()).toBe(50);
        }
    );

    /**
     * The same pair in the opposite order. The drain must still win when it is genuinely
     * last, or a drained outbox would leave a claim behind for work that no longer exists.
     */
    test(
        "a drain that is genuinely last releases the claim and tears the alarm down",
        { tags: "p0" },
        async () => {
            const { physical, claims, outbox, driver } = reconciler();
            outbox.enqueue("accepted", 50);

            await driveToCompletion(physical, driver.armAlarm());
            expect(physical.scheduledAt).toBe(50);

            await outbox.acknowledge({ id: await firstDue(outbox), scheduledAt: 50 });
            await driveToCompletion(physical, driver.repairAlarm());

            expect(await outbox.nextDueAt()).toBeNull();
            expect(claims.claimed(RUNTIME_OWNER)).toBeNull();
            expect(physical.scheduledAt).toBeNull();
        }
    );

    /**
     * The fence in isolation: a release carrying a stale due time removes nothing, so a
     * decision taken before an await cannot delete a claim written during it.
     */
    test(
        "a release fenced on a stale due time leaves a newer claim standing",
        { tags: "p0" },
        () => {
            const database = new NodeSqlite();
            new SqliteApplicationMigrator(database, fakeErrors).migrate();
            const claims = new DurableAlarmClaims(database, fakeErrors);

            claims.claim(RUNTIME_OWNER, 10);
            const observed = claims.claimed(RUNTIME_OWNER);
            claims.claim(RUNTIME_OWNER, 50);

            claims.release(RUNTIME_OWNER, observed);
            expect(claims.claimed(RUNTIME_OWNER)).toBe(50);

            claims.release(RUNTIME_OWNER, 50);
            expect(claims.claimed(RUNTIME_OWNER)).toBeNull();

            // Nothing observed releases nothing: another task's claim is not this one's to
            // drop.
            claims.claim(RUNTIME_OWNER, 70);
            claims.release(RUNTIME_OWNER, null);
            expect(claims.claimed(RUNTIME_OWNER)).toBe(70);
        }
    );
});

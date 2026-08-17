import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { SynchronousSqlitePort } from "./migration.js";
import { isFiniteNumber } from "./platform-value.js";
import type { AlarmStorageLike } from "./reconciliation.js";
import type { SqliteValue } from "./sqlite.js";

const READ_CLAIM = "SELECT due_at FROM agent_core_alarm_claims WHERE owner = ?";
const WRITE_CLAIM = `INSERT INTO agent_core_alarm_claims (owner, due_at) VALUES (?, ?)
     ON CONFLICT (owner) DO UPDATE SET due_at = excluded.due_at`;
const DELETE_CLAIM = "DELETE FROM agent_core_alarm_claims WHERE owner = ?";
const READ_EARLIEST = "SELECT MIN(due_at) AS due_at FROM agent_core_alarm_claims";

/**
 * A Durable Object has exactly one alarm. Every scheduler that wants one records a
 * durable claim here instead of writing the alarm directly, and the physical alarm
 * tracks the earliest live claim — so two schedulers in one object cannot delete or
 * overwrite each other's wakeups.
 */
export class DurableAlarmClaims {
    public constructor(
        private readonly database: SynchronousSqlitePort,
        private readonly errors: CloudflareErrorPort
    ) {}

    /** The storage seam a single claimant sees: its own claim, mediated. */
    public owner(name: string, alarms: AlarmStorageLike): AlarmStorageLike {
        requireOwner(name, this.errors);
        return new ClaimedAlarmStorage(this, name, alarms);
    }

    public claimed(owner: string): number | null {
        const rows = this.database.all(READ_CLAIM, [owner]);
        if (rows.length === 0) return null;
        return this.requireStoredTime(rows[0]?.due_at);
    }

    public claim(owner: string, dueAt: number): void {
        this.database.run(WRITE_CLAIM, [owner, dueAt]);
    }

    public release(owner: string): void {
        this.database.run(DELETE_CLAIM, [owner]);
    }

    public earliest(): number | null {
        const rows = this.database.all(READ_EARLIEST, []);
        if (rows.length !== 1) {
            operationalFailure(
                this.errors,
                "operation.invalid-output",
                "SQLite alarm claim query returned an invalid row count"
            );
        }
        const value = rows[0]?.due_at;
        if (value === null || value === undefined) return null;
        return this.requireStoredTime(value);
    }

    private requireStoredTime(value: SqliteValue | undefined): number {
        if (!isFiniteNumber(value) || !Number.isSafeInteger(value) || value < 0) {
            operationalFailure(
                this.errors,
                "codec.invalid",
                "Stored alarm claim time is not a nonnegative safe integer"
            );
        }
        return value;
    }
}

class ClaimedAlarmStorage implements AlarmStorageLike {
    public constructor(
        private readonly claims: DurableAlarmClaims,
        private readonly name: string,
        private readonly alarms: AlarmStorageLike
    ) {}

    public async getAlarm(): Promise<number | null> {
        const claimed = this.claims.claimed(this.name);
        if (claimed === null) return null;
        // A claim is armed only while the platform alarm still reflects the claim set. The
        // platform clears that alarm before `alarm()` runs while this row survives, so
        // returning the bare row would tell a scheduler its wakeup exists when nothing
        // will fire — and a scheduler that skips an unchanged write on that answer leaves
        // the object with due work and no wakeup.
        return (await this.alarms.getAlarm()) === null ? null : claimed;
    }

    public async setAlarm(scheduledTime: number): Promise<void> {
        this.claims.claim(this.name, scheduledTime);
        await this.synchronize();
    }

    public async deleteAlarm(): Promise<void> {
        this.claims.release(this.name);
        await this.synchronize();
    }

    private async synchronize(): Promise<void> {
        // Read the claim set last. A stale `actual` costs at most a redundant write, but a
        // stale `earliest` arms the physical alarm behind a claim another owner registered
        // during the await, losing that owner's wakeup — the clobbering this ledger exists
        // to prevent. Nothing awaits between this read and the write it decides.
        const actual = await this.alarms.getAlarm();
        const earliest = this.claims.earliest();
        if (earliest === null) {
            if (actual !== null) await this.alarms.deleteAlarm();
            return;
        }
        if (actual !== earliest) await this.alarms.setAlarm(earliest);
    }
}

function requireOwner(name: string, errors: CloudflareErrorPort): void {
    if (!isCanonicalOwner(name)) {
        operationalFailure(
            errors,
            "protocol.invalid-state",
            "Alarm claim owner must be nonempty canonical text"
        );
    }
}

function isCanonicalOwner(value: unknown): value is string {
    return typeof value === "string" && value.length !== 0 && value === value.trim();
}

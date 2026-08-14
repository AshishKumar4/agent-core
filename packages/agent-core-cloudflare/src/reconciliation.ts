import type { AgentCoreError } from "@agent-core/core";
import type { CloudflareErrorPort } from "./error.js";
import { operationalError, operationalFailure } from "./error.js";
import type { SynchronousSqlitePort } from "./migration.js";
import { ReconciliationOutboxId } from "./id.js";
import { isFiniteNumber } from "./platform-value.js";
import type { SqliteValue } from "./sqlite.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_RETRY_DELAY_MS = 30_000;

export interface AlarmStorageLike {
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
}

/** One due entry: the ID to reconcile and the schedule that made it due. */
export interface DueReconciliation {
    readonly id: ReconciliationOutboxId;
    readonly scheduledAt: number;
}

/**
 * The outbox retains scheduling and payload ownership; this seam exposes IDs only.
 *
 * Reconciliation awaits application work while the Durable Object's input gate is
 * open, so a request can reschedule an entry mid-flight. Both write paths therefore
 * fence on the schedule the reconciler observed: a newer schedule survives.
 */
export interface ReconciliationOutbox {
    dueIds(now: number, limit: number): Promise<readonly DueReconciliation[]>;
    nextDueAt(): Promise<number | null>;
    acknowledge(due: DueReconciliation): Promise<void>;
    reschedule(due: DueReconciliation, scheduledAt: number): Promise<void>;
}

/** Implementations must be idempotent for every repeated call with the same outbox ID. */
export type IdempotentReconciliation = (outboxId: ReconciliationOutboxId) => Promise<void>;

export interface ReconciliationClock {
    now(): number;
}

export interface AlarmReconciliationOptions {
    readonly batchSize?: number;
    readonly retryDelayMs?: number;
    readonly clock?: ReconciliationClock;
}

/** One entry the sweep could not reconcile, kept with the cause that rescheduled it. */
export interface ReconciliationFailure {
    readonly id: ReconciliationOutboxId;
    readonly cause: AgentCoreError;
}

export interface AlarmReconciliationResult {
    readonly succeededIds: readonly ReconciliationOutboxId[];
    readonly failures: readonly ReconciliationFailure[];
}

export class AlarmOutboxReconciler {
    readonly #batchSize: number;
    readonly #retryDelayMs: number;
    readonly #clock: ReconciliationClock;

    public constructor(
        private readonly alarms: AlarmStorageLike,
        private readonly outbox: ReconciliationOutbox,
        private readonly reconcile: IdempotentReconciliation,
        private readonly errors: CloudflareErrorPort,
        options: AlarmReconciliationOptions = {}
    ) {
        this.#batchSize = requirePositiveConfigInteger(
            options.batchSize ?? DEFAULT_BATCH_SIZE,
            "batch size"
        );
        this.#retryDelayMs = requirePositiveConfigInteger(
            options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
            "retry delay"
        );
        this.#clock = options.clock ?? { now: Date.now };
    }

    /** Call after durably enqueuing an ID; restart repair covers a crash before this call. */
    public async armAlarm(): Promise<void> {
        await this.synchronizeAlarm();
    }

    /** Call during Actor startup to reconstruct the physical alarm from durable outbox state. */
    public async repairAlarm(): Promise<void> {
        await this.synchronizeAlarm();
    }

    /** `notBefore` floors the physical alarm; entries stay due at their outbox schedule. */
    private async synchronizeAlarm(notBefore = 0): Promise<void> {
        const expected = await this.operation("Reconciliation outbox read failed", () =>
            this.outbox.nextDueAt()
        );
        requireOutputTime(expected, "Outbox next due time", this.errors);
        const actual = await this.operation("Physical alarm read failed", () =>
            this.alarms.getAlarm()
        );
        requireOutputTime(actual, "Physical alarm time", this.errors);
        if (expected === null) {
            if (actual !== null) {
                await this.operation("Physical alarm deletion failed", () =>
                    this.alarms.deleteAlarm()
                );
            }
            return;
        }
        const scheduledAt = Math.max(expected, notBefore);
        if (actual !== scheduledAt) {
            await this.operation("Physical alarm write failed", () =>
                this.alarms.setAlarm(scheduledAt)
            );
        }
    }

    public async handleAlarm(): Promise<AlarmReconciliationResult> {
        const now = this.#clock.now();
        requireOutputTime(now, "Reconciliation clock time", this.errors);
        const succeededIds: ReconciliationOutboxId[] = [];
        const failures: ReconciliationFailure[] = [];
        const visited = new Set<string>();
        try {
            const due = await this.operation("Reconciliation outbox due query failed", () =>
                this.outbox.dueIds(now, this.#batchSize)
            );
            for (const entry of due) {
                requireOutputId(entry?.id, this.errors);
                requireOutputTime(entry.scheduledAt, "Due reconciliation schedule", this.errors);
                const id = entry.id;
                if (visited.has(id.value)) continue;
                visited.add(id.value);
                let cause: AgentCoreError;
                try {
                    await this.reconcile(id);
                    await this.operation(
                        `Reconciliation outbox acknowledgement failed for ${id}`,
                        () => this.outbox.acknowledge(entry)
                    );
                    succeededIds.push(id);
                    continue;
                } catch (failure) {
                    cause = operationalError(
                        this.errors,
                        "protocol.invalid-state",
                        `Reconciliation failed for ${id}`,
                        { value: failure }
                    );
                }
                const retryAt = this.retryTime(now);
                await this.operation(`Reconciliation outbox reschedule failed for ${id}`, () =>
                    this.outbox.reschedule(entry, retryAt)
                );
                failures.push(Object.freeze({ id, cause }));
            }
        } catch (cause) {
            // Entries the sweep never reached stay due in the past, so rearming at the
            // outbox schedule refires the alarm immediately: floor it one retry delay out.
            try {
                await this.synchronizeAlarm(this.retryTime(now));
            } catch {
                // Nothing here may replace the in-flight failure: it is the root cause, and
                // the alarm is repaired from durable outbox state on the next arm or startup.
            }
            throw cause;
        }
        await this.repairAlarm();
        return Object.freeze({
            succeededIds: Object.freeze(succeededIds),
            failures: Object.freeze(failures)
        });
    }

    private retryTime(now: number): number {
        if (now > Number.MAX_SAFE_INTEGER - this.#retryDelayMs) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Reconciliation retry time exceeds the maximum safe integer"
            );
        }
        return now + this.#retryDelayMs;
    }

    private async operation<Result>(
        message: string,
        operation: () => Promise<Result>
    ): Promise<Result> {
        try {
            return await operation();
        } catch (cause) {
            operationalFailure(this.errors, "protocol.invalid-state", message, { value: cause });
        }
    }
}

export class SqliteReconciliationOutbox implements ReconciliationOutbox {
    public constructor(
        private readonly database: SynchronousSqlitePort,
        private readonly errors: CloudflareErrorPort
    ) {}

    public enqueue(id: ReconciliationOutboxId, scheduledAt: number): void {
        requireInputId(id, this.errors);
        requireInputTime(scheduledAt, "Reconciliation schedule time", this.errors);
        this.database.run(
            `INSERT INTO agent_core_reconciliation_outbox (id, scheduled_at) VALUES (?, ?)
             ON CONFLICT (id) DO UPDATE SET scheduled_at = excluded.scheduled_at`,
            [id.value, scheduledAt]
        );
    }

    public async dueIds(now: number, limit: number): Promise<readonly DueReconciliation[]> {
        requireInputTime(now, "Reconciliation query time", this.errors);
        requireInputPositiveInteger(limit, "query limit", this.errors);
        const rows = this.database.all(
            `SELECT id, scheduled_at FROM agent_core_reconciliation_outbox
             WHERE scheduled_at <= ? ORDER BY scheduled_at, id LIMIT ?`,
            [now, limit]
        );
        return Object.freeze(
            rows.map((row) => {
                requireStoredOutputId(row.id, this.errors);
                requireStoredSchedule(row.scheduled_at, this.errors);
                return Object.freeze({
                    id: new ReconciliationOutboxId(row.id),
                    scheduledAt: row.scheduled_at
                });
            })
        );
    }

    public async nextDueAt(): Promise<number | null> {
        const rows = this.database.all(
            "SELECT MIN(scheduled_at) AS scheduled_at FROM agent_core_reconciliation_outbox",
            []
        );
        if (rows.length !== 1) {
            operationalFailure(
                this.errors,
                "operation.invalid-output",
                "SQLite outbox query returned an invalid row count"
            );
        }
        const value = rows[0]?.scheduled_at;
        requireOutputTime(value, "SQLite outbox schedule", this.errors);
        return value;
    }

    public async acknowledge(due: DueReconciliation): Promise<void> {
        requireInputId(due?.id, this.errors);
        requireInputTime(due.scheduledAt, "Reconciliation acknowledgement fence", this.errors);
        this.database.run(
            "DELETE FROM agent_core_reconciliation_outbox WHERE id = ? AND scheduled_at = ?",
            [due.id.value, due.scheduledAt]
        );
    }

    public async reschedule(due: DueReconciliation, scheduledAt: number): Promise<void> {
        requireInputId(due?.id, this.errors);
        requireInputTime(due.scheduledAt, "Reconciliation reschedule fence", this.errors);
        requireInputTime(scheduledAt, "Reconciliation reschedule time", this.errors);
        this.database.run(
            `UPDATE agent_core_reconciliation_outbox SET scheduled_at = ?
             WHERE id = ? AND scheduled_at = ?`,
            [scheduledAt, due.id.value, due.scheduledAt]
        );
    }
}

function requireInputId(id: ReconciliationOutboxId, errors: CloudflareErrorPort): void {
    if (!(id instanceof ReconciliationOutboxId)) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            "Reconciliation outbox IDs must be non-empty"
        );
    }
}

function requireOutputId(
    value: ReconciliationOutboxId | undefined,
    errors: CloudflareErrorPort
): asserts value is ReconciliationOutboxId {
    if (!(value instanceof ReconciliationOutboxId)) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Reconciliation outbox returned an invalid ID"
        );
    }
}

function requireStoredOutputId(
    value: SqliteValue | undefined,
    errors: CloudflareErrorPort
): asserts value is string {
    if (!isNonemptyString(value)) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Reconciliation outbox returned an invalid stored ID"
        );
    }
}

function requireInputTime(value: number | null, label: string, errors: CloudflareErrorPort): void {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            `${label} must be a non-negative safe integer or null`
        );
    }
}

function requireOutputTime(
    value: SqliteValue | undefined,
    label: string,
    errors: CloudflareErrorPort
): asserts value is number | null {
    if (value !== null && (!isFiniteNumber(value) || !Number.isSafeInteger(value) || value < 0)) {
        operationalFailure(errors, "operation.invalid-output", `${label} is invalid`);
    }
}

function requireStoredSchedule(
    value: SqliteValue | undefined,
    errors: CloudflareErrorPort
): asserts value is number {
    requireOutputTime(value, "Stored outbox schedule", errors);
    if (value === null) {
        operationalFailure(errors, "operation.invalid-output", "Stored outbox schedule is invalid");
    }
}

function isNonemptyString(value: unknown): value is string {
    return typeof value === "string" && value.length !== 0;
}

function requirePositiveConfigInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Reconciliation ${label} must be a positive safe integer`);
    }
    return value;
}

function requireInputPositiveInteger(
    value: number,
    label: string,
    errors: CloudflareErrorPort
): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            `Reconciliation ${label} must be a positive safe integer`
        );
    }
}

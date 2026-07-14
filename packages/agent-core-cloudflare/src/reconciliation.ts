import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { SynchronousSqlitePort } from "./migration.js";
import { ReconciliationOutboxId } from "./id.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_RETRY_DELAY_MS = 30_000;

export interface AlarmStorageLike {
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
}

/** The outbox retains scheduling and payload ownership; this seam exposes IDs only. */
export interface ReconciliationOutbox {
    dueIds(now: number, limit: number): Promise<readonly ReconciliationOutboxId[]>;
    nextDueAt(): Promise<number | null>;
    acknowledge(id: ReconciliationOutboxId): Promise<void>;
    reschedule(id: ReconciliationOutboxId, scheduledAt: number): Promise<void>;
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

export interface AlarmReconciliationResult {
    readonly succeededIds: readonly ReconciliationOutboxId[];
    readonly failedIds: readonly ReconciliationOutboxId[];
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

    private async synchronizeAlarm(): Promise<void> {
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
        } else if (actual !== expected) {
            await this.operation("Physical alarm write failed", () =>
                this.alarms.setAlarm(expected)
            );
        }
    }

    public async handleAlarm(): Promise<AlarmReconciliationResult> {
        const now = this.#clock.now();
        requireOutputTime(now, "Reconciliation clock time", this.errors);
        const succeededIds: ReconciliationOutboxId[] = [];
        const failedIds: ReconciliationOutboxId[] = [];
        const visited = new Set<string>();
        try {
            const ids = await this.operation("Reconciliation outbox due query failed", () =>
                this.outbox.dueIds(now, this.#batchSize)
            );
            for (const id of ids) {
                requireOutputId(id, this.errors);
                if (visited.has(id.value)) continue;
                visited.add(id.value);
                try {
                    await this.reconcile(id);
                    await this.operation(
                        `Reconciliation outbox acknowledgement failed for ${id}`,
                        () => this.outbox.acknowledge(id)
                    );
                    succeededIds.push(id);
                } catch {
                    if (now > Number.MAX_SAFE_INTEGER - this.#retryDelayMs) {
                        operationalFailure(
                            this.errors,
                            "protocol.invalid-state",
                            "Reconciliation retry time exceeds the maximum safe integer"
                        );
                    }
                    const retryAt = now + this.#retryDelayMs;
                    await this.operation(`Reconciliation outbox reschedule failed for ${id}`, () =>
                        this.outbox.reschedule(id, retryAt)
                    );
                    failedIds.push(id);
                }
            }
        } finally {
            await this.repairAlarm();
        }
        return Object.freeze({
            succeededIds: Object.freeze(succeededIds),
            failedIds: Object.freeze(failedIds)
        });
    }

    private async operation<Result>(
        message: string,
        operation: () => Promise<Result>
    ): Promise<Result> {
        try {
            return await operation();
        } catch (cause) {
            operationalFailure(this.errors, "protocol.invalid-state", message, cause);
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

    public async dueIds(now: number, limit: number): Promise<readonly ReconciliationOutboxId[]> {
        requireInputTime(now, "Reconciliation query time", this.errors);
        requireInputPositiveInteger(limit, "query limit", this.errors);
        const rows = this.database.all(
            `SELECT id FROM agent_core_reconciliation_outbox
             WHERE scheduled_at <= ? ORDER BY scheduled_at, id LIMIT ?`,
            [now, limit]
        );
        return Object.freeze(
            rows.map((row) => {
                requireStoredOutputId(row.id, this.errors);
                return new ReconciliationOutboxId(row.id as string);
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
        requireOutputTime(value as number | null, "SQLite outbox schedule", this.errors);
        return value as number | null;
    }

    public async acknowledge(id: ReconciliationOutboxId): Promise<void> {
        requireInputId(id, this.errors);
        this.database.run("DELETE FROM agent_core_reconciliation_outbox WHERE id = ?", [id.value]);
    }

    public async reschedule(id: ReconciliationOutboxId, scheduledAt: number): Promise<void> {
        requireInputId(id, this.errors);
        requireInputTime(scheduledAt, "Reconciliation reschedule time", this.errors);
        this.database.run(
            "UPDATE agent_core_reconciliation_outbox SET scheduled_at = ? WHERE id = ?",
            [scheduledAt, id.value]
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

function requireOutputId(value: unknown, errors: CloudflareErrorPort): void {
    if (!(value instanceof ReconciliationOutboxId)) {
        operationalFailure(
            errors,
            "operation.invalid-output",
            "Reconciliation outbox returned an invalid ID"
        );
    }
}

function requireStoredOutputId(value: unknown, errors: CloudflareErrorPort): void {
    if (typeof value !== "string" || value.length === 0) {
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

function requireOutputTime(value: number | null, label: string, errors: CloudflareErrorPort): void {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        operationalFailure(errors, "operation.invalid-output", `${label} is invalid`);
    }
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

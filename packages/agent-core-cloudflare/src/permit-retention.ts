import type { TransactionalSqlite } from "@agent-core/core/substrates/sqlite";
import { operationalFailure, type CloudflareErrorPort } from "./error.js";
import type { SynchronousSqlitePort } from "./migration.js";

/**
 * The enqueue capability the driver needs, narrower than the outbox seam. `enqueue` is
 * synchronous on the concrete SQLite outbox because it is one durable write in the Actor's
 * own transaction; the reconciliation seam does not declare it, so the port names exactly
 * what re-enqueuing requires and nothing else.
 */
export interface PermitRetentionSchedule {
    enqueue(id: ReconciliationOutboxId, scheduledAt: number): void;
}
import { ReconciliationOutboxId } from "./id.js";
import { isText } from "./platform-value.js";

const READ_CURSOR = "SELECT cursor FROM agent_core_permit_retention WHERE owner = ?";
const WRITE_CURSOR = `INSERT INTO agent_core_permit_retention (owner, cursor) VALUES (?, ?)
    ON CONFLICT (owner) DO UPDATE SET cursor = excluded.cursor`;

/** How long after a completed pass the next full retention pass is scheduled. */
export const PERMIT_RETENTION_INTERVAL_MILLISECONDS = 3_600_000;

/** How soon the next page of an unfinished backlog is scheduled. */
export const PERMIT_RETENTION_PAGE_DELAY_MILLISECONDS = 1_000;

/**
 * How many candidate rows one prune sweep reads. Bounded so the sweep cannot become the
 * unbounded startup cost it exists to remove, and small enough that a sweep fits well inside
 * the reconciliation driver's own wall-time budget.
 */
export const PERMIT_PRUNE_LIMIT = 256;

/** How long a settled permit's rows are kept past expiry before a sweep may remove them. */
export const PERMIT_RETENTION_MILLISECONDS = 86_400_000;

/** One prune page: what it removed, how far it read, and where the next page resumes. */
export interface AuthorityPermitPrunePage {
    readonly removed: number;
    readonly examined: number;
    readonly more: boolean;
    readonly cursor: string;
}

/** The bounded, expiry-scoped prune the permit store offers its owning Actor. */
export interface PrunableAuthorityPermitStore {
    transaction<Result>(operation: (transaction: TransactionalSqlite) => Result): Result;
    prune(
        transaction: TransactionalSqlite,
        before: Date,
        limit: number,
        after: string
    ): AuthorityPermitPrunePage;
}

export interface PermitRetentionOptions {
    readonly store: PrunableAuthorityPermitStore;
    readonly errors: CloudflareErrorPort;
    readonly now: () => number;
    readonly limit?: number;
    readonly retentionMilliseconds?: number;
}

/**
 * Prunes settled, expired permit rows in bounded pages, in the owning Actor's own
 * transaction.
 *
 * The permit tables only ever grew: a nonce, a consumption and a denial row per mediated
 * call, retained for the lifetime of the Actor, so cold-start cost and storage rose without
 * a ceiling and nothing offered a drain. This is that drain. It runs as ordinary
 * reconciliation work rather than at startup, because startup is exactly where an unbounded
 * scan did its damage, and because an Actor that cannot be constructed cannot repair itself.
 *
 * A sweep that removes a full page leaves more to do and says so, so the caller re-enqueues
 * rather than looping here and spending a whole alarm on retention.
 */
export class PermitRetentionSweep {
    readonly #limit: number;
    readonly #retentionMilliseconds: number;

    public constructor(private readonly options: PermitRetentionOptions) {
        this.#limit = requirePositive(options.limit ?? PERMIT_PRUNE_LIMIT, "prune limit");
        this.#retentionMilliseconds = requirePositive(
            options.retentionMilliseconds ?? PERMIT_RETENTION_MILLISECONDS,
            "permit retention"
        );
    }

    /**
     * Runs one bounded page starting after `cursor`, and reports where the next one resumes.
     *
     * The cursor is the caller's to carry, because the sweep is re-enqueued through the
     * reconciliation outbox rather than looped here: a driver that restarted from the
     * beginning every time would re-read the same head of the ordering forever, which is the
     * page jam the keyset exists to prevent. An empty cursor starts a fresh pass, and a page
     * that did not fill has reached the end of this owner's rows.
     */
    public sweep(cursor = ""): AuthorityPermitPrunePage {
        const now = this.options.now();
        if (!Number.isSafeInteger(now) || now < 0) {
            operationalFailure(
                this.options.errors,
                "operation.invalid-output",
                "Permit retention clock time is not a nonnegative safe integer"
            );
        }
        const before = new Date(Math.max(0, now - this.#retentionMilliseconds));
        return this.options.store.transaction((transaction) =>
            this.options.store.prune(transaction, before, this.#limit, cursor)
        );
    }
}

function requirePositive(value: number, subject: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Permit retention ${subject} must be a positive safe integer`);
    }
    return value;
}

export interface ScheduledPermitRetentionOptions {
    readonly sweep: PermitRetentionSweep;
    readonly database: SynchronousSqlitePort;
    readonly outbox: PermitRetentionSchedule;
    readonly entry: ReconciliationOutboxId;
    readonly owner: string;
    readonly errors: CloudflareErrorPort;
    readonly now: () => number;
    readonly intervalMilliseconds?: number;
    readonly pageDelayMilliseconds?: number;
}

/**
 * Retention as ordinary reconciliation work: one page per alarm, re-enqueued while a backlog
 * remains, and rescheduled for the next pass when it drains.
 *
 * A sweep that is never called prunes nothing, so the driver is the point rather than the
 * page. The cursor is durable because it has to survive the gap between alarms — the object
 * is evicted between fires, and a driver that restarted from the beginning each time would
 * re-read the same head of the ordering forever, which is the page jam the keyset exists to
 * prevent. Re-enqueuing through the same outbox that drives every other reconciliation is
 * what arms the alarm, so retention needs no schedule of its own.
 */
export class ScheduledPermitRetention {
    readonly #interval: number;
    readonly #pageDelay: number;

    public constructor(private readonly options: ScheduledPermitRetentionOptions) {
        this.#interval = requirePositive(
            options.intervalMilliseconds ?? PERMIT_RETENTION_INTERVAL_MILLISECONDS,
            "retention interval"
        );
        this.#pageDelay = requirePositive(
            options.pageDelayMilliseconds ?? PERMIT_RETENTION_PAGE_DELAY_MILLISECONDS,
            "retention page delay"
        );
    }

    /** The outbox entry this driver answers to, so a host can enqueue the first pass. */
    public get entry(): ReconciliationOutboxId {
        return this.options.entry;
    }

    /** Whether this outbox ID is retention work rather than an application reconciliation. */
    public owns(id: ReconciliationOutboxId): boolean {
        return id.equals(this.options.entry);
    }

    /**
     * Runs one page and schedules the next. Idempotent in the sense the outbox requires: a
     * repeated delivery re-reads the durable cursor and sweeps the same page again, which
     * removes rows already gone and advances no further than the first run did. Async because
     * IdempotentReconciliation is, not because anything here awaits.
     */
    public async reconcile(): Promise<void> {
        const page = this.options.sweep.sweep(this.readCursor());
        // Persist before scheduling. A crash between the two repeats a page, which is safe;
        // scheduling first and crashing would advance the alarm past work still to do.
        this.writeCursor(page.more ? page.cursor : "");
        const at = this.options.now() + (page.more ? this.#pageDelay : this.#interval);
        // Re-enqueuing the entry the sweep is currently reconciling moves its schedule
        // forward. The reconciler's acknowledgement fences on the schedule it observed, so
        // the newer schedule survives the acknowledgement rather than being cleared by it.
        this.options.outbox.enqueue(this.options.entry, at);
    }

    private readCursor(): string {
        const rows = this.options.database.all(READ_CURSOR, [this.options.owner]);
        if (rows.length === 0) return "";
        const cursor = rows[0]?.cursor;
        if (!isText(cursor)) {
            operationalFailure(
                this.options.errors,
                "codec.invalid",
                "Stored permit retention cursor is not text"
            );
        }
        return cursor;
    }

    private writeCursor(cursor: string): void {
        this.options.database.run(WRITE_CURSOR, [this.options.owner, cursor]);
    }
}

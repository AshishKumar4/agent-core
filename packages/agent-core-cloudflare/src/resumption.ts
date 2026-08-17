import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import { ReconciliationOutboxId } from "./id.js";
import type { SynchronousSqlitePort } from "./migration.js";
import { isFiniteNumber } from "./platform-value.js";
import { storedRowReader, type SynchronousResultGuard } from "./sqlite.js";

const READ_OPERATION =
    "SELECT work, attempts, claimed FROM agent_core_resumable_operations WHERE id = ?";
const INSERT_OPERATION = `INSERT INTO agent_core_resumable_operations (id, work, attempts, claimed)
     VALUES (?, ?, 0, 0)`;
const CLAIM_OPERATION = `UPDATE agent_core_resumable_operations
     SET attempts = attempts + 1, claimed = 1 WHERE id = ?`;
const RELEASE_OPERATION = "UPDATE agent_core_resumable_operations SET claimed = 0 WHERE id = ?";
const DELETE_OPERATION = "DELETE FROM agent_core_resumable_operations WHERE id = ?";
const READ_STEP = "SELECT step FROM agent_core_resumable_steps WHERE operation_id = ? AND step = ?";
const INSERT_STEP = "INSERT INTO agent_core_resumable_steps (operation_id, step) VALUES (?, ?)";
const DELETE_STEPS = "DELETE FROM agent_core_resumable_steps WHERE operation_id = ?";

/** Separates the operation from the step in an effect key; a step may not contain it. */
const EFFECT_KEY_SEPARATOR = "/";

/**
 * Where a begun operation's wakeup is recorded. `SqliteReconciliationOutbox` implements
 * it: the journal deliberately has no scheduler of its own, so one alarm claim and one
 * sweep drive both plain reconciliation and resumable operations.
 */
export interface ResumptionSchedule {
    enqueue(id: ReconciliationOutboxId, scheduledAt: number): void;
}

/** One begun operation as the journal holds it. */
export interface ResumableOperationRecord {
    /** The registered name of the work to run; a release that omits it cannot resume it. */
    readonly work: string;
    /** Attempts started, counting one that is running or died running. */
    readonly attempts: number;
    /** Whether an attempt started and has not settled — in this isolate or a lost one. */
    readonly claimed: boolean;
}

/**
 * What one attempt at a resumable operation may do. Everything an attempt needs to know
 * about a previous attempt is on this interface: the work body reads no other state to
 * decide what to redo.
 */
export interface ResumableAttempt {
    /** Which operation this is an attempt at; one named work body serves many. */
    readonly id: ReconciliationOutboxId;
    /** 1 on the first attempt; higher means an earlier attempt did not finish. */
    readonly attempt: number;
    /**
     * Whether the previous attempt was lost rather than failed — its isolate went away
     * mid-flight, so an un-checkpointed effect it started has no recorded outcome.
     */
    readonly interrupted: boolean;
    /**
     * Commits `effect` and this step's marker in one transaction, or skips both because
     * an earlier attempt committed them. `effect` runs inside that transaction, so it
     * must be synchronous and must not open one of its own; a reset partway through it
     * leaves neither its writes nor the marker behind, which is what lets the next
     * attempt redo exactly this step and nothing before it.
     */
    checkpoint<Result>(
        step: string,
        effect: () => Result,
        ...guard: SynchronousResultGuard<Result>
    ): void;
    /**
     * Awaits `effect` unless an earlier attempt recorded this step, then records it. The
     * effect is *not* atomic with that record — nothing outside this object can be — so
     * it is at-least-once and receives the attempt-stable key it must be idempotent
     * under. Anything the effect produces that a later attempt needs must be written by
     * a `checkpoint`, because a resumed attempt never sees a returned value.
     */
    once(step: string, effect: (key: string) => Promise<void>): Promise<void>;
}

/** Named so a resumed attempt can find its body again; a closure would not survive. */
export type ResumableWork = (attempt: ResumableAttempt) => Promise<void>;

/**
 * A Durable Object is reset at any time — a deployment, an eviction, a runtime update, a
 * storage error — with no shutdown hook and no warning, and an in-flight handler that
 * touches storage after the reset is stopped outright. So an operation that matters may
 * not live in a promise chain: this journal records its intent and its schedule durably
 * before it starts, records each step as it commits, and hands the work back to the same
 * reconciliation driver that already re-arms the object's alarm on start. Recovery
 * therefore needs nothing outside the object — no cron, no keepalive, no external timer —
 * and a reset costs at most the step that was in flight.
 *
 * The journal owns only progress: the work's own records stay with their own owners, and
 * a completed operation is deleted rather than kept, so nothing here becomes a second
 * durable copy of a completed outcome.
 */
export class DurableOperationJournal {
    readonly #work: Readonly<Record<string, ResumableWork>>;
    /**
     * Operations running in *this* isolate. Losing this set on reset is the point: after
     * a reset nothing is running, while `claimed` still records that something was.
     */
    readonly #running = new Set<string>();

    public constructor(
        private readonly database: SynchronousSqlitePort,
        private readonly schedule: ResumptionSchedule,
        work: Readonly<Record<string, ResumableWork>>,
        private readonly errors: CloudflareErrorPort
    ) {
        for (const name of Object.keys(work)) requireWorkName(name, errors);
        this.#work = Object.freeze({ ...work });
    }

    /**
     * Records the operation and its wakeup in one transaction, so a reset either loses
     * both or leaves work the driver will find. The ID names one unit of work: beginning
     * it again reschedules that unit and keeps its progress rather than starting a second.
     *
     * Arm the alarm after this returns. A reset in between loses nothing — startup repair
     * rebuilds the alarm from the schedule this call wrote.
     */
    public begin(id: ReconciliationOutboxId, work: string, scheduledAt: number): void {
        requireOperationId(id, this.errors);
        requireWorkName(work, this.errors);
        requireSchedule(scheduledAt, this.errors);
        this.requireRegistered(work);
        this.database.transaction(() => {
            const existing = this.read(id);
            if (existing === undefined) {
                this.database.run(INSERT_OPERATION, [id.value, work]);
            } else if (existing.work !== work) {
                operationalFailure(
                    this.errors,
                    "protocol.invalid-state",
                    `Resumable operation ${id} is already begun as ${existing.work}`
                );
            }
            this.schedule.enqueue(id, scheduledAt);
        });
    }

    /** The operation as recorded, or undefined once it has completed and been cleared. */
    public record(id: ReconciliationOutboxId): ResumableOperationRecord | undefined {
        requireOperationId(id, this.errors);
        return this.read(id);
    }

    /**
     * Runs the next attempt. Satisfies `IdempotentReconciliation`: an ID the journal no
     * longer holds already completed, so a redelivered or duplicated sweep entry settles
     * without repeating anything. A throw leaves the operation unacknowledged with its
     * committed steps intact, which is what the driver's retry then resumes.
     */
    public async resume(id: ReconciliationOutboxId): Promise<void> {
        requireOperationId(id, this.errors);
        if (this.#running.has(id.value)) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                `Resumable operation ${id} is already running in this isolate`
            );
        }
        // Read, decide and claim in one synchronous span: the input gate reopens at the
        // first await, and by then the claim that fences this attempt is already durable.
        const claimed = this.read(id);
        if (claimed === undefined) return;
        const work = this.declared(claimed.work);
        if (work === undefined) {
            // A release that does not declare this work cannot run it, and dropping the
            // operation would lose it: refuse before claiming, so the entry stays
            // scheduled until a release that declares the work serves the object.
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                `Resumable work ${claimed.work} is not declared by this runtime`
            );
        }
        this.database.run(CLAIM_OPERATION, [id.value]);
        this.#running.add(id.value);
        try {
            await work(
                new JournalledAttempt(this, id, claimed.attempts + 1, claimed.claimed, this.errors)
            );
        } catch (cause) {
            // Releasing is what separates a failed attempt from a lost one: the next
            // attempt sees `interrupted` only when an isolate went away mid-flight.
            this.database.run(RELEASE_OPERATION, [id.value]);
            throw cause;
        } finally {
            this.#running.delete(id.value);
        }
        this.database.transaction(() => {
            this.database.run(DELETE_STEPS, [id.value]);
            this.database.run(DELETE_OPERATION, [id.value]);
        });
    }

    /** Internal: whether a step of this operation has already committed. */
    public reached(id: ReconciliationOutboxId, step: string): boolean {
        return this.database.all(READ_STEP, [id.value, step]).length !== 0;
    }

    /** Internal: `effect` and this step's marker, committed together or not at all. */
    public commitStep<Result>(
        id: ReconciliationOutboxId,
        step: string,
        effect: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): void {
        this.database.transaction(() => {
            if (this.reached(id, step)) return;
            effect();
            this.database.run(INSERT_STEP, [id.value, step]);
        });
    }

    private read(id: ReconciliationOutboxId): ResumableOperationRecord | undefined {
        const rows = this.database.all(READ_OPERATION, [id.value]);
        if (rows.length === 0) return undefined;
        const row = rows[0];
        if (row === undefined) return undefined;
        const stored = storedRowReader((column) =>
            operationalFailure(
                this.errors,
                "codec.invalid",
                `Stored resumable operation column ${column} is corrupt`
            )
        );
        const claimed = stored.integer(row, "claimed");
        return Object.freeze({
            work: stored.text(row, "work"),
            attempts: stored.integer(row, "attempts"),
            claimed: claimed === 1
        });
    }

    private declared(work: string): ResumableWork | undefined {
        return Object.hasOwn(this.#work, work) ? this.#work[work] : undefined;
    }

    private requireRegistered(work: string): void {
        if (Object.hasOwn(this.#work, work)) return;
        operationalFailure(
            this.errors,
            "operation.invalid-input",
            `Resumable work ${work} is not declared by this runtime`
        );
    }
}

class JournalledAttempt implements ResumableAttempt {
    public constructor(
        private readonly journal: DurableOperationJournal,
        public readonly id: ReconciliationOutboxId,
        public readonly attempt: number,
        public readonly interrupted: boolean,
        private readonly errors: CloudflareErrorPort
    ) {}

    public checkpoint<Result>(
        step: string,
        effect: () => Result,
        ...guard: SynchronousResultGuard<Result>
    ): void {
        requireStep(step, this.errors);
        this.journal.commitStep(this.id, step, effect, ...guard);
    }

    public async once(step: string, effect: (key: string) => Promise<void>): Promise<void> {
        requireStep(step, this.errors);
        if (this.journal.reached(this.id, step)) return;
        await effect(`${this.id.value}${EFFECT_KEY_SEPARATOR}${step}`);
        this.journal.commitStep(this.id, step, () => undefined);
    }
}

function requireOperationId(id: ReconciliationOutboxId, errors: CloudflareErrorPort): void {
    if (id instanceof ReconciliationOutboxId) return;
    operationalFailure(
        errors,
        "operation.invalid-input",
        "Resumable operation ID must be a ReconciliationOutboxId"
    );
}

function requireWorkName(work: string, errors: CloudflareErrorPort): void {
    if (isCanonicalName(work)) return;
    operationalFailure(
        errors,
        "operation.invalid-input",
        "Resumable work name must be nonempty canonical text"
    );
}

/**
 * A step name may not contain the effect-key separator, which is what makes the operation
 * and the step recoverable from a key an external system holds.
 */
function requireStep(step: string, errors: CloudflareErrorPort): void {
    if (isCanonicalName(step) && !step.includes(EFFECT_KEY_SEPARATOR)) return;
    operationalFailure(
        errors,
        "operation.invalid-input",
        `Resumable step name must be nonempty canonical text without ${EFFECT_KEY_SEPARATOR}`
    );
}

function requireSchedule(scheduledAt: number, errors: CloudflareErrorPort): void {
    if (isFiniteNumber(scheduledAt) && Number.isSafeInteger(scheduledAt) && scheduledAt >= 0) {
        return;
    }
    operationalFailure(
        errors,
        "operation.invalid-input",
        "Resumable operation schedule must be a nonnegative safe integer"
    );
}

function isCanonicalName(value: unknown): value is string {
    return typeof value === "string" && value.length !== 0 && value === value.trim();
}

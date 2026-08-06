import { AgentCoreError } from "../errors";
import type { EffectAttemptId } from "../invocation-references";
import type { AttemptReceipt } from "./receipt";

/**
 * The durable schedule a reconciliation driver arms. Implementations persist
 * the next fire time in the owning Actor's storage (a Durable Object alarm, a
 * workflow timer), so an armed sweep survives restarts.
 */
export interface ReconciliationSchedulePort {
    scheduled(): Date | undefined;
    schedule(at: Date): void;
    clear(): void;
}

/**
 * The host's index of attempts whose latest Receipt is indeterminate — the
 * exact set a sweep re-queries (§7.4).
 */
export interface IndeterminateAttemptSource {
    indeterminate(limit: number): readonly EffectAttemptId[];
}

export interface ReconciliationSweepReport {
    readonly queried: number;
    readonly reconciled: number;
    readonly remaining: boolean;
}

interface DriverReconciler {
    reconcile(attemptId: EffectAttemptId): Promise<AttemptReceipt | undefined>;
}

/**
 * The named reconciliation driver (C13-EFFECT-RECONCILIATION-DRIVER): owns the
 * durable schedule that drives InvocationReconciler. A sweep re-queries the
 * indeterminate attempts, reconciles each, and re-arms the schedule while any
 * remain unresolved; direct calls to the reconciler never establish
 * scheduling — only arm() and sweep() touch the schedule.
 */
export class AlarmReconciliationDriver {
    public constructor(
        private readonly reconciler: DriverReconciler,
        private readonly attempts: IndeterminateAttemptSource,
        private readonly schedule: ReconciliationSchedulePort,
        private readonly intervalMs: number,
        private readonly now: () => Date,
        private readonly batchLimit = 32
    ) {
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Reconciliation driver interval must be a positive safe integer"
            );
        }
        if (!Number.isSafeInteger(batchLimit) || batchLimit <= 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Reconciliation driver batch limit must be a positive safe integer"
            );
        }
    }

    /** Arm the durable schedule if it is not already armed. Idempotent. */
    public arm(): Date {
        const existing = this.schedule.scheduled();
        if (existing !== undefined) return existing;
        const at = new Date(this.now().getTime() + this.intervalMs);
        this.schedule.schedule(at);
        return at;
    }

    /**
     * Reconstruct the schedule from durable attempt state. A sweep interrupted by
     * eviction or a failing reconciliation leaves attempts indeterminate; call this
     * during startup so the driver resumes without waiting for new work to arm it.
     */
    public repair(): Date | undefined {
        if (this.attempts.indeterminate(1).length === 0) return undefined;
        return this.arm();
    }

    /**
     * One driver firing: re-query indeterminate attempts, reconcile each, and leave
     * the schedule armed exactly when unresolved attempts remain. An attempt whose
     * provider outcome is still unknown stays indeterminate and keeps it armed.
     *
     * The schedule is settled after the work, never before: clearing first would
     * strand every outstanding attempt if the firing is evicted or throws.
     */
    public async sweep(): Promise<ReconciliationSweepReport> {
        const queried = this.attempts.indeterminate(this.batchLimit);
        let reconciled = 0;
        try {
            for (const attemptId of queried) {
                const receipt = await this.reconciler.reconcile(attemptId);
                if (receipt !== undefined && receipt.outcome !== "indeterminate") reconciled += 1;
            }
        } finally {
            this.settleSchedule();
        }
        const remaining = this.attempts.indeterminate(1).length > 0;
        return Object.freeze({ queried: queried.length, reconciled, remaining });
    }

    private settleSchedule(): void {
        if (this.attempts.indeterminate(1).length > 0) {
            this.schedule.schedule(new Date(this.now().getTime() + this.intervalMs));
            return;
        }
        this.schedule.clear();
    }
}

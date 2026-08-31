import { AgentCoreError } from "../errors";
import type { AdmittedInvocationItem } from "./admitted-item";
import type { CanonicalBatchItemResult } from "./canonical-batch";
import type { ReconciliationSchedulePort } from "./reconciliation-driver";

/**
 * The host's index of detached items released for execution and not yet answered by a Receipt
 * — the exact set a sweep re-queries (§5.6).
 *
 * It answers with admitted items rather than stored records because that is what execution
 * needs, and it is the host's query rather than the driver's so that "released and unfinished"
 * stays one predicate over the store: the released state comes from the detachment record and
 * the unfinished half from the item's current Receipt, which §7.4 owns.
 */
export interface DetachedEffectExecutionSource {
    released(limit: number): readonly AdmittedInvocationItem[];
}

export interface DetachedEffectSweepReport {
    readonly queried: number;
    readonly executed: number;
    readonly remaining: boolean;
}

/** The execution seam the driver drives, narrowed to the one call it makes. */
interface DrivenDetachedExecution {
    execute(item: AdmittedInvocationItem): Promise<CanonicalBatchItemResult>;
}

/**
 * The named driver for detached execution: it owns the durable schedule that runs released
 * items whose Turn has ended (§5.6).
 *
 * Everything it needs comes from durable records. A sweep re-queries the released items,
 * executes each through a target that rebuilds its own live request, and re-arms while any
 * remain — so a host that restarts mid-flight resumes by calling `repair` and never by holding
 * a closure from the Turn that admitted the work. Direct calls to the execution step never
 * establish scheduling; only `arm` and `sweep` touch the schedule.
 *
 * It shares `ReconciliationSchedulePort` with the reconciliation driver because a durable
 * schedule is one substrate contract, not two. Each driver arms its own schedule instance; two
 * drivers sharing one would settle each other's work.
 */
export class AlarmDetachedEffectDriver {
    public constructor(
        private readonly executions: DrivenDetachedExecution,
        private readonly items: DetachedEffectExecutionSource,
        private readonly schedule: ReconciliationSchedulePort,
        private readonly intervalMs: number,
        private readonly now: () => Date,
        private readonly batchLimit = 32
    ) {
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Detached effect driver interval must be a positive safe integer"
            );
        }
        if (!Number.isSafeInteger(batchLimit) || batchLimit <= 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Detached effect driver batch limit must be a positive safe integer"
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
     * Reconstruct the schedule from durable detachment state. A release whose sweep was lost to
     * eviction, or a host that restarted between admission and execution, leaves released items
     * with no Receipt; call this during startup so the driver resumes without waiting for a new
     * delivery to arm it.
     */
    public repair(): Date | undefined {
        if (this.items.released(1).length === 0) return undefined;
        return this.arm();
    }

    /**
     * One driver firing: re-query released items, execute each, and leave the schedule armed
     * exactly when released work remains.
     *
     * The schedule is settled after the work, never before: clearing first would strand every
     * outstanding item if the firing is evicted or throws.
     */
    public async sweep(): Promise<DetachedEffectSweepReport> {
        const queried = this.items.released(this.batchLimit);
        let executed = 0;
        try {
            for (const item of queried) {
                await this.executions.execute(item);
                executed += 1;
            }
        } finally {
            this.settleSchedule();
        }
        return Object.freeze({
            queried: queried.length,
            executed,
            remaining: this.items.released(1).length > 0
        });
    }

    private settleSchedule(): void {
        if (this.items.released(1).length > 0) {
            this.schedule.schedule(new Date(this.now().getTime() + this.intervalMs));
            return;
        }
        this.schedule.clear();
    }
}

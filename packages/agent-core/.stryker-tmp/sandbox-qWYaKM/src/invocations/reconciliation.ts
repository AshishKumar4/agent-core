// @ts-nocheck
import type { EffectAttempt } from "./attempt";
import type { EffectReconciliationPort, ReconciliationResult } from "./ports";

export interface ReconciliationFinalizer<Lease, Admission, Result> {
    finalize(
        attempt: EffectAttempt<Lease, Admission>,
        result: Exclude<ReconciliationResult, { readonly kind: "unknown" }>
    ): Promise<Result>;
}

export class InvocationReconciler<Lease, Admission> {
    public constructor(private readonly provider: EffectReconciliationPort<Lease, Admission>) {}

    public async reconcile<Result>(
        attempt: EffectAttempt<Lease, Admission>,
        finalizer: ReconciliationFinalizer<Lease, Admission, Result>
    ): Promise<Result | undefined> {
        const result = await this.provider.query(attempt);
        if (result.kind === "unknown") return undefined;
        return finalizer.finalize(attempt, result);
    }
}

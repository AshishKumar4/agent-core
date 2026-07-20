import { ContentStore } from "../content";
import { encodeCanonicalJson, type Digest } from "../core";
import {
    ApprovalGatewayBackend,
    EffectDispatch,
    EffectDispatchAttempt,
    ProtectedProfileRuntimePort,
    type ProfileRuntimeEffectsPort,
    type ProfileRuntimeHostBinding
} from "../facets";
import {
    InvocationProtectedOperationPort,
    type EffectAttempt,
    type EffectReconciliationPort,
    type Receipt,
    type ReconciliationResult
} from "../invocations";

export function createProtectedProfileRuntime(
    host: ProfileRuntimeHostBinding,
    operations: InvocationProtectedOperationPort,
    effects: ProfileRuntimeEffectsPort<Receipt>
): ProtectedProfileRuntimePort<Receipt> {
    return new ProtectedProfileRuntimePort(host, operations, effects);
}

export class ApprovalGatewayReconciliationPort<
    Lease,
    Admission
> implements EffectReconciliationPort<Lease, Admission> {
    public constructor(
        private readonly backend: ApprovalGatewayBackend,
        private readonly content: ContentStore
    ) {}

    public async query(
        attempt: EffectAttempt<Lease, Admission>,
        intentDigest: Digest
    ): Promise<ReconciliationResult> {
        const dispatch = new EffectDispatch(
            attempt.idempotencyKey,
            new EffectDispatchAttempt(attempt.id, attempt.ordinal, intentDigest)
        );
        const result = await this.backend.reconcile(dispatch);
        if (result.kind === "unknown") return result;
        if (result.result === undefined) return { kind: result.kind };
        const stored = await this.content.put(encodeCanonicalJson(result.result));
        return { kind: result.kind, result: stored.ref };
    }
}

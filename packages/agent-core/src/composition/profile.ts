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
    AttemptFailureKind,
    type EffectAttempt,
    type EffectReconciliationPort,
    InvocationProtectedOperationPort,
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
        const stored =
            result.result === undefined
                ? undefined
                : (await this.content.put(encodeCanonicalJson(result.result))).ref;
        if (result.kind === "succeeded") {
            return stored === undefined ? { kind: "succeeded" } : { kind: "succeeded", result: stored };
        }
        // The gateway's verdict is the target's own report of its effect, which is the one
        // §7.4 kind the invoked side originates. The host derives nothing here: it observed
        // no bound, no cancellation and no lost domain, only an answer.
        const failure = AttemptFailureKind.raised;
        return stored === undefined
            ? { kind: "failed", failure }
            : { kind: "failed", failure, result: stored };
    }
}

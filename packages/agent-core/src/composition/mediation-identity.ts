import { Digest, encodeCanonicalJson, type JsonValue } from "../core";
import {
    AuditRecordId,
    ClaimWorkerId,
    CorrelationId,
    EffectAttemptId,
    InvocationId,
    ItemClaimId,
    ReceiptId,
    type AttemptReceiptOutcome,
    type PreEffectReceiptOutcome
} from "../invocations";
import type { MediatedInvocationIdentityPort } from "../invocations";
import type { MediatedInvocationPreflight } from "../operations";
import { canonicalFacetData } from "../facets";

/**
 * Every mediation identifier is a domain-separated digest of the durable evidence that
 * already determines it, never a counter or a random value. That is what makes the
 * pipeline restartable: a worker that crashes between minting an identifier and
 * persisting the record it names recomputes the same identifier from the same evidence,
 * so the idempotent claim/attempt/receipt protocol in §7.3–§7.4 converges instead of
 * forking a second identity for one item.
 *
 * Where two records legitimately coexist for one item, the evidence that distinguishes
 * them is in the derivation: the attempt ordinal separates retries, the claim worker
 * separates a recovered claim from the expired one it replaces (recovery already
 * requires a different worker), and the outcome separates a superseded Receipt from the
 * indeterminate one it replaces.
 */
const IDENTITY_DOMAIN = Object.freeze({
    invocation: "agent-core.identity.invocation.v1",
    directInvocation: "agent-core.identity.direct-invocation.v1",
    directItem: "agent-core.identity.direct-item.v1",
    idempotencySeed: "agent-core.identity.idempotency-seed.v1",
    correlation: "agent-core.identity.correlation.v1",
    claim: "agent-core.identity.item-claim.v1",
    attempt: "agent-core.identity.effect-attempt.v1",
    preEffectReceipt: "agent-core.identity.pre-effect-receipt.v1",
    attemptReceipt: "agent-core.identity.attempt-receipt.v1",
    invocationAudit: "agent-core.identity.invocation-audit.v1",
    attemptAudit: "agent-core.identity.attempt-audit.v1",
    receiptAudit: "agent-core.identity.receipt-audit.v1",
    supersessionAudit: "agent-core.identity.supersession-audit.v1"
});

export class DerivedMediationIdentities implements MediatedInvocationIdentityPort {
    public constructor(private readonly scope: string) {
        if (scope.length === 0 || scope !== scope.trim()) {
            throw new TypeError("Mediation identity scope must be canonical");
        }
    }

    /**
     * The mediated InvocationId commits exactly the replay reservation identity (§7.3):
     * the same authenticated caller and OperationRequestKey over the same bound intent
     * mint the same Invocation, and any changed bound field mints a different one.
     */
    public invocation(request: MediatedInvocationPreflight<unknown>): InvocationId {
        return new InvocationId(
            derive(IDENTITY_DOMAIN.invocation, {
                authorityIdentity: request.replayBinding.authorityIdentity.value,
                descriptor: Digest.sha256(encodeCanonicalJson(request.descriptor.toData())).value,
                execution: {
                    digest: request.replayBinding.execution.digest.value,
                    kind: request.replayBinding.execution.kind
                },
                facet: request.facet.value,
                packageOperationPin: request.replayBinding.packageOperationPin.value,
                payload: request.inputs.map(
                    (input) => Digest.sha256(encodeCanonicalJson(canonicalFacetData(input))).value
                ),
                principal: {
                    principal: request.replayBinding.principal.principalId.value,
                    tenant: request.replayBinding.principal.tenantId.value
                },
                requestKey: request.requestKey.value,
                scope: this.scope,
                ["shape"]:
                    request.cardinality.kind === "single"
                        ? { kind: "single" }
                        : { itemCount: request.cardinality.itemCount, kind: "batch" }
            })
        );
    }

    /**
     * A direct Invocation creates no durable record (§7.3), but its Operation still runs
     * under an OperationContext that names one. Deriving it from the request key keeps
     * that identity stable across a retried direct dispatch and distinct from every
     * mediated Invocation, which is minted under a different domain.
     */
    public directInvocation(requestKey: string): InvocationId {
        return new InvocationId(
            derive(IDENTITY_DOMAIN.directInvocation, { requestKey, scope: this.scope })
        );
    }

    public directItemKey(invocation: InvocationId, itemIndex: number): string {
        return derive(IDENTITY_DOMAIN.directItem, { invocation: invocation.value, itemIndex });
    }

    public idempotencySeed(invocation: InvocationId): string {
        return derive(IDENTITY_DOMAIN.idempotencySeed, { invocation: invocation.value });
    }

    public correlation(invocation: InvocationId): CorrelationId {
        return new CorrelationId(
            derive(IDENTITY_DOMAIN.correlation, { invocation: invocation.value })
        );
    }

    public claim(
        invocation: InvocationId,
        itemIndex: number,
        attemptOrdinal: number,
        worker: ClaimWorkerId
    ): ItemClaimId {
        return new ItemClaimId(
            derive(IDENTITY_DOMAIN.claim, {
                attemptOrdinal,
                invocation: invocation.value,
                itemIndex,
                worker: worker.value
            })
        );
    }

    public attempt(
        invocation: InvocationId,
        itemIndex: number,
        attemptOrdinal: number
    ): EffectAttemptId {
        return new EffectAttemptId(
            derive(IDENTITY_DOMAIN.attempt, {
                attemptOrdinal,
                invocation: invocation.value,
                itemIndex
            })
        );
    }

    public preEffectReceipt(
        invocation: InvocationId,
        itemIndex: number,
        outcome: PreEffectReceiptOutcome
    ): ReceiptId {
        return new ReceiptId(
            derive(IDENTITY_DOMAIN.preEffectReceipt, {
                invocation: invocation.value,
                itemIndex,
                outcome
            })
        );
    }

    public attemptReceipt(attempt: EffectAttemptId, outcome: AttemptReceiptOutcome): ReceiptId {
        return new ReceiptId(
            derive(IDENTITY_DOMAIN.attemptReceipt, { attempt: attempt.value, outcome })
        );
    }

    public invocationAudit(invocation: InvocationId): AuditRecordId {
        return new AuditRecordId(
            derive(IDENTITY_DOMAIN.invocationAudit, { invocation: invocation.value })
        );
    }

    public attemptAudit(attempt: EffectAttemptId): AuditRecordId {
        return new AuditRecordId(derive(IDENTITY_DOMAIN.attemptAudit, { attempt: attempt.value }));
    }

    public receiptAudit(receipt: ReceiptId): AuditRecordId {
        return new AuditRecordId(derive(IDENTITY_DOMAIN.receiptAudit, { receipt: receipt.value }));
    }

    public supersessionAudit(previous: ReceiptId, next: ReceiptId): AuditRecordId {
        return new AuditRecordId(
            derive(IDENTITY_DOMAIN.supersessionAudit, {
                next: next.value,
                previous: previous.value
            })
        );
    }
}

function derive(domain: string, evidence: JsonValue): string {
    return `${domain}:${Digest.sha256(encodeCanonicalJson({ domain, evidence })).value}`;
}

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
import { canonicalFacetData, type FacetData, type OperationDescriptor } from "../facets";
import { scopeKey } from "../authority";
import type { OperationResolutionState } from "./authority";

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
    staleDenialInvocation: "agent-core.identity.stale-denial-invocation.v1",
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

    /**
     * The Invocation a stale mediated observation denies (§3.4 rule 7, §7.4). It is minted
     * under its own domain because the mediated `invocation` derivation is unreachable
     * here: a stale re-check throws before `replayBinding` exists, so the replay reservation
     * that identity commits to has not been formed yet. What HAS been formed is the exact
     * resolution the caller presented, and every field below is part of what made this
     * intent distinct — so two different stale operations never collide, and the same stale
     * observation retried after a crash recomputes the same Receipt and AuditRecord ids
     * instead of forking a second denial for one refusal.
     *
     * The Binding generation and the resolution's own path epochs are in the evidence
     * deliberately: they are the STALE values the caller presented, not the current ones,
     * which is what makes the identity name this refusal rather than the state that
     * replaced it.
     */
    public staleDenialInvocation(
        resolution: OperationResolutionState,
        descriptor: OperationDescriptor,
        inputs: readonly FacetData[]
    ): InvocationId {
        return new InvocationId(
            derive(IDENTITY_DOMAIN.staleDenialInvocation, {
                binding: {
                    generation: resolution.binding.generation,
                    key: resolution.binding.key
                },
                descriptor: Digest.sha256(encodeCanonicalJson(descriptor.toData())).value,
                execution: executionReference(resolution),
                facet: resolution.binding.facet.value,
                owner: { id: resolution.owner.id.value, kind: resolution.owner.kind },
                path: resolution.pathEpochs.path.map((entry) => [
                    scopeKey(entry.scope),
                    entry.epoch
                ]),
                payload: inputs.map(
                    (input) => Digest.sha256(encodeCanonicalJson(canonicalFacetData(input))).value
                ),
                principal: {
                    principal: resolution.principal.principalId.value,
                    tenant: resolution.principal.tenantId.value
                },
                scope: this.scope
            })
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

/**
 * Which execution a resolution was issued against, as identity evidence. A Turn-leased
 * resolution and a route-driven one are different intents even for the same Binding and
 * arguments, and a resolution carrying neither is a third case rather than a missing
 * field — stating all three keeps the absent one from digesting the same as a Turn whose
 * token happened to be omitted.
 */
function executionReference(resolution: OperationResolutionState): JsonValue {
    if (resolution.lease !== undefined) {
        return {
            epoch: resolution.lease.epoch,
            kind: "turn",
            turn: resolution.lease.turn.value
        };
    }
    if (resolution.route !== undefined) {
        return { kind: "route", route: resolution.route.value };
    }
    return { kind: "none" };
}

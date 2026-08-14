import type { ActorRef } from "../actors";
import type { ContentRef } from "../core";
import { AgentCoreError } from "../errors";
import type { TenantId } from "../identity";
import {
    AttemptReceipt,
    AuditRecord,
    ClaimWorkerId,
    EffectAttempt,
    ItemClaim,
    PreEffectReceipt,
    type AttemptReceiptOutcome,
    type AuthorityAdmissionReference,
    type CanonicalBatchRecordPort,
    type InvocationClaimOwnerPort,
    type ItemClaimOwner,
    type Receipt
} from "../invocations";
import type { DerivedMediationIdentities } from "./mediation-identity";
import {
    sameLeaseReference,
    type MediationAuthorityReference,
    type MediationDomainReference,
    type MediationLeaseReference,
    type MediationPathEpochReference,
    type MediationPreparedInvocation
} from "./mediation-preparation";

export interface MediationRecordIdentity {
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    /**
     * The claim owner this process is. Claim recovery requires a different worker from
     * the one whose claim expired (§7.3), so this must identify the running worker
     * incarnation, not the Actor: two incarnations of one Actor are different workers.
     */
    readonly worker: ClaimWorkerId;
}

/**
 * The ledger's claim-owner gate: an EffectAttempt may only be admitted for the exact
 * ItemClaim that names it, and only under the authority that claim was taken with. An
 * executor claim attempts under its own exact lease token; a system claim attempts under
 * no token at all, so a system worker cannot borrow an executor's fencing (§5.3, §7.3).
 */
export class MediationClaimOwnerAdmission<
    Transaction,
    Admission
> implements InvocationClaimOwnerPort<Transaction, MediationLeaseReference, Admission> {
    public admits(
        _transaction: Transaction,
        claim: ItemClaim<MediationLeaseReference>,
        attempt: EffectAttempt<MediationLeaseReference, Admission>
    ): boolean {
        return (
            claim.id.equals(attempt.claim) &&
            claim.invocation.equals(attempt.invocation) &&
            claim.itemIndex === attempt.itemIndex &&
            claim.attemptOrdinal === attempt.ordinal &&
            (claim.owner.kind === "executor"
                ? attempt.token !== undefined &&
                  sameLeaseReference(claim.owner.token, attempt.token)
                : attempt.token === undefined)
        );
    }
}

/**
 * Mints the durable evidence of §7.3–§7.4 — ItemClaims, EffectAttempts, Receipts, and
 * the AuditRecords that chain them — for one Actor's mediation pipeline.
 *
 * The audit chain it produces is the one §7.4 requires and the ledger enforces:
 * the Invocation root causes each EffectAttempt record, each attempt record causes its
 * Receipt record, and a reconciled Receipt's supersession record is caused by the
 * Receipt record it supersedes. A pre-effect denial has no attempt, so its Receipt
 * record is caused by the Invocation root directly.
 */
export class CanonicalMediationRecords<Admission> implements CanonicalBatchRecordPort<
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    Admission
> {
    public constructor(
        private readonly identity: MediationRecordIdentity,
        private readonly identities: DerivedMediationIdentities,
        private readonly claimLifetimeMilliseconds: number
    ) {
        if (!Number.isSafeInteger(claimLifetimeMilliseconds) || claimLifetimeMilliseconds <= 0) {
            throw new TypeError("Item claim lifetime must be a positive safe integer");
        }
    }

    public invocationAudit(invocation: MediationPreparedInvocation): AuditRecord {
        return this.audit(invocation, invocation.header.auditCause, undefined, {
            kind: "invocation",
            id: invocation.header.id
        });
    }

    public claim(
        invocation: MediationPreparedInvocation,
        itemIndex: number,
        previous: ItemClaim<MediationLeaseReference> | undefined,
        now: Date
    ): ItemClaim<MediationLeaseReference> {
        const owner = this.owner(invocation);
        const expiresAt = new Date(now.getTime() + this.claimLifetimeMilliseconds);
        if (previous === undefined) {
            return new ItemClaim(
                this.identities.claim(invocation.header.id, itemIndex, 0, owner.worker),
                invocation.header.id,
                itemIndex,
                0,
                owner,
                expiresAt
            );
        }
        return previous.recover(
            this.identities.claim(
                invocation.header.id,
                itemIndex,
                previous.attemptOrdinal,
                owner.worker
            ),
            owner,
            expiresAt,
            now
        );
    }

    public retryClaim(
        invocation: MediationPreparedInvocation,
        previous: EffectAttempt<MediationLeaseReference, Admission>,
        now: Date
    ): ItemClaim<MediationLeaseReference> {
        const owner = this.owner(invocation);
        const attemptOrdinal = previous.ordinal + 1;
        return new ItemClaim(
            this.identities.claim(
                invocation.header.id,
                previous.itemIndex,
                attemptOrdinal,
                owner.worker
            ),
            invocation.header.id,
            previous.itemIndex,
            attemptOrdinal,
            owner,
            new Date(now.getTime() + this.claimLifetimeMilliseconds)
        );
    }

    public attempt(
        invocation: MediationPreparedInvocation,
        claim: ItemClaim<MediationLeaseReference>,
        admission: AuthorityAdmissionReference<Admission>,
        now: Date
    ): EffectAttempt<MediationLeaseReference, Admission> {
        return new EffectAttempt<MediationLeaseReference, Admission>(
            this.identities.attempt(invocation.header.id, claim.itemIndex, claim.attemptOrdinal),
            invocation.header.id,
            claim.itemIndex,
            claim.attemptOrdinal,
            claim.id,
            invocation.header.lease,
            admission,
            now,
            invocation.item(claim.itemIndex).idempotencyKey,
            invocation.header.auditCause
        );
    }

    public attemptAudit(
        invocation: MediationPreparedInvocation,
        attempt: EffectAttempt<MediationLeaseReference, Admission>
    ): AuditRecord {
        return this.audit(
            invocation,
            this.identities.attemptAudit(attempt.id),
            attempt.auditCause,
            { kind: "attempt", id: attempt.id }
        );
    }

    public preEffectReceipt(
        invocation: MediationPreparedInvocation,
        claim: ItemClaim<MediationLeaseReference>,
        recordedAt: Date,
        reason: string
    ): PreEffectReceipt {
        return new PreEffectReceipt(
            this.identities.preEffectReceipt(
                invocation.header.id,
                claim.itemIndex,
                "deniedPreEffect"
            ),
            invocation.header.id,
            claim.itemIndex,
            "deniedPreEffect",
            recordedAt,
            reason
        );
    }

    public attemptReceipt(
        attempt: EffectAttempt<MediationLeaseReference, Admission>,
        outcome: AttemptReceiptOutcome,
        recordedAt: Date,
        result: ContentRef | undefined
    ): AttemptReceipt {
        return new AttemptReceipt(
            this.identities.attemptReceipt(attempt.id, outcome),
            attempt.id,
            outcome,
            undefined,
            recordedAt,
            result
        );
    }

    public reconciledReceipt(
        attempt: EffectAttempt<MediationLeaseReference, Admission>,
        previous: AttemptReceipt,
        result: { readonly kind: "succeeded" | "failed"; readonly result?: ContentRef },
        recordedAt: Date
    ): AttemptReceipt {
        return new AttemptReceipt(
            this.identities.attemptReceipt(attempt.id, result.kind),
            attempt.id,
            result.kind,
            previous.id,
            recordedAt,
            result.result
        );
    }

    public receiptAudit(
        invocation: MediationPreparedInvocation,
        cause: AuditRecord | undefined,
        receipt: Receipt
    ): AuditRecord {
        return this.audit(
            invocation,
            this.identities.receiptAudit(receipt.id),
            cause?.id ?? invocation.header.auditCause,
            { kind: "receipt", id: receipt.id, outcome: receipt.outcome }
        );
    }

    public receiptSupersessionAudit(
        invocation: MediationPreparedInvocation,
        previousAudit: AuditRecord,
        previous: AttemptReceipt,
        next: AttemptReceipt
    ): AuditRecord {
        return this.audit(
            invocation,
            this.identities.supersessionAudit(previous.id, next.id),
            previousAudit.id,
            { kind: "receiptSuperseded", previous: previous.id, next: next.id }
        );
    }

    private owner(
        invocation: MediationPreparedInvocation
    ): ItemClaimOwner<MediationLeaseReference> {
        const lease = invocation.header.lease;
        return lease === undefined
            ? { kind: "system", actor: invocation.header.actor, worker: this.identity.worker }
            : { kind: "executor", token: lease, worker: this.identity.worker };
    }

    private audit(
        invocation: MediationPreparedInvocation,
        id: ReturnType<DerivedMediationIdentities["invocationAudit"]>,
        cause: ReturnType<DerivedMediationIdentities["invocationAudit"]> | undefined,
        kind: ConstructorParameters<typeof AuditRecord>[0]["kind"]
    ): AuditRecord {
        if (!invocation.header.actor.equals(this.identity.actor)) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Mediation records belong to the Actor that owns the Invocation"
            );
        }
        const audit: ConstructorParameters<typeof AuditRecord>[0] = {
            id,
            actor: this.identity.actor,
            tenant: this.identity.tenant,
            correlation: this.identities.correlation(invocation.header.id),
            kind
        };
        return new AuditRecord(cause === undefined ? audit : { ...audit, cause });
    }
}

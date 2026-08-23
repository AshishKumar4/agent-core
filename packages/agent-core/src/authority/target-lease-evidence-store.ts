import type { ActorRef, SynchronousResultGuard } from "../actors";
import {
    RunId,
    RunStoragePort,
    TurnId,
    TurnLease,
    type LeaseToken
} from "../agents";
import { Digest } from "../core";
import { AgentCoreError } from "../errors";
import type { PrincipalRef, TenantId } from "../identity";
import { TargetAuthorityPermitRequest } from "./permit-request";
import {
    TargetLeaseEvidence,
    TargetLeaseEvidenceKey
} from "./target-lease-evidence";
import type { InvalidationWatermark } from "./epoch";

export interface TargetLeaseEvidenceStore<Transaction> {
    readonly owner: ActorRef;
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    evidence(transaction: Transaction, idempotencyKey: string): TargetLeaseEvidence | undefined;
    record(transaction: Transaction, evidence: TargetLeaseEvidence): TargetLeaseEvidence;
}

/**
 * Source-local facts read in the same Actor transaction that records lease evidence.
 * The source owns these facts; no Tenant projection may substitute for this read.
 */
export interface TargetLeaseEvidenceSourceState {
    readonly run: RunId;
    readonly lease: TurnLease;
    readonly watermark: InvalidationWatermark;
    readonly invocationIntent: Digest;
}

export abstract class TargetLeaseEvidenceSourcePort<Transaction> {
    public abstract current(
        transaction: Transaction,
        source: ActorRef,
        run: RunId,
        lease: LeaseToken
    ): TargetLeaseEvidenceSourceState | undefined;
}

/**
 * The canonical owners behind one source Actor's attestation reads. The Turn lease
 * comes from the RunRepository, the holder watermark from the canonical watermark
 * owner, and the delegation intent from the canonical intent owner — an adapter must
 * read them through this seam inside the recording transaction and must never keep
 * its own mutable copy of any of them.
 */
export interface TargetLeaseEvidenceSourceFacts<Transaction> {
    turnLease(transaction: Transaction, turn: TurnId): TurnLease | undefined;
    watermark(transaction: Transaction, holder: PrincipalRef): InvalidationWatermark;
    invocationIntent(transaction: Transaction, run: RunId): Digest | undefined;
}

/** The Run-Actor transactional span the evidence records inside. */
export interface TargetLeaseEvidenceSourceRuns<Transaction> {
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
}

export interface TargetLeaseEvidenceSourceStore<Transaction>
    extends TargetLeaseEvidenceStore<Transaction>
{
    readonly tenant: TenantId;
    readonly source: TargetLeaseEvidenceSourcePort<Transaction>;
}

/** Records source-verified immutable evidence in the exact source Actor transaction. */
export class TargetLeaseEvidenceIssuer<Transaction> {
    public constructor(
        private readonly store: TargetLeaseEvidenceStore<Transaction>,
        private readonly source: TargetLeaseEvidenceSourcePort<Transaction>
    ) {}

    public attest(
        transaction: Transaction,
        request: TargetAuthorityPermitRequest,
        now: Date
    ): TargetLeaseEvidence | undefined {
        const expectation = request.expectation;
        const token = expectation.lease;
        if (token === undefined || !expectation.source.equals(this.store.owner)) {
            return undefined;
        }
        const existing = this.store.evidence(transaction, request.nonce);
        if (existing !== undefined) return this.replay(existing, request, token, now, transaction);
        const current = this.source.current(
            transaction,
            expectation.source,
            expectation.reservation.run,
            token
        );
        const expiresAt = current?.lease.expiresAt;
        if (
            current === undefined ||
            !current.run.equals(expectation.reservation.run) ||
            expiresAt === undefined ||
            !current.lease.admits(token, now) ||
            !current.invocationIntent.equals(expectation.intentDigest) ||
            !request.authority.invocationDigest.equals(expectation.intentDigest) ||
            current.watermark.ownerTenant.equals(expectation.tenant) !== true ||
            current.watermark.owner.equals(expectation.source) !== true ||
            current.watermark.holder.equals(token.holder) !== true ||
            expectation.pathEpochs.path.some(
                (entry) => current.watermark.epoch(entry.scope) > entry.epoch
            )
        ) {
            return undefined;
        }
        const deadline = new Date(
            Math.min(expiresAt.getTime(), request.expiresAt.getTime())
        );
        if (deadline.getTime() <= now.getTime()) return undefined;
        const evidence = new TargetLeaseEvidence({
            key: new TargetLeaseEvidenceKey(expectation.source, request.nonce),
            tenant: expectation.tenant,
            run: expectation.reservation.run,
            lease: token,
            target: expectation.target,
            requestIdentity: TargetAuthorityPermitRequest.identityFor(
                expectation,
                request.authority,
                request.nonce,
                deadline
            ),
            deadline,
            watermark: current.watermark
        });
        return this.store.record(transaction, evidence);
    }

    /**
     * A committed record whose response was lost replays unchanged while the exact
     * request still binds it and every live condition held at issuance still holds:
     * the original deadline has not passed, the current lease admits its token even
     * after a same-token renewal, and the current watermark has not invalidated the
     * path. The original deadline is never regenerated — renewal cannot extend an
     * attestation that already exists.
     */
    private replay(
        existing: TargetLeaseEvidence,
        request: TargetAuthorityPermitRequest,
        token: LeaseToken,
        now: Date,
        transaction: Transaction
    ): TargetLeaseEvidence | undefined {
        const expectation = request.expectation;
        if (
            !existing.matches({
                key: existing.key,
                tenant: expectation.tenant,
                run: expectation.reservation.run,
                lease: token,
                target: expectation.target,
                requestIdentity: TargetAuthorityPermitRequest.identityFor(
                    expectation,
                    request.authority,
                    request.nonce,
                    existing.deadline
                )
            })
        ) {
            throw denied("Target lease evidence key is bound to another source attestation");
        }
        const current = this.source.current(
            transaction,
            expectation.source,
            expectation.reservation.run,
            token
        );
        if (
            current === undefined ||
            !current.run.equals(expectation.reservation.run) ||
            !current.lease.admits(token, now) ||
            !current.invocationIntent.equals(expectation.intentDigest) ||
            current.watermark.ownerTenant.equals(expectation.tenant) !== true ||
            current.watermark.owner.equals(expectation.source) !== true ||
            current.watermark.holder.equals(token.holder) !== true ||
            expectation.pathEpochs.path.some(
                (entry) => current.watermark.epoch(entry.scope) > entry.epoch
            ) ||
            !existing.isCurrentAt(now)
        ) {
            return undefined;
        }
        return existing;
    }
}

/**
 * Immutable target lease evidence persisted through the source Run Actor's own
 * canonical run storage, keyed by idempotency key. The Turn lease, holder
 * watermark, and delegation intent are read only through `facts` — the canonical
 * RunRepository, watermark owner, and intent owner — inside whichever Run-Actor
 * transaction the caller opens on that same storage. One implementation serves
 * every substrate; no substrate keeps its own copy of any source fact.
 */
export class RunTargetLeaseEvidenceStore<Transaction extends object>
    implements
        TargetLeaseEvidenceSourceStore<Transaction>,
        TargetLeaseEvidenceSourcePort<Transaction>
{
    public constructor(
        public readonly tenant: TenantId,
        public readonly owner: ActorRef,
        private readonly storage: RunStoragePort<Transaction>,
        private readonly facts: TargetLeaseEvidenceSourceFacts<Transaction>
    ) {}

    /** The read side over this exact owner's canonical source state; the store itself. */
    public readonly source: TargetLeaseEvidenceSourcePort<Transaction> = this;

    public transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.storage.transaction(operation, ...guard);
    }

    public current(
        transaction: Transaction,
        source: ActorRef,
        run: RunId,
        token: LeaseToken
    ): TargetLeaseEvidenceSourceState | undefined {
        if (!source.equals(this.owner)) return undefined;
        const lease = this.facts.turnLease(transaction, new TurnId(token.turn.value));
        const intent = this.facts.invocationIntent(transaction, new RunId(run.value));
        if (lease === undefined || intent === undefined) return undefined;
        return Object.freeze({
            run: new RunId(run.value),
            lease,
            watermark: this.facts.watermark(transaction, token.holder),
            invocationIntent: new Digest(intent.value)
        });
    }

    public evidence(transaction: Transaction, idempotencyKey: string): TargetLeaseEvidence | undefined {
        const record = this.storage.get(transaction, "targetLeaseEvidence", idempotencyKey);
        if (record === undefined) return undefined;
        const decoded = TargetLeaseEvidence.decode(record.bytes.slice());
        if (
            decoded.key.idempotencyKey !== idempotencyKey ||
            !decoded.key.source.equals(this.owner)
        ) {
            throw corrupt();
        }
        return decoded;
    }

    public record(transaction: Transaction, evidence: TargetLeaseEvidence): TargetLeaseEvidence {
        if (!evidence.key.source.equals(this.owner)) {
            throw denied("Target lease evidence belongs to another source Actor");
        }
        const existing = this.evidence(transaction, evidence.key.idempotencyKey);
        if (existing !== undefined) {
            if (!existing.digest().equals(evidence.digest())) {
                throw denied("Target lease evidence key is bound to another source attestation");
            }
            return existing;
        }
        this.storage.insert(transaction, {
            kind: "targetLeaseEvidence",
            key: evidence.key.idempotencyKey,
            revision: null,
            bytes: TargetLeaseEvidence.encode(evidence)
        });
        return evidence;
    }
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

function corrupt(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored target lease evidence is malformed");
}

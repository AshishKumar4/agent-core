import { requireSynchronousResult, type ActorRef, type SynchronousResultGuard } from "../actors";
import { RunId, type LeaseToken, type TurnLease } from "../agents";
import { Digest, compareCanonicalText } from "../core";
import { AgentCoreError } from "../errors";
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
}

export interface MemoryTargetLeaseEvidenceSnapshot {
    readonly version: 1;
    readonly evidence: readonly { readonly idempotencyKey: string; readonly bytes: Uint8Array }[];
}

export class MemoryTargetLeaseEvidenceTransaction {
    public constructor() {
        Object.freeze(this);
    }
}

interface MemoryTargetLeaseEvidenceScope {
    readonly transaction: MemoryTargetLeaseEvidenceTransaction;
    readonly evidence: Map<string, Uint8Array>;
}

/** In-memory source-Actor reference store for immutable lease evidence. */
export class MemoryTargetLeaseEvidenceStore
    implements TargetLeaseEvidenceStore<MemoryTargetLeaseEvidenceTransaction>
{
    readonly #transactions = new WeakSet<MemoryTargetLeaseEvidenceTransaction>();
    #active: MemoryTargetLeaseEvidenceScope | undefined;
    #evidence = new Map<string, Uint8Array>();

    public constructor(
        public readonly owner: ActorRef,
        snapshot?: MemoryTargetLeaseEvidenceSnapshot
    ) {
        if (snapshot !== undefined) this.restore(snapshot);
    }

    public transaction<Result>(
        operation: (transaction: MemoryTargetLeaseEvidenceTransaction) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active !== undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Nested target lease evidence transactions are not supported"
            );
        }
        const transaction = new MemoryTargetLeaseEvidenceTransaction();
        const scope = {
            transaction,
            evidence: cloneBytesMap(this.#evidence)
        } as const;
        this.#transactions.add(transaction);
        this.#active = scope;
        try {
            const result = requireSynchronousResult(operation(transaction));
            this.#evidence = cloneBytesMap(scope.evidence);
            return result;
        } finally {
            this.#active = undefined;
        }
    }

    public evidence(
        transaction: MemoryTargetLeaseEvidenceTransaction,
        idempotencyKey: string
    ): TargetLeaseEvidence | undefined {
        const bytes = this.requireTransaction(transaction).evidence.get(idempotencyKey);
        if (bytes === undefined) return undefined;
        const evidence = TargetLeaseEvidence.decode(bytes.slice());
        this.requireOwner(evidence);
        if (evidence.key.idempotencyKey !== idempotencyKey) throw corrupt();
        return evidence;
    }

    public record(
        transaction: MemoryTargetLeaseEvidenceTransaction,
        evidence: TargetLeaseEvidence
    ): TargetLeaseEvidence {
        const scope = this.requireTransaction(transaction);
        this.requireOwner(evidence);
        const existing = this.evidence(transaction, evidence.key.idempotencyKey);
        if (existing !== undefined) {
            if (!existing.digest().equals(evidence.digest())) {
                throw denied("Target lease evidence key is bound to another source attestation");
            }
            return existing;
        }
        scope.evidence.set(evidence.key.idempotencyKey, TargetLeaseEvidence.encode(evidence));
        return evidence;
    }

    public snapshot(): MemoryTargetLeaseEvidenceSnapshot {
        return {
            version: 1,
            evidence: Object.freeze(
                [...this.#evidence]
                    .sort(([left], [right]) => compareCanonicalText(left, right))
                    .map(([idempotencyKey, bytes]) =>
                        Object.freeze({ idempotencyKey, bytes: bytes.slice() })
                    )
            )
        };
    }

    private restore(snapshot: MemoryTargetLeaseEvidenceSnapshot): void {
        if (snapshot.version !== 1 || !Array.isArray(snapshot.evidence)) throw corrupt();
        const evidence = new Map<string, Uint8Array>();
        for (const record of snapshot.evidence) {
            if (!isStoredEvidenceRecord(record) || evidence.has(record.idempotencyKey)) {
                throw corrupt();
            }
            const decoded = TargetLeaseEvidence.decode(record.bytes.slice());
            this.requireOwner(decoded);
            if (decoded.key.idempotencyKey !== record.idempotencyKey) throw corrupt();
            evidence.set(record.idempotencyKey, TargetLeaseEvidence.encode(decoded));
        }
        this.#evidence = cloneBytesMap(evidence);
    }

    private requireTransaction(
        transaction: MemoryTargetLeaseEvidenceTransaction
    ): MemoryTargetLeaseEvidenceScope {
        if (
            !(transaction instanceof MemoryTargetLeaseEvidenceTransaction) ||
            !this.#transactions.has(transaction)
        ) {
            throw new TypeError("Target lease evidence transaction belongs to another owner store");
        }
        if (this.#active?.transaction !== transaction) {
            throw new AgentCoreError(
                "actor.closed",
                "Target lease evidence transaction is no longer active"
            );
        }
        return this.#active;
    }

    private requireOwner(evidence: TargetLeaseEvidence): void {
        if (!evidence.key.source.equals(this.owner)) {
            throw denied("Target lease evidence belongs to another source Actor");
        }
    }
}

function isStoredEvidenceRecord(
    value: unknown
): value is MemoryTargetLeaseEvidenceSnapshot["evidence"][number] {
    return (
        value !== null &&
        typeof value === "object" &&
        "idempotencyKey" in value &&
        typeof value.idempotencyKey === "string" &&
        "bytes" in value &&
        value.bytes instanceof Uint8Array
    );
}

function cloneBytesMap(source: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
    return new Map([...source].map(([key, bytes]) => [key, bytes.slice()]));
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

function corrupt(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored target lease evidence is malformed");
}

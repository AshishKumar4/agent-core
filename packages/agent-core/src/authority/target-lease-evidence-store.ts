import { requireSynchronousResult, type ActorRef, type SynchronousResultGuard } from "../actors";
import { compareCanonicalText } from "../core";
import { AgentCoreError } from "../errors";
import { TargetLeaseEvidence } from "./target-lease-evidence";

export interface TargetLeaseEvidenceStore<Transaction> {
    readonly owner: ActorRef;
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    evidence(transaction: Transaction, idempotencyKey: string): TargetLeaseEvidence | undefined;
    record(transaction: Transaction, evidence: TargetLeaseEvidence): TargetLeaseEvidence;
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
            if (
                record === null ||
                typeof record !== "object" ||
                !("idempotencyKey" in record) ||
                typeof record.idempotencyKey !== "string" ||
                !("bytes" in record) ||
                !(record.bytes instanceof Uint8Array) ||
                evidence.has(record.idempotencyKey)
            ) {
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

function cloneBytesMap(source: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
    return new Map([...source].map(([key, bytes]) => [key, bytes.slice()]));
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

function corrupt(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored target lease evidence is malformed");
}

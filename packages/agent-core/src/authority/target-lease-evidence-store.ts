import { requireSynchronousResult, type ActorRef, type SynchronousResultGuard } from "../actors";
import {
    RunId,
    TurnId,
    TurnLease,
    type LeaseToken
} from "../agents";
import { Digest, compareCanonicalText } from "../core";
import { AgentCoreError } from "../errors";
import type { PrincipalRef, TenantId } from "../identity";
import { TargetAuthorityPermitRequest } from "./permit-request";
import {
    TargetLeaseEvidence,
    TargetLeaseEvidenceKey
} from "./target-lease-evidence";
import {
    InvalidationWatermark,
    type ScopeEpoch
} from "./epoch";
import {
    MemoryInvalidationWatermarkStore,
    watermarkKey,
    type MemoryInvalidationWatermarkSnapshot
} from "./watermark-store";

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
 * One source Actor's delegation authority under a single transaction token: the exact
 * Turn leases it holds, the holder watermarks it delivers invalidations into, the
 * invocation intents it stands behind, and the immutable target lease evidence it
 * records. The `source` view reads the real state inside whichever transaction is
 * recording evidence, so an attestation can never outlive a rollback or mix state
 * across owners.
 */
export interface TargetLeaseEvidenceSourceStore<Transaction>
    extends TargetLeaseEvidenceStore<Transaction>
{
    readonly tenant: TenantId;
    readonly source: TargetLeaseEvidenceSourcePort<Transaction>;
    claimTurn(
        transaction: Transaction,
        turn: TurnId,
        holder: PrincipalRef,
        expiresAt: Date,
        now: Date
    ): TurnLease;
    renewTurn(transaction: Transaction, token: LeaseToken, expiresAt: Date, now: Date): TurnLease;
    fenceTurn(transaction: Transaction, turn: TurnId): TurnLease;
    joinInvalidation(
        transaction: Transaction,
        holder: PrincipalRef,
        entries: readonly ScopeEpoch[]
    ): InvalidationWatermark;
    delegateInvocation(transaction: Transaction, run: RunId, intent: Digest): void;
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
    readonly version: 2;
    readonly evidence: readonly { readonly idempotencyKey: string; readonly bytes: Uint8Array }[];
    readonly turns: readonly { readonly key: string; readonly bytes: Uint8Array }[];
    readonly watermarks: readonly { readonly key: string; readonly bytes: Uint8Array }[];
    readonly delegations: readonly { readonly run: string; readonly digest: string }[];
}

export class MemoryTargetLeaseEvidenceTransaction {
    public constructor() {
        Object.freeze(this);
    }
}

interface MemoryTargetLeaseEvidenceScope {
    readonly transaction: MemoryTargetLeaseEvidenceTransaction;
    readonly evidence: Map<string, Uint8Array>;
    readonly turns: Map<string, Uint8Array>;
    watermarks: MemoryInvalidationWatermarkSnapshot;
    readonly delegations: Map<string, string>;
}

/**
 * In-memory source-Actor delegation authority. Real Turn leases, holder watermarks,
 * delegation intents, and immutable lease evidence live in one transaction scope, so
 * the attestation read and the evidence write observe one state and commit together.
 */
export class MemoryTargetLeaseSourceStore
    implements
        TargetLeaseEvidenceSourceStore<MemoryTargetLeaseEvidenceTransaction>,
        TargetLeaseEvidenceSourcePort<MemoryTargetLeaseEvidenceTransaction>
{
    readonly #transactions = new WeakSet<MemoryTargetLeaseEvidenceTransaction>();
    #active: MemoryTargetLeaseEvidenceScope | undefined;
    #evidence = new Map<string, Uint8Array>();
    #turns = new Map<string, Uint8Array>();
    #watermarks: MemoryInvalidationWatermarkSnapshot = { version: 1, records: [] };
    #delegations = new Map<string, string>();

    public constructor(
        public readonly tenant: TenantId,
        public readonly owner: ActorRef,
        snapshot?: MemoryTargetLeaseEvidenceSnapshot
    ) {
        if (snapshot !== undefined) this.restore(snapshot);
    }

    /** The read side over this exact owner's delegation state; the store itself. */
    public readonly source: TargetLeaseEvidenceSourcePort<MemoryTargetLeaseEvidenceTransaction> =
        this;

    public transaction<Result>(
        operation: (transaction: MemoryTargetLeaseEvidenceTransaction) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active !== undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Nested target lease transactions are not supported"
            );
        }
        const transaction = new MemoryTargetLeaseEvidenceTransaction();
        const scope: MemoryTargetLeaseEvidenceScope = {
            transaction,
            evidence: cloneBytesMap(this.#evidence),
            turns: cloneBytesMap(this.#turns),
            watermarks: cloneWatermarkRecords(this.#watermarks),
            delegations: new Map(this.#delegations)
        };
        this.#transactions.add(transaction);
        this.#active = scope;
        try {
            const result = requireSynchronousResult(operation(transaction));
            this.#evidence = cloneBytesMap(scope.evidence);
            this.#turns = cloneBytesMap(scope.turns);
            this.#watermarks = cloneWatermarkRecords(scope.watermarks);
            this.#delegations = new Map(scope.delegations);
            return result;
        } finally {
            this.#active = undefined;
        }
    }

    public current(
        transaction: MemoryTargetLeaseEvidenceTransaction,
        source: ActorRef,
        run: RunId,
        token: LeaseToken
    ): TargetLeaseEvidenceSourceState | undefined {
        const scope = this.requireTransaction(transaction);
        if (!source.equals(this.owner)) return undefined;
        const turnBytes = scope.turns.get(token.turn.value);
        const intent = scope.delegations.get(run.value);
        if (turnBytes === undefined || intent === undefined) return undefined;
        return Object.freeze({
            run: new RunId(run.value),
            lease: TurnLease.decode(turnBytes.slice()),
            watermark: this.watermarkIn(scope, token.holder),
            invocationIntent: new Digest(intent)
        });
    }

    public claimTurn(
        transaction: MemoryTargetLeaseEvidenceTransaction,
        turn: TurnId,
        holder: PrincipalRef,
        expiresAt: Date,
        now: Date
    ): TurnLease {
        const scope = this.requireTransaction(transaction);
        const stored = scope.turns.get(turn.value);
        const claimed = (
            stored === undefined ? TurnLease.unclaimed(new TurnId(turn.value)) : TurnLease.decode(stored.slice())
        ).claim(holder, now, expiresAt);
        scope.turns.set(claimed.turn.value, TurnLease.encode(claimed));
        return claimed;
    }

    public renewTurn(
        transaction: MemoryTargetLeaseEvidenceTransaction,
        token: LeaseToken,
        expiresAt: Date,
        now: Date
    ): TurnLease {
        const scope = this.requireTransaction(transaction);
        const stored = scope.turns.get(token.turn.value);
        if (stored === undefined) {
            throw new AgentCoreError("lease.invalid", "Turn lease renewal requires a stored lease");
        }
        const renewed = TurnLease.decode(stored.slice()).renew(token.holder, token.epoch, now, expiresAt);
        scope.turns.set(renewed.turn.value, TurnLease.encode(renewed));
        return renewed;
    }

    public fenceTurn(
        transaction: MemoryTargetLeaseEvidenceTransaction,
        turn: TurnId
    ): TurnLease {
        const scope = this.requireTransaction(transaction);
        const stored = scope.turns.get(turn.value);
        if (stored === undefined) {
            throw new AgentCoreError("lease.invalid", "Turn lease fencing requires a stored lease");
        }
        const fenced = TurnLease.decode(stored.slice()).fence();
        scope.turns.set(fenced.turn.value, TurnLease.encode(fenced));
        return fenced;
    }

    public joinInvalidation(
        transaction: MemoryTargetLeaseEvidenceTransaction,
        holder: PrincipalRef,
        entries: readonly ScopeEpoch[]
    ): InvalidationWatermark {
        const scope = this.requireTransaction(transaction);
        const watermarks = this.watermarkStoreIn(scope);
        const empty = InvalidationWatermark.empty(this.tenant, this.owner, holder);
        if (watermarks.load(watermarkKey(empty)) === undefined) watermarks.save(empty);
        const joined = watermarks.join(watermarkKey(empty), entries);
        scope.watermarks = watermarks.snapshot();
        return joined;
    }

    public delegateInvocation(
        transaction: MemoryTargetLeaseEvidenceTransaction,
        run: RunId,
        intent: Digest
    ): void {
        const scope = this.requireTransaction(transaction);
        scope.delegations.set(new RunId(run.value).value, new Digest(intent.value).value);
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
            version: 2,
            evidence: Object.freeze(
                [...this.#evidence]
                    .sort(([left], [right]) => compareCanonicalText(left, right))
                    .map(([idempotencyKey, bytes]) =>
                        Object.freeze({ idempotencyKey, bytes: bytes.slice() })
                    )
            ),
            turns: Object.freeze(
                [...this.#turns]
                    .sort(([left], [right]) => compareCanonicalText(left, right))
                    .map(([key, bytes]) => Object.freeze({ key, bytes: bytes.slice() }))
            ),
            watermarks: Object.freeze(cloneWatermarkRecords(this.#watermarks).records),
            delegations: Object.freeze(
                [...this.#delegations]
                    .sort(([left], [right]) => compareCanonicalText(left, right))
                    .map(([run, digest]) => Object.freeze({ run, digest }))
            )
        };
    }

    private restore(snapshot: MemoryTargetLeaseEvidenceSnapshot): void {
        if (
            snapshot.version !== 2 ||
            !Array.isArray(snapshot.evidence) ||
            !Array.isArray(snapshot.turns) ||
            !Array.isArray(snapshot.watermarks) ||
            !Array.isArray(snapshot.delegations)
        ) {
            throw corrupt();
        }
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
        const turns = new Map<string, Uint8Array>();
        for (const record of snapshot.turns) {
            if (!isStoredKeyedRecord(record) || turns.has(record.key)) throw corrupt();
            const decoded = TurnLease.decode(record.bytes.slice());
            if (decoded.turn.value !== record.key) throw corrupt();
            turns.set(record.key, TurnLease.encode(decoded));
        }
        // The watermark store validates keys, revisions, and owner identity itself.
        const watermarks = new MemoryInvalidationWatermarkStore(this.tenant, this.owner, {
            version: 1,
            records: snapshot.watermarks.map((record) => ({ key: record.key, bytes: record.bytes }))
        }).snapshot();
        const delegations = new Map<string, string>();
        for (const record of snapshot.delegations) {
            if (!isStoredDelegationRecord(record) || delegations.has(record.run)) throw corrupt();
            delegations.set(new RunId(record.run).value, new Digest(record.digest).value);
        }
        this.#evidence = cloneBytesMap(evidence);
        this.#turns = cloneBytesMap(turns);
        this.#watermarks = watermarks;
        this.#delegations = delegations;
    }

    private watermarkIn(
        scope: MemoryTargetLeaseEvidenceScope,
        holder: PrincipalRef
    ): InvalidationWatermark {
        const empty = InvalidationWatermark.empty(this.tenant, this.owner, holder);
        return this.watermarkStoreIn(scope).load(watermarkKey(empty)) ?? empty;
    }

    private watermarkStoreIn(
        scope: MemoryTargetLeaseEvidenceScope
    ): MemoryInvalidationWatermarkStore {
        return new MemoryInvalidationWatermarkStore(this.tenant, this.owner, scope.watermarks);
    }

    private requireTransaction(
        transaction: MemoryTargetLeaseEvidenceTransaction
    ): MemoryTargetLeaseEvidenceScope {
        if (
            !(transaction instanceof MemoryTargetLeaseEvidenceTransaction) ||
            !this.#transactions.has(transaction)
        ) {
            throw new TypeError("Target lease transaction belongs to another owner store");
        }
        if (this.#active?.transaction !== transaction) {
            throw new AgentCoreError(
                "actor.closed",
                "Target lease transaction is no longer active"
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

function isStoredKeyedRecord(
    value: unknown
): value is MemoryTargetLeaseEvidenceSnapshot["turns"][number] {
    return (
        value !== null &&
        typeof value === "object" &&
        "key" in value &&
        typeof value.key === "string" &&
        "bytes" in value &&
        value.bytes instanceof Uint8Array
    );
}

function isStoredDelegationRecord(
    value: unknown
): value is MemoryTargetLeaseEvidenceSnapshot["delegations"][number] {
    return (
        value !== null &&
        typeof value === "object" &&
        "run" in value &&
        typeof value.run === "string" &&
        "digest" in value &&
        typeof value.digest === "string"
    );
}

function cloneWatermarkRecords(
    snapshot: MemoryInvalidationWatermarkSnapshot
): MemoryInvalidationWatermarkSnapshot {
    return {
        version: 1,
        records: snapshot.records.map((record) => ({
            key: record.key,
            bytes: record.bytes.slice()
        }))
    };
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

// @ts-nocheck
import type { Approval } from "./approval";
import type { EffectAttempt } from "./attempt";
import type { ItemClaim } from "./claim";
import type { InvocationContinuation } from "./continuation";
import { ApprovalId, EffectAttemptId, ItemClaimId, ReceiptId } from "./id";
import { InvocationId } from "../interaction-references";
import type { InvocationPersistence } from "./persistence";
import type { PreparedInvocation } from "./prepared";
import { AttemptReceipt, PreEffectReceipt, type Receipt } from "./receipt";
import type { RecordCodec } from "../core";
import { AgentCoreError } from "../errors";
import { invocationError } from "./error";

export interface InvocationMemoryState {
    readonly prepared: Map<string, Uint8Array>;
    readonly approvals: Map<string, Uint8Array>;
    readonly approvalByInvocation: Map<string, string>;
    readonly continuations: Map<string, Uint8Array>;
    readonly claims: Map<string, Uint8Array>;
    readonly claimOrder: string[];
    readonly attempts: Map<string, Uint8Array>;
    readonly attemptByClaim: Map<string, string>;
    readonly receipts: Map<string, Uint8Array>;
    readonly receiptOrder: string[];
}

export interface InvocationMemoryCodecs<Lease, Authority, Domain, PathEpochs, Admission> {
    readonly prepared: RecordCodec<PreparedInvocation<Lease, Authority, Domain, PathEpochs>>;
    readonly approval: RecordCodec<Approval>;
    readonly continuation: RecordCodec<InvocationContinuation<Lease>>;
    readonly claim: RecordCodec<ItemClaim<Lease>>;
    readonly attempt: RecordCodec<EffectAttempt<Lease, Admission>>;
    readonly receipt: RecordCodec<Receipt>;
}

export function createInvocationMemoryState(): InvocationMemoryState {
    return {
        prepared: new Map(),
        approvals: new Map(),
        approvalByInvocation: new Map(),
        continuations: new Map(),
        claims: new Map(),
        claimOrder: [],
        attempts: new Map(),
        attemptByClaim: new Map(),
        receipts: new Map(),
        receiptOrder: []
    };
}

export function cloneInvocationMemoryState(state: InvocationMemoryState): InvocationMemoryState {
    return {
        prepared: cloneByteMap(state.prepared),
        approvals: cloneByteMap(state.approvals),
        approvalByInvocation: new Map(state.approvalByInvocation),
        continuations: cloneByteMap(state.continuations),
        claims: cloneByteMap(state.claims),
        claimOrder: [...state.claimOrder],
        attempts: cloneByteMap(state.attempts),
        attemptByClaim: new Map(state.attemptByClaim),
        receipts: cloneByteMap(state.receipts),
        receiptOrder: [...state.receiptOrder]
    };
}

export class MemoryInvocationPersistence<
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> implements InvocationPersistence<
    InvocationMemoryState,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission
> {
    public constructor(
        private readonly codecs: InvocationMemoryCodecs<
            Lease,
            Authority,
            Domain,
            PathEpochs,
            Admission
        >
    ) {}

    public prepared(
        transaction: InvocationMemoryState,
        id: InvocationId
    ): PreparedInvocation<Lease, Authority, Domain, PathEpochs> | undefined {
        const record = decode(transaction.prepared.get(id.value), this.codecs.prepared);
        if (record !== undefined && !record.header.id.equals(id)) corruptMemory();
        return record;
    }

    public insertPrepared(
        transaction: InvocationMemoryState,
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>
    ): void {
        insert(transaction.prepared, record.header.id.value, this.codecs.prepared.encode(record));
    }

    public approval(transaction: InvocationMemoryState, id: ApprovalId): Approval | undefined {
        const entries = approvalEntries(transaction.approvals, id.value);
        if (entries.length === 0) return undefined;
        const [revision, bytes] = entries.at(-1)!;
        const record = this.codecs.approval.decode(bytes);
        if (!record.id.equals(id) || record.revision.value !== revision) corruptMemory();
        return record;
    }

    public approvalForInvocation(
        transaction: InvocationMemoryState,
        invocation: InvocationId
    ): Approval | undefined {
        const id = transaction.approvalByInvocation.get(invocation.value);
        if (id === undefined) {
            for (const bytes of transaction.approvals.values()) {
                if (this.codecs.approval.decode(bytes).invocation.equals(invocation))
                    corruptMemory();
            }
            return undefined;
        }
        const record = this.approval(transaction, new ApprovalId(id));
        if (record === undefined || !record.invocation.equals(invocation)) corruptMemory();
        return record;
    }

    public approvalRevision(
        transaction: InvocationMemoryState,
        id: ApprovalId,
        revision: number
    ): Approval | undefined {
        const record = decode(
            transaction.approvals.get(approvalKey(id.value, revision)),
            this.codecs.approval
        );
        if (record !== undefined && (!record.id.equals(id) || record.revision.value !== revision))
            corruptMemory();
        return record;
    }

    public appendApproval(transaction: InvocationMemoryState, record: Approval): void {
        const currentId = transaction.approvalByInvocation.get(record.invocation.value);
        if (currentId !== undefined && currentId !== record.id.value) {
            throw invocationError(
                "store.duplicate-record",
                "An Invocation cannot have multiple Approvals"
            );
        }
        insert(
            transaction.approvals,
            approvalKey(record.id.value, record.revision.value),
            this.codecs.approval.encode(record)
        );
        transaction.approvalByInvocation.set(record.invocation.value, record.id.value);
    }

    public continuation(
        transaction: InvocationMemoryState,
        invocation: InvocationId
    ): InvocationContinuation<Lease> | undefined {
        const record = decode(
            transaction.continuations.get(invocation.value),
            this.codecs.continuation
        );
        if (record !== undefined && !record.invocation.equals(invocation)) corruptMemory();
        return record;
    }

    public insertContinuation(
        transaction: InvocationMemoryState,
        record: InvocationContinuation<Lease>
    ): void {
        insert(
            transaction.continuations,
            record.invocation.value,
            this.codecs.continuation.encode(record)
        );
    }

    public claim(
        transaction: InvocationMemoryState,
        id: ItemClaimId
    ): ItemClaim<Lease> | undefined {
        const record = decode(transaction.claims.get(id.value), this.codecs.claim);
        if (record !== undefined && !record.id.equals(id)) corruptMemory();
        return record;
    }

    public claimsForItem(
        transaction: InvocationMemoryState,
        invocation: InvocationId,
        itemIndex: number
    ): readonly ItemClaim<Lease>[] {
        requireOrder(transaction.claimOrder, transaction.claims, "claim");
        return transaction.claimOrder
            .map((id) => this.claim(transaction, new ItemClaimId(id))!)
            .filter(
                (claim) => claim.invocation.equals(invocation) && claim.itemIndex === itemIndex
            );
    }

    public appendClaim(transaction: InvocationMemoryState, record: ItemClaim<Lease>): void {
        insert(transaction.claims, record.id.value, this.codecs.claim.encode(record));
        transaction.claimOrder.push(record.id.value);
    }

    public attempt(
        transaction: InvocationMemoryState,
        id: EffectAttemptId
    ): EffectAttempt<Lease, Admission> | undefined {
        requireAttemptIndexes(transaction, this.codecs.attempt);
        const record = decode(transaction.attempts.get(id.value), this.codecs.attempt);
        if (record !== undefined && !record.id.equals(id)) corruptMemory();
        return record;
    }

    public attemptForClaim(
        transaction: InvocationMemoryState,
        claim: ItemClaimId
    ): EffectAttempt<Lease, Admission> | undefined {
        const id = transaction.attemptByClaim.get(claim.value);
        if (id === undefined) {
            for (const bytes of transaction.attempts.values()) {
                if (this.codecs.attempt.decode(bytes).claim.equals(claim)) corruptMemory();
            }
            return undefined;
        }
        const record = this.attempt(transaction, new EffectAttemptId(id));
        if (record === undefined || !record.claim.equals(claim)) corruptMemory();
        return record;
    }

    public attemptsForItem(
        transaction: InvocationMemoryState,
        invocation: InvocationId,
        itemIndex: number
    ): readonly EffectAttempt<Lease, Admission>[] {
        return [...transaction.attempts.keys()]
            .map((id) => this.attempt(transaction, new EffectAttemptId(id))!)
            .filter(
                (attempt) =>
                    attempt.invocation.equals(invocation) && attempt.itemIndex === itemIndex
            )
            .sort((left, right) => left.ordinal - right.ordinal);
    }

    public appendAttempt(
        transaction: InvocationMemoryState,
        record: EffectAttempt<Lease, Admission>
    ): void {
        if (transaction.attemptByClaim.has(record.claim.value)) {
            throw invocationError(
                "store.duplicate-record",
                "An ItemClaim cannot admit multiple EffectAttempts"
            );
        }
        if (
            this.attemptsForItem(transaction, record.invocation, record.itemIndex).some(
                (attempt) => attempt.ordinal === record.ordinal
            )
        ) {
            throw invocationError(
                "store.duplicate-record",
                "An item ordinal cannot have multiple EffectAttempts"
            );
        }
        insert(transaction.attempts, record.id.value, this.codecs.attempt.encode(record));
        transaction.attemptByClaim.set(record.claim.value, record.id.value);
    }

    public receipt(transaction: InvocationMemoryState, id: ReceiptId): Receipt | undefined {
        requireOrder(transaction.receiptOrder, transaction.receipts, "receipt");
        const record = decode(transaction.receipts.get(id.value), this.codecs.receipt);
        if (record !== undefined && !record.id.equals(id)) corruptMemory();
        return record;
    }

    public receiptsForItem(
        transaction: InvocationMemoryState,
        invocation: InvocationId,
        itemIndex: number
    ): readonly Receipt[] {
        const attempts = this.attemptsForItem(transaction, invocation, itemIndex);
        const attemptIds = new Set(attempts.map((attempt) => attempt.id.value));
        return transaction.receiptOrder
            .map((id) => this.receipt(transaction, new ReceiptId(id))!)
            .filter((receipt) =>
                receipt instanceof PreEffectReceipt
                    ? receipt.invocation.equals(invocation) && receipt.itemIndex === itemIndex
                    : receipt instanceof AttemptReceipt && attemptIds.has(receipt.attempt.value)
            );
    }

    public receiptsForAttempt(
        transaction: InvocationMemoryState,
        attempt: EffectAttemptId
    ): readonly Receipt[] {
        return transaction.receiptOrder
            .map((id) => this.receipt(transaction, new ReceiptId(id))!)
            .filter(
                (receipt) => receipt instanceof AttemptReceipt && receipt.attempt.equals(attempt)
            );
    }

    public appendReceipt(transaction: InvocationMemoryState, record: Receipt): void {
        insert(transaction.receipts, record.id.value, this.codecs.receipt.encode(record));
        transaction.receiptOrder.push(record.id.value);
    }
}

function approvalKey(id: string, revision: number): string {
    return `${id}\u0000${revision}`;
}

function approvalEntries(
    approvals: ReadonlyMap<string, Uint8Array>,
    id: string
): readonly (readonly [number, Uint8Array])[] {
    const prefix = `${id}\u0000`;
    return [...approvals.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => [Number(key.slice(prefix.length)), bytes] as const)
        .sort(([left], [right]) => left - right);
}

function insert(map: Map<string, Uint8Array>, key: string, bytes: Uint8Array): void {
    if (map.has(key)) {
        throw invocationError("store.duplicate-record", "Invocation records are append-only");
    }
    map.set(key, bytes.slice());
}

function decode<Record>(
    bytes: Uint8Array | undefined,
    codec: RecordCodec<Record>
): Record | undefined {
    return bytes === undefined ? undefined : codec.decode(bytes.slice());
}

function cloneByteMap(value: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
    return new Map([...value].map(([key, bytes]) => [key, bytes.slice()]));
}

function corruptMemory(): never {
    throw new AgentCoreError("codec.invalid", "Memory invocation index does not match codec bytes");
}

function requireOrder(
    order: readonly string[],
    records: ReadonlyMap<string, Uint8Array>,
    subject: string
): void {
    if (
        order.length !== records.size ||
        new Set(order).size !== order.length ||
        order.some((id) => !records.has(id))
    ) {
        throw new AgentCoreError("codec.invalid", `Memory invocation ${subject} order is corrupt`);
    }
}

function requireAttemptIndexes<Lease, Admission>(
    transaction: InvocationMemoryState,
    codec: RecordCodec<EffectAttempt<Lease, Admission>>
): void {
    if (transaction.attemptByClaim.size !== transaction.attempts.size) corruptMemory();
    for (const [id, bytes] of transaction.attempts) {
        const attempt = codec.decode(bytes);
        if (attempt.id.value !== id || transaction.attemptByClaim.get(attempt.claim.value) !== id) {
            corruptMemory();
        }
    }
}

import type { ActorRef } from "../actors";
import { Digest, type ContentRef } from "../core";
import type { AuditAppendContext, AuditKind, AuditRecord } from "./audit";
import type { AuditRecordId, InvocationId } from "../interaction-references";
import type { ReceiptId } from "./id";
import type { EffectAttempt } from "./attempt";
import type { ItemClaim } from "./claim";
import type { StructuralCodec } from "./codec";
import { immutableReference } from "./codec";
import type { PreparedInvocation } from "./prepared";
import type { InvocationPublicationOutbox } from "./publication";
import type { MediatedReplayRecord } from "./replay";

export interface InvocationReferencePorts<Lease, Authority, Domain, PathEpochs, Admission> {
    readonly lease: StructuralCodec<Lease>;
    readonly authority: StructuralCodec<Authority>;
    readonly domain: StructuralCodec<Domain>;
    readonly pathEpochs: StructuralCodec<PathEpochs>;
    readonly admission: StructuralCodec<Admission>;
}

export class AuthorityAdmissionReference<Reference> {
    public readonly reference: Reference;

    public constructor(
        reference: Reference,
        public readonly digest: Digest
    ) {
        this.reference = immutableReference(reference);
        Object.freeze(digest);
        Object.freeze(this);
    }
}

export interface AuthorityAdmissionContext<Lease, Authority, Domain, PathEpochs> {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly ordinal: number;
    readonly lease: Lease | undefined;
    readonly authority: Authority;
    readonly domain: Domain;
    readonly pathEpochs: PathEpochs;
    readonly intentDigest: Digest;
    readonly itemKey: string;
}

export interface AuthorityAdmissionPort<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    Admission,
    Authentication = undefined
> {
    admits(
        transaction: Transaction,
        admission: AuthorityAdmissionReference<Admission>,
        context: AuthorityAdmissionContext<Lease, Authority, Domain, PathEpochs>,
        authentication?: Authentication
    ): boolean;
}

export interface InvocationPreparationPort<Transaction, Lease, Authority, Domain, PathEpochs> {
    admits(
        transaction: Transaction,
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>
    ): boolean;
}

export interface InvocationTimePort<Transaction> {
    admits(transaction: Transaction, time: Date): boolean;
}

export interface InvocationClaimOwnerPort<Transaction, Lease, Admission> {
    admits(
        transaction: Transaction,
        claim: ItemClaim<Lease>,
        attempt: EffectAttempt<Lease, Admission>
    ): boolean;
}

export type ReconciliationResult =
    | { readonly kind: "unknown" }
    | { readonly kind: "succeeded"; readonly result?: ContentRef }
    | { readonly kind: "failed"; readonly result?: ContentRef };

export interface EffectReconciliationPort<Lease, Admission> {
    query(
        attempt: EffectAttempt<Lease, Admission>,
        intentDigest: Digest
    ): Promise<ReconciliationResult>;
}

export interface ReceiptObservation {
    readonly invocation: InvocationId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
}

export interface InvocationEventPort {
    publish(outboxId: Digest, observation: ReceiptObservation): Promise<void>;
}

export interface InvocationCommitPort {
    append(outboxId: Digest, observation: ReceiptObservation): Promise<void>;
}

export interface InvocationTransactionPort<Transaction> {
    transact<Result>(operation: (transaction: Transaction) => Result): Result;
}

export interface InvocationReplayPersistence<Transaction> {
    replay(
        transaction: Transaction,
        scope: string,
        requestKey: string
    ): MediatedReplayRecord | undefined;
    replayById(transaction: Transaction, id: Digest): MediatedReplayRecord | undefined;
    appendReplay(transaction: Transaction, record: MediatedReplayRecord): void;
}

export interface InvocationAuditPersistence<Transaction> {
    audit(transaction: Transaction, id: AuditRecordId): AuditRecord | undefined;
    findAuditByEvidence(
        transaction: Transaction,
        actor: ActorRef,
        kind: AuditKind
    ): AuditRecord | undefined;
    appendAudit(transaction: Transaction, record: AuditRecord, context?: AuditAppendContext): void;
}

export interface InvocationEvidencePersistence<
    Transaction
> extends InvocationAuditPersistence<Transaction> {
    publication(transaction: Transaction, id: Digest): InvocationPublicationOutbox | undefined;
    pendingPublications(transaction: Transaction): readonly InvocationPublicationOutbox[];
    appendPublication(transaction: Transaction, record: InvocationPublicationOutbox): void;
}

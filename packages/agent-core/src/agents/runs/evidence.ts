import { ContentRef } from "../../core";
import type { OperationRef } from "../../facets";
import type { ReceiptId } from "../../invocation-references";
import type { AttemptReceiptOutcome, Receipt } from "../../invocations";
import type {
    AuditRecordId,
    EventId,
    InvocationId,
    RouteReservationId
} from "../../interaction-references";
import type { LeaseToken } from "./lease";
import type { TurnAdmissionHandle } from "./handle";
import type { RunBranchId, RunId } from "./id";
import type { RunCommit } from "./commit";
import type { TurnId } from "../../execution-references";

export interface ReceiptCommitEvidence {
    readonly kind: "receipt";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly invocation: InvocationId;
    readonly subjectTurn?: LeaseToken["turn"];
}

export interface DeliveryCommitEvidence {
    readonly kind: "delivery";
    readonly run: RunId;
    readonly reservation: RouteReservationId;
    readonly audit: AuditRecordId;
    readonly subjectTurn?: LeaseToken["turn"];
}

/**
 * One item of the ordered `administer` payload a multiway fold declares (§5.2). The order is
 * the caller's, fixed by the Invocation's argument digest before the first merge is attempted,
 * so nothing here is a second copy of the graph: the fold is the request, the merge chain is
 * the result, and each merge already had to name this exact control Receipt.
 */
export interface MergeFoldStep {
    readonly invocation: InvocationId;
    /** Zero-based position of this binary merge in the declared fold. */
    readonly itemIndex: number;
    /** Length of the declared payload; one item declares no order. */
    readonly itemCount: number;
    /** The branch this item declared as the merge's source lineage. */
    readonly source: RunBranchId;
}

export interface ControlCommitEvidence {
    readonly kind: "control";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly proposalDigest: string;
    /** Present when this control Receipt is one item of a declared fold. */
    readonly fold?: MergeFoldStep;
}

/**
 * The one commit this platform admits on failed control evidence: a rewrite whose attempt
 * ended without installing anything. It binds the Run, the proposal and the audit record to
 * one Receipt and stops there: §7.4's closed failure kind on that Receipt is what says why the
 * attempt ended, so this evidence names the Receipt and never restates its determination. A
 * `failed` outcome and a failure label beside the Receipt were both that restatement, and a
 * host could name a kind the Receipt contradicted; `validateCommitWriter` now loads the
 * Receipt and reads the kind off it, so an abandoned attempt that says nothing about why it
 * ended is refused on the Receipt's own record rather than on a label.
 */
export interface AbandonedRewriteEvidence {
    readonly kind: "abandonedRewrite";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly proposalDigest: string;
}

export interface SynthesisCommitEvidence {
    readonly kind: "synthesis";
    readonly run: RunId;
    readonly receipt: ReceiptId;
    readonly token: LeaseToken;
    readonly content: ContentRef;
}

export interface AdministerControlEvidence {
    readonly kind: "administer";
    readonly run: RunId;
    readonly terminalTurn: TurnId;
    readonly receipt: ReceiptId;
    readonly audit: AuditRecordId;
    readonly outcome: "succeeded";
}

export interface AcceptanceReceiptEvidence {
    readonly kind: "acceptanceReceipt";
    readonly receipt: ReceiptId;
    readonly outcome: AttemptReceiptOutcome;
    /** The Operation this Receipt's attempt invoked, so discharge can bind it to the
     *  criterion's declared verifier rather than accept any succeeded Receipt. */
    readonly operation: OperationRef;
}

export interface ForcedCancellationEvidence {
    readonly kind: "turnCancellation";
    readonly eventKind: "turn.cancel";
    readonly run: RunId;
    readonly terminalTurn: TurnId;
    readonly turn: TurnId;
    readonly priorLeaseEpoch: number;
    readonly fencedLeaseEpoch: number;
    readonly inboxLeaseEpoch: number;
    readonly controlReceipt: ReceiptId;
    readonly controlAudit: AuditRecordId;
    readonly event: EventId;
    readonly audit: AuditRecordId;
}

export abstract class RunEvidencePort<Transaction> {
    public abstract receipt(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): ReceiptCommitEvidence | undefined;

    public abstract delivery(
        transaction: Transaction,
        reservation: RouteReservationId,
        audit: AuditRecordId
    ): DeliveryCommitEvidence | undefined;

    public abstract control(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): ControlCommitEvidence | undefined;

    public abstract abandonedRewrite(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): AbandonedRewriteEvidence | undefined;

    /**
     * The §7.4 Receipt this id names, exactly as §7.4 recorded it. Deliberately narrow: it
     * retrieves the record and decides nothing, so a commit that stands on a failed attempt
     * reads why that attempt ended off the Receipt rather than off a label beside it, and
     * every rule about what a commit may stand on stays in `validateCommitWriter`.
     */
    public abstract storedReceipt(
        transaction: Transaction,
        receipt: ReceiptId
    ): Receipt | undefined;

    /**
     * The handle a Turn published for one admitted item (SPEC §5.6), or none where no Turn
     * published it. Publication is what detaches an item from its Turn to a Run, and which
     * Run that is lives in the handle's admission identity, so a Run's cancellation has to
     * read the handle back rather than infer an owner from the obligation. Nothing here is a
     * second copy of state: every field of a handle is already owned durably by the §7.4
     * records it names, which is why a table of handles is exactly what this platform does
     * not keep, and this seam derives the value from those records instead.
     */
    public abstract publishedHandle(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number,
        itemKey: string
    ): TurnAdmissionHandle | undefined;

    public abstract synthesis(
        transaction: Transaction,
        receipt: ReceiptId
    ): SynthesisCommitEvidence | undefined;

    public abstract administer(
        transaction: Transaction,
        receipt: ReceiptId,
        audit: AuditRecordId
    ): AdministerControlEvidence | undefined;

    public abstract forcedCancellation(
        transaction: Transaction,
        event: EventId,
        audit: AuditRecordId
    ): ForcedCancellationEvidence | undefined;

    public abstract acceptance(
        transaction: Transaction,
        receipt: ReceiptId
    ): AcceptanceReceiptEvidence | undefined;
}

export abstract class RunMergePort<Transaction> {
    public abstract verifyConcat(
        transaction: Transaction,
        commit: RunCommit,
        target: RunCommit,
        source: RunCommit
    ): boolean;

    public abstract verifyTree(
        transaction: Transaction,
        commit: RunCommit,
        target: RunCommit,
        source: RunCommit
    ): boolean;
}

import type { RunId } from "../agents";
import type { BindingAuthority } from "../authority";
import type { OperationAddress } from "../facets";
import type { TenantId } from "../identity";
import type { ContentRef, Digest } from "../record";
import type { EventId, WorkspaceId } from "../workspaces";
import type { ApprovalId } from "./id";
import type { InvocationId } from "./id";
import type { InvocationReceipt } from "./receipt";

export type InvocationImpact = "observe" | "mutate" | "externalSend" | "execute" | "delegate" | "administer";
export type InvocationStatus = "prepared" | "approval-required" | "invoking" | "succeeded" | "failed" | "denied" | "cancelled" | "indeterminate";

export class InvocationMetadata {
    public constructor(
        public readonly tenantId: TenantId | undefined,
        public readonly workspaceId: WorkspaceId | undefined,
        public readonly authority: BindingAuthority | undefined,
        public readonly approvalId: ApprovalId | undefined,
        public readonly eventId: EventId | undefined,
        public readonly telemetryRef: ContentRef | undefined
    ) {
    }

    public static empty(): InvocationMetadata {
        return emptyInvocationMetadata;
    }
}

export class Invocation {
    public constructor(
        public readonly id: InvocationId,
        public readonly runId: RunId,
        public readonly sequence: number,
        public readonly target: OperationAddress,
        public readonly impact: InvocationImpact,
        public readonly argumentDigest: Digest,
        public readonly argumentRef: ContentRef | undefined,
        public readonly idempotencyKey: string,
        public readonly status: InvocationStatus,
        public readonly receipt: InvocationReceipt | undefined,
        public readonly metadata: InvocationMetadata = InvocationMetadata.empty()
    ) {
        if (!Number.isInteger(sequence) || sequence < 0) {
            throw new TypeError("Invocation sequence must be a non-negative integer");
        }

        if (idempotencyKey.length === 0 || idempotencyKey.length > 512) {
            throw new TypeError("Invocation idempotency key must contain between 1 and 512 characters");
        }
    }

    public get isTerminal(): boolean {
        return this.status === "succeeded"
            || this.status === "failed"
            || this.status === "denied"
            || this.status === "cancelled"
            || this.status === "indeterminate";
    }

    public requireApproval(approvalId: ApprovalId): Invocation {
        return this.transition("approval-required", undefined, new InvocationMetadata(
            this.metadata.tenantId,
            this.metadata.workspaceId,
            this.metadata.authority,
            approvalId,
            this.metadata.eventId,
            this.metadata.telemetryRef
        ));
    }

    public start(): Invocation {
        return this.transition("invoking", undefined);
    }

    public record(receipt: InvocationReceipt): Invocation {
        return this.transition(receipt.status, receipt);
    }

    private transition(
        status: InvocationStatus,
        receipt: InvocationReceipt | undefined,
        metadata: InvocationMetadata = this.metadata
    ): Invocation {
        return new Invocation(
            this.id,
            this.runId,
            this.sequence,
            this.target,
            this.impact,
            this.argumentDigest,
            this.argumentRef,
            this.idempotencyKey,
            status,
            receipt,
            metadata
        );
    }
}

const emptyInvocationMetadata = new InvocationMetadata(undefined, undefined, undefined, undefined, undefined, undefined);

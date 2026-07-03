import type { BindingAuthority } from "../authority";
import type { FacetData, OperationAddress, OperationDescriptor } from "../facets";
import type { OperationContext } from "../operations";
import { ObservedOperation, SpanOutcome } from "../observability/telemetry";
import { EventKind, EventMetadata, EventRecord, EventSource } from "../workspaces/events";
import type { EventId, WorkspaceId } from "../workspaces/id";
import { Revision } from "../record";
import { AgentCoreError } from "../errors";
import { Approval, ApprovalResolution } from "./approval";
import { AuditRecord } from "./audit";
import { digestFacetData } from "./digest";
import type { ApprovalId, AuditRecordId, ReceiptId } from "./id";
import type { Invocation } from "./invocation";
import type { InvocationMediator, InvocationRecorder } from "./mediator";
import { InvocationReceipt, type ReceiptStatus } from "./receipt";

export type InvocationEventKind = "prepared" | "approval-required" | "completed";

const invocationEventSource = new EventSource("invocation.pipeline");

export interface InvokableOperation {
    readonly authority?: BindingAuthority;
    readonly descriptor: OperationDescriptor;

    execute(context: OperationContext, input: FacetData): Promise<FacetData>;
}

export interface InvocationOperationResolver {
    resolve(address: OperationAddress): InvokableOperation | undefined;
}

export interface InvocationIdFactory {
    receiptId(invocation: Invocation, status: ReceiptStatus): ReceiptId;
    auditRecordId(invocation: Invocation, kind: AuditRecord["kind"]): AuditRecordId;
    eventId(invocation: Invocation, kind: InvocationEventKind): EventId;
    approvalId(invocation: Invocation): ApprovalId;
}

export type InvocationPipelineResult =
    | { readonly kind: "completed"; readonly invocation: Invocation; readonly receipt: InvocationReceipt; readonly output: FacetData }
    | { readonly kind: "approval-required"; readonly invocation: Invocation; readonly approval: Approval }
    | { readonly kind: "denied"; readonly invocation: Invocation; readonly receipt: InvocationReceipt }
    | { readonly kind: "cancelled"; readonly invocation: Invocation; readonly receipt: InvocationReceipt }
    | { readonly kind: "failed"; readonly invocation: Invocation; readonly receipt: InvocationReceipt };

export class InvocationPipeline {
    public constructor(
        private readonly operations: InvocationOperationResolver,
        private readonly mediator: InvocationMediator,
        private readonly recorder: InvocationRecorder,
        private readonly ids: InvocationIdFactory
    ) {
    }

    public async invoke(context: OperationContext, invocation: Invocation, input: FacetData): Promise<InvocationPipelineResult> {
        const span = context.start(new ObservedOperation("operation.invoke", []));
        try {
            ensureLease(context);
            await this.recordPrepared(context, invocation);

            const operation = this.operations.resolve(invocation.target);
            if (operation === undefined) {
                const receipt = this.createReceipt(invocation, "failed");
                const failed = await this.recordReceipt(context, invocation, receipt);
                span.end(SpanOutcome.failed("operation.missing"));
                return { kind: "failed", invocation: failed, receipt };
            }

            if (!context.permits(operation.authority)) {
                const receipt = this.createReceipt(invocation, "denied");
                const denied = await this.recordReceipt(context, invocation, receipt);
                span.end(SpanOutcome.failed("authority.denied"));
                return { kind: "denied", invocation: denied, receipt };
            }

            if (!this.revalidates(invocation, operation, input)) {
                const receipt = this.createReceipt(invocation, "denied");
                const denied = await this.recordReceipt(context, invocation, receipt);
                span.end(SpanOutcome.failed("invocation.invalid"));
                return { kind: "denied", invocation: denied, receipt };
            }

            const decision = await this.mediator.decide(invocation);
            if (decision === "request-approval") {
                const approval = new Approval(
                    this.ids.approvalId(invocation),
                    this.requireWorkspace(invocation),
                    invocation.runId,
                    invocation.id,
                    invocation.argumentDigest,
                    "pending",
                    undefined,
                    Revision.initial()
                );
                const pending = invocation.requireApproval(approval.id);
                await this.recorder.recordApproval(context, approval);
                await this.recordAudit(context, pending, "approval-required");
                await this.recordEvent(context, pending, "approval-required", undefined);
                span.end(SpanOutcome.succeeded());
                return { kind: "approval-required", invocation: pending, approval };
            }

            if (decision === "reject") {
                const receipt = this.createReceipt(invocation, "denied");
                const denied = await this.recordReceipt(context, invocation, receipt);
                span.end(SpanOutcome.failed("invocation.denied"));
                return { kind: "denied", invocation: denied, receipt };
            }

            return await this.executeOperation(context, invocation, operation, input, span);
        } catch (error) {
            span.end(SpanOutcome.failed("operation.failed"));
            throw error;
        }
    }

    /**
     * The approval continuation (SPEC §7.3): resolve the pending Approval, and when
     * approved, revalidate authority, lease, impact, and the argument digest against
     * the approved digest before executing. Denial produces a denied Receipt; expiry
     * or cancellation produces a cancelled Receipt. Approvals are single-use — the
     * mediator's resolve rejects non-pending Approvals.
     */
    public async resolveApproval(
        context: OperationContext,
        invocation: Invocation,
        approval: Approval,
        resolution: ApprovalResolution,
        input: FacetData
    ): Promise<InvocationPipelineResult> {
        const span = context.start(new ObservedOperation("operation.resolveApproval", []));
        try {
            ensureLease(context);

            if (invocation.status !== "approval-required"
                || !approval.invocationId.equals(invocation.id)
                || invocation.metadata.approvalId === undefined
                || !invocation.metadata.approvalId.equals(approval.id)) {
                throw new AgentCoreError("invocation.invalid", "Approval resolution requires the Invocation's pending Approval");
            }

            const resolved = await this.mediator.resolve(approval, resolution);

            if (resolved.status !== "approved") {
                const status: ReceiptStatus = resolved.status === "denied" ? "denied" : "cancelled";
                const receipt = this.createReceipt(invocation, status);
                const terminal = await this.recordReceipt(context, invocation, receipt);
                span.end(SpanOutcome.failed("approval.declined"));
                return { kind: status === "denied" ? "denied" : "cancelled", invocation: terminal, receipt };
            }

            const operation = this.operations.resolve(invocation.target);
            if (operation === undefined) {
                const receipt = this.createReceipt(invocation, "failed");
                const failed = await this.recordReceipt(context, invocation, receipt);
                span.end(SpanOutcome.failed("operation.missing"));
                return { kind: "failed", invocation: failed, receipt };
            }

            if (!context.permits(operation.authority)) {
                const receipt = this.createReceipt(invocation, "denied");
                const denied = await this.recordReceipt(context, invocation, receipt);
                span.end(SpanOutcome.failed("authority.denied"));
                return { kind: "denied", invocation: denied, receipt };
            }

            if (!this.revalidates(invocation, operation, input)
                || !resolved.operationDigest.equals(digestFacetData(input))) {
                const receipt = this.createReceipt(invocation, "denied");
                const denied = await this.recordReceipt(context, invocation, receipt);
                span.end(SpanOutcome.failed("approval.digest-mismatch"));
                return { kind: "denied", invocation: denied, receipt };
            }

            return await this.executeOperation(context, invocation, operation, input, span);
        } catch (error) {
            span.end(SpanOutcome.failed("operation.failed"));
            throw error;
        }
    }

    private async executeOperation(
        context: OperationContext,
        invocation: Invocation,
        operation: InvokableOperation,
        input: FacetData,
        span: ReturnType<OperationContext["start"]>
    ): Promise<InvocationPipelineResult> {
        const started = invocation.start();
        ensureLease(context);
        await this.recordAudit(context, started, "started");

        let output: FacetData;
        try {
            output = await operation.execute(context, input);
        } catch (error) {
            const receipt = this.createReceipt(started, "failed");
            await this.recordReceipt(context, started, receipt);
            throw error;
        }

        const receipt = this.createReceipt(started, "succeeded");
        ensureLease(context);
        const completed = await this.recordReceipt(context, started, receipt);
        span.end(SpanOutcome.succeeded());

        return { kind: "completed", invocation: completed, receipt, output };
    }

    private revalidates(invocation: Invocation, operation: InvokableOperation, input: FacetData): boolean {
        return invocation.impact === operation.descriptor.impact
            && invocation.argumentDigest.equals(digestFacetData(input));
    }

    private requireWorkspace(invocation: Invocation): WorkspaceId {
        const workspaceId = invocation.metadata.workspaceId;
        if (workspaceId === undefined) {
            throw new AgentCoreError("invocation.invalid", "Approval preparation requires Workspace scope");
        }

        return workspaceId;
    }

    private async recordPrepared(context: OperationContext, invocation: Invocation): Promise<void> {
        await this.recorder.recordPrepared(context, invocation);
        await this.recordAudit(context, invocation, "prepared");
        await this.recordEvent(context, invocation, "prepared", undefined);
    }

    private async recordReceipt(context: OperationContext, invocation: Invocation, receipt: InvocationReceipt): Promise<Invocation> {
        const recorded = await this.mediator.record(invocation, receipt);
        await this.recorder.recordReceipt(context, receipt);
        await this.recordAudit(context, invocation, receipt.status);
        await this.recordEvent(context, invocation, "completed", receipt.status);
        return recorded;
    }

    private createReceipt(invocation: Invocation, status: ReceiptStatus): InvocationReceipt {
        return new InvocationReceipt(this.ids.receiptId(invocation, status), invocation.id, status, undefined);
    }

    private recordAudit(context: OperationContext, invocation: Invocation, kind: AuditRecord["kind"]): Promise<void> {
        return this.recorder.recordAudit(context, new AuditRecord(
            this.ids.auditRecordId(invocation, kind),
            invocation.id,
            context.id,
            kind
        ));
    }

    private recordEvent(context: OperationContext, invocation: Invocation, kind: InvocationEventKind, receiptStatus: ReceiptStatus | undefined): Promise<void> {
        const workspaceId = this.requireWorkspace(invocation);

        return this.recorder.emit(context, new EventRecord(
            this.ids.eventId(invocation, kind),
            workspaceId,
            new EventKind(`invocation.${kind}`),
            invocationEventSource,
            "workspace",
            {
                invocationId: invocation.id.value,
                operationId: context.id.value,
                receiptStatus: receiptStatus ?? null
            },
            undefined,
            new Date(),
            Revision.initial(),
            new EventMetadata(
                "operation",
                invocation.metadata.tenantId,
                undefined,
                undefined,
                invocation.idempotencyKey,
                invocation.id.value
            )
        ));
    }
}

function ensureLease(context: OperationContext): void {
    if (!context.permitsLease()) {
        throw new AgentCoreError("lease.invalid", "Invocation requires the current Run lease");
    }
}

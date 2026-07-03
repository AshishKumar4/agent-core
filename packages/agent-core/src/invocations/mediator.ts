import type { OperationContext } from "../operations";
import type { EventRecord } from "../workspaces/events";
import type { Approval, ApprovalResolution } from "./approval";
import type { AuditRecord } from "./audit";
import type { Invocation } from "./invocation";
import type { InvocationReceipt } from "./receipt";

export type InvocationDecision = "invoke" | "request-approval" | "reject";

export interface InvocationMediator {
    decide(invocation: Invocation): Promise<InvocationDecision>;
    resolve(approval: Approval, resolution: ApprovalResolution): Promise<Approval>;
    record(invocation: Invocation, receipt: InvocationReceipt): Promise<Invocation>;
}

export interface InvocationRecorder {
    recordPrepared(context: OperationContext, invocation: Invocation): Promise<void>;
    recordApproval(context: OperationContext, approval: Approval): Promise<void>;
    recordReceipt(context: OperationContext, receipt: InvocationReceipt): Promise<void>;
    recordAudit(context: OperationContext, record: AuditRecord): Promise<void>;
    emit(context: OperationContext, event: EventRecord): Promise<void>;
}

import type { OperationId } from "../operations/id";
import type { AuditRecordId, InvocationId } from "./id";

export type AuditRecordKind =
    | "discovery"
    | "grant"
    | "binding"
    | "revocation"
    | "delegation"
    | "prepared"
    | "approval-required"
    | "denied"
    | "started"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "indeterminate";

export class AuditRecord {
    public constructor(
        public readonly id: AuditRecordId,
        public readonly invocationId: InvocationId,
        public readonly operationId: OperationId,
        public readonly kind: AuditRecordKind
    ) {
    }
}

import type { OperationContext } from "../operations/context";
import type { AuditRecord } from "../invocations/audit";
export type { AuditRecord, AuditRecordKind } from "../invocations/audit";

export abstract class AuditLog {
    public abstract append(context: OperationContext, record: AuditRecord): void;
}

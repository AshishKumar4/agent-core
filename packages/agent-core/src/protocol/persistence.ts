import type { ActorKind } from "../actors";
import { AgentCoreError } from "../errors";
import type { TenantId } from "../identity";
import {
    AuditRecord,
    AuditRecordCodec,
    type AuditKind,
    type AuditRecordId,
    type AuditRootAdmission,
    type WriteRecordId,
    validateAuditAppend
} from "../invocations";
import type { CommandIdentity, ProtocolPersistence } from "./dispatcher";
import { commandCallersEqual, type CommandCaller } from "./envelope";
import { WriteRecord, WriteRecordCodec, writeReservesIdentity, type CommandOutcome } from "./write";

export type ProtocolCallerProjection =
    | { readonly kind: "principal"; readonly tenantId: TenantId; readonly id: string }
    | { readonly kind: "actor"; readonly actorKind: ActorKind; readonly id: string };

export interface ProtocolIdentityProjection {
    readonly caller: ProtocolCallerProjection;
    readonly idempotencyKey: string;
}

export interface ProtocolWriteIdentityProjection {
    readonly writeId: WriteRecordId;
    readonly identity: ProtocolIdentityProjection;
}

export interface StoredProtocolAudit {
    readonly id: string;
    readonly evidenceKind: AuditKind["kind"];
    readonly writeId?: WriteRecordId;
    readonly writeOutcome?: CommandOutcome;
    readonly bytes: Uint8Array;
}

export interface StoredProtocolWrite {
    readonly id: string;
    readonly auditId: AuditRecordId;
    readonly outcome: CommandOutcome;
    readonly bytes: Uint8Array;
}

export abstract class ProtocolRecordStorage {
    public abstract findAudit(id: string): StoredProtocolAudit | undefined;
    public abstract findWrite(id: string): StoredProtocolWrite | undefined;
    public abstract scanAudits(): readonly StoredProtocolAudit[];
    public abstract scanWrites(): readonly StoredProtocolWrite[];
    public abstract insertAudit(record: StoredProtocolAudit): void;
    public abstract insertWrite(
        record: StoredProtocolWrite,
        identity: ProtocolIdentityProjection | undefined
    ): void;
    public abstract synchronizeIdentityProjection(
        entries: readonly ProtocolWriteIdentityProjection[]
    ): void;
}

export abstract class ProtocolPersistenceAdapter<
    Transaction
> implements ProtocolPersistence<Transaction> {
    protected abstract storage(transaction: Transaction): ProtocolRecordStorage;

    public repair(transaction: Transaction): void {
        const storage = this.storage(transaction);
        storage.synchronizeIdentityProjection(this.validateStoredGraph(storage));
    }

    public findWrite(transaction: Transaction, identity: CommandIdentity): WriteRecord | undefined {
        const storage = this.storage(transaction);
        const originals = this.originalIdentityEntries(storage);
        storage.synchronizeIdentityProjection(originals);
        const projected = projectIdentity(identity);
        const key = identityProjectionKey(projected);
        const match = originals.find((entry) => identityProjectionKey(entry.identity) === key);
        if (match === undefined) return undefined;
        const write = this.loadWrite(storage, match.writeId.value);
        if (write === undefined) {
            throw corruptProtocol("Command identity points to a missing write record");
        }
        this.requireReciprocalAudit(storage, write);
        return write;
    }

    public findWriteById(transaction: Transaction, id: WriteRecordId): WriteRecord | undefined {
        const storage = this.storage(transaction);
        const write = this.loadWrite(storage, id.value);
        if (write !== undefined) {
            this.requireReciprocalAudit(storage, write);
            this.validateStoredDuplicate(storage, write);
        }
        return write;
    }

    public findAudit(transaction: Transaction, id: AuditRecordId): AuditRecord | undefined {
        const storage = this.storage(transaction);
        const audit = this.loadAudit(storage, id.value);
        if (audit?.kind.kind === "write") {
            const write = this.loadWrite(storage, audit.kind.id.value);
            if (write === undefined) {
                throw corruptProtocol("Write audit points to a missing write record");
            }
            validateReciprocalRecords(audit, write);
            this.validateStoredWriteAuditCause(storage, audit);
            this.validateStoredDuplicate(storage, write);
        }
        return audit;
    }

    public appendAudit(
        transaction: Transaction,
        record: AuditRecord,
        admission?: AuditRootAdmission
    ): void {
        const storage = this.storage(transaction);
        const bytes = AuditRecordCodec.encode(record);
        const decoded = AuditRecordCodec.decode(bytes);
        if (storage.findAudit(decoded.id.value) !== undefined) {
            throw corruptProtocol("Audit records are append-only");
        }
        validateAuditAppend(
            decoded,
            {
                get: (id) => this.findAudit(transaction, id)
            },
            admission
        );
        storage.insertAudit(projectAudit(decoded, bytes));
    }

    public appendWrite(transaction: Transaction, record: WriteRecord): void {
        const storage = this.storage(transaction);
        const bytes = WriteRecordCodec.encode(record);
        const decoded = WriteRecordCodec.decode(bytes);
        if (storage.findWrite(decoded.id.value) !== undefined) {
            throw corruptProtocol("Write records are append-only");
        }

        const audit = this.loadAudit(storage, decoded.audit.value);
        if (audit === undefined) {
            throw corruptProtocol("Write audit must exist before append");
        }
        validateReciprocalRecords(audit, decoded);

        const identity = identityForWrite(decoded);
        if (decoded.outcome === "duplicate") {
            this.validateDuplicate(transaction, decoded, identity);
            storage.insertWrite(projectWrite(decoded, bytes), undefined);
            return;
        }

        if (writeReservesIdentity(decoded)) {
            if (identity === undefined) {
                throw corruptProtocol("An original write requires its canonical command identity");
            }
            if (this.findWrite(transaction, identity) !== undefined) {
                throw corruptProtocol("Command identity is already reserved");
            }
        } else if (identity !== undefined) {
            throw corruptProtocol("Unindexable writes cannot contain an idempotency key");
        }

        storage.insertWrite(
            projectWrite(decoded, bytes),
            identity === undefined ? undefined : projectIdentity(identity)
        );
    }

    private validateDuplicate(
        transaction: Transaction,
        duplicate: WriteRecord,
        identity: CommandIdentity | undefined
    ): void {
        if (identity === undefined) {
            throw corruptProtocol("Duplicate writes require their original command identity");
        }
        const original = this.findWrite(transaction, identity);
        if (
            original === undefined ||
            !duplicate.duplicateOf?.equals(original.id) ||
            !duplicate.actor.equals(original.actor) ||
            !bytesEqual(duplicate.reply, original.reply)
        ) {
            throw corruptProtocol("Duplicate write must identify the reserved original write");
        }
    }

    private validateStoredDuplicate(storage: ProtocolRecordStorage, write: WriteRecord): void {
        if (write.outcome !== "duplicate") return;
        const originalId = write.duplicateOf;
        const original =
            originalId === undefined ? undefined : this.loadWrite(storage, originalId.value);
        const originalIdentity = original === undefined ? undefined : identityForWrite(original);
        const duplicateIdentity = identityForWrite(write);
        if (
            original === undefined ||
            !writeReservesIdentity(original) ||
            originalIdentity === undefined ||
            duplicateIdentity === undefined ||
            !identitiesEqual(originalIdentity, duplicateIdentity) ||
            !write.actor.equals(original.actor) ||
            !bytesEqual(write.reply, original.reply)
        ) {
            throw corruptProtocol("Duplicate write does not name a valid original write");
        }
        this.requireReciprocalAudit(storage, original);
    }

    private originalIdentityEntries(
        storage: ProtocolRecordStorage
    ): readonly ProtocolWriteIdentityProjection[] {
        const writes: WriteRecord[] = [];
        for (const stored of storage.scanWrites()) {
            writes.push(this.decodeStoredWrite(stored, stored.id));
        }
        return identityEntries(writes);
    }

    private validateStoredGraph(
        storage: ProtocolRecordStorage
    ): readonly ProtocolWriteIdentityProjection[] {
        const audits = new Map<string, AuditRecord>();
        for (const stored of storage.scanAudits()) {
            if (audits.has(stored.id)) {
                throw corruptProtocol("Stored protocol contains duplicate audit identifiers");
            }
            audits.set(stored.id, this.decodeStoredAudit(stored, stored.id));
        }

        const writes = new Map<string, WriteRecord>();
        for (const stored of storage.scanWrites()) {
            if (writes.has(stored.id)) {
                throw corruptProtocol("Stored protocol contains duplicate write identifiers");
            }
            writes.set(stored.id, this.decodeStoredWrite(stored, stored.id));
        }

        for (const write of writes.values()) {
            const audit = audits.get(write.audit.value);
            if (audit === undefined) {
                throw corruptProtocol("Write record points to a missing audit record");
            }
            validateReciprocalRecords(audit, write);
            validateWriteAuditCause(audit, audits);
            validateDuplicateLineage(write, writes);
        }
        for (const audit of audits.values()) {
            if (audit.kind.kind !== "write") continue;
            const write = writes.get(audit.kind.id.value);
            if (write === undefined) {
                throw corruptProtocol("Write audit points to a missing write record");
            }
            validateReciprocalRecords(audit, write);
            validateWriteAuditCause(audit, audits);
        }

        return identityEntries(writes.values());
    }

    private loadAudit(storage: ProtocolRecordStorage, id: string): AuditRecord | undefined {
        const stored = storage.findAudit(id);
        return stored === undefined ? undefined : this.decodeStoredAudit(stored, id);
    }

    private decodeStoredAudit(stored: StoredProtocolAudit, id: string): AuditRecord {
        const record = AuditRecordCodec.decode(copyBytes(stored.bytes, "audit"));
        const projection = projectAudit(record, stored.bytes);
        if (
            stored.id !== id ||
            stored.id !== projection.id ||
            stored.evidenceKind !== projection.evidenceKind ||
            !optionalWriteIdsEqual(stored.writeId, projection.writeId) ||
            stored.writeOutcome !== projection.writeOutcome
        ) {
            throw corruptRecord("Stored audit key or projection does not match its codec bytes");
        }
        return record;
    }

    private loadWrite(storage: ProtocolRecordStorage, id: string): WriteRecord | undefined {
        const stored = storage.findWrite(id);
        return stored === undefined ? undefined : this.decodeStoredWrite(stored, id);
    }

    private decodeStoredWrite(stored: StoredProtocolWrite, id: string): WriteRecord {
        const record = WriteRecordCodec.decode(copyBytes(stored.bytes, "write"));
        const projection = projectWrite(record, stored.bytes);
        if (
            stored.id !== id ||
            stored.id !== projection.id ||
            !stored.auditId.equals(projection.auditId) ||
            stored.outcome !== projection.outcome
        ) {
            throw corruptRecord("Stored write key or projection does not match its codec bytes");
        }
        return record;
    }

    private requireReciprocalAudit(
        storage: ProtocolRecordStorage,
        write: WriteRecord
    ): AuditRecord {
        const audit = this.loadAudit(storage, write.audit.value);
        if (audit === undefined) {
            throw corruptProtocol("Write record points to a missing audit record");
        }
        validateReciprocalRecords(audit, write);
        this.validateStoredWriteAuditCause(storage, audit);
        return audit;
    }

    private validateStoredWriteAuditCause(
        storage: ProtocolRecordStorage,
        audit: AuditRecord
    ): void {
        if (audit.kind.kind !== "write") {
            throw corruptProtocol("Write audit evidence kind is invalid");
        }
        if (audit.cause === undefined) {
            if (!audit.kind.outcome.startsWith("rejected")) {
                throw corruptProtocol("Only rejected writes may have a cause-free audit root");
            }
            return;
        }
        const cause = this.loadAudit(storage, audit.cause.value);
        if (
            cause === undefined ||
            cause.kind.kind !== "invocation" ||
            cause.cause !== undefined ||
            !cause.actor.equals(audit.actor) ||
            !cause.tenant.equals(audit.tenant) ||
            !cause.correlation.equals(audit.correlation)
        ) {
            throw corruptProtocol("Write audit cause is not a matching local Invocation root");
        }
    }
}

export function protocolIdentityProjection(identity: CommandIdentity): ProtocolIdentityProjection {
    return projectIdentity(identity);
}

export function protocolIdentityProjectionsEqual(
    left: ProtocolIdentityProjection,
    right: ProtocolIdentityProjection
): boolean {
    return (
        left.idempotencyKey === right.idempotencyKey &&
        left.caller.kind === right.caller.kind &&
        left.caller.id === right.caller.id &&
        (left.caller.kind !== "principal" ||
            (right.caller.kind === "principal" &&
                left.caller.tenantId.equals(right.caller.tenantId))) &&
        (left.caller.kind !== "actor" ||
            (right.caller.kind === "actor" && left.caller.actorKind === right.caller.actorKind))
    );
}

function identityEntries(
    writes: Iterable<WriteRecord>
): readonly ProtocolWriteIdentityProjection[] {
    const entries: ProtocolWriteIdentityProjection[] = [];
    const identities = new Map<string, string>();
    for (const write of writes) {
        if (!writeReservesIdentity(write)) continue;
        const identity = identityForWrite(write);
        if (identity === undefined) {
            throw corruptProtocol("An original write is missing its canonical command identity");
        }
        const projected = projectIdentity(identity);
        const key = identityProjectionKey(projected);
        if (identities.has(key)) {
            throw corruptProtocol("Conflicting original writes reserve one command identity");
        }
        identities.set(key, write.id.value);
        entries.push({ writeId: write.id, identity: projected });
    }
    return entries;
}

function identityProjectionKey(identity: ProtocolIdentityProjection): string {
    return JSON.stringify(
        identity.caller.kind === "principal"
            ? [
                  identity.caller.kind,
                  identity.caller.tenantId.value,
                  identity.caller.id,
                  identity.idempotencyKey
              ]
            : [
                  identity.caller.kind,
                  identity.caller.actorKind,
                  identity.caller.id,
                  identity.idempotencyKey
              ]
    );
}

function validateWriteAuditCause(
    audit: AuditRecord,
    audits: ReadonlyMap<string, AuditRecord>
): void {
    if (audit.kind.kind !== "write") {
        throw corruptProtocol("Write audit evidence kind is invalid");
    }
    if (audit.cause === undefined) {
        if (!audit.kind.outcome.startsWith("rejected")) {
            throw corruptProtocol("Only rejected writes may have a cause-free audit root");
        }
        return;
    }
    const cause = audits.get(audit.cause.value);
    if (
        cause === undefined ||
        cause.kind.kind !== "invocation" ||
        cause.cause !== undefined ||
        !cause.actor.equals(audit.actor) ||
        !cause.tenant.equals(audit.tenant) ||
        !cause.correlation.equals(audit.correlation)
    ) {
        throw corruptProtocol("Write audit cause is not a matching local Invocation root");
    }
}

function validateDuplicateLineage(
    write: WriteRecord,
    writes: ReadonlyMap<string, WriteRecord>
): void {
    if (write.outcome !== "duplicate") return;
    const original =
        write.duplicateOf === undefined ? undefined : writes.get(write.duplicateOf.value);
    const originalIdentity = original === undefined ? undefined : identityForWrite(original);
    const duplicateIdentity = identityForWrite(write);
    if (
        original === undefined ||
        !writeReservesIdentity(original) ||
        originalIdentity === undefined ||
        duplicateIdentity === undefined ||
        !identitiesEqual(originalIdentity, duplicateIdentity) ||
        !write.actor.equals(original.actor) ||
        !bytesEqual(write.reply, original.reply)
    ) {
        throw corruptProtocol("Duplicate write does not name a valid original write");
    }
}

function projectIdentity(identity: CommandIdentity): ProtocolIdentityProjection {
    return {
        caller: projectCaller(identity.caller),
        idempotencyKey: identity.idempotencyKey
    };
}

function projectCaller(caller: CommandCaller): ProtocolCallerProjection {
    return caller.kind === "principal"
        ? {
              kind: caller.kind,
              tenantId: caller.principal.tenantId,
              id: caller.principal.principalId.value
          }
        : { kind: caller.kind, actorKind: caller.actor.kind, id: caller.actor.id.value };
}

function projectAudit(record: AuditRecord, bytes: Uint8Array): StoredProtocolAudit {
    return record.kind.kind === "write"
        ? {
              id: record.id.value,
              evidenceKind: record.kind.kind,
              writeId: record.kind.id,
              writeOutcome: record.kind.outcome,
              bytes: bytes.slice()
          }
        : { id: record.id.value, evidenceKind: record.kind.kind, bytes: bytes.slice() };
}

function projectWrite(record: WriteRecord, bytes: Uint8Array): StoredProtocolWrite {
    return {
        id: record.id.value,
        auditId: record.audit,
        outcome: record.outcome,
        bytes: bytes.slice()
    };
}

function identityForWrite(write: WriteRecord): CommandIdentity | undefined {
    return write.caller === undefined || write.idempotencyKey === undefined
        ? undefined
        : { caller: write.caller, idempotencyKey: write.idempotencyKey };
}

function identitiesEqual(left: CommandIdentity, right: CommandIdentity): boolean {
    return (
        left.idempotencyKey === right.idempotencyKey &&
        commandCallersEqual(left.caller, right.caller)
    );
}

function validateReciprocalRecords(audit: AuditRecord, write: WriteRecord): void {
    if (
        audit.kind.kind !== "write" ||
        !audit.kind.id.equals(write.id) ||
        audit.kind.outcome !== write.outcome ||
        !write.audit.equals(audit.id) ||
        !write.actor.equals(audit.actor)
    ) {
        throw corruptProtocol("Write record and audit record are not reciprocal");
    }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function optionalWriteIdsEqual(
    left: WriteRecordId | undefined,
    right: WriteRecordId | undefined
): boolean {
    return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function copyBytes(value: Uint8Array, record: string): Uint8Array {
    if (!(value instanceof Uint8Array)) {
        throw corruptRecord(`Stored ${record} bytes are malformed`);
    }
    return value.slice();
}

function corruptRecord(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function corruptProtocol(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

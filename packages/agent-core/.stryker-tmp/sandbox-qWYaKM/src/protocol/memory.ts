// @ts-nocheck
import { ACTOR_STATE_SNAPSHOT, type ActorCloneOwnedState } from "../actors";
import { AgentCoreError } from "../errors";
import { AuditRecordId, WriteRecordId } from "../invocations";
import {
    ProtocolPersistenceAdapter,
    ProtocolRecordStorage,
    type ProtocolIdentityProjection,
    type ProtocolWriteIdentityProjection,
    type StoredProtocolAudit,
    type StoredProtocolWrite
} from "./persistence";
import { WriteRecordCodec, writeReservesIdentity } from "./write";

export interface MemoryProtocolSnapshot {
    readonly audits: readonly StoredProtocolAudit[];
    readonly writes: readonly StoredProtocolWrite[];
    readonly identities: readonly ProtocolWriteIdentityProjection[];
}

export class MemoryProtocolRecords extends ProtocolRecordStorage implements ActorCloneOwnedState {
    readonly #audits = new Map<string, StoredProtocolAudit>();
    readonly #writes = new Map<string, StoredProtocolWrite>();

    public constructor(snapshot?: MemoryProtocolSnapshot) {
        super();
        if (
            snapshot !== undefined &&
            (snapshot === null ||
                typeof snapshot !== "object" ||
                !Array.isArray(snapshot.audits) ||
                !Array.isArray(snapshot.writes))
        ) {
            throw corruptSnapshot("Memory protocol snapshot is malformed");
        }
        for (const audit of snapshot?.audits ?? []) {
            const stored = copyAudit(audit);
            if (this.#audits.has(stored.id)) {
                throw corruptSnapshot("Memory protocol snapshot contains duplicate audit records");
            }
            this.#audits.set(stored.id, stored);
        }
        for (const write of snapshot?.writes ?? []) {
            const stored = copyWrite(write);
            if (this.#writes.has(stored.id)) {
                throw corruptSnapshot("Memory protocol snapshot contains duplicate write records");
            }
            this.#writes.set(stored.id, stored);
        }
        Object.freeze(this);
    }

    public findAudit(id: string): StoredProtocolAudit | undefined {
        const record = this.#audits.get(id);
        return record === undefined ? undefined : copyAudit(record);
    }

    public findWrite(id: string): StoredProtocolWrite | undefined {
        const record = this.#writes.get(id);
        return record === undefined ? undefined : copyWrite(record);
    }

    public scanAudits(): readonly StoredProtocolAudit[] {
        return [...this.#audits.values()].map(copyAudit);
    }

    public scanWrites(): readonly StoredProtocolWrite[] {
        return [...this.#writes.values()].map(copyWrite);
    }

    public insertAudit(record: StoredProtocolAudit): void {
        const stored = copyAudit(record);
        if (this.#audits.has(stored.id)) {
            throw invalidProtocolState("Audit records are append-only");
        }
        this.#audits.set(stored.id, stored);
    }

    public insertWrite(
        record: StoredProtocolWrite,
        _identity: ProtocolIdentityProjection | undefined
    ): void {
        const stored = copyWrite(record);
        if (this.#writes.has(stored.id)) {
            throw invalidProtocolState("Write records are append-only");
        }
        this.#writes.set(stored.id, stored);
    }

    public synchronizeIdentityProjection(
        _entries: readonly ProtocolWriteIdentityProjection[]
    ): void {}

    public clone(): MemoryProtocolRecords {
        return new MemoryProtocolRecords(this.snapshot());
    }

    public snapshot(): MemoryProtocolSnapshot {
        const writes = [...this.#writes.values()].map(copyWrite);
        return {
            audits: [...this.#audits.values()].map(copyAudit),
            writes,
            identities: derivedIdentities(writes)
        };
    }

    public [ACTOR_STATE_SNAPSHOT](): MemoryProtocolSnapshot {
        return this.snapshot();
    }
}

export class MemoryProtocolPersistence<
    Transaction
> extends ProtocolPersistenceAdapter<Transaction> {
    public constructor(
        private readonly records: (transaction: Transaction) => MemoryProtocolRecords
    ) {
        super();
    }

    protected storage(transaction: Transaction): ProtocolRecordStorage {
        return this.records(transaction);
    }
}

function derivedIdentities(
    writes: readonly StoredProtocolWrite[]
): readonly ProtocolWriteIdentityProjection[] {
    return writes.flatMap((stored) => {
        const write = WriteRecordCodec.decode(stored.bytes);
        if (
            !writeReservesIdentity(write) ||
            write.caller === undefined ||
            write.idempotencyKey === undefined
        )
            return [];
        return [
            {
                writeId: write.id,
                identity: {
                    caller:
                        write.caller.kind === "principal"
                            ? {
                                  kind: write.caller.kind,
                                  tenantId: write.caller.principal.tenantId,
                                  id: write.caller.principal.principalId.value
                              }
                            : {
                                  kind: write.caller.kind,
                                  actorKind: write.caller.actor.kind,
                                  id: write.caller.actor.id.value
                              },
                    idempotencyKey: write.idempotencyKey
                }
            }
        ];
    });
}

function copyAudit(record: StoredProtocolAudit): StoredProtocolAudit {
    if (
        record === null ||
        typeof record !== "object" ||
        typeof record.id !== "string" ||
        typeof record.evidenceKind !== "string" ||
        (record.writeId !== undefined && !(record.writeId instanceof WriteRecordId)) ||
        (record.writeOutcome !== undefined && typeof record.writeOutcome !== "string") ||
        !(record.bytes instanceof Uint8Array)
    ) {
        throw corruptSnapshot("Memory protocol snapshot contains a malformed audit record");
    }
    return {
        id: record.id,
        evidenceKind: record.evidenceKind,
        ...(record.writeId === undefined
            ? {}
            : { writeId: new WriteRecordId(record.writeId.value) }),
        ...(record.writeOutcome === undefined ? {} : { writeOutcome: record.writeOutcome }),
        bytes: record.bytes.slice()
    };
}

function copyWrite(record: StoredProtocolWrite): StoredProtocolWrite {
    if (
        record === null ||
        typeof record !== "object" ||
        typeof record.id !== "string" ||
        !(record.auditId instanceof AuditRecordId) ||
        typeof record.outcome !== "string" ||
        !(record.bytes instanceof Uint8Array)
    ) {
        throw corruptSnapshot("Memory protocol snapshot contains a malformed write record");
    }
    return {
        id: record.id,
        auditId: new AuditRecordId(record.auditId.value),
        outcome: record.outcome,
        bytes: record.bytes.slice()
    };
}

function corruptSnapshot(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidProtocolState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

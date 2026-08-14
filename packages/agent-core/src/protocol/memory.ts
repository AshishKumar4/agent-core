import { ACTOR_STATE_SNAPSHOT, type ActorCloneOwnedState } from "../actors";
import { isObjectRecord, jsonDataParser } from "../core";
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
    readonly #auditsByEvidence = new Map<string, string>();
    readonly #writes = new Map<string, StoredProtocolWrite>();

    public constructor(snapshot?: MemoryProtocolSnapshot) {
        super();
        if (
            snapshot !== undefined &&
            (!isObjectRecord(snapshot) ||
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
            if (this.#auditsByEvidence.has(stored.evidenceIdentity)) {
                throw corruptSnapshot(
                    "Memory protocol snapshot contains duplicate audit evidence relations"
                );
            }
            this.#audits.set(stored.id, stored);
            this.#auditsByEvidence.set(stored.evidenceIdentity, stored.id);
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

    public findAuditByEvidence(identity: string): StoredProtocolAudit | undefined {
        const id = this.#auditsByEvidence.get(identity);
        if (id === undefined) return undefined;
        const record = this.#audits.get(id);
        if (record === undefined) {
            throw corruptSnapshot("Memory protocol audit evidence points to a missing record");
        }
        return copyAudit(record);
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
        if (this.#auditsByEvidence.has(stored.evidenceIdentity)) {
            throw invalidProtocolState("Audit evidence relation is append-only");
        }
        this.#audits.set(stored.id, stored);
        this.#auditsByEvidence.set(stored.evidenceIdentity, stored.id);
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

type StoredAuditDraft = {
    -readonly [Key in keyof StoredProtocolAudit]: StoredProtocolAudit[Key];
};

const parseAuditSnapshot = jsonDataParser(() =>
    corruptSnapshot("Memory protocol snapshot contains a malformed audit record")
);
const parseWriteSnapshot = jsonDataParser(() =>
    corruptSnapshot("Memory protocol snapshot contains a malformed write record")
);

function copyAudit(record: StoredProtocolAudit): StoredProtocolAudit {
    if (!isObjectRecord(record) || !(record.bytes instanceof Uint8Array)) {
        throw corruptSnapshot("Memory protocol snapshot contains a malformed audit record");
    }
    parseAuditSnapshot.string(record.id, "id");
    parseAuditSnapshot.string(record.evidenceIdentity, "evidenceIdentity");
    parseAuditSnapshot.string(record.evidenceKind, "evidenceKind");
    const writeId = record.writeId;
    if (writeId !== undefined && !(writeId instanceof WriteRecordId)) {
        throw corruptSnapshot("Memory protocol snapshot contains a malformed audit record");
    }
    const writeOutcome = record.writeOutcome;
    if (writeOutcome !== undefined) {
        parseAuditSnapshot.string(writeOutcome, "writeOutcome");
    }
    const copied: StoredAuditDraft = {
        id: record.id,
        evidenceIdentity: record.evidenceIdentity,
        evidenceKind: record.evidenceKind,
        bytes: record.bytes.slice()
    };
    if (writeId !== undefined) {
        copied.writeId = new WriteRecordId(writeId.value);
    }
    if (writeOutcome !== undefined) {
        copied.writeOutcome = writeOutcome;
    }
    return copied;
}

function copyWrite(record: StoredProtocolWrite): StoredProtocolWrite {
    if (
        !isObjectRecord(record) ||
        !(record.auditId instanceof AuditRecordId) ||
        !(record.bytes instanceof Uint8Array)
    ) {
        throw corruptSnapshot("Memory protocol snapshot contains a malformed write record");
    }
    parseWriteSnapshot.string(record.id, "id");
    parseWriteSnapshot.string(record.outcome, "outcome");
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

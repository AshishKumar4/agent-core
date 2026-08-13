import { expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest } from "../../src/core";
import { TenantId } from "../../src/identity";
import {
    AuditRecord,
    AuditRecordCodec,
    AuditRecordId,
    CorrelationId,
    InvocationId,
    RouteReservationId,
    WriteRecordId,
    auditEvidenceIdentity
} from "../../src/invocations";
import {
    MemoryProtocolRecords,
    ProtocolPersistenceAdapter,
    ProtocolRecordStorage,
    WriteRecord,
    WriteRecordCodec,
    protocolIdentityProjectionsEqual,
    type ProtocolIdentityProjection,
    type ProtocolWriteIdentityProjection,
    type StoredProtocolAudit,
    type StoredProtocolWrite,
    type WriteRecordInit
} from "../../src/protocol";
import { expectAgentCoreError } from "./error-assertion";
import { appendProtocolTestRecords, protocolTestRecords } from "./persistence-contract";

class StoragePersistence extends ProtocolPersistenceAdapter<ProtocolRecordStorage> {
    protected storage(transaction: ProtocolRecordStorage): ProtocolRecordStorage {
        return transaction;
    }
}

class FacadeStorage extends ProtocolRecordStorage {
    public constructor(protected readonly base: ProtocolRecordStorage) {
        super();
    }

    public findAudit(id: string): StoredProtocolAudit | undefined {
        return this.base.findAudit(id);
    }

    public findAuditByEvidence(identity: string): StoredProtocolAudit | undefined {
        return this.base.findAuditByEvidence(identity);
    }

    public findWrite(id: string): StoredProtocolWrite | undefined {
        return this.base.findWrite(id);
    }

    public scanAudits(): readonly StoredProtocolAudit[] {
        return this.base.scanAudits();
    }

    public scanWrites(): readonly StoredProtocolWrite[] {
        return this.base.scanWrites();
    }

    public insertAudit(record: StoredProtocolAudit): void {
        this.base.insertAudit(record);
    }

    public insertWrite(
        record: StoredProtocolWrite,
        identity: ProtocolIdentityProjection | undefined
    ): void {
        this.base.insertWrite(record, identity);
    }

    public synchronizeIdentityProjection(
        entries: readonly ProtocolWriteIdentityProjection[]
    ): void {
        this.base.synchronizeIdentityProjection(entries);
    }
}

class UncheckedStorage extends ProtocolRecordStorage {
    readonly #audits = new Map<string, StoredProtocolAudit>();
    readonly #auditsByEvidence = new Map<string, string>();
    readonly #writes = new Map<string, StoredProtocolWrite>();

    public findAudit(id: string): StoredProtocolAudit | undefined {
        return this.#audits.get(id);
    }

    public findAuditByEvidence(identity: string): StoredProtocolAudit | undefined {
        const id = this.#auditsByEvidence.get(identity);
        return id === undefined ? undefined : this.#audits.get(id);
    }

    public findWrite(id: string): StoredProtocolWrite | undefined {
        return this.#writes.get(id);
    }

    public scanAudits(): readonly StoredProtocolAudit[] {
        return [...this.#audits.values()];
    }

    public scanWrites(): readonly StoredProtocolWrite[] {
        return [...this.#writes.values()];
    }

    public insertAudit(record: StoredProtocolAudit): void {
        this.#audits.set(record.id, record);
        this.#auditsByEvidence.set(record.evidenceIdentity, record.id);
    }

    public insertWrite(
        record: StoredProtocolWrite,
        _identity: ProtocolIdentityProjection | undefined
    ): void {
        this.#writes.set(record.id, record);
    }

    public synchronizeIdentityProjection(
        _entries: readonly ProtocolWriteIdentityProjection[]
    ): void {}
}

const adapterTenant = new TenantId("adapter-tenant");
const adapterActor = new ActorRef("run", new ActorId("adapter-actor"));

test("identity lookup fails closed when the indexed write record is missing", { tags: "p0" }, () => {
    const records = new MemoryProtocolRecords();
    const persistence = new StoragePersistence();
    const expected = protocolTestRecords("adapter-missing-write");
    appendProtocolTestRecords(persistence, records, expected);
    const facade = new (class extends FacadeStorage {
        public override findWrite(id: string): StoredProtocolWrite | undefined {
            return id === expected.write.id.value ? undefined : super.findWrite(id);
        }
    })(records);

    expectAgentCoreError(
        () => persistence.findWrite(facade, expected.identity),
        "protocol.invalid-state"
    );
    expect(() => persistence.findWrite(facade, expected.identity)).toThrow(
        "Command identity points to a missing write record"
    );
});

test("audit evidence lookup fails closed on a mismatched stored projection", { tags: "p1" }, () => {
    const records = new MemoryProtocolRecords();
    const persistence = new StoragePersistence();
    const expected = protocolTestRecords("adapter-evidence-mismatch");
    appendProtocolTestRecords(persistence, records, expected);
    const facade = new (class extends FacadeStorage {
        public override findAuditByEvidence(_identity: string): StoredProtocolAudit | undefined {
            return super.findAudit(expected.audit.id.value);
        }
    })(records);

    const lookup = () =>
        persistence.findAuditByEvidence(facade, expected.root.actor, expected.root.kind);
    expectAgentCoreError(lookup, "codec.invalid");
    expect(lookup).toThrow("Stored audit evidence lookup returned a mismatched projection");
});

test("append-only and reservation guards throw exact protocol diagnostics", { tags: "p0" }, () => {
    const persistence = new StoragePersistence();

    const appendOnly = new MemoryProtocolRecords();
    const first = protocolTestRecords("adapter-append-only");
    appendProtocolTestRecords(persistence, appendOnly, first);
    const reappendAudit = (): void => persistence.appendAudit(appendOnly, first.root);
    expectAgentCoreError(reappendAudit, "protocol.invalid-state");
    expect(reappendAudit).toThrow("Audit records are append-only");

    const missingAudit = new MemoryProtocolRecords();
    const unappended = protocolTestRecords("adapter-missing-audit");
    const appendWithoutAudit = (): void => persistence.appendWrite(missingAudit, unappended.write);
    expectAgentCoreError(appendWithoutAudit, "protocol.invalid-state");
    expect(appendWithoutAudit).toThrow("Write audit must exist before append");

    const reserved = new MemoryProtocolRecords();
    const original = protocolTestRecords("adapter-reserved-original");
    const replacement = protocolTestRecords("adapter-reserved-replacement", undefined, {
        key: original.identity.idempotencyKey
    });
    appendProtocolTestRecords(persistence, reserved, original);
    const replaceIdentity = (): void => {
        persistence.appendAudit(reserved, replacement.root);
        persistence.appendAudit(reserved, replacement.audit);
        persistence.appendWrite(reserved, replacement.write);
    };
    expect(replaceIdentity).toThrow("Command identity is already reserved");

    const unchecked = new UncheckedStorage();
    const stored = protocolTestRecords("adapter-unchecked");
    appendProtocolTestRecords(persistence, unchecked, stored);
    const reappendWrite = (): void => persistence.appendWrite(unchecked, stored.write);
    expectAgentCoreError(reappendWrite, "protocol.invalid-state");
    expect(reappendWrite).toThrow("Write records are append-only");
});

test("duplicate appends must name the reserved original write exactly", { tags: "p0" }, () => {
    const persistence = new StoragePersistence();
    const records = new MemoryProtocolRecords();
    const original = protocolTestRecords("adapter-duplicate-original");
    appendProtocolTestRecords(persistence, records, original);

    const wrongOriginal = protocolTestRecords("adapter-duplicate-wrong", undefined, {
        outcome: "duplicate",
        duplicateOf: new WriteRecordId("adapter-not-the-original"),
        key: original.identity.idempotencyKey,
        reply: original.write.reply
    });
    expect(() => {
        persistence.appendAudit(records, wrongOriginal.root);
        persistence.appendAudit(records, wrongOriginal.audit);
        persistence.appendWrite(records, wrongOriginal.write);
    }).toThrow("Duplicate write must identify the reserved original write");

    const originalReply = original.write.reply;
    const sameLengthReply = originalReply.slice();
    sameLengthReply[0] = (sameLengthReply[0] ?? 0) ^ 0xff;
    const differingReplies = [sameLengthReply, originalReply.slice(0, originalReply.byteLength - 1)];
    for (const [index, reply] of differingReplies.entries()) {
        const mismatch = protocolTestRecords(`adapter-duplicate-reply-${index}`, undefined, {
            outcome: "duplicate",
            duplicateOf: original.write.id,
            key: original.identity.idempotencyKey,
            reply
        });
        expect(() => {
            persistence.appendAudit(records, mismatch.root);
            persistence.appendAudit(records, mismatch.audit);
            persistence.appendWrite(records, mismatch.write);
        }).toThrow("Duplicate write must identify the reserved original write");
    }
});

test("stored duplicate reads fail closed when the original write is missing", { tags: "p1" }, () => {
    const persistence = new StoragePersistence();
    const records = new MemoryProtocolRecords();
    const original = protocolTestRecords("adapter-lineage-original");
    const duplicate = protocolTestRecords("adapter-lineage-duplicate", undefined, {
        outcome: "duplicate",
        duplicateOf: original.write.id,
        key: original.identity.idempotencyKey,
        reply: original.write.reply
    });
    appendProtocolTestRecords(persistence, records, original);
    appendProtocolTestRecords(persistence, records, duplicate);
    const snapshot = records.snapshot();
    const restored = new MemoryProtocolRecords({
        ...snapshot,
        writes: snapshot.writes.filter((write) => write.id !== original.write.id.value)
    });

    const read = () => persistence.findWriteById(restored, duplicate.write.id);
    expectAgentCoreError(read, "protocol.invalid-state");
    expect(read).toThrow("Duplicate write does not name a valid original write");
});

test("repair accepts duplicates and cause-free rejected writes", { tags: "p1" }, () => {
    const persistence = new StoragePersistence();
    const records = new MemoryProtocolRecords();
    const original = protocolTestRecords("adapter-repair-original");
    const duplicate = protocolTestRecords("adapter-repair-duplicate", undefined, {
        outcome: "duplicate",
        duplicateOf: original.write.id,
        key: original.identity.idempotencyKey,
        reply: original.write.reply
    });
    appendProtocolTestRecords(persistence, records, original);
    appendProtocolTestRecords(persistence, records, duplicate);
    const rejected = causeFreeWriteRecords("adapter-repair-rejected", "rejectedMalformed");
    const snapshot = records.snapshot();
    const restored = new MemoryProtocolRecords({
        audits: [...snapshot.audits, storedAudit(rejected.audit)],
        writes: [...snapshot.writes, storedWrite(rejected.write)],
        identities: snapshot.identities
    });

    expect(() => persistence.repair(restored)).not.toThrow();
    expect(persistence.findWriteById(restored, duplicate.write.id)?.outcome).toBe("duplicate");
    expect(persistence.findWriteById(restored, rejected.write.id)?.outcome).toBe(
        "rejectedMalformed"
    );
});

test("committed write audits require a cause on read and repair", { tags: "p1" }, () => {
    const persistence = new StoragePersistence();
    const committed = causeFreeWriteRecords("adapter-causeless-committed", "committed");
    const records = new MemoryProtocolRecords({
        audits: [storedAudit(committed.audit)],
        writes: [storedWrite(committed.write)],
        identities: []
    });

    const read = () => persistence.findWriteById(records, committed.write.id);
    expectAgentCoreError(read, "protocol.invalid-state");
    expect(read).toThrow("Only rejected writes may have a cause-free audit root");
    expect(() => persistence.repair(records)).toThrow("Stored audit graph is invalid");
});

test("write audit cause mismatches carry the exact diagnostic", { tags: "p1" }, () => {
    const persistence = new StoragePersistence();
    const records = new MemoryProtocolRecords();
    const expected = protocolTestRecords("adapter-cause-mismatch");
    appendProtocolTestRecords(persistence, records, expected);
    const snapshot = records.snapshot();
    const alteredRoot = new AuditRecord({
        id: expected.root.id,
        actor: expected.root.actor,
        tenant: expected.root.tenant,
        correlation: new CorrelationId("adapter-cause-altered"),
        kind: expected.root.kind
    });
    const restored = new MemoryProtocolRecords({
        ...snapshot,
        audits: snapshot.audits.map((audit) =>
            audit.id === expected.root.id.value ? storedAudit(alteredRoot) : audit
        )
    });

    expect(() => persistence.findWriteById(restored, expected.write.id)).toThrow(
        "Write audit cause is not a matching local Invocation root"
    );
});

test("stored record key aliasing fails closed for audits and writes", { tags: "p1" }, () => {
    const records = new MemoryProtocolRecords();
    const persistence = new StoragePersistence();
    const expected = protocolTestRecords("adapter-alias");
    appendProtocolTestRecords(persistence, records, expected);

    const auditAlias = new (class extends FacadeStorage {
        public override findAudit(id: string): StoredProtocolAudit | undefined {
            return id === expected.root.id.value
                ? super.findAudit(expected.audit.id.value)
                : super.findAudit(id);
        }
    })(records);
    const readAlias = () => persistence.findAudit(auditAlias, expected.root.id);
    expectAgentCoreError(readAlias, "codec.invalid");
    expect(readAlias).toThrow("Stored audit key or projection does not match its codec bytes");

    const second = protocolTestRecords("adapter-alias-second");
    appendProtocolTestRecords(persistence, records, second);
    const writeAlias = new (class extends FacadeStorage {
        public override findWrite(id: string): StoredProtocolWrite | undefined {
            return id === expected.write.id.value
                ? super.findWrite(second.write.id.value)
                : super.findWrite(id);
        }
    })(records);
    expect(() => persistence.findWriteById(writeAlias, expected.write.id)).toThrow(
        "Stored write key or projection does not match its codec bytes"
    );

    const writeProjectionAlias = new (class extends FacadeStorage {
        public override findWrite(id: string): StoredProtocolWrite | undefined {
            if (id !== expected.write.id.value) return super.findWrite(id);
            const other = super.findWrite(second.write.id.value);
            return other === undefined ? undefined : { ...other, id };
        }
    })(records);
    expect(() => persistence.findWriteById(writeProjectionAlias, expected.write.id)).toThrow(
        "Stored write key or projection does not match its codec bytes"
    );
});

test("stored byte containers must be genuine byte arrays", { tags: "p2" }, () => {
    const records = new MemoryProtocolRecords();
    const persistence = new StoragePersistence();
    const expected = protocolTestRecords("adapter-bytes");
    appendProtocolTestRecords(persistence, records, expected);
    const nonBytes = forgedBytes("not bytes");

    const corruptAudit = new (class extends FacadeStorage {
        public override findAudit(id: string): StoredProtocolAudit | undefined {
            const stored = super.findAudit(id);
            return stored === undefined ? undefined : { ...stored, bytes: nonBytes };
        }
    })(records);
    const readAudit = () => persistence.findAudit(corruptAudit, expected.root.id);
    expectAgentCoreError(readAudit, "codec.invalid");
    expect(readAudit).toThrow("Stored audit bytes are malformed");

    const corruptWrite = new (class extends FacadeStorage {
        public override findWrite(id: string): StoredProtocolWrite | undefined {
            const stored = super.findWrite(id);
            return stored === undefined ? undefined : { ...stored, bytes: nonBytes };
        }
    })(records);
    expect(() => persistence.findWriteById(corruptWrite, expected.write.id)).toThrow(
        "Stored write bytes are malformed"
    );
});

test("repair fails closed on duplicated stored identifiers and relations", { tags: "p1" }, () => {
    const persistence = new StoragePersistence();

    const duplicateAudits = new MemoryProtocolRecords();
    const first = protocolTestRecords("adapter-scan-duplicate");
    appendProtocolTestRecords(persistence, duplicateAudits, first);
    const duplicatedAuditScan = new (class extends FacadeStorage {
        public override scanAudits(): readonly StoredProtocolAudit[] {
            const audits = super.scanAudits();
            return [...audits, ...audits.slice(0, 1)];
        }
    })(duplicateAudits);
    expect(() => persistence.repair(duplicatedAuditScan)).toThrow(
        "Stored protocol contains duplicate audit identifiers"
    );

    const duplicatedEvidence = new UncheckedStorage();
    const invocation = new InvocationId("adapter-shared-invocation");
    for (const id of ["adapter-evidence-a", "adapter-evidence-b"]) {
        duplicatedEvidence.insertAudit(
            storedAudit(
                new AuditRecord({
                    id: new AuditRecordId(id),
                    actor: adapterActor,
                    tenant: adapterTenant,
                    correlation: new CorrelationId(id),
                    kind: { kind: "invocation", id: invocation }
                })
            )
        );
    }
    expect(() => persistence.repair(duplicatedEvidence)).toThrow(
        "Stored protocol contains duplicate audit evidence relations"
    );

    const duplicatedWriteScan = new (class extends FacadeStorage {
        public override scanWrites(): readonly StoredProtocolWrite[] {
            const writes = super.scanWrites();
            return [...writes, ...writes.slice(0, 1)];
        }
    })(duplicateAudits);
    expect(() => persistence.repair(duplicatedWriteScan)).toThrow(
        "Stored protocol contains duplicate write identifiers"
    );
});

test("missing reciprocal records carry exact diagnostics", { tags: "p1" }, () => {
    const persistence = new StoragePersistence();
    const records = new MemoryProtocolRecords();
    const expected = protocolTestRecords("adapter-reciprocal");
    appendProtocolTestRecords(persistence, records, expected);
    const snapshot = records.snapshot();

    const missingAudit = new MemoryProtocolRecords({
        ...snapshot,
        audits: snapshot.audits.filter((audit) => audit.id !== expected.audit.id.value)
    });
    expect(() => persistence.repair(missingAudit)).toThrow(
        "Write record points to a missing audit record"
    );
    expect(() => persistence.findWriteById(missingAudit, expected.write.id)).toThrow(
        "Write record points to a missing audit record"
    );

    const missingWrite = new MemoryProtocolRecords({ ...snapshot, writes: [] });
    expect(() => persistence.repair(missingWrite)).toThrow(
        "Write audit points to a missing write record"
    );
    expect(() => persistence.findAudit(missingWrite, expected.audit.id)).toThrow(
        "Write audit points to a missing write record"
    );
});

test("conflicting stored originals cannot share one command identity", { tags: "p0" }, () => {
    const persistence = new StoragePersistence();
    const first = new MemoryProtocolRecords();
    const second = new MemoryProtocolRecords();
    const original = protocolTestRecords("adapter-conflict-original");
    const conflict = protocolTestRecords("adapter-conflict-second", undefined, {
        key: original.identity.idempotencyKey
    });
    appendProtocolTestRecords(persistence, first, original);
    appendProtocolTestRecords(persistence, second, conflict);
    const firstSnapshot = first.snapshot();
    const secondSnapshot = second.snapshot();
    const merged = new MemoryProtocolRecords({
        audits: [...firstSnapshot.audits, ...secondSnapshot.audits],
        writes: [...firstSnapshot.writes, ...secondSnapshot.writes],
        identities: []
    });

    expect(() => persistence.findWrite(merged, original.identity)).toThrow(
        "Conflicting original writes reserve one command identity"
    );
    expect(() => persistence.repair(merged)).toThrow(
        "Conflicting original writes reserve one command identity"
    );
});

test("identity projections compare every structural field", { tags: "p0" }, () => {
    const principal: ProtocolIdentityProjection = {
        caller: { kind: "principal", tenantId: adapterTenant, id: "adapter-principal" },
        idempotencyKey: "adapter-key"
    };
    const actor: ProtocolIdentityProjection = {
        caller: { kind: "actor", actorKind: "run", id: "adapter-principal" },
        idempotencyKey: "adapter-key"
    };

    expect(protocolIdentityProjectionsEqual(principal, principal)).toBe(true);
    expect(protocolIdentityProjectionsEqual(actor, actor)).toBe(true);
    expect(
        protocolIdentityProjectionsEqual(principal, {
            ...principal,
            idempotencyKey: "adapter-other-key"
        })
    ).toBe(false);
    expect(protocolIdentityProjectionsEqual(principal, actor)).toBe(false);
    expect(protocolIdentityProjectionsEqual(actor, principal)).toBe(false);
    expect(
        protocolIdentityProjectionsEqual(principal, {
            ...principal,
            caller: { kind: "principal", tenantId: adapterTenant, id: "adapter-other" }
        })
    ).toBe(false);
    expect(
        protocolIdentityProjectionsEqual(principal, {
            ...principal,
            caller: {
                kind: "principal",
                tenantId: new TenantId("adapter-other-tenant"),
                id: "adapter-principal"
            }
        })
    ).toBe(false);
    expect(
        protocolIdentityProjectionsEqual(actor, {
            ...actor,
            caller: { kind: "actor", actorKind: "workspace", id: "adapter-principal" }
        })
    ).toBe(false);
    expect(
        protocolIdentityProjectionsEqual(actor, {
            ...actor,
            caller: { kind: "actor", actorKind: "run", id: "adapter-other" }
        })
    ).toBe(false);
});

test("duplicate lineage must name an identity-reserving original", { tags: "p0" }, () => {
    const persistence = new StoragePersistence();
    const records = new MemoryProtocolRecords();
    const original = protocolTestRecords("adapter-chain-original");
    const first = protocolTestRecords("adapter-chain-first", undefined, {
        outcome: "duplicate",
        duplicateOf: original.write.id,
        key: original.identity.idempotencyKey,
        reply: original.write.reply
    });
    const second = protocolTestRecords("adapter-chain-second", undefined, {
        outcome: "duplicate",
        duplicateOf: first.write.id,
        key: original.identity.idempotencyKey,
        reply: original.write.reply
    });
    appendProtocolTestRecords(persistence, records, original);
    appendProtocolTestRecords(persistence, records, first);
    const snapshot = records.snapshot();
    const chained = new MemoryProtocolRecords({
        audits: [...snapshot.audits, storedAudit(second.root), storedAudit(second.audit)],
        writes: [...snapshot.writes, storedWrite(second.write)],
        identities: snapshot.identities
    });

    const read = () => persistence.findWriteById(chained, second.write.id);
    expectAgentCoreError(read, "protocol.invalid-state");
    expect(read).toThrow("Duplicate write does not name a valid original write");
    expect(() => persistence.repair(chained)).toThrow(
        "Duplicate write does not name a valid original write"
    );
});

test("stored audit write projections must match their codec bytes", { tags: "p1" }, () => {
    const records = new MemoryProtocolRecords();
    const persistence = new StoragePersistence();
    const expected = protocolTestRecords("adapter-projection");
    appendProtocolTestRecords(persistence, records, expected);
    const phantom = new (class extends FacadeStorage {
        public override findAudit(id: string): StoredProtocolAudit | undefined {
            const stored = super.findAudit(id);
            return stored === undefined || stored.evidenceKind !== "invocation"
                ? stored
                : { ...stored, writeId: new WriteRecordId("adapter-projection-phantom") };
        }
    })(records);

    const read = () => persistence.findAudit(phantom, expected.root.id);
    expectAgentCoreError(read, "codec.invalid");
    expect(read).toThrow("Stored audit key or projection does not match its codec bytes");
});

test("write appends against non-write audit evidence fail closed", { tags: "p0" }, () => {
    const persistence = new StoragePersistence();
    const records = new MemoryProtocolRecords();
    const delivery = new AuditRecord({
        id: new AuditRecordId("adapter-delivery-audit"),
        actor: adapterActor,
        tenant: adapterTenant,
        correlation: new CorrelationId("adapter-delivery-correlation"),
        kind: { kind: "delivery", reservation: new RouteReservationId("adapter-delivery") }
    });
    records.insertAudit(storedAudit(delivery));
    const write = new WriteRecord({
        id: new WriteRecordId("adapter-delivery-write"),
        actor: adapterActor,
        envelopeDigest: Digest.sha256(new TextEncoder().encode("adapter-delivery")),
        caller: { kind: "actor", actor: adapterActor },
        command: "adapter.command",
        idempotencyKey: "adapter-delivery-key",
        at: new Date("2026-07-07T12:00:00.000Z"),
        outcome: "committed",
        audit: delivery.id,
        reply: new TextEncoder().encode("adapter-delivery-reply")
    });

    expectAgentCoreError(() => persistence.appendWrite(records, write), "protocol.invalid-state");
    expect(persistence.findWriteById(records, write.id)).toBeUndefined();
});

test("stored write audits must retain their write id projection", { tags: "p1" }, () => {
    const records = new MemoryProtocolRecords();
    const persistence = new StoragePersistence();
    const expected = protocolTestRecords("adapter-stripped-write-id");
    appendProtocolTestRecords(persistence, records, expected);
    const stripped = new (class extends FacadeStorage {
        public override findAudit(id: string): StoredProtocolAudit | undefined {
            const stored = super.findAudit(id);
            if (stored === undefined || stored.evidenceKind !== "write") return stored;
            const { writeId: _writeId, ...rest } = stored;
            return rest;
        }
    })(records);

    const read = () => persistence.findAudit(stripped, expected.audit.id);
    expectAgentCoreError(read, "codec.invalid");
});

type CauseFreeOutcome = "committed" | "rejectedMalformed";

interface CauseFreeRecords {
    readonly audit: AuditRecord;
    readonly write: WriteRecord;
}

/**
 * Stored bytes are supposed to hold an encoded record. Proving the read path rejects a stored
 * value that is not bytes means putting one there, which the projection types forbid.
 */
function forgedBytes<TActual>(value: TActual): Uint8Array {
    // SAFETY: not a Uint8Array. The adapter must report the stored record as malformed rather
    // than hand it to a codec that would fail somewhere less specific.
    return value as TActual & Uint8Array;
}

function causeFreeWriteRecords(prefix: string, outcome: CauseFreeOutcome): CauseFreeRecords {
    const writeId = new WriteRecordId(`${prefix}-write`);
    const audit = new AuditRecord({
        id: new AuditRecordId(`${prefix}-audit`),
        actor: adapterActor,
        tenant: adapterTenant,
        correlation: new CorrelationId(`${prefix}-correlation`),
        kind: { kind: "write", id: writeId, outcome }
    });
    const required: WriteRecordInit = {
        id: writeId,
        actor: adapterActor,
        envelopeDigest: Digest.sha256(new TextEncoder().encode(prefix)),
        at: new Date("2026-07-07T12:00:00.000Z"),
        outcome,
        audit: audit.id,
        reply: new TextEncoder().encode(`${prefix}-reply`)
    };
    // Only a committed write carries the decoded envelope fields; a malformed one may omit them.
    const write = new WriteRecord(
        outcome === "committed"
            ? {
                  ...required,
                  caller: { kind: "actor", actor: adapterActor },
                  command: "adapter.command",
                  idempotencyKey: `${prefix}-key`
              }
            : required
    );
    return { audit, write };
}

function storedAudit(record: AuditRecord): StoredProtocolAudit {
    const evidenceIdentity = auditEvidenceIdentity(record.actor, record.kind).value;
    return record.kind.kind === "write"
        ? {
              id: record.id.value,
              evidenceIdentity,
              evidenceKind: record.kind.kind,
              writeId: record.kind.id,
              writeOutcome: record.kind.outcome,
              bytes: AuditRecordCodec.encode(record)
          }
        : {
              id: record.id.value,
              evidenceIdentity,
              evidenceKind: record.kind.kind,
              bytes: AuditRecordCodec.encode(record)
          };
}

function storedWrite(record: WriteRecord): StoredProtocolWrite {
    return {
        id: record.id.value,
        auditId: record.audit,
        outcome: record.outcome,
        bytes: WriteRecordCodec.encode(record)
    };
}

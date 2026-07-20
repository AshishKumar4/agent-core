import { expect, test } from "vitest";
import { ActorId, ActorRef, MemoryActorStore, type SynchronousResultGuard } from "../../src/actors";
import { TenantId } from "../../src/identity";
import {
    AuditRecord,
    AuditRecordCodec,
    AuditRecordId,
    CorrelationId,
    InvocationId,
    WriteRecordId,
    auditEvidenceIdentity
} from "../../src/invocations";
import {
    MemoryProtocolPersistence,
    MemoryProtocolRecords,
    protocolIdentityProjection,
    protocolIdentityProjectionsEqual,
    WriteRecord,
    WriteRecordCodec,
    type MemoryProtocolSnapshot,
    type ProtocolPersistenceAdapter
} from "../../src/protocol";
import {
    appendProtocolTestRecords,
    protocolPersistenceContract,
    protocolTestRecords,
    protocolUnsupportedAuditRecords,
    type ProtocolPersistenceHarness
} from "./persistence-contract";
import { expectAgentCoreError } from "./error-assertion";

interface MemoryState {
    readonly protocol: MemoryProtocolRecords;
}

protocolPersistenceContract("memory", createMemoryHarness);

test("[write-record] memory protocol records survive adapter and snapshot restoration", () => {
    const records = new MemoryProtocolRecords();
    const persistence = persistenceForRecords();
    const expected = protocolTestRecords("memory-restart");
    appendProtocolTestRecords(persistence, records, expected);
    const snapshot = records.snapshot();

    expect(snapshot.audits.find((audit) => audit.writeId !== undefined)?.writeId).toBeInstanceOf(
        WriteRecordId
    );
    expect(snapshot.writes[0]?.auditId).toBeInstanceOf(AuditRecordId);
    expect(snapshot.identities[0]?.writeId).toBeInstanceOf(WriteRecordId);

    const restored = new MemoryProtocolRecords(snapshot);
    const restarted = persistenceForRecords();

    expect(restarted.findWrite(restored, expected.identity)?.id.value).toBe(
        expected.write.id.value
    );
    expect(restarted.findAudit(restored, expected.audit.id)?.kind).toMatchObject({
        kind: "write",
        id: expected.write.id
    });
});

test("memory restart preserves actor source identity without aliasing principal callers", () => {
    const actor = new ActorRef("workspace", new ActorId("memory-source-actor"));
    const actorCaller = { kind: "actor" as const, actor };
    const records = new MemoryProtocolRecords();
    const persistence = persistenceForRecords();
    const expected = protocolTestRecords("memory-actor-restart", actorCaller);
    appendProtocolTestRecords(persistence, records, expected);

    const restored = new MemoryProtocolRecords(records.snapshot());
    expect(persistence.findWrite(restored, expected.identity)?.id.value).toBe(
        expected.write.id.value
    );
    const actorProjection = protocolIdentityProjection(expected.identity);
    const principalProjection = protocolIdentityProjection(
        protocolTestRecords("memory-principal-projection").identity
    );
    expect(protocolIdentityProjectionsEqual(actorProjection, actorProjection)).toBe(true);
    expect(protocolIdentityProjectionsEqual(actorProjection, principalProjection)).toBe(false);
    expect(protocolIdentityProjectionsEqual(principalProjection, principalProjection)).toBe(true);
    expect(
        protocolIdentityProjectionsEqual(principalProjection, {
            ...principalProjection,
            caller:
                principalProjection.caller.kind === "principal"
                    ? {
                          ...principalProjection.caller,
                          tenantId: new TenantId("memory-other-source-tenant")
                      }
                    : principalProjection.caller
        })
    ).toBe(false);
});

test("memory snapshots rebuild non-authoritative identity projections from writes", () => {
    const records = new MemoryProtocolRecords();
    const persistence = persistenceForRecords();
    const expected = protocolTestRecords("memory-identity-alias");
    appendProtocolTestRecords(persistence, records, expected);
    const snapshot = records.snapshot();
    const identity = snapshot.identities[0]!;
    expect(identity.identity.caller.kind).toBe("principal");
    if (identity.identity.caller.kind === "principal") {
        expect(identity.identity.caller.tenantId).toBeInstanceOf(TenantId);
    }

    const restored = new MemoryProtocolRecords({
        ...snapshot,
        identities: [
            identity,
            {
                identity: {
                    caller: {
                        kind: "principal",
                        tenantId: new TenantId("memory-other-tenant"),
                        id: "memory-other-caller"
                    },
                    idempotencyKey: "memory-other-key"
                },
                writeId: identity.writeId
            }
        ]
    });

    expect(restored.snapshot().identities).toEqual([identity]);
    expect(persistence.findWrite(restored, expected.identity)?.id.value).toBe(
        expected.write.id.value
    );
});

test.each(["audit", "write"] as const)(
    "memory snapshots reject duplicate %s identifiers",
    (kind) => {
        const records = new MemoryProtocolRecords();
        const persistence = persistenceForRecords();
        appendProtocolTestRecords(
            persistence,
            records,
            protocolTestRecords(`memory-duplicate-${kind}`)
        );
        const snapshot = records.snapshot();

        expectAgentCoreError(
            () =>
                new MemoryProtocolRecords({
                    ...snapshot,
                    ...(kind === "audit"
                        ? { audits: [...snapshot.audits, snapshot.audits[0]!] }
                        : { writes: [...snapshot.writes, snapshot.writes[0]!] })
                }),
            "codec.invalid"
        );
    }
);

test.each(["audit", "write"] as const)(
    "memory records enforce append-only %s insertion directly",
    (kind) => {
        const records = new MemoryProtocolRecords();
        const persistence = persistenceForRecords();
        appendProtocolTestRecords(
            persistence,
            records,
            protocolTestRecords(`memory-append-${kind}`)
        );
        const snapshot = records.snapshot();

        expectAgentCoreError(
            () =>
                kind === "audit"
                    ? records.insertAudit(snapshot.audits[0]!)
                    : records.insertWrite(snapshot.writes[0]!, undefined),
            "protocol.invalid-state"
        );
    }
);

test("memory snapshots and reads do not expose mutable record bytes", () => {
    const records = new MemoryProtocolRecords();
    const persistence = persistenceForRecords();
    const expected = protocolTestRecords("memory-byte-copy");
    appendProtocolTestRecords(persistence, records, expected);
    const snapshot = records.snapshot();
    snapshot.audits[0]!.bytes.fill(0);
    snapshot.writes[0]!.bytes.fill(0);

    expect(persistence.findAudit(records, expected.root.id)?.id.value).toBe(expected.root.id.value);
    expect(persistence.findWriteById(records, expected.write.id)?.id.value).toBe(
        expected.write.id.value
    );
});

test.each(["audit", "write"] as const)("memory reads reject non-byte %s storage", (kind) => {
    const records = new MemoryProtocolRecords();
    const persistence = persistenceForRecords();
    const expected = protocolTestRecords(`memory-non-byte-${kind}`);
    appendProtocolTestRecords(persistence, records, expected);
    const snapshot = records.snapshot();
    const nonBytes = "not bytes" as unknown as Uint8Array;
    expectAgentCoreError(
        () =>
            new MemoryProtocolRecords({
                ...snapshot,
                ...(kind === "audit"
                    ? {
                          audits: snapshot.audits.map((audit) =>
                              audit.id === expected.audit.id.value
                                  ? { ...audit, bytes: nonBytes }
                                  : audit
                          )
                      }
                    : { writes: snapshot.writes.map((write) => ({ ...write, bytes: nonBytes })) })
            }),
        "codec.invalid"
    );
});

test("memory fails closed when canonical snapshot writes reserve one identity", () => {
    const first = new MemoryProtocolRecords();
    const second = new MemoryProtocolRecords();
    const persistence = persistenceForRecords();
    const original = protocolTestRecords("memory-conflict-original");
    const conflict = protocolTestRecords("memory-conflict-second", undefined, {
        key: original.identity.idempotencyKey
    });
    appendProtocolTestRecords(persistence, first, original);
    appendProtocolTestRecords(persistence, second, conflict);
    const firstSnapshot = first.snapshot();
    const secondSnapshot = second.snapshot();
    const restored = new MemoryProtocolRecords({
        audits: [...firstSnapshot.audits, ...secondSnapshot.audits],
        writes: [...firstSnapshot.writes, ...secondSnapshot.writes],
        identities: []
    });

    expectAgentCoreError(
        () => persistence.findWrite(restored, original.identity),
        "protocol.invalid-state"
    );
});

test("memory reads every hand-seeded codec-representable non-write audit projection", () => {
    const audits = protocolUnsupportedAuditRecords("memory-unsupported");
    const records = new MemoryProtocolRecords({
        audits: audits.map((audit) => ({
            id: audit.id.value,
            evidenceIdentity: auditEvidenceIdentity(audit.actor, audit.kind).value,
            evidenceKind: audit.kind.kind,
            bytes: AuditRecordCodec.encode(audit)
        })),
        writes: [],
        identities: []
    });

    const persistence = persistenceForRecords();
    for (const expected of audits) {
        const actual = persistence.findAudit(records, expected.id);
        expect(actual).toBeDefined();
        if (actual === undefined) throw new TypeError("Expected stored audit record");
        expect(AuditRecordCodec.encode(actual)).toEqual(AuditRecordCodec.encode(expected));
    }
    expect(() => persistence.repair(records)).toThrow(
        expect.objectContaining({ code: "protocol.invalid-state" })
    );
});

test.each(["audit", "write"] as const)("memory reads reject corrupt %s codec bytes", (record) => {
    const records = new MemoryProtocolRecords();
    const persistence = persistenceForRecords();
    const expected = protocolTestRecords(`memory-codec-${record}`);
    appendProtocolTestRecords(persistence, records, expected);
    const snapshot = records.snapshot();
    const restored = new MemoryProtocolRecords(
        record === "audit"
            ? {
                  ...snapshot,
                  audits: snapshot.audits.map((audit) =>
                      audit.id === expected.audit.id.value
                          ? { ...audit, bytes: new Uint8Array([0]) }
                          : audit
                  )
              }
            : {
                  ...snapshot,
                  writes: snapshot.writes.map((write) => ({
                      ...write,
                      bytes: new Uint8Array([0])
                  }))
              }
    );

    expectAgentCoreError(
        () =>
            record === "audit"
                ? persistence.findAudit(restored, expected.audit.id)
                : persistence.findWriteById(restored, expected.write.id),
        "codec.invalid"
    );
});

test.each(["evidenceIdentity", "evidenceKind", "writeId", "writeOutcome"] as const)(
    "memory reads reject a corrupt write-audit %s projection",
    (projection) => {
        const records = new MemoryProtocolRecords();
        const persistence = persistenceForRecords();
        const expected = protocolTestRecords(`memory-write-audit-${projection}`);
        appendProtocolTestRecords(persistence, records, expected);
        const snapshot = records.snapshot();
        const restored = new MemoryProtocolRecords({
            ...snapshot,
            audits: snapshot.audits.map((audit) =>
                audit.id === expected.audit.id.value
                    ? {
                          ...audit,
                          ...(projection === "evidenceIdentity"
                              ? { evidenceIdentity: "0".repeat(64) }
                              : {}),
                          ...(projection === "evidenceKind"
                              ? { evidenceKind: "commit" as const }
                              : {}),
                          ...(projection === "writeId"
                              ? { writeId: new WriteRecordId("other-write") }
                              : {}),
                          ...(projection === "writeOutcome"
                              ? { writeOutcome: "rejectedAuthority" as const }
                              : {})
                      }
                    : audit
            )
        });

        expectAgentCoreError(
            () => persistence.findAudit(restored, expected.audit.id),
            "codec.invalid"
        );
    }
);

test.each(["missing", "actor", "tenant", "correlation"] as const)(
    "memory write reads reject a %s Invocation cause",
    (corruption) => {
        const records = new MemoryProtocolRecords();
        const persistence = persistenceForRecords();
        const expected = protocolTestRecords(`memory-cause-${corruption}`);
        appendProtocolTestRecords(persistence, records, expected);
        const snapshot = records.snapshot();
        const audits =
            corruption === "missing"
                ? snapshot.audits.filter((audit) => audit.id !== expected.root.id.value)
                : snapshot.audits.map((audit) =>
                      audit.id === expected.root.id.value
                          ? {
                                ...audit,
                                bytes: AuditRecordCodec.encode(
                                    new AuditRecord({
                                        id: expected.root.id,
                                        actor:
                                            corruption === "actor"
                                                ? new ActorRef(
                                                      "run",
                                                      new ActorId("other-memory-actor")
                                                  )
                                                : expected.root.actor,
                                        tenant:
                                            corruption === "tenant"
                                                ? new TenantId("other-memory-tenant")
                                                : expected.root.tenant,
                                        correlation:
                                            corruption === "correlation"
                                                ? new CorrelationId("other-memory-correlation")
                                                : expected.root.correlation,
                                        kind: expected.root.kind
                                    })
                                )
                            }
                          : audit
                  );
        const restored = new MemoryProtocolRecords({ ...snapshot, audits });

        expectAgentCoreError(
            () => persistence.findWriteById(restored, expected.write.id),
            corruption === "actor" ? "codec.invalid" : "protocol.invalid-state"
        );
    }
);

test("memory rejects write and audit records whose reciprocal record is missing", () => {
    const records = new MemoryProtocolRecords();
    const persistence = persistenceForRecords();
    const expected = protocolTestRecords("memory-missing-reciprocal");
    appendProtocolTestRecords(persistence, records, expected);
    const snapshot = records.snapshot();
    const missingAudit = new MemoryProtocolRecords({
        ...snapshot,
        audits: snapshot.audits.filter((audit) => audit.id !== expected.audit.id.value)
    });
    const missingWrite = new MemoryProtocolRecords({ ...snapshot, writes: [] });

    expectAgentCoreError(
        () => persistence.findWriteById(missingAudit, expected.write.id),
        "protocol.invalid-state"
    );
    expectAgentCoreError(
        () => persistence.findAudit(missingWrite, expected.audit.id),
        "protocol.invalid-state"
    );
});

test.each(["wrong-kind", "cause-free"] as const)(
    "memory rejects a %s write audit cause",
    (corruption) => {
        const records = new MemoryProtocolRecords();
        const persistence = persistenceForRecords();
        const expected = protocolTestRecords(`memory-audit-cause-${corruption}`);
        appendProtocolTestRecords(persistence, records, expected);
        const snapshot = records.snapshot();
        let audits = snapshot.audits;

        if (corruption === "cause-free") {
            const audit = new AuditRecord({
                id: expected.audit.id,
                actor: expected.audit.actor,
                tenant: expected.audit.tenant,
                correlation: expected.audit.correlation,
                kind: expected.audit.kind
            });
            audits = replaceAudit(audits, audit);
        } else {
            const cause = new AuditRecord({
                id: expected.root.id,
                actor: expected.root.actor,
                tenant: expected.root.tenant,
                correlation: expected.root.correlation,
                kind: {
                    kind: "write",
                    id: new WriteRecordId("memory-cause-write"),
                    outcome: "rejectedMalformed"
                }
            });
            audits = replaceAudit(audits, cause);
        }

        const restored = new MemoryProtocolRecords({ ...snapshot, audits });
        expectAgentCoreError(
            () => persistence.findWriteById(restored, expected.write.id),
            "protocol.invalid-state"
        );
    }
);

test("[C13-PROTOCOL-REJECTION-ROOT] audit values reject nested Invocation roots before persistence", () => {
    expect(
        () =>
            new AuditRecord({
                id: new AuditRecordId("memory-nested-root"),
                actor: new ActorRef("run", new ActorId("memory-nested-actor")),
                tenant: new TenantId("memory-nested-tenant"),
                correlation: new CorrelationId("memory-nested-correlation"),
                cause: new AuditRecordId("memory-earlier-root"),
                kind: { kind: "invocation", id: new InvocationId("memory-nested-invocation") }
            })
    ).toThrow("Invocation audit roots cannot have a cause");
});

test.each(["identity", "actor", "reply", "unreserved-original"] as const)(
    "memory rejects a duplicate with corrupt %s lineage",
    (corruption) => {
        const records = new MemoryProtocolRecords();
        const persistence = persistenceForRecords();
        const original = protocolTestRecords(`memory-duplicate-original-${corruption}`);
        const duplicate = protocolTestRecords(`memory-duplicate-copy-${corruption}`, undefined, {
            outcome: "duplicate",
            duplicateOf: original.write.id,
            key: original.identity.idempotencyKey,
            reply: original.write.reply
        });
        appendProtocolTestRecords(persistence, records, original);
        appendProtocolTestRecords(persistence, records, duplicate);
        const snapshot = records.snapshot();
        const corruptedWrites = snapshot.writes.map((stored) => {
            if (corruption === "unreserved-original" && stored.id === original.write.id.value) {
                const replacement = copyStoredWrite(original.write, {
                    outcome: "rejectedAuthentication",
                    idempotencyKey: undefined
                });
                return storedProjection(replacement);
            }
            if (stored.id !== duplicate.write.id.value) return stored;
            const replacement = copyStoredWrite(duplicate.write, {
                ...(corruption === "identity" ? { idempotencyKey: "other-key" } : {}),
                ...(corruption === "actor"
                    ? { actor: new ActorRef("workspace", new ActorId("other-duplicate-actor")) }
                    : {}),
                ...(corruption === "reply" ? { reply: Uint8Array.of(9) } : {})
            });
            return storedProjection(replacement);
        });
        const corruptedActor = new ActorRef("workspace", new ActorId("other-duplicate-actor"));
        const corruptedAudits =
            corruption === "actor"
                ? replaceAudit(
                      replaceAudit(
                          snapshot.audits,
                          new AuditRecord({
                              id: duplicate.root.id,
                              actor: corruptedActor,
                              tenant: duplicate.root.tenant,
                              correlation: duplicate.root.correlation,
                              kind: duplicate.root.kind
                          })
                      ),
                      new AuditRecord({
                          id: duplicate.audit.id,
                          actor: corruptedActor,
                          tenant: duplicate.audit.tenant,
                          correlation: duplicate.audit.correlation,
                          cause: duplicate.root.id,
                          kind: duplicate.audit.kind
                      })
                  )
                : snapshot.audits;
        const restored = new MemoryProtocolRecords({
            ...snapshot,
            audits: corruptedAudits,
            writes: corruptedWrites
        });

        expect(() => persistence.findWriteById(restored, duplicate.write.id)).toThrow(
            "valid original write"
        );
    }
);

test.each(["audit", "write"] as const)(
    "memory reads reject a corrupt %s projection",
    (projection) => {
        const records = new MemoryProtocolRecords();
        const persistence = persistenceForRecords();
        const expected = protocolTestRecords(`memory-corrupt-${projection}`);
        appendProtocolTestRecords(persistence, records, expected);
        const snapshot = records.snapshot();
        const corrupted = corruptSnapshot(snapshot, projection);
        const restored = new MemoryProtocolRecords(corrupted.snapshot);
        const restarted = persistenceForRecords();

        expectAgentCoreError(() => restarted.repair(restored), "codec.invalid");
        expectAgentCoreError(
            () =>
                projection === "audit"
                    ? restarted.findAudit(restored, corrupted.auditId)
                    : restarted.findWriteById(restored, expected.write.id),
            "codec.invalid"
        );
    }
);

test.each(["missing-audit", "orphan-write-audit", "missing-cause", "duplicate-lineage"] as const)(
    "memory startup repair rejects %s corruption",
    (corruption) => {
        const records = new MemoryProtocolRecords();
        const persistence = persistenceForRecords();
        const original = protocolTestRecords(`memory-startup-${corruption}`);
        appendProtocolTestRecords(persistence, records, original);
        let snapshot = records.snapshot();
        if (corruption === "missing-audit") {
            snapshot = {
                ...snapshot,
                audits: snapshot.audits.filter((audit) => audit.id !== original.audit.id.value)
            };
        } else if (corruption === "orphan-write-audit") {
            snapshot = {
                ...snapshot,
                writes: snapshot.writes.filter((write) => write.id !== original.write.id.value)
            };
        } else if (corruption === "missing-cause") {
            snapshot = {
                ...snapshot,
                audits: snapshot.audits.filter((audit) => audit.id !== original.root.id.value)
            };
        } else {
            const duplicate = protocolTestRecords("memory-startup-duplicate", undefined, {
                outcome: "duplicate",
                duplicateOf: original.write.id,
                key: original.identity.idempotencyKey,
                reply: original.write.reply
            });
            appendProtocolTestRecords(persistence, records, duplicate);
            snapshot = records.snapshot();
            const encoded = new TextDecoder().decode(WriteRecordCodec.encode(duplicate.write));
            snapshot = {
                ...snapshot,
                writes: snapshot.writes.map((write) =>
                    write.id === duplicate.write.id.value
                        ? {
                              ...write,
                              bytes: new TextEncoder().encode(
                                  encoded.replace(
                                      original.write.id.value,
                                      "missing-startup-original"
                                  )
                              )
                          }
                        : write
                )
            };
        }
        const restored = new MemoryProtocolRecords(snapshot);

        expectAgentCoreError(() => persistence.repair(restored), /codec|protocol/);
    }
);

function createMemoryHarness(): ProtocolPersistenceHarness<MemoryState> {
    const clone = (state: MemoryState): MemoryState => ({ protocol: state.protocol.clone() });
    let store = new MemoryActorStore<MemoryState>({ protocol: new MemoryProtocolRecords() }, clone);
    return {
        persistence: new MemoryProtocolPersistence((state) => state.protocol),
        transaction<Result>(
            operation: (transaction: MemoryState) => Result,
            ...guard: SynchronousResultGuard<Result>
        ): Result {
            return store.transaction(operation, ...guard);
        },
        restart(): void {
            store = MemoryActorStore.restore(store.snapshot(), clone);
        },
        dispose(): void {}
    };
}

function persistenceForRecords(): ProtocolPersistenceAdapter<MemoryProtocolRecords> {
    return new MemoryProtocolPersistence((records) => records);
}

function corruptSnapshot(
    snapshot: MemoryProtocolSnapshot,
    projection: "audit" | "write"
): {
    readonly snapshot: MemoryProtocolSnapshot;
    readonly auditId: AuditRecordId;
} {
    if (projection === "audit") {
        const corruptId = new AuditRecordId("memory-corrupt-audit-key");
        return {
            snapshot: {
                ...snapshot,
                audits: snapshot.audits.map((audit, index) =>
                    index === 0 ? { ...audit, id: corruptId.value } : audit
                )
            },
            auditId: corruptId
        };
    }
    return {
        snapshot: {
            ...snapshot,
            writes: snapshot.writes.map((write) => ({
                ...write,
                auditId: new AuditRecordId("memory-corrupt-audit-projection")
            }))
        },
        auditId: new AuditRecordId("unused-audit")
    };
}

function replaceAudit(
    audits: MemoryProtocolSnapshot["audits"],
    record: AuditRecord
): MemoryProtocolSnapshot["audits"] {
    return audits.map((audit) =>
        audit.id === record.id.value
            ? {
                  id: record.id.value,
                  evidenceIdentity: auditEvidenceIdentity(record.actor, record.kind).value,
                  evidenceKind: record.kind.kind,
                  ...(record.kind.kind === "write"
                      ? { writeId: record.kind.id, writeOutcome: record.kind.outcome }
                      : {}),
                  bytes: AuditRecordCodec.encode(record)
              }
            : audit
    );
}

function copyStoredWrite(
    write: WriteRecord,
    overrides: {
        readonly actor?: ActorRef;
        readonly idempotencyKey?: string | undefined;
        readonly outcome?: "rejectedAuthentication";
        readonly reply?: Uint8Array;
    }
): WriteRecord {
    const outcome = overrides.outcome ?? write.outcome;
    const idempotencyKey =
        "idempotencyKey" in overrides ? overrides.idempotencyKey : write.idempotencyKey;
    return new WriteRecord({
        id: write.id,
        actor: overrides.actor ?? write.actor,
        envelopeDigest: write.envelopeDigest,
        ...(write.caller === undefined ? {} : { caller: write.caller }),
        ...(write.command === undefined ? {} : { command: write.command }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        at: write.at,
        outcome,
        audit: write.audit,
        ...(write.duplicateOf === undefined || outcome !== "duplicate"
            ? {}
            : { duplicateOf: write.duplicateOf }),
        reply: overrides.reply ?? write.reply
    });
}

function storedProjection(write: WriteRecord): MemoryProtocolSnapshot["writes"][number] {
    return {
        id: write.id.value,
        auditId: write.audit,
        outcome: write.outcome,
        bytes: WriteRecordCodec.encode(write)
    };
}

import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    InvalidationWatermark,
    MemoryAuthorityPermitStore,
    MemoryTargetLeaseEvidenceStore,
    TargetLeaseEvidence,
    TargetLeaseEvidenceKey
} from "../../src/authority";
import { RunId, TurnId } from "../../src/agents";
import { Digest } from "../../src/core";
import { ProtectionDomain } from "../../src/facets";
import { SqliteAuthorityPermitStore, SqliteTargetLeaseEvidenceStore } from "../../src/substrates";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { TestSqlite } from "../helpers/sqlite";

const tenant = new TenantId("target-lease-evidence-tenant");
const holder = new PrincipalRef(tenant, new PrincipalId("target-lease-evidence-holder"));
const source = new ActorRef("workspace", new ActorId("target-lease-evidence-source"));
const target = new ActorRef("run", new ActorId("target-lease-evidence-target"));
const tenantActor = new ActorRef("tenant", new ActorId("target-lease-evidence-issuer"));
const key = new TargetLeaseEvidenceKey(source, "target-lease-evidence-key");
const deadline = new Date("2026-08-23T12:00:05.000Z");

function evidence(requestIdentity = Digest.sha256(new TextEncoder().encode("target-request"))) {
    return new TargetLeaseEvidence({
        key,
        tenant,
        run: new RunId("target-lease-evidence-run"),
        lease: Object.freeze({
            turn: new TurnId("target-lease-evidence-turn"),
            holder,
            epoch: 7
        }),
        target: {
            actor: target,
            fence: 4,
            domain: new ProtectionDomain("backend", "target-lease-evidence", "may-hold-secrets")
        },
        requestIdentity,
        deadline,
        watermark: InvalidationWatermark.empty(tenant, source, holder)
    });
}

describe("TargetLeaseEvidence", () => {
    test("[authority.target-lease-evidence] records one exact source-owned immutable attestation across restart", { tags: "p0" }, () => {
        const store = new MemoryTargetLeaseEvidenceStore(source);
        const recorded = store.transaction((transaction) => store.record(transaction, evidence()));
        const restarted = new MemoryTargetLeaseEvidenceStore(source, store.snapshot());
        const restored = restarted.transaction((transaction) =>
            restarted.evidence(transaction, key.idempotencyKey)
        );

        expect(restored?.digest().equals(recorded.digest())).toBe(true);
        expect(restored?.run.equals(recorded.run)).toBe(true);
        expect(restored?.lease.turn.equals(recorded.lease.turn)).toBe(true);
        expect(restored?.lease.holder.equals(recorded.lease.holder)).toBe(true);
        expect(restored?.lease.epoch).toBe(recorded.lease.epoch);
        expect(restored?.deadline).toEqual(deadline);
    });

    test("binds exact Tenant, target, Run, Turn, holder, epoch, and deadline", { tags: "p0" }, () => {
        const record = evidence();
        const binding = {
            key: record.key,
            tenant: record.tenant,
            run: record.run,
            lease: record.lease,
            target: record.target,
            requestIdentity: record.requestIdentity
        };

        expect(record.matches(binding)).toBe(true);
        expect(
            record.matches({
                ...binding,
                tenant: new TenantId("target-lease-evidence-other-tenant")
            })
        ).toBe(false);
        expect(
            record.matches({
                ...binding,
                target: { ...binding.target, fence: binding.target.fence + 1 }
            })
        ).toBe(false);
        expect(
            record.matches({
                ...binding,
                lease: { ...binding.lease, turn: new TurnId("target-lease-evidence-other-turn") }
            })
        ).toBe(false);
        expect(
            record.matches({
                ...binding,
                lease: { ...binding.lease, epoch: binding.lease.epoch + 1 }
            })
        ).toBe(false);
        expect(record.isCurrentAt(new Date(deadline.getTime() - 1))).toBe(true);
        expect(record.isCurrentAt(deadline)).toBe(false);
    });

    test("refuses a same-key source substitution", { tags: "p0" }, () => {
        const store = new MemoryTargetLeaseEvidenceStore(source);
        store.transaction((transaction) => store.record(transaction, evidence()));

        expect(() =>
            store.transaction((transaction) =>
                store.record(
                    transaction,
                    evidence(Digest.sha256(new TextEncoder().encode("substituted-request")))
                )
            )
        ).toThrow(/bound to another source attestation/);
    });
    test("[target-lease-evidence-store] persists the source-owned record through SQLite restart", { tags: "p0" }, () => {
        const database = new TestSqlite();
        let store = new SqliteTargetLeaseEvidenceStore(database, source);
        const recorded = store.transaction((transaction) => store.record(transaction, evidence()));
        store = new SqliteTargetLeaseEvidenceStore(database, source);
        const restored = store.transaction((transaction) =>
            store.evidence(transaction, key.idempotencyKey)
        );

        expect(restored?.digest().equals(recorded.digest())).toBe(true);
    });

    test("refuses a record under another source Actor", { tags: "p0" }, () => {
        const store = new MemoryTargetLeaseEvidenceStore(target);
        expect(() => store.transaction((transaction) => store.record(transaction, evidence()))).toThrow(
            /another source Actor/
        );
    });
});

function projectionStoreContract(
    name: string,
    create: () => {
        readonly project: (value: TargetLeaseEvidence) => TargetLeaseEvidence;
        readonly projected: () => TargetLeaseEvidence | undefined;
        readonly restart: () => void;
    }
): void {
    describe(`${name} Tenant lease-evidence projection`, () => {
        test("is idempotent across restart and refuses a same-key substitution", { tags: "p0" }, () => {
            const store = create();
            const first = store.project(evidence());
            store.restart();
            const restored = store.projected();

            expect(restored?.digest().equals(first.digest())).toBe(true);
            expect(store.project(evidence()).digest().equals(first.digest())).toBe(true);
            expect(() =>
                store.project(
                    evidence(Digest.sha256(new TextEncoder().encode(`${name}-substituted-request`)))
                )
            ).toThrow(/bound to another attestation/);
        });
    });
}

projectionStoreContract("memory", () => {
    let store = new MemoryAuthorityPermitStore(tenantActor);
    return {
        project: (value) => store.transaction((transaction) => store.projectEvidence(transaction, value)),
        projected: () => store.transaction((transaction) => store.projectedEvidence(transaction, valueRef())),
        restart: () => {
            store = new MemoryAuthorityPermitStore(tenantActor, store.snapshot());
        }
    };
});

projectionStoreContract("sqlite", () => {
    const database = new TestSqlite();
    let store = new SqliteAuthorityPermitStore(database, tenantActor);
    return {
        project: (value) => store.transaction((transaction) => store.projectEvidence(transaction, value)),
        projected: () => store.transaction((transaction) => store.projectedEvidence(transaction, valueRef())),
        restart: () => {
            store = new SqliteAuthorityPermitStore(database, tenantActor);
        }
    };
});

function valueRef() {
    return evidence().reference();
}

import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    InvalidationWatermark,
    MemoryAuthorityPermitStore,
    RunTargetLeaseEvidenceStore,
    TargetLeaseEvidence,
    TargetLeaseEvidenceKey
} from "../../src/authority";
import {
    MemoryRunStorage,
    RunId,
    TurnId,
    type RunTransaction
} from "../../src/agents";
import { Digest } from "../../src/core";
import { ProtectionDomain } from "../../src/facets";
import {
    SqliteAuthorityPermitStore,
    SqliteRunStorage
} from "../../src/substrates";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { TestSqlite } from "../helpers/sqlite";

const tenant = new TenantId("target-lease-evidence-tenant");
const holder = new PrincipalRef(tenant, new PrincipalId("target-lease-evidence-holder"));
const source = new ActorRef("workspace", new ActorId("target-lease-evidence-source"));
const target = new ActorRef("run", new ActorId("target-lease-evidence-target"));
const otherTenant = new TenantId("target-lease-evidence-other");
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
    test("[authority.target-lease-evidence] [runs.target-lease-evidence] records one exact source-owned immutable attestation across restart", { tags: "p0" }, () => {
        const storage = new MemoryRunStorage(tenant, source);
        const store = new RunTargetLeaseEvidenceStore<RunTransaction>(tenant, source, storage, {
            turn: () => undefined,
            watermark: (_tx, h) => InvalidationWatermark.empty(tenant, source, h),
            invocationIntent: () => undefined
        });
        const recorded = store.transaction((transaction) => store.record(transaction, evidence()));
        const restarted = new RunTargetLeaseEvidenceStore<RunTransaction>(
            tenant,
            source,
            new MemoryRunStorage(tenant, source, storage.snapshot()),
            {
                turn: () => undefined,
                watermark: (_tx, h) => InvalidationWatermark.empty(tenant, source, h),
                invocationIntent: () => undefined
            }
        );
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

    test("[target-lease-evidence-source] answers only its exact owner through one run storage", { tags: "p0" }, () => {
        const storage = new MemoryRunStorage(tenant, source);
        const store = new RunTargetLeaseEvidenceStore<RunTransaction>(tenant, source, storage, {
            turn: () => undefined,
            watermark: (_tx, h) => InvalidationWatermark.empty(tenant, source, h),
            invocationIntent: () => undefined
        });
        store.transaction((transaction) => store.record(transaction, evidence()));

        expect(() =>
            store.transaction((transaction) =>
                store.record(transaction, evidence(Digest.sha256(new TextEncoder().encode("substituted"))))
            )
        ).toThrow(/bound to another source attestation/);

        // The same physical storage cannot be wrapped under a foreign identity.
        expect(
            () =>
                new RunTargetLeaseEvidenceStore<RunTransaction>(tenant, target, storage, {
                    turn: () => undefined,
                    watermark: (_tx, h) => InvalidationWatermark.empty(tenant, target, h),
                    invocationIntent: () => undefined
                })
        ).toThrow(/belongs to another source Actor/);
    });

    test("[target-lease-evidence-store] persists the source-owned record through SQLite restart", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const storage = new SqliteRunStorage(database, tenant, source);
        let store = new RunTargetLeaseEvidenceStore<RunTransaction>(tenant, source, storage, {
            turn: () => undefined,
            watermark: (_tx, h) => InvalidationWatermark.empty(tenant, source, h),
            invocationIntent: () => undefined
        });
        const recorded = store.transaction((transaction) => store.record(transaction, evidence()));
        store = new RunTargetLeaseEvidenceStore<RunTransaction>(tenant, source, storage, {
            turn: () => undefined,
            watermark: (_tx, h) => InvalidationWatermark.empty(tenant, source, h),
            invocationIntent: () => undefined
        });
        const restored = store.transaction((transaction) =>
            store.evidence(transaction, key.idempotencyKey)
        );

        expect(restored?.digest().equals(recorded.digest())).toBe(true);
    });

    test("[target-lease-evidence-source] refuses a foreign owner over the same run storage", { tags: "p0" }, () => {
        const storage = new MemoryRunStorage(tenant, source);
        new RunTargetLeaseEvidenceStore<RunTransaction>(tenant, source, storage, {
            turn: () => undefined,
            watermark: (_tx, h) => InvalidationWatermark.empty(tenant, source, h),
            invocationIntent: () => undefined
        });
        expect(
            () =>
                new RunTargetLeaseEvidenceStore<RunTransaction>(tenant, target, storage, {
                    turn: () => undefined,
                    watermark: (_tx, h) => InvalidationWatermark.empty(tenant, target, h),
                    invocationIntent: () => undefined
                })
        ).toThrow(/belongs to another source Actor/);
        expect(
            () =>
                new RunTargetLeaseEvidenceStore<RunTransaction>(otherTenant, source, storage, {
                    turn: () => undefined,
                    watermark: (_tx, h) => InvalidationWatermark.empty(otherTenant, source, h),
                    invocationIntent: () => undefined
                })
        ).toThrow(/belongs to another source Actor/);
    });

    test("refuses a record whose source differs from its bound owner", { tags: "p0" }, () => {
        const storage = new MemoryRunStorage(tenant, source);
        const store = new RunTargetLeaseEvidenceStore<RunTransaction>(tenant, source, storage, {
            turn: () => undefined,
            watermark: (_tx, h) => InvalidationWatermark.empty(tenant, source, h),
            invocationIntent: () => undefined
        });
        const forgedKey = new TargetLeaseEvidenceKey(target, key.idempotencyKey);
        const base = evidence();
        const forged = TargetLeaseEvidence.fromData({
            ...base.toData(),
            key: forgedKey.toData(),
            watermark: InvalidationWatermark.empty(tenant, target, holder).toData()
        });
        expect(() =>
            store.transaction((transaction) => store.record(transaction, forged))
        ).toThrow(/belongs to another source Actor/);
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

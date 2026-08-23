import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    InvalidationWatermark,
    MemoryAuthorityPermitStore,
    MemoryTargetLeaseSourceStore,
    ScopeEpoch,
    TargetLeaseEvidence,
    TargetLeaseEvidenceKey,
    type TargetLeaseEvidenceSourceState
} from "../../src/authority";
import { RunId, TurnId, TurnLease, type LeaseToken } from "../../src/agents";
import { Digest } from "../../src/core";
import { ProtectionDomain } from "../../src/facets";
import { SqliteAuthorityPermitStore, SqliteTargetLeaseSourceStore } from "../../src/substrates";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
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
        const store = new MemoryTargetLeaseSourceStore(tenant, source);
        const recorded = store.transaction((transaction) => store.record(transaction, evidence()));
        const restarted = new MemoryTargetLeaseSourceStore(tenant, source, store.snapshot());
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
        const store = new MemoryTargetLeaseSourceStore(tenant, source);
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
        let store = new SqliteTargetLeaseSourceStore(database, tenant, source);
        const recorded = store.transaction((transaction) => store.record(transaction, evidence()));
        store = new SqliteTargetLeaseSourceStore(database, tenant, source);
        const restored = store.transaction((transaction) =>
            store.evidence(transaction, key.idempotencyKey)
        );

        expect(restored?.digest().equals(recorded.digest())).toBe(true);
    });

    test("refuses a record under another source Actor", { tags: "p0" }, () => {
        const store = new MemoryTargetLeaseSourceStore(tenant, target);
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

interface SourceAuthorityHarness {
    claim(turn: TurnId, expiresAt: Date): TurnLease;
    renew(token: LeaseToken, expiresAt: Date): TurnLease;
    fence(turn: TurnId): TurnLease;
    join(entries: readonly ScopeEpoch[]): InvalidationWatermark;
    delegate(run: RunId, intent: Digest): void;
    current(run: RunId, token: LeaseToken): TargetLeaseEvidenceSourceState | undefined;
    currentFor(actor: ActorRef, run: RunId, token: LeaseToken): TargetLeaseEvidenceSourceState | undefined;
    restart(): void;
}

function sourceAuthorityContract(name: string, create: () => SourceAuthorityHarness): void {
    describe(`source delegation authority (${name})`, () => {
        const turn = new TurnId("source-authority-turn");
        const run = new RunId("source-authority-run");
        const token: LeaseToken = Object.freeze({ turn, holder, epoch: 1 });
        const intent = Digest.sha256(new TextEncoder().encode(`${name}-delegation-intent`));
        const startsAt = new Date("2026-08-23T12:00:00.000Z");
        const scope = ScopeRef.workspace(tenant, new WorkspaceId(`source-authority-${name}`));

        test(
            "[target-lease-evidence-source] reads the real Turn lease, watermark, and delegation intent under one transaction",
            { tags: "p0" },
            () => {
                const harness = create();
                expect(harness.current(run, token)).toBeUndefined();

                const claimed = harness.claim(turn, new Date(startsAt.getTime() + 60_000));
                harness.delegate(run, intent);
                const current = harness.current(run, token);
                expect(current?.lease.admits(token, startsAt)).toBe(true);
                expect(claimed.expiresAt).toEqual(new Date(startsAt.getTime() + 60_000));
                expect(current?.invocationIntent.equals(intent)).toBe(true);
                expect(current?.watermark.ownerTenant.equals(tenant)).toBe(true);
                expect(current?.watermark.owner.equals(source)).toBe(true);

                const renewed = harness.renew(token, new Date(startsAt.getTime() + 120_000));
                expect(renewed.epoch).toBe(token.epoch);
                expect(harness.current(run, token)?.lease.admits(token, startsAt)).toBe(true);

                expect(harness.join([new ScopeEpoch(scope, 3)]).epoch(scope)).toBe(3);
                expect(harness.current(run, token)?.watermark.epoch(scope)).toBe(3);

                harness.fence(turn);
                expect(harness.current(run, token)?.lease.admits(token, startsAt)).toBe(false);
            }
        );

        test("[target-lease-evidence-source] answers only its exact owner and survives restart", { tags: "p0" }, () => {
            const harness = create();
            harness.claim(turn, new Date(startsAt.getTime() + 60_000));
            harness.delegate(run, intent);
            const before = harness.current(run, token);

            const stranger = new ActorRef("workspace", new ActorId(`${name}-stranger-source`));
            expect(harness.currentFor(stranger, run, token)).toBeUndefined();

            harness.restart();
            const after = harness.current(run, token);
            expect(after?.lease.admits(token, startsAt)).toBe(true);
            expect(after?.invocationIntent.equals(before!.invocationIntent)).toBe(true);
            expect(after?.lease.expiresAt).toEqual(before?.lease.expiresAt);
        });
    });
}

sourceAuthorityContract("memory", () => {
    let store = new MemoryTargetLeaseSourceStore(tenant, source);
    return {
        claim: (turnId, expiresAt) =>
            store.transaction((transaction) =>
                store.claimTurn(transaction, turnId, holder, expiresAt, sourceStartsAt)
            ),
        renew: (tokenValue, expiresAt) =>
            store.transaction((transaction) =>
                store.renewTurn(transaction, tokenValue, expiresAt, sourceStartsAt)
            ),
        fence: (turnId) => store.transaction((transaction) => store.fenceTurn(transaction, turnId)),
        join: (entries) =>
            store.transaction((transaction) => store.joinInvalidation(transaction, holder, entries)),
        delegate: (runId, digest) =>
            store.transaction((transaction) => store.delegateInvocation(transaction, runId, digest)),
        current: (runId, tokenValue) => store.transaction((transaction) => store.current(transaction, source, runId, tokenValue)),
        currentFor: (actor, runId, tokenValue) =>
            store.transaction((transaction) => store.current(transaction, actor, runId, tokenValue)),
        restart: () => {
            store = new MemoryTargetLeaseSourceStore(tenant, source, store.snapshot());
        }
    };
});

sourceAuthorityContract("sqlite", () => {
    const database = new TestSqlite();
    let store = new SqliteTargetLeaseSourceStore(database, tenant, source);
    return {
        claim: (turnId, expiresAt) =>
            store.transaction((transaction) =>
                store.claimTurn(transaction, turnId, holder, expiresAt, sourceStartsAt)
            ),
        renew: (tokenValue, expiresAt) =>
            store.transaction((transaction) =>
                store.renewTurn(transaction, tokenValue, expiresAt, sourceStartsAt)
            ),
        fence: (turnId) => store.transaction((transaction) => store.fenceTurn(transaction, turnId)),
        join: (entries) =>
            store.transaction((transaction) => store.joinInvalidation(transaction, holder, entries)),
        delegate: (runId, digest) =>
            store.transaction((transaction) => store.delegateInvocation(transaction, runId, digest)),
        current: (runId, tokenValue) => store.transaction((transaction) => store.current(transaction, source, runId, tokenValue)),
        currentFor: (actor, runId, tokenValue) =>
            store.transaction((transaction) => store.current(transaction, actor, runId, tokenValue)),
        restart: () => {
            store = new SqliteTargetLeaseSourceStore(database, tenant, source);
        }
    };
});

const sourceStartsAt = new Date("2026-08-23T12:00:00.000Z");

test("SQLite binds the source aggregate to exactly one owning Actor", { tags: "p0" }, () => {
    const database = new TestSqlite();
    new SqliteTargetLeaseSourceStore(database, tenant, source);
    expect(
        () => new SqliteTargetLeaseSourceStore(database, tenant, target)
    ).toThrow(/bound to a different Actor/);
});

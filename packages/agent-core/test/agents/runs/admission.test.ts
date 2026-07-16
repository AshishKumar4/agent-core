import { describe, expect, it } from "vitest";
import { Revision } from "../../../src/core";
import { RunCommitId } from "../../../src/execution-references";
import { ApprovalId, EffectAttemptId } from "../../../src/invocation-references";
import { InvocationId, RouteReservationId } from "../../../src/interaction-references";
import {
    RunAdmissionRegistry,
    RunAdmissionRegistryCodec,
    decodeRunObligation,
    runObligationKey,
    type RunObligation
} from "../../../src/agents/runs/admission";
import { RunCommit } from "../../../src/agents/runs/commit";
import { RunId } from "../../../src/agents/runs/id";
import {
    SettlementObligation,
    TerminalSnapshot,
    isSettled
} from "../../../src/agents/runs/settlement";
import {
    content,
    genesis,
    harness,
    ids,
    pins,
    seedRunningTurn,
    settlementAuditKey
} from "./fixture";

const invocation = new InvocationId("admission-invocation");
const route = new RouteReservationId("admission-route");
const approval = new ApprovalId("admission-approval");
const attempt = new EffectAttemptId("admission-attempt");
const systemCommit = new RunCommitId("admission-system-commit");
const item: RunObligation = Object.freeze({
    kind: "invocationItem",
    invocation,
    itemIndex: 2,
    itemKey: "admission-item-key"
});

describe("durable Run admission registry", () => {
    it("round-trips immutable canonical state and rejects malformed completion sets", () => {
        const reserved = RunAdmissionRegistry.initial(ids.run).reserve(item);
        const completed = reserved.registry.complete(reserved.reservation);
        const decoded = RunAdmissionRegistryCodec.decode(
            RunAdmissionRegistryCodec.encode(completed)
        );

        expect(decoded).toEqual(completed);
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(Object.isFrozen(decoded.reserved)).toBe(true);
        expect(
            () =>
                new RunAdmissionRegistry({
                    run: ids.run,
                    epoch: 0,
                    accepting: true,
                    reserved: [],
                    completed: [item]
                })
        ).toThrow(/must be reserved/);
        expect(
            () =>
                new RunAdmissionRegistry({
                    run: ids.run,
                    epoch: 0,
                    accepting: true,
                    reserved: [item, item],
                    completed: []
                })
        ).toThrow(/unique canonical/);
    });

    it("[C13-ADV-POST-TERMINAL-ROUTE] reuses duplicate reservations, completes idempotently, and rejects substitutions", () => {
        const first = RunAdmissionRegistry.initial(ids.run).reserve(item);
        const duplicate = first.registry.reserve({ ...item });
        expect(duplicate.registry).toBe(first.registry);
        expect(duplicate.reservation).toEqual(first.reservation);

        const completed = first.registry.complete(first.reservation);
        expect(completed.complete(first.reservation)).toBe(completed);
        expect(
            first.registry.accepts({
                ...first.reservation,
                obligation: { ...item, itemKey: "substituted" }
            })
        ).toBe(false);
        expect(
            first.registry.accepts({
                ...first.reservation,
                registryEpoch: first.reservation.registryEpoch + 1
            })
        ).toBe(false);
        expect(
            first.registry.accepts({
                ...first.reservation,
                run: new RunId("other-admission-run")
            })
        ).toBe(false);
        expect(
            first.registry.accepts({
                ...first.reservation,
                obligation: { kind: "approval", approval: ids.run } as never
            })
        ).toBe(false);
        expect(() =>
            first.registry.complete({
                ...first.reservation,
                obligation: { kind: "approval", approval: ids.run } as never
            })
        ).toThrow(/exact reserved/);
    });

    it("[C13-ADV-POST-FENCE-SYSTEM-EVIDENCE] captures exactly reserved minus completed and rejects every post-close race", () => {
        let registry = RunAdmissionRegistry.initial(ids.run);
        const completed = registry.reserve({ kind: "approval", approval });
        registry = completed.registry.complete(completed.reservation);
        const pending = [
            item,
            { kind: "route", reservation: route } as const,
            { kind: "reconciliation", attempt } as const,
            { kind: "systemCommit", commit: systemCommit } as const
        ];
        const reservations = pending.map((obligation) => {
            const result = registry.reserve(obligation);
            registry = result.registry;
            return result.reservation;
        });
        const closed = registry.close();

        expect(closed.epoch).toBe(1);
        expect(closed.accepting).toBe(false);
        expect(closed.close()).toBe(closed);
        expect(closed.frontier().map(runObligationKey)).toEqual(
            [...pending]
                .sort((left, right) =>
                    runObligationKey(left).localeCompare(runObligationKey(right))
                )
                .map(runObligationKey)
        );
        expect(closed.frontier().some((value) => value.kind === "approval")).toBe(false);
        expect(reservations.every((reservation) => !closed.accepts(reservation))).toBe(true);
        expect(() => closed.reserve({ kind: "approval", approval })).toThrow(/closed/);
        const completedAfterClose = closed.complete(reservations[0]!);
        expect(completedAfterClose.complete(reservations[0]!)).toBe(completedAfterClose);
        expect(completedAfterClose.frontier()).toHaveLength(pending.length - 1);
        expect(() =>
            closed.complete({
                ...reservations[0]!,
                registryEpoch: reservations[0]!.registryEpoch - 1
            })
        ).toThrow(/exact reserved/);
    });

    it("[C13-ADV-UNEQUAL-PIN-MERGE] persists reservations and completion across a memory restart", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const done = value.runtime.reserveRunObligation(ids.run, {
            kind: "approval",
            approval
        });
        value.runtime.completeRunObligation(done);
        value.runtime.completeRunObligation(done);
        const pending = value.runtime.reserveRunObligation(ids.run, item);

        const restarted = harness(value.storage.snapshot());
        const restored = restarted.repository.transaction((transaction) =>
            restarted.repository.loadAdmission(transaction, ids.run)!
        );
        expect(restored.frontier()).toEqual([pending.obligation]);
        expect(restarted.runtime.acceptsRunAdmission(pending)).toBe(true);
    });

    it("fails closed when durable admission is omitted and when its epoch is exhausted", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const snapshot = value.storage.snapshot();
        const restarted = harness({
            ...snapshot,
            records: snapshot.records.filter((record) => record.kind !== "admission")
        });
        const reservation = Object.freeze({
            run: ids.run,
            registryEpoch: 0,
            obligation: item
        });

        expect(restarted.runtime.acceptsRunAdmission(reservation)).toBe(false);
        expect(() => restarted.runtime.reserveRunObligation(ids.run, item)).toThrow(
            /admission registry is missing/
        );

        const exhausted = new RunAdmissionRegistry({
            run: ids.run,
            epoch: Number.MAX_SAFE_INTEGER,
            accepting: true,
            reserved: [],
            completed: []
        });
        expect(() => exhausted.close()).toThrow(/epoch is exhausted/);
    });

    it("rejects malformed registry and reservation identities before admission", () => {
        expect(
            () =>
                new RunAdmissionRegistry({
                    run: ids.agent as never,
                    epoch: 0,
                    accepting: true,
                    reserved: [],
                    completed: []
                })
        ).toThrow(/exact Run ID/);
        expect(
            () =>
                new RunAdmissionRegistry({
                    run: ids.run,
                    epoch: -1,
                    accepting: true,
                    reserved: [],
                    completed: []
                })
        ).toThrow(/non-negative/);
        expect(
            () =>
                new RunAdmissionRegistry({
                    run: ids.run,
                    epoch: 0,
                    accepting: "yes" as never,
                    reserved: [],
                    completed: []
                })
        ).toThrow(/accepting state/);
        expect(
            () =>
                new RunAdmissionRegistry({
                    run: ids.run,
                    epoch: 0,
                    accepting: false,
                    reserved: [],
                    completed: []
                })
        ).toThrow(/advanced epoch/);
        expect(() =>
            RunAdmissionRegistry.fromData({
                accepting: "yes",
                completed: [],
                epoch: 0,
                reserved: [],
                run: ids.run.value
            } as never)
        ).toThrow(/accepting state/);
        expect(
            () =>
                new RunAdmissionRegistry({
                    run: ids.run,
                    epoch: 0,
                    accepting: true,
                    reserved: null as never,
                    completed: []
                })
        ).toThrow(/array/);

        const malformed: readonly RunObligation[] = [
            { kind: "invocationItem", invocation: ids.run as never, itemIndex: 0, itemKey: "key" },
            { kind: "invocationItem", invocation, itemIndex: -1, itemKey: "key" },
            { kind: "invocationItem", invocation, itemIndex: 0, itemKey: "" },
            { kind: "route", reservation: ids.run as never },
            { kind: "reconciliation", attempt: ids.run as never },
            { kind: "systemCommit", commit: ids.run as never },
            { kind: "unknown" } as never
        ];
        for (const obligation of malformed) {
            expect(() => RunAdmissionRegistry.initial(ids.run).reserve(obligation)).toThrow(
                TypeError
            );
        }
        expect(() => decodeRunObligation({ kind: "unknown" } as never)).toThrow(/kind/);

        const registry = RunAdmissionRegistry.initial(ids.run).reserve(item).registry;
        expect(() =>
            registry.complete({
                run: ids.run,
                registryEpoch: 0,
                obligation: { kind: "approval", approval }
            })
        ).toThrow(/exact reserved/);
    });
});

describe("transactional terminal frontier", () => {
    it("[C13-RUN-SETTLED-DERIVED] captures a nonempty exact frontier and derives all settlement categories", () => {
        const value = seedRunningTurn();
        const obligations: readonly RunObligation[] = [
            { kind: "approval", approval },
            item,
            { kind: "route", reservation: route },
            { kind: "reconciliation", attempt },
            { kind: "systemCommit", commit: systemCommit }
        ];
        const reservations = obligations.map((obligation) =>
            value.runtime.reserveRunObligation(ids.run, obligation)
        );
        const snapshot = value.runtime.terminalizeRun(terminalRequest(value, "admission-terminal"));

        expect(snapshot.obligation.registryEpoch).toBe(1);
        expect(snapshot.obligation.obligations.map(runObligationKey)).toEqual(
            [...obligations]
                .sort((left, right) =>
                    runObligationKey(left).localeCompare(runObligationKey(right))
                )
                .map(runObligationKey)
        );
        expect(snapshot.obligation.requiredAudits.map((audit) => audit.kind).sort()).toEqual([
            "commit",
            "delivery",
            "receipt"
        ]);
        value.runtime.completeRunObligation(reservations[0]!);
        expect(snapshot.obligation.obligations).toHaveLength(obligations.length);
        expect(
            value.repository.transaction(
                (transaction) =>
                    value.repository.loadAdmission(transaction, ids.run)?.frontier().length
            )
        ).toBe(obligations.length - 1);
        expect(value.runtime.settled(ids.run)).toBe(false);
        value.settlement.approvals.add(approval.value);
        value.settlement.terminalItems.add(`${invocation.value}:2:admission-item-key`);
        value.settlement.terminalRoutes.add(route.value);
        value.settlement.reconciliations.add(attempt.value);
        value.settlement.commits.add(systemCommit.value);
        for (const audit of snapshot.obligation.requiredAudits) {
            value.settlement.audits.add(settlementAuditKey(audit));
        }
        expect(value.runtime.settled(ids.run)).toBe(true);
    });

    it("[C13-RUN-FRONTIER-EMPTY] records an honestly empty frontier", () => {
        const value = seedRunningTurn();
        const snapshot = value.runtime.terminalizeRun(terminalRequest(value, "empty-terminal"));
        expect(snapshot.obligation.obligations).toEqual([]);
        expect(snapshot.obligation.registryEpoch).toBe(1);
        expect(value.runtime.settled(ids.run)).toBe(true);
    });

    it("[C13-ADV-POST-TERMINAL-CONTROL] rolls back close on terminalization failure", () => {
        const value = seedRunningTurn();
        const reservation = value.runtime.reserveRunObligation(ids.run, item);
        const invalid = terminalRequest(value, "invalid-terminal");
        const wrongCommit = new RunCommit({
            id: new RunCommitId("invalid-parent-terminal"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [new RunCommitId("not-the-head")],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("e")
        });
        expect(() => value.runtime.terminalizeRun({ ...invalid, commit: wrongCommit })).toThrow(
            /current branch head/
        );
        expect(value.runtime.acceptsRunAdmission(reservation)).toBe(true);
    });

    it("[C13-ADV-POST-TERMINAL-PREPARATION] requires every canonical settlement identity without accepting broad Invocation evidence", () => {
        const obligation = new SettlementObligation({
            registryEpoch: 1,
            obligations: [item]
        });
        const value = harness();
        for (const audit of obligation.requiredAudits) {
            value.settlement.audits.add(settlementAuditKey(audit));
        }
        value.settlement.terminalItems.add(`${invocation.value}:1:admission-item-key`);
        expect(isSettled({}, obligation, value.settlement)).toBe(false);
        value.settlement.terminalItems.add(`${invocation.value}:2:admission-item-key`);
        expect(isSettled({}, obligation, value.settlement)).toBe(true);
    });

    it("[C13-RUN-FRONTIER-COMPLETE] requires each captured obligation and each derived audit independently", () => {
        const obligations: readonly RunObligation[] = [
            { kind: "approval", approval },
            item,
            { kind: "route", reservation: route },
            { kind: "reconciliation", attempt },
            { kind: "systemCommit", commit: systemCommit }
        ];
        const obligation = new SettlementObligation({
            registryEpoch: 1,
            obligations
        });
        expect(obligation.requiredAudits.map((audit) => audit.kind).sort()).toEqual([
            "commit",
            "delivery",
            "receipt"
        ]);
        const value = harness();
        value.settlement.approvals.add(approval.value);
        value.settlement.terminalItems.add(`${invocation.value}:2:admission-item-key`);
        value.settlement.terminalRoutes.add(route.value);
        value.settlement.reconciliations.add(attempt.value);
        value.settlement.commits.add(systemCommit.value);
        for (const audit of obligation.requiredAudits) {
            value.settlement.audits.add(settlementAuditKey(audit));
        }

        const evidenceSets = [
            [value.settlement.approvals, approval.value],
            [value.settlement.terminalItems, `${invocation.value}:2:admission-item-key`],
            [value.settlement.terminalRoutes, route.value],
            [value.settlement.reconciliations, attempt.value],
            [value.settlement.commits, systemCommit.value],
            ...obligation.requiredAudits.map(
                (audit) => [value.settlement.audits, settlementAuditKey(audit)] as const
            )
        ] as const;
        for (const [set, key] of evidenceSets) {
            set.delete(key);
            expect(isSettled({}, obligation, value.settlement), key).toBe(false);
            set.add(key);
        }
        expect(isSettled({}, obligation, value.settlement)).toBe(true);
    });

    it("[C13-RUN-RESERVATION-EPOCH] rejects malformed settlement epochs, timestamps, and obligation identities", () => {
        expect(
            () =>
                new SettlementObligation({
                    registryEpoch: -1,
                    obligations: []
                })
        ).toThrow(/registry epoch/);
        expect(
            () =>
                new TerminalSnapshot(
                    ids.run,
                    ids.turn,
                    ids.root,
                    ids.root,
                    "succeeded",
                    new SettlementObligation({
                        registryEpoch: 1,
                        obligations: []
                    }),
                    new Date(Number.NaN)
                )
        ).toThrow(/Terminal time/);

        for (const malformed of [
            {
                kind: "invocationItem" as const,
                invocation: ids.run as never,
                itemIndex: 0,
                itemKey: "k"
            },
            { kind: "route" as const, reservation: ids.run as never },
            { kind: "systemCommit" as const, commit: ids.run as never }
        ]) {
            expect(
                () =>
                    new SettlementObligation({
                        registryEpoch: 1,
                        obligations: [malformed]
                    })
            ).toThrow(TypeError);
        }
    });
});

function terminalRequest(value: ReturnType<typeof seedRunningTurn>, commitId: string) {
    return {
        run: ids.run,
        turn: ids.turn,
        expectedRunRevision: value.repository.transaction(
            (transaction) => value.repository.loadRun(transaction, ids.run)!.revision
        ),
        expectedTurnRevision: value.running.revision,
        expectedBranchRevision: new Revision(0),
        token: value.token,
        outcome: "succeeded" as const,
        commit: new RunCommit({
            id: new RunCommitId(commitId),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("f")
        }),
        siblingCancellations: new Map(),
        now: new Date(2000)
    };
}

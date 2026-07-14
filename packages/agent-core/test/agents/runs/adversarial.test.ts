import { describe, expect, it } from "vitest";
import { Revision } from "../../../src/core";
import { PrincipalId } from "../../../src/identity";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { RunCommit, RunCommitCodec, validateCommitWriter } from "../../../src/agents/runs/commit";
import { AgentId } from "../../../src/agents/id";
import { MemoryRunStorage } from "../../../src/agents/runs/memory";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { RunConfigurationSnapshot } from "../../../src/agents/runs/pins";
import { RunPins } from "../../../src/agents/runs/pins";
import { RunBranch } from "../../../src/agents/runs/run";
import { RunBranchId } from "../../../src/agents/runs/id";
import { RunRepository } from "../../../src/agents/runs/store";
import { Turn, TurnInboxEntry, TurnStatus } from "../../../src/agents/runs/turn";
import { TurnLease } from "../../../src/agents/runs/lease";
import { TurnInboxEntryId } from "../../../src/agents/runs/id";
import { configuration, content, digest, genesis, harness, ids, pins, refs } from "./fixture";

function runningHarness(turnId = ids.turn) {
    const value = harness();
    value.runtime.createRun(genesis());
    const placement = new TurnPlacementSnapshot(turnId, pins(), []);
    const queued = new Turn({
        id: turnId,
        run: ids.run,
        branch: ids.branch,
        startHead: ids.root,
        effectiveInput: ids.root,
        pins: pins(),
        placement: placement.digest,
        input: content("a"),
        revision: new Revision(0)
    });
    value.runtime.createTurn({ turn: queued, placement }, new Revision(0));
    const running = value.runtime.claimTurn(
        turnId,
        new Revision(0),
        ids.holder,
        new Date(1000),
        new Date(5000)
    );
    return {
        ...value,
        running,
        token: Object.freeze({ turn: turnId, holder: ids.holder, epoch: 1 })
    };
}

function cancellation(turn: Turn, sequence = 0): TurnInboxEntry {
    if (turn.lease.holder === undefined) throw new TypeError("Test Turn must be held");
    return new TurnInboxEntry(
        new TurnInboxEntryId(`cancel-${turn.id.value}-${sequence}`),
        turn.id,
        sequence,
        "turn.cancel",
        content("b"),
        digest("b"),
        `cancel-key-${turn.id.value}-${sequence}`,
        { turn: turn.id, holder: turn.lease.holder, epoch: turn.lease.epoch },
        new Date(5000)
    );
}

describe("W5 adversarial invariants", () => {
    it("[C13-ADV-INCOMPLETE-PACKAGE-CLOSURE] rejects genesis when the authoritative Package closure is incomplete", () => {
        const value = harness();
        value.sources.acceptsClosure = false;
        expect(() => value.runtime.createRun(genesis())).toThrow(/source revisions/);
        expect(
            value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run))
        ).toBeUndefined();
    });

    it("returns false for missing ancestry endpoints", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        expect(
            value.repository.transaction((tx) =>
                value.repository.isAncestor(tx, new RunCommitId("missing"), ids.root)
            )
        ).toBe(false);
        expect(
            value.repository.transaction((tx) =>
                value.repository.isAncestor(tx, ids.root, new RunCommitId("missing"))
            )
        ).toBe(false);
    });

    it("composes transaction-scoped genesis with outer rollback and rejects nesting", () => {
        const value = harness();
        expect(() =>
            value.repository.transaction((tx) => {
                value.runtime.createRunInTransaction(tx, genesis());
                throw new Error("outer failure");
            })
        ).toThrow("outer failure");
        expect(
            value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run))
        ).toBeUndefined();
        expect(() =>
            value.repository.transaction(() => value.runtime.createRun(genesis()))
        ).toThrow(/Nested/);
    });

    it("[C13-TURN-EFFECT-ATTEMPT-WRITER] rejects nonfresh ordinary Turn genesis", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        const forged = new Turn({
            id: ids.turn,
            run: ids.run,
            branch: ids.branch,
            startHead: ids.root,
            effectiveInput: ids.root,
            pins: pins(),
            placement: placement.digest,
            input: content("c"),
            status: TurnStatus.running,
            lease: TurnLease.restore(ids.turn, ids.holder, 9, new Date(5000)),
            revision: new Revision(4)
        });
        expect(() =>
            value.runtime.createTurn({ turn: forged, placement }, new Revision(0))
        ).toThrow(/genesis/);
    });

    it("[C13-ADV-TURN-MERGE] rejects completing one Turn with another Turn's valid commit", () => {
        const value = runningHarness();
        const otherId = new TurnId("turn-other");
        const otherPlacement = new TurnPlacementSnapshot(otherId, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: otherId,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: otherPlacement.digest,
                    input: content("e"),
                    revision: new Revision(0)
                }),
                placement: otherPlacement
            },
            new Revision(0)
        );
        const other = value.runtime.claimTurn(
            otherId,
            new Revision(0),
            new PrincipalId("other-holder"),
            new Date(1000),
            new Date(5000)
        );
        const otherToken = { turn: otherId, holder: new PrincipalId("other-holder"), epoch: 1 };
        const commit = new RunCommit({
            id: new RunCommitId("other-result"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: otherToken },
            subjectTurn: otherId,
            content: content("f")
        });
        expect(() =>
            value.runtime.completeTurn({
                turn: ids.turn,
                expectedTurnRevision: value.running.revision,
                expectedBranchRevision: new Revision(0),
                token: value.token,
                outcome: "succeeded",
                commit,
                now: new Date(1500)
            })
        ).toThrow(/result commit/);
        expect(
            value.repository.transaction((tx) => value.repository.loadCommit(tx, commit.id))
        ).toBeUndefined();
        expect(other.status.kind).toBe("running");
    });

    it("atomically records displaced-token cancellation on reclaim", () => {
        const value = runningHarness();
        const entry = cancellation(value.running);
        const reclaimed = value.runtime.reclaimTurn(
            ids.turn,
            value.running.revision,
            new PrincipalId("replacement"),
            new Date(5000),
            new Date(9000),
            entry
        );
        expect(reclaimed.lease.epoch).toBe(2);
        expect(reclaimed.lease.holder?.value).toBe("replacement");
        expect(
            value.repository.transaction((tx) => value.repository.listInbox(tx, ids.turn))
        ).toEqual([entry]);
    });

    it("atomically commits held cancellation result, inbox event, and fence", () => {
        const value = runningHarness();
        const result = new RunCommit({
            id: new RunCommitId("cancelled-result"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("7")
        });
        value.runtime.cancelHeldTurn(
            {
                turn: ids.turn,
                expectedTurnRevision: value.running.revision,
                expectedBranchRevision: new Revision(0),
                token: value.token,
                outcome: "cancelled",
                commit: result,
                now: new Date(1500)
            },
            cancellation(value.running)
        );
        const cancelled = value.repository.transaction((tx) =>
            value.repository.loadTurn(tx, ids.turn)!
        );
        expect(cancelled.status.kind).toBe("cancelled");
        expect(cancelled.lease.holder).toBeUndefined();
        expect(
            value.repository.transaction((tx) => value.repository.listInbox(tx, ids.turn))
        ).toHaveLength(1);
    });

    it("times out only an expired held Turn and records its exact displaced token", () => {
        const value = runningHarness();
        expect(() =>
            value.runtime.timeoutTurn(
                ids.turn,
                value.running.revision,
                cancellation(value.running),
                new Date(4999)
            )
        ).toThrow(/expired/);
        const timedOut = value.runtime.timeoutTurn(
            ids.turn,
            value.running.revision,
            cancellation(value.running),
            new Date(5000)
        );
        expect(timedOut.status.kind).toBe("cancelled");
        expect(timedOut.lease.epoch).toBe(2);
    });

    it("rejects reserved cancellation through generic delivery", () => {
        const value = runningHarness();
        expect(() =>
            value.runtime.deliverEvent(
                ids.turn,
                value.running.revision,
                value.token,
                cancellation(value.running),
                new Date(1500)
            )
        ).toThrow(/sequence/);
        expect(
            value.repository.transaction((tx) => value.repository.listInbox(tx, ids.turn))
        ).toEqual([]);
    });

    it("delivers an ordinary event at the next durable inbox sequence", () => {
        const value = runningHarness();
        const entry = new TurnInboxEntry(
            new TurnInboxEntryId("ordinary-event"),
            ids.turn,
            0,
            "message.received",
            content("c"),
            digest("c"),
            "message-key",
            undefined,
            new Date(1500)
        );
        value.runtime.deliverEvent(
            ids.turn,
            value.running.revision,
            value.token,
            entry,
            new Date(1500)
        );
        expect(
            value.repository.transaction((tx) => value.repository.loadInbox(tx, entry.id))
        ).toEqual(entry);
    });

    it("[C13-ADV-WRONG-TURN-LEASE] rejects undo while a branch Turn holds an unexpired lease", () => {
        const value = runningHarness();
        const undo = new RunCommit({
            id: new RunCommitId("undo-live"),
            run: ids.run,
            branch: ids.branch,
            kind: "undo",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            selects: ids.root,
            receipt: refs.receipt
        });
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: undo.proposalDigest.value
        });
        expect(() => value.runtime.appendCommit(undo, new Revision(0), new Date(1500))).toThrow(
            /fenced/
        );

        const expired = runningHarness();
        const expiredUndo = new RunCommit({
            id: new RunCommitId("undo-expired-held"),
            run: ids.run,
            branch: ids.branch,
            kind: "undo",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            selects: ids.root,
            receipt: refs.receipt
        });
        expired.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: expiredUndo.proposalDigest.value
        });
        expect(() =>
            expired.runtime.appendCommit(expiredUndo, new Revision(0), new Date(5000))
        ).toThrow(/fenced/);
    });

    it("[MIGRATE-RUN-PINS] rejects an invalid target pin snapshot without partial persistence", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const migration = new RunCommit({
            id: new RunCommitId("migration-unverified"),
            run: ids.run,
            branch: ids.branch,
            kind: "migration",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            receipt: refs.receipt,
            migration: { from: pins(), to: pins() }
        });
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: migration.proposalDigest.value
        });
        value.sources.accepts = false;
        expect(() =>
            value.runtime.migrateRun(migration, configuration(), new Revision(0), new Date(1000))
        ).toThrow(/authoritative/);
        expect(
            value.repository.transaction((tx) => value.repository.loadCommit(tx, migration.id))
        ).toBeUndefined();
        value.sources.accepts = true;
        const current = configuration();
        const mismatchedTarget = new RunConfigurationSnapshot({
            pins: new RunPins({
                ...current.pins,
                effectivePolicy: {
                    ...current.pins.effectivePolicy,
                    revision: current.pins.effectivePolicy.revision.next()
                }
            })
        });
        expect(() =>
            value.runtime.migrateRun(migration, mismatchedTarget, new Revision(0), new Date(1000))
        ).toThrow(/authoritative/);
        expect(
            value.repository.transaction((tx) =>
                value.repository.loadConfiguration(tx, mismatchedTarget.id.value)
            )
        ).toBeUndefined();
    });

    it("[C13-RUN-PINS-PACKAGES] [MIGRATE-RUN-PINS] rejects incomplete Package closure and a wrong Agent", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const migration = new RunCommit({
            id: new RunCommitId("migration-incomplete"),
            run: ids.run,
            branch: ids.branch,
            kind: "migration",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            receipt: refs.receipt,
            migration: { from: pins(), to: pins() }
        });
        value.sources.acceptsClosure = false;
        expect(() =>
            value.runtime.migrateRun(migration, configuration(), new Revision(0), new Date(1000))
        ).toThrow(/authoritative/);
        value.sources.acceptsClosure = true;
        const current = configuration();
        const otherAgent = new RunConfigurationSnapshot({
            pins: new RunPins({
                ...current.pins,
                agent: { ...current.pins.agent, id: new AgentId("other-agent") }
            })
        });
        const wrongAgentMigration = new RunCommit({
            id: new RunCommitId("migration-wrong-agent"),
            run: ids.run,
            branch: ids.branch,
            kind: "migration",
            parents: [ids.root],
            pins: otherAgent.pins,
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            receipt: refs.receipt,
            migration: { from: current.pins, to: otherAgent.pins }
        });
        expect(() =>
            value.runtime.migrateRun(
                wrongAgentMigration,
                otherAgent,
                new Revision(0),
                new Date(1000)
            )
        ).toThrow(/authoritative/);
        expect(
            value.repository.transaction((tx) =>
                value.repository.loadConfiguration(tx, otherAgent.id.value)
            )
        ).toBeUndefined();
    });

    it("persists a verified explicit migration snapshot and commit", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const admission = value.runtime.reserveRunObligation(ids.run, {
            kind: "invocationItem",
            invocation: refs.invocation,
            itemIndex: 0,
            itemKey: "migration-admission"
        });
        const migration = new RunCommit({
            id: new RunCommitId("migration-verified"),
            run: ids.run,
            branch: ids.branch,
            kind: "migration",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            receipt: refs.receipt,
            migration: { from: pins(), to: pins() }
        });
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: migration.proposalDigest.value
        });
        value.runtime.migrateRun(migration, configuration(), new Revision(0), new Date(1000));
        expect(value.runtime.effectiveCommit(ids.run, ids.branch).equals(migration.id)).toBe(true);
        expect(
            value.repository.transaction((tx) =>
                value.repository.loadConfiguration(tx, configuration().id.value)
            )
        ).toBeDefined();
        expect(value.runtime.acceptsRunAdmission(admission)).toBe(true);
    });

    it("[C13-RUN-EXPLICIT-MIGRATION] [MIGRATE-RUN-PINS] preserves old Turn pins, adopts exact new pins, rejects unequal merges, and survives restart", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const oldBranch = new RunBranch(
            new RunBranchId("old-pins"),
            ids.run,
            "old-pins",
            ids.root,
            new Revision(0)
        );
        value.runtime.createBranch(ids.run, oldBranch, new Revision(0));
        const current = configuration();
        const oldTurnId = new TurnId("pre-migration-turn");
        const oldPlacement = new TurnPlacementSnapshot(oldTurnId, current.pins, []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: oldTurnId,
                    run: ids.run,
                    branch: oldBranch.id,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: current.pins,
                    placement: oldPlacement.digest,
                    input: content("6"),
                    revision: new Revision(0)
                }),
                placement: oldPlacement
            },
            new Revision(0)
        );
        const nextPins = new RunPins({
            blueprint: current.pins.blueprint,
            packages: current.pins.packages,
            agent: { ...current.pins.agent, revision: new Revision(4), digest: digest("7") },
            effectivePolicy: {
                ...current.pins.effectivePolicy,
                revision: new Revision(4),
                digest: digest("8")
            },
            modelPolicy: {
                ...current.pins.modelPolicy,
                revision: new Revision(4),
                digest: digest("9")
            },
            environment: {
                ...current.pins.environment,
                revision: new Revision(4),
                digest: digest("a")
            }
        });
        const target = new RunConfigurationSnapshot({ pins: nextPins });
        expect(target.pins.agent.id.equals(current.pins.agent.id)).toBe(true);
        expect(target.pins.agent.revision.equals(current.pins.agent.revision)).toBe(false);
        expect(target.pins.effectivePolicy.digest.equals(current.pins.effectivePolicy.digest)).toBe(
            false
        );
        expect(target.pins.modelPolicy.digest.equals(current.pins.modelPolicy.digest)).toBe(false);
        expect(target.pins.environment.digest.equals(current.pins.environment.digest)).toBe(false);
        const migration = new RunCommit({
            id: new RunCommitId("changed-migration"),
            run: ids.run,
            branch: ids.branch,
            kind: "migration",
            parents: [ids.root],
            pins: nextPins,
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            receipt: refs.receipt,
            migration: { from: current.pins, to: nextPins }
        });
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: migration.proposalDigest.value
        });
        value.runtime.migrateRun(migration, target, new Revision(0), new Date(1000));
        const migratedRun = value.repository.transaction((tx) =>
            value.repository.loadRun(tx, ids.run)!
        );
        expect(migratedRun.configurations.map((entry) => entry.value)).toEqual([
            current.id.value,
            target.id.value
        ]);

        const descendantId = new TurnId("post-migration-turn");
        const placement = new TurnPlacementSnapshot(descendantId, nextPins, []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: descendantId,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: migration.id,
                    effectiveInput: migration.id,
                    pins: nextPins,
                    placement: placement.digest,
                    input: content("7"),
                    revision: new Revision(0)
                }),
                placement
            },
            new Revision(1)
        );
        expect(
            value.repository
                .transaction((tx) => value.repository.loadTurn(tx, oldTurnId)!.pins)
                .equals(current.pins)
        ).toBe(true);
        expect(
            value.repository
                .transaction((tx) => value.repository.loadTurn(tx, descendantId)!.pins)
                .equals(target.pins)
        ).toBe(true);

        const unequal = new RunCommit({
            id: new RunCommitId("unequal-merge"),
            run: ids.run,
            branch: ids.branch,
            kind: "merge",
            parents: [migration.id, ids.root],
            pins: nextPins,
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            content: content("8"),
            resolution: { kind: "concat" },
            receipt: refs.receipt
        });
        expect(() => value.runtime.appendCommit(unequal, new Revision(1), new Date(1100))).toThrow(
            /equal-pinned/
        );

        const rollback = new RunCommit({
            id: new RunCommitId("migration-rollback"),
            run: ids.run,
            branch: ids.branch,
            kind: "undo",
            parents: [migration.id],
            pins: nextPins,
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            selects: ids.root,
            receipt: refs.receipt
        });
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: rollback.proposalDigest.value
        });
        value.runtime.appendCommit(rollback, new Revision(1), new Date(1200));
        expect(value.runtime.effectiveCommit(ids.run, ids.branch).equals(ids.root)).toBe(true);

        const restarted = harness(value.storage.snapshot());
        const restoredMigration = restarted.repository.transaction((tx) =>
            restarted.repository.loadCommit(tx, migration.id)
        );
        expect(restoredMigration?.migration?.from.equals(current.pins)).toBe(true);
        expect(restoredMigration?.migration?.to.equals(target.pins)).toBe(true);
        expect(
            restarted.repository.transaction((tx) =>
                restarted.repository.loadTurn(tx, oldTurnId)!.pins.equals(current.pins)
            )
        ).toBe(true);
        expect(
            restarted.repository.transaction((tx) =>
                restarted.repository.loadTurn(tx, descendantId)!.pins.equals(target.pins)
            )
        ).toBe(true);
        expect(
            restarted.repository
                .transaction((tx) => restarted.repository.loadCommit(tx, rollback.id))
                ?.selects?.equals(ids.root)
        ).toBe(true);
    });

    it("[C13-WRITER-SYSTEM-MERGE] admits only captured system evidence after terminalization", () => {
        const value = runningHarness();
        const evidenceId = new RunCommitId("captured-evidence");
        const controlId = new RunCommitId("captured-control");
        value.runtime.reserveRunObligation(ids.run, {
            kind: "systemCommit",
            commit: evidenceId
        });
        value.runtime.reserveRunObligation(ids.run, {
            kind: "systemCommit",
            commit: controlId
        });
        const result = new RunCommit({
            id: new RunCommitId("terminal-result"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("8")
        });
        value.runtime.terminalizeRun({
            run: ids.run,
            turn: ids.turn,
            expectedRunRevision: value.repository.transaction(
                (tx) => value.repository.loadRun(tx, ids.run)!.revision
            ),
            expectedTurnRevision: value.running.revision,
            expectedBranchRevision: new Revision(0),
            token: value.token,
            outcome: "succeeded",
            commit: result,
            siblingCancellations: new Map(),
            now: new Date(1500)
        });
        const evidence = new RunCommit({
            id: evidenceId,
            run: ids.run,
            branch: ids.branch,
            kind: "invocation",
            parents: [result.id],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
            },
            invocation: refs.invocation,
            receipt: refs.receipt
        });
        value.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "receipt",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            invocation: refs.invocation
        });
        const control = new RunCommit({
            id: controlId,
            run: ids.run,
            branch: ids.branch,
            kind: "undo",
            parents: [result.id],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            selects: ids.root,
            receipt: refs.receipt
        });
        expect(() =>
            value.runtime.appendCapturedEvidence(control, new Revision(1), new Date(2000))
        ).toThrow(/captured obligation/);
        value.runtime.appendCapturedEvidence(evidence, new Revision(1), new Date(2000));
        expect(value.runtime.effectiveCommit(ids.run, ids.branch).equals(evidence.id)).toBe(true);
        const uncaptured = new RunCommit({
            id: new RunCommitId("uncaptured"),
            run: ids.run,
            branch: ids.branch,
            kind: "invocation",
            parents: [evidence.id],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
            },
            invocation: refs.invocation,
            receipt: refs.receipt
        });
        expect(() =>
            value.runtime.appendCapturedEvidence(uncaptured, new Revision(2), new Date(2000))
        ).toThrow(/captured/);
    });

    it("[C13-RUN-BINARY-TREE-MERGE] rejects arbitrary merge picks and tree sides", () => {
        expect(
            () =>
                new RunCommit({
                    id: new RunCommitId("bad-tree-merge"),
                    run: ids.run,
                    branch: ids.branch,
                    kind: "merge",
                    parents: [ids.root, new RunCommitId("source")],
                    pins: pins(),
                    writer: {
                        kind: "system",
                        cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
                    },
                    content: content("1"),
                    resolution: { kind: "pick", parent: new RunCommitId("unrelated") },
                    treeCheckpoint: content("2"),
                    treeResolution: {
                        policy: "ours",
                        side: new RunCommitId("unrelated"),
                        base: content("3"),
                        environment: "environment-1"
                    },
                    receipt: refs.receipt
                })
        ).toThrow(/parent/);
    });

    it("requires symmetric optional Turn attribution in evidence", () => {
        const value = harness();
        const commit = new RunCommit({
            id: new RunCommitId("attribution"),
            run: ids.run,
            branch: ids.branch,
            kind: "invocation",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
            },
            subjectTurn: ids.turn,
            invocation: refs.invocation,
            receipt: refs.receipt
        });
        value.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "receipt",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            invocation: refs.invocation
        });
        expect(() =>
            value.repository.transaction((tx) => validateCommitWriter(tx, commit, value.evidence))
        ).toThrow(/evidence/);
    });

    it("permits unary commits to carry an independent tree checkpoint", () => {
        const token = { turn: ids.turn, holder: ids.holder, epoch: 1 };
        const commit = new RunCommit({
            id: new RunCommitId("tree-message"),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token },
            subjectTurn: ids.turn,
            content: content("4"),
            treeCheckpoint: content("5")
        });
        expect(
            RunCommitCodec.decode(RunCommitCodec.encode(commit)).treeCheckpoint?.equals(
                content("5")
            )
        ).toBe(true);
    });

    it("rejects corrupted keys and parent projections after restore", () => {
        const value = runningHarness();
        const commit = new RunCommit({
            id: new RunCommitId("projection-commit"),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("6")
        });
        value.runtime.appendCommit(commit, new Revision(0), new Date(1500));
        const snapshot = value.storage.snapshot();
        const corrupted = {
            version: 1 as const,
            records: snapshot.records,
            parents: snapshot.parents.map((edge) =>
                edge.commit === commit.id.value ? { ...edge, parent: "forged-parent" } : edge
            )
        };
        const storage = new MemoryRunStorage(corrupted);
        const repository = new RunRepository(storage);
        expect(() => repository.transaction((tx) => repository.loadCommit(tx, commit.id))).toThrow(
            /parents/
        );
    });
});

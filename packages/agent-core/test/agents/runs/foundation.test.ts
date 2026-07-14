import { describe, expect, it } from "vitest";
import { Revision } from "../../../src/core";
import { PrincipalId } from "../../../src/identity";
import { FacetRef } from "../../../src/facets";
import { EnvironmentId } from "../../../src/environments";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { RunCommit, RunCommitCodec, validateCommitWriter } from "../../../src/agents/runs/commit";
import {
    RunBranchId,
    RunCheckpointId,
    RunId,
    SpawnReservationId,
    TurnInboxEntryId
} from "../../../src/agents/runs/id";
import {
    BlueprintPin,
    RunConfigurationSnapshot,
    RunConfigurationSnapshotCodec,
    RunPins,
    RunPinsCodec
} from "../../../src/agents/runs/pins";
import {
    PlacementPin,
    TurnPlacementSnapshot,
    TurnPlacementSnapshotCodec
} from "../../../src/agents/runs/placement";
import { Run, RunBranch, RunCodec } from "../../../src/agents/runs/run";
import { SpawnReservation, SpawnReservationCodec } from "../../../src/agents/runs/spawn";
import { SettlementObligation } from "../../../src/agents/runs/settlement";
import { RunCheckpoint, Turn, TurnInboxEntry } from "../../../src/agents/runs/turn";
import {
    AgentPolicyRevisionRecordCodec,
    AgentRevisionRecordCodec,
    ModelPolicyRevisionRecordCodec
} from "../../../src/agents/source";
import {
    configuration,
    content,
    digest,
    genesis,
    harness,
    ids,
    pins,
    refs,
    sourceRecords
} from "./fixture";

describe("Agent and Run records", () => {
    it("[C13-RUN-PINS-VALIDITY] round-trips authoritative source revisions and canonical pins", () => {
        const sources = sourceRecords();
        expect(
            AgentRevisionRecordCodec.decode(AgentRevisionRecordCodec.encode(sources.agent))
        ).toEqual(sources.agent);
        expect(
            AgentPolicyRevisionRecordCodec.decode(
                AgentPolicyRevisionRecordCodec.encode(sources.policy)
            )
        ).toEqual(sources.policy);
        expect(
            ModelPolicyRevisionRecordCodec.decode(
                ModelPolicyRevisionRecordCodec.encode(sources.model)
            )
        ).toEqual(sources.model);

        const value = RunPinsCodec.decode(RunPinsCodec.encode(pins()));
        expect(value.packages.map((pin) => pin.id.value)).toEqual(["alpha", "zeta"]);
        expect(value.equals(pins())).toBe(true);
        const snapshot = configuration();
        expect(
            RunConfigurationSnapshotCodec.decode(
                RunConfigurationSnapshotCodec.encode(snapshot)
            ).id.equals(snapshot.id)
        ).toBe(true);
    });

    it("rejects duplicate package IDs and nonpreferred placement", () => {
        const value = pins();
        expect(
            () => new BlueprintPin(" ", value.blueprint.version, value.blueprint.digest)
        ).toThrow(/blank/);
        expect(() => new RunPins({ ...value, packages: [] })).toThrow(/nonempty/);
        expect(
            () =>
                new RunPins({
                    blueprint: value.blueprint,
                    packages: [value.packages[0]!, value.packages[0]!],
                    agent: value.agent,
                    effectivePolicy: value.effectivePolicy,
                    modelPolicy: value.modelPolicy,
                    environment: value.environment
                })
        ).toThrow();
        expect(
            () =>
                new RunPins({
                    ...value,
                    agent: { ...value.agent, id: ids.policy as never }
                })
        ).toThrow(/canonical ID/);
        expect(
            () =>
                new PlacementPin({
                    facet: new FacetRef("core:facet-1"),
                    manifest: ["dynamic", "provider"],
                    policy: ["dynamic", "provider"],
                    substrate: ["dynamic", "provider"],
                    trust: ["dynamic", "provider"],
                    selected: "provider"
                })
        ).toThrow(/preference/);
    });

    it("[C13-RUN-PINS-ENVIRONMENT] round-trips exact source identities and does not alias Environment revisions", () => {
        const value = RunPinsCodec.decode(RunPinsCodec.encode(pins()));
        expect(value.agent.id.constructor).toBe(ids.agent.constructor);
        expect(value.effectivePolicy.id.constructor).toBe(ids.policy.constructor);
        expect(value.modelPolicy.id.constructor).toBe(ids.model.constructor);
        expect(value.environment.id).toBeInstanceOf(EnvironmentId);
        expect(Object.isFrozen(value.environment)).toBe(true);

        const otherEnvironment = new RunPins({
            ...value,
            environment: { ...value.environment, id: new EnvironmentId("environment-2") }
        });
        expect(otherEnvironment.environment.revision.equals(value.environment.revision)).toBe(true);
        expect(otherEnvironment.equals(value)).toBe(false);
    });

    it("rejects bare-revision and duplicated snapshot source fields", () => {
        const legacyPins = structuredClone(pins().toData()) as Record<string, unknown>;
        delete legacyPins["environment"];
        legacyPins["environmentRevision"] = 3;
        expect(() => RunPins.fromData(legacyPins as never)).toThrow(/fields/);

        const duplicatedSnapshot = {
            ...(configuration().toData() as object),
            agent: ids.agent.value,
            agentDigest: digest("a").value
        };
        expect(() => RunConfigurationSnapshot.fromData(duplicatedSnapshot as never)).toThrow(
            /fields/
        );
    });

    it("rejects empty, reordered, and duplicate Run configuration histories", () => {
        const run = genesis().run;
        const { parent, terminal, ...required } = run;
        for (const configurations of [[], [digest("f")], [run.configuration, run.configuration]]) {
            expect(
                () =>
                    new Run({
                        ...required,
                        configurations,
                        ...(parent === undefined ? {} : { parent }),
                        ...(terminal === undefined ? {} : { terminal })
                    })
            ).toThrow(/configuration history/);
        }
    });

    it("[C13-RUN-PLACEMENT-SNAPSHOT] binds placement snapshots to one Turn and one pin set", () => {
        const pin = new PlacementPin({
            facet: new FacetRef("core:facet-1"),
            manifest: ["provider", "dynamic"],
            policy: ["dynamic"],
            substrate: ["dynamic", "provider"],
            trust: ["dynamic", "provider"],
            selected: "dynamic"
        });
        const snapshot = new TurnPlacementSnapshot(ids.turn, pins(), [pin]);
        const decoded = TurnPlacementSnapshotCodec.decode(
            TurnPlacementSnapshotCodec.encode(snapshot)
        );
        expect(decoded.turn.equals(ids.turn)).toBe(true);
        expect(decoded.placements[0]?.selected).toBe("dynamic");
    });

    it("enforces the closed writer matrix and complete control proposal binding", () => {
        const { evidence, repository } = harness();
        const receiptCommit = new RunCommit({
            id: new RunCommitId("commit-invocation"),
            run: ids.run,
            branch: ids.branch,
            kind: "invocation",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
            },
            invocation: refs.invocation,
            receipt: refs.receipt
        });
        evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "receipt",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            invocation: refs.invocation
        });
        repository.transaction((tx) => validateCommitWriter(tx, receiptCommit, evidence));
        expect(
            () =>
                new RunCommit({
                    id: new RunCommitId("bad-merge"),
                    run: ids.run,
                    branch: ids.branch,
                    kind: "merge",
                    parents: [ids.root, new RunCommitId("other")],
                    pins: pins(),
                    writer: {
                        kind: "system",
                        cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
                    }
                })
        ).toThrow();

        const migration = new RunCommit({
            id: new RunCommitId("migration-1"),
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
        evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: "wrong"
        });
        expect(() =>
            repository.transaction((tx) => validateCommitWriter(tx, migration, evidence))
        ).toThrow(/proposal/);
        evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: migration.proposalDigest.value
        });
        repository.transaction((tx) => validateCommitWriter(tx, migration, evidence));
        expect(
            RunCommitCodec.decode(RunCommitCodec.encode(migration)).proposalDigest.equals(
                migration.proposalDigest
            )
        ).toBe(true);
    });
});

describe("Turn lifecycle", () => {
    it("[C13-TURN-LIFECYCLE] enforces claim, renewal, suspension, resume, completion, and terminal rejection", () => {
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        let turn = new Turn({
            id: ids.turn,
            run: ids.run,
            branch: ids.branch,
            startHead: ids.root,
            effectiveInput: ids.root,
            pins: pins(),
            placement: placement.digest,
            input: content("5"),
            revision: new Revision(0)
        });
        const now = new Date(1000);
        turn = turn.claim(ids.holder, now, new Date(2000));
        const token = { turn: ids.turn, holder: ids.holder, epoch: 1 };
        turn = turn.renew(token, new Date(1100), new Date(3000));
        expect(turn.lease.epoch).toBe(1);
        turn = turn.suspend(token, new RunCheckpointId("checkpoint-1"), new Date(1200));
        expect(turn.status.kind).toBe("suspended");
        expect(turn.lease.epoch).toBe(2);
        turn = turn.claim(new PrincipalId("principal-2"), new Date(1300), new Date(4000));
        const resumed = { turn: ids.turn, holder: new PrincipalId("principal-2"), epoch: 3 };
        turn = turn.complete(resumed, "succeeded", content("6"), new Date(1400));
        expect(turn.status.kind).toBe("succeeded");
        expect(turn.lease.holder).toBeUndefined();
        expect(() => turn.claim(ids.holder, new Date(1500), new Date(5000))).toThrow(/claim/);
    });

    it("[C13-TURN-NO-RETRY-EXPORT] keeps checkpoint and cancellation inbox records distinct", () => {
        const checkpoint = new RunCheckpoint(
            new RunCheckpointId("checkpoint-1"),
            ids.turn,
            new RunCommitId("checkpoint-commit"),
            content("7"),
            2,
            content("8")
        );
        expect(checkpoint.state.equals(checkpoint.tree!)).toBe(false);
        const cancellation = new TurnInboxEntry(
            new TurnInboxEntryId("inbox-1"),
            ids.turn,
            0,
            "turn.cancel",
            content("9"),
            digest("9"),
            "cancel-1",
            { turn: ids.turn, holder: ids.holder, epoch: 4 },
            new Date(1000)
        );
        expect(cancellation.cancellationToken?.epoch).toBe(4);
        expect(
            () =>
                new TurnInboxEntry(
                    new TurnInboxEntryId("inbox-2"),
                    ids.turn,
                    1,
                    "message",
                    content("9"),
                    digest("9"),
                    "message-1",
                    { turn: ids.turn, holder: ids.holder, epoch: 4 },
                    new Date(1000)
                )
        ).toThrow(/cancel/);
    });
});

describe("memory Run runtime", () => {
    it("[C13-RUN-GRAPH-ARITY] atomically creates and restores a canonical Run graph", () => {
        const first = harness();
        first.runtime.createRun(genesis());
        const snapshot = first.storage.snapshot();
        const restored = harness(snapshot);
        expect(
            restored.repository.transaction(
                (tx) => restored.repository.loadRun(tx, ids.run)?.root.value
            )
        ).toBe(ids.root.value);
        expect(
            restored.repository.transaction((tx) => restored.repository.listRuns(tx))
        ).toHaveLength(1);
        expect(
            restored.repository.transaction((tx) => restored.repository.listBranches(tx))
        ).toHaveLength(1);
        expect(
            restored.repository.transaction((tx) => restored.repository.listCommits(tx))
        ).toHaveLength(1);
        expect(
            restored.repository.transaction((tx) =>
                restored.repository.loadConfiguration(tx, configuration().id.value)
            )
        ).toBeDefined();
        expect(RunCodec.decode(RunCodec.encode(genesis().run))).toEqual(genesis().run);
        expect(restored.runtime.effectiveCommit(ids.run, ids.branch).equals(ids.root)).toBe(true);
    });

    it("uses expected-head CAS without leaving an orphan losing commit", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        const queued = new Turn({
            id: ids.turn,
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
            ids.turn,
            new Revision(0),
            ids.holder,
            new Date(1000),
            new Date(5000)
        );
        const token = { turn: ids.turn, holder: ids.holder, epoch: running.lease.epoch };
        const winner = new RunCommit({
            id: new RunCommitId("commit-winner"),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token },
            subjectTurn: ids.turn,
            content: content("b")
        });
        const loser = new RunCommit({
            id: new RunCommitId("commit-loser"),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token },
            subjectTurn: ids.turn,
            content: content("c")
        });
        value.runtime.appendCommit(winner, new Revision(0), new Date(1500));
        expect(() => value.runtime.appendCommit(loser, new Revision(0), new Date(1500))).toThrow(
            /revision/
        );
        expect(
            value.repository.transaction((tx) => value.repository.loadCommit(tx, loser.id))
        ).toBeUndefined();
        expect(value.runtime.effectiveCommit(ids.run, ids.branch).equals(winner.id)).toBe(true);
    });

    it("atomically persists checkpoint before suspension fencing", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        const queued = new Turn({
            id: ids.turn,
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
            ids.turn,
            new Revision(0),
            ids.holder,
            new Date(1000),
            new Date(5000)
        );
        const token = { turn: ids.turn, holder: ids.holder, epoch: 1 };
        const commit = new RunCommit({
            id: new RunCommitId("checkpoint-commit"),
            run: ids.run,
            branch: ids.branch,
            kind: "checkpoint",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token },
            subjectTurn: ids.turn,
            content: content("d")
        });
        const checkpoint = new RunCheckpoint(
            new RunCheckpointId("checkpoint-atomic"),
            ids.turn,
            commit.id,
            content("d"),
            0,
            undefined
        );
        value.runtime.suspendTurn({
            turn: ids.turn,
            expectedTurnRevision: running.revision,
            expectedBranchRevision: new Revision(0),
            token,
            checkpoint,
            commit,
            now: new Date(1500)
        });
        const suspended = value.repository.transaction((tx) =>
            value.repository.loadTurn(tx, ids.turn)!
        );
        expect(suspended.status.kind).toBe("suspended");
        expect(suspended.lease.holder).toBeUndefined();
        expect(suspended.lease.epoch).toBe(2);
        expect(
            value.repository.transaction((tx) => value.repository.loadCheckpoint(tx, checkpoint.id))
        ).toBeDefined();
    });

    it("[C13-RUN-PINS-SOURCES] rejects migration ahead of an admitted old-pin Turn", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: ids.turn,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: placement.digest,
                    input: content("e"),
                    revision: new Revision(0)
                }),
                placement
            },
            new Revision(0)
        );
        const migration = new RunCommit({
            id: new RunCommitId("migration-admitted"),
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
        expect(() =>
            value.runtime.migrateRun(migration, configuration(), new Revision(0), new Date(1000))
        ).toThrow(/admitted Turn/);
        expect(
            value.repository.transaction((tx) => value.repository.loadCommit(tx, migration.id))
        ).toBeUndefined();
    });

    it("[C13-TURN-NO-RETRY-RECORD] exposes no Turn retry runtime or record field", () => {
        const value = harness();
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        const turn = new Turn({
            id: ids.turn,
            run: ids.run,
            branch: ids.branch,
            startHead: ids.root,
            effectiveInput: ids.root,
            pins: pins(),
            placement: placement.digest,
            input: content("1"),
            revision: new Revision(0)
        });
        expect("retryTurn" in value.runtime).toBe(false);
        expect("retryTurnInTransaction" in value.runtime).toBe(false);
        expect("retryOf" in turn).toBe(false);
        expect("retryOf" in (turn.toData() as object)).toBe(false);
        expect("retryOf" in Turn.decode(Turn.encode(turn))).toBe(false);
    });

    it("[C13-ADV-STALE-LEASE] creates one attenuated child through lease-bound atomic spawn genesis", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        const parentTurn = new Turn({
            id: ids.turn,
            run: ids.run,
            branch: ids.branch,
            startHead: ids.root,
            effectiveInput: ids.root,
            pins: pins(),
            placement: placement.digest,
            input: content("4"),
            revision: new Revision(0)
        });
        value.runtime.createTurn({ turn: parentTurn, placement }, new Revision(0));
        value.runtime.claimTurn(
            ids.turn,
            new Revision(0),
            ids.holder,
            new Date(1000),
            new Date(5000)
        );
        const childId = new RunId("run-child");
        const childBranchId = new RunBranchId("branch-child");
        const childRootId = new RunCommitId("commit-child-root");
        const snapshot = configuration();
        const childRoot = new RunCommit({
            id: childRootId,
            run: childId,
            branch: childBranchId,
            kind: "root",
            parents: [],
            pins: snapshot.pins,
            writer: { kind: "root" },
            content: content("5")
        });
        const child = new Run({
            id: childId,
            agent: ids.agent,
            configuration: snapshot.id,
            root: childRootId,
            initialBranch: childBranchId,
            parent: ids.run,
            revision: new Revision(0)
        });
        expect(child.revise().parent?.equals(ids.run)).toBe(true);
        const reservation = new SpawnReservation(
            new SpawnReservationId("spawn-1"),
            ids.run,
            ids.turn,
            childId,
            { turn: ids.turn, holder: ids.holder, epoch: 1 },
            snapshot.id,
            childRoot.content!,
            refs.invocation,
            refs.receipt,
            digest("6"),
            new Date(1500)
        );
        expect(SpawnReservationCodec.decode(SpawnReservationCodec.encode(reservation))).toEqual(
            reservation
        );
        expect(reservation.recordedAt.getTime()).toBe(1500);
        value.runtime.spawnRun(
            reservation,
            {
                run: child,
                configuration: snapshot,
                branch: new RunBranch(childBranchId, childId, "main", childRootId, new Revision(0)),
                root: childRoot
            },
            new Date(1500)
        );
        expect(
            value.repository.transaction((tx) =>
                value.repository.loadRun(tx, childId)?.parent?.equals(ids.run)
            )
        ).toBe(true);
        expect(
            value.repository.transaction((tx) => value.repository.loadSpawn(tx, reservation.id))
        ).toBeDefined();
        expect(() =>
            value.runtime.spawnRun(
                reservation,
                {
                    run: child,
                    configuration: snapshot,
                    branch: new RunBranch(
                        childBranchId,
                        childId,
                        "main",
                        childRootId,
                        new Revision(0)
                    ),
                    root: childRoot
                },
                new Date(1500)
            )
        ).not.toThrow();
        const conflict = new SpawnReservation(
            reservation.id,
            reservation.parentRun,
            reservation.parentTurn,
            reservation.childRun,
            reservation.token,
            reservation.configuration,
            content("6"),
            reservation.invocation,
            reservation.receipt,
            reservation.attenuation,
            reservation.recordedAt
        );
        expect(() =>
            value.runtime.spawnRun(
                conflict,
                {
                    run: child,
                    configuration: snapshot,
                    branch: new RunBranch(
                        childBranchId,
                        childId,
                        "main",
                        childRootId,
                        new Revision(0)
                    ),
                    root: childRoot
                },
                new Date(1500)
            )
        ).toThrow(/identity conflicts/);
        expect(
            value.repository.transaction((tx) =>
                value.repository.listRuns(tx).filter((run) => run.id.equals(childId))
            )
        ).toHaveLength(1);
    });

    it("[C13-RUN-EQUAL-PIN-MERGE] accepts only ordered equal-pin current heads for binary merge", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const sourceBranchId = new RunBranchId("branch-source");
        const sourceBranch = new RunBranch(
            sourceBranchId,
            ids.run,
            "source",
            ids.root,
            new Revision(0)
        );
        const runRevision = value.repository.transaction(
            (tx) => value.repository.loadRun(tx, ids.run)!.revision
        );
        value.runtime.createBranch(ids.run, sourceBranch, runRevision);
        const sourceHead = new RunCommit({
            id: new RunCommitId("source-head"),
            run: ids.run,
            branch: sourceBranchId,
            kind: "invocation",
            parents: [ids.root],
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
        value.runtime.appendCommit(sourceHead, new Revision(0), new Date(1000));
        const merge = new RunCommit({
            id: new RunCommitId("merge-commit"),
            run: ids.run,
            branch: ids.branch,
            kind: "merge",
            parents: [ids.root, sourceHead.id],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            content: content("4"),
            resolution: { kind: "pick", parent: ids.root },
            treeCheckpoint: content("e"),
            treeResolution: {
                policy: "ours",
                side: ids.root,
                base: content("e"),
                environment: ids.environment.value
            },
            receipt: refs.receipt
        });
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: merge.proposalDigest.value
        });
        value.merge.acceptsTree = false;
        expect(() => value.runtime.appendCommit(merge, new Revision(0), new Date(1000))).toThrow(
            /base, Environment, or conflict/
        );
        value.merge.acceptsTree = true;
        value.runtime.appendCommit(merge, new Revision(0), new Date(1000));
        expect(value.runtime.effectiveCommit(ids.run, ids.branch).equals(merge.id)).toBe(true);
    });

    it("[C13-RUN-UNDO-REDO] appends undo selection without rewinding ancestry", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const undo = new RunCommit({
            id: new RunCommitId("undo-selection"),
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
        value.runtime.appendCommit(undo, new Revision(0), new Date(1000));
        expect(value.runtime.effectiveCommit(ids.run, ids.branch).equals(ids.root)).toBe(true);
        expect(
            value.repository.transaction((tx) => value.repository.isAncestor(tx, ids.root, undo.id))
        ).toBe(true);
    });

    it("rolls back incomplete genesis and rejects unresolved source revisions", () => {
        const value = harness();
        value.sources.accepts = false;
        expect(() => value.runtime.createRun(genesis())).toThrow(/source revisions/);
        expect(
            value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run))
        ).toBeUndefined();
        expect(() =>
            value.repository.transaction((tx) => {
                value.repository.insertRun(tx, genesis().run);
                throw new Error("rollback");
            })
        ).toThrow("rollback");
        expect(
            value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run))
        ).toBeUndefined();
    });

    it("[C13-TURN-NO-RETRY-RUNTIME] cancels an unheld queued Turn without creating a result commit", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: ids.turn,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: placement.digest,
                    input: content("0"),
                    revision: new Revision(0)
                }),
                placement
            },
            new Revision(0)
        );
        const cancelled = value.runtime.cancelUnheldTurn(ids.turn, new Revision(0));
        expect(cancelled.status.kind).toBe("cancelled");
        expect(cancelled.result).toBeUndefined();
        expect(
            value.repository.transaction((tx) => value.repository.loadPlacement(tx, ids.turn))
        ).toBeDefined();
    });

    it("[C13-TURN-CALLBACK-WRITER] anchors a Turn, rejects stale tokens, and terminalizes with derived settlement", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        const turn = new Turn({
            id: ids.turn,
            run: ids.run,
            branch: ids.branch,
            startHead: ids.root,
            effectiveInput: ids.root,
            pins: pins(),
            placement: placement.digest,
            input: content("a"),
            revision: new Revision(0)
        });
        value.runtime.createTurn({ turn, placement }, new Revision(0));
        const running = value.runtime.claimTurn(
            ids.turn,
            new Revision(0),
            ids.holder,
            new Date(1000),
            new Date(5000)
        );
        const token = { turn: ids.turn, holder: ids.holder, epoch: running.lease.epoch };
        expect(() =>
            value.runtime.renewTurn(
                ids.turn,
                running.revision,
                { ...token, turn: new TurnId("wrong") },
                new Date(1500),
                new Date(6000)
            )
        ).toThrow(/token/);

        const result = new RunCommit({
            id: new RunCommitId("commit-result"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token },
            subjectTurn: ids.turn,
            content: content("b")
        });
        const runRevision = value.repository.transaction(
            (tx) => value.repository.loadRun(tx, ids.run)!.revision
        );
        value.runtime.terminalizeRun({
            run: ids.run,
            turn: ids.turn,
            expectedRunRevision: runRevision,
            expectedTurnRevision: running.revision,
            expectedBranchRevision: new Revision(0),
            token,
            outcome: "succeeded",
            commit: result,
            siblingCancellations: new Map(),
            now: new Date(2000)
        });
        expect(value.runtime.settled(ids.run)).toBe(true);
        const terminal = value.repository.transaction((tx) =>
            value.repository.loadRun(tx, ids.run)!
        );
        expect(() => terminal.revise()).toThrow(/ordinary mutations/);
        expect(() => terminal.recordConfiguration(digest("f"))).toThrow(/configuration migration/);
        const { parent, terminal: snapshot, ...required } = terminal;
        expect(
            () =>
                new Run({
                    ...required,
                    id: new RunId("other-terminal-run"),
                    ...(parent === undefined ? {} : { parent }),
                    ...(snapshot === undefined ? {} : { terminal: snapshot })
                })
        ).toThrow(/different Run/);
        expect(() => value.runtime.appendCommit(result, new Revision(1), new Date(2100))).toThrow(
            /Terminal Runs reject ordinary commits/
        );
        expect(() =>
            value.runtime.createBranch(ids.run, genesis().branch, new Revision(0))
        ).toThrow(/terminal/);
    });

    it("[C13-RUN-TERMINAL-OBLIGATIONS] derives settlement from every captured obligation", () => {
        const value = harness();
        const audit = {
            audit: refs.audit,
            evidence: { kind: "receipt", invocation: refs.invocation, receipt: refs.receipt }
        } as const;
        const obligation = new SettlementObligation({
            registryEpoch: 1,
            obligations: [
                {
                    kind: "invocationItem",
                    invocation: refs.invocation,
                    itemIndex: 0,
                    itemKey: "item-key"
                },
                { kind: "route", reservation: refs.route },
                { kind: "systemCommit", commit: new RunCommitId("required-commit") }
            ],
            requiredAudits: [audit]
        });
        expect(obligation.requiredAudits).toHaveLength(1);
        value.settlement.terminalItems.add(`${refs.invocation.value}:0:item-key`);
        value.settlement.terminalRoutes.add(refs.route.value);
        value.settlement.commits.add("required-commit");
        value.settlement.audits.add(refs.audit.value);
        expect(value.settlement.auditSatisfied({}, audit)).toBe(true);
    });
});

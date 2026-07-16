// @ts-nocheck
import { describe, expect, it } from "vitest";
import { Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { RunCommit } from "../../../src/agents/runs/commit";
import { RunBranchId, RunCheckpointId, RunId, TurnInboxEntryId } from "../../../src/agents/runs/id";
import { RunPins } from "../../../src/agents/runs/pins";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import { RunCheckpoint, Turn, TurnInboxEntry } from "../../../src/agents/runs/turn";
import { ReceiptId } from "../../../src/invocation-references";
import { AuditRecordId, EventId } from "../../../src/interaction-references";
import {
    configuration,
    content,
    digest,
    genesis,
    harness,
    ids,
    pins,
    refs,
    seedRunningTurn
} from "./fixture";

function expectCode(operation: () => unknown, code: AgentCoreError["code"]): void {
    try {
        operation();
        throw new Error("Expected operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
    }
}

function message(
    id: string,
    parent: RunCommitId,
    token = { turn: ids.turn, holder: ids.holder, epoch: 1 },
    runPins = pins()
): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "message",
        parents: [parent],
        pins: runPins,
        writer: { kind: "turn", token },
        subjectTurn: token.turn,
        content: content("1")
    });
}

function cancellation(
    turn: Turn,
    overrides: Partial<{
        readonly target: TurnId;
        readonly sequence: number;
        readonly event: string;
        readonly tokenTurn: TurnId;
    }> = {}
): TurnInboxEntry {
    if (turn.lease.holder === undefined)
        throw new TypeError("Cancellation fixture requires holder");
    return new TurnInboxEntry(
        new TurnInboxEntryId(`cancel-${turn.id.value}-${overrides.sequence ?? 0}`),
        overrides.target ?? turn.id,
        overrides.sequence ?? 0,
        overrides.event ?? "turn.cancel",
        content("2"),
        digest("2"),
        `cancel-${turn.id.value}`,
        {
            turn: overrides.tokenTurn ?? turn.id,
            holder: turn.lease.holder,
            epoch: turn.lease.epoch
        },
        new Date(5000)
    );
}

function forcedCancellation(
    value: ReturnType<typeof harness>,
    terminalTurn: TurnId,
    sibling: Turn,
    suffix: string,
    existingControl?: { readonly receipt: ReceiptId; readonly audit: AuditRecordId }
) {
    const receipt = existingControl?.receipt ?? new ReceiptId(`forced-control-${suffix}`);
    const controlAudit =
        existingControl?.audit ?? new AuditRecordId(`forced-control-audit-${suffix}`);
    const event = new EventId(`forced-event-${suffix}`);
    const cancellationAudit = new AuditRecordId(`forced-audit-${suffix}`);
    value.evidence.administers.set(`${receipt.value}:${controlAudit.value}`, {
        kind: "administer",
        run: sibling.run,
        terminalTurn,
        receipt,
        audit: controlAudit,
        outcome: "succeeded"
    });
    value.evidence.cancellations.set(`${event.value}:${cancellationAudit.value}`, {
        kind: "turnCancellation",
        eventKind: "turn.cancel",
        run: sibling.run,
        terminalTurn,
        turn: sibling.id,
        priorLeaseEpoch: sibling.lease.epoch,
        fencedLeaseEpoch: sibling.lease.epoch + 1,
        inboxLeaseEpoch: sibling.lease.epoch,
        controlReceipt: receipt,
        controlAudit,
        event,
        audit: cancellationAudit
    });
    return {
        control: { receipt, audit: controlAudit },
        evidence: { event, audit: cancellationAudit }
    };
}

describe("RunRuntime rejection matrix", () => {
    it("uses run.invalid-state for malformed and duplicate genesis", () => {
        const value = harness();
        const valid = genesis();
        const malformed = {
            ...valid,
            run: new Run({
                id: valid.run.id,
                agent: valid.run.agent,
                configuration: digest("f"),
                root: valid.run.root,
                initialBranch: valid.run.initialBranch,
                revision: new Revision(0)
            })
        };
        expectCode(() => value.runtime.createRun(malformed), "run.invalid-state");
        expectCode(() => {
            const { parent, terminal, ...required } = valid.run;
            value.runtime.createRun({
                ...valid,
                run: new Run({
                    ...required,
                    agent: ids.policy as never,
                    ...(parent === undefined ? {} : { parent }),
                    ...(terminal === undefined ? {} : { terminal })
                })
            });
        }, "run.invalid-state");
        value.runtime.createRun(valid);
        expectCode(() => value.runtime.createRun(valid), "run.invalid-state");
    });

    it("rejects invalid branches and generic migration append", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const duplicateName = new RunBranch(
            new RunBranchId("duplicate-name"),
            ids.run,
            "main",
            ids.root,
            new Revision(0)
        );
        expectCode(
            () => value.runtime.createBranch(ids.run, duplicateName, new Revision(0)),
            "run.invalid-state"
        );
        const migration = new RunCommit({
            id: new RunCommitId("generic-migration"),
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
        expectCode(
            () => value.runtime.appendCommit(migration, new Revision(0), new Date(1000)),
            "run.invalid-state"
        );
    });

    it("[C13-RUN-PARENT-PIN-INHERITANCE] rejects migration evidence whose from pins do not match the durable parent", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const target = configuration();
        const wrongFrom = new RunPins({
            ...pins(),
            environment: { ...pins().environment, revision: new Revision(4) }
        });
        const migration = new RunCommit({
            id: new RunCommitId("migration-wrong-from-pins"),
            run: ids.run,
            branch: ids.branch,
            kind: "migration",
            parents: [ids.root],
            pins: target.pins,
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            receipt: refs.receipt,
            migration: { from: wrongFrom, to: target.pins }
        });
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: migration.proposalDigest.value
        });

        expectCode(
            () => value.runtime.migrateRun(migration, target, new Revision(0), new Date(1000)),
            "run.invalid-state"
        );
        expect(
            value.repository.transaction((tx) => value.repository.loadCommit(tx, migration.id))
        ).toBeUndefined();
    });

    it("[C13-TURN-NO-RETRY-PROTOCOL] has no retry transition and rejects a wrong effective Run", () => {
        const value = seedRunningTurn();
        expect("retryTurn" in value.runtime).toBe(false);
        expectCode(
            () => value.runtime.effectiveCommit(new RunId("other"), ids.branch),
            "run.invalid-state"
        );
        expect(value.runtime.settled(ids.run)).toBe(false);
    });

    it("[C13-RUN-MIGRATED-TURN-REJECTION] rejects duplicate commits, stale parents, pin changes, and foreign Turn writers", () => {
        const value = seedRunningTurn();
        const first = message("first", ids.root);
        value.runtime.appendCommit(first, new Revision(0), new Date(1500));
        expectCode(
            () => value.runtime.appendCommit(first, new Revision(1), new Date(1500)),
            "run.invalid-state"
        );
        expectCode(
            () =>
                value.runtime.appendCommit(
                    message("stale-parent", ids.root),
                    new Revision(1),
                    new Date(1500)
                ),
            "protocol.revision-conflict"
        );
        const differentPins = new RunPins({
            blueprint: pins().blueprint,
            packages: pins().packages,
            agent: { ...pins().agent, revision: new Revision(4) },
            effectivePolicy: pins().effectivePolicy,
            modelPolicy: pins().modelPolicy,
            environment: pins().environment
        });
        expectCode(
            () =>
                value.runtime.appendCommit(
                    message("different-pins", first.id, value.token, differentPins),
                    new Revision(1),
                    new Date(1500)
                ),
            "run.invalid-state"
        );
        const otherTurn = new TurnId("missing-turn");
        expectCode(
            () =>
                value.runtime.appendCommit(
                    message("missing-writer", first.id, {
                        turn: otherTurn,
                        holder: ids.holder,
                        epoch: 1
                    }),
                    new Revision(1),
                    new Date(1500)
                ),
            "run.invalid-state"
        );
    });

    it("[C13-ADV-NONBINARY-MERGE] rejects missing merge sources and invalid picked content", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const missingSource = new RunCommit({
            id: new RunCommitId("merge-missing"),
            run: ids.run,
            branch: ids.branch,
            kind: "merge",
            parents: [ids.root, new RunCommitId("missing-source")],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            content: content("4"),
            resolution: { kind: "concat" },
            receipt: refs.receipt
        });
        expectCode(
            () => value.runtime.appendCommit(missingSource, new Revision(0), new Date(1000)),
            "run.invalid-state"
        );

        const sourceBranch = new RunBranch(
            new RunBranchId("source"),
            ids.run,
            "source",
            ids.root,
            new Revision(0)
        );
        value.runtime.createBranch(ids.run, sourceBranch, new Revision(0));
        const sourceHead = new RunCommit({
            id: new RunCommitId("source-head-runtime"),
            run: ids.run,
            branch: sourceBranch.id,
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
            audit: refs.audit,
            receipt: refs.receipt,
            invocation: refs.invocation
        });
        value.runtime.appendCommit(sourceHead, new Revision(0), new Date(1000));
        const pick = new RunCommit({
            id: new RunCommitId("bad-pick-content"),
            run: ids.run,
            branch: ids.branch,
            kind: "merge",
            parents: [ids.root, sourceHead.id],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            content: content("5"),
            resolution: { kind: "pick", parent: ids.root },
            receipt: refs.receipt
        });
        expectCode(
            () => value.runtime.appendCommit(pick, new Revision(0), new Date(1000)),
            "run.invalid-state"
        );

        const concat = new RunCommit({
            id: new RunCommitId("verified-concat"),
            run: ids.run,
            branch: ids.branch,
            kind: "merge",
            parents: [ids.root, sourceHead.id],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            content: content("6"),
            resolution: { kind: "concat" },
            receipt: refs.receipt
        });
        value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
            kind: "control",
            run: ids.run,
            receipt: refs.receipt,
            audit: refs.audit,
            proposalDigest: concat.proposalDigest.value
        });
        value.merge.acceptsConcat = false;
        expectCode(
            () => value.runtime.appendCommit(concat, new Revision(0), new Date(1000)),
            "run.invalid-state"
        );
        value.merge.acceptsConcat = true;
        value.runtime.appendCommit(concat, new Revision(0), new Date(1000));
    });
});

describe("Turn and terminalization rejection matrix", () => {
    it("rejects ordinary inbox sequence and suspend/complete mismatches with turn.invalid-state", () => {
        const value = seedRunningTurn();
        const wrongEntry = new TurnInboxEntry(
            new TurnInboxEntryId("wrong-sequence"),
            ids.turn,
            2,
            "message",
            content("6"),
            digest("6"),
            "wrong-sequence",
            undefined,
            new Date(1500)
        );
        expectCode(
            () =>
                value.runtime.deliverEvent(
                    ids.turn,
                    value.running.revision,
                    value.token,
                    wrongEntry,
                    new Date(1500)
                ),
            "turn.invalid-state"
        );
        expectCode(
            () =>
                value.runtime.cancelHeldTurn(
                    {
                        turn: ids.turn,
                        expectedTurnRevision: value.running.revision,
                        expectedBranchRevision: new Revision(0),
                        token: value.token,
                        outcome: "failed",
                        commit: message("not-result", ids.root),
                        now: new Date(1500)
                    },
                    cancellation(value.running)
                ),
            "turn.invalid-state"
        );

        const checkpointCommit = new RunCommit({
            id: new RunCommitId("cursor-checkpoint"),
            run: ids.run,
            branch: ids.branch,
            kind: "checkpoint",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("6")
        });
        expectCode(
            () =>
                value.runtime.suspendTurn({
                    turn: ids.turn,
                    expectedTurnRevision: value.running.revision,
                    expectedBranchRevision: new Revision(0),
                    token: value.token,
                    checkpoint: new RunCheckpoint(
                        new RunCheckpointId("cursor"),
                        ids.turn,
                        checkpointCommit.id,
                        checkpointCommit.content!,
                        1,
                        undefined
                    ),
                    commit: checkpointCommit,
                    now: new Date(1500)
                }),
            "turn.invalid-state"
        );
    });

    it("rejects duplicate inbox idempotency keys", () => {
        const value = seedRunningTurn();
        const first = new TurnInboxEntry(
            new TurnInboxEntryId("first-key"),
            ids.turn,
            0,
            "message",
            content("1"),
            digest("1"),
            "same-key",
            undefined,
            new Date(1500)
        );
        value.runtime.deliverEvent(
            ids.turn,
            value.running.revision,
            value.token,
            first,
            new Date(1500)
        );
        const current = value.repository.transaction((tx) =>
            value.repository.loadTurn(tx, ids.turn)!
        );
        const duplicate = new TurnInboxEntry(
            new TurnInboxEntryId("second-key"),
            ids.turn,
            1,
            "message",
            content("2"),
            digest("2"),
            "same-key",
            undefined,
            new Date(1600)
        );
        expectCode(
            () =>
                value.runtime.deliverEvent(
                    ids.turn,
                    current.revision,
                    value.token,
                    duplicate,
                    new Date(1600)
                ),
            "turn.invalid-state"
        );
    });

    it("rejects malformed cancellation attribution on reclaim", () => {
        for (const overrides of [{ sequence: 1 }]) {
            const value = seedRunningTurn();
            expectCode(
                () =>
                    value.runtime.reclaimTurn(
                        ids.turn,
                        value.running.revision,
                        ids.holder,
                        new Date(5000),
                        new Date(6000),
                        cancellation(value.running, overrides)
                    ),
                "turn.invalid-state"
            );
        }
    });

    it("rejects terminalization with mismatched result and sibling cancellation evidence", () => {
        const value = seedRunningTurn();
        const result = message("terminal-not-result", ids.root);
        expectCode(
            () =>
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
                }),
            "run.invalid-state"
        );

        const siblingId = new TurnId("queued-sibling");
        const placement = new TurnPlacementSnapshot(siblingId, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: siblingId,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: placement.digest,
                    input: content("7"),
                    revision: new Revision(0)
                }),
                placement
            },
            new Revision(0)
        );
        const terminalCommit = new RunCommit({
            id: new RunCommitId("terminal-result-runtime"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("8")
        });
        expectCode(
            () =>
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
                    commit: terminalCommit,
                    siblingCancellations: new Map([
                        [
                            siblingId.value,
                            {
                                event: new EventId("uncontrolled-event"),
                                audit: new AuditRecordId("uncontrolled-audit")
                            }
                        ]
                    ]),
                    now: new Date(1500)
                }),
            "run.invalid-state"
        );
    });

    it("[C13-RUN-TERMINAL-SIBLINGS] atomically fences queued, running, and suspended siblings with durable evidence", () => {
        const value = seedRunningTurn();
        const queuedId = new TurnId("queued-terminal-sibling");
        const queuedPlacement = new TurnPlacementSnapshot(queuedId, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: queuedId,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: queuedPlacement.digest,
                    input: content("9"),
                    revision: new Revision(0)
                }),
                placement: queuedPlacement
            },
            new Revision(0)
        );
        const terminalSiblingId = new TurnId("already-terminal-sibling");
        const terminalPlacement = new TurnPlacementSnapshot(terminalSiblingId, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: terminalSiblingId,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: terminalPlacement.digest,
                    input: content("a"),
                    revision: new Revision(0)
                }),
                placement: terminalPlacement
            },
            new Revision(0)
        );
        value.runtime.cancelUnheldTurn(terminalSiblingId, new Revision(0));

        const heldId = new TurnId("held-terminal-sibling");
        const heldPlacement = new TurnPlacementSnapshot(heldId, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: heldId,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: heldPlacement.digest,
                    input: content("b"),
                    revision: new Revision(0)
                }),
                placement: heldPlacement
            },
            new Revision(0)
        );
        const held = value.runtime.claimTurn(
            heldId,
            new Revision(0),
            ids.holder,
            new Date(1000),
            new Date(5000)
        );
        const suspendedId = new TurnId("suspended-terminal-sibling");
        const suspendedPlacement = new TurnPlacementSnapshot(suspendedId, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: suspendedId,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: suspendedPlacement.digest,
                    input: content("d"),
                    revision: new Revision(0)
                }),
                placement: suspendedPlacement
            },
            new Revision(0)
        );
        const suspendedRunning = value.runtime.claimTurn(
            suspendedId,
            new Revision(0),
            ids.holder,
            new Date(1000),
            new Date(5000)
        );
        const checkpointCommit = new RunCommit({
            id: new RunCommitId("suspended-sibling-checkpoint"),
            run: ids.run,
            branch: ids.branch,
            kind: "checkpoint",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "turn",
                token: {
                    turn: suspendedId,
                    holder: ids.holder,
                    epoch: suspendedRunning.lease.epoch
                }
            },
            subjectTurn: suspendedId,
            content: content("e")
        });
        value.runtime.suspendTurn({
            turn: suspendedId,
            expectedTurnRevision: suspendedRunning.revision,
            expectedBranchRevision: new Revision(0),
            token: {
                turn: suspendedId,
                holder: ids.holder,
                epoch: suspendedRunning.lease.epoch
            },
            checkpoint: new RunCheckpoint(
                new RunCheckpointId("suspended-sibling-state"),
                suspendedId,
                checkpointCommit.id,
                checkpointCommit.content!,
                0,
                undefined
            ),
            commit: checkpointCommit,
            now: new Date(1500)
        });
        const queued = value.repository.transaction((tx) =>
            value.repository.loadTurn(tx, queuedId)!
        );
        const queuedCancellation = forcedCancellation(value, ids.turn, queued, "queued");
        const heldCancellation = forcedCancellation(
            value,
            ids.turn,
            held,
            "held",
            queuedCancellation.control
        );
        const suspended = value.repository.transaction((tx) =>
            value.repository.loadTurn(tx, suspendedId)!
        );
        const suspendedCancellation = forcedCancellation(
            value,
            ids.turn,
            suspended,
            "suspended",
            queuedCancellation.control
        );
        const terminalCommit = new RunCommit({
            id: new RunCommitId("terminal-with-siblings"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [checkpointCommit.id],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("c")
        });
        value.runtime.terminalizeRun({
            run: ids.run,
            turn: ids.turn,
            expectedRunRevision: value.repository.transaction(
                (tx) => value.repository.loadRun(tx, ids.run)!.revision
            ),
            expectedTurnRevision: value.running.revision,
            expectedBranchRevision: new Revision(1),
            token: value.token,
            outcome: "succeeded",
            commit: terminalCommit,
            forcedCancellationControl: queuedCancellation.control,
            siblingCancellations: new Map([
                [queuedId.value, queuedCancellation.evidence],
                [heldId.value, heldCancellation.evidence],
                [suspendedId.value, suspendedCancellation.evidence]
            ]),
            now: new Date(1500)
        });
        for (const id of [queuedId, terminalSiblingId, heldId, suspendedId]) {
            const sibling = value.repository.transaction((tx) =>
                value.repository.loadTurn(tx, id)!
            );
            expect(sibling.status.kind).toBe("cancelled");
            expect(sibling.lease.holder).toBeUndefined();
        }
        const records = value.repository.transaction((tx) =>
            value.repository.listForcedCancellations(tx, ids.run)
        );
        expect(records).toHaveLength(3);
        expect(
            records.map((record) => [
                record.turn.value,
                record.priorLeaseEpoch,
                record.fencedLeaseEpoch
            ])
        ).toEqual([
            [heldId.value, 1, 2],
            [queuedId.value, 0, 1],
            [suspendedId.value, 2, 3]
        ]);
        expect(
            value.repository
                .transaction((tx) => value.repository.listCommits(tx))
                .filter(
                    (commit) => commit.kind === "result" && !commit.subjectTurn?.equals(ids.turn)
                )
        ).toEqual([]);

        const restarted = harness(value.storage.snapshot());
        expect(
            restarted.repository.transaction((tx) =>
                restarted.repository.listForcedCancellations(tx, ids.run)
            )
        ).toEqual(records);
    });

    it("[C13-ADV-ADMITTED-SIBLING] rejects missing and malformed held sibling cancellation evidence", () => {
        for (const variant of ["missing", "event"] as const) {
            const value = seedRunningTurn();
            const siblingId = new TurnId(`held-${variant}`);
            const placement = new TurnPlacementSnapshot(siblingId, pins(), []);
            value.runtime.createTurn(
                {
                    turn: new Turn({
                        id: siblingId,
                        run: ids.run,
                        branch: ids.branch,
                        startHead: ids.root,
                        effectiveInput: ids.root,
                        pins: pins(),
                        placement: placement.digest,
                        input: content("d"),
                        revision: new Revision(0)
                    }),
                    placement
                },
                new Revision(0)
            );
            const held = value.runtime.claimTurn(
                siblingId,
                new Revision(0),
                ids.holder,
                new Date(1000),
                new Date(5000)
            );
            const valid = forcedCancellation(value, ids.turn, held, variant);
            const evidence =
                variant === "missing"
                    ? undefined
                    : {
                          event: new EventId("ordinary-sibling"),
                          audit: new AuditRecordId("ordinary-sibling-audit")
                      };
            const result = new RunCommit({
                id: new RunCommitId(`terminal-${variant}`),
                run: ids.run,
                branch: ids.branch,
                kind: "result",
                parents: [ids.root],
                pins: pins(),
                writer: { kind: "turn", token: value.token },
                subjectTurn: ids.turn,
                content: content("f")
            });
            expectCode(
                () =>
                    value.runtime.terminalizeRun({
                        run: ids.run,
                        turn: ids.turn,
                        expectedRunRevision: value.repository.transaction(
                            (tx) => value.repository.loadRun(tx, ids.run)!.revision
                        ),
                        expectedTurnRevision: value.running.revision,
                        expectedBranchRevision: new Revision(0),
                        token: value.token,
                        outcome: "failed",
                        commit: result,
                        forcedCancellationControl: valid.control,
                        siblingCancellations:
                            evidence === undefined
                                ? new Map()
                                : new Map([[siblingId.value, evidence]]),
                        now: new Date(1500)
                    }),
                "run.invalid-state"
            );
            expect(
                value.repository.transaction((tx) => value.repository.loadTurn(tx, siblingId))
                    ?.status.kind
            ).toBe("running");
            expect(
                value.repository.transaction((tx) => value.repository.loadAdmission(tx, ids.run))
                    ?.accepting
            ).toBe(true);
            expect(
                value.repository.transaction((tx) =>
                    value.repository.listForcedCancellations(tx, ids.run)
                )
            ).toEqual([]);
        }
    });

    it("rejects unsuccessful control and mismatched fence evidence atomically", () => {
        for (const variant of ["control", "fence"] as const) {
            const value = seedRunningTurn();
            const siblingId = new TurnId(`adversarial-${variant}`);
            const placement = new TurnPlacementSnapshot(siblingId, pins(), []);
            value.runtime.createTurn(
                {
                    turn: new Turn({
                        id: siblingId,
                        run: ids.run,
                        branch: ids.branch,
                        startHead: ids.root,
                        effectiveInput: ids.root,
                        pins: pins(),
                        placement: placement.digest,
                        input: content("1"),
                        revision: new Revision(0)
                    }),
                    placement
                },
                new Revision(0)
            );
            const sibling = value.runtime.claimTurn(
                siblingId,
                new Revision(0),
                ids.holder,
                new Date(1000),
                new Date(5000)
            );
            const forced = forcedCancellation(value, ids.turn, sibling, variant);
            if (variant === "control") {
                const key = `${forced.control.receipt.value}:${forced.control.audit.value}`;
                value.evidence.administers.set(key, {
                    ...value.evidence.administers.get(key)!,
                    outcome: "failed"
                } as never);
            } else {
                const key = `${forced.evidence.event.value}:${forced.evidence.audit.value}`;
                value.evidence.cancellations.set(key, {
                    ...value.evidence.cancellations.get(key)!,
                    priorLeaseEpoch: sibling.lease.epoch + 1,
                    fencedLeaseEpoch: sibling.lease.epoch + 2
                });
            }
            const result = new RunCommit({
                id: new RunCommitId(`adversarial-result-${variant}`),
                run: ids.run,
                branch: ids.branch,
                kind: "result",
                parents: [ids.root],
                pins: pins(),
                writer: { kind: "turn", token: value.token },
                subjectTurn: ids.turn,
                content: content("2")
            });
            expectCode(
                () =>
                    value.runtime.terminalizeRun({
                        run: ids.run,
                        turn: ids.turn,
                        expectedRunRevision: value.repository.transaction(
                            (tx) => value.repository.loadRun(tx, ids.run)!.revision
                        ),
                        expectedTurnRevision: value.running.revision,
                        expectedBranchRevision: new Revision(0),
                        token: value.token,
                        outcome: "failed",
                        commit: result,
                        forcedCancellationControl: forced.control,
                        siblingCancellations: new Map([[siblingId.value, forced.evidence]]),
                        now: new Date(1500)
                    }),
                variant === "control" ? "authority.denied" : "run.invalid-state"
            );
            const unchanged = value.repository.transaction((tx) =>
                value.repository.loadTurn(tx, siblingId)!
            );
            expect(unchanged.status.kind).toBe("running");
            expect(unchanged.lease.epoch).toBe(sibling.lease.epoch);
            expect(
                value.repository.transaction((tx) =>
                    value.repository.listForcedCancellations(tx, ids.run)
                )
            ).toEqual([]);
            expect(
                value.repository.transaction((tx) => value.repository.loadCommit(tx, result.id))
            ).toBeUndefined();
        }
    });

    it("rolls back sibling fences, records, and registry close when the terminal commit fails", () => {
        const value = seedRunningTurn();
        const siblingId = new TurnId("rollback-sibling");
        const placement = new TurnPlacementSnapshot(siblingId, pins(), []);
        value.runtime.createTurn(
            {
                turn: new Turn({
                    id: siblingId,
                    run: ids.run,
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: placement.digest,
                    input: content("3"),
                    revision: new Revision(0)
                }),
                placement
            },
            new Revision(0)
        );
        const sibling = value.repository.transaction((tx) =>
            value.repository.loadTurn(tx, siblingId)!
        );
        const forced = forcedCancellation(value, ids.turn, sibling, "rollback");
        const result = new RunCommit({
            id: new RunCommitId("rollback-terminal-result"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [new RunCommitId("stale-terminal-parent")],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("4")
        });

        expectCode(
            () =>
                value.runtime.terminalizeRun({
                    run: ids.run,
                    turn: ids.turn,
                    expectedRunRevision: value.repository.transaction(
                        (tx) => value.repository.loadRun(tx, ids.run)!.revision
                    ),
                    expectedTurnRevision: value.running.revision,
                    expectedBranchRevision: new Revision(0),
                    token: value.token,
                    outcome: "failed",
                    commit: result,
                    forcedCancellationControl: forced.control,
                    siblingCancellations: new Map([[siblingId.value, forced.evidence]]),
                    now: new Date(1500)
                }),
            "protocol.revision-conflict"
        );
        const unchanged = value.repository.transaction((tx) =>
            value.repository.loadTurn(tx, siblingId)!
        );
        expect(unchanged.status.kind).toBe("queued");
        expect(unchanged.lease.epoch).toBe(0);
        expect(
            value.repository.transaction((tx) => value.repository.loadAdmission(tx, ids.run))
                ?.accepting
        ).toBe(true);
        expect(
            value.repository.transaction((tx) =>
                value.repository.listForcedCancellations(tx, ids.run)
            )
        ).toEqual([]);
    });
});

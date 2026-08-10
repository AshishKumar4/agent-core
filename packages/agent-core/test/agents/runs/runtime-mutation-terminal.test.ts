import { describe, expect, test } from "vitest";
import { Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { RunCommit } from "../../../src/agents/runs/commit";
import { ForcedTurnCancellation } from "../../../src/agents/runs/forced-cancellation";
import { RunCheckpointId, RunId, TurnInboxEntryId } from "../../../src/agents/runs/id";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import type { TerminalizeRunRequest } from "../../../src/agents/runs/runtime";
import { RunCheckpoint, Turn, TurnInboxEntry } from "../../../src/agents/runs/turn";
import { PrincipalId, PrincipalRef } from "../../../src/identity";
import { ReceiptId } from "../../../src/invocation-references";
import { AuditRecordId, EventId } from "../../../src/interaction-references";
import { content, digest, harness, ids, pins, seedRunningTurn } from "./fixture";

function expectCode(
    operation: () => unknown,
    code: AgentCoreError["code"],
    message?: string
): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
        if (message !== undefined) expect((error as AgentCoreError).message).toBe(message);
        return;
    }
    expect.fail("expected operation to throw");
}

function must<Value>(value: Value | undefined): Value {
    if (value === undefined) throw new Error("expected a value");
    return value;
}

function cancelEntry(
    id: string,
    over: Partial<{
        sequence: number;
        event: string;
        key: string;
        token: { turn: TurnId; holder: PrincipalRef; epoch: number } | undefined;
    }> = {}
): TurnInboxEntry {
    const token = "token" in over ? over.token : { turn: ids.turn, holder: ids.holder, epoch: 1 };
    return new TurnInboxEntry(
        new TurnInboxEntryId(id),
        ids.turn,
        over.sequence ?? 0,
        over.event ?? "turn.cancel",
        content("2"),
        digest("2"),
        over.key ?? id,
        token,
        new Date(5000)
    );
}

function resultCommit(
    id: string,
    turn: TurnId,
    parent: RunCommitId,
    token: { turn: TurnId; holder: PrincipalRef; epoch: number }
): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "result",
        parents: [parent],
        pins: pins(),
        writer: { kind: "turn", token },
        subjectTurn: turn,
        content: content("3")
    });
}

function queueSibling(
    value: ReturnType<typeof seedRunningTurn>,
    id: string,
    branchRevision = new Revision(0),
    head: RunCommitId = ids.root
): TurnId {
    const turnId = new TurnId(id);
    const placement = new TurnPlacementSnapshot(turnId, pins(), []);
    value.runtime.createTurn(
        {
            turn: new Turn({
                id: turnId,
                run: ids.run,
                branch: ids.branch,
                startHead: head,
                effectiveInput: head,
                pins: pins(),
                placement: placement.digest,
                input: content("7"),
                revision: new Revision(0)
            }),
            placement
        },
        branchRevision
    );
    return turnId;
}

function claimSibling(value: ReturnType<typeof seedRunningTurn>, id: string): Turn {
    const turnId = queueSibling(value, id);
    return value.runtime.claimTurn(
        turnId,
        new Revision(0),
        ids.holder,
        new Date(1000),
        new Date(5000)
    );
}

function forcedEvidence(value: ReturnType<typeof seedRunningTurn>, sibling: Turn, suffix: string) {
    const receipt = new ReceiptId(`forced-control-${suffix}`);
    const controlAudit = new AuditRecordId(`forced-control-audit-${suffix}`);
    const event = new EventId(`forced-event-${suffix}`);
    const cancellationAudit = new AuditRecordId(`forced-audit-${suffix}`);
    value.evidence.administers.set(`${receipt.value}:${controlAudit.value}`, {
        kind: "administer",
        run: ids.run,
        terminalTurn: ids.turn,
        receipt,
        audit: controlAudit,
        outcome: "succeeded"
    });
    value.evidence.cancellations.set(`${event.value}:${cancellationAudit.value}`, {
        kind: "turnCancellation",
        eventKind: "turn.cancel",
        run: ids.run,
        terminalTurn: ids.turn,
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
        evidence: { event, audit: cancellationAudit },
        administerKey: `${receipt.value}:${controlAudit.value}`,
        cancellationKey: `${event.value}:${cancellationAudit.value}`
    };
}

function terminalRequest(
    value: ReturnType<typeof seedRunningTurn>,
    over: Partial<TerminalizeRunRequest> = {}
): TerminalizeRunRequest {
    return {
        run: ids.run,
        turn: ids.turn,
        expectedRunRevision: value.repository.transaction(
            (tx) => must(value.repository.loadRun(tx, ids.run)).revision
        ),
        expectedTurnRevision: value.running.revision,
        expectedBranchRevision: new Revision(0),
        token: value.token,
        outcome: "failed",
        commit: resultCommit("terminal-result", ids.turn, ids.root, value.token),
        siblingCancellations: new Map(),
        now: new Date(1500),
        ...over
    };
}

describe("turn cancellation appends", () => {
    test("rejects each malformed displaced-token cancellation entry", { tags: "p0" }, () => {
        const cases: readonly ((value: ReturnType<typeof seedRunningTurn>) => TurnInboxEntry)[] = [
            () => cancelEntry("cancel-not-cancel", { event: "message", token: undefined }),
            () => cancelEntry("cancel-wrong-sequence", { sequence: 1 }),
            () =>
                cancelEntry("cancel-stale-epoch", {
                    token: { turn: ids.turn, holder: ids.holder, epoch: 0 }
                }),
            () =>
                cancelEntry("cancel-wrong-holder", {
                    token: {
                        turn: ids.turn,
                        holder: new PrincipalRef(
                            ids.holder.tenantId,
                            new PrincipalId("principal-elsewhere")
                        ),
                        epoch: 1
                    }
                })
        ];
        for (const build of cases) {
            const value = seedRunningTurn();
            expectCode(
                () =>
                    value.runtime.reclaimTurn(
                        ids.turn,
                        value.running.revision,
                        ids.holder,
                        new Date(5000),
                        new Date(9000),
                        build(value)
                    ),
                "turn.invalid-state",
                "Turn cancellation must append the next entry for the displaced token"
            );
        }
    });

    test("rejects a cancellation reusing an inbox idempotency key", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        value.runtime.deliverEvent(
            ids.turn,
            value.running.revision,
            value.token,
            new TurnInboxEntry(
                new TurnInboxEntryId("inbox-shared"),
                ids.turn,
                0,
                "message",
                content("1"),
                digest("1"),
                "shared-key",
                undefined,
                new Date(1500)
            ),
            new Date(1500)
        );
        const current = value.repository.transaction((tx) =>
            must(value.repository.loadTurn(tx, ids.turn))
        );
        expectCode(
            () =>
                value.runtime.reclaimTurn(
                    ids.turn,
                    current.revision,
                    ids.holder,
                    new Date(5000),
                    new Date(9000),
                    cancelEntry("cancel-duplicate", { sequence: 1, key: "shared-key" })
                ),
            "turn.invalid-state",
            "Turn cancellation must append the next entry for the displaced token"
        );
    });

    test("reclaims an expired lease with an exact displaced cancellation", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        const replacement = new PrincipalRef(
            ids.holder.tenantId,
            new PrincipalId("principal-replacement")
        );
        const reclaimed = value.runtime.reclaimTurn(
            ids.turn,
            value.running.revision,
            replacement,
            new Date(5000),
            new Date(9000),
            cancelEntry("cancel-reclaim")
        );
        expect(reclaimed.lease.epoch).toBe(2);
        expect(must(reclaimed.lease.holder).equals(replacement)).toBe(true);
        expect(
            value.repository.transaction((tx) => value.repository.listInbox(tx, ids.turn))
        ).toHaveLength(1);
    });

    test("cannot displace a Turn that holds no lease", { tags: "p0" }, () => {
        const value = harness();
        const seeded = seedRunningTurn(value, { id: new TurnId("turn-held") });
        const queued = queueSibling(seeded, "turn-unheld");
        expectCode(
            () =>
                seeded.runtime.reclaimTurn(
                    queued,
                    new Revision(0),
                    ids.holder,
                    new Date(5000),
                    new Date(9000),
                    new TurnInboxEntry(
                        new TurnInboxEntryId("cancel-unheld"),
                        queued,
                        0,
                        "turn.cancel",
                        content("2"),
                        digest("2"),
                        "cancel-unheld",
                        { turn: queued, holder: ids.holder, epoch: 0 },
                        new Date(5000)
                    )
                ),
            "lease.invalid",
            "Turn has no held lease to displace"
        );
    });
});

describe("held cancellation and timeout fencing", () => {
    test("held cancellation requires a cancelled result", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        expectCode(
            () =>
                value.runtime.cancelHeldTurn(
                    {
                        turn: ids.turn,
                        expectedTurnRevision: value.running.revision,
                        expectedBranchRevision: new Revision(0),
                        token: value.token,
                        outcome: "failed",
                        commit: resultCommit("cancel-held-result", ids.turn, ids.root, value.token),
                        now: new Date(1500)
                    },
                    cancelEntry("cancel-held-entry")
                ),
            "turn.invalid-state",
            "Held cancellation requires a cancelled result"
        );
    });

    test("cancels a held Turn with a cancelled result and inbox fence", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        value.runtime.cancelHeldTurn(
            {
                turn: ids.turn,
                expectedTurnRevision: value.running.revision,
                expectedBranchRevision: new Revision(0),
                token: value.token,
                outcome: "cancelled",
                commit: resultCommit("cancel-held-exact", ids.turn, ids.root, value.token),
                now: new Date(1500)
            },
            cancelEntry("cancel-held-fence")
        );
        const cancelled = value.repository.transaction((tx) =>
            must(value.repository.loadTurn(tx, ids.turn))
        );
        expect(cancelled.status.kind).toBe("cancelled");
        expect(cancelled.lease.holder).toBeUndefined();
        expect(
            value.repository.transaction((tx) => value.repository.listInbox(tx, ids.turn))
        ).toHaveLength(1);
    });

    test("fences a held Turn after ordinary inbox traffic", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        value.runtime.deliverEvent(
            ids.turn,
            value.running.revision,
            value.token,
            new TurnInboxEntry(
                new TurnInboxEntryId("inbox-prior"),
                ids.turn,
                0,
                "message",
                content("1"),
                digest("1"),
                "prior-key",
                undefined,
                new Date(1400)
            ),
            new Date(1400)
        );
        const current = value.repository.transaction((tx) =>
            must(value.repository.loadTurn(tx, ids.turn))
        );
        value.runtime.cancelHeldTurn(
            {
                turn: ids.turn,
                expectedTurnRevision: current.revision,
                expectedBranchRevision: new Revision(0),
                token: value.token,
                outcome: "cancelled",
                commit: resultCommit("cancel-after-inbox", ids.turn, ids.root, value.token),
                now: new Date(1500)
            },
            cancelEntry("cancel-after-inbox-entry", { sequence: 1 })
        );
        expect(
            value.repository.transaction((tx) => value.repository.listInbox(tx, ids.turn))
        ).toHaveLength(2);
        expect(
            value.repository.transaction((tx) => must(value.repository.loadTurn(tx, ids.turn)))
                .status.kind
        ).toBe("cancelled");
    });

    test("timeout rejects a suspended Turn whose fenced lease has expired", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        const commit = new RunCommit({
            id: new RunCommitId("suspend-for-timeout"),
            run: ids.run,
            branch: ids.branch,
            kind: "checkpoint",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("d")
        });
        const checkpoint = new RunCheckpoint(
            new RunCheckpointId("suspend-for-timeout-checkpoint"),
            ids.turn,
            commit.id,
            content("d"),
            0,
            undefined
        );
        value.runtime.suspendTurn({
            turn: ids.turn,
            expectedTurnRevision: value.running.revision,
            expectedBranchRevision: new Revision(0),
            token: value.token,
            checkpoint,
            commit,
            now: new Date(1500)
        });
        const suspended = value.repository.transaction((tx) =>
            must(value.repository.loadTurn(tx, ids.turn))
        );
        expectCode(
            () =>
                value.runtime.timeoutTurn(
                    ids.turn,
                    suspended.revision,
                    cancelEntry("timeout-suspended"),
                    new Date(6000)
                ),
            "turn.invalid-state",
            "Turn timeout requires an expired running lease"
        );
    });

    test("timeout requires an expired running lease", { tags: "p0" }, () => {
        const queued = seedRunningTurn(harness(), { id: new TurnId("turn-held") });
        const queuedId = queueSibling(queued, "turn-queued");
        expectCode(
            () =>
                queued.runtime.timeoutTurn(
                    queuedId,
                    new Revision(0),
                    new TurnInboxEntry(
                        new TurnInboxEntryId("timeout-queued"),
                        queuedId,
                        0,
                        "turn.cancel",
                        content("2"),
                        digest("2"),
                        "timeout-queued",
                        { turn: queuedId, holder: ids.holder, epoch: 0 },
                        new Date(6000)
                    ),
                    new Date(6000)
                ),
            "turn.invalid-state",
            "Turn timeout requires an expired running lease"
        );

        const unexpired = seedRunningTurn();
        expectCode(
            () =>
                unexpired.runtime.timeoutTurn(
                    ids.turn,
                    unexpired.running.revision,
                    cancelEntry("timeout-unexpired"),
                    new Date(4999)
                ),
            "turn.invalid-state",
            "Turn timeout requires an expired running lease"
        );
    });

    test("times out exactly at lease expiry and fences the epoch", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        const fenced = value.runtime.timeoutTurn(
            ids.turn,
            value.running.revision,
            cancelEntry("timeout-boundary"),
            new Date(5000)
        );
        expect(fenced.status.kind).toBe("cancelled");
        expect(fenced.lease.holder).toBeUndefined();
        expect(fenced.lease.epoch).toBe(2);
        expect(
            value.repository.transaction((tx) => value.repository.listInbox(tx, ids.turn))
        ).toHaveLength(1);
    });
});

describe("terminalization guards", () => {
    test("terminal result must name the finishing Turn", { tags: "p0" }, () => {
        const nonResult = seedRunningTurn();
        const message = new RunCommit({
            id: new RunCommitId("terminal-not-result"),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: nonResult.token },
            subjectTurn: ids.turn,
            content: content("3")
        });
        expectCode(
            () => nonResult.runtime.terminalizeRun(terminalRequest(nonResult, { commit: message })),
            "run.invalid-state",
            "Terminal result does not match the finishing Turn"
        );

        const unnamed = seedRunningTurn();
        const forged = {
            ...resultCommit("terminal-unnamed", ids.turn, ids.root, unnamed.token),
            subjectTurn: undefined
        } as RunCommit;
        expectCode(
            () => unnamed.runtime.terminalizeRun(terminalRequest(unnamed, { commit: forged })),
            "run.invalid-state",
            "Terminal result does not match the finishing Turn"
        );
    });

    test("rejects an already-closed admission registry", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        value.repository.transaction((tx) => {
            const registry = must(value.repository.loadAdmission(tx, ids.run));
            value.repository.replaceAdmission(tx, registry, registry.close());
        });
        expectCode(
            () => value.runtime.terminalizeRun(terminalRequest(value)),
            "run.invalid-state",
            "Run admission registry is already closed"
        );
    });
});

describe("forced sibling cancellation", () => {
    test("rejects preexisting forced cancellation records", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        value.repository.transaction((tx) =>
            value.repository.insertForcedCancellation(
                tx,
                new ForcedTurnCancellation({
                    run: ids.run,
                    terminalTurn: ids.turn,
                    turn: new TurnId("turn-phantom"),
                    priorLeaseEpoch: 0,
                    fencedLeaseEpoch: 1,
                    controlReceipt: new ReceiptId("phantom-receipt"),
                    controlAudit: new AuditRecordId("phantom-control-audit"),
                    cancellationEvent: new EventId("phantom-event"),
                    cancellationAudit: new AuditRecordId("phantom-audit")
                })
            )
        );
        expectCode(
            () => value.runtime.terminalizeRun(terminalRequest(value)),
            "run.invalid-state",
            "Active Run contains preexisting forced cancellation records"
        );
    });

    test("rejects unused forced cancellation evidence", { tags: "p0" }, () => {
        const control = seedRunningTurn();
        expectCode(
            () =>
                control.runtime.terminalizeRun(
                    terminalRequest(control, {
                        forcedCancellationControl: {
                            receipt: new ReceiptId("unused-receipt"),
                            audit: new AuditRecordId("unused-audit")
                        }
                    })
                ),
            "run.invalid-state",
            "Terminalization supplied unused forced cancellation evidence"
        );

        const map = seedRunningTurn();
        expectCode(
            () =>
                map.runtime.terminalizeRun(
                    terminalRequest(map, {
                        siblingCancellations: new Map([
                            [
                                "turn-anything",
                                {
                                    event: new EventId("unused-event"),
                                    audit: new AuditRecordId("unused-map-audit")
                                }
                            ]
                        ])
                    })
                ),
            "run.invalid-state",
            "Terminalization supplied unused forced cancellation evidence"
        );
    });

    test("requires one control and exact evidence for every active sibling", { tags: "p0" }, () => {
        const noControl = seedRunningTurn();
        const noControlSibling = claimSibling(noControl, "sibling-no-control");
        expectCode(
            () =>
                noControl.runtime.terminalizeRun(
                    terminalRequest(noControl, {
                        siblingCancellations: new Map([
                            [
                                noControlSibling.id.value,
                                {
                                    event: new EventId("no-control-event"),
                                    audit: new AuditRecordId("no-control-audit")
                                }
                            ]
                        ])
                    })
                ),
            "run.invalid-state",
            "Terminalization requires one control and exact evidence for every active sibling"
        );

        const bare = seedRunningTurn();
        claimSibling(bare, "sibling-bare");
        expectCode(
            () => bare.runtime.terminalizeRun(terminalRequest(bare)),
            "run.invalid-state",
            "Terminalization requires one control and exact evidence for every active sibling"
        );

        const short = seedRunningTurn();
        const shortSibling = claimSibling(short, "sibling-short");
        const forced = forcedEvidence(short, shortSibling, "short");
        expectCode(
            () =>
                short.runtime.terminalizeRun(
                    terminalRequest(short, { forcedCancellationControl: forced.control })
                ),
            "run.invalid-state",
            "Terminalization requires one control and exact evidence for every active sibling"
        );
    });

    test("requires sibling cancellation evidence under the exact Turn key", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        const sibling = claimSibling(value, "sibling-mislabeled");
        const forced = forcedEvidence(value, sibling, "mislabeled");
        expectCode(
            () =>
                value.runtime.terminalizeRun(
                    terminalRequest(value, {
                        forcedCancellationControl: forced.control,
                        siblingCancellations: new Map([["turn-wrong-key", forced.evidence]])
                    })
                ),
            "run.invalid-state",
            "Terminalization is missing sibling cancellation evidence"
        );
    });

    test("rejects every administer control evidence mismatch", { tags: "p0" }, () => {
        const cases: readonly ((
            value: ReturnType<typeof seedRunningTurn>,
            forced: ReturnType<typeof forcedEvidence>
        ) => void)[] = [
            (value, forced) => value.evidence.administers.delete(forced.administerKey),
            (value, forced) => {
                const stored = must(value.evidence.administers.get(forced.administerKey));
                value.evidence.administers.set(forced.administerKey, {
                    ...stored,
                    kind: "control"
                } as never);
            },
            (value, forced) => {
                const stored = must(value.evidence.administers.get(forced.administerKey));
                value.evidence.administers.set(forced.administerKey, {
                    ...stored,
                    outcome: "failed"
                } as never);
            },
            (value, forced) => {
                const stored = must(value.evidence.administers.get(forced.administerKey));
                value.evidence.administers.set(forced.administerKey, {
                    ...stored,
                    run: new RunId("run-elsewhere")
                });
            },
            (value, forced) => {
                const stored = must(value.evidence.administers.get(forced.administerKey));
                value.evidence.administers.set(forced.administerKey, {
                    ...stored,
                    terminalTurn: new TurnId("turn-elsewhere")
                });
            },
            (value, forced) => {
                const stored = must(value.evidence.administers.get(forced.administerKey));
                value.evidence.administers.set(forced.administerKey, {
                    ...stored,
                    receipt: new ReceiptId("receipt-elsewhere")
                });
            },
            (value, forced) => {
                const stored = must(value.evidence.administers.get(forced.administerKey));
                value.evidence.administers.set(forced.administerKey, {
                    ...stored,
                    audit: new AuditRecordId("audit-elsewhere")
                });
            }
        ];
        for (const mutate of cases) {
            const value = seedRunningTurn();
            const sibling = claimSibling(value, "sibling-administer");
            const forced = forcedEvidence(value, sibling, "administer");
            mutate(value, forced);
            expectCode(
                () =>
                    value.runtime.terminalizeRun(
                        terminalRequest(value, {
                            forcedCancellationControl: forced.control,
                            siblingCancellations: new Map([[sibling.id.value, forced.evidence]])
                        })
                    ),
                "authority.denied",
                "Forced cancellation requires the exact successful administer Receipt and Audit"
            );
            expect(
                value.repository.transaction((tx) =>
                    value.repository.listForcedCancellations(tx, ids.run)
                )
            ).toEqual([]);
        }
    });

    test("rejects every forced cancellation evidence mismatch", { tags: "p0" }, () => {
        const cases: readonly ((
            value: ReturnType<typeof seedRunningTurn>,
            forced: ReturnType<typeof forcedEvidence>,
            sibling: Turn
        ) => void)[] = [
            (value, forced) => value.evidence.cancellations.delete(forced.cancellationKey),
            (value, forced) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    kind: "administer"
                } as never);
            },
            (value, forced) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    eventKind: "turn.message"
                } as never);
            },
            (value, forced) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    run: new RunId("run-elsewhere")
                });
            },
            (value, forced) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    terminalTurn: new TurnId("turn-elsewhere")
                });
            },
            (value, forced) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    turn: new TurnId("turn-elsewhere")
                });
            },
            (value, forced, sibling) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    priorLeaseEpoch: sibling.lease.epoch + 1
                });
            },
            (value, forced, sibling) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    fencedLeaseEpoch: sibling.lease.epoch + 2
                });
            },
            (value, forced, sibling) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    inboxLeaseEpoch: sibling.lease.epoch + 1
                });
            },
            (value, forced) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    controlReceipt: new ReceiptId("receipt-elsewhere")
                });
            },
            (value, forced) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    controlAudit: new AuditRecordId("audit-elsewhere")
                });
            },
            (value, forced) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    event: new EventId("event-elsewhere")
                });
            },
            (value, forced) => {
                const stored = must(value.evidence.cancellations.get(forced.cancellationKey));
                value.evidence.cancellations.set(forced.cancellationKey, {
                    ...stored,
                    audit: new AuditRecordId("audit-elsewhere")
                });
            }
        ];
        for (const mutate of cases) {
            const value = seedRunningTurn();
            const sibling = claimSibling(value, "sibling-fence");
            const forced = forcedEvidence(value, sibling, "fence");
            mutate(value, forced, sibling);
            expectCode(
                () =>
                    value.runtime.terminalizeRun(
                        terminalRequest(value, {
                            forcedCancellationControl: forced.control,
                            siblingCancellations: new Map([[sibling.id.value, forced.evidence]])
                        })
                    ),
                "run.invalid-state",
                "Forced cancellation inbox and Audit evidence do not match the fence"
            );
            const unchanged = value.repository.transaction((tx) =>
                must(value.repository.loadTurn(tx, sibling.id))
            );
            expect(unchanged.status.kind).toBe("running");
        }
    });

    test("fences a running sibling with exact durable evidence", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        const sibling = claimSibling(value, "sibling-fenced");
        const forced = forcedEvidence(value, sibling, "fenced");
        const snapshot = value.runtime.terminalizeRun(
            terminalRequest(value, {
                forcedCancellationControl: forced.control,
                siblingCancellations: new Map([[sibling.id.value, forced.evidence]])
            })
        );
        expect(snapshot.outcome).toBe("failed");
        const fenced = value.repository.transaction((tx) =>
            must(value.repository.loadTurn(tx, sibling.id))
        );
        expect(fenced.status.kind).toBe("cancelled");
        expect(fenced.lease.holder).toBeUndefined();
        expect(fenced.lease.epoch).toBe(2);
        const record = value.repository.transaction((tx) =>
            must(value.repository.loadForcedCancellation(tx, sibling.id))
        );
        expect(record.priorLeaseEpoch).toBe(1);
        expect(record.fencedLeaseEpoch).toBe(2);
        expect(record.terminalTurn.equals(ids.turn)).toBe(true);
        expect(
            value.repository.transaction(
                (tx) => must(value.repository.loadRun(tx, ids.run)).lifecycle.kind
            )
        ).toBe("terminal");
    });

    test("fences a queued sibling with exact durable evidence", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        const queuedId = queueSibling(value, "sibling-queued-fence");
        const sibling = value.repository.transaction((tx) =>
            must(value.repository.loadTurn(tx, queuedId))
        );
        const forced = forcedEvidence(value, sibling, "queued-fence");
        const snapshot = value.runtime.terminalizeRun(
            terminalRequest(value, {
                forcedCancellationControl: forced.control,
                siblingCancellations: new Map([[queuedId.value, forced.evidence]])
            })
        );
        expect(snapshot.outcome).toBe("failed");
        const fenced = value.repository.transaction((tx) =>
            must(value.repository.loadTurn(tx, queuedId))
        );
        expect(fenced.status.kind).toBe("cancelled");
        expect(fenced.lease.holder).toBeUndefined();
        expect(fenced.lease.epoch).toBe(1);
        const record = value.repository.transaction((tx) =>
            must(value.repository.loadForcedCancellation(tx, queuedId))
        );
        expect(record.priorLeaseEpoch).toBe(0);
        expect(record.fencedLeaseEpoch).toBe(1);
    });

    test(
        "terminalizes cleanly over succeeded, failed, and cancelled siblings",
        { tags: "p0" },
        () => {
            const value = seedRunningTurn();
            const succeeded = claimSibling(value, "sibling-succeeded");
            const succeededResult = resultCommit(
                "sibling-succeeded-result",
                succeeded.id,
                ids.root,
                {
                    turn: succeeded.id,
                    holder: ids.holder,
                    epoch: 1
                }
            );
            value.runtime.completeTurn({
                turn: succeeded.id,
                expectedTurnRevision: succeeded.revision,
                expectedBranchRevision: new Revision(0),
                token: { turn: succeeded.id, holder: ids.holder, epoch: 1 },
                outcome: "succeeded",
                commit: succeededResult,
                now: new Date(1200)
            });

            const failedId = queueSibling(
                value,
                "sibling-failed",
                new Revision(1),
                succeededResult.id
            );
            const failed = value.runtime.claimTurn(
                failedId,
                new Revision(0),
                ids.holder,
                new Date(1200),
                new Date(5000)
            );
            const failedResult = resultCommit(
                "sibling-failed-result",
                failedId,
                succeededResult.id,
                {
                    turn: failedId,
                    holder: ids.holder,
                    epoch: 1
                }
            );
            value.runtime.completeTurn({
                turn: failedId,
                expectedTurnRevision: failed.revision,
                expectedBranchRevision: new Revision(1),
                token: { turn: failedId, holder: ids.holder, epoch: 1 },
                outcome: "failed",
                commit: failedResult,
                now: new Date(1300)
            });

            const cancelledId = queueSibling(
                value,
                "sibling-cancelled",
                new Revision(2),
                failedResult.id
            );
            value.runtime.cancelUnheldTurn(cancelledId, new Revision(0));

            const snapshot = value.runtime.terminalizeRun(
                terminalRequest(value, {
                    outcome: "succeeded",
                    expectedBranchRevision: new Revision(2),
                    commit: resultCommit("terminal-final", ids.turn, failedResult.id, value.token)
                })
            );
            expect(snapshot.outcome).toBe("succeeded");
            expect(
                value.repository.transaction((tx) =>
                    value.repository.listForcedCancellations(tx, ids.run)
                )
            ).toEqual([]);
            for (const [turnId, status] of [
                [succeeded.id, "succeeded"],
                [failedId, "failed"],
                [cancelledId, "cancelled"]
            ] as const) {
                const sibling = value.repository.transaction((tx) =>
                    must(value.repository.loadTurn(tx, turnId))
                );
                expect(sibling.status.kind).toBe(status);
                expect(sibling.lease.holder).toBeUndefined();
            }
            expect(value.runtime.settled(ids.run)).toBe(true);
        }
    );
});

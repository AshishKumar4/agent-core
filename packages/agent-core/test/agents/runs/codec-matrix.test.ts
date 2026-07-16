import { describe, expect, it } from "vitest";
import { RunCommitId } from "../../../src/execution-references";
import { RunCommit, RunCommitCodec } from "../../../src/agents/runs/commit";
import { ApprovalId, EffectAttemptId, ReceiptId } from "../../../src/invocations";
import { InvocationId, RouteReservationId } from "../../../src/interaction-references";
import {
    SettlementEvidencePort,
    SettlementObligation,
    TerminalSnapshot,
    TerminalSnapshotCodec,
    isSettled,
    type SettlementAuditObligation
} from "../../../src/agents/runs/settlement";
import { RunLifecycle } from "../../../src/agents/runs/run";
import { content, genesis, ids, pins, refs } from "./fixture";

function roundTrip(commit: RunCommit): RunCommit {
    return RunCommitCodec.decode(RunCommitCodec.encode(commit));
}

describe("Run commit codec matrix", () => {
    it("round-trips delivery and every tree resolution shape", () => {
        const delivery = roundTrip(
            new RunCommit({
                id: new RunCommitId("delivery"),
                run: ids.run,
                branch: ids.branch,
                kind: "eventDelivery",
                parents: [ids.root],
                pins: pins(),
                writer: {
                    kind: "system",
                    cause: { kind: "delivery", audit: refs.audit, reservation: refs.route }
                },
                reservation: refs.route,
                treeCheckpoint: content("a")
            })
        );
        expect(delivery.writer.kind).toBe("system");
        expect(delivery.treeCheckpoint?.equals(content("a"))).toBe(true);

        const source = new RunCommitId("source");
        const common = {
            run: ids.run,
            branch: ids.branch,
            kind: "merge" as const,
            parents: [ids.root, source],
            pins: pins(),
            writer: {
                kind: "system" as const,
                cause: { kind: "control" as const, audit: refs.audit, receipt: refs.receipt }
            },
            content: content("b"),
            resolution: { kind: "concat" as const },
            treeCheckpoint: content("c"),
            receipt: refs.receipt
        };
        const ours = roundTrip(
            new RunCommit({
                ...common,
                id: new RunCommitId("merge-ours"),
                treeResolution: {
                    policy: "ours",
                    side: ids.root,
                    base: content("d"),
                    environment: "environment"
                }
            })
        );
        const theirs = roundTrip(
            new RunCommit({
                ...common,
                id: new RunCommitId("merge-theirs"),
                treeResolution: {
                    policy: "theirs",
                    side: source,
                    base: content("d"),
                    environment: "environment"
                }
            })
        );
        const perPath = roundTrip(
            new RunCommit({
                ...common,
                id: new RunCommitId("merge-paths"),
                treeResolution: {
                    policy: "perPath",
                    base: content("d"),
                    environment: "environment",
                    resolutions: [
                        { path: "/a", side: ids.root },
                        { path: "/b", side: source }
                    ]
                }
            })
        );
        expect(ours.treeResolution?.policy).toBe("ours");
        expect(theirs.treeResolution?.policy).toBe("theirs");
        expect(perPath.treeResolution?.policy).toBe("perPath");
        expect(
            () =>
                new RunCommit({
                    ...common,
                    id: new RunCommitId("merge-duplicate-path"),
                    treeResolution: {
                        policy: "perPath",
                        base: content("d"),
                        environment: "environment",
                        resolutions: [
                            { path: "/same", side: ids.root },
                            { path: "/same", side: source }
                        ]
                    }
                })
        ).toThrow(/unique/);
    });

    it("round-trips pick and synthesis resolution evidence", () => {
        const source = new RunCommitId("source-2");
        const control = {
            kind: "system" as const,
            cause: { kind: "control" as const, audit: refs.audit, receipt: refs.receipt }
        };
        const pick = roundTrip(
            new RunCommit({
                id: new RunCommitId("merge-pick"),
                run: ids.run,
                branch: ids.branch,
                kind: "merge",
                parents: [ids.root, source],
                pins: pins(),
                writer: control,
                content: content("e"),
                resolution: { kind: "pick", parent: ids.root },
                receipt: refs.receipt
            })
        );
        const synth = roundTrip(
            new RunCommit({
                id: new RunCommitId("merge-synth"),
                run: ids.run,
                branch: ids.branch,
                kind: "merge",
                parents: [ids.root, source],
                pins: pins(),
                writer: control,
                subjectTurn: ids.turn,
                content: content("f"),
                resolution: {
                    kind: "synthesize",
                    token: { turn: ids.turn, holder: ids.holder, epoch: 2 },
                    receipt: new ReceiptId("synthesis-receipt")
                },
                receipt: refs.receipt
            })
        );
        expect(pick.resolution?.kind).toBe("pick");
        expect(synth.resolution?.kind).toBe("synthesize");
    });
});

class MatrixSettlementPort extends SettlementEvidencePort<object> {
    public readonly missing = new Set<string>();
    public approvalResolved(_tx: object, value: ApprovalId): boolean {
        return !this.missing.has(`approval:${value.value}`);
    }
    public invocationItemTerminal(
        _tx: object,
        value: InvocationId,
        itemIndex: number,
        itemKey: string
    ): boolean {
        return !this.missing.has(`invocation:${value.value}:${itemIndex}:${itemKey}`);
    }
    public routeTerminal(_tx: object, value: RouteReservationId): boolean {
        return !this.missing.has(`route:${value.value}`);
    }
    public reconciliationSuperseded(_tx: object, value: EffectAttemptId): boolean {
        return !this.missing.has(`reconciliation:${value.value}`);
    }
    public commitExists(_tx: object, value: RunCommitId): boolean {
        return !this.missing.has(`commit:${value.value}`);
    }
    public auditSatisfied(_tx: object, value: SettlementAuditObligation): boolean {
        return !this.missing.has(`audit:${auditKey(value)}`);
    }
}

function auditKey(audit: SettlementAuditObligation): string {
    switch (audit.kind) {
        case "receipt":
            return `receipt:${audit.invocation.value}:${audit.itemIndex}:${audit.itemKey}`;
        case "delivery":
            return `delivery:${audit.reservation.value}`;
        case "commit":
            return `commit:${audit.commit.value}`;
    }
}

describe("Settlement codec and lifecycle", () => {
    it("derives every typed audit obligation from the frontier and round-trips", () => {
        const obligation = new SettlementObligation({
            registryEpoch: 4,
            obligations: [
                {
                    kind: "invocationItem",
                    invocation: refs.invocation,
                    itemIndex: 0,
                    itemKey: "matrix-item"
                },
                { kind: "route", reservation: refs.route },
                { kind: "systemCommit", commit: new RunCommitId("required") }
            ]
        });
        const snapshot = new TerminalSnapshot(
            ids.run,
            ids.turn,
            ids.root,
            new RunCommitId("terminal"),
            "failed",
            obligation,
            new Date(1000)
        );
        const decoded = TerminalSnapshotCodec.decode(TerminalSnapshotCodec.encode(snapshot));
        expect(decoded.recordedAt.getTime()).toBe(1000);
        expect(decoded.obligation.requiredAudits.map((value) => value.kind)).toEqual([
            "commit",
            "delivery",
            "receipt"
        ]);
        const port = new MatrixSettlementPort();
        expect(isSettled({}, decoded.obligation, port)).toBe(true);
        for (const missing of [
            `invocation:${refs.invocation.value}:0:matrix-item`,
            `route:${refs.route.value}`,
            "commit:required",
            `audit:receipt:${refs.invocation.value}:0:matrix-item`,
            `audit:delivery:${refs.route.value}`,
            "audit:commit:required"
        ]) {
            port.missing.clear();
            port.missing.add(missing);
            expect(isSettled({}, decoded.obligation, port)).toBe(false);
        }
        expect(
            () =>
                new SettlementObligation({
                    registryEpoch: 1,
                    obligations: [
                        { kind: "route", reservation: refs.route },
                        { kind: "route", reservation: refs.route }
                    ]
                })
        ).toThrow(/unique/);
        expect(SettlementObligation.decode(SettlementObligation.encode(obligation))).toEqual(
            obligation
        );
        const invalidObligation = structuredClone(obligation.toData()) as {
            obligations: Array<{ kind: string }>;
        };
        invalidObligation.obligations[0]!.kind = "unknown";
        expect(() => SettlementObligation.fromData(invalidObligation as never)).toThrow(/kind/);
        const invalidOutcome = structuredClone(snapshot.toData()) as Record<string, unknown>;
        invalidOutcome["outcome"] = "unknown";
        expect(() => TerminalSnapshot.fromData(invalidOutcome as never)).toThrow(/outcome/);
        expect(
            () =>
                new TerminalSnapshot(
                    ids.run,
                    ids.turn,
                    ids.root,
                    new RunCommitId("invalid-outcome"),
                    "unknown" as never,
                    obligation,
                    new Date(1)
                )
        ).toThrow(/outcome/);
    });

    it("keeps terminal state immutable and permits only captured evidence revision", () => {
        const obligation = new SettlementObligation({
            registryEpoch: 1,
            obligations: []
        });
        const terminal = genesis().run.terminalize(
            new TerminalSnapshot(
                ids.run,
                ids.turn,
                ids.root,
                new RunCommitId("terminal-2"),
                "cancelled",
                obligation,
                new Date(2000)
            )
        );
        expect(terminal.lifecycle.kind).toBe("terminal");
        expect(terminal.recordEvidence().revision.value).toBe(2);
        expect(() => terminal.terminalize(terminal.terminal!)).toThrow(/Terminal/);
        expect(() => genesis().run.recordEvidence()).toThrow(/terminal/);
        expect(RunLifecycle.from("active").kind).toBe("active");
    });
});

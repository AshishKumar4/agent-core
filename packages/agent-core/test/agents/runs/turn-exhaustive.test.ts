import { describe, expect, it } from "vitest";
import { Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { PrincipalId, PrincipalRef } from "../../../src/identity";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { RunCheckpointId, TurnInboxEntryId } from "../../../src/agents/runs/id";
import { TurnLease } from "../../../src/agents/runs/lease";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { RunCheckpoint, Turn, TurnInboxEntry, TurnStatus } from "../../../src/agents/runs/turn";
import { content, digest, ids, pins } from "./fixture";

function queued(overrides: Partial<ConstructorParameters<typeof Turn>[0]> = {}): Turn {
    const placement = new TurnPlacementSnapshot(overrides.id ?? ids.turn, pins(), []);
    return new Turn({
        id: ids.turn,
        run: ids.run,
        branch: ids.branch,
        startHead: ids.root,
        effectiveInput: ids.root,
        pins: pins(),
        placement: placement.digest,
        input: content("a"),
        revision: new Revision(0),
        ...overrides
    });
}

function expectCode(operation: () => unknown, code: AgentCoreError["code"]): void {
    try {
        operation();
        throw new Error("Expected operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
    }
}

describe("TurnStatus complete transition matrix", () => {
    it("[C13-TURN-CHILD-RUN-WRITER] rejects every illegal queued, running, suspended, and terminal transition", () => {
        expectCode(() => TurnStatus.queued.suspend(), "turn.invalid-state");
        expectCode(() => TurnStatus.queued.complete("failed"), "turn.invalid-state");
        expectCode(() => TurnStatus.running.claim(), "turn.invalid-state");
        expectCode(() => TurnStatus.running.cancelUnheld(), "turn.invalid-state");
        expectCode(() => TurnStatus.suspended.suspend(), "turn.invalid-state");
        expectCode(() => TurnStatus.suspended.complete("failed"), "turn.invalid-state");
        for (const status of [TurnStatus.succeeded, TurnStatus.failed, TurnStatus.cancelled]) {
            expectCode(() => status.claim(), "turn.invalid-state");
            expectCode(() => status.suspend(), "turn.invalid-state");
            expectCode(() => status.complete("failed"), "turn.invalid-state");
            expectCode(() => status.cancelUnheld(), "turn.invalid-state");
        }
    });

    it("returns every legal status singleton", () => {
        expect(TurnStatus.queued.claim().kind).toBe("running");
        expect(TurnStatus.running.suspend().kind).toBe("suspended");
        expect(TurnStatus.running.complete("succeeded").kind).toBe("succeeded");
        expect(TurnStatus.running.complete("failed").kind).toBe("failed");
        expect(TurnStatus.running.complete("cancelled").kind).toBe("cancelled");
        expect(TurnStatus.suspended.claim().kind).toBe("running");
        expect(TurnStatus.suspended.cancelUnheld().kind).toBe("cancelled");
    });
});

describe("Turn aggregate exhaustive behavior", () => {
    it("rejects every invalid aggregate shape", () => {
        expect(() =>
            queued({
                lease: TurnLease.unclaimed(new TurnId("other"))
            })
        ).toThrow(/another Turn/);
        expect(() =>
            queued({
                lease: TurnLease.restore(ids.turn, ids.holder, 1, new Date(10))
            })
        ).toThrow(/epoch-zero/);
        expect(() =>
            queued({
                status: TurnStatus.running,
                lease: TurnLease.unclaimed(ids.turn)
            })
        ).toThrow(/held lease/);
        expect(() =>
            queued({
                status: TurnStatus.failed,
                lease: TurnLease.restore(ids.turn, ids.holder, 1, new Date(10))
            })
        ).toThrow(/unheld/);
        expect(() =>
            queued({
                status: TurnStatus.suspended,
                lease: TurnLease.restore(ids.turn, undefined, 2, new Date(10))
            })
        ).toThrow(/checkpoint/);
        expect(() =>
            queued({
                status: TurnStatus.failed,
                lease: TurnLease.restore(ids.turn, undefined, 2, new Date(10))
            })
        ).toThrow(/result/);
    });

    it("rejects lifecycle methods outside running and exact-token state", () => {
        const value = queued();
        const token = { turn: ids.turn, holder: ids.holder, epoch: 1 };
        expectCode(() => value.renew(token, new Date(1), new Date(10)), "turn.invalid-state");
        expectCode(
            () => value.reclaim(ids.holder, new Date(1), new Date(10)),
            "turn.invalid-state"
        );
        const running = value.claim(ids.holder, new Date(1), new Date(10));
        for (const invalid of [
            { turn: new TurnId("other"), holder: ids.holder, epoch: 1 },
            {
                turn: ids.turn,
                holder: new PrincipalRef(ids.holder.tenantId, new PrincipalId("other")),
                epoch: 1
            },
            { turn: ids.turn, holder: ids.holder, epoch: 2 }
        ]) {
            expectCode(() => running.requireToken(invalid, new Date(2)), "lease.invalid");
        }
        expectCode(() => running.requireToken(token, new Date(10)), "lease.invalid");
    });

    it("[C13-TURN-NO-RETRY] rejects retry linkage in the Turn record codec", () => {
        const value = queued();
        expect("retryOf" in value).toBe(false);
        expect("retryOf" in (value.toData() as object)).toBe(false);
        const data = { ...(value.toData() as object), retryOf: "prior" };
        expect(() => Turn.fromData(data as never)).toThrow(/fields/);
    });

    it("round-trips optional checkpoint, result, lease, and every status", () => {
        const checkpoint = new RunCheckpointId("checkpoint");
        const result = content("b");
        for (const status of [
            TurnStatus.queued,
            TurnStatus.suspended,
            TurnStatus.succeeded,
            TurnStatus.failed,
            TurnStatus.cancelled
        ]) {
            const lease =
                status.kind === "queued"
                    ? TurnLease.unclaimed(ids.turn)
                    : TurnLease.restore(ids.turn, undefined, 2, new Date(10));
            const value = queued({
                status,
                lease,
                ...(status.kind === "queued" ? {} : { checkpoint }),
                ...(status.kind === "succeeded" || status.kind === "failed" ? { result } : {})
            });
            expect(Turn.decode(Turn.encode(value)).status.kind).toBe(status.kind);
        }
        const data = structuredClone(queued().toData()) as Record<string, unknown>;
        data["status"] = "unknown";
        expect(() => Turn.fromData(data as never)).toThrow(/status/);
    });

    it("round-trips advisory cache lineage without affecting transitions", () => {
        const value = queued({
            cacheLineage: {
                turn: new TurnId("cache-parent"),
                promptPrefix: digest("f")
            }
        });
        const decoded = Turn.decode(Turn.encode(value));
        expect(decoded.cacheLineage?.turn.value).toBe("cache-parent");
        expect(decoded.claim(ids.holder, new Date(1), new Date(10)).cacheLineage).toEqual(
            decoded.cacheLineage
        );
    });
});

describe("checkpoint and inbox codecs", () => {
    it("round-trips tree and no-tree checkpoints and rejects cursor shape", () => {
        const withTree = new RunCheckpoint(
            new RunCheckpointId("with-tree"),
            ids.turn,
            new RunCommitId("commit"),
            content("c"),
            1,
            content("d")
        );
        const withoutTree = new RunCheckpoint(
            new RunCheckpointId("without-tree"),
            ids.turn,
            new RunCommitId("commit"),
            content("c"),
            0,
            undefined
        );
        expect(RunCheckpoint.decode(RunCheckpoint.encode(withTree)).tree).toBeDefined();
        expect(RunCheckpoint.decode(RunCheckpoint.encode(withoutTree)).tree).toBeUndefined();
        expect(
            () =>
                new RunCheckpoint(
                    new RunCheckpointId("bad"),
                    ids.turn,
                    new RunCommitId("commit"),
                    content("c"),
                    -1,
                    undefined
                )
        ).toThrow(/cursor/);
    });

    it("round-trips ordinary and cancellation inbox entries and rejects every malformed shape", () => {
        const ordinary = new TurnInboxEntry(
            new TurnInboxEntryId("ordinary"),
            ids.turn,
            0,
            "message",
            content("e"),
            digest("e"),
            "key",
            undefined,
            new Date(1)
        );
        const cancelled = new TurnInboxEntry(
            new TurnInboxEntryId("cancel"),
            ids.turn,
            1,
            "turn.cancel",
            content("e"),
            digest("e"),
            "cancel-key",
            { turn: ids.turn, holder: ids.holder, epoch: 1 },
            new Date(2)
        );
        expect(
            TurnInboxEntry.decode(TurnInboxEntry.encode(ordinary)).cancellationToken
        ).toBeUndefined();
        expect(
            TurnInboxEntry.decode(TurnInboxEntry.encode(cancelled)).cancellationToken?.epoch
        ).toBe(1);
        expect(
            () =>
                new TurnInboxEntry(
                    new TurnInboxEntryId("sequence"),
                    ids.turn,
                    -1,
                    "message",
                    content("e"),
                    digest("e"),
                    "key",
                    undefined,
                    new Date(1)
                )
        ).toThrow(/sequence/);
        expect(
            () =>
                new TurnInboxEntry(
                    new TurnInboxEntryId("empty"),
                    ids.turn,
                    0,
                    "",
                    content("e"),
                    digest("e"),
                    "",
                    undefined,
                    new Date(1)
                )
        ).toThrow(/required/);
        expect(
            () =>
                new TurnInboxEntry(
                    new TurnInboxEntryId("token"),
                    ids.turn,
                    0,
                    "message",
                    content("e"),
                    digest("e"),
                    "key",
                    { turn: ids.turn, holder: ids.holder, epoch: 1 },
                    new Date(1)
                )
        ).toThrow(/turn.cancel/);
        expect(
            () =>
                new TurnInboxEntry(
                    new TurnInboxEntryId("date"),
                    ids.turn,
                    0,
                    "message",
                    content("e"),
                    digest("e"),
                    "key",
                    undefined,
                    new Date(Number.NaN)
                )
        ).toThrow(/timestamp/);
        expect(
            () =>
                new TurnInboxEntry(
                    new TurnInboxEntryId("digest"),
                    ids.turn,
                    0,
                    "message",
                    content("e"),
                    digest("f"),
                    "key",
                    undefined,
                    new Date(1)
                )
        ).toThrow(/digest/);
    });
});

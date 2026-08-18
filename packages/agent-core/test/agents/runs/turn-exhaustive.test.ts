import { describe, expect, it } from "vitest";
import { Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { PrincipalId, PrincipalRef } from "../../../src/identity";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { RunCheckpointId, TurnInboxEntryId } from "../../../src/agents/runs/id";
import { TurnLease } from "../../../src/agents/runs/lease";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { RunCheckpoint, Turn, TurnInboxEntry, TurnStatus } from "../../../src/agents/runs/turn";
import {
    content,
    digest,
    ids,
    mutableData,
    objectAt,
    pins,
    thrownBy,
    type TurnOverrides
} from "./fixture";

function queued(overrides: TurnOverrides = {}): Turn {
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

function expectCode(operation: () => void, code: AgentCoreError["code"]): void {
    expect(thrownBy(AgentCoreError, operation).code).toBe(code);
}

describe("TurnStatus complete transition matrix", () => {
    it(
        "[C13-TURN-EXECUTOR-WRITER] rejects every illegal queued, running, suspended, and terminal transition",
        { tags: "p1" },
        () => {
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
        }
    );

    it("returns every legal status singleton", { tags: "p1" }, () => {
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
    it("rejects every invalid aggregate shape", { tags: "p2" }, () => {
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

    it("rejects lifecycle methods outside running and exact-token state", { tags: "p0" }, () => {
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

    it("[C13-TURN-NO-RETRY] rejects retry linkage in the Turn record codec", { tags: "p0" }, () => {
        const value = queued();
        expect("retryOf" in value).toBe(false);
        expect("retryOf" in objectAt(value.toData(), "Turn")).toBe(false);
        const data = { ...objectAt(value.toData(), "Turn"), retryOf: "prior" };
        expect(() => Turn.fromData(data)).toThrow(/fields/);
    });

    it("round-trips optional checkpoint, result, lease, and every status", { tags: "p1" }, () => {
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
            const overrides: TurnOverrides = { status, lease };
            if (status.kind !== "queued") overrides.checkpoint = checkpoint;
            if (status.kind === "succeeded" || status.kind === "failed") overrides.result = result;
            const value = queued(overrides);
            expect(Turn.decode(Turn.encode(value)).status.kind).toBe(status.kind);
        }
        const data = mutableData(queued().toData());
        data["status"] = "unknown";
        expect(() => Turn.fromData(data)).toThrow(/status/);
    });

    it("round-trips advisory cache lineage without affecting transitions", { tags: "p1" }, () => {
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
    it("[C13-RUN-CHECKPOINT-KINDS] round-trips tree and no-tree checkpoints and rejects cursor shape", { tags: "p1" }, () => {
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

    it(
        "round-trips ordinary and cancellation inbox entries and rejects every malformed shape",
        { tags: "p1" },
        () => {
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
        }
    );
});

describe("decode and constructor trust boundaries", () => {
    it(
        "rejects a queued Turn whose lease claims a holder without an expiration",
        { tags: "p1" },
        () => {
            const forged = { turn: ids.turn, holder: ids.holder, epoch: 0, expiresAt: undefined };
            // SAFETY: TurnLease guards "held leases require an expiration" in its own
            // constructor, so this combination is unreachable through the real class. Only a
            // forged stand-in can prove Turn re-checks the queued-lease invariant itself
            // instead of trusting the lease it is handed.
            expect(() => queued({ lease: forged as never })).toThrow(TypeError);
        }
    );

    it("rejects an unknown Turn status on decode", { tags: "p2" }, () => {
        const data = { ...objectAt(queued().toData(), "Turn"), status: "bogus" };
        expect(() => Turn.fromData(data)).toThrow(TypeError);
    });

    it("rejects a negative inbox timestamp on decode", { tags: "p2" }, () => {
        const entry = new TurnInboxEntry(
            new TurnInboxEntryId("decode-timestamp"),
            ids.turn,
            0,
            "message",
            content("e"),
            digest("e"),
            "decode-timestamp-key",
            undefined,
            new Date(1)
        );
        const data = { ...objectAt(entry.toData(), "Turn inbox entry"), recordedAt: -1 };
        expect(() => TurnInboxEntry.fromData(data)).toThrow(TypeError);
    });
});

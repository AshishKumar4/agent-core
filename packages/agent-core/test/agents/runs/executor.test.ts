import { describe, expect, it } from "vitest";
import { RunCommitId } from "../../../src/execution-references";
import {
    TurnCheckpointHandle,
    TurnCommitHandle,
    TurnExecutor,
    TurnInboxHandle,
    TurnInvocationHandle,
    type TurnContext,
    type TurnOutcome
} from "../../../src/agents/runs/executor";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { Turn } from "../../../src/agents/runs/turn";
import { Revision } from "../../../src/core";
import { content, ids, pins } from "./fixture";

class CommitHandle extends TurnCommitHandle {
    public async append(): Promise<RunCommitId> {
        return new RunCommitId("appended");
    }
}

class CheckpointHandle extends TurnCheckpointHandle {
    public async persist(): Promise<RunCommitId> {
        return new RunCommitId("checkpoint");
    }
}

class InvocationHandle extends TurnInvocationHandle {
    public async invoke(): Promise<ReturnType<typeof content>> {
        return content("b");
    }
}

class InboxHandle extends TurnInboxHandle {
    public reads: number[] = [];
    public async read(afterSequence: number) {
        this.reads.push(afterSequence);
        return [];
    }
}

class Executor extends TurnExecutor {
    public context: TurnContext | undefined;
    public async execute(turn: TurnContext): Promise<TurnOutcome> {
        this.context = turn;
        return turn.cancellation.aborted
            ? { kind: "cancelled" }
            : {
                  kind: "succeeded",
                  result: await turn.invocation.invoke("operation", content("a"))
              };
    }
}

function context(signal: AbortSignal): TurnContext {
    const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
    return {
        turn: new Turn({
            id: ids.turn,
            run: ids.run,
            branch: ids.branch,
            startHead: ids.root,
            effectiveInput: ids.root,
            pins: pins(),
            placement: placement.digest,
            input: content("a"),
            revision: new Revision(0)
        }),
        effectiveCommit: ids.root,
        placement,
        resolvedFacets: [{ ref: "facet", operations: ["observe"] }],
        operationCatalog: ["facet.observe"],
        prompt: content("c"),
        inbox: new InboxHandle(),
        commit: new CommitHandle(),
        checkpoint: new CheckpointHandle(),
        invocation: new InvocationHandle(),
        cancellation: signal
    };
}

describe("TurnExecutor seam", () => {
    it("passes immutable Turn context and provider-neutral handles", async () => {
        const executor = new Executor();
        const turn = context(new AbortController().signal);
        await expect(executor.execute(turn)).resolves.toEqual({
            kind: "succeeded",
            result: content("b")
        });
        expect(executor.context).toBe(turn);
        expect(executor.context?.resolvedFacets[0]?.ref).toBe("facet");
        expect(executor.context?.operationCatalog).toEqual(["facet.observe"]);
        expect(executor.context?.prompt).toEqual(content("c"));
        await expect(turn.inbox.read(0)).resolves.toEqual([]);
        await expect(turn.commit.append({} as never)).resolves.toEqual(new RunCommitId("appended"));
        await expect(turn.checkpoint.persist({} as never)).resolves.toEqual(
            new RunCommitId("checkpoint")
        );
    });

    it("exposes cancellation between executor steps", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(new Executor().execute(context(controller.signal))).resolves.toEqual({
            kind: "cancelled"
        });
    });
});

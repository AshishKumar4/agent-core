import { describe, expect, it } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { RunBranchId, RunCommitId, RunId, TurnId } from "../../src/agents";
import { Revision } from "../../src/core";
import type { CommandEnvelope, ProtocolValueCodec } from "../../src/protocol";
import {
    RUN_COMMANDS,
    RunCommandPayload,
    RunProtocolPort,
    RunProtocolRecordRef,
    createRunProtocolCommands,
    type RunProtocolRequest
} from "../../src/protocol/run-commands";

interface ReadState {
    readonly revision: Revision;
}

interface RunObservation {
    readonly kind: RunProtocolRequest["kind"];
    readonly at: Date;
}

class TestPort extends RunProtocolPort<object, ReadState, string, RunObservation> {
    public readonly replyCodec: ProtocolValueCodec<string> = {
        encode: (value) => new TextEncoder().encode(value),
        decode: (bytes) => new TextDecoder().decode(bytes)
    };
    public readonly observationCodec: ProtocolValueCodec<RunObservation> = {
        encode: (value) => new TextEncoder().encode(`${value.kind}:${value.at.toISOString()}`),
        decode: (bytes) => {
            const [kind, at] = new TextDecoder().decode(bytes).split(":", 2);
            return { kind: kind as RunProtocolRequest["kind"], at: new Date(at!) };
        }
    };
    public executed: RunProtocolRequest | undefined;
    public decisionAt: Date | undefined;
    public authorize(): boolean {
        return true;
    }
    public permitsLifecycle(): boolean {
        return true;
    }
    public currentRevision(read: ReadState): Revision {
        return read.revision;
    }
    public currentLease(
        _read: ReadState,
        _envelope: CommandEnvelope,
        request: RunProtocolRequest,
        at: Date
    ) {
        this.decisionAt = at;
        const turn = "turn" in request ? request.turn : new TurnId("none");
        return {
            turn,
            holder: undefined,
            epoch: 0,
            expiresAt: undefined
        };
    }
    public execute(_tx: object, _envelope: CommandEnvelope, request: RunProtocolRequest, at: Date) {
        this.executed = request;
        this.decisionAt = at;
        return { reply: request.kind, observation: { kind: request.kind, at } };
    }
}

const owner = new ActorRef("workspace", new ActorId("workspace-1"));
const requests: readonly RunProtocolRequest[] = [
    { kind: "createRun", run: new RunId("run-1") },
    { kind: "createBranch", run: new RunId("run-1"), branch: new RunBranchId("branch-1") },
    {
        kind: "appendSystem",
        run: new RunId("run-1"),
        branch: new RunBranchId("branch-1"),
        commit: new RunCommitId("commit-1")
    },
    {
        kind: "appendTurn",
        run: new RunId("run-1"),
        branch: new RunBranchId("branch-1"),
        commit: new RunCommitId("commit-turn")
    },
    {
        kind: "merge",
        run: new RunId("run-1"),
        branch: new RunBranchId("branch-1"),
        commit: new RunCommitId("commit-2")
    },
    {
        kind: "undo",
        run: new RunId("run-1"),
        branch: new RunBranchId("branch-1"),
        commit: new RunCommitId("commit-3")
    },
    {
        kind: "migrate",
        run: new RunId("run-1"),
        branch: new RunBranchId("branch-1"),
        commit: new RunCommitId("commit-4")
    },
    {
        kind: "terminalize",
        run: new RunId("run-1"),
        turn: new TurnId("turn-1"),
        commit: new RunCommitId("commit-5"),
        outcome: "succeeded"
    },
    {
        kind: "spawn",
        run: new RunId("run-1"),
        turn: new TurnId("turn-1"),
        child: new RunId("run-child"),
        reservation: new RunProtocolRecordRef("spawn", "spawn-1")
    },
    {
        kind: "createTurn",
        run: new RunId("run-1"),
        branch: new RunBranchId("branch-1"),
        turn: new TurnId("turn-1")
    },
    { kind: "claimTurn", turn: new TurnId("turn-1"), expiresAt: new Date(2000) },
    { kind: "renewTurn", turn: new TurnId("turn-1"), expiresAt: new Date(3000) },
    { kind: "reclaimTurn", turn: new TurnId("turn-1"), expiresAt: new Date(4000) },
    { kind: "suspendTurn", turn: new TurnId("turn-1"), commit: new RunCommitId("commit-6") },
    {
        kind: "completeTurn",
        turn: new TurnId("turn-1"),
        commit: new RunCommitId("commit-7"),
        outcome: "failed"
    },
    { kind: "cancelHeldTurn", turn: new TurnId("turn-1") },
    { kind: "cancelUnheldTurn", turn: new TurnId("turn-1") },
    {
        kind: "deliverTurnEvent",
        turn: new TurnId("turn-1"),
        entry: new RunProtocolRecordRef("inbox", "entry-1")
    }
];

describe("Run protocol family", () => {
    it("declares every closed command with fixed revision and lease policies", () => {
        const commands = createRunProtocolCommands(new TestPort(), owner);
        expect(commands.map((command) => command.command)).toEqual(Object.values(RUN_COMMANDS));
        expect(Object.values(RUN_COMMANDS)).not.toContain("turn.retry");
        expect("retryTurn" in RUN_COMMANDS).toBe(false);
        expect(
            commands.find((command) => command.command === RUN_COMMANDS.create)?.expectedRevision
        ).toBe("forbidden");
        expect(commands.find((command) => command.command === RUN_COMMANDS.renewTurn)?.lease).toBe(
            "required"
        );
        expect(commands.find((command) => command.command === RUN_COMMANDS.appendTurn)?.lease).toBe(
            "required"
        );
        expect(
            commands.find((command) => command.command === RUN_COMMANDS.reclaimTurn)?.lease
        ).toBe("forbidden");
        expect(
            commands.find((command) => command.command === RUN_COMMANDS.cancelUnheldTurn)?.lease
        ).toBe("forbidden");
        expect(() =>
            createRunProtocolCommands(new TestPort(), new ActorRef("tenant", new ActorId("tenant")))
        ).toThrow(/Workspace or Run/);
    });

    it("round-trips exact canonical payloads through command-specific codecs", () => {
        const commands = createRunProtocolCommands(new TestPort(), owner);
        for (const [index, request] of requests.entries()) {
            const decoded = commands[index]!.payload.decode(
                RunCommandPayload.encode(request)
            ) as RunProtocolRequest;
            expect(decoded.kind).toBe(request.kind);
            expect(RunCommandPayload.encode(decoded)).toEqual(RunCommandPayload.encode(request));
        }
        expect(() =>
            commands[0]!.payload.decode(new TextEncoder().encode('{"extra":true,"run":"run-1"}'))
        ).toThrow(/fields/);
    });

    it("keeps system commands restricted to the exact owning Actor", () => {
        const commands = createRunProtocolCommands(new TestPort(), owner);
        const system = commands.find((command) => command.command === RUN_COMMANDS.merge)!;
        expect(system.caller.admits({ kind: "actor", actor: owner })).toBe(true);
        expect(
            system.caller.admits({
                kind: "actor",
                actor: new ActorRef("workspace", new ActorId("other"))
            })
        ).toBe(false);
        expect(
            system.caller.admits({ kind: "principal", principal: { value: "principal" } as never })
        ).toBe(false);
    });

    it("delegates decoded requests to the typed transaction port", () => {
        const port = new TestPort();
        const command = createRunProtocolCommands(port, owner).find(
            (candidate) => candidate.command === RUN_COMMANDS.create
        )!;
        const request = requests[0]!;
        const payload = command.payload.decode(RunCommandPayload.encode(request));
        const at = new Date("2026-07-12T12:00:00.000Z");
        const result = command.execute({}, {} as CommandEnvelope, payload, at);
        if (result instanceof Uint8Array) throw new TypeError("Expected typed command execution");
        expect(result.reply).toBe("createRun");
        expect(result.observation?.at).toBe(at);
        expect(port.executed?.kind).toBe("createRun");
        expect(port.decisionAt).toBe(at);
    });

    it("delegates every deterministic gate through the typed port", () => {
        const port = new TestPort();
        const command = createRunProtocolCommands(port, owner).find(
            (candidate) => candidate.command === RUN_COMMANDS.claimTurn
        )!;
        const request = requests.find((candidate) => candidate.kind === "claimTurn")!;
        const payload = command.payload.decode(RunCommandPayload.encode(request));
        const envelope = {} as CommandEnvelope;
        const read = { revision: new Revision(7) };
        expect(command.authorize(read, envelope, payload)).toBe(true);
        expect(command.permitsLifecycle(read, envelope, payload)).toBe(true);
        expect(command.currentRevision(read, envelope, payload)?.value).toBe(7);
        const at = new Date("2026-07-12T12:00:00.000Z");
        expect(
            command.currentLease(read, envelope, payload, at)?.turn.equals(new TurnId("turn-1"))
        ).toBe(true);
        expect(port.decisionAt).toBe(at);
    });

    it("rejects every malformed payload shape before typed port execution", () => {
        const commands = createRunProtocolCommands(new TestPort(), owner);
        const create = commands.find((command) => command.command === RUN_COMMANDS.create)!;
        for (const payload of ["null", "[]", "{}", '{"run":""}', '{"run":1}']) {
            expect(() => create.payload.decode(new TextEncoder().encode(payload))).toThrow(
                TypeError
            );
        }
        const claim = commands.find((command) => command.command === RUN_COMMANDS.claimTurn)!;
        for (const payload of [
            '{"expiresAt":"1","turn":"turn"}',
            '{"expiresAt":-1,"turn":"turn"}',
            '{"expiresAt":9007199254740991,"turn":"turn"}'
        ]) {
            expect(() => claim.payload.decode(new TextEncoder().encode(payload))).toThrow(
                /expiration/
            );
        }
        const complete = commands.find((command) => command.command === RUN_COMMANDS.completeTurn)!;
        expect(() =>
            complete.payload.decode(
                new TextEncoder().encode('{"commit":"commit","outcome":"unknown","turn":"turn"}')
            )
        ).toThrow(/outcome/);
        const valid = claim.payload.decode(
            RunCommandPayload.encode(requests.find((request) => request.kind === "claimTurn")!)
        );
        expect(() =>
            claim.authorize({ revision: new Revision(0) }, {} as CommandEnvelope, null as never)
        ).toThrow(/not decoded/);
        expect(() =>
            claim.authorize(
                { revision: new Revision(0) },
                {} as CommandEnvelope,
                { ...(valid as object), kind: "renewTurn" } as never
            )
        ).toThrow(/not decoded/);
    });
});

import type { ActorRef } from "../actors";
import { RunBranchId, RunCommitId, RunId, TurnId } from "../agents";
import {
    decodeCanonicalJson,
    encodeCanonicalJson,
    hasExactJsonKeys,
    TextId,
    type JsonValue,
    type Revision
} from "../core";
import type { CurrentLease, ProtocolCommand } from "./dispatcher";
import type { CommandCaller, CommandEnvelope } from "./envelope";
import type { CommandPayloadCodec } from "./payload";
import { CommandCallerPolicy } from "./policy";
import type { ProtocolCommandExecution, ProtocolValueCodec } from "./registration";

export const RUN_COMMANDS = Object.freeze({
    create: "run.create",
    createBranch: "run.branch.create",
    appendSystem: "run.commit.system",
    appendTurn: "run.commit.turn",
    merge: "run.merge",
    undo: "run.undo",
    migrate: "run.migrate",
    terminalize: "run.terminalize",
    spawn: "run.spawn",
    createTurn: "turn.create",
    claimTurn: "turn.claim",
    renewTurn: "turn.renew",
    reclaimTurn: "turn.reclaim",
    suspendTurn: "turn.suspend",
    completeTurn: "turn.complete",
    cancelHeldTurn: "turn.cancelHeld",
    cancelUnheldTurn: "turn.cancelUnheld",
    deliverTurnEvent: "turn.deliverEvent"
});

export type RunProtocolRequest =
    | { readonly kind: "createRun"; readonly run: RunId }
    | { readonly kind: "createBranch"; readonly run: RunId; readonly branch: RunBranchId }
    | {
          readonly kind: "appendSystem" | "merge" | "undo" | "migrate";
          readonly run: RunId;
          readonly branch: RunBranchId;
          readonly commit: RunCommitId;
      }
    | {
          readonly kind: "appendTurn";
          readonly run: RunId;
          readonly branch: RunBranchId;
          readonly commit: RunCommitId;
      }
    | {
          readonly kind: "terminalize";
          readonly run: RunId;
          readonly turn: TurnId;
          readonly commit: RunCommitId;
          readonly outcome: "succeeded" | "failed" | "cancelled";
      }
    | {
          readonly kind: "spawn";
          readonly run: RunId;
          readonly turn: TurnId;
          readonly child: RunId;
          readonly reservation: RunProtocolRecordRef<"spawn">;
      }
    | {
          readonly kind: "createTurn";
          readonly run: RunId;
          readonly branch: RunBranchId;
          readonly turn: TurnId;
      }
    | {
          readonly kind: "claimTurn" | "renewTurn" | "reclaimTurn";
          readonly turn: TurnId;
          readonly expiresAt: Date;
      }
    | { readonly kind: "suspendTurn"; readonly turn: TurnId; readonly commit: RunCommitId }
    | {
          readonly kind: "completeTurn";
          readonly turn: TurnId;
          readonly commit: RunCommitId;
          readonly outcome: "succeeded" | "failed" | "cancelled";
      }
    | { readonly kind: "cancelHeldTurn" | "cancelUnheldTurn"; readonly turn: TurnId }
    | {
          readonly kind: "deliverTurnEvent";
          readonly turn: TurnId;
          readonly entry: RunProtocolRecordRef<"inbox">;
      };

export class RunProtocolRecordRef<Kind extends "spawn" | "inbox"> extends TextId {
    public constructor(
        public readonly recordKind: Kind,
        value: string
    ) {
        super(value, `Run protocol ${recordKind} record reference`);
        Object.freeze(this);
    }
}

export abstract class RunProtocolPort<Transaction, Read, Reply, Observation> {
    public abstract readonly replyCodec: ProtocolValueCodec<Reply>;
    public abstract readonly observationCodec: ProtocolValueCodec<Observation>;
    public abstract authorize(
        read: Read,
        envelope: CommandEnvelope,
        request: RunProtocolRequest
    ): boolean;
    public abstract permitsLifecycle(read: Read, request: RunProtocolRequest): boolean;
    public abstract currentRevision(read: Read, request: RunProtocolRequest): Revision | undefined;
    public abstract currentLease(
        read: Read,
        envelope: CommandEnvelope,
        request: RunProtocolRequest,
        at: Date
    ): CurrentLease | undefined;
    public abstract execute(
        transaction: Transaction,
        envelope: CommandEnvelope,
        request: RunProtocolRequest,
        at: Date
    ): ProtocolCommandExecution<Reply, Observation>;
}

interface CommandDescriptor {
    readonly command: string;
    readonly requestKind: RunProtocolRequest["kind"];
    readonly caller: "principal" | "owner";
    readonly expectedRevision: "required" | "forbidden";
    readonly lease: "required" | "forbidden";
}

const DESCRIPTORS: readonly CommandDescriptor[] = Object.freeze([
    {
        command: RUN_COMMANDS.create,
        requestKind: "createRun",
        caller: "principal",
        expectedRevision: "forbidden",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.createBranch,
        requestKind: "createBranch",
        caller: "owner",
        expectedRevision: "required",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.appendSystem,
        requestKind: "appendSystem",
        caller: "owner",
        expectedRevision: "required",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.appendTurn,
        requestKind: "appendTurn",
        caller: "principal",
        expectedRevision: "required",
        lease: "required"
    },
    {
        command: RUN_COMMANDS.merge,
        requestKind: "merge",
        caller: "owner",
        expectedRevision: "required",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.undo,
        requestKind: "undo",
        caller: "owner",
        expectedRevision: "required",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.migrate,
        requestKind: "migrate",
        caller: "owner",
        expectedRevision: "required",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.terminalize,
        requestKind: "terminalize",
        caller: "principal",
        expectedRevision: "required",
        lease: "required"
    },
    {
        command: RUN_COMMANDS.spawn,
        requestKind: "spawn",
        caller: "principal",
        expectedRevision: "required",
        lease: "required"
    },
    {
        command: RUN_COMMANDS.createTurn,
        requestKind: "createTurn",
        caller: "principal",
        expectedRevision: "required",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.claimTurn,
        requestKind: "claimTurn",
        caller: "principal",
        expectedRevision: "required",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.renewTurn,
        requestKind: "renewTurn",
        caller: "principal",
        expectedRevision: "required",
        lease: "required"
    },
    {
        command: RUN_COMMANDS.reclaimTurn,
        requestKind: "reclaimTurn",
        caller: "principal",
        expectedRevision: "required",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.suspendTurn,
        requestKind: "suspendTurn",
        caller: "principal",
        expectedRevision: "required",
        lease: "required"
    },
    {
        command: RUN_COMMANDS.completeTurn,
        requestKind: "completeTurn",
        caller: "principal",
        expectedRevision: "required",
        lease: "required"
    },
    {
        command: RUN_COMMANDS.cancelHeldTurn,
        requestKind: "cancelHeldTurn",
        caller: "principal",
        expectedRevision: "required",
        lease: "required"
    },
    {
        command: RUN_COMMANDS.cancelUnheldTurn,
        requestKind: "cancelUnheldTurn",
        caller: "owner",
        expectedRevision: "required",
        lease: "forbidden"
    },
    {
        command: RUN_COMMANDS.deliverTurnEvent,
        requestKind: "deliverTurnEvent",
        caller: "owner",
        expectedRevision: "required",
        lease: "required"
    }
]);

export function createRunProtocolCommands<Transaction, Read, Reply, Observation>(
    port: RunProtocolPort<Transaction, Read, Reply, Observation>,
    owner: ActorRef
): readonly ProtocolCommand<Transaction, Read, RunProtocolRequest, Reply, Observation>[] {
    const commandOwner = requireRunProtocolOwner(owner);
    return Object.freeze(
        DESCRIPTORS.map((descriptor) => new RunPortCommand(port, commandOwner, descriptor))
    );
}

class RunPortCommand<Transaction, Read, Reply, Observation> implements ProtocolCommand<
    Transaction,
    Read,
    RunProtocolRequest,
    Reply,
    Observation
> {
    public readonly command: string;
    public readonly caller: CommandCallerPolicy;
    public readonly expectedRevision: "required" | "forbidden";
    public readonly lease: "required" | "forbidden";
    public readonly payload: CommandPayloadCodec<RunProtocolRequest>;
    public readonly replyCodec: ProtocolValueCodec<Reply>;
    public readonly observationCodec: ProtocolValueCodec<Observation>;

    public constructor(
        private readonly port: RunProtocolPort<Transaction, Read, Reply, Observation>,
        owner: ActorRef,
        private readonly descriptor: CommandDescriptor
    ) {
        this.command = descriptor.command;
        this.caller =
            descriptor.caller === "principal"
                ? CommandCallerPolicy.principal()
                : new ExactActorPolicy(owner);
        this.expectedRevision = descriptor.expectedRevision;
        this.lease = descriptor.lease;
        this.payload = new RunRequestCodec(descriptor.requestKind);
        this.replyCodec = port.replyCodec;
        this.observationCodec = port.observationCodec;
    }

    public authorize(read: Read, envelope: CommandEnvelope, payload: RunProtocolRequest): boolean {
        return this.port.authorize(
            read,
            envelope,
            requireRequest(payload, this.descriptor.requestKind)
        );
    }

    public permitsLifecycle(
        read: Read,
        _envelope: CommandEnvelope,
        payload: RunProtocolRequest
    ): boolean {
        return this.port.permitsLifecycle(
            read,
            requireRequest(payload, this.descriptor.requestKind)
        );
    }

    public currentRevision(
        read: Read,
        _envelope: CommandEnvelope,
        payload: RunProtocolRequest
    ): Revision | undefined {
        return this.port.currentRevision(
            read,
            requireRequest(payload, this.descriptor.requestKind)
        );
    }

    public currentLease(
        read: Read,
        envelope: CommandEnvelope,
        payload: RunProtocolRequest,
        at: Date
    ): CurrentLease | undefined {
        return this.port.currentLease(
            read,
            envelope,
            requireRequest(payload, this.descriptor.requestKind),
            at
        );
    }

    public execute(
        transaction: Transaction,
        envelope: CommandEnvelope,
        payload: RunProtocolRequest,
        at: Date
    ): ProtocolCommandExecution<Reply, Observation> {
        return this.port.execute(
            transaction,
            envelope,
            requireRequest(payload, this.descriptor.requestKind),
            at
        );
    }
}

class RunRequestCodec implements CommandPayloadCodec {
    public constructor(private readonly kind: RunProtocolRequest["kind"]) {}

    public decode(bytes: Uint8Array): RunProtocolRequest {
        return requestFromData(this.kind, decodeCanonicalJson(bytes));
    }
}

class ExactActorPolicy extends CommandCallerPolicy {
    public constructor(private readonly owner: ActorRef) {
        super();
    }
    public admits(caller: CommandCaller): boolean {
        return caller.kind === "actor" && caller.actor.equals(this.owner);
    }
}

export const RunCommandPayload = Object.freeze({
    encode(request: RunProtocolRequest): Uint8Array {
        return encodeCanonicalJson(requestData(request));
    }
});

function requestData(request: RunProtocolRequest): JsonValue {
    switch (request.kind) {
        case "createRun":
            return { run: request.run.value };
        case "createBranch":
            return { branch: request.branch.value, run: request.run.value };
        case "appendSystem":
        case "appendTurn":
        case "merge":
        case "undo":
        case "migrate":
            return {
                branch: request.branch.value,
                commit: request.commit.value,
                run: request.run.value
            };
        case "terminalize":
            return {
                commit: request.commit.value,
                outcome: request.outcome,
                run: request.run.value,
                turn: request.turn.value
            };
        case "spawn":
            return {
                child: request.child.value,
                reservation: request.reservation.value,
                run: request.run.value,
                turn: request.turn.value
            };
        case "createTurn":
            return {
                branch: request.branch.value,
                run: request.run.value,
                turn: request.turn.value
            };
        case "claimTurn":
        case "renewTurn":
        case "reclaimTurn":
            return { expiresAt: request.expiresAt.getTime(), turn: request.turn.value };
        case "suspendTurn":
            return { commit: request.commit.value, turn: request.turn.value };
        case "completeTurn":
            return {
                commit: request.commit.value,
                outcome: request.outcome,
                turn: request.turn.value
            };
        case "cancelHeldTurn":
        case "cancelUnheldTurn":
            return { turn: request.turn.value };
        case "deliverTurnEvent":
            return { entry: request.entry.value, turn: request.turn.value };
    }
}

function requestFromData(kind: RunProtocolRequest["kind"], value: JsonValue): RunProtocolRequest {
    const object = requireObject(value);
    switch (kind) {
        case "createRun":
            requireKeys(object, ["run"]);
            return Object.freeze({ kind, run: new RunId(requireString(object["run"])) });
        case "createBranch":
            requireKeys(object, ["branch", "run"]);
            return Object.freeze({
                kind,
                run: new RunId(requireString(object["run"])),
                branch: new RunBranchId(requireString(object["branch"]))
            });
        case "appendSystem":
        case "appendTurn":
        case "merge":
        case "undo":
        case "migrate":
            requireKeys(object, ["branch", "commit", "run"]);
            return Object.freeze({
                kind,
                run: new RunId(requireString(object["run"])),
                branch: new RunBranchId(requireString(object["branch"])),
                commit: new RunCommitId(requireString(object["commit"]))
            });
        case "terminalize":
            requireKeys(object, ["commit", "outcome", "run", "turn"]);
            return Object.freeze({
                kind,
                run: new RunId(requireString(object["run"])),
                turn: new TurnId(requireString(object["turn"])),
                commit: new RunCommitId(requireString(object["commit"])),
                outcome: requireOutcome(object["outcome"])
            });
        case "spawn":
            requireKeys(object, ["child", "reservation", "run", "turn"]);
            return Object.freeze({
                kind,
                run: new RunId(requireString(object["run"])),
                turn: new TurnId(requireString(object["turn"])),
                child: new RunId(requireString(object["child"])),
                reservation: new RunProtocolRecordRef("spawn", requireString(object["reservation"]))
            });
        case "createTurn":
            requireKeys(object, ["branch", "run", "turn"]);
            return Object.freeze({
                kind,
                run: new RunId(requireString(object["run"])),
                branch: new RunBranchId(requireString(object["branch"])),
                turn: new TurnId(requireString(object["turn"]))
            });
        case "claimTurn":
        case "renewTurn":
        case "reclaimTurn":
            requireKeys(object, ["expiresAt", "turn"]);
            return Object.freeze({
                kind,
                turn: new TurnId(requireString(object["turn"])),
                expiresAt: requireDate(object["expiresAt"])
            });
        case "suspendTurn":
            requireKeys(object, ["commit", "turn"]);
            return Object.freeze({
                kind,
                turn: new TurnId(requireString(object["turn"])),
                commit: new RunCommitId(requireString(object["commit"]))
            });
        case "completeTurn":
            requireKeys(object, ["commit", "outcome", "turn"]);
            return Object.freeze({
                kind,
                turn: new TurnId(requireString(object["turn"])),
                commit: new RunCommitId(requireString(object["commit"])),
                outcome: requireOutcome(object["outcome"])
            });
        case "cancelHeldTurn":
        case "cancelUnheldTurn":
            requireKeys(object, ["turn"]);
            return Object.freeze({ kind, turn: new TurnId(requireString(object["turn"])) });
        case "deliverTurnEvent":
            requireKeys(object, ["entry", "turn"]);
            return Object.freeze({
                kind,
                turn: new TurnId(requireString(object["turn"])),
                entry: new RunProtocolRecordRef("inbox", requireString(object["entry"]))
            });
    }
}

function requireRequest(value: unknown, kind: RunProtocolRequest["kind"]): RunProtocolRequest {
    if (
        value === null ||
        typeof value !== "object" ||
        (value as { readonly kind?: unknown }).kind !== kind
    ) {
        throw new TypeError("Run protocol payload was not decoded for this command");
    }
    return value as RunProtocolRequest;
}

function requireRunProtocolOwner(owner: ActorRef): ActorRef {
    if (owner.kind !== "workspace" && owner.kind !== "run") {
        throw new TypeError("Run protocol owner must be a Workspace or Run Actor");
    }
    return owner;
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Run command payload must be an object");
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireKeys(value: { readonly [key: string]: JsonValue }, keys: readonly string[]): void {
    if (!hasExactJsonKeys(value, keys))
        throw new TypeError("Run command payload fields are invalid");
}

function requireString(value: JsonValue | undefined): string {
    if (typeof value !== "string" || value.length === 0)
        throw new TypeError("Run command value must be a non-empty string");
    return value;
}

function requireDate(value: JsonValue | undefined): Date {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Run command expiration is invalid");
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("Run command expiration is invalid");
    return date;
}

function requireOutcome(value: JsonValue | undefined): "succeeded" | "failed" | "cancelled" {
    if (value === "succeeded" || value === "failed" || value === "cancelled") return value;
    throw new TypeError("Run command outcome is invalid");
}

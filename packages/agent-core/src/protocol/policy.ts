import type { ActorKind } from "../actors";
import type { CommandCaller } from "./envelope";

export abstract class CommandCallerPolicy {
    public static principal(): CommandCallerPolicy {
        return principalCallerPolicy;
    }

    public static actor(kind: ActorKind): CommandCallerPolicy {
        return new ActorCommandCallerPolicy(kind);
    }

    public abstract admits(caller: CommandCaller): boolean;
}

class PrincipalCommandCallerPolicy extends CommandCallerPolicy {
    public admits(caller: CommandCaller): boolean {
        return caller.kind === "principal";
    }
}

class ActorCommandCallerPolicy extends CommandCallerPolicy {
    public constructor(private readonly kind: ActorKind) {
        super();
    }

    public admits(caller: CommandCaller): boolean {
        return caller.kind === "actor" && caller.actor.kind === this.kind;
    }
}

const principalCallerPolicy = new PrincipalCommandCallerPolicy();

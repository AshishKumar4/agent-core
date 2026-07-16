// @ts-nocheck
import { TextId } from "../core";

const exactActorIds = new WeakSet<object>();

export class ActorId extends TextId {
    public constructor(value: string) {
        super(value, "Actor ID");
        if (new.target === ActorId) exactActorIds.add(this);
        Object.freeze(this);
    }
}

export function isExactActorId(value: unknown): value is ActorId {
    return value !== null && typeof value === "object" && exactActorIds.has(value);
}

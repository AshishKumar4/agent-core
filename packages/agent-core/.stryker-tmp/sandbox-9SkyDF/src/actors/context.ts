// @ts-nocheck
import type { ActorActivationStore, ActorStore } from "./store";
import { ActorRef } from "./types";

export interface ActorContext<TTransaction> {
    readonly actor: ActorRef;
    readonly store: ActorActivationStore<TTransaction>;
}

export function isActorActivationStore<TTransaction>(
    store: ActorStore<TTransaction>
): store is ActorActivationStore<TTransaction> {
    return "activateActor" in store && typeof store.activateActor === "function";
}

export function createActorContext<TTransaction>(
    actor: ActorRef,
    store: ActorStore<TTransaction>
): ActorContext<TTransaction> {
    validateActorContext(actor, store);
    return Object.freeze({ actor, store });
}

function validateActorContext<TTransaction>(
    actor: ActorRef,
    store: ActorStore<TTransaction>
): asserts store is ActorActivationStore<TTransaction> {
    if (!(actor instanceof ActorRef)) {
        throw new TypeError("Actor context requires an ActorRef");
    }
    if (!isActorActivationStore(store)) {
        throw new TypeError("Actor context requires atomic activation storage");
    }
}

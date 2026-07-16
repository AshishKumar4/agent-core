// @ts-nocheck
import { AgentCoreError } from "../errors";
import { Revision, TextId } from "../core";
import { types as utilTypes } from "node:util";
import { ActorRecoveryState } from "./fence";
import { ActorId } from "./id";
import {
    ActorRef,
    type ActorKind,
    type SynchronousResultGuard,
    type TransactionOperation,
    type TransactionalStore
} from "./types";

const ASYNC_TRANSACTION_MESSAGE = "Actor transaction callbacks must be synchronous";

export const ACTOR_STATE_SNAPSHOT: unique symbol = Symbol("actor-state-snapshot");

export interface ActorCloneOwnedState {
    [ACTOR_STATE_SNAPSHOT](): unknown;
}

export interface ActorStore<TTransaction> extends TransactionalStore<TTransaction> {
    bindActor(actor: ActorRef): void;

    loadRecoveryState(transaction: TTransaction, actor: ActorRef): ActorRecoveryState | undefined;

    saveRecoveryState(transaction: TTransaction, state: ActorRecoveryState): void;
}

export class ActorActivation {
    private constructor(
        public readonly kind: "created" | "recovered",
        public readonly recovery: ActorRecoveryState
    ) {
        Object.freeze(this);
    }

    public static created(recovery: ActorRecoveryState): ActorActivation {
        requireCreatedRecovery(recovery);
        return new ActorActivation("created", recovery);
    }

    public static recovered(recovery: ActorRecoveryState): ActorActivation {
        requireRecoveredRecovery(recovery);
        return new ActorActivation("recovered", recovery);
    }
}

function requireCreatedRecovery(recovery: ActorRecoveryState): void {
    if (recovery.epoch !== 0 || recovery.recoveries !== 1) {
        throw new TypeError("Created Actor activation requires initial recovery state");
    }
}

function requireRecoveredRecovery(recovery: ActorRecoveryState): void {
    if (recovery.recoveries < 2) {
        throw new TypeError("Recovered Actor activation requires recovered state");
    }
}

export type ActorStartOperation<TTransaction> = (
    transaction: TTransaction,
    activation: ActorActivation
) => void;

export interface ActorActivationStore<TTransaction> extends ActorStore<TTransaction> {
    activateActor(actor: ActorRef, start: ActorStartOperation<TTransaction>): ActorRecoveryState;
}

export interface ActorLocalStore<
    TTransaction,
    TReadTransaction = TTransaction
> extends ActorStore<TTransaction> {
    read<TResult>(
        transaction: TTransaction,
        operation: TransactionOperation<TReadTransaction, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult;
}

export interface MemoryActorStoreSnapshot<TState> {
    readonly version: 1;
    readonly state: TState;
    readonly actor: { readonly kind: ActorKind; readonly id: string } | null;
    readonly recoveryState: Uint8Array | null;
}

export class MemoryActorStore<TTransaction extends object>
    implements ActorLocalStore<TTransaction>, ActorActivationStore<TTransaction>
{
    #value: TTransaction;
    #recovery: ActorRecoveryState | undefined;
    #activeTransaction: TTransaction | undefined;
    #activeDraft: TTransaction | undefined;
    #activeRecovery: ActorRecoveryState | undefined;
    #activeActor: ActorRef | undefined;
    #actor: ActorRef | undefined;

    public constructor(
        value: TTransaction,
        private readonly clone: (value: TTransaction) => TTransaction
    ) {
        this.#value = copyDetached(value, clone);
        requireOwnedGraph(this.#value);
    }

    public static restore<TState extends object>(
        snapshot: MemoryActorStoreSnapshot<TState>,
        clone: (value: TState) => TState
    ): MemoryActorStore<TState> {
        requireSnapshot(snapshot);
        const store = new MemoryActorStore(snapshot.state, clone);
        if (snapshot.actor === null) {
            if (snapshot.recoveryState !== null) {
                throw corruptSnapshot("Unbound Actor snapshots cannot contain recovery state");
            }
            return store;
        }
        const actor = new ActorRef(snapshot.actor.kind, new ActorId(snapshot.actor.id));
        store.#actor = actor;
        if (snapshot.recoveryState !== null) {
            const recovery = ActorRecoveryState.codec.decode(snapshot.recoveryState.slice());
            if (!recovery.actor.equals(actor)) {
                throw corruptSnapshot("Actor snapshot recovery state belongs to a different Actor");
            }
            store.#recovery = recovery;
        }
        return store;
    }

    public bindActor(actor: ActorRef): void {
        const bound = this.#activeTransaction === undefined ? this.#actor : this.#activeActor;
        if (bound !== undefined && !bound.equals(actor)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "An ActorStore cannot be shared by different Actors"
            );
        }
        if (this.#activeTransaction === undefined) {
            this.#actor = actor;
        } else {
            this.#activeActor = actor;
        }
    }

    public activateActor(
        actor: ActorRef,
        start: ActorStartOperation<TTransaction>
    ): ActorRecoveryState {
        const existing = this.#actor !== undefined;
        return this.transaction((transaction) => {
            this.bindActor(actor);
            const previous = this.loadRecoveryState(transaction, actor);
            if (existing && previous === undefined) {
                throw missingRecoveryState();
            }
            if (!existing && previous !== undefined) {
                throw corruptSnapshot("Unbound Actor storage cannot contain recovery state");
            }
            const next =
                previous === undefined ? ActorRecoveryState.initial(actor) : previous.recover();
            this.saveRecoveryState(transaction, next);
            const activated =
                previous === undefined
                    ? ActorActivation.created(next)
                    : ActorActivation.recovered(next);
            requireSynchronousResult(start(transaction, activated));
            return next;
        });
    }

    public transaction<TResult>(
        operation: TransactionOperation<TTransaction, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        if (this.#activeTransaction !== undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Nested actor transactions are not supported"
            );
        }

        const draft = copyDetached(this.#value, this.clone);
        requireOwnedGraph(draft);
        const recoveryDraft =
            this.#recovery === undefined
                ? undefined
                : ActorRecoveryState.codec.decode(ActorRecoveryState.codec.encode(this.#recovery));
        let active = true;
        const scope = new Proxy(draft, {
            defineProperty(target, property, descriptor) {
                requireActiveScope(active);
                return Reflect.defineProperty(target, property, descriptor);
            },
            deleteProperty(target, property) {
                requireActiveScope(active);
                return Reflect.deleteProperty(target, property);
            },
            get(target, property, receiver) {
                requireActiveScope(active);
                return Reflect.get(target, property, receiver);
            },
            getOwnPropertyDescriptor(target, property) {
                requireActiveScope(active);
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
            getPrototypeOf(target) {
                requireActiveScope(active);
                return Reflect.getPrototypeOf(target);
            },
            has(target, property) {
                requireActiveScope(active);
                return Reflect.has(target, property);
            },
            isExtensible(target) {
                requireActiveScope(active);
                return Reflect.isExtensible(target);
            },
            ownKeys(target) {
                requireActiveScope(active);
                return Reflect.ownKeys(target);
            },
            preventExtensions(target) {
                requireActiveScope(active);
                return Reflect.preventExtensions(target);
            },
            set(target, property, value, receiver) {
                requireActiveScope(active);
                return Reflect.set(target, property, value, receiver);
            },
            setPrototypeOf(target, prototype) {
                requireActiveScope(active);
                return Reflect.setPrototypeOf(target, prototype);
            }
        });
        this.#activeTransaction = scope;
        this.#activeDraft = draft;
        this.#activeRecovery = recoveryDraft;
        this.#activeActor = this.#actor;

        try {
            const result = requireSynchronousResult(operation(scope));
            const committed = copyDetached(draft, this.clone);
            requireOwnedGraph(committed);
            this.#value = committed;
            this.#recovery = this.#activeRecovery;
            this.#actor = this.#activeActor;
            return result;
        } finally {
            this.#activeTransaction = undefined;
            this.#activeDraft = undefined;
            this.#activeRecovery = undefined;
            this.#activeActor = undefined;
            active = false;
        }
    }

    public read<TResult>(
        transaction: TTransaction,
        operation: TransactionOperation<TTransaction, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        if (transaction !== this.#activeTransaction || this.#activeDraft === undefined) {
            throw staleTransaction("Actor reads require the active transaction");
        }
        const view = copyDetached(this.#activeDraft, this.clone);
        requireOwnedGraph(view);
        return requireSynchronousResult(operation(readonlyView(view)));
    }

    public loadRecoveryState(
        transaction: TTransaction,
        actor: ActorRef
    ): ActorRecoveryState | undefined {
        this.requireActor(transaction, actor);
        return this.#activeRecovery;
    }

    public saveRecoveryState(transaction: TTransaction, state: ActorRecoveryState): void {
        this.requireActor(transaction, state.actor);
        this.#activeRecovery = state;
    }

    public snapshot(): MemoryActorStoreSnapshot<TTransaction> {
        const state = copyDetached(this.#value, this.clone);
        requireOwnedGraph(state);
        return Object.freeze({
            version: 1,
            state,
            actor:
                this.#actor === undefined
                    ? null
                    : Object.freeze({ kind: this.#actor.kind, id: this.#actor.id.value }),
            recoveryState:
                this.#recovery === undefined
                    ? null
                    : ActorRecoveryState.codec.encode(this.#recovery).slice()
        });
    }

    private requireActor(transaction: TTransaction, actor: ActorRef): void {
        if (transaction !== this.#activeTransaction || this.#activeActor === undefined) {
            throw staleTransaction("Actor recovery state requires an active transaction");
        }
        if (!this.#activeActor.equals(actor)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Actor recovery state belongs to a different Actor"
            );
        }
    }
}

export function requireSynchronousResult<TResult>(result: TResult): TResult {
    if (hasUnstableOrThenableShape(result)) {
        if (result instanceof Promise) {
            void result.catch(noop);
        }
        throw new TypeError(ASYNC_TRANSACTION_MESSAGE);
    }
    return result;
}

function hasUnstableOrThenableShape(value: unknown): value is PromiseLike<unknown> {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return false;
    }
    let owner: object | null = value;
    while (owner !== null) {
        if (utilTypes.isProxy(owner) || Object.hasOwn(owner, "then")) return true;
        owner = Object.getPrototypeOf(owner) as object | null;
    }
    return typeof (value as { readonly then?: unknown }).then === "function";
}

function noop(): void {}

function requireSnapshot<TState>(value: MemoryActorStoreSnapshot<TState>): void {
    if (
        value === null ||
        typeof value !== "object" ||
        JSON.stringify(Object.keys(value).sort()) !==
            JSON.stringify(["actor", "recoveryState", "state", "version"]) ||
        value.version !== 1 ||
        value.state === null ||
        typeof value.state !== "object" ||
        !isSnapshotActor(value.actor) ||
        (value.recoveryState !== null && !(value.recoveryState instanceof Uint8Array))
    ) {
        throw corruptSnapshot("Memory Actor snapshot is malformed");
    }
}

function isSnapshotActor(
    value: MemoryActorStoreSnapshot<unknown>["actor"]
): value is MemoryActorStoreSnapshot<unknown>["actor"] {
    return (
        value === null ||
        (typeof value === "object" &&
            JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["id", "kind"]) &&
            typeof value.id === "string" &&
            isActorKind(value.kind))
    );
}

function isActorKind(value: unknown): value is ActorKind {
    return (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    );
}

function immutableRead(): never {
    throw new AgentCoreError("protocol.invalid-state", "Actor read views are immutable");
}

function requireActiveScope(active: boolean): void {
    if (!active) throw new AgentCoreError("actor.closed", "Actor transaction is no longer active");
}

function staleTransaction(message: string): AgentCoreError {
    return new AgentCoreError("actor.stale-callback", message);
}

function readonlyView<Value>(value: Value): Value {
    return readonlyValue(value, {
        seen: new WeakMap<object, unknown>(),
        buffers: new WeakMap<ArrayBuffer, ArrayBuffer>()
    }) as Value;
}

interface ReadonlyContext {
    readonly seen: WeakMap<object, unknown>;
    readonly buffers: WeakMap<ArrayBuffer, ArrayBuffer>;
}

function readonlyValue(value: unknown, context: ReadonlyContext): unknown {
    if (value === null || typeof value !== "object") return value;
    const previous = context.seen.get(value);
    if (previous !== undefined) return previous;
    if (value instanceof Date) return readonlyDate(value, context);
    if (value instanceof Map) return readonlyMap(value, context);
    if (value instanceof Set) return readonlySet(value, context);
    if (value instanceof ArrayBuffer) return readonlyArrayBuffer(value, context);
    if (ArrayBuffer.isView(value)) return readonlyArrayBufferView(value, context);
    if (isImmutableLeaf(value)) {
        context.seen.set(value, value);
        return value;
    }
    if (value instanceof TextId) return readonlyTextId(value, context);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
        return readonlyClass(value, context);
    }
    return readonlyPlain(value, prototype, context);
}

function readonlyTextId(value: TextId, context: ReadonlyContext): TextId {
    const proxy = new Proxy(value, {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            if (property === "value") return target.value;
            if (property === "equals") return TextId.prototype.equals.bind(target);
            if (property === "toString") return TextId.prototype.toString.bind(target);
            const descriptor = propertyDescriptor(target, property);
            if (descriptor === undefined) return undefined;
            if (!("value" in descriptor) || typeof descriptor.value === "function") {
                return immutableRead();
            }
            return readonlyValue(descriptor.value, context);
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    return proxy;
}

function readonlyPlain(value: object, prototype: object | null, context: ReadonlyContext): object {
    const target = Array.isArray(value)
        ? arrayWithLength(value.length)
        : (Object.create(prototype) as object);
    const proxy = new Proxy(target, immutableHandler());
    context.seen.set(value, proxy);
    defineReadonlyProperties(value, target, context, Array.isArray(value));
    Object.freeze(target);
    return proxy;
}

function arrayWithLength(length: number): unknown[] {
    const value: unknown[] = [];
    value.length = length;
    return value;
}

function immutableHandler(): ProxyHandler<object> {
    return {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property, receiver) {
            const descriptor = propertyDescriptor(target, property);
            if (descriptor?.get !== undefined) return immutableRead();
            return Reflect.get(target, property, receiver);
        },
        set: immutableRead
    };
}

function readonlyDate(value: Date, context: ReadonlyContext): Date {
    const proxy = new Proxy(value, {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            if (typeof property === "string" && property.startsWith("set")) return immutableRead;
            const member = Reflect.get(target, property, target);
            return typeof member === "function" ? member.bind(target) : member;
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    return proxy;
}

function readonlyClass(value: object, context: ReadonlyContext): object {
    const target = Object.create(Object.getPrototypeOf(value)) as object;
    const proxy = new Proxy(target, {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            const descriptor = propertyDescriptor(target, property);
            if (descriptor?.get !== undefined) return immutableRead();
            const member = Reflect.get(target, property, target);
            if (typeof member !== "function") return member;
            return immutableRead;
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    defineReadonlyProperties(value, target, context, false);
    Object.freeze(target);
    return proxy;
}

function defineReadonlyProperties(
    source: object,
    target: object,
    context: ReadonlyContext,
    skipArrayLength: boolean
): void {
    for (const property of Reflect.ownKeys(source)) {
        if (skipArrayLength && property === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, property)!;
        Object.defineProperty(
            target,
            property,
            "value" in descriptor
                ? {
                      ...descriptor,
                      value:
                          typeof descriptor.value === "function"
                              ? immutableRead
                              : readonlyValue(descriptor.value, context),
                      writable: false
                  }
                : descriptor
        );
    }
}

function readonlyMap(
    value: Map<unknown, unknown>,
    context: ReadonlyContext
): Map<unknown, unknown> {
    const copy = new Map<unknown, unknown>();
    const proxy = new Proxy(
        copy,
        collectionHandler(new Set(["clear", "delete", "forEach", "set", "valueOf"]))
    );
    context.seen.set(value, proxy);
    for (const [key, entry] of value) {
        copy.set(readonlyValue(key, context), readonlyValue(entry, context));
    }
    return proxy as Map<unknown, unknown>;
}

function readonlySet(value: Set<unknown>, context: ReadonlyContext): Set<unknown> {
    const copy = new Set<unknown>();
    const proxy = new Proxy(
        copy,
        collectionHandler(new Set(["add", "clear", "delete", "forEach", "valueOf"]))
    );
    context.seen.set(value, proxy);
    for (const entry of value) copy.add(readonlyValue(entry, context));
    return proxy as Set<unknown>;
}

function collectionHandler(mutators: ReadonlySet<string>): ProxyHandler<object> {
    return {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            if (typeof property === "string" && mutators.has(property)) return immutableRead;
            const member = Reflect.get(target, property, target);
            return typeof member === "function" ? member.bind(target) : member;
        },
        set: immutableRead
    };
}

function readonlyArrayBuffer(value: ArrayBuffer, context: ReadonlyContext): ArrayBuffer {
    const copy = clonedBuffer(value, context);
    const proxy = new Proxy(copy, {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            const member = Reflect.get(target, property, target);
            if (typeof member !== "function") return member;
            return property === "slice" ? member.bind(target) : immutableRead;
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    return proxy as ArrayBuffer;
}

function readonlyArrayBufferView<T extends ArrayBufferView>(value: T, context: ReadonlyContext): T {
    const sourceBuffer = value.buffer as ArrayBuffer;
    const copy = cloneView(value, clonedBuffer(sourceBuffer, context));
    const mutators = new Set([
        "copyWithin",
        "fill",
        "reverse",
        "set",
        "sort",
        "subarray",
        "valueOf"
    ]);
    const proxy = new Proxy(copy, {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            if (property === "buffer") return readonlyValue(sourceBuffer, context);
            const member = Reflect.get(target, property, target);
            if (typeof member !== "function") return member;
            if (
                typeof property !== "string" ||
                mutators.has(property) ||
                property.startsWith("set")
            )
                return immutableRead;
            const allowed =
                target instanceof DataView
                    ? property.startsWith("get")
                    : SAFE_TYPED_ARRAY_METHODS.has(property);
            return allowed ? member.bind(target) : immutableRead;
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    return proxy as T;
}

function clonedBuffer(value: ArrayBuffer, context: ReadonlyContext): ArrayBuffer {
    const previous = context.buffers.get(value);
    if (previous !== undefined) return previous;
    const copy = value.slice(0);
    context.buffers.set(value, copy);
    return copy;
}

function cloneView<T extends ArrayBufferView>(value: T, buffer: ArrayBuffer): T {
    if (value instanceof DataView) {
        return new DataView(buffer, value.byteOffset, value.byteLength) as unknown as T;
    }
    const constructor = value.constructor as new (
        buffer: ArrayBuffer,
        byteOffset: number,
        length: number
    ) => T;
    const bytesPerElement = (value as unknown as { readonly BYTES_PER_ELEMENT: number })
        .BYTES_PER_ELEMENT;
    return new constructor(buffer, value.byteOffset, value.byteLength / bytesPerElement);
}

function corruptSnapshot(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function missingRecoveryState(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Existing Actor storage is missing recovery state");
}

function copyDetached<TState extends object>(
    value: TState,
    clone: (value: TState) => TState
): TState {
    requireOwnedGraph(value);
    const copy = clone(value);
    if (copy === null || typeof copy !== "object") {
        throw new TypeError("Memory Actor clones must return an object");
    }
    const sourceObjects = new Set<object>();
    collectMutableObjects(value, sourceObjects, new Set<object>());
    requireDetachedObjects(copy, sourceObjects, new Set<object>());
    return copy;
}

function collectMutableObjects(value: unknown, objects: Set<object>, seen: Set<object>): void {
    if (isImmutableLeaf(value) || value === null || typeof value !== "object" || seen.has(value)) {
        return;
    }
    seen.add(value);
    objects.add(value);
    forEachOwnedChild(value, (child) => collectMutableObjects(child, objects, seen));
}

function requireDetachedObjects(
    value: unknown,
    sourceObjects: ReadonlySet<object>,
    seen: Set<object>
): void {
    if (isImmutableLeaf(value) || value === null || typeof value !== "object" || seen.has(value)) {
        return;
    }
    if (sourceObjects.has(value)) {
        throw new TypeError("Memory Actor clones must detach all mutable state");
    }
    seen.add(value);
    forEachOwnedChild(value, (child) => requireDetachedObjects(child, sourceObjects, seen));
}

function isImmutableLeaf(value: unknown): boolean {
    return Revision.isExact(value);
}

function forEachOwnedChild(value: object, inspect: (child: unknown) => void): void {
    if (ArrayBuffer.isView(value)) {
        inspect(value.buffer);
    } else if (value instanceof Map) {
        for (const [key, entry] of value) {
            inspect(key);
            inspect(entry);
        }
    } else if (value instanceof Set) {
        for (const entry of value) inspect(entry);
    }
    const owned = (value as Partial<ActorCloneOwnedState>)[ACTOR_STATE_SNAPSHOT];
    if (typeof owned === "function") {
        inspect(owned.call(value));
    }
    for (const property of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (descriptor !== undefined && "value" in descriptor && property !== ACTOR_STATE_SNAPSHOT)
            inspect(descriptor.value);
    }
}

function requireOwnedGraph(value: unknown, seen = new Set<object>()): void {
    if (typeof value === "function") {
        throw new TypeError("Memory Actor state cannot contain functions");
    }
    if (
        typeof SharedArrayBuffer !== "undefined" &&
        (value instanceof SharedArrayBuffer ||
            (ArrayBuffer.isView(value) && value.buffer instanceof SharedArrayBuffer))
    ) {
        throw new TypeError("Memory Actor state cannot contain shared memory");
    }
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const property of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (descriptor !== undefined && !("value" in descriptor)) {
            throw new TypeError("Memory Actor state cannot contain accessor properties");
        }
    }
    const prototype = Object.getPrototypeOf(value);
    if (
        prototype !== Object.prototype &&
        prototype !== Array.prototype &&
        prototype !== null &&
        !(value instanceof Date) &&
        !(value instanceof TextId) &&
        !(value instanceof Revision) &&
        !(value instanceof Map) &&
        !(value instanceof Set) &&
        !(value instanceof ArrayBuffer) &&
        !ArrayBuffer.isView(value)
    ) {
        const inspect = (value as Partial<ActorCloneOwnedState>)[ACTOR_STATE_SNAPSHOT];
        if (!Object.isFrozen(value) || typeof inspect !== "function") {
            throw new TypeError("Memory Actor custom state objects must be frozen and clone-owned");
        }
    }
    forEachOwnedChild(value, (child) => requireOwnedGraph(child, seen));
}

function propertyDescriptor(target: object, property: PropertyKey): PropertyDescriptor | undefined {
    let owner: object | null = target;
    while (owner !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, property);
        if (descriptor !== undefined) return descriptor;
        owner = Object.getPrototypeOf(owner) as object | null;
    }
    return undefined;
}

const SAFE_TYPED_ARRAY_METHODS = new Set([
    "at",
    "entries",
    "includes",
    "indexOf",
    "join",
    "keys",
    "lastIndexOf",
    "slice",
    "toLocaleString",
    "toString",
    "values"
]);

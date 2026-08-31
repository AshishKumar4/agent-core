import { types as utilTypes } from "node:util";

import { AgentCoreError } from "../errors";
import { Revision, TextId, hasExactKeys } from "../core";
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

type ActorCloneSnapshot = boolean | number | string | null | bigint | symbol | object | undefined;

export interface ActorCloneOwnedState {
    [ACTOR_STATE_SNAPSHOT](): ActorCloneSnapshot;
}

declare const ACTOR_STATE_OBJECT: unique symbol;

interface ActorStateObject {
    readonly [ACTOR_STATE_OBJECT]?: undefined;
}

type ActorStateTarget = ActorStateObject | unknown[];

type InspectableActorState =
    | ActorStateTarget
    | ArrayBuffer
    | ArrayBufferView
    | Date
    | Map<unknown, unknown>
    | Set<unknown>
    | TextId;

export interface ActorStore<TTransaction> extends TransactionalStore<TTransaction> {
    bindActor(actor: ActorRef): void;

    /**
     * The stable bootstrap record, decoded before any record the Actor itself owns.
     * It never carries a codec declaration: keeping that carrier stable lets an older
     * runtime construct and fence the Actor instead of failing before it can refuse work.
     */
    loadRecoveryState(transaction: TTransaction, actor: ActorRef): ActorRecoveryState | undefined;

    saveRecoveryState(transaction: TTransaction, state: ActorRecoveryState): void;

    /**
     * Raw canonical CodecDeclaration bytes in the separate record-set bootstrap carrier.
     * Stores deliberately do not decode these bytes: Actor decides compatibility before it
     * starts its record-owning work and defers a malformed or future carrier to operations.
     */
    loadRecordSetDeclaration(transaction: TTransaction, actor: ActorRef): Uint8Array | undefined;

    saveRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef,
        declaration: Uint8Array
    ): void;
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
    readonly version: 1 | 2;
    readonly state: TState;
    readonly actor: { readonly kind: ActorKind; readonly id: string } | null;
    readonly recoveryState: Uint8Array | null;
    readonly recordSetDeclaration?: Uint8Array | null;
}

export class MemoryActorStore<TTransaction extends object>
    implements ActorLocalStore<TTransaction>, ActorActivationStore<TTransaction>
{
    #value: TTransaction;
    #recovery: ActorRecoveryState | undefined;
    #recordSetDeclaration: Uint8Array | undefined;
    #activeTransaction: TTransaction | undefined;
    #activeDraft: TTransaction | undefined;
    #activeRecovery: ActorRecoveryState | undefined;
    #activeRecordSetDeclaration: Uint8Array | undefined;
    #activeActor: ActorRef | undefined;
    #actor: ActorRef | undefined;

    public constructor(
        value: TTransaction,
        private readonly clone: (value: TTransaction) => TTransaction
    ) {
        this.#value = copyDetached(value, clone);
    }

    public static restore<TState extends object>(
        snapshot: MemoryActorStoreSnapshot<TState>,
        clone: (value: TState) => TState
    ): MemoryActorStore<TState> {
        requireSnapshot(snapshot);
        const store = new MemoryActorStore(snapshot.state, clone);
        if (snapshot.actor === null) {
            if (
                snapshot.recoveryState !== null ||
                (snapshot.recordSetDeclaration !== undefined &&
                    snapshot.recordSetDeclaration !== null)
            ) {
                throw corruptSnapshot("Unbound Actor snapshots cannot contain bootstrap state");
            }
            return store;
        }
        const actor = new ActorRef(snapshot.actor.kind, new ActorId(snapshot.actor.id));
        store.#actor = actor;
        if (snapshot.recordSetDeclaration !== undefined && snapshot.recordSetDeclaration !== null) {
            store.#recordSetDeclaration = snapshot.recordSetDeclaration.slice();
        }
        if (snapshot.recoveryState !== null) {
            const recovery = ActorRecoveryState.codec.decode(snapshot.recoveryState.slice());
            if (!recovery.actor.equals(actor)) {
                throw corruptSnapshot("Actor snapshot recovery state belongs to a different Actor");
            }
            store.#recovery = recovery;
        }
        if (store.#recordSetDeclaration !== undefined && store.#recovery === undefined) {
            throw corruptSnapshot("Actor snapshot declaration requires recovery state");
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
        const recoveryDraft =
            this.#recovery === undefined
                ? undefined
                : ActorRecoveryState.codec.decode(ActorRecoveryState.codec.encode(this.#recovery));
        const declarationDraft = this.#recordSetDeclaration?.slice();
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
                const member = inspectProperty(target, property);
                if (member.kind === "missing") return undefined;
                if (member.kind === "accessor") return member.descriptor.get?.call(receiver);
                return member.value;
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
        this.#activeRecordSetDeclaration = declarationDraft;
        this.#activeActor = this.#actor;

        try {
            const result = requireSynchronousResult(operation(scope));
            const committed = copyDetached(draft, this.clone);
            this.#value = committed;
            this.#recovery = this.#activeRecovery;
            this.#recordSetDeclaration = this.#activeRecordSetDeclaration;
            this.#actor = this.#activeActor;
            return result;
        } finally {
            this.#activeTransaction = undefined;
            this.#activeDraft = undefined;
            this.#activeRecovery = undefined;
            this.#activeRecordSetDeclaration = undefined;
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

    public loadRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef
    ): Uint8Array | undefined {
        this.requireActor(transaction, actor);
        return this.#activeRecordSetDeclaration?.slice();
    }

    public saveRecordSetDeclaration(
        transaction: TTransaction,
        actor: ActorRef,
        declaration: Uint8Array
    ): void {
        this.requireActor(transaction, actor);
        if (!(declaration instanceof Uint8Array)) {
            throw new AgentCoreError("codec.invalid", "Actor record set declaration must be bytes");
        }
        this.#activeRecordSetDeclaration = declaration.slice();
    }

    public snapshot(): MemoryActorStoreSnapshot<TTransaction> {
        const state = copyDetached(this.#value, this.clone);
        return Object.freeze({
            version: 2,
            state,
            actor:
                this.#actor === undefined
                    ? null
                    : Object.freeze({ kind: this.#actor.kind, id: this.#actor.id.value }),
            recoveryState:
                this.#recovery === undefined
                    ? null
                    : ActorRecoveryState.codec.encode(this.#recovery).slice(),
            recordSetDeclaration: this.#recordSetDeclaration?.slice() ?? null
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
    if (isThenableCandidate(result)) {
        let owner: object | null = result;
        while (owner !== null) {
            if (utilTypes.isProxy(owner) || Object.hasOwn(owner, "then")) {
                if (utilTypes.isPromise(result)) void result.catch(noop);
                throw new TypeError(ASYNC_TRANSACTION_MESSAGE);
            }
            owner = Reflect.getPrototypeOf(owner);
        }
    }
    return result;
}

function isThenableCandidate(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

function noop(): void {}

function requireSnapshot<TState>(value: MemoryActorStoreSnapshot<TState>): void {
    const legacy =
        isActorStateObject(value) &&
        hasExactKeys(value, ["actor", "recoveryState", "state", "version"]) &&
        value.version === 1;
    const current =
        isActorStateObject(value) &&
        hasExactKeys(value, [
            "actor",
            "recordSetDeclaration",
            "recoveryState",
            "state",
            "version"
        ]) &&
        value.version === 2 &&
        (value.recordSetDeclaration === null || value.recordSetDeclaration instanceof Uint8Array);
    if (
        (!legacy && !current) ||
        !isActorStateObject(value.state) ||
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
        (isActorStateObject(value) &&
            hasExactKeys(value, ["id", "kind"]) &&
            isActorId(value.id) &&
            isActorKind(value.kind))
    );
}

function isActorId(value: unknown): value is string {
    return typeof value === "string";
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
        seen: new WeakMap<object, object>(),
        buffers: new WeakMap<ArrayBuffer, ArrayBuffer>()
    });
}

interface ReadonlyContext {
    readonly seen: WeakMap<object, object>;
    readonly buffers: WeakMap<ArrayBuffer, ArrayBuffer>;
}

function readonlyValue<Value>(value: Value, context: ReadonlyContext): Value {
    if (!isActorStateObject(value)) return value;
    const previous = context.seen.get(value);
    let view: object;
    if (previous !== undefined) {
        view = previous;
    } else if (value instanceof Date) {
        view = readonlyDate(value, context);
    } else if (value instanceof Map) {
        view = readonlyMap(value, context);
    } else if (value instanceof Set) {
        view = readonlySet(value, context);
    } else if (value instanceof ArrayBuffer) {
        view = readonlyArrayBuffer(value, context);
    } else if (ArrayBuffer.isView(value)) {
        view = readonlyArrayBufferView(value, context);
    } else if (isImmutableLeaf(value)) {
        context.seen.set(value, value);
        view = value;
    } else if (value instanceof TextId) {
        view = readonlyTextId(value, context);
    } else {
        const prototype = Reflect.getPrototypeOf(value);
        view =
            prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null
                ? readonlyClass(value, context)
                : readonlyPlain(value, context);
    }
    // SAFETY: each branch retains the source object's public runtime shape while replacing
    // mutable operations and nested mutable members with immutable views.
    return view as Value;
}

function readonlyTextId(value: TextId, context: ReadonlyContext): TextId {
    const proxy = new Proxy(value, {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            if (property === "value") return target.value;
            if (property === "equals") return TextId.prototype.equals.bind(target);
            if (property === "toString") return TextId.prototype.toString.bind(target);
            const member = inspectProperty(target, property);
            if (member.kind === "missing") return undefined;
            if (member.kind === "accessor" || isFunctionValue(member.value)) {
                return immutableRead();
            }
            return readonlyValue(member.value, context);
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    return proxy;
}

function readonlyPlain(value: ActorStateObject, context: ReadonlyContext) {
    const prototype = Reflect.getPrototypeOf(value);
    const target: ActorStateTarget = Array.isArray(value)
        ? arrayWithLength(value.length)
        : createActorStateTarget(prototype);
    const proxy = new Proxy(target, immutableHandler());
    context.seen.set(value, proxy);
    copyReadonlyProperties(value, target, context, Array.isArray(value));
    Object.freeze(target);
    return proxy;
}

function arrayWithLength(length: number): unknown[] {
    const value: unknown[] = [];
    value.length = length;
    return value;
}

function immutableHandler(): ProxyHandler<ActorStateTarget> {
    return {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            const member = inspectProperty(target, property);
            if (member.kind === "accessor") return immutableRead();
            return member.kind === "data" ? member.value : undefined;
        },
        set: immutableRead
    };
}

function readonlyDate(value: Date, context: ReadonlyContext): Date {
    const proxy = new Proxy(value, {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            if (isStringProperty(property) && property.startsWith("set")) return immutableRead;
            if (property === Symbol.toPrimitive) {
                // A Proxy cannot carry the Date internal slot, so new Date(view)
                // falls back to ToPrimitive — and the native default hint stringifies
                // without milliseconds, silently shifting the instant. Answer the
                // default hint with the ISO form, which round-trips exactly.
                return (hint: string) =>
                    hint === "number"
                        ? target.getTime()
                        : hint === "string"
                          ? target.toString()
                          : target.toISOString();
            }
            const member = inspectProperty(target, property);
            if (member.kind === "missing") return undefined;
            const accessed: unknown =
                member.kind === "accessor" ? member.descriptor.get?.call(target) : member.value;
            return isFunctionValue(accessed) ? accessed.bind(target) : accessed;
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    return proxy;
}

function readonlyClass(value: ActorStateObject, context: ReadonlyContext) {
    const prototype = Reflect.getPrototypeOf(value);
    const target = createActorStateTarget(prototype);
    const proxy = new Proxy(target, {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            const member = inspectProperty(target, property);
            if (member.kind === "accessor") return immutableRead();
            if (member.kind === "missing" || !isFunctionValue(member.value)) {
                return member.kind === "data" ? member.value : undefined;
            }
            return immutableRead;
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    copyReadonlyProperties(value, target, context, false);
    Object.freeze(target);
    return proxy;
}

function copyReadonlyProperties(
    source: ActorStateObject,
    target: ActorStateTarget,
    context: ReadonlyContext,
    skipArrayLength: boolean
): void {
    for (const property of Reflect.ownKeys(source)) {
        if (skipArrayLength && property === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, property);
        if (descriptor === undefined) {
            throw new TypeError("Memory Actor state changed while creating a read view");
        }
        const descriptorValue: unknown = "value" in descriptor ? descriptor.value : undefined;
        Object.defineProperty(
            target,
            property,
            "value" in descriptor
                ? {
                      ...descriptor,
                      value: isFunctionValue(descriptorValue)
                          ? immutableRead
                          : readonlyValue(descriptorValue, context),
                      writable: false
                  }
                : descriptor
        );
    }
}

function createActorStateTarget(prototype: ActorStateObject | null): ActorStateObject {
    // SAFETY: Object.create always returns a non-callable object with the requested
    // prototype; the standard TypeScript library alone declares that result as `any`.
    return Object.create(prototype) as ActorStateObject;
}

function readonlyMap(
    value: Map<unknown, unknown>,
    context: ReadonlyContext
): Map<unknown, unknown> {
    const copy = new Map<unknown, unknown>();
    const proxy = new Proxy(
        copy,
        collectionHandler<Map<unknown, unknown>>(
            new Set(["clear", "delete", "forEach", "set", "valueOf"])
        )
    );
    context.seen.set(value, proxy);
    for (const [key, entry] of value) {
        copy.set(readonlyValue(key, context), readonlyValue(entry, context));
    }
    return proxy;
}

function readonlySet(value: Set<unknown>, context: ReadonlyContext): Set<unknown> {
    const copy = new Set<unknown>();
    const proxy = new Proxy(
        copy,
        collectionHandler<Set<unknown>>(new Set(["add", "clear", "delete", "forEach", "valueOf"]))
    );
    context.seen.set(value, proxy);
    for (const entry of value) copy.add(readonlyValue(entry, context));
    return proxy;
}

function collectionHandler<Collection extends object>(
    mutators: ReadonlySet<string>
): ProxyHandler<Collection> {
    return {
        defineProperty: immutableRead,
        deleteProperty: immutableRead,
        get(target, property) {
            if (isStringProperty(property) && mutators.has(property)) return immutableRead;
            const member = inspectProperty(target, property);
            if (member.kind === "missing") return undefined;
            const accessed: unknown =
                member.kind === "accessor" ? member.descriptor.get?.call(target) : member.value;
            return isFunctionValue(accessed) ? accessed.bind(target) : accessed;
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
            const member = inspectProperty(target, property);
            if (member.kind === "missing") return undefined;
            const accessed: unknown =
                member.kind === "accessor" ? member.descriptor.get?.call(target) : member.value;
            if (!isFunctionValue(accessed)) return accessed;
            return property === "slice" ? accessed.bind(target) : immutableRead;
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    return proxy;
}

function readonlyArrayBufferView(
    value: ArrayBufferView,
    context: ReadonlyContext
): ArrayBufferView {
    // SAFETY: copyDetached validates and rejects shared-memory views before any read view
    // is constructed, leaving ArrayBuffer as the only possible backing buffer here.
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
            const member = inspectProperty(target, property);
            if (member.kind === "missing") return undefined;
            const accessed: unknown =
                member.kind === "accessor" ? member.descriptor.get?.call(target) : member.value;
            if (!isFunctionValue(accessed)) return accessed;
            if (!isStringProperty(property) || mutators.has(property) || property.startsWith("set"))
                return immutableRead;
            const allowed =
                target instanceof DataView
                    ? property.startsWith("get")
                    : SAFE_TYPED_ARRAY_METHODS.has(property);
            return allowed ? accessed.bind(target) : immutableRead;
        },
        set: immutableRead
    });
    context.seen.set(value, proxy);
    return proxy;
}

function clonedBuffer(value: ArrayBuffer, context: ReadonlyContext): ArrayBuffer {
    const previous = context.buffers.get(value);
    if (previous !== undefined) return previous;
    const copy = value.slice(0);
    context.buffers.set(value, copy);
    return copy;
}

function cloneView(value: ArrayBufferView, buffer: ArrayBuffer): ArrayBufferView {
    if (value instanceof DataView) {
        return new DataView(buffer, value.byteOffset, value.byteLength);
    }
    // SAFETY: ArrayBuffer.isView admitted this value and the DataView branch returned,
    // so the remaining built-in typed array has this standard constructor signature.
    const constructor = value.constructor as new (
        buffer: ArrayBuffer,
        byteOffset: number,
        length: number
    ) => ArrayBufferView;
    // SAFETY: the same ArrayBuffer.isView and non-DataView narrowing establishes the
    // standard typed-array element-width field.
    const { BYTES_PER_ELEMENT } = value as ArrayBufferView & { readonly BYTES_PER_ELEMENT: number };
    return new constructor(buffer, value.byteOffset, value.byteLength / BYTES_PER_ELEMENT);
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
    if (!isActorStateObject(value)) {
        throw new TypeError("Memory Actor state must be an object");
    }
    const sourceGraph = new ActorStateGraph(value);
    sourceGraph.validate();
    const copy = clone(value);
    if (!isActorStateObject(copy)) {
        throw new TypeError("Memory Actor clones must return an object");
    }
    const copyGraph = new ActorStateGraph(copy);
    copyGraph.validate();
    copyGraph.requireDetachedFrom(sourceGraph.mutableObjects());
    return copy;
}

function isImmutableLeaf(value: unknown): value is Revision {
    return Revision.isExact(value);
}

class ActorStateGraph {
    public constructor(private readonly root: ActorStateObject) {}

    public mutableObjects(): Set<object> {
        const objects = new Set<object>();
        for (const value of this.values()) {
            if (!isImmutableLeaf(value) && isActorStateObject(value)) objects.add(value);
        }
        return objects;
    }

    public requireDetachedFrom(sourceObjects: ReadonlySet<object>): void {
        for (const value of this.values()) {
            if (isImmutableLeaf(value) || !isActorStateObject(value)) continue;
            if (sourceObjects.has(value)) {
                throw new TypeError("Memory Actor clones must detach all mutable state");
            }
        }
    }

    public validate(): void {
        for (const value of this.values()) {
            if (isFunctionValue(value)) {
                throw new TypeError("Memory Actor state cannot contain functions");
            }
            const SharedBuffer = globalThis.SharedArrayBuffer;
            if (
                SharedBuffer !== undefined &&
                (value instanceof SharedBuffer ||
                    (ArrayBuffer.isView(value) && value.buffer instanceof SharedBuffer))
            ) {
                throw new TypeError("Memory Actor state cannot contain shared memory");
            }
            if (!isActorStateObject(value)) continue;
            for (const property of Reflect.ownKeys(value)) {
                const descriptor = Object.getOwnPropertyDescriptor(value, property);
                if (descriptor !== undefined && !("value" in descriptor)) {
                    throw new TypeError("Memory Actor state cannot contain accessor properties");
                }
            }
            const prototype = Reflect.getPrototypeOf(value);
            const isCustomState =
                prototype !== Object.prototype &&
                prototype !== Array.prototype &&
                prototype !== null &&
                !(value instanceof Date) &&
                !(value instanceof TextId) &&
                !(value instanceof Revision) &&
                !(value instanceof Map) &&
                !(value instanceof Set) &&
                !(value instanceof ArrayBuffer) &&
                !ArrayBuffer.isView(value);
            if (isCustomState) {
                if (!Object.isFrozen(value) || !isActorCloneOwnedState(value)) {
                    throw new TypeError(
                        "Memory Actor custom state objects must be frozen and clone-owned"
                    );
                }
            }
        }
    }

    private *values(): Generator<unknown> {
        const expanded = new Set<object>();
        const pending: unknown[] = [this.root];
        while (pending.length > 0) {
            const value = pending.pop();
            if (isActorStateObject(value)) {
                if (expanded.has(value)) continue;
                expanded.add(value);
            }
            yield value;
            if (isImmutableLeaf(value) || !isActorStateObject(value)) continue;
            if (ArrayBuffer.isView(value)) {
                pending.push(value.buffer);
            } else if (value instanceof Map) {
                for (const [key, entry] of value) pending.push(key, entry);
            } else if (value instanceof Set) {
                pending.push(...value);
            }
            const ownsState = isActorCloneOwnedState(value);
            if (ownsState) pending.push(value[ACTOR_STATE_SNAPSHOT]());
            for (const property of Reflect.ownKeys(value)) {
                const descriptor = Object.getOwnPropertyDescriptor(value, property);
                if (descriptor === undefined || !("value" in descriptor)) continue;
                if (property === ACTOR_STATE_SNAPSHOT && ownsState) continue;
                const propertyValue: unknown = descriptor.value;
                pending.push(propertyValue);
            }
        }
    }
}

function isActorStateObject(value: unknown): value is ActorStateObject {
    return value !== null && typeof value === "object";
}

function isFunctionValue(value: unknown): value is CallableFunction {
    return typeof value === "function";
}

function isActorCloneOwnedState(value: unknown): value is ActorCloneOwnedState {
    return (
        isActorStateObject(value) &&
        ACTOR_STATE_SNAPSHOT in value &&
        typeof value[ACTOR_STATE_SNAPSHOT] === "function"
    );
}

type InspectedProperty =
    | { readonly kind: "missing" }
    | { readonly kind: "data"; readonly value: unknown }
    | { readonly kind: "accessor"; readonly descriptor: PropertyDescriptor };

function inspectProperty(target: InspectableActorState, property: PropertyKey): InspectedProperty {
    let owner: object | null = target;
    while (owner !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, property);
        if (descriptor !== undefined) {
            if (!("value" in descriptor)) return { kind: "accessor", descriptor };
            const descriptorValue: unknown = descriptor.value;
            return { kind: "data", value: descriptorValue };
        }
        owner = Reflect.getPrototypeOf(owner);
    }
    return { kind: "missing" };
}

function isStringProperty(value: PropertyKey): value is string {
    return typeof value === "string";
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

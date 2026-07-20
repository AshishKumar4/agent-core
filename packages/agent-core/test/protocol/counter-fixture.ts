import {
    ActorCommitUnknownError,
    ActorId,
    ActorRef,
    MemoryActorStore,
    type ActorLocalStore,
    type ActorRecoveryState,
    type MemoryActorStoreSnapshot,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../src/actors";
import {
    TransientContentAccess,
    TransientContentLease,
    type TransientContentBinding
} from "../../src/content";
import { ContentRef, decodeCanonicalJson, Digest, encodeCanonicalJson } from "../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { AgentCoreError } from "../../src/errors";
import {
    AuditRecord,
    AuditRecordCodec,
    AuditRecordId,
    CorrelationId,
    InvocationId,
    WriteRecordId,
    type AuditAppendContext
} from "../../src/invocations";
import {
    CommandCommitUnknownError,
    CommandDispatcher,
    type CommandDispatchResult,
    type CommandIdentity,
    type CurrentLease,
    type ExpectedRevisionPolicy,
    type LeaseTokenPolicy,
    type ProtocolCommand,
    type ProtocolIdFactory,
    type ProtocolPersistence
} from "../../src/protocol/dispatcher";
import type { ProtocolCommandExecution, ProtocolValueCodec } from "../../src/protocol/registration";
import { MemoryProtocolPersistence, MemoryProtocolRecords } from "../../src/protocol/memory";
import { CommandIngress, type CommandIngressResult } from "../../src/protocol/ingress";
import {
    CommandEnvelope,
    CommandEnvelopeCodec,
    type CommandCaller,
    type LeaseToken
} from "../../src/protocol/envelope";
import { WriteRecordCodec, type WriteRecord } from "../../src/protocol/write";
import { CommandCallerPolicy } from "../../src/protocol/policy";
import { CommandPayloadMalformedError } from "../../src/protocol/payload";
import { Revision } from "../../src/core";
import { TurnId } from "../../src/agents";
import { CommandAuthenticator } from "../../src/protocol/authentication";

export type FaultBoundary =
    | "gateMutation"
    | "readSnapshot"
    | "payloadValidation"
    | "mutation"
    | "forgedUnknown"
    | "forgedActorUnknown"
    | "unreadableInvocationAudit"
    | "invocationAudit"
    | "writeAudit"
    | "writeRecord"
    | "contentGet"
    | "contentPut"
    | "contentUnknown"
    | "authUnknown"
    | "replyEncoding"
    | "observationEncoding"
    | "unknownUnindexed"
    | "unknownAck";

const counterTenant = new TenantId("counter-tenant");

export interface CounterSnapshot {
    readonly value: number;
    readonly revision: Revision;
    readonly writes: readonly WriteRecord[];
    readonly audits: ReadonlyMap<string, AuditRecord>;
    readonly identityCount: number;
    readonly contentGets: number;
    readonly contentPuts: number;
}

export interface CounterEnvelopeInit {
    readonly key?: string;
    readonly amount?: number;
    readonly expectedRevision?: Revision;
    readonly omitRevision?: boolean;
    readonly lease?: LeaseToken;
    readonly callerCause?: AuditRecordId;
}

export interface CounterFixture {
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    readonly principal: PrincipalId;
    readonly caller: CommandCaller;

    envelope(init?: CounterEnvelopeInit): Uint8Array;
    dispatch(
        raw: Uint8Array,
        caller?: CommandCaller,
        submittedBytes?: Uint8Array
    ): Promise<CommandDispatchResult>;
    accept(
        raw: Uint8Array,
        caller?: CommandCaller,
        submittedBytes?: Uint8Array
    ): Promise<CommandIngressResult>;
    seedInvocationCause(
        id?: string,
        location?: {
            readonly actor?: ActorRef;
            readonly tenant?: TenantId;
        }
    ): AuditRecord;
    corruptRemoveAudit(id: AuditRecordId): void;
    setLease(init?: {
        readonly turn?: string;
        readonly holder?: PrincipalId;
        readonly epoch?: number;
        readonly expiresAt?: Date;
    }): LeaseToken;
    setAuthorized(authorized: boolean): void;
    setLifecycle(lifecycle: boolean): void;
    setFault(fault: FaultBoundary | undefined): void;
    installPayload(ref: string, payload: Uint8Array): void;
    removePayload(ref: string): void;
    payloadBytes(amount?: number): Uint8Array;
    pauseNextPayloadGet(): { readonly started: Promise<void>; release(): void };
    snapshot(): CounterSnapshot;
    restart(): CounterFixture;
    recovery(): ActorRecoveryState | undefined;
}

export type CounterFixtureFactory = (options?: CounterHarnessOptions) => CounterFixture;

interface CounterState {
    value: number;
    revision: Revision;
    authorized: boolean;
    lifecycle: boolean;
    lease: CounterStoredLease | undefined;
    records: MemoryProtocolRecords;
    nextId: number;
    fault: FaultBoundary | undefined;
}

interface CounterStoredLease {
    readonly turn: CurrentLease["turn"];
    readonly holderTenant: TenantId | undefined;
    readonly holder: PrincipalId | undefined;
    readonly epoch: number;
    readonly expiresAt: Date | undefined;
}

export interface CounterReadCapability {
    readonly authorized: boolean;
    readonly lifecycle: boolean;
    readonly revision: Revision;
    readonly lease: CurrentLease | undefined;
}

export interface CounterOperations<TTransaction> {
    increment(
        transaction: TTransaction,
        amount: number
    ): {
        readonly value: number;
        readonly revision: Revision;
        readonly fault?: FaultBoundary;
    };
}

export class CounterCommand<TTransaction> implements ProtocolCommand<
    TTransaction,
    CounterReadCapability,
    unknown,
    CounterReply,
    CounterObservation
> {
    public readonly payload: CounterPayloadCodec;
    public readonly replyCodec: ProtocolValueCodec<CounterReply> = counterReplyCodec;
    public readonly observationCodec: ProtocolValueCodec<CounterObservation> =
        counterObservationCodec;

    public constructor(
        public readonly expectedRevision: ExpectedRevisionPolicy,
        public readonly lease: LeaseTokenPolicy,
        private readonly operations: CounterOperations<TTransaction>,
        private readonly asynchronousGate: boolean,
        public readonly caller: CommandCallerPolicy,
        private readonly typedExecution: boolean,
        private readonly typedObservation = true,
        includeReplyCodec = true,
        includeObservationCodec = true,
        asynchronousPayload = false,
        payloadFailure?: PayloadDecoderFailure,
        private readonly mutateEnvelope = false,
        public readonly command = "counter.increment"
    ) {
        this.payload = new CounterPayloadCodec(asynchronousPayload, payloadFailure);
        if (!includeReplyCodec) {
            Object.defineProperty(this, "replyCodec", { value: undefined });
        }
        if (!includeObservationCodec) {
            Object.defineProperty(this, "observationCodec", { value: undefined });
        }
    }

    public authorize(read: CounterReadCapability, envelope: CommandEnvelope): boolean {
        if (this.mutateEnvelope) {
            Reflect.set(envelope, "command", "mutated.command");
            Reflect.set(envelope.caller, "kind", "actor");
            if (envelope.lease !== undefined) Reflect.set(envelope.lease, "epoch", 999);
        }
        return this.asynchronousGate
            ? (Promise.resolve(read.authorized) as unknown as boolean)
            : read.authorized;
    }

    public permitsLifecycle(read: CounterReadCapability): boolean {
        return read.lifecycle;
    }

    public currentRevision(read: CounterReadCapability): Revision {
        return read.revision;
    }

    public currentLease(
        read: CounterReadCapability,
        _envelope: CommandEnvelope,
        _payload: unknown,
        _at: Date
    ): CurrentLease | undefined {
        return read.lease;
    }

    public execute(
        transaction: TTransaction,
        _envelope: CommandEnvelope,
        payload: unknown,
        _at: Date
    ): Uint8Array | ProtocolCommandExecution<CounterReply, CounterObservation> {
        const decoded = requireCounterPayload(payload);
        const result = this.operations.increment(transaction, decoded.amount);
        const reply = {
            value: result.value,
            revision: result.revision.value,
            ...(result.fault === undefined ? {} : { encodingFault: result.fault })
        };
        return this.typedExecution
            ? {
                  reply,
                  ...(this.typedObservation
                      ? {
                            observation: {
                                amount: decoded.amount,
                                ...(result.fault === undefined
                                    ? {}
                                    : { encodingFault: result.fault })
                            }
                        }
                      : {})
              }
            : encodeCanonicalJson({ value: reply.value, revision: reply.revision });
    }
}

class CounterPayloadCodec {
    public constructor(
        private readonly asynchronous: boolean,
        private readonly failure?: PayloadDecoderFailure
    ) {}

    public decode(bytes: Uint8Array): CounterPayload {
        if (this.failure === "type") throw new TypeError("Injected payload decoder failure");
        if (this.failure === "agentCore") {
            throw new AgentCoreError("protocol.invalid-state", "Injected payload decoder failure");
        }
        if (this.failure === "programmer") throw new RangeError("Injected payload decoder failure");
        let decoded: ReturnType<typeof decodeCanonicalJson>;
        try {
            decoded = decodeCanonicalJson(bytes);
        } catch (error) {
            if (error instanceof AgentCoreError) {
                throw new CommandPayloadMalformedError("Counter payload is invalid");
            }
            throw error;
        }
        if (
            decoded === null ||
            Array.isArray(decoded) ||
            typeof decoded !== "object" ||
            Object.keys(decoded).length !== 1
        ) {
            throw new CommandPayloadMalformedError("Counter payload is invalid");
        }
        const amount = (decoded as { readonly [key: string]: unknown })["amount"];
        if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
            throw new CommandPayloadMalformedError("Counter payload is invalid");
        }
        const payload = { amount };
        return this.asynchronous
            ? (Promise.resolve(payload) as unknown as CounterPayload)
            : payload;
    }
}

interface CounterPayload {
    readonly amount: number;
}

type PayloadDecoderFailure = "type" | "agentCore" | "programmer";

interface CounterReply {
    readonly value: number;
    readonly revision: number;
    readonly encodingFault?: FaultBoundary;
}

interface CounterObservation {
    readonly amount: number;
    readonly encodingFault?: FaultBoundary;
}

const counterReplyCodec: ProtocolValueCodec<CounterReply> = {
    encode: (value) => {
        if (value.encodingFault === "replyEncoding") {
            throw new TypeError("Injected replyEncoding failure");
        }
        return encodeCanonicalJson({ value: value.value, revision: value.revision });
    },
    decode: (bytes) => requireCounterReply(decodeCanonicalJson(bytes))
};

const counterObservationCodec: ProtocolValueCodec<CounterObservation> = {
    encode: (value) => {
        if (value.encodingFault === "observationEncoding") {
            throw new TypeError("Injected observationEncoding failure");
        }
        return encodeCanonicalJson({ amount: value.amount });
    },
    decode: (bytes) => requireCounterObservation(decodeCanonicalJson(bytes))
};

function requireCounterPayload(payload: unknown): CounterPayload {
    if (
        payload === null ||
        typeof payload !== "object" ||
        typeof (payload as { readonly amount?: unknown }).amount !== "number"
    ) {
        throw new TypeError("Counter payload was not decoded");
    }
    return payload as CounterPayload;
}

function requireCounterReply(value: unknown): CounterReply {
    if (
        value === null ||
        typeof value !== "object" ||
        Object.keys(value).sort().join(",") !== "revision,value"
    ) {
        throw new TypeError("Counter reply is invalid");
    }
    const reply = value as { readonly revision?: unknown; readonly value?: unknown };
    if (
        typeof reply.value !== "number" ||
        !Number.isSafeInteger(reply.value) ||
        typeof reply.revision !== "number" ||
        !Number.isSafeInteger(reply.revision)
    ) {
        throw new TypeError("Counter reply is invalid");
    }
    return { value: reply.value, revision: reply.revision };
}

function requireCounterObservation(value: unknown): CounterObservation {
    if (value === null || typeof value !== "object" || Object.keys(value).join(",") !== "amount") {
        throw new TypeError("Counter observation is invalid");
    }
    const amount = (value as { readonly amount?: unknown }).amount;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
        throw new TypeError("Counter observation is invalid");
    }
    return { amount };
}

export class FaultingCounterPersistence<TTransaction> implements ProtocolPersistence<TTransaction> {
    public constructor(
        private readonly persistence: ProtocolPersistence<TTransaction>,
        private readonly fault: (transaction: TTransaction) => FaultBoundary | undefined
    ) {}

    public repair(transaction: TTransaction): void {
        this.persistence.repair?.(transaction);
    }

    public findWrite(
        transaction: TTransaction,
        identity: CommandIdentity
    ): WriteRecord | undefined {
        return this.persistence.findWrite(transaction, identity);
    }

    public findAudit(transaction: TTransaction, id: AuditRecordId): AuditRecord | undefined {
        const audit = this.persistence.findAudit(transaction, id);
        return this.fault(transaction) === "unreadableInvocationAudit" &&
            audit?.kind.kind === "invocation"
            ? undefined
            : audit;
    }

    public appendAudit(
        transaction: TTransaction,
        record: AuditRecord,
        context?: AuditAppendContext
    ): void {
        this.persistence.appendAudit(transaction, record, context);
        failAt(
            this.fault(transaction),
            record.kind.kind === "invocation" ? "invocationAudit" : "writeAudit"
        );
    }

    public appendWrite(transaction: TTransaction, record: WriteRecord): void {
        this.persistence.appendWrite(transaction, record);
        failAt(this.fault(transaction), "writeRecord");
    }
}

export class CounterIds<TTransaction> implements ProtocolIdFactory<TTransaction> {
    public constructor(
        private readonly createId: (transaction: TTransaction, prefix: string) => string
    ) {}

    public writeRecordId(transaction: TTransaction): WriteRecordId {
        return new WriteRecordId(this.createId(transaction, "write"));
    }

    public auditRecordId(transaction: TTransaction): AuditRecordId {
        return new AuditRecordId(this.createId(transaction, "audit"));
    }

    public invocationId(transaction: TTransaction): InvocationId {
        return new InvocationId(this.createId(transaction, "invocation"));
    }

    public correlationId(transaction: TTransaction): CorrelationId {
        return new CorrelationId(this.createId(transaction, "correlation"));
    }
}

class FaultingMemoryActorStore implements ActorLocalStore<CounterState> {
    public constructor(
        private readonly store: MemoryActorStore<CounterState>,
        activating = true
    ) {
        if (!activating) {
            Object.defineProperty(this, "activateActor", { value: undefined });
        }
    }

    public bindActor(actor: ActorRef): void {
        this.store.bindActor(actor);
    }

    public activateActor(
        actor: ActorRef,
        start: TransactionOperation<CounterState, void>
    ): ActorRecoveryState {
        return this.store.activateActor(actor, start);
    }

    public transaction<TResult>(
        operation: TransactionOperation<CounterState, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult {
        const before = this.store.snapshot().state.records.snapshot().writes.length;
        const result = this.store.transaction(operation, ...guard);
        const snapshot = this.store.snapshot().state;
        if (
            (snapshot.fault === "unknownAck" || snapshot.fault === "unknownUnindexed") &&
            snapshot.records.snapshot().writes.length !== before
        ) {
            throw new CommandCommitUnknownError(undefined, snapshot.fault === "unknownAck");
        }
        return result;
    }

    public read<TResult>(
        transaction: CounterState,
        operation: TransactionOperation<CounterState, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult {
        return this.store.read(transaction, operation, ...guard);
    }

    public loadRecoveryState(
        transaction: CounterState,
        actor: ActorRef
    ): ActorRecoveryState | undefined {
        return this.store.loadRecoveryState(transaction, actor);
    }

    public saveRecoveryState(transaction: CounterState, state: ActorRecoveryState): void {
        this.store.saveRecoveryState(transaction, state);
    }

    public snapshot(): MemoryActorStoreSnapshot<CounterState> {
        return this.store.snapshot();
    }
}

export interface CounterHarnessOptions {
    readonly expectedRevision?: ExpectedRevisionPolicy;
    readonly lease?: LeaseTokenPolicy;
    readonly asynchronousGate?: boolean;
    readonly caller?: CommandCallerPolicy;
    readonly typedExecution?: boolean;
    readonly typedObservation?: boolean;
    readonly includeReplyCodec?: boolean;
    readonly includeObservationCodec?: boolean;
    readonly asynchronousPayload?: boolean;
    readonly payloadFailure?: PayloadDecoderFailure;
    readonly mutateEnvelope?: boolean;
    readonly activatingStore?: boolean;
    readonly commandName?: string;
    readonly duplicateCommand?: boolean;
    readonly limits?: { readonly envelopeBytes: number; readonly payloadBytes: number };
    readonly useDefaultNow?: boolean;
    readonly now?: () => Date;
}

export class CounterContentStore extends TransientContentAccess {
    readonly #content = new Map<string, Uint8Array>();
    #gets = 0;
    #puts = 0;
    #nextGetBarrier: PayloadGetBarrier | undefined;

    public constructor(private readonly fault: () => FaultBoundary | undefined) {
        super();
    }

    public async acquire(
        binding: TransientContentBinding,
        submitted?: Uint8Array
    ): Promise<TransientContentLease | undefined> {
        let bytes: Uint8Array | undefined;
        if (submitted === undefined) {
            this.#gets += 1;
            const barrier = this.#nextGetBarrier;
            this.#nextGetBarrier = undefined;
            if (barrier !== undefined) {
                barrier.start();
                await barrier.wait();
            }
            if (this.fault() === "contentGet") {
                throw new TypeError("Injected contentGet failure");
            }
            if (this.fault() === "contentUnknown") {
                throw new CommandCommitUnknownError(undefined, true);
            }
            bytes = this.#content.get(binding.ref.value)?.slice();
        } else {
            this.#puts += 1;
            if (this.fault() === "contentPut") {
                throw new TypeError("Injected contentPut failure");
            }
            bytes = submitted.slice();
            this.#content.set(binding.ref.value, bytes.slice());
        }
        return bytes === undefined
            ? undefined
            : new CounterContentLease(bytes, binding, this.fault);
    }

    public install(ref: string, bytes: Uint8Array): void {
        this.#content.set(ref, bytes.slice());
    }

    public remove(ref: string): void {
        this.#content.delete(ref);
    }

    public pauseNextGet(): { readonly started: Promise<void>; release(): void } {
        const barrier = new PayloadGetBarrier();
        this.#nextGetBarrier = barrier;
        return { started: barrier.started, release: () => barrier.release() };
    }

    public get gets(): number {
        return this.#gets;
    }

    public get puts(): number {
        return this.#puts;
    }
}

export class CounterAuthenticator extends CommandAuthenticator<CommandCaller | undefined> {
    public constructor(
        tenant: TenantId,
        private readonly fault: () => FaultBoundary | undefined = () => undefined
    ) {
        super(tenant);
    }

    protected authenticateTransport(caller: CommandCaller | undefined): CommandCaller | undefined {
        if (this.fault() === "authUnknown") {
            throw new CommandCommitUnknownError(undefined, true);
        }
        return caller;
    }
}

class CounterContentLease extends TransientContentLease {
    readonly #bytes: Uint8Array;

    public constructor(
        bytes: Uint8Array,
        private readonly acquired: TransientContentBinding,
        private readonly fault: () => FaultBoundary | undefined
    ) {
        super();
        this.#bytes = bytes.slice();
    }

    public read(): Uint8Array {
        return this.#bytes.slice();
    }

    public matches(binding: TransientContentBinding, now: Date): boolean {
        if (this.fault() === "payloadValidation") {
            throw new TypeError("Injected payloadValidation failure");
        }
        return (
            transientBindingsEqual(this.acquired, binding) &&
            binding.expiresAt.getTime() > now.getTime()
        );
    }

    public async close(): Promise<void> {}
}

class PayloadGetBarrier {
    readonly started: Promise<void>;
    readonly #waiting: Promise<void>;
    #start: (() => void) | undefined;
    #release: (() => void) | undefined;

    public constructor() {
        this.started = new Promise((resolve) => {
            this.#start = resolve;
        });
        this.#waiting = new Promise((resolve) => {
            this.#release = resolve;
        });
    }

    public start(): void {
        this.#start?.();
        this.#start = undefined;
    }

    public wait(): Promise<void> {
        return this.#waiting;
    }

    public release(): void {
        this.#release?.();
        this.#release = undefined;
    }
}

function transientBindingsEqual(
    left: TransientContentBinding,
    right: TransientContentBinding
): boolean {
    return (
        left.tenant.equals(right.tenant) &&
        left.actor.equals(right.actor) &&
        left.envelopeDigest.equals(right.envelopeDigest) &&
        left.ref.equals(right.ref) &&
        left.digest.equals(right.digest) &&
        left.expiresAt.getTime() === right.expiresAt.getTime()
    );
}

export class CounterHarness implements CounterFixture {
    public static readonly now = new Date("2026-07-07T12:00:00.000Z");
    public readonly actor = new ActorRef("run", new ActorId("counter-actor"));
    public readonly tenant = counterTenant;
    public readonly principal = new PrincipalId("counter-principal");
    public readonly caller: CommandCaller = {
        kind: "principal",
        principal: new PrincipalRef(this.tenant, this.principal)
    };
    public readonly store: FaultingMemoryActorStore;
    public readonly content: CounterContentStore;
    public readonly dispatcher: CommandDispatcher<CounterState, CounterReadCapability>;
    public readonly ingress: CommandIngress<CounterState, CounterReadCapability>;
    readonly #options: CounterHarnessOptions;
    readonly #persistence: ProtocolPersistence<CounterState>;

    public constructor(
        options: CounterHarnessOptions = {},
        snapshot?: MemoryActorStoreSnapshot<CounterState>
    ) {
        this.#options = options;
        const actorStore =
            snapshot === undefined
                ? new MemoryActorStore(initialCounterState(), cloneState)
                : MemoryActorStore.restore(snapshot, cloneState);
        this.store = new FaultingMemoryActorStore(actorStore, options.activatingStore ?? true);
        this.content = new CounterContentStore(() => this.state().fault);
        this.#persistence = new FaultingCounterPersistence(
            new MemoryProtocolPersistence((transaction) => transaction.records),
            (transaction) => transaction.fault
        );
        const command = new CounterCommand(
            options.expectedRevision ?? "required",
            options.lease ?? "optional",
            memoryCounterOperations,
            options.asynchronousGate ?? false,
            options.caller ?? CommandCallerPolicy.principal(),
            options.typedExecution ?? false,
            options.typedObservation ?? true,
            options.includeReplyCodec ?? true,
            options.includeObservationCodec ?? true,
            options.asynchronousPayload ?? false,
            options.payloadFailure,
            options.mutateEnvelope ?? false,
            options.commandName ?? "counter.increment"
        );
        this.dispatcher = new CommandDispatcher({
            store: this.store,
            persistence: this.#persistence,
            ids: new CounterIds(nextId),
            actor: this.actor,
            tenant: this.tenant,
            readOnly: memoryReadCapability,
            commands: options.duplicateCommand === true ? [command, command] : [command],
            limits: options.limits ?? { envelopeBytes: 4096, payloadBytes: 1024 },
            ...(options.useDefaultNow === true
                ? {}
                : { now: options.now ?? (() => CounterHarness.now) })
        });
        this.ingress = new CommandIngress({
            dispatcher: this.dispatcher,
            content: this.content,
            authenticator: new CounterAuthenticator(this.tenant, () => this.state().fault),
            leaseForMilliseconds: 60_000,
            ...(options.useDefaultNow === true ? {} : { now: () => CounterHarness.now })
        });
    }

    public envelope(init: CounterEnvelopeInit = {}): Uint8Array {
        const amount = init.amount ?? 1;
        const key = init.key ?? "counter-key";
        const payload = encodeCanonicalJson({ amount });
        const ref = ContentRef.fromDigest(Digest.sha256(payload));
        this.installPayload(ref.value, payload);
        return CommandEnvelopeCodec.encode(
            new CommandEnvelope({
                command: "counter.increment",
                caller: this.caller,
                idempotencyKey: key,
                ...(init.omitRevision === true
                    ? {}
                    : { expectedRevision: init.expectedRevision ?? this.state().revision }),
                ...(init.lease === undefined ? {} : { lease: init.lease }),
                ...(init.callerCause === undefined ? {} : { callerCause: init.callerCause }),
                payload: ref,
                payloadDigest: Digest.sha256(payload)
            })
        );
    }

    public async dispatch(
        raw: Uint8Array,
        caller: CommandCaller | undefined = this.caller,
        submittedBytes?: Uint8Array
    ): Promise<CommandDispatchResult> {
        const result = await this.accept(raw, caller, submittedBytes);
        if (result.kind === "preDispatchFailure") {
            throw result.cause;
        }
        return result;
    }

    public accept(
        raw: Uint8Array,
        caller: CommandCaller | undefined = this.caller,
        submittedBytes?: Uint8Array
    ): Promise<CommandIngressResult> {
        return this.ingress.accept(raw, caller, submittedBytes);
    }

    public seedInvocationCause(
        id = "caller-cause",
        location: {
            readonly actor?: ActorRef;
            readonly tenant?: TenantId;
        } = {}
    ): AuditRecord {
        const record = new AuditRecord({
            id: new AuditRecordId(id),
            actor: location.actor ?? this.actor,
            tenant: location.tenant ?? this.tenant,
            correlation: new CorrelationId(`correlation-${id}`),
            kind: { kind: "invocation", id: new InvocationId(`invocation-${id}`) }
        });
        this.store.transaction((transaction) => this.#persistence.appendAudit(transaction, record));
        return record;
    }

    public corruptRemoveAudit(id: AuditRecordId): void {
        this.store.transaction((transaction) => {
            const snapshot = transaction.records.snapshot();
            transaction.records = new MemoryProtocolRecords({
                ...snapshot,
                audits: snapshot.audits.filter((record) => record.id !== id.value)
            });
        });
    }

    public setLease(
        init: {
            readonly turn?: string;
            readonly holder?: PrincipalId;
            readonly epoch?: number;
            readonly expiresAt?: Date;
        } = {}
    ): LeaseToken {
        const token: LeaseToken = {
            turn: new TurnId(init.turn ?? "counter-turn"),
            holder: new PrincipalRef(this.tenant, init.holder ?? this.principal),
            epoch: init.epoch ?? 3
        };
        this.store.transaction((transaction) => {
            transaction.lease = {
                turn: token.turn,
                holderTenant: token.holder.tenantId,
                holder: token.holder.principalId,
                epoch: token.epoch,
                expiresAt: init.expiresAt ?? new Date("2026-07-07T12:05:00.000Z")
            };
        });
        return token;
    }

    public setAuthorized(authorized: boolean): void {
        this.store.transaction((transaction) => {
            transaction.authorized = authorized;
        });
    }

    public setLifecycle(lifecycle: boolean): void {
        this.store.transaction((transaction) => {
            transaction.lifecycle = lifecycle;
        });
    }

    public setFault(fault: FaultBoundary | undefined): void {
        this.store.transaction((transaction) => {
            transaction.fault = fault;
        });
    }

    public installPayload(ref: string, payload: Uint8Array): void {
        this.content.install(ref, payload);
    }

    public removePayload(ref: string): void {
        this.content.remove(ref);
    }

    public payloadBytes(amount = 1): Uint8Array {
        return encodeCanonicalJson({ amount });
    }

    public pauseNextPayloadGet(): { readonly started: Promise<void>; release(): void } {
        return this.content.pauseNextGet();
    }

    public snapshot(): CounterSnapshot {
        const state = this.state();
        const records = state.records.snapshot();
        return {
            value: state.value,
            revision: state.revision,
            writes: records.writes.map((record) => WriteRecordCodec.decode(record.bytes)),
            audits: new Map(
                records.audits.map((record) => [record.id, AuditRecordCodec.decode(record.bytes)])
            ),
            identityCount: records.identities.length,
            contentGets: this.content.gets,
            contentPuts: this.content.puts
        };
    }

    public restart(): CounterFixture {
        return new CounterHarness(this.#options, this.store.snapshot());
    }

    public recovery(): ActorRecoveryState | undefined {
        return this.store.transaction((transaction) =>
            this.store.loadRecoveryState(transaction, this.actor)
        );
    }

    private state(): CounterState {
        return this.store.snapshot().state;
    }
}

const memoryCounterOperations: CounterOperations<CounterState> = {
    increment(transaction, amount) {
        transaction.value += amount;
        transaction.revision = transaction.revision.next();
        if (transaction.fault === "forgedUnknown") throw new CommandCommitUnknownError();
        if (transaction.fault === "forgedActorUnknown") throw new ActorCommitUnknownError();
        fail(transaction, "mutation");
        return {
            value: transaction.value,
            revision: transaction.revision,
            ...(transaction.fault === undefined ? {} : { fault: transaction.fault })
        };
    }
};

function memoryReadCapability(transaction: CounterState): CounterReadCapability {
    if (transaction.fault === "readSnapshot") {
        throw new TypeError("Injected readSnapshot failure");
    }
    if (transaction.fault === "gateMutation") {
        transaction.value += 100;
        transaction.revision = transaction.revision.next();
    }
    if (
        transaction.lease !== undefined &&
        (transaction.lease.holderTenant === undefined) !== (transaction.lease.holder === undefined)
    ) {
        throw new TypeError("Memory counter lease holder is partially qualified");
    }
    return Object.freeze({
        authorized: transaction.fault === "gateMutation" ? false : transaction.authorized,
        lifecycle: transaction.lifecycle,
        revision: transaction.revision,
        lease:
            transaction.lease === undefined
                ? undefined
                : Object.freeze({
                      turn: transaction.lease.turn,
                      holder:
                          transaction.lease.holderTenant === undefined ||
                          transaction.lease.holder === undefined
                              ? undefined
                              : new PrincipalRef(
                                    transaction.lease.holderTenant,
                                    transaction.lease.holder
                                ),
                      epoch: transaction.lease.epoch,
                      expiresAt:
                          transaction.lease.expiresAt === undefined
                              ? undefined
                              : new Date(transaction.lease.expiresAt)
                  })
    });
}

function cloneState(state: CounterState): CounterState {
    return {
        ...state,
        records: state.records.clone(),
        lease:
            state.lease === undefined
                ? undefined
                : {
                      turn: new TurnId(state.lease.turn.value),
                      holderTenant:
                          state.lease.holderTenant === undefined
                              ? undefined
                              : new TenantId(state.lease.holderTenant.value),
                      holder:
                          state.lease.holder === undefined
                              ? undefined
                              : new PrincipalId(state.lease.holder.value),
                      epoch: state.lease.epoch,
                      expiresAt:
                          state.lease.expiresAt === undefined
                              ? undefined
                              : new Date(state.lease.expiresAt)
                  }
    };
}

function initialCounterState(): CounterState {
    return {
        value: 0,
        revision: Revision.initial(),
        authorized: true,
        lifecycle: true,
        lease: undefined,
        records: new MemoryProtocolRecords(),
        nextId: 0,
        fault: undefined
    };
}

function nextId(transaction: CounterState, prefix: string): string {
    transaction.nextId += 1;
    return `${prefix}-${transaction.nextId}`;
}

function fail(transaction: CounterState, boundary: FaultBoundary): void {
    failAt(transaction.fault, boundary);
}

function failAt(actual: FaultBoundary | undefined, expected: FaultBoundary): void {
    if (actual === expected) throw new Error(`Injected ${expected} failure`);
}

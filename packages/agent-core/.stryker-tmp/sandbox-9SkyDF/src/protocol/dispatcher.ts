// @ts-nocheck
import {
    Actor,
    ActorCommitUnknownError,
    requireSynchronousResult,
    type ActorContext,
    type ActorLocalStore,
    type ActorRef,
    type SynchronousResultGuard
} from "../actors";
import { Digest, encodeCanonicalJson, type Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { TenantId } from "../identity";
import {
    AuditRecord,
    CorrelationId,
    validateAuditAppend,
    type AuditRecordId,
    type AuditRecordLookup,
    type AuditRootAdmission,
    type InvocationId,
    type WriteRecordId
} from "../invocations";
import { commandAuthenticationMatches, type CommandAuthentication } from "./authentication";
import { CommandEnvelopeCodec, type CommandCaller, type CommandEnvelope } from "./envelope";
import {
    CommandPayloadMalformedError,
    inspectPreparedCommandPayload,
    type PreparedCommandPayload
} from "./payload";
import type {
    ExpectedRevisionPolicy,
    ProtocolCommand,
    ProtocolCommandExecution,
    ProtocolValueCodec
} from "./registration";
import { WriteRecord, type CommandOutcome } from "./write";

export type {
    CurrentLease,
    ExpectedRevisionPolicy,
    LeaseTokenPolicy,
    ProtocolCommand
} from "./registration";

export interface CommandIdentity {
    readonly caller: CommandCaller;
    readonly idempotencyKey: string;
}

export interface ProtocolPersistence<Transaction> {
    repair?(transaction: Transaction): void;
    findWrite(transaction: Transaction, identity: CommandIdentity): WriteRecord | undefined;
    findAudit(transaction: Transaction, id: AuditRecordId): AuditRecord | undefined;
    appendAudit(
        transaction: Transaction,
        record: AuditRecord,
        admission?: AuditRootAdmission
    ): void;
    appendWrite(transaction: Transaction, record: WriteRecord): void;
}

export interface ProtocolIdFactory<Transaction> {
    writeRecordId(transaction: Transaction): WriteRecordId;
    auditRecordId(transaction: Transaction): AuditRecordId;
    invocationId(transaction: Transaction): InvocationId;
    correlationId(transaction: Transaction): CorrelationId;
}

export interface CommandProtocolLimits {
    readonly envelopeBytes: number;
    readonly payloadBytes: number;
}

export interface CommandDispatcherInit<Transaction, Read, ReadTransaction = Transaction> {
    readonly store: ActorLocalStore<Transaction, ReadTransaction>;
    readonly persistence: ProtocolPersistence<Transaction>;
    readonly ids: ProtocolIdFactory<Transaction>;
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    readonly readOnly: (transaction: ReadTransaction) => Read;
    readonly commands: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly limits: CommandProtocolLimits;
    readonly now?: () => Date;
    // Type-only W2/W4 cutover input; generic dispatch never reads or trusts it.
    readonly heldContentVerifier?: unknown;
}

export interface CommandDispatchResult {
    readonly kind: "commandOutcome";
    readonly outcome: CommandOutcome;
    readonly reply: Uint8Array;
    readonly observation?: Uint8Array;
    readonly write: WriteRecord;
}

export type CommandAdmission = CompletedCommandAdmission | PreparedCommandAdmission;

export interface CompletedCommandAdmission {
    readonly kind: "completed";
    readonly result: CommandDispatchResult;
}

export interface PreparedCommandAdmission {
    readonly kind: "prepare";
    dispatch(payload: PreparedCommandPayload): Promise<CommandDispatchResult>;
}

interface Decision {
    readonly outcome: CommandOutcome;
    readonly reply: Uint8Array;
    readonly observation?: Uint8Array;
    readonly duplicateOf?: WriteRecordId;
    readonly callerCauseEligible: boolean;
    readonly reservesIdentity: boolean;
}

interface ValidatedRequest<Transaction, Read> {
    readonly envelope: CommandEnvelope;
    readonly command: RegisteredProtocolCommand<Transaction, Read>;
    readonly identity: CommandIdentity;
}

type AdmissionTransactionResult =
    | { readonly kind: "completed"; readonly result: CommandDispatchResult }
    | { readonly kind: "prepare" };

export class CommandCommitUnknownError extends ActorCommitUnknownError {
    public readonly retrySameKey: boolean;

    public constructor(
        message = "The command transaction commit result is unknown",
        retrySameKey = false
    ) {
        super(message);
        this.retrySameKey = retrySameKey;

        // Actor commit uncertainty is nominal. Re-prototype an exactly issued canonical
        // error so the Actor recognizes this protocol specialization synchronously.
        const canonical = new ActorCommitUnknownError(message);
        Object.setPrototypeOf(canonical, new.target.prototype);
        Object.defineProperties(canonical, {
            name: { configurable: true, value: "CommandCommitUnknownError" },
            retrySameKey: { enumerable: true, value: retrySameKey }
        });
        return canonical as CommandCommitUnknownError;
    }
}

export class CommandPreparationUnavailableError extends AgentCoreError {
    public constructor(message = "Prepared command content is unavailable") {
        super("protocol.invalid-state", message);
        this.name = "CommandPreparationUnavailableError";
    }
}

export class CommandDispatcher<
    Transaction,
    Read,
    ReadTransaction = Transaction
> extends Actor<Transaction> {
    readonly #store: ActorLocalStore<Transaction, ReadTransaction>;
    readonly #persistence: ProtocolPersistence<Transaction>;
    readonly #ids: ProtocolIdFactory<Transaction>;
    readonly #actor: ActorRef;
    readonly #tenant: TenantId;
    readonly #readOnly: (transaction: ReadTransaction) => Read;
    readonly #commands: ReadonlyMap<string, RegisteredProtocolCommand<Transaction, Read>>;
    readonly #limits: CommandProtocolLimits;
    readonly #now: () => Date;

    public constructor(init: CommandDispatcherInit<Transaction, Read, ReadTransaction>) {
        const context = validateCommandActorContext(init.actor, init.store);
        const commands = new Map<string, RegisteredProtocolCommand<Transaction, Read>>();
        for (const command of init.commands) {
            if (command.command.length === 0 || commands.has(command.command)) {
                throw new TypeError("Protocol command names must be non-empty and unique");
            }
            commands.set(command.command, command);
        }
        validateLimit(init.limits.envelopeBytes, "envelope");
        validateLimit(init.limits.payloadBytes, "payload");
        super(context, (transaction) => init.persistence.repair?.(transaction));
        this.#store = init.store;
        this.#persistence = init.persistence;
        this.#ids = init.ids;
        this.#actor = init.actor;
        this.#tenant = init.tenant;
        this.#readOnly = init.readOnly;
        this.#commands = commands;
        this.#limits = { ...init.limits };
        this.#now = init.now ?? (() => new Date());
    }

    public get actor(): ActorRef {
        return this.#actor;
    }

    public get tenant(): TenantId {
        return this.#tenant;
    }

    public get limits(): CommandProtocolLimits {
        return { ...this.#limits };
    }

    public decodeForPreparation(rawEnvelope: Uint8Array): CommandEnvelope | undefined {
        return this.decode(rawEnvelope);
    }

    public decodeForAuthentication(rawEnvelope: Uint8Array): CommandEnvelope | undefined {
        return this.decode(rawEnvelope);
    }

    public admit(
        rawEnvelope: Uint8Array,
        authentication: CommandAuthentication | undefined
    ): Promise<CommandAdmission> {
        const submitted = rawEnvelope.slice();
        return this.execute((transaction) => {
            try {
                const result = this.admitInTransaction(transaction, submitted, authentication);
                if (result.kind === "completed") return result;
                return {
                    kind: "prepare",
                    dispatch: (payload) => this.dispatchPrepared(submitted, authentication, payload)
                };
            } catch (error) {
                throw rejectForgedCommitUnknown(error);
            }
        });
    }

    private admitInTransaction(
        transaction: Transaction,
        rawEnvelope: Uint8Array,
        authentication: CommandAuthentication | undefined
    ): AdmissionTransactionResult {
        const envelopeDigest = Digest.sha256(rawEnvelope);
        const validated = this.validate(rawEnvelope, envelopeDigest, authentication);
        if (validated instanceof DecisionBeforePreparation) {
            const at = this.timestamp();
            const duplicate =
                validated.decision.reservesIdentity && validated.identity !== undefined
                    ? this.#persistence.findWrite(transaction, validated.identity)
                    : undefined;
            return {
                kind: "completed",
                result: this.persistDecision(
                    transaction,
                    validated.envelope,
                    validated.identity,
                    envelopeDigest,
                    duplicate === undefined ? validated.decision : duplicateDecision(duplicate),
                    at
                )
            };
        }
        const duplicate = this.#persistence.findWrite(transaction, validated.identity);
        if (duplicate !== undefined) {
            return {
                kind: "completed",
                result: this.persistDecision(
                    transaction,
                    validated.envelope,
                    validated.identity,
                    envelopeDigest,
                    duplicateDecision(duplicate),
                    this.timestamp()
                )
            };
        }
        if (this.hasInvalidCallerCause(transaction, validated.envelope)) {
            return {
                kind: "completed",
                result: this.persistDecision(
                    transaction,
                    validated.envelope,
                    validated.identity,
                    envelopeDigest,
                    rejected("rejectedMalformed", false, true),
                    this.timestamp()
                )
            };
        }
        return { kind: "prepare" };
    }

    private dispatchPrepared(
        rawEnvelope: Uint8Array,
        authentication: CommandAuthentication | undefined,
        payload: PreparedCommandPayload
    ): Promise<CommandDispatchResult> {
        return this.execute((transaction) => {
            try {
                return this.dispatchPreparedInTransaction(
                    transaction,
                    rawEnvelope,
                    authentication,
                    payload
                );
            } catch (error) {
                throw rejectForgedCommitUnknown(error);
            }
        });
    }

    private dispatchPreparedInTransaction(
        transaction: Transaction,
        rawEnvelope: Uint8Array,
        authentication: CommandAuthentication | undefined,
        prepared: PreparedCommandPayload
    ): CommandDispatchResult {
        const at = this.timestamp();
        const envelopeDigest = Digest.sha256(rawEnvelope);
        const validated = this.validate(rawEnvelope, envelopeDigest, authentication);
        if (validated instanceof DecisionBeforePreparation) {
            const duplicate =
                validated.decision.reservesIdentity && validated.identity !== undefined
                    ? this.#persistence.findWrite(transaction, validated.identity)
                    : undefined;
            return this.persistDecision(
                transaction,
                validated.envelope,
                validated.identity,
                envelopeDigest,
                duplicate === undefined ? validated.decision : duplicateDecision(duplicate),
                at
            );
        }
        const duplicate = this.#persistence.findWrite(transaction, validated.identity);
        if (duplicate !== undefined) {
            return this.persistDecision(
                transaction,
                validated.envelope,
                validated.identity,
                envelopeDigest,
                duplicateDecision(duplicate),
                at
            );
        }

        const decodedPayload = this.decodePreparedPayload(validated, prepared, envelopeDigest, at);
        if (decodedPayload === invalidPayload) {
            return this.persistDecision(
                transaction,
                validated.envelope,
                validated.identity,
                envelopeDigest,
                rejected("rejectedMalformed", validated.envelope.callerCause !== undefined, true),
                at
            );
        }
        if (this.hasInvalidCallerCause(transaction, validated.envelope)) {
            return this.persistDecision(
                transaction,
                validated.envelope,
                validated.identity,
                envelopeDigest,
                rejected("rejectedMalformed", false, true),
                at
            );
        }
        return this.persistDecision(
            transaction,
            validated.envelope,
            validated.identity,
            envelopeDigest,
            this.decide(transaction, validated, decodedPayload, at),
            at
        );
    }

    private validate(
        rawEnvelope: Uint8Array,
        envelopeDigest: Digest,
        authentication: CommandAuthentication | undefined
    ): ValidatedRequest<Transaction, Read> | DecisionBeforePreparation {
        const envelope = this.decode(rawEnvelope);
        if (envelope === undefined) {
            return new DecisionBeforePreparation(
                undefined,
                undefined,
                rejected("rejectedMalformed")
            );
        }
        const identity: CommandIdentity = {
            caller: envelope.caller,
            idempotencyKey: envelope.idempotencyKey
        };
        if (!commandAuthenticationMatches(authentication, envelopeDigest, envelope, this.#tenant)) {
            return new DecisionBeforePreparation(
                envelope,
                identity,
                rejected("rejectedAuthentication")
            );
        }
        if (
            envelope.caller.kind === "principal" &&
            !envelope.caller.principal.tenantId.equals(this.#tenant)
        ) {
            return new DecisionBeforePreparation(
                envelope,
                identity,
                rejected("rejectedAuthentication")
            );
        }
        const command = this.#commands.get(envelope.command);
        if (
            command === undefined ||
            !revisionFieldIsValid(command.expectedRevision, envelope.expectedRevision)
        ) {
            return new DecisionBeforePreparation(
                envelope,
                identity,
                rejected("rejectedMalformed", false, true)
            );
        }
        if (!command.caller.admits(envelope.caller)) {
            return new DecisionBeforePreparation(
                envelope,
                identity,
                rejected("rejectedAuthentication")
            );
        }
        return { envelope, command, identity };
    }

    private decode(rawEnvelope: Uint8Array): CommandEnvelope | undefined {
        if (rawEnvelope.byteLength > this.#limits.envelopeBytes) return undefined;
        try {
            return CommandEnvelopeCodec.decode(rawEnvelope);
        } catch {
            return undefined;
        }
    }

    private decodePreparedPayload(
        request: ValidatedRequest<Transaction, Read>,
        prepared: PreparedCommandPayload,
        envelopeDigest: Digest,
        now: Date
    ): unknown | typeof invalidPayload {
        const state = inspectPreparedCommandPayload(prepared);
        if (state === undefined) return invalidPayload;
        const { lease, binding } = state;
        if (
            lease === undefined ||
            binding === undefined ||
            !binding.matches(
                this.#tenant,
                this.#actor,
                envelopeDigest,
                request.envelope.payload,
                request.envelope.payloadDigest
            )
        ) {
            return invalidPayload;
        }
        if (!lease.matches(binding, now)) return invalidPayload;
        const bytes = lease.read();
        if (
            bytes.byteLength > this.#limits.payloadBytes ||
            !request.envelope.payload.digest.equals(request.envelope.payloadDigest) ||
            !Digest.sha256(bytes).equals(request.envelope.payloadDigest)
        ) {
            return invalidPayload;
        }
        try {
            return requireSynchronousResult(request.command.payload.decode(bytes.slice()));
        } catch (error) {
            if (error instanceof CommandPayloadMalformedError) return invalidPayload;
            throw error;
        }
    }

    private decide(
        transaction: Transaction,
        request: ValidatedRequest<Transaction, Read>,
        payload: unknown,
        now: Date
    ): Decision {
        const { command, envelope } = request;
        if (!this.booleanGate(transaction, (read) => command.authorize(read, envelope, payload))) {
            return rejected("rejectedAuthority", true);
        }
        if (
            !this.booleanGate(transaction, (read) =>
                command.permitsLifecycle(read, envelope, payload)
            )
        ) {
            return rejected("rejectedLifecycle", true);
        }
        if (!this.revisionMatches(transaction, command, envelope, payload)) {
            return rejected("rejectedRevision", true);
        }
        if (!this.leaseMatches(transaction, command, envelope, payload, now)) {
            return rejected("rejectedLease", true);
        }
        const execution = requireSynchronousResult(
            command.execute(transaction, envelope, payload, now)
        );
        return committedDecision(command, execution);
    }

    private persistDecision(
        transaction: Transaction,
        envelope: CommandEnvelope | undefined,
        identity: CommandIdentity | undefined,
        envelopeDigest: Digest,
        decision: Decision,
        at: Date
    ): CommandDispatchResult {
        const writeId = this.#ids.writeRecordId(transaction);
        const auditId = this.#ids.auditRecordId(transaction);
        const cause =
            !decision.callerCauseEligible || envelope?.callerCause === undefined
                ? undefined
                : this.usableCause(transaction, envelope.callerCause);
        let auditCause = cause?.id;

        if (auditCause === undefined && !isRejected(decision.outcome)) {
            const root = new AuditRecord({
                id: this.#ids.auditRecordId(transaction),
                actor: this.#actor,
                tenant: this.#tenant,
                correlation: this.#ids.correlationId(transaction),
                kind: { kind: "invocation", id: this.#ids.invocationId(transaction) }
            });
            this.appendAudit(transaction, root);
            auditCause = root.id;
        }

        const correlation =
            cause?.correlation ??
            (auditCause === undefined
                ? this.#ids.correlationId(transaction)
                : this.requireAudit(transaction, auditCause).correlation);
        const audit = new AuditRecord({
            id: auditId,
            actor: this.#actor,
            tenant: this.#tenant,
            correlation,
            ...(auditCause === undefined ? {} : { cause: auditCause }),
            kind: { kind: "write", id: writeId, outcome: decision.outcome }
        });
        const admission =
            auditCause === undefined ? ({ kind: "commandRejection" } as const) : undefined;
        this.appendAudit(transaction, audit, admission);

        const hasCanonicalIdentity = identity !== undefined && decision.reservesIdentity;
        const write = new WriteRecord({
            id: writeId,
            actor: this.#actor,
            envelopeDigest,
            ...(envelope === undefined
                ? {}
                : {
                      caller: envelope.caller,
                      command: envelope.command
                  }),
            ...(hasCanonicalIdentity ? { idempotencyKey: identity.idempotencyKey } : {}),
            at,
            outcome: decision.outcome,
            audit: audit.id,
            ...(decision.duplicateOf === undefined ? {} : { duplicateOf: decision.duplicateOf }),
            reply: decision.reply,
            ...(decision.observation === undefined ? {} : { observation: decision.observation })
        });
        this.#persistence.appendWrite(transaction, write);
        return {
            kind: "commandOutcome",
            outcome: decision.outcome,
            reply: write.reply,
            ...(write.observation === undefined ? {} : { observation: write.observation }),
            write
        };
    }

    private hasInvalidCallerCause(transaction: Transaction, envelope: CommandEnvelope): boolean {
        return (
            envelope.callerCause !== undefined &&
            this.usableCause(transaction, envelope.callerCause) === undefined
        );
    }

    private usableCause(transaction: Transaction, id: AuditRecordId): AuditRecord | undefined {
        const cause = this.#persistence.findAudit(transaction, id);
        return cause !== undefined &&
            cause.kind.kind === "invocation" &&
            cause.cause === undefined &&
            cause.actor.equals(this.#actor) &&
            cause.tenant.equals(this.#tenant)
            ? cause
            : undefined;
    }

    private requireAudit(transaction: Transaction, id: AuditRecordId): AuditRecord {
        const record = this.#persistence.findAudit(transaction, id);
        if (record === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Appended audit root is not readable in its transaction"
            );
        }
        return record;
    }

    private appendAudit(
        transaction: Transaction,
        record: AuditRecord,
        admission?: AuditRootAdmission
    ): void {
        const records: AuditRecordLookup = {
            get: (id) => this.#persistence.findAudit(transaction, id)
        };
        validateAuditAppend(record, records, admission);
        this.#persistence.appendAudit(transaction, record, admission);
    }

    private readForGate(transaction: Transaction): Read {
        return this.#store.read(
            transaction,
            this.#readOnly,
            ...([] as SynchronousResultGuard<Read>)
        );
    }

    private booleanGate(transaction: Transaction, evaluate: (read: Read) => boolean): boolean {
        return requireSynchronousResult(evaluate(this.readForGate(transaction))) === true;
    }

    private revisionMatches(
        transaction: Transaction,
        command: RegisteredProtocolCommand<Transaction, Read>,
        envelope: CommandEnvelope,
        payload: unknown
    ): boolean {
        if (envelope.expectedRevision === undefined) return true;
        const current = requireSynchronousResult(
            command.currentRevision(this.readForGate(transaction), envelope, payload)
        );
        return current !== undefined && current.equals(envelope.expectedRevision);
    }

    private leaseMatches(
        transaction: Transaction,
        command: RegisteredProtocolCommand<Transaction, Read>,
        envelope: CommandEnvelope,
        payload: unknown,
        now: Date
    ): boolean {
        if (command.lease === "forbidden") return envelope.lease === undefined;
        if (envelope.lease === undefined) return command.lease === "optional";
        const current = requireSynchronousResult(
            command.currentLease(this.readForGate(transaction), envelope, payload, now)
        );
        const expiresAt = current?.expiresAt?.getTime();
        return (
            current !== undefined &&
            current.turn.equals(envelope.lease.turn) &&
            current.holder !== undefined &&
            current.holder.equals(envelope.lease.holder) &&
            current.epoch === envelope.lease.epoch &&
            expiresAt !== undefined &&
            Number.isFinite(expiresAt) &&
            expiresAt > now.getTime()
        );
    }

    private timestamp(): Date {
        const at = new Date(this.#now());
        if (!Number.isFinite(at.getTime())) {
            throw new AgentCoreError("protocol.invalid-state", "Command timestamp must be valid");
        }
        return at;
    }
}

class DecisionBeforePreparation {
    public constructor(
        public readonly envelope: CommandEnvelope | undefined,
        public readonly identity: CommandIdentity | undefined,
        public readonly decision: Decision
    ) {}
}

type RegisteredProtocolCommand<Transaction, Read> = ProtocolCommand<
    Transaction,
    Read,
    unknown,
    unknown,
    unknown
>;

const invalidPayload = Symbol("invalid command payload");

function duplicateDecision(duplicate: WriteRecord): Decision {
    return {
        outcome: "duplicate",
        reply: duplicate.reply,
        duplicateOf: duplicate.id,
        callerCauseEligible: true,
        reservesIdentity: true
    };
}

function committedDecision(
    command: {
        readonly replyCodec?: ProtocolValueCodec<unknown>;
        readonly observationCodec?: ProtocolValueCodec<unknown>;
    },
    execution: Uint8Array | ProtocolCommandExecution<unknown, unknown>
): Decision {
    if (execution instanceof Uint8Array) {
        return {
            outcome: "committed",
            reply: execution.slice(),
            callerCauseEligible: true,
            reservesIdentity: true
        };
    }
    const typed = requireTypedCommandExecution(command, execution);
    const reply = requireSynchronousResult(typed.replyCodec.encode(typed.execution.reply));
    const observationValue = typed.execution.observation;
    if (observationValue === undefined) {
        return {
            outcome: "committed",
            reply,
            callerCauseEligible: true,
            reservesIdentity: true
        };
    }
    const observationCodec = requireObservationCodec(command);
    return {
        outcome: "committed",
        reply,
        observation: requireSynchronousResult(observationCodec.encode(observationValue)),
        callerCauseEligible: true,
        reservesIdentity: true
    };
}

function rejected(
    outcome: Exclude<CommandOutcome, "committed" | "duplicate">,
    callerCauseEligible = false,
    reservesIdentity = callerCauseEligible
): Decision {
    return {
        outcome,
        reply: encodeCanonicalJson({ outcome }),
        callerCauseEligible,
        reservesIdentity
    };
}

type ActorActivationStoreCapability<Transaction, ReadTransaction> = ActorLocalStore<
    Transaction,
    ReadTransaction
> &
    ActorContext<Transaction>["store"];

function requireTypedCommandExecution(
    command: {
        readonly replyCodec?: ProtocolValueCodec<unknown>;
    },
    execution: unknown
): {
    readonly execution: ProtocolCommandExecution<unknown, unknown>;
    readonly replyCodec: ProtocolValueCodec<unknown>;
} {
    if (
        execution === null ||
        typeof execution !== "object" ||
        !("reply" in execution) ||
        command.replyCodec === undefined
    ) {
        throw new TypeError("Typed command execution requires a reply codec");
    }
    return { execution, replyCodec: command.replyCodec };
}

function requireObservationCodec(command: {
    readonly observationCodec?: ProtocolValueCodec<unknown>;
}): ProtocolValueCodec<unknown> {
    if (command.observationCodec === undefined) {
        throw new TypeError("Typed command observation requires an observation codec");
    }
    return command.observationCodec;
}

function validateCommandActorContext<Transaction, ReadTransaction>(
    actor: ActorRef,
    store: ActorLocalStore<Transaction, ReadTransaction>
): ActorContext<Transaction> {
    if (!isActorActivationStore(store)) {
        throw new TypeError("Command dispatcher requires an Actor activation store");
    }
    return { actor, store };
}

function isActorActivationStore<Transaction, ReadTransaction>(
    store: ActorLocalStore<Transaction, ReadTransaction>
): store is ActorActivationStoreCapability<Transaction, ReadTransaction> {
    return (
        ((typeof store === "object" && store !== null) || typeof store === "function") &&
        "activateActor" in store &&
        typeof store.activateActor === "function"
    );
}

function revisionFieldIsValid(
    policy: ExpectedRevisionPolicy,
    revision: Revision | undefined
): boolean {
    return policy === "required"
        ? revision !== undefined
        : policy !== "forbidden" || revision === undefined;
}

function isRejected(outcome: CommandOutcome): boolean {
    return outcome.startsWith("rejected");
}

function rejectForgedCommitUnknown(error: unknown): unknown {
    return error instanceof CommandCommitUnknownError
        ? new AgentCoreError(
              "protocol.invalid-state",
              "Commit uncertainty cannot originate inside an Actor transaction"
          )
        : error;
}

function validateLimit(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Command ${name} byte limit must be a positive safe integer`);
    }
}

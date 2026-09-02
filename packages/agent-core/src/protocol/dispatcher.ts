import {
    Actor,
    ActorCommitUnknownError,
    isActorActivationStore,
    requireSynchronousResult,
    type ActorContext,
    type ActorLocalStore,
    type ActorRef,
    type SynchronousResultGuard
} from "../actors";
import {
    CodecDeclaration,
    Digest,
    encodeCanonicalJson,
    isObjectRecord,
    type Revision
} from "../core";
import { AgentCoreError } from "../errors";
import type { TenantId } from "../identity";
import {
    AuditRecord,
    CorrelationId,
    type AuditAppendContext,
    type AuditRecordInit,
    type AuditRecordId,
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
import type { ExpectedRevisionPolicy, ProtocolCommand } from "./registration";
import { WriteRecord, type CommandOutcome, type WriteRecordInit } from "./write";

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
    appendAudit(transaction: Transaction, record: AuditRecord, context?: AuditAppendContext): void;
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

interface PreparedDecision {
    decide(): Decision;
}

type WriteRecordDraft = {
    -readonly [Key in keyof WriteRecordInit]: WriteRecordInit[Key];
};

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
        // SAFETY: the canonical issued Actor error now has this subclass prototype and
        // the required retrySameKey own property.
        return canonical as CommandCommitUnknownError;
    }
}

export class CommandPreparationUnavailableError extends AgentCoreError {
    public constructor(message = "Prepared command content is unavailable") {
        super("protocol.invalid-state", message);
        this.name = "CommandPreparationUnavailableError";
    }
}

/**
 * The codec versions a dispatcher owns besides the stable recovery carrier. Actor adds that
 * carrier itself, so no subclass can omit or manually version bootstrap state. Every
 * registered command adds the kinds its own execution writes, so the declaration a reader
 * compares against covers the whole record set the §8.3 gate protects — not just the write
 * and audit records the dispatcher writes itself.
 */
const DISPATCHER_CODECS: CodecDeclaration = CodecDeclaration.of([
    AuditRecord.codec,
    WriteRecord.codec
]);

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
        super(
            context,
            CodecDeclaration.merge([
                DISPATCHER_CODECS,
                ...init.commands.map((command) => command.declaration)
            ]),
            (transaction) => init.persistence.repair?.(transaction)
        );
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
                if (isForgedCommitUnknown(error)) throw invalidCommitUnknownOrigin();
                throw error;
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
                if (isForgedCommitUnknown(error)) throw invalidCommitUnknownOrigin();
                throw error;
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

        const preparedDecision = this.prepareDecision(
            transaction,
            validated,
            prepared,
            envelopeDigest,
            at
        );
        if (preparedDecision === invalidPayload) {
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
            preparedDecision.decide(),
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

    private prepareDecision(
        transaction: Transaction,
        request: ValidatedRequest<Transaction, Read>,
        prepared: PreparedCommandPayload,
        envelopeDigest: Digest,
        now: Date
    ): PreparedDecision | typeof invalidPayload {
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
        const payload = (() => {
            try {
                return requireSynchronousResult(request.command.payload.decode(bytes.slice()));
            } catch (error) {
                if (error instanceof CommandPayloadMalformedError) return invalidPayload;
                throw error;
            }
        })();
        if (payload === invalidPayload) return invalidPayload;
        const { command, envelope } = request;
        return {
            decide: () => {
                if (
                    !this.booleanGate(transaction, (read) =>
                        command.authorize(read, envelope, payload)
                    )
                ) {
                    return rejected("rejectedAuthority", true);
                }
                if (
                    !this.booleanGate(transaction, (read) =>
                        command.permitsLifecycle(read, envelope, payload)
                    )
                ) {
                    return rejected("rejectedLifecycle", true);
                }
                if (envelope.expectedRevision !== undefined) {
                    const current = requireSynchronousResult(
                        command.currentRevision(this.readForGate(transaction), envelope, payload)
                    );
                    if (current === undefined || !current.equals(envelope.expectedRevision)) {
                        return rejected("rejectedRevision", true);
                    }
                }
                if (command.lease === "forbidden") {
                    if (envelope.lease !== undefined) return rejected("rejectedLease", true);
                } else if (envelope.lease === undefined) {
                    if (command.lease !== "optional") return rejected("rejectedLease", true);
                } else {
                    const current = requireSynchronousResult(
                        command.currentLease(this.readForGate(transaction), envelope, payload, now)
                    );
                    const expiresAt = current?.expiresAt?.getTime();
                    if (
                        current === undefined ||
                        !current.turn.equals(envelope.lease.turn) ||
                        current.holder === undefined ||
                        !current.holder.equals(envelope.lease.holder) ||
                        current.epoch !== envelope.lease.epoch ||
                        expiresAt === undefined ||
                        !Number.isFinite(expiresAt) ||
                        expiresAt <= now.getTime()
                    ) {
                        return rejected("rejectedLease", true);
                    }
                }
                const execution = requireSynchronousResult(
                    command.execute(transaction, envelope, payload, now)
                );
                if (execution instanceof Uint8Array) {
                    return {
                        outcome: "committed",
                        reply: execution.slice(),
                        callerCauseEligible: true,
                        reservesIdentity: true
                    };
                }
                if (
                    !isObjectRecord(execution) ||
                    !("reply" in execution) ||
                    command.replyCodec === undefined
                ) {
                    requireTypedCommandExecution();
                }
                const reply = requireSynchronousResult(command.replyCodec.encode(execution.reply));
                if (execution.observation === undefined) {
                    return {
                        outcome: execution.outcome,
                        reply,
                        callerCauseEligible: true,
                        reservesIdentity: true
                    };
                }
                if (command.observationCodec === undefined) {
                    requireObservationCodec();
                }
                return {
                    outcome: execution.outcome,
                    reply,
                    observation: requireSynchronousResult(
                        command.observationCodec.encode(execution.observation)
                    ),
                    callerCauseEligible: true,
                    reservesIdentity: true
                };
            }
        };
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
        const auditInit: AuditRecordInit = {
            id: auditId,
            actor: this.#actor,
            tenant: this.#tenant,
            correlation,
            kind: { kind: "write", id: writeId, outcome: decision.outcome }
        };
        const audit = new AuditRecord(
            auditCause === undefined ? auditInit : { ...auditInit, cause: auditCause }
        );
        const admission =
            auditCause === undefined ? ({ kind: "commandRejection" } as const) : undefined;
        this.appendAudit(transaction, audit, admission);

        const hasCanonicalIdentity = identity !== undefined && decision.reservesIdentity;
        const writeInit: WriteRecordDraft = {
            id: writeId,
            actor: this.#actor,
            envelopeDigest,
            at,
            outcome: decision.outcome,
            audit: audit.id,
            reply: decision.reply
        };
        if (envelope !== undefined) {
            writeInit.caller = envelope.caller;
            writeInit.command = envelope.command;
        }
        if (hasCanonicalIdentity) {
            writeInit.idempotencyKey = identity.idempotencyKey;
        }
        if (decision.duplicateOf !== undefined) {
            writeInit.duplicateOf = decision.duplicateOf;
        }
        if (decision.observation !== undefined) {
            writeInit.observation = decision.observation;
        }
        const write = new WriteRecord(writeInit);
        this.#persistence.appendWrite(transaction, write);
        const result: CommandDispatchResult = {
            kind: "commandOutcome",
            outcome: decision.outcome,
            reply: write.reply,
            write
        };
        return write.observation === undefined
            ? result
            : { ...result, observation: write.observation };
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
        this.#persistence.appendAudit(
            transaction,
            record,
            admission === undefined ? undefined : { rootAdmission: admission }
        );
    }

    private readForGate(transaction: Transaction): Read {
        // SAFETY: the ActorLocalStore contract requires implementations to reject a
        // Promise-like read result; this empty conditional-rest tuple has no runtime value.
        return this.#store.read(
            transaction,
            this.#readOnly,
            ...([] as SynchronousResultGuard<Read>)
        );
    }

    private booleanGate(transaction: Transaction, evaluate: (read: Read) => boolean): boolean {
        return requireSynchronousResult(evaluate(this.readForGate(transaction))) === true;
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

/**
 * A command as the dispatcher holds it. The dispatcher routes payloads and replies
 * through each command's own codecs without ever naming their types, so a registry
 * mixes commands whose request, reply, and observation types differ; the defaults on
 * ProtocolCommand describe one command, never a heterogeneous family.
 */
export type RegisteredProtocolCommand<Transaction, Read> = ProtocolCommand<
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

function requireTypedCommandExecution(): never {
    throw new TypeError("Typed command execution requires a reply codec");
}

function requireObservationCodec(): never {
    throw new TypeError("Typed command observation requires an observation codec");
}

function validateCommandActorContext<Transaction, ReadTransaction>(
    actor: ActorRef,
    store: ActorLocalStore<Transaction, ReadTransaction>
): ActorContext<Transaction> {
    try {
        if (isActorActivationStore(store)) return { actor, store };
    } catch {
        // Invalid host values are rejected through the same constructor contract below.
    }
    throw new TypeError("Command dispatcher requires an Actor activation store");
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

function isForgedCommitUnknown(cause: unknown): cause is CommandCommitUnknownError {
    return cause instanceof CommandCommitUnknownError;
}

function invalidCommitUnknownOrigin(): AgentCoreError {
    return new AgentCoreError(
        "protocol.invalid-state",
        "Commit uncertainty cannot originate inside an Actor transaction"
    );
}

function validateLimit(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Command ${name} byte limit must be a positive safe integer`);
    }
}

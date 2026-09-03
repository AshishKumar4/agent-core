import { ActorId, ActorRef, type ActorKind } from "../actors";
import { TurnId, type LeaseToken } from "../agents";
import {
    ContentRef,
    Digest,
    RecordCodec,
    Revision,
    type JsonValue,
    type RecordVersion,
    TextId
} from "../core";
import { PrincipalId, PrincipalRef, TenantId } from "../identity";
import { AuditRecordId } from "../invocations";
import {
    requireKeys,
    requireNonnegativeInteger,
    requireObject,
    requireString,
    requireStringValue,
    type MutableJsonObject
} from "./codec";

export type { LeaseToken } from "../agents";

export type CommandCaller =
    | { readonly kind: "principal"; readonly principal: PrincipalRef }
    | { readonly kind: "actor"; readonly actor: ActorRef };

export interface CommandEnvelopeInit {
    readonly command: string;
    readonly caller: CommandCaller;
    readonly idempotencyKey: string;
    readonly expectedRevision?: Revision | undefined;
    readonly lease?: LeaseToken | undefined;
    readonly callerCause?: AuditRecordId | undefined;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
}

class CommandEnvelopeCodecV1 extends RecordCodec<CommandEnvelope> {
    public constructor() {
        super(
            [
                CommandEnvelope,
                ActorRef,
                Revision,
                TextId,
                ContentRef,
                Digest,
                ActorId,
                AuditRecordId,
                TenantId,
                TurnId,
                PrincipalId,
                PrincipalRef
            ],
            "command-envelope",
            {
                major: 1,
                minor: 0
            }
        );
    }

    protected encodePayload(envelope: CommandEnvelope): JsonValue {
        const encoded: MutableJsonObject = {
            command: envelope.command,
            caller: encodeCommandCaller(envelope.caller),
            idempotencyKey: envelope.idempotencyKey,
            payload: envelope.payload.value,
            payloadDigest: envelope.payloadDigest.value
        };
        if (envelope.expectedRevision !== undefined) {
            encoded["expectedRevision"] = envelope.expectedRevision.value;
        }
        if (envelope.lease !== undefined) {
            encoded["lease"] = {
                turn: envelope.lease.turn.value,
                holder: {
                    principal: envelope.lease.holder.principalId.value,
                    tenant: envelope.lease.holder.tenantId.value
                },
                epoch: envelope.lease.epoch
            };
        }
        if (envelope.callerCause !== undefined) {
            encoded["callerCause"] = envelope.callerCause.value;
        }
        return encoded;
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): CommandEnvelope {
        const object = requireObject(payload, "Command envelope payload");
        requireKeys(
            object,
            ["command", "caller", "idempotencyKey", "payload", "payloadDigest"],
            ["expectedRevision", "lease", "callerCause"],
            "Command envelope"
        );
        const expectedRevision = object["expectedRevision"];
        const lease = object["lease"];
        const callerCause = object["callerCause"];
        return new CommandEnvelope({
            command: requireString(object, "command"),
            caller: decodeCommandCaller(object["caller"]),
            idempotencyKey: requireString(object, "idempotencyKey"),
            expectedRevision:
                expectedRevision === undefined
                    ? undefined
                    : new Revision(requireNonnegativeInteger(expectedRevision, "expectedRevision")),
            lease: lease === undefined ? undefined : decodeLease(lease),
            callerCause:
                callerCause === undefined
                    ? undefined
                    : new AuditRecordId(requireStringValue(callerCause, "callerCause")),
            payload: new ContentRef(requireString(object, "payload")),
            payloadDigest: new Digest(requireString(object, "payloadDigest"))
        });
    }
}

/** The longest a command name may be; see `MAX_TEXT_VALUE_LENGTH` in core. */
const MAX_COMMAND_NAME_LENGTH = 256;
/**
 * The longest an idempotency key may be. Twice the identifier bound, because a key is
 * composed from a caller's own identifiers rather than being one.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;

export class CommandEnvelope {
    public static get codec(): RecordCodec<CommandEnvelope> {
        return commandEnvelopeCodecInstance;
    }
    public readonly command: string;
    public readonly caller: CommandCaller;
    public readonly idempotencyKey: string;
    public readonly expectedRevision: Revision | undefined;
    public readonly lease: LeaseToken | undefined;
    public readonly callerCause: AuditRecordId | undefined;
    public readonly payload: ContentRef;
    public readonly payloadDigest: Digest;

    public constructor(init: CommandEnvelopeInit) {
        if (
            !isString(init.command) ||
            init.command.length === 0 ||
            init.command.length > MAX_COMMAND_NAME_LENGTH
        ) {
            throw new TypeError(
                `Command name must contain between 1 and ${MAX_COMMAND_NAME_LENGTH} characters`
            );
        }
        if (
            !isString(init.idempotencyKey) ||
            init.idempotencyKey.length === 0 ||
            init.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
        ) {
            throw new TypeError(
                `Command idempotency key must contain between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
            );
        }
        this.command = init.command;
        this.caller = copyCommandCaller(init.caller);
        this.idempotencyKey = init.idempotencyKey;
        this.expectedRevision = init.expectedRevision;
        this.lease = init.lease === undefined ? undefined : copyLeaseToken(init.lease);
        this.callerCause = init.callerCause;
        this.payload = init.payload;
        this.payloadDigest = init.payloadDigest;
        Object.freeze(this);
    }

    public static encode(envelope: CommandEnvelope): Uint8Array {
        return CommandEnvelope.codec.encode(envelope);
    }

    public static decode(bytes: Uint8Array): CommandEnvelope {
        return CommandEnvelope.codec.decode(bytes);
    }
}

const commandEnvelopeCodecInstance = new CommandEnvelopeCodecV1();

export const CommandEnvelopeCodec: RecordCodec<CommandEnvelope> = CommandEnvelope.codec;

export function commandCallersEqual(left: CommandCaller, right: CommandCaller): boolean {
    if (left.kind === "principal" && right.kind === "principal") {
        return left.principal.equals(right.principal);
    }
    return left.kind === "actor" && right.kind === "actor" && left.actor.equals(right.actor);
}

export function copyCommandCaller(caller: CommandCaller): CommandCaller {
    requireCommandCallerContainer(caller);
    if (commandCallerHasKind(caller, "principal")) {
        requirePlainObjectKeys(caller, ["kind", "principal"], "Command caller");
        if (caller.principal instanceof PrincipalRef) {
            return Object.freeze({
                kind: "principal",
                principal: new PrincipalRef(caller.principal.tenantId, caller.principal.principalId)
            });
        }
    } else if (commandCallerHasKind(caller, "actor")) {
        requirePlainObjectKeys(caller, ["kind", "actor"], "Command caller");
        if (caller.actor instanceof ActorRef) {
            return Object.freeze({
                kind: "actor",
                actor: new ActorRef(
                    requireActorKind(caller.actor.kind),
                    new ActorId(caller.actor.id.value)
                )
            });
        }
    }
    throw new TypeError("Command caller is invalid");
}

function requireCommandCallerContainer(caller: CommandCaller): void {
    if (caller === null || Object.getPrototypeOf(caller) !== Object.prototype) {
        throw new TypeError("Command caller must be a plain object with exact fields");
    }
    const descriptor = Object.getOwnPropertyDescriptor(caller, "kind");
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Command caller must contain enumerable data fields");
    }
}

export function encodeCommandCaller(caller: CommandCaller): JsonValue {
    return caller.kind === "principal"
        ? {
              kind: caller.kind,
              principal: {
                  id: caller.principal.principalId.value,
                  tenant: caller.principal.tenantId.value
              }
          }
        : { kind: caller.kind, actor: { kind: caller.actor.kind, id: caller.actor.id.value } };
}

export function decodeCommandCaller(value: JsonValue | undefined): CommandCaller {
    const object = requireObject(value, "Command caller");
    const kind = requireString(object, "kind");
    if (kind === "principal") {
        requireKeys(object, ["kind", "principal"], [], "Command envelope");
        const principal = requireObject(object["principal"], "Command caller principal");
        requireKeys(principal, ["id", "tenant"], [], "Command envelope");
        return {
            kind,
            principal: new PrincipalRef(
                new TenantId(requireString(principal, "tenant")),
                new PrincipalId(requireString(principal, "id"))
            )
        };
    }
    if (kind === "actor") {
        requireKeys(object, ["kind", "actor"], [], "Command envelope");
        const actor = requireObject(object["actor"], "Command caller actor");
        requireKeys(actor, ["kind", "id"], [], "Command envelope");
        return {
            kind,
            actor: new ActorRef(
                requireActorKind(actor["kind"]),
                new ActorId(requireString(actor, "id"))
            )
        };
    }
    throw new TypeError("Command caller kind is invalid");
}

function decodeLease(value: JsonValue): LeaseToken {
    const object = requireObject(value, "Lease token");
    requireKeys(object, ["turn", "holder", "epoch"], [], "Command envelope");
    return {
        turn: new TurnId(requireString(object, "turn")),
        holder: decodePrincipalRef(object["holder"], "Lease holder"),
        epoch: requireNonnegativeInteger(object["epoch"], "epoch")
    };
}

function copyLeaseToken(lease: LeaseToken): LeaseToken {
    requirePlainObjectKeys(lease, ["turn", "holder", "epoch"], "Lease token");
    if (
        !(lease.turn instanceof TurnId) ||
        !(lease.holder instanceof PrincipalRef) ||
        !Number.isSafeInteger(lease.epoch) ||
        lease.epoch < 0
    ) {
        throw new TypeError(
            "Lease token requires a TurnId turn, PrincipalRef holder, and non-negative epoch"
        );
    }
    return Object.freeze({
        turn: new TurnId(lease.turn.value),
        holder: new PrincipalRef(lease.holder.tenantId, lease.holder.principalId),
        epoch: lease.epoch
    });
}

function decodePrincipalRef(value: JsonValue | undefined, name: string): PrincipalRef {
    const object = requireObject(value, name);
    requireKeys(object, ["principal", "tenant"], [], "Command envelope");
    return new PrincipalRef(
        new TenantId(requireString(object, "tenant")),
        new PrincipalId(requireString(object, "principal"))
    );
}

function commandCallerHasKind<Kind extends CommandCaller["kind"]>(
    caller: CommandCaller,
    kind: Kind
): caller is Extract<CommandCaller, { readonly kind: Kind }> {
    if (caller === null || Object.getPrototypeOf(caller) !== Object.prototype) {
        return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(caller, "kind");
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return false;
    }
    return descriptor.value === kind;
}

function requirePlainObjectKeys(
    value: CommandCaller | LeaseToken,
    fields: readonly string[],
    name: string
): void {
    if (value === null || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError(`${name} must be a plain object with exact fields`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) {
        throw new TypeError(`${name} must be a plain object with exact fields`);
    }
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError(`${name} must contain enumerable data fields`);
        }
    }
}

function requireActorKind(value: JsonValue | undefined): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    ) {
        return value;
    }
    throw new TypeError("Command caller actor kind is invalid");
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

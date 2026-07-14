import { ActorId, ActorRef, type ActorKind } from "../actors";
import { TurnId } from "../agents";
import {
    ContentRef,
    Digest,
    RecordCodec,
    Revision,
    type JsonValue,
    type RecordVersion
} from "../core";
import { PrincipalId, PrincipalRef, TenantId } from "../identity";
import { AuditRecordId } from "../invocations";

export interface LeaseToken {
    readonly turn: TurnId;
    readonly holder: PrincipalRef;
    readonly epoch: number;
}

export type CommandCaller =
    | { readonly kind: "principal"; readonly principal: PrincipalRef }
    | { readonly kind: "actor"; readonly actor: ActorRef };

export interface CommandEnvelopeInit {
    readonly command: string;
    readonly caller: CommandCaller;
    readonly idempotencyKey: string;
    readonly expectedRevision?: Revision;
    readonly lease?: LeaseToken;
    readonly callerCause?: AuditRecordId;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
}

class CommandEnvelopeCodecV1 extends RecordCodec<CommandEnvelope> {
    public constructor() {
        super("command-envelope", { major: 1, minor: 0 });
    }

    protected encodePayload(envelope: CommandEnvelope): JsonValue {
        return {
            command: envelope.command,
            caller: encodeCommandCaller(envelope.caller),
            idempotencyKey: envelope.idempotencyKey,
            ...(envelope.expectedRevision === undefined
                ? {}
                : { expectedRevision: envelope.expectedRevision.value }),
            ...(envelope.lease === undefined
                ? {}
                : {
                      lease: {
                          turn: envelope.lease.turn.value,
                          holder: {
                              principal: envelope.lease.holder.principalId.value,
                              tenant: envelope.lease.holder.tenantId.value
                          },
                          epoch: envelope.lease.epoch
                      }
                  }),
            ...(envelope.callerCause === undefined
                ? {}
                : { callerCause: envelope.callerCause.value }),
            payload: envelope.payload.value,
            payloadDigest: envelope.payloadDigest.value
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): CommandEnvelope {
        const object = requireObject(payload, "Command envelope payload");
        requireKeys(
            object,
            ["command", "caller", "idempotencyKey", "payload", "payloadDigest"],
            ["expectedRevision", "lease", "callerCause"]
        );
        const expectedRevision = object["expectedRevision"];
        const lease = object["lease"];
        const callerCause = object["callerCause"];
        return new CommandEnvelope({
            command: requireString(object, "command"),
            caller: decodeCommandCaller(object["caller"]),
            idempotencyKey: requireString(object, "idempotencyKey"),
            ...(expectedRevision === undefined
                ? {}
                : {
                      expectedRevision: new Revision(
                          requireSafeInteger(expectedRevision, "expectedRevision")
                      )
                  }),
            ...(lease === undefined ? {} : { lease: decodeLease(lease) }),
            ...(callerCause === undefined
                ? {}
                : {
                      callerCause: new AuditRecordId(requireStringValue(callerCause, "callerCause"))
                  }),
            payload: new ContentRef(requireString(object, "payload")),
            payloadDigest: new Digest(requireString(object, "payloadDigest"))
        });
    }
}

export class CommandEnvelope {
    public static readonly codec: RecordCodec<CommandEnvelope> = new CommandEnvelopeCodecV1();
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
            typeof init.command !== "string" ||
            init.command.length === 0 ||
            init.command.length > 256
        ) {
            throw new TypeError("Command name must contain between 1 and 256 characters");
        }
        if (
            typeof init.idempotencyKey !== "string" ||
            init.idempotencyKey.length === 0 ||
            init.idempotencyKey.length > 512
        ) {
            throw new TypeError(
                "Command idempotency key must contain between 1 and 512 characters"
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

export const CommandEnvelopeCodec: RecordCodec<CommandEnvelope> = CommandEnvelope.codec;

export function commandCallersEqual(left: CommandCaller, right: CommandCaller): boolean {
    if (left.kind === "principal" && right.kind === "principal") {
        return left.principal.equals(right.principal);
    }
    return left.kind === "actor" && right.kind === "actor" && left.actor.equals(right.actor);
}

export function copyCommandCaller(caller: CommandCaller): CommandCaller {
    const callerKind = requirePlainDataValue(caller, "kind", "Command caller");
    const [kind, identity] = requireExactPlainData(
        caller,
        callerKind === "principal" ? ["kind", "principal"] : ["kind", "actor"],
        "Command caller"
    );
    if (kind === "principal" && identity instanceof PrincipalRef) {
        return Object.freeze({
            kind,
            principal: new PrincipalRef(identity.tenantId, identity.principalId)
        });
    }
    if (kind === "actor" && identity instanceof ActorRef) {
        return Object.freeze({
            kind,
            actor: new ActorRef(requireActorKind(identity.kind), new ActorId(identity.id.value))
        });
    }
    throw new TypeError("Command caller is invalid");
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
        requireKeys(object, ["kind", "principal"], []);
        const principal = requireObject(object["principal"], "Command caller principal");
        requireKeys(principal, ["id", "tenant"], []);
        return {
            kind,
            principal: new PrincipalRef(
                new TenantId(requireString(principal, "tenant")),
                new PrincipalId(requireString(principal, "id"))
            )
        };
    }
    if (kind === "actor") {
        requireKeys(object, ["kind", "actor"], []);
        const actor = requireObject(object["actor"], "Command caller actor");
        requireKeys(actor, ["kind", "id"], []);
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
    requireKeys(object, ["turn", "holder", "epoch"], []);
    return {
        turn: new TurnId(requireString(object, "turn")),
        holder: decodePrincipalRef(object["holder"], "Lease holder"),
        epoch: requireSafeInteger(object["epoch"], "epoch")
    };
}

function copyLeaseToken(lease: LeaseToken): LeaseToken {
    const [turn, holder, epoch] = requireExactPlainData(
        lease,
        ["turn", "holder", "epoch"],
        "Lease token"
    );
    if (
        !(turn instanceof TurnId) ||
        !(holder instanceof PrincipalRef) ||
        typeof epoch !== "number" ||
        !Number.isSafeInteger(epoch) ||
        epoch < 0
    ) {
        throw new TypeError("Lease token is invalid");
    }
    return Object.freeze({
        turn: new TurnId(turn.value),
        holder: new PrincipalRef(holder.tenantId, holder.principalId),
        epoch
    });
}

function decodePrincipalRef(value: JsonValue | undefined, name: string): PrincipalRef {
    const object = requireObject(value, name);
    requireKeys(object, ["principal", "tenant"], []);
    return new PrincipalRef(
        new TenantId(requireString(object, "tenant")),
        new PrincipalId(requireString(object, "principal"))
    );
}

function requireExactPlainData(
    value: unknown,
    fields: readonly string[],
    name: string
): readonly unknown[] {
    if (
        value === null ||
        typeof value !== "object" ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new TypeError(`${name} must be a plain object with exact fields`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) {
        throw new TypeError(`${name} must be a plain object with exact fields`);
    }
    return fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError(`${name} must contain enumerable data fields`);
        }
        return descriptor.value as unknown;
    });
}

function requirePlainDataValue(value: unknown, field: string, name: string): unknown {
    if (
        value === null ||
        typeof value !== "object" ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new TypeError(`${name} must be a plain object with exact fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${name} must contain enumerable data fields`);
    }
    return descriptor.value as unknown;
}

function requireObject(
    value: JsonValue | undefined,
    name: string
): { readonly [key: string]: JsonValue } {
    if (
        value === undefined ||
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
    ) {
        throw new TypeError(`${name} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireKeys(
    object: { readonly [key: string]: JsonValue },
    required: readonly string[],
    optional: readonly string[]
): void {
    const admitted = new Set([...required, ...optional]);
    if (
        required.some((key) => !(key in object)) ||
        Object.keys(object).some((key) => !admitted.has(key))
    ) {
        throw new TypeError("Command envelope contains missing or unknown fields");
    }
}

function requireString(object: { readonly [key: string]: JsonValue }, key: string): string {
    return requireStringValue(object[key], key);
}

function requireStringValue(value: JsonValue | undefined, name: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${name} must be a string`);
    }
    return value;
}

function requireSafeInteger(value: JsonValue | undefined, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    return value;
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

import { ActorId, ActorRef, type ActorKind } from "../actors";
import {
    Digest,
    RecordCodec,
    decodeBase64,
    encodeBase64,
    hasExactJsonKeys,
    type JsonValue,
    type RecordVersion
} from "../core";
import { AuditRecordId, WriteRecordId } from "../invocations";
import {
    decodeCommandCaller,
    encodeCommandCaller,
    copyCommandCaller,
    type CommandCaller
} from "./envelope";

export type CommandOutcome =
    | "committed"
    | "rejectedMalformed"
    | "rejectedAuthentication"
    | "rejectedAuthority"
    | "rejectedLifecycle"
    | "rejectedRevision"
    | "rejectedLease"
    | "duplicate";

class WriteRecordCodecV2 extends RecordCodec<WriteRecord> {
    public constructor() {
        super("write-record", { major: 2, minor: 0 });
    }

    protected encodePayload(record: WriteRecord): JsonValue {
        return {
            id: record.id.value,
            actor: { kind: record.actor.kind, id: record.actor.id.value },
            envelopeDigest: record.envelopeDigest.value,
            caller: record.caller === undefined ? null : encodeCommandCaller(record.caller),
            command: record.command ?? null,
            idempotencyKey: record.idempotencyKey ?? null,
            at: record.at.toISOString(),
            outcome: record.outcome,
            audit: record.audit.value,
            duplicateOf: record.duplicateOf?.value ?? null,
            reply: encodeBase64(record.reply),
            observation: record.observation === undefined ? null : encodeBase64(record.observation)
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): WriteRecord {
        const object = requireObject(payload, "Write record payload");
        const actor = requireObject(object["actor"], "Write record actor");
        if (
            !hasExactJsonKeys(object, [
                "actor",
                "at",
                "audit",
                "caller",
                "command",
                "duplicateOf",
                "envelopeDigest",
                "id",
                "idempotencyKey",
                "observation",
                "outcome",
                "reply"
            ]) ||
            !hasExactJsonKeys(actor, ["id", "kind"])
        ) {
            throw new TypeError("Write record payload contains missing or unknown fields");
        }
        const caller = object["caller"];
        const command = object["command"];
        const duplicateOf = object["duplicateOf"];
        const idempotencyKey = object["idempotencyKey"];
        const observation = object["observation"];
        requireNullableString(command, "Write record command");
        requireNullableString(duplicateOf, "Write record duplicate");
        requireNullableString(idempotencyKey, "Write record idempotency key");
        requireNullableString(observation, "Write record observation");
        return new WriteRecord({
            id: new WriteRecordId(requireString(object, "id")),
            actor: new ActorRef(
                requireActorKind(actor["kind"]),
                new ActorId(requireString(actor, "id"))
            ),
            envelopeDigest: new Digest(requireString(object, "envelopeDigest")),
            ...(caller === null ? {} : { caller: decodeCommandCaller(caller) }),
            ...(command === null ? {} : { command }),
            ...(idempotencyKey === null ? {} : { idempotencyKey }),
            at: new Date(requireString(object, "at")),
            outcome: requireOutcome(object["outcome"]),
            audit: new AuditRecordId(requireString(object, "audit")),
            ...(duplicateOf === null ? {} : { duplicateOf: new WriteRecordId(duplicateOf) }),
            reply: decodeBase64(requireString(object, "reply")),
            ...(observation === null ? {} : { observation: decodeBase64(observation) })
        });
    }
}

export interface WriteRecordInit {
    readonly id: WriteRecordId;
    readonly actor: ActorRef;
    readonly envelopeDigest: Digest;
    readonly caller?: CommandCaller;
    readonly command?: string;
    readonly idempotencyKey?: string;
    readonly at: Date;
    readonly outcome: CommandOutcome;
    readonly audit: AuditRecordId;
    readonly duplicateOf?: WriteRecordId;
    readonly reply: Uint8Array;
    readonly observation?: Uint8Array;
}

export class WriteRecord {
    readonly #atTime: number;
    readonly #reply: Uint8Array;
    readonly #observation: Uint8Array | undefined;
    public static readonly codec: RecordCodec<WriteRecord> = new WriteRecordCodecV2();

    public readonly id: WriteRecordId;
    public readonly actor: ActorRef;
    public readonly envelopeDigest: Digest;
    public readonly caller: CommandCaller | undefined;
    public readonly command: string | undefined;
    public readonly idempotencyKey: string | undefined;
    public readonly outcome: CommandOutcome;
    public readonly audit: AuditRecordId;
    public readonly duplicateOf: WriteRecordId | undefined;

    public constructor(init: WriteRecordInit) {
        const atTime = init.at.getTime();
        if (!Number.isFinite(atTime)) {
            throw new TypeError("Write record time must be valid");
        }
        if (init.outcome === "duplicate" && init.duplicateOf === undefined) {
            throw new TypeError("Duplicate write records must identify the original write");
        }
        if (init.outcome !== "duplicate" && init.duplicateOf !== undefined) {
            throw new TypeError("Only duplicate write records may identify an original write");
        }
        if (
            (init.caller === undefined || init.command === undefined) &&
            init.outcome !== "rejectedMalformed"
        ) {
            throw new TypeError("Only malformed writes may omit decoded envelope fields");
        }
        if (
            init.idempotencyKey !== undefined &&
            (init.idempotencyKey.length === 0 || init.idempotencyKey.length > 512)
        ) {
            throw new TypeError("Write idempotency key must contain between 1 and 512 characters");
        }
        const requiresIdentity =
            init.outcome !== "rejectedMalformed" && init.outcome !== "rejectedAuthentication";
        if (
            (requiresIdentity && init.idempotencyKey === undefined) ||
            (init.outcome === "rejectedAuthentication" && init.idempotencyKey !== undefined)
        ) {
            throw new TypeError("Write idempotency key does not match its outcome");
        }
        if (
            init.idempotencyKey !== undefined &&
            (init.caller === undefined || init.command === undefined)
        ) {
            throw new TypeError("Write idempotency keys require decoded envelope fields");
        }
        if (init.observation !== undefined && init.outcome !== "committed") {
            throw new TypeError("Only committed writes may contain an observation");
        }
        this.id = init.id;
        this.actor = init.actor;
        this.envelopeDigest = init.envelopeDigest;
        this.caller = init.caller === undefined ? undefined : copyCommandCaller(init.caller);
        this.command = init.command;
        this.idempotencyKey = init.idempotencyKey;
        this.#atTime = atTime;
        this.outcome = init.outcome;
        this.audit = init.audit;
        this.duplicateOf = init.duplicateOf;
        this.#reply = init.reply.slice();
        this.#observation = init.observation?.slice();
        Object.freeze(this);
    }

    public static encode(record: WriteRecord): Uint8Array {
        return WriteRecord.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): WriteRecord {
        return WriteRecord.codec.decode(bytes);
    }

    public get at(): Date {
        return new Date(this.#atTime);
    }

    public get reply(): Uint8Array {
        return this.#reply.slice();
    }

    public get observation(): Uint8Array | undefined {
        return this.#observation?.slice();
    }
}

export const WriteRecordCodec: RecordCodec<WriteRecord> = WriteRecord.codec;

export function writeReservesIdentity(record: WriteRecord): boolean {
    return (
        record.idempotencyKey !== undefined &&
        record.outcome !== "duplicate" &&
        record.outcome !== "rejectedAuthentication"
    );
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

function requireString(object: { readonly [key: string]: JsonValue }, key: string): string {
    const value = object[key];
    if (typeof value !== "string") {
        throw new TypeError(`${key} must be a string`);
    }
    return value;
}

function requireNullableString(
    value: JsonValue | undefined,
    name: string
): asserts value is string | null {
    if (value !== null && typeof value !== "string") {
        throw new TypeError(`${name} must be a string or null`);
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
    throw new TypeError("Write record actor kind is invalid");
}

function requireOutcome(value: JsonValue | undefined): CommandOutcome {
    if (
        value === "committed" ||
        value === "rejectedMalformed" ||
        value === "rejectedAuthentication" ||
        value === "rejectedAuthority" ||
        value === "rejectedLifecycle" ||
        value === "rejectedRevision" ||
        value === "rejectedLease" ||
        value === "duplicate"
    ) {
        return value;
    }
    throw new TypeError("Write record outcome is invalid");
}

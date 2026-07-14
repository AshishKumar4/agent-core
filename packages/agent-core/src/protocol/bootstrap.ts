import { ActorId, type ActorRef } from "../actors";
import {
    RecordCodec,
    decodeBase64,
    decodeCanonicalJson,
    encodeBase64,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue,
    type Revision
} from "../core";
import { PrincipalId, PrincipalRef, TenantId, type TenantKind } from "../identity";
import { AgentCoreError } from "../errors";
import type { CurrentLease, ProtocolCommand } from "./dispatcher";
import type { CommandEnvelope } from "./envelope";
import { CommandPayloadMalformedError, type CommandPayloadCodec } from "./payload";
import { CommandCallerPolicy } from "./policy";
import type { ProtocolCommandExecution, ProtocolValueCodec } from "./registration";

export interface TenantBootstrapAnchor {
    readonly actorId: ActorId;
    readonly tenantId: TenantId;
    readonly principalId: PrincipalId;
    readonly trustAnchor: Uint8Array;
    readonly tenantKind?: TenantKind;
}

class TenantBootstrapAnchorCodec extends RecordCodec<TenantBootstrapAnchorRecord> {
    public constructor() {
        super("protocol.tenant-bootstrap-anchor", { major: 1, minor: 0 });
    }

    protected encodePayload(anchor: TenantBootstrapAnchorRecord): JsonValue {
        return {
            actorId: anchor.actorId.value,
            principalId: anchor.principalId.value,
            tenantId: anchor.tenantId.value,
            tenantKind: anchor.tenantKind,
            trustAnchor: encodeBase64(anchor.trustAnchor)
        };
    }

    protected decodePayload(payload: JsonValue): TenantBootstrapAnchorRecord {
        if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
            throw new TypeError("Tenant bootstrap anchor payload is malformed");
        }
        const object = payload as { readonly [key: string]: JsonValue };
        if (
            !hasExactJsonKeys(object, [
                "actorId",
                "principalId",
                "tenantId",
                "tenantKind",
                "trustAnchor"
            ])
        ) {
            throw new TypeError("Tenant bootstrap anchor payload is malformed");
        }
        const actorId = object["actorId"];
        const principalId = object["principalId"];
        const tenantId = object["tenantId"];
        const tenantKind = object["tenantKind"];
        const trustAnchor = object["trustAnchor"];
        if (
            typeof actorId !== "string" ||
            typeof principalId !== "string" ||
            typeof tenantId !== "string" ||
            typeof trustAnchor !== "string" ||
            !isTenantKind(tenantKind)
        ) {
            throw new TypeError("Tenant bootstrap anchor payload is malformed");
        }
        return new TenantBootstrapAnchorRecord({
            actorId: new ActorId(actorId),
            principalId: new PrincipalId(principalId),
            tenantId: new TenantId(tenantId),
            tenantKind,
            trustAnchor: decodeBase64(trustAnchor)
        });
    }
}

export class TenantBootstrapAnchorRecord implements TenantBootstrapAnchor {
    public static readonly codec: RecordCodec<TenantBootstrapAnchorRecord> =
        new TenantBootstrapAnchorCodec();
    public readonly actorId: ActorId;
    public readonly tenantId: TenantId;
    public readonly principalId: PrincipalId;
    public readonly tenantKind: TenantKind;
    readonly #trustAnchor: Uint8Array;

    public constructor(anchor: TenantBootstrapAnchor) {
        if (
            !(anchor.actorId instanceof ActorId) ||
            !(anchor.trustAnchor instanceof Uint8Array) ||
            anchor.trustAnchor.byteLength === 0
        ) {
            throw new TypeError("Tenant bootstrap anchor is malformed");
        }
        this.actorId = anchor.actorId;
        this.tenantId = anchor.tenantId;
        this.principalId = anchor.principalId;
        this.#trustAnchor = anchor.trustAnchor.slice();
        this.tenantKind = anchor.tenantKind ?? "personal";
        Object.freeze(this);
    }

    public static encode(anchor: TenantBootstrapAnchorRecord): Uint8Array {
        return TenantBootstrapAnchorRecord.codec.encode(anchor);
    }

    public static decode(bytes: Uint8Array): TenantBootstrapAnchorRecord {
        return TenantBootstrapAnchorRecord.codec.decode(bytes);
    }

    public get trustAnchor(): Uint8Array {
        return this.#trustAnchor.slice();
    }
}

// Structural by design: protocol cannot import concrete substrate stores without a cycle.
// Implementations expose one high-level atomic operation, never constituent record writers.
interface TenantBootstrapStore<Transaction, Read> {
    anchor(read: Read): TenantBootstrapAnchor | undefined;
    anchorInTransaction(transaction: Transaction): TenantBootstrapAnchor | undefined;
    eligible(read: Read, anchor: TenantBootstrapAnchor): boolean;
    currentRevision(read: Read, anchor: TenantBootstrapAnchor): Revision;
    bootstrapTenant(
        transaction: Transaction,
        anchor: TenantBootstrapAnchorRecord,
        expectedRevision: Revision
    ): void;
}

export interface TenantBootstrapTarget {
    readonly actor: ActorRef;
    readonly tenantId: TenantId;
}

export interface TenantBootstrapReply {
    readonly owner: PrincipalRef;
    readonly tenant: TenantId;
}

export interface TenantBootstrapObservation {
    readonly at: Date;
    readonly owner: PrincipalRef;
    readonly tenant: TenantId;
}

type EmptyBootstrapPayload = Readonly<Record<string, never>>;

class TenantBootstrapCommand<Transaction, Read> implements ProtocolCommand<
    Transaction,
    Read,
    EmptyBootstrapPayload,
    TenantBootstrapReply,
    TenantBootstrapObservation
> {
    public readonly command = "tenant.bootstrap";
    public readonly caller = CommandCallerPolicy.principal();
    public readonly expectedRevision = "required" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload: CommandPayloadCodec<EmptyBootstrapPayload> =
        emptyBootstrapPayloadCodec;
    public readonly replyCodec: ProtocolValueCodec<TenantBootstrapReply> = bootstrapReplyCodec;
    public readonly observationCodec: ProtocolValueCodec<TenantBootstrapObservation> =
        bootstrapObservationCodec;

    public constructor(
        private readonly backend: TenantBootstrapStore<Transaction, Read>,
        private readonly target: TenantBootstrapTarget
    ) {
        if (target.actor.kind !== "tenant") {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap must target a Tenant Actor"
            );
        }
    }

    public authorize(read: Read, envelope: CommandEnvelope): boolean {
        const anchor = this.backend.anchor(read);
        return (
            anchor !== undefined &&
            anchorMatchesTarget(anchor, this.target) &&
            envelope.caller.kind === "principal" &&
            envelope.caller.principal.equals(principalFor(anchor))
        );
    }

    public permitsLifecycle(read: Read): boolean {
        const anchor = this.backend.anchor(read);
        return (
            anchor !== undefined &&
            anchorMatchesTarget(anchor, this.target) &&
            this.backend.eligible(read, anchor)
        );
    }

    public currentRevision(read: Read): Revision | undefined {
        const anchor = this.backend.anchor(read);
        return anchor === undefined ? undefined : this.backend.currentRevision(read, anchor);
    }

    public currentLease(
        _read: Read,
        _envelope: CommandEnvelope,
        _payload: EmptyBootstrapPayload,
        _at: Date
    ): CurrentLease | undefined {
        return undefined;
    }

    public execute(
        transaction: Transaction,
        envelope: CommandEnvelope,
        _payload: EmptyBootstrapPayload,
        at: Date
    ): ProtocolCommandExecution<TenantBootstrapReply, TenantBootstrapObservation> {
        const anchor = this.backend.anchorInTransaction(transaction);
        const expectedRevision = envelope.expectedRevision;
        if (
            anchor === undefined ||
            expectedRevision === undefined ||
            !anchorMatchesTarget(anchor, this.target) ||
            envelope.caller.kind !== "principal" ||
            !envelope.caller.principal.equals(principalFor(anchor))
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap anchor disappeared during dispatch"
            );
        }
        const verifiedAnchor = new TenantBootstrapAnchorRecord(anchor);
        this.backend.bootstrapTenant(transaction, verifiedAnchor, expectedRevision);
        const reply = Object.freeze({
            owner: principalFor(verifiedAnchor),
            tenant: verifiedAnchor.tenantId
        });
        return {
            reply,
            observation: Object.freeze({ ...reply, at: new Date(at) })
        };
    }
}

export function tenantBootstrapPayload(): Uint8Array {
    return encodeCanonicalJson({});
}

class EmptyBootstrapPayloadCodec implements CommandPayloadCodec<EmptyBootstrapPayload> {
    public decode(bytes: Uint8Array): EmptyBootstrapPayload {
        const value = decodeCanonicalJson(bytes);
        if (value === null || Array.isArray(value) || typeof value !== "object") {
            throw new CommandPayloadMalformedError(
                "Tenant bootstrap payload must be an empty object"
            );
        }
        const object = value as { readonly [key: string]: never };
        if (!hasExactJsonKeys(object, [])) {
            throw new CommandPayloadMalformedError(
                "Tenant bootstrap payload must be an empty object"
            );
        }
        return Object.freeze({});
    }
}

const emptyBootstrapPayloadCodec = new EmptyBootstrapPayloadCodec();

export function createTenantBootstrapCommand<Transaction, Read>(
    store: TenantBootstrapStore<Transaction, Read>,
    target: TenantBootstrapTarget
): ProtocolCommand<
    Transaction,
    Read,
    EmptyBootstrapPayload,
    TenantBootstrapReply,
    TenantBootstrapObservation
> {
    return new TenantBootstrapCommand(store, target);
}

class TenantBootstrapReplyCodec implements ProtocolValueCodec<TenantBootstrapReply> {
    public encode(reply: TenantBootstrapReply): Uint8Array {
        return encodeCanonicalJson({
            owner: {
                principal: reply.owner.principalId.value,
                tenant: reply.owner.tenantId.value
            },
            tenant: reply.tenant.value
        });
    }

    public decode(bytes: Uint8Array): TenantBootstrapReply {
        const object = requireObject(decodeCanonicalJson(bytes), "Tenant bootstrap reply");
        if (!hasExactJsonKeys(object, ["owner", "tenant"])) {
            throw new TypeError("Tenant bootstrap reply is malformed");
        }
        const owner = requireObject(object["owner"], "Tenant bootstrap owner");
        if (!hasExactJsonKeys(owner, ["principal", "tenant"])) {
            throw new TypeError("Tenant bootstrap owner is malformed");
        }
        return Object.freeze({
            owner: new PrincipalRef(
                new TenantId(requireString(owner["tenant"], "Tenant bootstrap owner Tenant")),
                new PrincipalId(requireString(owner["principal"], "Tenant bootstrap owner"))
            ),
            tenant: new TenantId(requireString(object["tenant"], "Tenant bootstrap Tenant"))
        });
    }
}

class TenantBootstrapObservationCodec implements ProtocolValueCodec<TenantBootstrapObservation> {
    public encode(observation: TenantBootstrapObservation): Uint8Array {
        return encodeCanonicalJson({
            at: observation.at.toISOString(),
            reply: encodeBase64(bootstrapReplyCodec.encode(observation))
        });
    }

    public decode(bytes: Uint8Array): TenantBootstrapObservation {
        const object = requireObject(decodeCanonicalJson(bytes), "Tenant bootstrap observation");
        if (!hasExactJsonKeys(object, ["at", "reply"])) {
            throw new TypeError("Tenant bootstrap observation is malformed");
        }
        const at = new Date(requireString(object["at"], "Tenant bootstrap observation time"));
        if (!Number.isFinite(at.getTime())) {
            throw new TypeError("Tenant bootstrap observation time is invalid");
        }
        return Object.freeze({
            ...bootstrapReplyCodec.decode(
                decodeBase64(requireString(object["reply"], "Tenant bootstrap observation reply"))
            ),
            at
        });
    }
}

const bootstrapReplyCodec = new TenantBootstrapReplyCodec();
const bootstrapObservationCodec = new TenantBootstrapObservationCodec();

function anchorMatchesTarget(
    anchor: TenantBootstrapAnchor,
    target: TenantBootstrapTarget
): boolean {
    return anchor.actorId.equals(target.actor.id) && anchor.tenantId.equals(target.tenantId);
}

function principalFor(anchor: TenantBootstrapAnchor): PrincipalRef {
    return new PrincipalRef(anchor.tenantId, anchor.principalId);
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

function requireString(value: JsonValue | undefined, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string`);
    }
    return value;
}

function isTenantKind(value: JsonValue | undefined): value is TenantKind {
    return value === "personal" || value === "organization" || value === "service";
}

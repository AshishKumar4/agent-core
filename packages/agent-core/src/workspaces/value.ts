import type { ActorRef } from "../actors";
import {
    RecordCodec,
    encodeCanonicalJson,
    decodeCanonicalJson,
    hasExactJsonKeys,
    type RecordVersion,
    type JsonValue
} from "../core";
import type { BindingName, FacetPackageId, TrustTier } from "../facets";
import { PrincipalRef, type TenantId } from "../identity";
import { decodeOptionalPrincipalRef, encodeOptionalPrincipalRef } from "./codec";

export type EventSource =
    | { readonly kind: "facet"; readonly facet: FacetPackageId }
    | { readonly kind: "actor"; readonly actor: ActorRef };

export abstract class EventVerification {
    public static verified(): EventVerification {
        return verifiedEvent;
    }

    public static host(): EventVerification {
        return hostEvent;
    }

    public abstract readonly kind: "verified" | "host";

    public equals(other: EventVerification): boolean {
        return this.kind === other.kind;
    }
}

class VerifiedEvent extends EventVerification {
    public readonly kind = "verified" as const;
}

class HostEvent extends EventVerification {
    public readonly kind = "host" as const;
}

const verifiedEvent = Object.freeze(new VerifiedEvent());
const hostEvent = Object.freeze(new HostEvent());

export interface EventProvenanceInit {
    readonly verification: EventVerification;
    readonly principal?: PrincipalRef;
    readonly channel?: string;
    readonly group?: string;
    readonly claims?: JsonValue;
}

class EventProvenanceCodecV1 extends RecordCodec<EventProvenance> {
    public constructor() {
        super("workspace.event-provenance", { major: 1, minor: 0 });
    }

    protected encodePayload(provenance: EventProvenance): JsonValue {
        return provenance.toData();
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): EventProvenance {
        return EventProvenance.fromData(payload);
    }
}

export class EventProvenance {
    public static readonly codec: RecordCodec<EventProvenance> = new EventProvenanceCodecV1();
    public readonly verification: EventVerification;
    public readonly principal: PrincipalRef | undefined;
    public readonly channel: string | undefined;
    public readonly group: string | undefined;
    public readonly claims: JsonValue;

    public constructor(init: EventProvenanceInit) {
        this.verification =
            init.verification.kind === "host"
                ? EventVerification.host()
                : EventVerification.verified();
        this.principal = init.principal;
        this.channel = validateOptionalCanonicalText(init.channel, "Provenance channel");
        this.group = validateOptionalCanonicalText(init.group, "Provenance group");
        this.claims = canonicalJson(init.claims ?? {});
        Object.freeze(this);
    }

    public static encode(provenance: EventProvenance): Uint8Array {
        return EventProvenance.codec.encode(provenance);
    }

    public static decode(bytes: Uint8Array): EventProvenance {
        return EventProvenance.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): EventProvenance {
        if (
            value === null ||
            Array.isArray(value) ||
            typeof value !== "object" ||
            !hasExactJsonKeys(value as { readonly [key: string]: JsonValue }, [
                "channel",
                "claims",
                "group",
                "principal",
                "verification"
            ])
        ) {
            throw new TypeError("Event provenance payload is malformed");
        }
        const object = value as { readonly [key: string]: JsonValue };
        const verification = object["verification"];
        const principal = object["principal"];
        const channel = object["channel"];
        const group = object["group"];
        if (
            (verification !== "verified" && verification !== "host") ||
            (channel !== null && typeof channel !== "string") ||
            (group !== null && typeof group !== "string")
        ) {
            throw new TypeError("Event provenance fields are malformed");
        }
        return new EventProvenance({
            verification:
                verification === "host" ? EventVerification.host() : EventVerification.verified(),
            ...(principal === null
                ? {}
                : { principal: decodeOptionalPrincipalRef(principal, "Provenance Principal")! }),
            ...(channel === null ? {} : { channel }),
            ...(group === null ? {} : { group }),
            claims: object["claims"]!
        });
    }

    public toData(): JsonValue {
        return {
            verification: this.verification.kind,
            principal: encodeOptionalPrincipalRef(this.principal),
            channel: this.channel ?? null,
            group: this.group ?? null,
            claims: this.claims
        };
    }
}

export type RouteAuthority =
    | { readonly kind: "initiator"; readonly binding: BindingName }
    | { readonly kind: "delegated"; readonly binding: BindingName };

export type TenantRelation =
    | { readonly kind: "same"; readonly tenant: TenantId }
    | {
          readonly kind: "cross";
          readonly source: TenantId;
          readonly target: TenantId;
          readonly authority: BindingName;
      };

export interface DerivedEventTrust {
    readonly tier: TrustTier;
    readonly initiator?: PrincipalRef;
}

export function canonicalJson(value: JsonValue): JsonValue {
    return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
}

function deepFreeze(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        for (const entry of value) deepFreeze(entry);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) deepFreeze(entry);
        return Object.freeze(value);
    }
    return value;
}

function validateOptionalCanonicalText(
    value: string | undefined,
    subject: string
): string | undefined {
    if (value === undefined) return undefined;
    if (value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
    return value;
}

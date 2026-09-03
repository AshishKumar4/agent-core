import type { ActorRef } from "../actors";
import {
    RecordCodec,
    encodeCanonicalJson,
    decodeCanonicalJson,
    hasExactJsonKeys,
    isJsonObject,
    type RecordVersion,
    type JsonValue,
    TextId
} from "../core";
import { JsonPointer, type BindingName, type FacetPackageId, type TrustTier } from "../facets";
import { PrincipalId, PrincipalRef, TenantId } from "../identity";
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
        super(
            [
                EventProvenance,
                EventVerification,
                VerifiedEvent,
                HostEvent,
                TextId,
                TenantId,
                PrincipalId,
                PrincipalRef
            ],
            "workspace.event-provenance",
            {
                major: 1,
                minor: 0
            }
        );
    }

    protected encodePayload(provenance: EventProvenance): JsonValue {
        return provenance.toData();
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): EventProvenance {
        return EventProvenance.fromData(payload);
    }
}

export class EventProvenance {
    public static get codec(): RecordCodec<EventProvenance> {
        return eventProvenanceCodecInstance;
    }
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
            !isJsonObject(value) ||
            !hasExactJsonKeys(value, ["channel", "claims", "group", "principal", "verification"])
        ) {
            throw new TypeError("Event provenance payload is malformed");
        }
        const verification = value["verification"];
        const principal = value["principal"];
        const channel = value["channel"];
        const group = value["group"];
        if (
            (verification !== "verified" && verification !== "host") ||
            (channel !== null && !isStringValue(channel)) ||
            (group !== null && !isStringValue(group))
        ) {
            throw new TypeError("Event provenance fields are malformed");
        }
        let provenance: EventProvenanceInit = {
            verification:
                verification === "host" ? EventVerification.host() : EventVerification.verified(),
            claims: value["claims"]
        };
        if (principal !== null) {
            const decoded = decodeOptionalPrincipalRef(principal, "Provenance Principal");
            if (decoded === undefined) throw new TypeError("Provenance Principal is malformed");
            provenance = { ...provenance, principal: decoded };
        }
        if (channel !== null) provenance = { ...provenance, channel };
        if (group !== null) provenance = { ...provenance, group };
        return new EventProvenance(provenance);
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

const eventProvenanceCodecInstance = new EventProvenanceCodecV1();

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

/**
 * The value one RFC 6901 pointer names inside a document, or nothing when the document
 * does not hold that position. Absence is the return rather than a throw because the two
 * callers owe different refusals for it — a View mark that resolves nowhere is a malformed
 * record, a decision placement that resolves nowhere is a rejected rendering — while the
 * traversal itself is one fact about pointers. A JSON `null` the document does hold is a
 * value and answers as one.
 */
export function readJsonPointer(document: JsonValue, pointer: string): JsonValue | undefined {
    let current: JsonValue = document;
    for (const token of new JsonPointer(pointer).tokens) {
        if (Array.isArray(current)) {
            if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return undefined;
            const index = Number(token);
            const entry = Number.isSafeInteger(index) ? current[index] : undefined;
            if (entry === undefined) return undefined;
            current = entry;
        } else if (isJsonObject(current) && Object.hasOwn(current, token)) {
            const entry = current[token];
            if (entry === undefined) return undefined;
            current = entry;
        } else {
            return undefined;
        }
    }
    return current;
}

function deepFreeze(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        for (const entry of value) deepFreeze(entry);
        return Object.freeze(value);
    }
    if (isJsonObject(value)) {
        for (const entry of Object.values(value)) deepFreeze(entry);
        return Object.freeze(value);
    }
    return value;
}

function isStringValue(value: JsonValue): value is string {
    return typeof value === "string";
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

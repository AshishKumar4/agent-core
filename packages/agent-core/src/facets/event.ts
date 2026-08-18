import { isNonempty, JsonSchema, SecretRef, TextId } from "../core";
import type { FacetData } from "./data";
import {
    DataRecordCodec,
    canonicalOrder,
    dataRecord,
    requireArray,
    requireDataObject,
    requireExactFields,
    requireNonblank,
    requireOptionalString,
    requireSchemaDocument,
    requireString
} from "./data";
import { EventKind } from "./id";
import { FieldMove, JsonPointer, MappingRecord, ProvenanceMapping } from "./mapping";

export type TrustTier = "owner" | "authenticated" | "external" | "self";
export type EventVisibility = "workspace" | "private";
export type VerificationScheme = "hmac" | "signature" | "oauth" | "mtls";

const trustOrder: readonly TrustTier[] = ["owner", "authenticated", "external", "self"];

export class EventPattern {
    public readonly source: string | undefined;
    public readonly acceptedTrust: readonly [TrustTier, ...TrustTier[]];

    public constructor(
        public readonly kind: string,
        acceptedTrust: readonly [TrustTier, ...TrustTier[]],
        source?: string
    ) {
        requirePrefixPattern(kind, "Event pattern kind");
        if (source !== undefined) {
            requirePrefixPattern(source, "Event pattern source");
        }
        this.source = source;
        this.acceptedTrust = canonicalTrustTiers(acceptedTrust);
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): EventPattern {
        const object = requireDataObject(payload, "Event pattern");
        requireExactFields(object, ["acceptedTrust", "kind"], ["source"]);
        const trust = requireArray(object["acceptedTrust"], "Accepted trust tiers").map(
            requireTrustTier
        );
        if (!isNonempty(trust)) {
            throw new TypeError("Accepted trust tiers must not be empty");
        }
        return new EventPattern(
            requireString(object["kind"], "Event pattern kind"),
            trust,
            requireOptionalString(object["source"], "Event pattern source")
        );
    }

    public static encode(pattern: EventPattern): Uint8Array {
        return eventPatternCodec.encode(pattern);
    }

    public static decode(bytes: Uint8Array): EventPattern {
        return eventPatternCodec.decode(bytes);
    }

    public toData(): FacetData {
        return dataRecord({
            acceptedTrust: this.acceptedTrust,
            kind: this.kind,
            source: this.source
        });
    }
}

const eventPatternCodec = new DataRecordCodec(
    [EventPattern],
    "facet.event-pattern",
    (pattern: EventPattern) => pattern.toData(),
    (payload) => EventPattern.fromData(payload)
);

export class EventDeclaration {
    public constructor(
        public readonly kind: EventKind,
        public readonly description: string,
        public readonly payload: JsonSchema,
        public readonly visibility: EventVisibility
    ) {
        requireNonblank(description, "Event description");
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): EventDeclaration {
        const object = requireDataObject(payload, "Event declaration");
        requireExactFields(object, ["description", "kind", "payload", "visibility"]);
        return new EventDeclaration(
            new EventKind(requireString(object["kind"], "Event kind")),
            requireString(object["description"], "Event description"),
            new JsonSchema(requireSchemaDocument(object["payload"], "Event payload schema")),
            requireVisibility(object["visibility"])
        );
    }

    public static encode(event: EventDeclaration): Uint8Array {
        return eventDeclarationCodec.encode(event);
    }

    public static decode(bytes: Uint8Array): EventDeclaration {
        return eventDeclarationCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            description: this.description,
            kind: this.kind.value,
            payload: this.payload.document,
            visibility: this.visibility
        };
    }
}

const eventDeclarationCodec = new DataRecordCodec(
    [EventDeclaration, TextId, JsonSchema, EventKind],
    "facet.event-declaration",
    (event: EventDeclaration) => event.toData(),
    (payload) => EventDeclaration.fromData(payload)
);

export class IngressVerification {
    public readonly secret: SecretRef;

    public constructor(
        public readonly scheme: VerificationScheme,
        secret: SecretRef
    ) {
        this.secret = Object.freeze(new SecretRef(secret.source, secret.provider, secret.id));
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): IngressVerification {
        const object = requireDataObject(payload, "Ingress verification");
        requireExactFields(object, ["scheme", "secret"]);
        const secret = requireDataObject(object["secret"]!, "Ingress verification secret");
        requireExactFields(secret, ["id", "provider", "source"]);
        return new IngressVerification(
            requireVerificationScheme(object["scheme"]),
            new SecretRef(
                requireString(secret["source"], "Secret source"),
                requireString(secret["provider"], "Secret provider"),
                requireString(secret["id"], "Secret ID")
            )
        );
    }

    public static encode(verification: IngressVerification): Uint8Array {
        return ingressVerificationCodec.encode(verification);
    }

    public static decode(bytes: Uint8Array): IngressVerification {
        return ingressVerificationCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            scheme: this.scheme,
            secret: {
                id: this.secret.id,
                provider: this.secret.provider,
                source: this.secret.source
            }
        };
    }
}

const ingressVerificationCodec = new DataRecordCodec(
    [IngressVerification, SecretRef],
    "facet.ingress-verification",
    (verification: IngressVerification) => verification.toData(),
    (payload) => IngressVerification.fromData(payload)
);

export class IngressDeclaration {
    public constructor(
        public readonly path: string,
        public readonly verification: IngressVerification,
        public readonly provenance: ProvenanceMapping
    ) {
        requireNonblank(path, "Ingress path");
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): IngressDeclaration {
        const object = requireDataObject(payload, "Ingress declaration");
        requireExactFields(object, ["path", "provenance", "verification"]);
        return new IngressDeclaration(
            requireString(object["path"], "Ingress path"),
            IngressVerification.fromData(object["verification"]!),
            new ProvenanceMapping(
                requireArray(object["provenance"], "Ingress provenance mapping").map(
                    FieldMove.fromData
                )
            )
        );
    }

    public static encode(ingress: IngressDeclaration): Uint8Array {
        return ingressDeclarationCodec.encode(ingress);
    }

    public static decode(bytes: Uint8Array): IngressDeclaration {
        return ingressDeclarationCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            path: this.path,
            provenance: this.provenance.toData(),
            verification: this.verification.toData()
        };
    }
}

const ingressDeclarationCodec = new DataRecordCodec(
    [
        IngressDeclaration,
        IngressVerification,
        SecretRef,
        MappingRecord,
        FieldMove,
        ProvenanceMapping,
        JsonPointer
    ],
    "facet.ingress-declaration",
    (ingress: IngressDeclaration) => ingress.toData(),
    (payload) => IngressDeclaration.fromData(payload)
);

export function canonicalTrustTiers(
    values: readonly [TrustTier, ...TrustTier[]]
): readonly [TrustTier, ...TrustTier[]] {
    return canonicalOrder(values, trustOrder, "Trust tiers");
}

function requireTrustTier(value: FacetData): TrustTier {
    if (
        value === "owner" ||
        value === "authenticated" ||
        value === "external" ||
        value === "self"
    ) {
        return value;
    }
    throw new TypeError("Trust tier is invalid");
}

function requireVisibility(value: FacetData | undefined): EventVisibility {
    if (value === "workspace" || value === "private") {
        return value;
    }
    throw new TypeError("Event visibility is invalid");
}

function requireVerificationScheme(value: FacetData | undefined): VerificationScheme {
    if (value === "hmac" || value === "signature" || value === "oauth" || value === "mtls") {
        return value;
    }
    throw new TypeError("Ingress verification scheme is invalid");
}

function requirePrefixPattern(value: string, subject: string): void {
    if (value.length === 0 || value.trim() !== value || value.slice(0, -1).includes("*")) {
        throw new TypeError(`${subject} must be a literal or suffix-wildcard pattern`);
    }
}

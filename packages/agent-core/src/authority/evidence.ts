import { ActorId, ActorRef, type ActorKind } from "../actors";
import { Digest, RecordCodec, encodeCanonicalJson, type JsonValue } from "../core";
import { FacetRef, type Impact } from "../facets";
import { PrincipalId, PrincipalRef, TenantId } from "../identity";
import { Binding } from "./binding";
import {
    requireArray,
    canonicalJson,
    requireExact,
    requireObject,
    requireSafeInteger,
    requireString,
    type JsonObject
} from "./data";
import { PathEpochEvidence } from "./epoch";
import { GrantId } from "./id";

export type AuthorityDecisionReason =
    | "allowed"
    | "missingPrincipal"
    | "inactivePrincipal"
    | "invalidBinding"
    | "missingGrant"
    | "revokedGrant"
    | "invalidDelegation"
    | "guestElevation"
    | "guestVerificationExpired"
    | "noMatchingAllow"
    | "matchingDeny"
    | "stalePath";

export interface AuthorityOperationIntent {
    readonly facet: FacetRef;
    readonly operation: string;
    readonly impact: Impact;
    readonly arguments: Readonly<Record<string, JsonValue>>;
    readonly argumentsDigest: Digest;
}

export interface AuthorityCheckRequestInit {
    readonly ownerTenant: TenantId;
    readonly owner: ActorRef;
    readonly ownerFence: number;
    readonly principal: PrincipalRef;
    readonly binding: Binding;
    readonly intent: AuthorityOperationIntent;
    readonly expectedPath: PathEpochEvidence;
    readonly invocationDigest: Digest;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
    readonly nonce: string;
}

class AuthorityCheckRequestCodec extends RecordCodec<AuthorityCheckRequest> {
    public constructor() {
        super("authority.check-request", { major: 1, minor: 0 });
    }
    protected encodePayload(record: AuthorityCheckRequest): JsonValue {
        return record.toData();
    }
    protected decodePayload(payload: JsonValue): AuthorityCheckRequest {
        return AuthorityCheckRequest.fromData(payload);
    }
}

export class AuthorityCheckRequest {
    public static readonly codec: RecordCodec<AuthorityCheckRequest> =
        new AuthorityCheckRequestCodec();
    public readonly intent: AuthorityOperationIntent;

    public constructor(init: AuthorityCheckRequestInit) {
        requireSafeNonnegative(init.ownerFence, "Authority owner fence");
        requireSafeNonnegative(init.itemIndex, "Authority item index");
        requireSafeNonnegative(init.attemptOrdinal, "Authority attempt ordinal");
        if (init.nonce.length === 0 || init.nonce !== init.nonce.trim()) {
            throw new TypeError("Authority check nonce must be canonical and nonblank");
        }
        if (
            init.intent.operation.length === 0 ||
            init.intent.operation !== init.intent.operation.trim()
        ) {
            throw new TypeError("Authority operation must be canonical and nonblank");
        }
        this.ownerTenant = init.ownerTenant;
        this.owner = init.owner;
        this.ownerFence = init.ownerFence;
        this.principal = init.principal;
        this.binding = init.binding;
        const canonicalArguments = canonicalJson(init.intent.arguments);
        if (
            !Digest.sha256(encodeCanonicalJson(canonicalArguments)).equals(
                init.intent.argumentsDigest
            )
        ) {
            throw new TypeError("Authority argument digest does not match canonical arguments");
        }
        this.intent = Object.freeze({ ...init.intent, arguments: canonicalArguments });
        this.expectedPath = init.expectedPath;
        this.invocationDigest = init.invocationDigest;
        this.itemIndex = init.itemIndex;
        this.attemptOrdinal = init.attemptOrdinal;
        this.nonce = init.nonce;
        Object.freeze(this);
    }

    public readonly ownerTenant: TenantId;
    public readonly owner: ActorRef;
    public readonly ownerFence: number;
    public readonly principal: PrincipalRef;
    public readonly binding: Binding;
    public readonly invocationDigest: Digest;
    public readonly expectedPath: PathEpochEvidence;
    public readonly itemIndex: number;
    public readonly attemptOrdinal: number;
    public readonly nonce: string;

    public digest(): Digest {
        return Digest.sha256(encodeCanonicalJson(this.toData()));
    }

    public static encode(record: AuthorityCheckRequest): Uint8Array {
        return AuthorityCheckRequest.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): AuthorityCheckRequest {
        return AuthorityCheckRequest.codec.decode(bytes);
    }

    public toData(): JsonObject {
        return {
            attemptOrdinal: this.attemptOrdinal,
            binding: this.binding.toData(),
            expectedPath: this.expectedPath.toData(),
            intent: encodeIntent(this.intent),
            invocationDigest: this.invocationDigest.value,
            itemIndex: this.itemIndex,
            nonce: this.nonce,
            owner: { id: this.owner.id.value, kind: this.owner.kind },
            ownerFence: this.ownerFence,
            ownerTenant: this.ownerTenant.value,
            principal: {
                principal: this.principal.principalId.value,
                tenant: this.principal.tenantId.value
            }
        };
    }

    public static fromData(value: JsonValue | undefined): AuthorityCheckRequest {
        const object = requireObject(value, "Authority check request");
        requireExact(
            object,
            [
                "attemptOrdinal",
                "binding",
                "expectedPath",
                "intent",
                "invocationDigest",
                "itemIndex",
                "nonce",
                "owner",
                "ownerFence",
                "ownerTenant",
                "principal"
            ],
            "Authority check request"
        );
        const owner = requireObject(object["owner"], "Authority check owner");
        const principal = requireObject(object["principal"], "Authority check Principal");
        requireExact(owner, ["id", "kind"], "Authority check owner");
        requireExact(principal, ["principal", "tenant"], "Authority check Principal");
        return new AuthorityCheckRequest({
            ownerTenant: new TenantId(requireString(object, "ownerTenant")),
            owner: new ActorRef(
                requireActorKind(owner["kind"]),
                new ActorId(requireString(owner, "id"))
            ),
            ownerFence: requireSafeInteger(object, "ownerFence"),
            principal: new PrincipalRef(
                new TenantId(requireString(principal, "tenant")),
                new PrincipalId(requireString(principal, "principal"))
            ),
            binding: Binding.fromData(object["binding"]),
            intent: decodeIntent(object["intent"]),
            expectedPath: PathEpochEvidence.fromData(object["expectedPath"]),
            invocationDigest: new Digest(requireString(object, "invocationDigest")),
            itemIndex: requireSafeInteger(object, "itemIndex"),
            attemptOrdinal: requireSafeInteger(object, "attemptOrdinal"),
            nonce: requireString(object, "nonce")
        });
    }
}

class AuthorityCheckEvidenceCodec extends RecordCodec<AuthorityCheckEvidence> {
    public constructor() {
        super("authority.check-evidence", { major: 1, minor: 0 });
    }
    protected encodePayload(record: AuthorityCheckEvidence): JsonValue {
        return record.toData();
    }
    protected decodePayload(payload: JsonValue): AuthorityCheckEvidence {
        return AuthorityCheckEvidence.fromData(payload);
    }
}

export class AuthorityCheckEvidence {
    public static readonly codec: RecordCodec<AuthorityCheckEvidence> =
        new AuthorityCheckEvidenceCodec();
    readonly #checkedAt: number;
    public readonly matchedAllow: readonly GrantId[];
    public readonly matchedDeny: readonly GrantId[];

    public constructor(
        public readonly issuerTenant: TenantId,
        public readonly issuer: ActorRef,
        public readonly requestDigest: Digest,
        public readonly bindingKey: string,
        public readonly bindingGeneration: number,
        public readonly decision: "allow" | "deny",
        public readonly reason: AuthorityDecisionReason,
        matchedAllow: readonly GrantId[],
        matchedDeny: readonly GrantId[],
        public readonly pathEpochs: PathEpochEvidence,
        checkedAt: Date
    ) {
        requireSafeNonnegative(bindingGeneration, "Authority Binding generation");
        if ((decision === "allow") !== (reason === "allowed")) {
            throw new TypeError("Only allowed authority evidence may carry the allowed reason");
        }
        this.matchedAllow = canonicalGrantIds(matchedAllow);
        this.matchedDeny = canonicalGrantIds(matchedDeny);
        if (decision === "allow") {
            if (this.matchedAllow.length === 0 || this.matchedDeny.length > 0) {
                throw new TypeError(
                    "Allowed authority evidence requires allow evidence and no deny evidence"
                );
            }
        } else if (reason === "matchingDeny") {
            if (this.matchedAllow.length > 0 || this.matchedDeny.length === 0) {
                throw new TypeError("Matching-deny evidence requires only deny Grants");
            }
        } else if (this.matchedAllow.length > 0 || this.matchedDeny.length > 0) {
            throw new TypeError("Non-matching authority denials cannot carry matched Grants");
        }
        if (!issuerTenant.equals(pathEpochs.target.scope.tenantId)) {
            throw new TypeError("Authority evidence issuer Tenant must match its path");
        }
        if (bindingKey.length === 0) {
            throw new TypeError("Authority evidence Binding key must be nonblank");
        }
        this.#checkedAt = validDate(checkedAt, "Authority check time");
        if (issuer.kind !== "tenant") {
            throw new TypeError("Authority check evidence must be issued by a Tenant Actor");
        }
        Object.freeze(this);
    }

    public static encode(record: AuthorityCheckEvidence): Uint8Array {
        return AuthorityCheckEvidence.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): AuthorityCheckEvidence {
        return AuthorityCheckEvidence.codec.decode(bytes);
    }

    public get checkedAt(): Date {
        return new Date(this.#checkedAt);
    }
    public get allowed(): boolean {
        return this.decision === "allow";
    }

    public binds(request: AuthorityCheckRequest): boolean {
        return (
            this.requestDigest.equals(request.digest()) &&
            this.bindingKey === request.binding.key &&
            this.bindingGeneration === request.binding.generation
        );
    }

    public toData(): JsonObject {
        return {
            bindingGeneration: this.bindingGeneration,
            bindingKey: this.bindingKey,
            checkedAt: this.#checkedAt,
            decision: this.decision,
            issuer: { id: this.issuer.id.value, kind: this.issuer.kind },
            issuerTenant: this.issuerTenant.value,
            matchedAllow: this.matchedAllow.map((id) => id.value),
            matchedDeny: this.matchedDeny.map((id) => id.value),
            pathEpochs: this.pathEpochs.toData(),
            reason: this.reason,
            requestDigest: this.requestDigest.value
        };
    }

    public static fromData(value: JsonValue | undefined): AuthorityCheckEvidence {
        const object = requireObject(value, "Authority check evidence");
        requireExact(
            object,
            [
                "bindingGeneration",
                "bindingKey",
                "checkedAt",
                "decision",
                "issuer",
                "issuerTenant",
                "matchedAllow",
                "matchedDeny",
                "pathEpochs",
                "reason",
                "requestDigest"
            ],
            "Authority check evidence"
        );
        const issuer = requireObject(object["issuer"], "Authority evidence issuer");
        requireExact(issuer, ["id", "kind"], "Authority evidence issuer");
        const decision = requireDecision(object["decision"]);
        return new AuthorityCheckEvidence(
            new TenantId(requireString(object, "issuerTenant")),
            new ActorRef(
                requireActorKind(issuer["kind"]),
                new ActorId(requireString(issuer, "id"))
            ),
            new Digest(requireString(object, "requestDigest")),
            requireString(object, "bindingKey"),
            requireSafeInteger(object, "bindingGeneration"),
            decision,
            requireReason(object["reason"]),
            decodeGrantIds(object["matchedAllow"], "Matched allow Grants"),
            decodeGrantIds(object["matchedDeny"], "Matched deny Grants"),
            PathEpochEvidence.fromData(object["pathEpochs"]),
            new Date(requireSafeInteger(object, "checkedAt"))
        );
    }
}

export type AuthorityAdmission = AuthorityCheckEvidence;

function encodeIntent(intent: AuthorityOperationIntent): JsonObject {
    return {
        arguments: intent.arguments,
        argumentsDigest: intent.argumentsDigest.value,
        facet: intent.facet.value,
        impact: intent.impact,
        operation: intent.operation
    };
}

function decodeIntent(value: JsonValue | undefined): AuthorityOperationIntent {
    const object = requireObject(value, "Authority operation intent");
    requireExact(
        object,
        ["arguments", "argumentsDigest", "facet", "impact", "operation"],
        "Authority operation intent"
    );
    const argumentsValue = requireObject(object["arguments"], "Authority operation arguments");
    return Object.freeze({
        facet: new FacetRef(requireString(object, "facet")),
        operation: requireString(object, "operation"),
        impact: requireImpact(object["impact"]),
        arguments: canonicalJson(argumentsValue),
        argumentsDigest: new Digest(requireString(object, "argumentsDigest"))
    });
}

function canonicalGrantIds(ids: readonly GrantId[]): readonly GrantId[] {
    const ordered = [...ids].sort((left, right) => left.value.localeCompare(right.value));
    if (new Set(ordered.map((id) => id.value)).size !== ordered.length) {
        throw new TypeError("Authority Grant evidence must be unique");
    }
    return Object.freeze(ordered);
}

function decodeGrantIds(value: JsonValue | undefined, subject: string): readonly GrantId[] {
    return requireArray(value, subject).map((entry, index) => {
        if (typeof entry !== "string")
            throw new TypeError(`${subject} entry ${index} must be a string`);
        return new GrantId(entry);
    });
}

function requireActorKind(value: JsonValue | undefined): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    )
        return value;
    throw new TypeError("Authority Actor kind is invalid");
}

function requireImpact(value: JsonValue | undefined): Impact {
    if (
        value === "observe" ||
        value === "mutate" ||
        value === "externalSend" ||
        value === "execute" ||
        value === "delegate" ||
        value === "administer"
    )
        return value;
    throw new TypeError("Authority impact is invalid");
}

function requireDecision(value: JsonValue | undefined): "allow" | "deny" {
    if (value === "allow" || value === "deny") return value;
    throw new TypeError("Authority decision is invalid");
}

function requireReason(value: JsonValue | undefined): AuthorityDecisionReason {
    const reasons: readonly AuthorityDecisionReason[] = [
        "allowed",
        "missingPrincipal",
        "inactivePrincipal",
        "invalidBinding",
        "missingGrant",
        "revokedGrant",
        "invalidDelegation",
        "guestElevation",
        "guestVerificationExpired",
        "noMatchingAllow",
        "matchingDeny",
        "stalePath"
    ];
    if (typeof value === "string" && reasons.includes(value as AuthorityDecisionReason)) {
        return value as AuthorityDecisionReason;
    }
    throw new TypeError("Authority decision reason is invalid");
}

function requireSafeNonnegative(value: number, subject: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${subject} is invalid`);
}

function validDate(value: Date, subject: string): number {
    const time = value.getTime();
    if (!Number.isSafeInteger(time) || time < 0) throw new TypeError(`${subject} is invalid`);
    return time;
}

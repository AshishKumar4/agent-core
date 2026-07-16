// @ts-nocheck
import { ActorId, ActorRef, type ActorKind } from "../actors";
import { Digest, RecordCodec, encodeCanonicalJson, type JsonValue } from "../core";
import { BindingName, FacetRef, ProtectionDomain } from "../facets";
import { TenantId, type ScopeRef, type SubjectRef } from "../identity";
import { decodeDomain, encodeDomain } from "./binding";
import {
    requireExact,
    requireObject,
    requireSafeInteger,
    requireString,
    type JsonObject
} from "./data";
import { PathEpochEvidence } from "./epoch";
import { GrantId } from "./id";
import {
    decodeAuthorityScope,
    decodeAuthoritySubject,
    encodeAuthorityScope,
    encodeAuthoritySubject
} from "./reference";

export interface BindingValidationRequestInit {
    readonly ownerTenant: TenantId;
    readonly workspaceActor: ActorRef;
    readonly workspaceFence: number;
    readonly scope: ScopeRef;
    readonly domain: ProtectionDomain;
    readonly name: BindingName;
    readonly grantId: GrantId;
    readonly facet: FacetRef;
    readonly nonce: string;
}

class BindingValidationRequestCodec extends RecordCodec<BindingValidationRequest> {
    public constructor() {
        super("authority.binding-validation-request", { major: 1, minor: 0 });
    }
    protected encodePayload(record: BindingValidationRequest): JsonValue {
        return record.toData();
    }
    protected decodePayload(payload: JsonValue): BindingValidationRequest {
        return BindingValidationRequest.fromData(payload);
    }
}

export class BindingValidationRequest {
    public static readonly codec: RecordCodec<BindingValidationRequest> =
        new BindingValidationRequestCodec();
    public readonly domain: ProtectionDomain;

    public constructor(init: BindingValidationRequestInit) {
        if (init.workspaceActor.kind !== "workspace" || init.scope.kind !== "workspace") {
            throw new TypeError("Binding validation requires a Workspace Actor and Scope");
        }
        if (!Number.isSafeInteger(init.workspaceFence) || init.workspaceFence < 0) {
            throw new TypeError("Binding validation fence is invalid");
        }
        if (init.nonce.length === 0 || init.nonce !== init.nonce.trim()) {
            throw new TypeError("Binding validation nonce must be canonical and nonblank");
        }
        this.ownerTenant = init.ownerTenant;
        this.workspaceActor = init.workspaceActor;
        this.workspaceFence = init.workspaceFence;
        this.scope = init.scope;
        this.domain = Object.freeze(
            new ProtectionDomain(init.domain.kind, init.domain.label, init.domain.secretPolicy)
        );
        this.name = init.name;
        this.grantId = init.grantId;
        this.facet = init.facet;
        this.nonce = init.nonce;
        Object.freeze(this);
    }

    public readonly ownerTenant: TenantId;
    public readonly workspaceActor: ActorRef;
    public readonly workspaceFence: number;
    public readonly scope: ScopeRef;
    public readonly name: BindingName;
    public readonly grantId: GrantId;
    public readonly facet: FacetRef;
    public readonly nonce: string;

    public digest(): Digest {
        return Digest.sha256(encodeCanonicalJson(this.toData()));
    }

    public static encode(record: BindingValidationRequest): Uint8Array {
        return BindingValidationRequest.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): BindingValidationRequest {
        return BindingValidationRequest.codec.decode(bytes);
    }

    public toData(): JsonObject {
        return {
            domain: encodeDomain(this.domain),
            facet: this.facet.value,
            grantId: this.grantId.value,
            name: this.name.value,
            nonce: this.nonce,
            ownerTenant: this.ownerTenant.value,
            scope: encodeAuthorityScope(this.scope),
            workspaceActor: { id: this.workspaceActor.id.value, kind: this.workspaceActor.kind },
            workspaceFence: this.workspaceFence
        };
    }

    public static fromData(value: JsonValue | undefined): BindingValidationRequest {
        const object = requireObject(value, "Binding validation request");
        requireExact(
            object,
            [
                "domain",
                "facet",
                "grantId",
                "name",
                "nonce",
                "ownerTenant",
                "scope",
                "workspaceActor",
                "workspaceFence"
            ],
            "Binding validation request"
        );
        const workspaceActor = requireObject(object["workspaceActor"], "Binding Workspace Actor");
        requireExact(workspaceActor, ["id", "kind"], "Binding Workspace Actor");
        return new BindingValidationRequest({
            ownerTenant: new TenantId(requireString(object, "ownerTenant")),
            workspaceActor: new ActorRef(
                requireActorKind(workspaceActor["kind"]),
                new ActorId(requireString(workspaceActor, "id"))
            ),
            workspaceFence: requireSafeInteger(object, "workspaceFence"),
            scope: decodeAuthorityScope(object["scope"]!),
            domain: decodeDomain(object["domain"]),
            name: new BindingName(requireString(object, "name")),
            grantId: new GrantId(requireString(object, "grantId")),
            facet: new FacetRef(requireString(object, "facet")),
            nonce: requireString(object, "nonce")
        });
    }
}

class BindingValidationEvidenceCodec extends RecordCodec<BindingValidationEvidence> {
    public constructor() {
        super("authority.binding-validation-evidence", { major: 1, minor: 0 });
    }
    protected encodePayload(record: BindingValidationEvidence): JsonValue {
        return record.toData();
    }
    protected decodePayload(payload: JsonValue): BindingValidationEvidence {
        return BindingValidationEvidence.fromData(payload);
    }
}

export class BindingValidationEvidence {
    public static readonly codec: RecordCodec<BindingValidationEvidence> =
        new BindingValidationEvidenceCodec();
    readonly #checkedAt: number;
    public readonly subject: SubjectRef;

    public constructor(
        public readonly issuerTenant: TenantId,
        public readonly issuer: ActorRef,
        public readonly requestDigest: Digest,
        public readonly scope: ScopeRef,
        subject: SubjectRef,
        public readonly grantId: GrantId,
        public readonly pathEpochs: PathEpochEvidence,
        checkedAt: Date
    ) {
        const time = checkedAt.getTime();
        if (!Number.isSafeInteger(time) || time < 0) {
            throw new TypeError("Binding validation time is invalid");
        }
        if (scope.kind !== "workspace" || !scope.equals(pathEpochs.target.scope)) {
            throw new TypeError("Binding validation path must end at its Workspace Scope");
        }
        if (issuer.kind !== "tenant") {
            throw new TypeError("Binding validation evidence must be issued by a Tenant Actor");
        }
        if (!issuerTenant.equals(scope.tenantId)) {
            throw new TypeError("Binding validation issuer Tenant must match its Scope");
        }
        this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
        this.#checkedAt = time;
        Object.freeze(this);
    }

    public static encode(record: BindingValidationEvidence): Uint8Array {
        return BindingValidationEvidence.codec.encode(record);
    }

    public static decode(bytes: Uint8Array): BindingValidationEvidence {
        return BindingValidationEvidence.codec.decode(bytes);
    }

    public get checkedAt(): Date {
        return new Date(this.#checkedAt);
    }

    public binds(request: BindingValidationRequest): boolean {
        return (
            this.requestDigest.equals(request.digest()) &&
            this.issuerTenant.equals(request.ownerTenant) &&
            this.scope.equals(request.scope) &&
            this.grantId.equals(request.grantId)
        );
    }

    public toData(): JsonObject {
        return {
            checkedAt: this.#checkedAt,
            grantId: this.grantId.value,
            issuer: { id: this.issuer.id.value, kind: this.issuer.kind },
            issuerTenant: this.issuerTenant.value,
            pathEpochs: this.pathEpochs.toData(),
            requestDigest: this.requestDigest.value,
            scope: encodeAuthorityScope(this.scope),
            subject: encodeAuthoritySubject(this.subject)
        };
    }

    public static fromData(value: JsonValue | undefined): BindingValidationEvidence {
        const object = requireObject(value, "Binding validation evidence");
        requireExact(
            object,
            [
                "checkedAt",
                "grantId",
                "issuer",
                "issuerTenant",
                "pathEpochs",
                "requestDigest",
                "scope",
                "subject"
            ],
            "Binding validation evidence"
        );
        const issuer = requireObject(object["issuer"], "Binding validation issuer");
        requireExact(issuer, ["id", "kind"], "Binding validation issuer");
        return new BindingValidationEvidence(
            new TenantId(requireString(object, "issuerTenant")),
            new ActorRef(
                requireActorKind(issuer["kind"]),
                new ActorId(requireString(issuer, "id"))
            ),
            new Digest(requireString(object, "requestDigest")),
            decodeAuthorityScope(object["scope"]!),
            decodeAuthoritySubject(object["subject"]!),
            new GrantId(requireString(object, "grantId")),
            PathEpochEvidence.fromData(object["pathEpochs"]),
            new Date(requireSafeInteger(object, "checkedAt"))
        );
    }
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
    throw new TypeError("Binding validation Actor kind is invalid");
}

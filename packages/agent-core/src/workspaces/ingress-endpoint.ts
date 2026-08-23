import {
    Digest,
    RecordCodec,
    Revision,
    SemVer,
    SecretRef,
    TextId,
    isJsonObject,
    type JsonValue,
    type RecordVersion
} from "../core";
import { PackageId, PackagePin } from "../definition-references";
import {
    ContributionAttribution,
    FacetPackageId,
    FacetRef,
    FieldMove,
    IngressDeclaration,
    IngressVerification,
    JsonPointer,
    MappingRecord,
    ProvenanceMapping,
    dataRecord
} from "../facets";
import { AgentCoreError } from "../errors";
import { ProjectId, ScopeRef, TenantId, WorkspaceId } from "../identity";
import {
    decodeRevision,
    decodeScope,
    encodeRevision,
    encodeScope,
    requireOptionalFields,
    requireObject,
    requireString
} from "./codec";

/**
 * The durable identity of one target-bound ingress endpoint. It lives beside its record
 * so the whole ingress plane stays one slice until the owning context wires it into the
 * shared workspace storage.
 */
export class IngressEndpointId extends TextId {
    public constructor(value: string) {
        super(value, "Ingress endpoint ID");
        Object.freeze(this);
    }
}

export interface IngressEndpointInit {
    readonly id: IngressEndpointId;
    readonly revision: Revision;
    /** The target Scope the endpoint binds to: accepted input mints this Scope's Events. */
    readonly scope: ScopeRef;
    readonly declared: IngressDeclaration;
    /**
     * SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): present exactly when a Facet's
     * `ingress` contribution materialized this endpoint, absent when a caller declared it
     * directly. Its presence is what puts the endpoint in that Facet's §4.1 withdrawal set.
     */
    readonly contribution?: ContributionAttribution | undefined;
    /**
     * SPEC §4.1: present only on the revision a withdrawal writes. A retired endpoint is
     * no longer exposed: it verifies no request and mints no Event.
     */
    readonly retired?: true | undefined;
}

/**
 * A trusted materializer supplies the declared endpoint and its target Scope. The store
 * derives the initial revision, authenticated contribution attribution, and live state
 * itself.
 */
export type IngressEndpointMaterializationInit = Omit<
    IngressEndpointInit,
    "contribution" | "retired" | "revision"
>;

/**
 * Major 1 carries the target-bound declaration plus the §4.2 attribution of the Facet
 * contribution that materialized it and the §4.1 retirement marker a withdrawal writes.
 * Both optional halves are encoded by presence: an endpoint no Facet contributed carries
 * no attribution key, and a live one carries no `retired` key.
 */
class IngressEndpointCodecV1 extends RecordCodec<IngressEndpoint> {
    public constructor() {
        super(
            [
                IngressEndpoint,
                ContributionAttribution,
                Revision,
                TextId,
                MappingRecord,
                FieldMove,
                IngressDeclaration,
                IngressVerification,
                ProvenanceMapping,
                SecretRef,
                JsonPointer,
                FacetPackageId,
                FacetRef,
                Digest,
                SemVer,
                PackageId,
                PackagePin,
                ScopeRef,
                TenantId,
                WorkspaceId,
                ProjectId
            ],
            "workspace.ingress-endpoint",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(endpoint: IngressEndpoint): JsonValue {
        const contribution = endpoint.contribution;
        return dataRecord({
            id: endpoint.id.value,
            revision: encodeRevision(endpoint.revision),
            scope: encodeScope(endpoint.scope),
            declared: endpoint.declared.toData(),
            contribution:
                contribution === undefined
                    ? undefined
                    : {
                          contributor: contribution.contributor.value,
                          package: contribution.package.toData()
                      },
            retired: endpoint.retired
        });
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): IngressEndpoint {
        const object = requireObject(payload, "Ingress endpoint payload");
        requireOptionalFields(
            object,
            ["declared", "id", "revision", "scope"],
            ["contribution", "retired"],
            "Ingress endpoint payload"
        );
        const contribution = object["contribution"];
        const retired = object["retired"];
        if (retired !== undefined && retired !== true) {
            throw new TypeError("Ingress endpoint retirement is encoded by presence");
        }
        return new IngressEndpoint({
            id: new IngressEndpointId(requireString(object["id"], "Ingress endpoint ID")),
            revision: decodeRevision(object["revision"], "Ingress endpoint revision"),
            scope: decodeScope(object["scope"]),
            declared: IngressDeclaration.fromData(object["declared"]),
            contribution: contribution === undefined ? undefined : decodeContribution(contribution),
            retired: retired === undefined ? undefined : true
        });
    }
}

export class IngressEndpoint {
    public static get codec(): RecordCodec<IngressEndpoint> {
        return ingressEndpointCodecInstance;
    }

    public static encode(endpoint: IngressEndpoint): Uint8Array {
        return IngressEndpoint.codec.encode(endpoint);
    }

    public static decode(bytes: Uint8Array): IngressEndpoint {
        return IngressEndpoint.codec.decode(bytes);
    }

    public readonly id: IngressEndpointId;
    public readonly revision: Revision;
    public readonly scope: ScopeRef;
    public readonly declared: IngressDeclaration;
    public readonly contribution: ContributionAttribution | undefined;
    public readonly retired: true | undefined;

    public constructor(init: IngressEndpointInit) {
        if (!(init.scope instanceof ScopeRef)) {
            throw new TypeError("Ingress endpoint must bind its target Scope");
        }
        if (!(init.declared instanceof IngressDeclaration)) {
            throw new TypeError("Ingress endpoint must carry a canonical declaration");
        }
        if (
            init.contribution !== undefined &&
            !(init.contribution instanceof ContributionAttribution)
        ) {
            throw new TypeError("Ingress endpoint contribution must carry canonical attribution");
        }
        if (init.retired !== undefined && init.retired !== true) {
            throw new TypeError("Ingress endpoint retirement is declared by presence");
        }
        this.id = init.id;
        this.revision = init.revision;
        this.scope = init.scope;
        // The round-trip normalizes the declaration so two constructions of the same
        // declared shape encode byte-identically.
        this.declared = IngressDeclaration.decode(IngressDeclaration.encode(init.declared));
        this.contribution = init.contribution;
        this.retired = init.retired;
        Object.freeze(this);
    }

    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the retirement revision a withdrawal writes
     * for an endpoint its Facet's `ingress` contribution materialized. The declared shape,
     * the target Scope, and the attribution are carried through unchanged.
     */
    public retire(): IngressEndpoint {
        if (this.contribution === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Only a contributed Ingress endpoint is retired by withdrawal"
            );
        }
        return new IngressEndpoint({
            id: this.id,
            revision: this.revision.next(),
            scope: this.scope,
            declared: this.declared,
            contribution: this.contribution,
            retired: true
        });
    }
}

function decodeContribution(value: JsonValue): ContributionAttribution {
    if (!isJsonObject(value)) {
        throw new TypeError("Ingress endpoint contribution must be an object");
    }
    return ContributionAttribution.decodeFields(value, "Ingress endpoint contribution");
}

const ingressEndpointCodecInstance = new IngressEndpointCodecV1();

import {
    Digest,
    RecordCodec,
    SemVer,
    TextId,
    jsonDataParser,
    type JsonObject,
    type JsonValue
} from "../core";
import { PackageId, PackagePin } from "../definition-references";
import { ContributionAttribution, FacetPackageId, FacetRef } from "../facets";
import { TenantId } from "../identity";
import { DeploymentId, FacetInstallFailureId } from "./id";
import { ManagedOrigin } from "./origin";

const parse = jsonDataParser((message) => new TypeError(message));

/**
 * SPEC §4.1: where an activation stopped. `start` means the Facet's own `start` hook did
 * not complete, and nothing was materialized, because a contribution's records are written
 * only after every start succeeds. `materialization` means start completed and the
 * record-write transaction failed.
 *
 * The distinction is a per-case method rather than a caller-side branch on a label,
 * because exactly one thing turns on it: only a materialization-phase failure can have
 * left attributed records the §4.1 withdrawal set must retire. The two cases are frozen
 * singletons and equality is identity, so nothing can mint a third phase or hold two
 * unequal copies of one meaning.
 */
export abstract class FacetInstallPhase {
    public static get start(): FacetInstallPhase {
        return startPhase;
    }
    public static get materialization(): FacetInstallPhase {
        return materializationPhase;
    }

    public static fromData(value: JsonValue | undefined): FacetInstallPhase {
        const declared = FACET_INSTALL_PHASES.find((candidate) => candidate.label === value);
        if (declared === undefined) {
            throw new TypeError(
                `Facet install phase must be one of ${FACET_INSTALL_PHASES.map((phase) => phase.label).join(", ")}`
            );
        }
        return declared;
    }

    /** The wire label this phase serializes to. */
    public abstract readonly label: "start" | "materialization";

    /** Could this failure have left records a withdrawal set must retire? */
    public abstract get materializedRecords(): boolean;

    public toData(): JsonValue {
        return this.label;
    }

    public equals(other: FacetInstallPhase): boolean {
        return this === other;
    }
}

class StartPhase extends FacetInstallPhase {
    public readonly label = "start";
    public get materializedRecords(): boolean {
        return false;
    }
}

class MaterializationPhase extends FacetInstallPhase {
    public readonly label = "materialization";
    public get materializedRecords(): boolean {
        return true;
    }
}

const startPhase = Object.freeze(new StartPhase());
const materializationPhase = Object.freeze(new MaterializationPhase());

const FACET_INSTALL_PHASES: readonly FacetInstallPhase[] = Object.freeze([
    startPhase,
    materializationPhase
]);

export interface FacetInstallFailureInit {
    readonly attribution: ContributionAttribution;
    readonly packageFacet: FacetPackageId;
    readonly manifestDigest: Digest;
    readonly materialization: ManagedOrigin;
    readonly phase: FacetInstallPhase;
    readonly reason: string;
    readonly id?: FacetInstallFailureId;
}

class FacetInstallFailureCodec extends RecordCodec<FacetInstallFailure> {
    public constructor() {
        super(
            [
                FacetInstallFailure,
                ContributionAttribution,
                ManagedOrigin,
                FacetInstallPhase,
                FacetInstallFailureId,
                FacetPackageId,
                FacetRef,
                TextId,
                Digest,
                TenantId,
                DeploymentId,
                PackageId,
                PackagePin,
                SemVer
            ],
            "definition.facet-install-failure",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(failure: FacetInstallFailure): JsonValue {
        return failure.toData();
    }

    protected decodePayload(payload: JsonValue): FacetInstallFailure {
        return FacetInstallFailure.fromData(payload);
    }
}

/**
 * SPEC §4.1: the typed failed install a host records instead of a live Facet. It is
 * durable definition-plane evidence, not a diagnostic: a failed Facet is inactive,
 * obstructs nothing, and is not retried against the same unchanged Scope, and this record
 * is what makes that last clause answerable after the process that failed is gone.
 *
 * `materialization` is the exact `ManagedOrigin` the installation authenticated under, so
 * the Scope is named by Tenant, deployment, attestation, Blueprint, PackageLock, config
 * and generation. A later generation is a different origin, which is why a retry under it
 * is admitted rather than refused by an older failure.
 */
export class FacetInstallFailure {
    public static get codec(): RecordCodec<FacetInstallFailure> {
        return facetInstallFailureCodecInstance;
    }

    public readonly id: FacetInstallFailureId;
    public readonly attribution: ContributionAttribution;
    /** The Facet package whose activation failed. */
    public readonly packageFacet: FacetPackageId;
    public readonly manifestDigest: Digest;
    public readonly materialization: ManagedOrigin;
    public readonly phase: FacetInstallPhase;
    public readonly reason: string;

    public constructor(init: FacetInstallFailureInit) {
        if (!(init.attribution instanceof ContributionAttribution)) {
            throw new TypeError("A failed install carries its contribution attribution");
        }
        if (!(init.packageFacet instanceof FacetPackageId)) {
            throw new TypeError("A failed install names the Facet package that failed");
        }
        if (
            !(init.manifestDigest instanceof Digest) ||
            !(init.materialization instanceof ManagedOrigin)
        ) {
            throw new TypeError(
                "A failed install carries its manifest digest and its managed origin"
            );
        }
        if (!(init.phase instanceof FacetInstallPhase)) {
            throw new TypeError("A failed install names the phase its activation stopped in");
        }
        if (init.reason.length === 0 || init.reason !== init.reason.trim()) {
            throw new TypeError("Facet install failure reason must be a nonblank canonical string");
        }
        this.attribution = init.attribution;
        this.packageFacet = init.packageFacet;
        this.manifestDigest = init.manifestDigest;
        this.materialization = init.materialization;
        this.phase = init.phase;
        this.reason = init.reason;
        const id = FacetInstallFailureId.derive(declaredFields(init));
        if (init.id !== undefined && !init.id.equals(id)) {
            throw new TypeError("Facet install failure ID does not match its canonical contents");
        }
        this.id = id;
        Object.freeze(this);
    }

    public static encode(failure: FacetInstallFailure): Uint8Array {
        return FacetInstallFailure.codec.encode(failure);
    }

    public static decode(bytes: Uint8Array): FacetInstallFailure {
        return FacetInstallFailure.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): FacetInstallFailure {
        const object = parse.exact(
            parse.object(payload, "Facet install failure"),
            [
                "contributor",
                "id",
                "manifestDigest",
                "materialization",
                "package",
                "packageFacet",
                "phase",
                "reason"
            ],
            "Facet install failure"
        );
        return new FacetInstallFailure({
            attribution: ContributionAttribution.decodeFields(object, "Facet install failure"),
            packageFacet: new FacetPackageId(
                parse.string(object["packageFacet"], "Facet install failure Facet package")
            ),
            manifestDigest: new Digest(
                parse.string(object["manifestDigest"], "Facet install failure manifest digest")
            ),
            materialization: ManagedOrigin.fromData(object["materialization"]),
            phase: FacetInstallPhase.fromData(object["phase"]),
            reason: parse.string(object["reason"], "Facet install failure reason"),
            id: new FacetInstallFailureId(parse.string(object["id"], "Facet install failure ID"))
        });
    }

    /**
     * SPEC §4.1: does this failure refuse a retry of the same contribution against the same
     * unchanged Scope? Both halves are exact — the contributing FacetRef with its source
     * PackagePin, and the complete managed origin — so nothing about a changed Scope reads
     * as the one that already failed.
     */
    public refuses(attribution: ContributionAttribution, materialization: ManagedOrigin): boolean {
        return this.attribution.equals(attribution) && this.materialization.equals(materialization);
    }

    public toData(): JsonValue {
        return { ...declaredFields(this), id: this.id.value };
    }
}

const facetInstallFailureCodecInstance = new FacetInstallFailureCodec();

/** Exactly the fields the record declares, which are exactly the fields its id digests. */
function declaredFields(init: FacetInstallFailureInit): JsonObject {
    return {
        ...init.attribution.encodeFields(),
        manifestDigest: init.manifestDigest.value,
        materialization: init.materialization.toData(),
        packageFacet: init.packageFacet.value,
        phase: init.phase.toData(),
        reason: init.reason
    };
}

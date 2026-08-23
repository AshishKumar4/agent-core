import { Digest, SemVer, TextId } from "../core";
import { PackageId, PackagePin } from "../definition-references";
import { ContributionAttribution } from "./attribution";
import { SurfaceDescriptor } from "./contribution";
import type { FacetData } from "./data";
import { DataRecordCodec, requireDataObject, requireExactFields } from "./data";
import { FacetPackageId, FacetRef, SurfaceId } from "./id";

/**
 * A Surface as a Scope holds it: SPEC §6.3's stable UI contribution from a Facet, paired
 * with the §4.2 attribution of the Facet whose `surfaces` contribution materialized it. The
 * declaration half is authored in a manifest before any release exists, so the pin lives
 * here rather than on `SurfaceDescriptor` — the same split `InstalledSlot` makes for Slots —
 * and a registration the host cannot attribute cannot be built. That is what lets a host
 * answer from records alone which Facet is responsible for a rendered Surface, and what puts
 * the Surface in that Facet's §4.1 withdrawal set.
 */
export class SurfaceRegistration {
    public constructor(
        public readonly descriptor: SurfaceDescriptor,
        public readonly attribution: ContributionAttribution
    ) {
        if (
            !(descriptor instanceof SurfaceDescriptor) ||
            !(attribution instanceof ContributionAttribution)
        ) {
            throw new TypeError(
                "A Surface registration carries its descriptor and its attribution"
            );
        }
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): SurfaceRegistration {
        const object = requireDataObject(payload, "Surface registration");
        requireExactFields(object, ["contributor", "descriptor", "package"]);
        const descriptor = object["descriptor"];
        if (descriptor === undefined) {
            throw new TypeError("Surface registration carries no Surface descriptor");
        }
        return new SurfaceRegistration(
            SurfaceDescriptor.fromData(descriptor),
            ContributionAttribution.decodeFields(object, "Surface registration")
        );
    }

    public static encode(registration: SurfaceRegistration): Uint8Array {
        return surfaceRegistrationCodec.encode(registration);
    }

    public static decode(bytes: Uint8Array): SurfaceRegistration {
        return surfaceRegistrationCodec.decode(bytes);
    }

    public toData(): FacetData {
        return { ...this.attribution.encodeFields(), descriptor: this.descriptor.toData() };
    }
}

const surfaceRegistrationCodec = new DataRecordCodec(
    [
        SurfaceRegistration,
        SurfaceDescriptor,
        ContributionAttribution,
        TextId,
        SurfaceId,
        FacetRef,
        FacetPackageId,
        Digest,
        SemVer,
        PackageId,
        PackagePin
    ],
    "facet.surface-registration",
    (registration: SurfaceRegistration) => registration.toData(),
    (payload) => SurfaceRegistration.fromData(payload)
);

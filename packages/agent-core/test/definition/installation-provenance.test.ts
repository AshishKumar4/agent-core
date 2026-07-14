import { describe, expect, test } from "vitest";
import { Digest, SemVer } from "../../src/core";
import { FacetPackageId, FacetRef, PackageInstallationRef } from "../../src/facets";
import {
    DeploymentId,
    ManagedOrigin,
    PackageId,
    PackageInstallationProvenancePort,
    PackagePin,
    type AuthenticatedPackageInstallation
} from "../../src/definition";
import { TenantId } from "../../src/identity";

describe("Package installation contribution provenance", () => {
    test("derives the contributor from authenticated materialization state", () => {
        const authenticated = installation("workspace:installed.facet");
        const port = new TestInstallationPort(authenticated);
        const supplied = { contributor: new FacetRef("workspace:payload.facet") };

        const reference = port.reference({}, supplied);
        const prepared = port.prepareContribution({}, supplied)!;
        const apply = port.resolveContributionForApply({}, supplied, prepared.stamp);

        expect(reference).toBeInstanceOf(PackageInstallationRef);
        expect(prepared.reference.facet.equals(authenticated.facet)).toBe(true);
        expect(apply?.facet.equals(authenticated.facet)).toBe(true);
        expect(reference?.facet).toBe(authenticated.facet);
        expect(reference?.facet.equals(supplied.contributor)).toBe(false);
        expect(reference?.packageFacet).toBe(authenticated.packageFacet);
    });

    test("fails closed when authenticated installation provenance is absent", () => {
        expect(new TestInstallationPort(undefined).reference({}, {})).toBeUndefined();
        expect(new TestInstallationPort(undefined).prepareContribution({}, {})).toBeUndefined();
    });

    test("rejects noncanonical authenticated installation evidence", () => {
        const authenticated = installation("workspace:installed.facet");
        const forged = {
            ...authenticated,
            package: {}
        } as AuthenticatedPackageInstallation;
        expect(() => new TestInstallationPort(forged).prepareContribution({}, {})).toThrow(
            /canonical pin/
        );
        expect(() => new PackageInstallationRef(authenticated.facet, {} as FacetPackageId)).toThrow(
            TypeError
        );
    });

    test("rejects a provenance swap between authorization and apply", () => {
        const port = new TestInstallationPort(installation("workspace:installed.facet"));
        const prepared = port.prepareContribution({}, {})!;
        port.installation = installation("workspace:substituted.facet");

        expect(port.resolveContributionForApply({}, {}, prepared.stamp)).toBeUndefined();
        expect(port.resolveContributionForApply({}, {}, prepared.stamp)).toBeUndefined();
    });
});

class TestInstallationPort extends PackageInstallationProvenancePort<object, object> {
    public constructor(public installation: AuthenticatedPackageInstallation | undefined) {
        super();
    }

    protected authenticatedInstallation(): AuthenticatedPackageInstallation | undefined {
        return this.installation;
    }
}

function installation(facet: string): AuthenticatedPackageInstallation {
    const digest = new Digest("a".repeat(64));
    return Object.freeze({
        package: new PackagePin(
            new PackageId("profile-package"),
            new SemVer("1.0.0"),
            digest,
            digest
        ),
        packageFacet: new FacetPackageId("profile.facet"),
        facet: new FacetRef(facet),
        materialization: new ManagedOrigin({
            tenantId: new TenantId("tenant"),
            deploymentId: new DeploymentId("b".repeat(64)),
            attestationDigest: digest,
            blueprintDigest: digest,
            packageLockDigest: digest,
            configDigest: digest,
            generation: 1
        })
    });
}

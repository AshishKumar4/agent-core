import { describe, expect, test } from "vitest";
import { Digest, SemVer } from "../../src/core";
import {
    ContributionAttribution,
    FacetPackageId,
    FacetRef,
    PackageInstallationRef
} from "../../src/facets";
import {
    DeploymentId,
    ManagedOrigin,
    PackageId,
    PackageInstallationProvenancePort,
    PackagePin,
    consumeAuthenticatedContribution,
    type AuthenticatedContribution,
    type AuthenticatedPackageInstallation
} from "../../src/definition";
import { malformed } from "../helpers/malformed";
import { TenantId } from "../../src/identity";

describe("Package installation contribution provenance", () => {
    test("derives the contributor from authenticated materialization state", { tags: "p1" }, () => {
        const authenticated = installation("workspace:installed.facet");
        const port = new TestInstallationPort(authenticated);
        const supplied = { contributor: new FacetRef("workspace:payload.facet") };

        const reference = port.reference({}, supplied);
        const prepared = port.prepareContribution({}, supplied)!;
        const apply = port.resolveContributionForApply({}, supplied, prepared.stamp);

        expect(reference).toBeInstanceOf(PackageInstallationRef);
        expect(prepared.reference.attribution.contributor.equals(authenticated.facet)).toBe(true);
        expect(apply?.attribution.contributor.equals(authenticated.facet)).toBe(true);
        expect(reference?.attribution.contributor.equals(authenticated.facet)).toBe(true);
        expect(reference?.attribution.contributor.equals(supplied.contributor)).toBe(false);
        expect(reference?.packageFacet).toBe(authenticated.packageFacet);
    });

    test(
        "issues one synchronous opaque capability only after current provenance resolves",
        { tags: "p0" },
        () => {
            const authenticated = installation("workspace:materialized.facet");
            const port = new TestInstallationPort(authenticated);
            const prepared = port.prepareContribution({}, {});
            if (prepared === undefined) {
                throw new TypeError("Authenticated installation did not prepare a contribution");
            }
            let captured: AuthenticatedContribution | undefined;
            expect(
                port
                    .withAuthenticatedContribution({}, {}, prepared.stamp, (contribution) => {
                        captured = contribution;
                        return consumeAuthenticatedContribution(contribution);
                    })
                    ?.equals(
                        new ContributionAttribution(authenticated.facet, authenticated.package)
                    )
            ).toBe(true);
            const expired = captured;
            if (expired === undefined) {
                throw new TypeError("Authenticated installation did not issue a capability");
            }
            expect(
                consumeAuthenticatedContribution(malformed<AuthenticatedContribution>({}))
            ).toBeUndefined();

            const failed = new TestInstallationPort(authenticated);
            const failedPrepared = failed.prepareContribution({}, {});
            if (failedPrepared === undefined) {
                throw new TypeError("Authenticated installation did not prepare a contribution");
            }
            failed.installation = undefined;
            let invoked = false;
            expect(
                failed.withAuthenticatedContribution({}, {}, failedPrepared.stamp, () => {
                    invoked = true;
                    return true;
                })
            ).toBeUndefined();
            expect(invoked).toBe(false);
        }
    );

    test("fails closed when authenticated installation provenance is absent", { tags: "p0" }, () => {
        expect(new TestInstallationPort(undefined).reference({}, {})).toBeUndefined();
        expect(new TestInstallationPort(undefined).prepareContribution({}, {})).toBeUndefined();
    });

    test("rejects noncanonical authenticated installation evidence", { tags: "p0" }, () => {
        const authenticated = installation("workspace:installed.facet");
        const forged = forgedInstallation({ ...authenticated, package: {} });
        expect(() => new TestInstallationPort(forged).prepareContribution({}, {})).toThrow(
            /canonical pin/
        );
        expect(() =>
            new PackageInstallationRef(
                new ContributionAttribution(authenticated.facet, authenticated.package),
                forgedPackageId({})
            )
        ).toThrow(
            TypeError
        );
    });

    test("fails closed when provenance disappears before apply", { tags: "p0" }, () => {
        const port = new TestInstallationPort(installation("workspace:installed.facet"));
        const prepared = port.prepareContribution({}, {});
        expect(prepared).toBeDefined();
        port.installation = undefined;

        expect(
            prepared === undefined
                ? "unprepared"
                : port.resolveContributionForApply({}, {}, prepared.stamp)
        ).toBeUndefined();
    });

    test("rejects any single-field provenance drift between authorization and apply", { tags: "p0" }, () => {
        const base = installation("workspace:installed.facet");
        const otherDigest = new Digest("c".repeat(64));
        const substitutions: readonly Partial<AuthenticatedPackageInstallation>[] = [
            {
                package: new PackagePin(
                    new PackageId("swapped-package"),
                    base.package.version,
                    base.package.manifestDigest,
                    base.package.codeDigest
                )
            },
            {
                package: new PackagePin(
                    base.package.id,
                    new SemVer("1.0.1"),
                    base.package.manifestDigest,
                    base.package.codeDigest
                )
            },
            {
                package: new PackagePin(
                    base.package.id,
                    base.package.version,
                    otherDigest,
                    base.package.codeDigest
                )
            },
            {
                package: new PackagePin(
                    base.package.id,
                    base.package.version,
                    base.package.manifestDigest,
                    otherDigest
                )
            },
            { packageFacet: new FacetPackageId("substituted.facet") },
            {
                materialization: new ManagedOrigin({
                    tenantId: base.materialization.tenantId,
                    deploymentId: base.materialization.deploymentId,
                    attestationDigest: base.materialization.attestationDigest,
                    blueprintDigest: base.materialization.blueprintDigest,
                    packageLockDigest: base.materialization.packageLockDigest,
                    configDigest: base.materialization.configDigest,
                    generation: base.materialization.generation + 1
                })
            }
        ];

        for (const substitution of substitutions) {
            const port = new TestInstallationPort(base);
            const prepared = port.prepareContribution({}, {});
            expect(prepared).toBeDefined();
            if (prepared === undefined) continue;
            port.installation = Object.freeze({ ...base, ...substitution });
            expect({
                substitution,
                resolved: port.resolveContributionForApply({}, {}, prepared.stamp)
            }).toEqual({ substitution, resolved: undefined });
        }

        const unchanged = new TestInstallationPort(base);
        const prepared = unchanged.prepareContribution({}, {});
        expect(prepared).toBeDefined();
        if (prepared !== undefined) {
            unchanged.installation = installation("workspace:installed.facet");
            expect(
                unchanged.resolveContributionForApply({}, {}, prepared.stamp)
            ).toBeInstanceOf(PackageInstallationRef);
        }
    });

    test("rejects a provenance swap between authorization and apply", { tags: "p0" }, () => {
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

/**
 * An installation whose package pin is not canonical, and a Facet package ID that is not one at
 * all. Installation evidence crosses a trust boundary, so its port re-validates the values it is
 * given rather than trusting their declared types.
 */
function forgedInstallation<TActual>(value: TActual): AuthenticatedPackageInstallation {
    // SAFETY: the package field is not a canonical pin. The port must reject the evidence.
    return value as TActual & AuthenticatedPackageInstallation;
}

function forgedPackageId<TActual>(value: TActual): FacetPackageId {
    // SAFETY: not a FacetPackageId. PackageInstallationRef identifies its Facet by class, so this
    // is the case its constructor must refuse.
    return value as TActual & FacetPackageId;
}

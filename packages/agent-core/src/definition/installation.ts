import { FacetPackageId, FacetRef, PackageInstallationRef } from "../facets";
import { ManagedOrigin } from "./origin";
import { PackagePin } from "./package-lock";

export interface AuthenticatedPackageInstallation {
    readonly package: PackagePin;
    readonly packageFacet: FacetPackageId;
    readonly facet: FacetRef;
    readonly materialization: ManagedOrigin;
}

export interface PreparedPackageContribution {
    readonly reference: PackageInstallationRef;
    readonly stamp: object;
}

export abstract class PackageInstallationProvenancePort<State, Context> {
    readonly #prepared = new WeakMap<object, AuthenticatedPackageInstallation>();

    protected abstract authenticatedInstallation(
        state: State,
        context: Context
    ): AuthenticatedPackageInstallation | undefined;

    public reference(state: State, context: Context): PackageInstallationRef | undefined {
        const installation = this.authenticatedInstallation(state, context);
        if (installation === undefined) return undefined;
        requireInstallation(installation);
        return new PackageInstallationRef(installation.facet, installation.packageFacet);
    }

    public prepareContribution(
        state: State,
        context: Context
    ): PreparedPackageContribution | undefined {
        const installation = this.authenticatedInstallation(state, context);
        if (installation === undefined) return undefined;
        requireInstallation(installation);
        const prepared = copyInstallation(installation);
        const stamp = Object.freeze({});
        this.#prepared.set(stamp, prepared);
        return Object.freeze({
            reference: new PackageInstallationRef(prepared.facet, prepared.packageFacet),
            stamp
        });
    }

    public resolveContributionForApply(
        state: State,
        context: Context,
        stamp: object
    ): PackageInstallationRef | undefined {
        const expected = this.#prepared.get(stamp);
        if (expected === undefined) return undefined;
        this.#prepared.delete(stamp);
        const installation = this.authenticatedInstallation(state, context);
        if (installation === undefined) return undefined;
        requireInstallation(installation);
        if (!sameInstallation(expected, installation)) return undefined;
        return new PackageInstallationRef(installation.facet, installation.packageFacet);
    }
}

function requireInstallation(installation: AuthenticatedPackageInstallation): void {
    if (
        !(installation.package instanceof PackagePin) ||
        !(installation.materialization instanceof ManagedOrigin)
    ) {
        throw new TypeError(
            "Authenticated package installation requires canonical pin and materialization provenance"
        );
    }
}

function copyInstallation(
    installation: AuthenticatedPackageInstallation
): AuthenticatedPackageInstallation {
    return Object.freeze({
        package: PackagePin.fromData(installation.package.toData()),
        packageFacet: new FacetPackageId(installation.packageFacet.value),
        facet: new FacetRef(installation.facet.value),
        materialization: ManagedOrigin.fromData(installation.materialization.toData())
    });
}

function sameInstallation(
    left: AuthenticatedPackageInstallation,
    right: AuthenticatedPackageInstallation
): boolean {
    return (
        left.package.id.equals(right.package.id) &&
        left.package.version.equals(right.package.version) &&
        left.package.manifestDigest.equals(right.package.manifestDigest) &&
        left.package.codeDigest.equals(right.package.codeDigest) &&
        left.packageFacet.equals(right.packageFacet) &&
        left.facet.equals(right.facet) &&
        left.materialization.equals(right.materialization)
    );
}

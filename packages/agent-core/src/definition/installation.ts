import {
    ContributionAttribution,
    FacetPackageId,
    FacetRef,
    PackageInstallationRef
} from "../facets";
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

/**
 * One-use authority to materialize a record from an authenticated package contribution.
 * It carries no public fields: only PackageInstallationProvenancePort can mint one after
 * its prepare/apply proof succeeds.
 */
class AuthenticatedContributionToken {
    readonly #brand = undefined;

    public static consume(
        candidate: AuthenticatedContributionToken
    ): ContributionAttribution | undefined {
        if (!(candidate instanceof AuthenticatedContributionToken)) return undefined;
        const attribution = authenticatedContributions.get(candidate);
        if (attribution === undefined || candidate.#brand !== undefined) return undefined;
        authenticatedContributions.delete(candidate);
        return attribution;
    }
}

export type AuthenticatedContribution = AuthenticatedContributionToken;

const authenticatedContributions = new WeakMap<
    AuthenticatedContributionToken,
    ContributionAttribution
>();

function authenticatedContribution(
    attribution: ContributionAttribution
): AuthenticatedContribution {
    const token = new AuthenticatedContributionToken();
    authenticatedContributions.set(token, attribution);
    return token;
}

/**
 * Consumes the capability so one successful provenance check authorizes one materialization.
 * A structurally forged token has no WeakMap entry and is not authority.
 */
export function consumeAuthenticatedContribution(
    candidate: AuthenticatedContribution
): ContributionAttribution | undefined {
    return AuthenticatedContributionToken.consume(candidate);
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
        return new PackageInstallationRef(
            new ContributionAttribution(installation.facet, installation.package),
            installation.packageFacet
        );
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
        const reference = new PackageInstallationRef(
            new ContributionAttribution(prepared.facet, prepared.package),
            prepared.packageFacet
        );
        this.#prepared.set(stamp, prepared);
        return Object.freeze({
            reference,
            stamp
        });
    }

    public resolveContributionForApply(
        state: State,
        context: Context,
        stamp: PreparedPackageContribution["stamp"]
    ): PackageInstallationRef | undefined {
        const expected = this.#prepared.get(stamp);
        if (expected === undefined) return undefined;
        this.#prepared.delete(stamp);
        const installation = this.authenticatedInstallation(state, context);
        if (installation === undefined) return undefined;
        requireInstallation(installation);
        if (!sameInstallation(expected, installation)) return undefined;
        return new PackageInstallationRef(
            new ContributionAttribution(installation.facet, installation.package),
            installation.packageFacet
        );
    }

    /**
     * Binds an opaque materialization capability to this synchronous prepare/apply span.
     * The callback must consume it before returning; finally revokes an unconsumed token,
     * so it cannot cross an await, restart, or RPC boundary as durable authority.
     */
    public withAuthenticatedContribution<Result>(
        state: State,
        context: Context,
        stamp: PreparedPackageContribution["stamp"],
        materialize: (contribution: AuthenticatedContribution) => Result
    ): Result | undefined {
        const installation = this.resolveContributionForApply(state, context, stamp);
        if (installation === undefined) return undefined;
        const contribution = authenticatedContribution(installation.attribution);
        try {
            return materialize(contribution);
        } finally {
            authenticatedContributions.delete(contribution);
        }
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
        left.package.equals(right.package) &&
        left.packageFacet.equals(right.packageFacet) &&
        left.facet.equals(right.facet) &&
        left.materialization.equals(right.materialization)
    );
}

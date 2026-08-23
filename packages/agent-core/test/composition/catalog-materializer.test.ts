import { describe, expect, test } from "vitest";
import { Digest, SemVer } from "../../src/core";
import {
    DeploymentId,
    ManagedOrigin,
    PackageId,
    PackageInstallationProvenancePort,
    PackagePin,
    type AuthenticatedContribution,
    type AuthenticatedPackageInstallation,
    type PreparedPackageContribution
} from "../../src/definition";
import { CatalogMaterializer } from "../../src/composition/catalog-materializer";
import { CatalogEntry } from "../../src/facets/catalog-entry";
import { MemoryWorkspaceCatalogStore } from "../../src/facets/catalog-entry-memory";
import { FacetPackageId, FacetRef } from "../../src/facets/id";
import { WorkspaceId, TenantId } from "../../src/identity";
import { descriptor, directDeclaration } from "../w3/catalog-store-contract";
import { malformed } from "../helpers/malformed";

const resize = {
    kind: "operation",
    name: "resize",
    declaration: descriptor("resize")
} as const;

describe("Catalog contribution materialization", () => {
    test("materializes an entry attributed by the minted capability alone", () => {
        const port = new TestInstallationPort(installation("workspace:installed.facet"));
        const catalog = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        // The store drives its own single transaction per write; this handle is the
        // ambient state the provenance port reads, and this port reads nothing.
        const ambient = catalog.transaction((transaction) => transaction);
        const materializer = new CatalogMaterializer(catalog, port);

        const prepared = requirePrepared(materializer.prepareContribution({}, {}));
        const entry = materializer.materialize(ambient, {}, prepared, resize);

        expect(entry.attribution?.contributor.value).toBe("workspace:installed.facet");
        expect(entry.attribution?.package.id.value).toBe("profile-package");
        expect(catalog.entries()).toHaveLength(1);
        expect(catalog.entry(entry.id)?.attribution?.equals(entry.attribution!)).toBe(true);
    });

    test("refuses a replayed or forged stamp before any record is written", () => {
        const port = new TestInstallationPort(installation("workspace:installed.facet"));
        const catalog = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        const ambient = catalog.transaction((transaction) => transaction);
        const materializer = new CatalogMaterializer(catalog, port);
        const prepared = requirePrepared(materializer.prepareContribution({}, {}));
        materializer.materialize(ambient, {}, prepared, resize);
        const revision = catalog.revision().value;

        // One prepare authorizes one apply: the second use of the stamp is a replay.
        expect(() =>
            materializer.materialize(ambient, {}, prepared, {
                kind: "operation",
                name: "other",
                declaration: descriptor("other")
            })
        ).toThrow(/provenance changed before materialization/);

        // A stamp the port never minted is refused the same way. The prepared envelope is
        // a boundary type, so only a malformed stand-in can present an unminted stamp.
        const forged = malformed<PreparedPackageContribution>({ stamp: Object.freeze({}) });
        expect(() =>
            materializer.materialize(ambient, {}, forged, {
                kind: "operation",
                name: "other",
                declaration: descriptor("other")
            })
        ).toThrow(/provenance changed before materialization/);

        expect(catalog.revision().value).toBe(revision);
        expect(catalog.entries()).toHaveLength(1);
    });

    test("refuses when the installation provenance drifts or expires between prepare and apply", () => {
        const port = new TestInstallationPort(installation("workspace:installed.facet"));
        const catalog = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        const ambient = catalog.transaction((transaction) => transaction);
        const materializer = new CatalogMaterializer(catalog, port);
        const prepared = requirePrepared(materializer.prepareContribution({}, {}));

        // A different installation answers at apply time than authorized at prepare.
        port.installation = installation("workspace:replaced.facet");
        expect(() => materializer.materialize(ambient, {}, prepared, resize)).toThrow(
            /provenance changed before materialization/
        );
        expect(catalog.entries()).toHaveLength(0);

        // The installation itself disappears, so no capability can be issued at all.
        port.installation = undefined;
        expect(() => materializer.materialize(ambient, {}, prepared, resize)).toThrow(
            /provenance changed before materialization/
        );
        expect(catalog.entries()).toHaveLength(0);
        expect(catalog.revision().value).toBe(0);
    });

    test("refuses a structurally forged capability with no provenance entry", () => {
        const forgery = new ForgeryPort();
        const catalog = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        const ambient = catalog.transaction((transaction) => transaction);
        const materializer = new CatalogMaterializer(catalog, forgery);
        const probe: ProbeState = { entries: new Map(), revision: 0 };
        const prepared = requirePrepared(forgery.prepareContribution(probe, probe));

        expect(() => materializer.materialize(ambient, probe, prepared, resize)).toThrow(
            /requires authenticated contribution provenance/
        );
        expect(catalog.entries()).toHaveLength(0);
        expect(catalog.revision().value).toBe(0);
    });

    test("a superseding release keeps exactly one attributed record per origin", () => {
        const port = new TestInstallationPort(installation("workspace:installed.facet"));
        const catalog = new MemoryWorkspaceCatalogStore(new WorkspaceId("workspace"));
        const ambient = catalog.transaction((transaction) => transaction);
        const materializer = new CatalogMaterializer(catalog, port);
        const firstEntry = materializer.materialize(
            ambient,
            {},
            requirePrepared(materializer.prepareContribution({}, {})),
            resize
        );

        port.installation = upgraded(installation("workspace:installed.facet"));
        const secondEntry = materializer.materialize(
            ambient,
            {},
            requirePrepared(materializer.prepareContribution({}, {})),
            resize
        );

        expect(secondEntry.id.equals(firstEntry.id)).toBe(false);
        expect(secondEntry.attribution!.package.version.toString()).toBe("2.0.0");
        expect(catalog.entries()).toHaveLength(1);
        expect(catalog.entry(firstEntry.id)).toBeUndefined();

        // The direct path still refuses attribution it was not minted, on either side.
        const unattributed = new CatalogEntry("operation", "resize", descriptor("resize"), undefined);
        expect(() => catalog.contribute(unattributed)).toThrow(
            /requires its authenticated attribution/
        );
        expect(() => catalog.declare(directDeclaration("crop"))).not.toThrow();
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

/** The ambient state shape a memory catalog hands its own transaction callback. */
interface ProbeState {
    readonly entries: ReadonlyMap<string, Uint8Array>;
    readonly revision: number;
}

/**
 * A port whose issued capability carries no provenance entry — what a caller-supplied or
 * structurally cloned token looks like to the consuming boundary.
 */
class ForgeryPort extends PackageInstallationProvenancePort<ProbeState, ProbeState> {
    protected authenticatedInstallation(): AuthenticatedPackageInstallation | undefined {
        return installation("workspace:installed.facet");
    }

    public override withAuthenticatedContribution<Result>(
        _state: ProbeState,
        _context: ProbeState,
        _stamp: PreparedPackageContribution["stamp"],
        materialize: (contribution: AuthenticatedContribution) => Result
    ): Result | undefined {
        return materialize(malformed<AuthenticatedContribution>({}));
    }
}

function requirePrepared(
    prepared: PreparedPackageContribution | undefined
): PreparedPackageContribution {
    if (prepared === undefined) {
        throw new TypeError("Authenticated installation did not prepare a contribution");
    }
    return prepared;
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
        materialization: managedOrigin(digest)
    });
}

function upgraded(previous: AuthenticatedPackageInstallation): AuthenticatedPackageInstallation {
    return Object.freeze({
        ...previous,
        package: new PackagePin(
            previous.package.id,
            new SemVer("2.0.0"),
            previous.package.manifestDigest,
            previous.package.codeDigest
        )
    });
}

function managedOrigin(digest: Digest): ManagedOrigin {
    return new ManagedOrigin({
        tenantId: new TenantId("tenant"),
        deploymentId: new DeploymentId("b".repeat(64)),
        attestationDigest: digest,
        blueprintDigest: digest,
        packageLockDigest: digest,
        configDigest: digest,
        generation: 1
    });
}

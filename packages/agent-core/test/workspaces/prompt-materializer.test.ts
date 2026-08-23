import { describe, expect, test } from "vitest";
import { Digest, SemVer } from "../../src/core";
import {
    DeploymentId,
    ManagedOrigin,
    PackageId,
    PackagePin,
    PackageInstallationProvenancePort,
    consumeAuthenticatedContribution,
    type AuthenticatedContribution,
    type AuthenticatedPackageInstallation,
    type PreparedPackageContribution
} from "../../src/definition";
import { WorkspaceId, TenantId } from "../../src/identity";
import {
    ContributionAttribution,
    FacetPackageId,
    FacetRef,
    MemoryWorkspacePromptSectionStore,
    Prompt,
    PromptContribution,
    PromptSection
} from "../../src/facets";
import { WorkspacePromptMaterializer } from "../../src/workspaces/prompt-materializer";
import { malformed } from "../helpers/malformed";

describe("WorkspacePromptMaterializer trusted provenance", () => {
    test(
        "[C13-FACET-CONTRIBUTION-ATTRIBUTION] attributes materialized sections to the authenticated installation, never to caller state",
        { tags: "p0" },
        () => {
            const authenticated = installation("workspace:installed.facet");
            const store = new MemoryWorkspacePromptSectionStore(new WorkspaceId("workspace"));
            const materializer = new WorkspacePromptMaterializer(store, new TestPort(authenticated));
            const prepared = prepare(materializer);

            const sections = materializer.materializeSections(
                {},
                {},
                prepared,
                new PromptContribution([new Prompt("Overview", "Overview body", 2)])
            );

            expect(sections).toHaveLength(1);
            const held = store.assembledSections();
            expect(held).toHaveLength(1);
            expect(held[0]?.attribution.contributor.equals(authenticated.facet)).toBe(true);
            expect(held[0]?.attribution.package.equals(authenticated.package)).toBe(true);
            // The record's identity digests its attribution, so the stored bytes answer
            // which Facet contributed the section without consulting the installer.
            const expected = new PromptSection(
                "Overview",
                "Overview body",
                2,
                new ContributionAttribution(authenticated.facet, authenticated.package),
                0
            );
            expect(held[0]?.id.equals(expected.id)).toBe(true);
            expect(prepared.reference.attribution.contributor.equals(authenticated.facet)).toBe(true);
        }
    );

    test("consumes a minted capability exactly once", { tags: "p0" }, () => {
        const port = new TestPort(installation("workspace:materialized.facet"));
        const prepared = port.prepareContribution({}, {});
        if (prepared === undefined) throw new TypeError("expected preparation");

        let captured: AuthenticatedContribution | undefined;
        expect(
            port.withAuthenticatedContribution({}, {}, prepared.stamp, (contribution) => {
                captured = contribution;
                return consumeAuthenticatedContribution(contribution);
            })
        ).toBeDefined();

        // The token is spent after its one synchronous span: a replayed capability carries no
        // attribution, and a structurally forged one never did.
        const replayed = captured;
        if (replayed === undefined) throw new TypeError("expected minted capability");
        expect(consumeAuthenticatedContribution(replayed)).toBeUndefined();
        expect(
            consumeAuthenticatedContribution(malformed<AuthenticatedContribution>({}))
        ).toBeUndefined();
    });

    test("refuses a stamp reused for a second materialization", { tags: "p0" }, () => {
        const authenticated = installation("workspace:once.facet");
        const store = new MemoryWorkspacePromptSectionStore(new WorkspaceId("workspace"));
        const materializer = new WorkspacePromptMaterializer(store, new TestPort(authenticated));
        const prepared = prepare(materializer);
        const contribution = new PromptContribution([new Prompt("Once", "body", 1)]);

        materializer.materializeSections({}, {}, prepared, contribution);

        expect(() =>
            materializer.materializeSections({}, {}, prepared, contribution)
        ).toThrow(/provenance changed before materialization/);
        expect(store.assembledSections()).toHaveLength(1);
        expect(store.revision().value).toBe(1);
    });

    test("fails closed when installation provenance drifts before materialization", { tags: "p0" }, () => {
        const base = installation("workspace:drifted.facet");
        const port = new TestPort(base);
        const store = new MemoryWorkspacePromptSectionStore(new WorkspaceId("workspace"));
        const materializer = new WorkspacePromptMaterializer(store, port);
        const prepared = prepare(materializer);

        port.installation = undefined;
        expect(() =>
            materializer.materializeSections(
                {},
                {},
                prepared,
                new PromptContribution([new Prompt("Drifted", "body", 1)])
            )
        ).toThrow(/provenance changed before materialization/);
        expect(store.assembledSections()).toHaveLength(0);
        expect(store.revision().value).toBe(0);

        // Substituting the installation is equally refused: the apply proof compares the
        // full installation evidence against what prepare authorized.
        const substituted = new TestPort(installation("workspace:substituted.facet"));
        const substitutedMaterializer = new WorkspacePromptMaterializer(store, substituted);
        const otherPrepared = prepare(substitutedMaterializer);
        substituted.installation = installation("workspace:elsewhere.facet");
        expect(() =>
            substitutedMaterializer.materializeSections(
                {},
                {},
                otherPrepared,
                new PromptContribution([new Prompt("Elsewhere", "body", 1)])
            )
        ).toThrow(/provenance changed before materialization/);
        expect(store.assembledSections()).toHaveLength(0);
    });

    test("fails closed when no authenticated installation exists", { tags: "p0" }, () => {
        const store = new MemoryWorkspacePromptSectionStore(new WorkspaceId("workspace"));
        const absent = new WorkspacePromptMaterializer(store, new TestPort(undefined));
        expect(absent.prepareContribution({}, {})).toBeUndefined();

        const port = new TestPort(installation("workspace:absent.facet"));
        const prepared = port.prepareContribution({}, {});
        if (prepared === undefined) throw new TypeError("expected preparation");
        port.installation = undefined;
        const vanished = new WorkspacePromptMaterializer(store, port);
        expect(() =>
            vanished.materializeSections(
                {},
                {},
                prepared,
                new PromptContribution([new Prompt("Absent", "body", 1)])
            )
        ).toThrow(/provenance changed before materialization/);
        expect(store.assembledSections()).toHaveLength(0);
    });
});

class TestPort extends PackageInstallationProvenancePort<object, object> {
    public constructor(public installation: AuthenticatedPackageInstallation | undefined) {
        super();
    }

    protected authenticatedInstallation(): AuthenticatedPackageInstallation | undefined {
        return this.installation;
    }
}

function prepare(
    materializer: WorkspacePromptMaterializer<object, object>
): PreparedPackageContribution {
    const prepared = materializer.prepareContribution({}, {});
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

import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../../src/errors";
import {
    ProtectionDomain,
    Surface,
    SurfaceActionSet,
    SurfaceId,
    View,
    ViewRequest,
    type FacetDataMap
} from "../../src/facets";
import { TenantId } from "../../src/identity";
import { ContentRef, Revision } from "../../src/record";
import type { OperationContext } from "../../src/operations";
import {
    Slate,
    SlateAppDataBoundary,
    SlateApplication,
    SlateBlueprint,
    SlateBlueprintExport,
    SlateBlueprintId,
    SlateDeployment,
    SlateDeploymentId,
    SlateDeploymentTarget,
    SlateDocument,
    SlateDocumentId,
    SlateId,
    SlateRuntime,
    MemorySlateVersionStore,
    SlateProtectionDomains,
    SlateVersion,
    SlateVersionId
} from "../../src/slates";
import { WorkspaceId } from "../../src/workspaces";
import { testOperationContext } from "../helpers/context";

class TestSlateSurface extends Surface {
    public constructor() {
        super(new SurfaceId("customer-portal-surface"), "Customer Portal");
    }

    public descriptor(): FacetDataMap {
        return { entrypoint: "src/app.tsx", kind: "slate" };
    }

    public actions(): SurfaceActionSet {
        return SurfaceActionSet.empty();
    }

    public render(_context: OperationContext, _request: ViewRequest): Promise<View> {
        return Promise.resolve(new View(
            this.id,
            Revision.initial(),
            this.descriptor(),
            "application/vnd.agent-core.slate"
        ));
    }
}

function slateApplication(): SlateApplication {
    return new SlateApplication(
        new TestSlateSurface(),
        new SlateAppDataBoundary(
            "isolated",
            new ContentRef("content://schemas/customer-portal-data"),
            "schema"
        ),
        new SlateProtectionDomains(
            new ProtectionDomain("frontend", "browser", "no-secrets"),
            new ProtectionDomain("backend", "worker", "may-hold-secrets")
        )
    );
}

function slateDocument(id: string, slateId: SlateId): SlateDocument {
    return new SlateDocument(
        new SlateDocumentId(id),
        slateId,
        new ContentRef(`content://sources/${id}`),
        "slate.v1",
        slateApplication()
    );
}

function slateVersion(id: string, document: SlateDocument): SlateVersion {
    return new SlateVersion(
        new SlateVersionId(id),
        document.slateId,
        document.id,
        document.sourceRef,
        document.schemaVersion,
        document.application
    );
}

describe("Slate", () => {
    test("models a source document as a programmable surface with data and protection boundaries", () => {
        const slateId = new SlateId("slate-customer-portal");
        const document = slateDocument("document-customer-portal", slateId);
        const version = slateVersion("version-customer-portal", document);

        expect(document.application.surface.title).toBe("Customer Portal");
        expect(document.application.appDataBoundary.persistsRuntimeData).toBe(true);
        expect(document.application.appDataBoundary.exportsRuntimeData).toBe(false);
        expect(version.documentId.equals(document.id)).toBe(true);
        expect(version.application.protectionDomains.backend.canHoldSecrets).toBe(true);
    });

    test("keeps frontend and backend protection domains distinct", () => {
        expect(() => new ProtectionDomain("frontend", "browser", "may-hold-secrets")).toThrow(TypeError);
        expect(() => new SlateProtectionDomains(
            new ProtectionDomain("backend", "worker", "no-secrets"),
            new ProtectionDomain("frontend", "browser", "no-secrets")
        )).toThrow(TypeError);
    });

    test("keeps app data outside source exports unless the boundary explicitly allows it", () => {
        expect(new SlateAppDataBoundary("none", undefined, "none").persistsRuntimeData).toBe(false);
        expect(() => new SlateAppDataBoundary(
            "none",
            new ContentRef("content://schemas/unowned"),
            "schema"
        )).toThrow(TypeError);
        expect(() => new SlateAppDataBoundary("isolated", undefined, "schema")).toThrow(TypeError);
    });

    test("publishes only owned versions and forks from an active published version", () => {
        const slateId = new SlateId("slate-publishable");
        const document = slateDocument("document-publishable", slateId);
        const version = slateVersion("version-publishable", document);
        const slate = new Slate(
            slateId,
            new WorkspaceId("workspace-publishable"),
            new TenantId("tenant-publishable"),
            "active",
            document.id,
            Revision.initial(),
            undefined,
            undefined,
            Revision.initial()
        );

        const published = slate.publish(version);
        const forked = published.fork(
            new SlateId("slate-forked"),
            new WorkspaceId("workspace-forked"),
            new SlateDocumentId("document-forked"),
            Revision.initial(),
            Revision.initial(),
            "copy"
        );

        expect(published.activeVersionId?.equals(version.id)).toBe(true);
        expect(published.canFork).toBe(true);
        expect(published.revision.value).toBe(1);
        expect(forked.activeVersionId).toBeUndefined();
        expect(forked.forkedFrom?.sourceSlateId.equals(slate.id)).toBe(true);
        expect(forked.forkedFrom?.sourceVersionId.equals(version.id)).toBe(true);
        expect(forked.forkedFrom?.appDataMode).toBe("copy");
    });

    test("rejects invalid publish and fork transitions", () => {
        const slateId = new SlateId("slate-restricted");
        const document = slateDocument("document-restricted", slateId);
        const version = slateVersion("version-restricted", document);
        const draft = new Slate(
            slateId,
            new WorkspaceId("workspace-restricted"),
            new TenantId("tenant-restricted"),
            "active",
            document.id,
            Revision.initial(),
            undefined,
            undefined,
            Revision.initial()
        );
        const archived = new Slate(
            slateId,
            new WorkspaceId("workspace-restricted"),
            new TenantId("tenant-restricted"),
            "archived",
            document.id,
            Revision.initial(),
            undefined,
            undefined,
            Revision.initial()
        );
        const foreignDocument = slateDocument("document-foreign", new SlateId("slate-foreign"));
        const foreignVersion = slateVersion("version-foreign", foreignDocument);

        expect(() => archived.publish(version)).toThrow(TypeError);
        expect(() => draft.publish(foreignVersion)).toThrow(TypeError);
        expect(() => draft.fork(
            new SlateId("slate-unpublished-fork"),
            new WorkspaceId("workspace-unpublished-fork"),
            new SlateDocumentId("document-unpublished-fork"),
            Revision.initial(),
            Revision.initial(),
            "empty"
        )).toThrow(TypeError);
    });

    test("models deployment targets and blueprint template exports without substrate details", () => {
        const slateId = new SlateId("slate-deployable");
        const document = slateDocument("document-deployable", slateId);
        const version = slateVersion("version-deployable", document);
        const deployment = new SlateDeployment(
            new SlateDeploymentId("deployment-customer-portal"),
            slateId,
            version.id,
            new SlateDeploymentTarget("public/customer-portal"),
            "pending",
            Revision.initial()
        );
        const blueprint = new SlateBlueprint(
            new SlateBlueprintId("blueprint-customer-portal"),
            version.id,
            new ContentRef("content://blueprints/customer-portal"),
            SlateBlueprintExport.template()
        );

        expect(deployment.activate().status).toBe("active");
        expect(deployment.fail().status).toBe("failed");
        expect(deployment.retire().revision.value).toBe(1);
        expect(blueprint.exportRequirements.requires("source-document")).toBe(true);
        expect(blueprint.exportRequirements.requires("app-data-schema")).toBe(true);
        expect(blueprint.exportRequirements.includesRuntimeAppData).toBe(false);
        expect(() => new SlateBlueprintExport(["source-document", "source-document"])).toThrow(TypeError);
    });

    test("renders the active Slate version through its Surface", async () => {
        const slateId = new SlateId("slate-runtime");
        const document = slateDocument("document-runtime", slateId);
        const version = slateVersion("version-runtime", document);
        const slate = new Slate(
            slateId,
            new WorkspaceId("workspace-runtime"),
            new TenantId("tenant-runtime"),
            "active",
            document.id,
            Revision.initial(),
            version.id,
            undefined,
            Revision.initial()
        );
        const runtime = new SlateRuntime(slate, new MemorySlateVersionStore([version]));

        const view = await runtime.render(testOperationContext("slate-runtime"), new ViewRequest());

        expect(view.surface.equals(version.application.surface.id)).toBe(true);
        expect(view.body).toEqual({ entrypoint: "src/app.tsx", kind: "slate" });
    });

    test("rejects rendering an unpublished Slate", async () => {
        const slateId = new SlateId("slate-unpublished-runtime");
        const document = slateDocument("document-unpublished-runtime", slateId);
        const slate = new Slate(
            slateId,
            new WorkspaceId("workspace-unpublished-runtime"),
            new TenantId("tenant-unpublished-runtime"),
            "active",
            document.id,
            Revision.initial(),
            undefined,
            undefined,
            Revision.initial()
        );
        const runtime = new SlateRuntime(slate, new MemorySlateVersionStore());

        await expect(runtime.render(testOperationContext("slate-unpublished-runtime"), new ViewRequest()))
            .rejects.toMatchObject(new AgentCoreError("slate.unpublished", "Slate has no active version"));
    });
});

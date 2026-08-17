import { describe, expect, test } from "vitest";
import { violating } from "../helpers/malformed";
import { ContentRef, Digest, Revision } from "../../src/core";
import {
    EnvironmentId,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    PortExposureId
} from "../../src/environments";
import { InvocationId, ReceiptId } from "../../src/invocations";
import {
    MemorySlateStore,
    Slate,
    SlateDeployment,
    SlateDeploymentId,
    SlateDeploymentReservation,
    SlateId,
    SlatePreview,
    SlatePreviewId,
    SlatePublication,
    SlatePublicationId,
    SlateResource,
    SlateResourceId,
    SlateResourceReservation,
    SlateVersion,
    SlateVersionId,
    type StoredSlateRecord,
    type StoredSlateReservation
} from "../../src/slates";
import { WorkspaceId } from "../../src/workspaces";

describe("MemorySlateStore mutation kills", () => {
    test("lists records in ID order scoped to their exact owner", { tags: "p1" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-list-order");
        const second = buildGraph(store, workspace, "list-b");
        const first = buildGraph(store, workspace, "list-a");
        const lateVersion = new SlateVersion(
            new SlateVersionId("version-list-a-0"),
            workspace,
            first.slate.id,
            first.slate.source
        );
        store.addVersion(lateVersion);

        expect(store.listSlates().map((slate) => slate.id.value)).toEqual([
            "slate-list-a",
            "slate-list-b"
        ]);
        expect(store.listVersions(first.slate.id).map((version) => version.id.value)).toEqual([
            "version-list-a",
            "version-list-a-0"
        ]);
        expect(
            store.listPublications(first.slate.id).map((publication) => publication.id.value)
        ).toEqual(["publication-list-a"]);
        expect(
            store.listDeployments(first.slate.id).map((deployment) => deployment.id.value)
        ).toEqual(["deployment-list-a"]);
        expect(
            store.listResources(first.deployment.id).map((resource) => resource.id.value)
        ).toEqual(["resource-list-a"]);
        expect(store.listPreviews(first.slate.id).map((preview) => preview.id.value)).toEqual([
            "preview-list-a"
        ]);
        expect(store.listPublications(second.slate.id)).toHaveLength(1);
    });

    test("snapshots order slate rows by ID and revision", { tags: "p1" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-snapshot-order");
        const slateB = Slate.initial(new SlateId("slate-order-b"), workspace, ref("b-0"));
        expect(store.compareAndSetSlate(undefined, slateB)).toBe(true);
        const slateB1 = slateB.update(ref("b-1"));
        expect(store.compareAndSetSlate(slateB.revision, slateB1)).toBe(true);
        expect(store.compareAndSetSlate(slateB1.revision, slateB1.update(ref("b-2")))).toBe(true);
        const slateA = Slate.initial(new SlateId("slate-order-a"), workspace, ref("a-0"));
        expect(store.compareAndSetSlate(undefined, slateA)).toBe(true);

        expect(store.snapshot().slates.map((row) => [row.id, row.revision])).toEqual([
            ["slate-order-a", 0],
            ["slate-order-b", 0],
            ["slate-order-b", 1],
            ["slate-order-b", 2]
        ]);
    });

    test("rejects histories with gaps or a missing first revision", { tags: "p0" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-history-gap");
        const slate = Slate.initial(new SlateId("slate-history-gap"), workspace, ref("one"));
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        const updated = slate.update(ref("two"));
        expect(store.compareAndSetSlate(slate.revision, updated)).toBe(true);
        expect(store.compareAndSetSlate(updated.revision, updated.update(ref("three")))).toBe(true);
        const snapshot = store.snapshot();
        const error = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Slate history is not a contiguous immutable replay"
        });

        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    slates: snapshot.slates.filter((row) => row.revision !== 1)
                })
        ).toThrowError(error);
        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    slates: snapshot.slates.filter((row) => row.revision !== 0)
                })
        ).toThrowError(error);
    });

    test("catches workspace and fork-origin drift across revisions", { tags: "p0" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-transition-drift");
        const slate = Slate.initial(new SlateId("slate-transition-drift"), workspace, ref("one"));
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        expect(store.compareAndSetSlate(slate.revision, slate.update(ref("two")))).toBe(true);
        const snapshot = store.snapshot();
        const movedWorkspace = new WorkspaceId("workspace-transition-moved");
        const moved = new Slate({
            id: slate.id,
            workspaceId: movedWorkspace,
            source: ref("two"),
            revision: new Revision(1)
        });
        const error = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Slate identity, workspace ownership, and fork origin are immutable"
        });

        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    slates: snapshot.slates.map((row) =>
                        row.revision === 1
                            ? {
                                  id: row.id,
                                  workspaceId: movedWorkspace,
                                  revision: 1,
                                  bytes: Slate.encode(moved)
                              }
                            : row
                    )
                })
        ).toThrowError(error);

        const forkStore = new MemorySlateStore();
        const origin = Slate.initial(
            new SlateId("slate-fork-origin"),
            workspace,
            ref("origin-source")
        );
        expect(forkStore.compareAndSetSlate(undefined, origin)).toBe(true);
        const originVersion = new SlateVersion(
            new SlateVersionId("version-fork-origin"),
            workspace,
            origin.id,
            origin.source
        );
        forkStore.addVersion(originVersion);
        const fork = new Slate({
            id: new SlateId("slate-forked-drift"),
            workspaceId: workspace,
            source: origin.source,
            forkedFrom: { slateId: origin.id, versionId: originVersion.id },
            revision: Revision.initial()
        });
        expect(forkStore.compareAndSetSlate(undefined, fork)).toBe(true);
        const forkSnapshot = forkStore.snapshot();
        const detached = new Slate({
            id: fork.id,
            workspaceId: workspace,
            source: ref("fork-next"),
            revision: new Revision(1)
        });

        expect(
            () =>
                new MemorySlateStore({
                    ...forkSnapshot,
                    slates: [
                        ...forkSnapshot.slates,
                        {
                            id: fork.id.value,
                            workspaceId: workspace,
                            revision: 1,
                            bytes: Slate.encode(detached)
                        }
                    ]
                })
        ).toThrowError(error);
    });

    test("names every dangling graph reference exactly", { tags: "p0" }, () => {
        const workspace = new WorkspaceId("workspace-dangling-exact");

        const publicationStore = new MemorySlateStore();
        const publicationGraph = buildDetachedRecords(publicationStore, workspace, "dangling-pub");
        expect(
            () =>
                new MemorySlateStore({
                    ...publicationStore.snapshot(),
                    versions: []
                })
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Slate publication has a dangling version"
            })
        );
        expect(publicationGraph.publication.slateId.value).toBe("slate-dangling-pub");

        const reservationStore = new MemorySlateStore();
        const reservationGraph = buildDetachedRecords(
            reservationStore,
            workspace,
            "dangling-reservation"
        );
        reservationStore.reserveDeployment(reservationGraph.reservation);
        expect(
            () =>
                new MemorySlateStore({
                    ...reservationStore.snapshot(),
                    publications: []
                })
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Slate deployment reservation has a dangling publication"
            })
        );

        const mismatchStore = new MemorySlateStore();
        const mismatch = buildDetachedRecords(mismatchStore, workspace, "reservation-mismatch");
        mismatchStore.reserveDeployment(mismatch.reservation);
        mismatchStore.addDeployment(mismatch.deployment);
        const changedReservation = new SlateDeploymentReservation({
            id: mismatch.reservation.id,
            workspaceId: mismatch.reservation.workspaceId,
            slateId: mismatch.reservation.slateId,
            publicationId: mismatch.reservation.publicationId,
            publicationMaterialization: mismatch.reservation.publicationMaterialization,
            target: "different-target",
            externalKey: mismatch.reservation.externalKey,
            invocationId: mismatch.reservation.invocationId
        });
        expect(
            () =>
                new MemorySlateStore({
                    ...mismatchStore.snapshot(),
                    deploymentReservations: mismatchStore
                        .snapshot()
                        .deploymentReservations.map((row) =>
                            replaceReservationBytes(
                                row,
                                SlateDeploymentReservation.encode(changedReservation)
                            )
                        )
                })
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Slate deployment does not match its reservation"
            })
        );

        const resourceStore = new MemorySlateStore();
        const resourceGraph = buildDetachedRecords(resourceStore, workspace, "resource-mismatch");
        resourceStore.reserveDeployment(resourceGraph.reservation);
        resourceStore.addDeployment(resourceGraph.deployment);
        resourceStore.reserveResource(resourceGraph.resourceReservation);
        resourceStore.addResource(resourceGraph.resource);
        const changedResourceReservation = new SlateResourceReservation({
            id: resourceGraph.resourceReservation.id,
            workspaceId: resourceGraph.resourceReservation.workspaceId,
            slateId: resourceGraph.resourceReservation.slateId,
            deploymentId: resourceGraph.resourceReservation.deploymentId,
            deploymentMaterialization: resourceGraph.resourceReservation.deploymentMaterialization,
            name: "different-name",
            source: resourceGraph.resourceReservation.source,
            invocationId: resourceGraph.resourceReservation.invocationId
        });
        expect(
            () =>
                new MemorySlateStore({
                    ...resourceStore.snapshot(),
                    resourceReservations: resourceStore
                        .snapshot()
                        .resourceReservations.map((row) =>
                            replaceReservationBytes(
                                row,
                                SlateResourceReservation.encode(changedResourceReservation)
                            )
                        )
                })
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Slate resource does not match its reservation"
            })
        );

        expect(
            () =>
                new MemorySlateStore({
                    ...resourceStore.snapshot(),
                    deployments: []
                })
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Slate resource has a dangling deployment"
            })
        );
    });

    test("refuses expectations for slates that do not exist", { tags: "p0" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-missing-expectation");
        const phantom = new Slate({
            id: new SlateId("slate-phantom"),
            workspaceId: workspace,
            source: ref("phantom"),
            revision: new Revision(1)
        });

        expect(store.compareAndSetSlate(new Revision(0), phantom)).toBe(false);
        expect(store.getSlate(phantom.id)).toBeUndefined();
        expect(store.listSlateHistory(phantom.id)).toEqual([]);
    });

    test("CAS and closure violations carry exact messages", { tags: "p1" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-exact-messages");
        const slate = Slate.initial(new SlateId("slate-exact-messages"), workspace, ref("source"));
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);

        expect(() =>
            store.compareAndSetSlate(
                slate.revision,
                new Slate({
                    id: slate.id,
                    workspaceId: workspace,
                    source: ref("skipped"),
                    revision: new Revision(2)
                })
            )
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "A Slate CAS must append the next revision"
            })
        );
        expect(() =>
            store.addVersion(
                new SlateVersion(
                    new SlateVersionId("version-unowned-exact"),
                    workspace,
                    new SlateId("slate-not-stored"),
                    slate.source
                )
            )
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Slate record must be owned by its Slate workspace"
            })
        );
        expect(() =>
            store.compareAndSetSlate(
                undefined,
                new Slate({
                    id: new SlateId("slate-missing-fork-exact"),
                    workspaceId: workspace,
                    source: slate.source,
                    forkedFrom: {
                        slateId: slate.id,
                        versionId: new SlateVersionId("version-not-stored")
                    },
                    revision: Revision.initial()
                })
            )
        ).toThrowError(
            expect.objectContaining({
                code: "slate.invalid-version",
                message: "Slate fork must reference an existing exact source version"
            })
        );
        expect(() =>
            store.compareAndSetSlate(
                undefined,
                new Slate({
                    id: new SlateId("slate-missing-head-exact"),
                    workspaceId: workspace,
                    source: ref("head"),
                    headVersionId: new SlateVersionId("version-not-stored"),
                    revision: Revision.initial()
                })
            )
        ).toThrowError(
            expect.objectContaining({
                code: "slate.invalid-version",
                message: "Slate head must reference an owned version"
            })
        );

        const version = new SlateVersion(
            new SlateVersionId("version-fork-cas"),
            workspace,
            slate.id,
            slate.source
        );
        store.addVersion(version);
        const fork = new Slate({
            id: new SlateId("slate-fork-cas"),
            workspaceId: workspace,
            source: slate.source,
            forkedFrom: { slateId: slate.id, versionId: version.id },
            revision: Revision.initial()
        });
        expect(store.compareAndSetSlate(undefined, fork)).toBe(true);
        expect(() =>
            store.compareAndSetSlate(
                fork.revision,
                new Slate({
                    id: fork.id,
                    workspaceId: workspace,
                    source: ref("detached"),
                    revision: fork.revision.next()
                })
            )
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Slate fork origin is immutable"
            })
        );

        const snapshot = store.snapshot();
        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    slates: [...snapshot.slates, snapshot.slates[0]!]
                })
        ).toThrowError(
            expect.objectContaining({
                code: "protocol.duplicate",
                message: "Slate snapshot contains duplicate history"
            })
        );
    });

    test("duplicate record snapshots name their record kinds", { tags: "p2" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-duplicate-kinds");
        buildGraph(store, workspace, "duplicate-kinds");
        const snapshot = store.snapshot();
        const cases = [
            ["publications", "Slate publications snapshot contains duplicate IDs"],
            ["deployments", "Slate deployments snapshot contains duplicate IDs"],
            ["resources", "Slate resources snapshot contains duplicate IDs"],
            ["previews", "Slate previews snapshot contains duplicate IDs"],
            ["versions", "Slate versions snapshot contains duplicate IDs"],
            [
                "deploymentReservations",
                "Slate deployment reservations snapshot contains duplicate IDs"
            ],
            ["resourceReservations", "Slate resource reservations snapshot contains duplicate IDs"]
        ] as const;

        for (const [kind, message] of cases) {
            const rows = snapshot[kind];
            expect(
                () =>
                    new MemorySlateStore({
                        ...snapshot,
                        [kind]: [...rows, rows[0]!]
                    })
            ).toThrowError(expect.objectContaining({ code: "protocol.duplicate", message }));
        }
    });

    test("rejects projection drift on workspace and slate columns", { tags: "p1" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-projection-drift");
        const slate = Slate.initial(new SlateId("slate-projection-drift"), workspace, ref("one"));
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        const version = new SlateVersion(
            new SlateVersionId("version-projection-drift"),
            workspace,
            slate.id,
            slate.source
        );
        store.addVersion(version);
        const snapshot = store.snapshot();
        const error = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Stored Slate projection does not match its codec bytes"
        });

        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    versions: snapshot.versions.map((row) => ({
                        ...row,
                        workspaceId: new WorkspaceId("workspace-projection-moved")
                    }))
                })
        ).toThrowError(error);
        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    versions: snapshot.versions.map((row) => ({
                        ...row,
                        slateId: new SlateId("slate-projection-moved")
                    }))
                })
        ).toThrowError(error);
    });

    test("lists records sorted by ID regardless of insertion order", { tags: "p1" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-insertion-order");
        const slate = Slate.initial(new SlateId("slate-insertion-order"), workspace, ref("one"));
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        store.addVersion(
            new SlateVersion(
                new SlateVersionId("version-order-z"),
                workspace,
                slate.id,
                slate.source
            )
        );
        store.addVersion(
            new SlateVersion(
                new SlateVersionId("version-order-a"),
                workspace,
                slate.id,
                slate.source
            )
        );

        expect(store.listVersions(slate.id).map((version) => version.id.value)).toEqual([
            "version-order-a",
            "version-order-z"
        ]);
    });

    test("snapshots reorder scrambled slate history rows by revision", { tags: "p1" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-scrambled-history");
        const slate = Slate.initial(new SlateId("slate-scrambled-history"), workspace, ref("r0"));
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        const second = slate.update(ref("r1"));
        expect(store.compareAndSetSlate(slate.revision, second)).toBe(true);
        expect(store.compareAndSetSlate(second.revision, second.update(ref("r2")))).toBe(true);
        const snapshot = store.snapshot();

        const restored = new MemorySlateStore({
            ...snapshot,
            slates: [...snapshot.slates].reverse()
        });

        expect(restored.snapshot().slates.map((row) => row.revision)).toEqual([0, 1, 2]);
    });

    test("refuses resources that were never reserved", { tags: "p0" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-unreserved-resource");
        const graph = buildGraph(store, workspace, "unreserved-resource");
        const resource = new SlateResource(
            new SlateResourceId("resource-never-reserved"),
            workspace,
            graph.slate.id,
            graph.deployment.id,
            "database",
            ref("unreserved-source"),
            ref("unreserved-materialization"),
            new InvocationId("invocation-never-reserved"),
            new ReceiptId("receipt-never-reserved")
        );

        expect(() => store.addResource(resource)).toThrowError(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Slate resource must match its frozen reservation"
            })
        );
        expect(store.getResource(resource.id)).toBeUndefined();
    });

    test("refuses replays that change the stored record bytes", { tags: "p0" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-changed-replay");
        const graph = buildGraph(store, workspace, "changed-replay");
        const conflicting = new SlateVersion(
            graph.version.id,
            workspace,
            graph.slate.id,
            ref("changed-replay-other-source")
        );

        expect(() => store.addVersion(conflicting)).toThrowError(
            expect.objectContaining({ code: "protocol.duplicate" })
        );
        expect(store.getVersion(graph.version.id)?.source.equals(graph.version.source)).toBe(true);
    });

    test("deployments must match every reserved field exactly", { tags: "p0" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-deployment-fields");
        const graph = buildGraph(store, workspace, "deployment-fields");
        const other = Slate.initial(
            new SlateId("slate-deployment-fields-other"),
            workspace,
            ref("deployment-fields-other")
        );
        expect(store.compareAndSetSlate(undefined, other)).toBe(true);
        const secondPublication = new SlatePublication(
            new SlatePublicationId("publication-deployment-fields-2"),
            workspace,
            graph.slate.id,
            graph.version.id,
            ref("deployment-fields-publication-2"),
            []
        );
        store.addPublication(secondPublication);
        const invocation = new InvocationId("invocation-deployment-fields");
        const id = new SlateDeploymentId("deployment-deployment-fields-new");
        store.reserveDeployment(
            new SlateDeploymentReservation({
                id,
                workspaceId: workspace,
                slateId: graph.slate.id,
                publicationId: graph.publication.id,
                publicationMaterialization: graph.publication.materialization,
                target: "production",
                externalKey: "external-deployment-fields",
                invocationId: invocation
            })
        );
        const deployment = (overrides: {
            readonly slateId?: SlateId;
            readonly publicationId?: SlatePublicationId;
            readonly target?: string;
            readonly invocationId?: InvocationId;
        }): SlateDeployment =>
            new SlateDeployment(
                id,
                workspace,
                overrides.slateId ?? graph.slate.id,
                overrides.publicationId ?? graph.publication.id,
                overrides.target ?? "production",
                ref("deployment-fields-materialization"),
                overrides.invocationId ?? invocation,
                new ReceiptId("receipt-deployment-fields")
            );
        const error = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Slate deployment must match its frozen reservation"
        });

        expect(() => store.addDeployment(deployment({ slateId: other.id }))).toThrowError(error);
        expect(() =>
            store.addDeployment(deployment({ publicationId: secondPublication.id }))
        ).toThrowError(error);
        expect(() => store.addDeployment(deployment({ target: "staging" }))).toThrowError(error);
        expect(() =>
            store.addDeployment(
                deployment({ invocationId: new InvocationId("invocation-deployment-fields-x") })
            )
        ).toThrowError(error);
        store.addDeployment(deployment({}));
        expect(store.getDeployment(id)).toBeDefined();
    });

    test("resources must match every reserved field exactly", { tags: "p0" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-resource-fields");
        const graph = buildGraph(store, workspace, "resource-fields");
        const other = Slate.initial(
            new SlateId("slate-resource-fields-other"),
            workspace,
            ref("resource-fields-other")
        );
        expect(store.compareAndSetSlate(undefined, other)).toBe(true);
        const secondInvocation = new InvocationId("invocation-resource-fields-second");
        const secondDeployment = new SlateDeployment(
            new SlateDeploymentId("deployment-resource-fields-2"),
            workspace,
            graph.slate.id,
            graph.publication.id,
            "production",
            ref("resource-fields-deployment-2"),
            secondInvocation,
            new ReceiptId("receipt-resource-fields-2")
        );
        store.reserveDeployment(
            new SlateDeploymentReservation({
                id: secondDeployment.id,
                workspaceId: workspace,
                slateId: graph.slate.id,
                publicationId: graph.publication.id,
                publicationMaterialization: graph.publication.materialization,
                target: secondDeployment.target,
                externalKey: "external-resource-fields-2",
                invocationId: secondInvocation
            })
        );
        store.addDeployment(secondDeployment);
        const invocation = new InvocationId("invocation-resource-fields");
        const id = new SlateResourceId("resource-resource-fields-new");
        const reservedSource = ref("resource-fields-source");
        store.reserveResource(
            new SlateResourceReservation({
                id,
                workspaceId: workspace,
                slateId: graph.slate.id,
                deploymentId: graph.deployment.id,
                deploymentMaterialization: graph.deployment.materialization,
                name: "database",
                source: reservedSource,
                invocationId: invocation
            })
        );
        const resource = (overrides: {
            readonly slateId?: SlateId;
            readonly deploymentId?: SlateDeploymentId;
            readonly name?: string;
            readonly source?: ContentRef;
            readonly invocationId?: InvocationId;
        }): SlateResource =>
            new SlateResource(
                id,
                workspace,
                overrides.slateId ?? graph.slate.id,
                overrides.deploymentId ?? graph.deployment.id,
                overrides.name ?? "database",
                overrides.source ?? reservedSource,
                ref("resource-fields-materialization"),
                overrides.invocationId ?? invocation,
                new ReceiptId("receipt-resource-fields")
            );
        const error = expect.objectContaining({
            code: "protocol.invalid-state",
            message: "Slate resource must match its frozen reservation"
        });

        expect(() => store.addResource(resource({ slateId: other.id }))).toThrowError(error);
        expect(() =>
            store.addResource(resource({ deploymentId: secondDeployment.id }))
        ).toThrowError(error);
        expect(() => store.addResource(resource({ name: "cache" }))).toThrowError(error);
        expect(() =>
            store.addResource(resource({ source: ref("resource-fields-drifted") }))
        ).toThrowError(error);
        expect(() =>
            store.addResource(
                resource({ invocationId: new InvocationId("invocation-resource-fields-x") })
            )
        ).toThrowError(error);
        store.addResource(resource({}));
        expect(store.getResource(id)).toBeDefined();
    });

    test("rejects slate rows whose key column drifts from their bytes", { tags: "p1" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-row-alias");
        const slate = Slate.initial(new SlateId("slate-row-alias"), workspace, ref("aliased"));
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        const snapshot = store.snapshot();

        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    slates: snapshot.slates.map((row) => ({
                        ...row,
                        id: "slate-row-alias-other"
                    }))
                })
        ).toThrowError(expect.objectContaining({ code: "protocol.invalid-state" }));
    });

    test("refuses attaching a fork origin to an existing slate", { tags: "p0" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-fork-attach");
        const origin = Slate.initial(
            new SlateId("slate-fork-attach-origin"),
            workspace,
            ref("fork-attach-origin")
        );
        expect(store.compareAndSetSlate(undefined, origin)).toBe(true);
        const originVersion = new SlateVersion(
            new SlateVersionId("version-fork-attach-origin"),
            workspace,
            origin.id,
            origin.source
        );
        store.addVersion(originVersion);
        const slate = Slate.initial(
            new SlateId("slate-fork-attach"),
            workspace,
            ref("fork-attach-source")
        );
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        const forged = new Slate({
            id: slate.id,
            workspaceId: workspace,
            source: origin.source,
            forkedFrom: { slateId: origin.id, versionId: originVersion.id },
            revision: new Revision(1)
        });

        expect(() => store.compareAndSetSlate(slate.revision, forged)).toThrowError(
            expect.objectContaining({ code: "protocol.invalid-state" })
        );
        expect(store.getSlate(slate.id)?.forkedFrom).toBeUndefined();
    });

    test("record rows must carry branded workspace and slate columns", { tags: "p2" }, () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-branded-columns");
        const slate = Slate.initial(new SlateId("slate-branded-columns"), workspace, ref("one"));
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        store.addVersion(
            new SlateVersion(
                new SlateVersionId("version-branded-columns"),
                workspace,
                slate.id,
                slate.source
            )
        );
        const snapshot = store.snapshot();
        const forged = violating<WorkspaceId>({ value: workspace.value });

        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    versions: snapshot.versions.map((row) => ({ ...row, workspaceId: forged }))
                })
        ).toThrowError(expect.objectContaining({ code: "protocol.invalid-state" }));
    });
});

let sharedKeyCounter = 0;

/** One Slate with every record that hangs off it, all already stored. */
type SlateRecordGraph = {
    readonly slate: Slate;
    readonly version: SlateVersion;
    readonly publication: SlatePublication;
    readonly deployment: SlateDeployment;
    readonly resource: SlateResource;
};

/** The same graph plus the reservations each record was claimed under. */
type DetachedSlateRecords = {
    readonly slate: Slate;
    readonly version: SlateVersion;
    readonly publication: SlatePublication;
    readonly reservation: SlateDeploymentReservation;
    readonly deployment: SlateDeployment;
    readonly resourceReservation: SlateResourceReservation;
    readonly resource: SlateResource;
};

function buildGraph(
    store: MemorySlateStore,
    workspace: WorkspaceId,
    label: string
): SlateRecordGraph {
    const slate = Slate.initial(new SlateId(`slate-${label}`), workspace, ref(`${label}-source`));
    expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
    const version = new SlateVersion(
        new SlateVersionId(`version-${label}`),
        workspace,
        slate.id,
        slate.source
    );
    store.addVersion(version);
    const publication = new SlatePublication(
        new SlatePublicationId(`publication-${label}`),
        workspace,
        slate.id,
        version.id,
        ref(`${label}-publication`),
        []
    );
    store.addPublication(publication);
    const invocation = new InvocationId(`invocation-${label}`);
    const deployment = new SlateDeployment(
        new SlateDeploymentId(`deployment-${label}`),
        workspace,
        slate.id,
        publication.id,
        "production",
        ref(`${label}-deployment`),
        invocation,
        new ReceiptId(`receipt-${label}`)
    );
    store.reserveDeployment(
        new SlateDeploymentReservation({
            id: deployment.id,
            workspaceId: workspace,
            slateId: slate.id,
            publicationId: publication.id,
            publicationMaterialization: publication.materialization,
            target: deployment.target,
            externalKey: `external-mutation-${sharedKeyCounter++}`,
            invocationId: invocation
        })
    );
    store.addDeployment(deployment);
    const resource = new SlateResource(
        new SlateResourceId(`resource-${label}`),
        workspace,
        slate.id,
        deployment.id,
        "database",
        ref(`${label}-resource-source`),
        ref(`${label}-resource`),
        invocation,
        new ReceiptId(`receipt-resource-${label}`)
    );
    store.reserveResource(
        new SlateResourceReservation({
            id: resource.id,
            workspaceId: workspace,
            slateId: slate.id,
            deploymentId: deployment.id,
            deploymentMaterialization: deployment.materialization,
            name: resource.name,
            source: resource.source,
            invocationId: invocation
        })
    );
    store.addResource(resource);
    store.addPreview(
        new SlatePreview(
            new SlatePreviewId(`preview-${label}`),
            workspace,
            slate.id,
            new EnvironmentSessionCapability(
                new EnvironmentId(`environment-${label}`),
                new EnvironmentSessionId(`session-${label}`),
                Revision.initial(),
                0
            ),
            new PortExposureId(`exposure-${label}`),
            slate.source
        )
    );
    return { slate, version, publication, deployment, resource };
}

function buildDetachedRecords(
    store: MemorySlateStore,
    workspace: WorkspaceId,
    label: string
): DetachedSlateRecords {
    const slate = Slate.initial(new SlateId(`slate-${label}`), workspace, ref(`${label}-source`));
    expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
    const version = new SlateVersion(
        new SlateVersionId(`version-${label}`),
        workspace,
        slate.id,
        slate.source
    );
    store.addVersion(version);
    const publication = new SlatePublication(
        new SlatePublicationId(`publication-${label}`),
        workspace,
        slate.id,
        version.id,
        ref(`${label}-publication`),
        []
    );
    store.addPublication(publication);
    const invocation = new InvocationId(`invocation-${label}`);
    const deployment = new SlateDeployment(
        new SlateDeploymentId(`deployment-${label}`),
        workspace,
        slate.id,
        publication.id,
        "production",
        ref(`${label}-deployment`),
        invocation,
        new ReceiptId(`receipt-${label}`)
    );
    const reservation = new SlateDeploymentReservation({
        id: deployment.id,
        workspaceId: workspace,
        slateId: slate.id,
        publicationId: publication.id,
        publicationMaterialization: publication.materialization,
        target: deployment.target,
        externalKey: `external-mutation-${sharedKeyCounter++}`,
        invocationId: invocation
    });
    const resource = new SlateResource(
        new SlateResourceId(`resource-${label}`),
        workspace,
        slate.id,
        deployment.id,
        "database",
        ref(`${label}-resource-source`),
        ref(`${label}-resource`),
        invocation,
        new ReceiptId(`receipt-resource-${label}`)
    );
    const resourceReservation = new SlateResourceReservation({
        id: resource.id,
        workspaceId: workspace,
        slateId: slate.id,
        deploymentId: deployment.id,
        deploymentMaterialization: deployment.materialization,
        name: resource.name,
        source: resource.source,
        invocationId: invocation
    });
    return {
        slate,
        version,
        publication,
        reservation,
        deployment,
        resourceReservation,
        resource
    };
}

function replaceReservationBytes(
    row: StoredSlateReservation,
    bytes: Uint8Array
): StoredSlateReservation {
    const replacement: StoredSlateRecord & StoredSlateReservation = {
        id: row.id,
        workspaceId: row.workspaceId,
        slateId: row.slateId,
        invocationId: row.invocationId,
        bytes
    };
    return replacement;
}

function ref(label: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(label)));
}

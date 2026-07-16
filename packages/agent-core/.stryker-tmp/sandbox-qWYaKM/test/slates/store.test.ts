// @ts-nocheck
let externalKeyCounter = 0;
import { describe, expect, test } from "vitest";
import { ContentRef, Digest, Revision } from "../../src/core";
import {
    EnvironmentId,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    PortExposureId
} from "../../src/environments";
import { AgentCoreError } from "../../src/errors";
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
    type MemorySlateSnapshot
} from "../../src/slates";
import { WorkspaceId } from "../../src/workspaces";

describe("MemorySlateStore", () => {
    test("[P11-SLATE-IMMUTABLE-PUBLICATION] [slate] [slate.version] [slate.publication] [slate.deployment] [slate.resource] [slate.preview] retains immutable Slate history and restores detached codec bytes", () => {
        const store = new MemorySlateStore();
        const slate = Slate.initial(
            new SlateId("slate-history"),
            new WorkspaceId("workspace-history"),
            ref("source-one")
        );
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        const updated = slate.update(ref("source-two"));
        expect(store.compareAndSetSlate(slate.revision, updated)).toBe(true);
        const version = new SlateVersion(
            new SlateVersionId("version-history"),
            slate.workspaceId,
            slate.id,
            updated.source
        );
        store.addVersion(version);
        const committed = updated.commit(version.id);
        expect(store.compareAndSetSlate(updated.revision, committed)).toBe(true);
        const editedAfterCommit = committed.update(ref("source-three"));
        expect(store.compareAndSetSlate(committed.revision, editedAfterCommit)).toBe(true);

        expect(store.listSlateHistory(slate.id).map((item) => item.revision.value)).toEqual([
            0, 1, 2, 3
        ]);
        expect(
            store.getSlateRevision(slate.id, Revision.initial())?.source.equals(slate.source)
        ).toBe(true);

        const snapshot = store.snapshot();
        const restored = new MemorySlateStore(snapshot);
        snapshot.slates[0]!.bytes.fill(0);
        snapshot.versions[0]!.bytes.fill(0);

        expect(restored.getSlate(slate.id)?.headVersionId?.equals(version.id)).toBe(true);
        expect(restored.getVersion(version.id)?.source.equals(updated.source)).toBe(true);
        expect(store.getSlate(slate.id)?.revision.value).toBe(3);
    });

    test("enforces CAS and immutable record replay", () => {
        const store = new MemorySlateStore();
        const slate = Slate.initial(
            new SlateId("slate-cas"),
            new WorkspaceId("workspace-cas"),
            ref("cas")
        );
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        expect(store.compareAndSetSlate(undefined, slate)).toBe(false);
        expect(store.compareAndSetSlate(new Revision(9), slate.update(ref("other")))).toBe(false);

        const version = new SlateVersion(
            new SlateVersionId("version-cas"),
            slate.workspaceId,
            slate.id,
            slate.source
        );
        store.addVersion(version);
        expect(() =>
            store.addVersion(
                new SlateVersion(version.id, slate.workspaceId, slate.id, ref("different"))
            )
        ).toThrow(
            new AgentCoreError(
                "protocol.duplicate",
                `Slate record ${version.id.value} is immutable`
            )
        );
    });

    test("rejects projection corruption and non-contiguous replay snapshots", () => {
        const store = new MemorySlateStore();
        const slate = Slate.initial(
            new SlateId("slate-corrupt"),
            new WorkspaceId("workspace-corrupt"),
            ref("corrupt")
        );
        store.compareAndSetSlate(undefined, slate);
        const snapshot = store.snapshot();

        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    slates: [{ ...snapshot.slates[0]!, workspaceId: new WorkspaceId("wrong") }]
                })
        ).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Stored Slate projection does not match its codec bytes"
            )
        );
        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    slates: [{ ...snapshot.slates[0]!, revision: 1 }]
                } as MemorySlateSnapshot)
        ).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Stored Slate projection does not match its codec bytes"
            )
        );
    });

    test("commits synchronous transactions atomically and rolls back failed or async drafts", async () => {
        const store = new MemorySlateStore();
        const slate = Slate.initial(
            new SlateId("slate-transaction"),
            new WorkspaceId("workspace-transaction"),
            ref("transaction")
        );
        store.compareAndSetSlate(undefined, slate);
        const failedVersion = new SlateVersion(
            new SlateVersionId("version-failed"),
            slate.workspaceId,
            slate.id,
            slate.source
        );

        expect(() =>
            store.transaction((transaction) => {
                transaction.addVersion(failedVersion);
                throw new TypeError("abort transaction");
            })
        ).toThrow(/abort transaction/);
        expect(store.getVersion(failedVersion.id)).toBeUndefined();

        const asyncVersion = new SlateVersion(
            new SlateVersionId("version-async"),
            slate.workspaceId,
            slate.id,
            slate.source
        );
        expect(() =>
            store.transaction(async (transaction) => {
                transaction.addVersion(asyncVersion);
                await Promise.resolve();
            })
        ).toThrow(/synchronous/);
        expect(store.getVersion(asyncVersion.id)).toBeUndefined();
        await Promise.resolve();
        expect(store.getVersion(asyncVersion.id)).toBeUndefined();

        const committedVersion = new SlateVersion(
            new SlateVersionId("version-committed"),
            slate.workspaceId,
            slate.id,
            slate.source
        );
        store.transaction((transaction) => {
            transaction.addVersion(committedVersion);
            expect(
                transaction.compareAndSetSlate(slate.revision, slate.commit(committedVersion.id))
            ).toBe(true);
        });
        expect(store.getVersion(committedVersion.id)).toBeDefined();
        expect(store.getSlate(slate.id)?.headVersionId?.equals(committedVersion.id)).toBe(true);
    });

    test("lists and clones a complete owned Slate graph without leaking mutable storage", () => {
        const graph = completeGraph("lists");
        const clone = graph.store.clone();

        expect(clone.listSlates().map((record) => record.id.value)).toEqual([graph.slate.id.value]);
        expect(clone.listSlates(graph.workspace)).toHaveLength(1);
        expect(clone.listSlates(new WorkspaceId("workspace-other"))).toEqual([]);
        expect(clone.listVersions(graph.slate.id).map((record) => record.id.value)).toEqual([
            graph.version.id.value
        ]);
        expect(clone.listPublications(graph.slate.id).map((record) => record.id.value)).toEqual([
            graph.publication.id.value
        ]);
        expect(clone.listDeployments(graph.slate.id).map((record) => record.id.value)).toEqual([
            graph.deployment.id.value
        ]);
        expect(clone.listResources(graph.deployment.id).map((record) => record.id.value)).toEqual([
            graph.resource.id.value
        ]);
        expect(clone.listPreviews(graph.slate.id).map((record) => record.id.value)).toEqual([
            graph.preview.id.value
        ]);
        expect(
            clone.getPreview(graph.preview.id)?.exposureId.equals(graph.preview.exposureId)
        ).toBe(true);

        clone.compareAndSetSlate(graph.current.revision, graph.current.update(ref("clone-only")));
        expect(graph.store.getSlate(graph.slate.id)?.revision.value).toBe(
            graph.current.revision.value
        );
    });

    test("rejects broken graph projections and dangling reservations during restore", () => {
        const graph = completeGraph("restore-corruption");
        const snapshot = graph.store.snapshot();
        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    versions: snapshot.versions.map((row) => ({ ...row, id: "wrong-version" }))
                })
        ).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Stored Slate projection does not match its codec bytes"
            )
        );
        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    deploymentReservations: snapshot.deploymentReservations.map((row) => ({
                        ...row,
                        invocationId: new InvocationId("wrong-invocation")
                    }))
                })
        ).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Stored Slate reservation invocation does not match its codec bytes"
            )
        );
        expect(() => new MemorySlateStore({ ...snapshot, deployments: [] })).toThrow(
            new AgentCoreError(
                "protocol.invalid-state",
                "Slate active deployment must be a successful owned deployment"
            )
        );
        expect(
            () =>
                new MemorySlateStore({
                    ...snapshot,
                    versions: [...snapshot.versions, snapshot.versions[0]!]
                })
        ).toThrow(
            new AgentCoreError(
                "protocol.duplicate",
                "Slate versions snapshot contains duplicate IDs"
            )
        );
    });

    test("rejects noncontiguous CAS updates and immutable ownership changes", () => {
        const store = new MemorySlateStore();
        const slate = Slate.initial(
            new SlateId("slate-invalid-cas"),
            new WorkspaceId("workspace-cas"),
            ref("one")
        );
        expect(() => store.compareAndSetSlate(undefined, slate.update(ref("two")))).toThrow(
            new AgentCoreError("protocol.invalid-state", "A new Slate must start at revision zero")
        );
        expect(store.compareAndSetSlate(undefined, slate)).toBe(true);
        expect(() =>
            store.compareAndSetSlate(
                slate.revision,
                new Slate({
                    id: slate.id,
                    workspaceId: new WorkspaceId("workspace-moved"),
                    source: ref("two"),
                    revision: slate.revision.next()
                })
            )
        ).toThrow(
            new AgentCoreError("protocol.invalid-state", "Slate workspace ownership is immutable")
        );
        expect(() =>
            store.addVersion(
                new SlateVersion(
                    new SlateVersionId("version-dangling-parent"),
                    slate.workspaceId,
                    slate.id,
                    slate.source,
                    new SlateVersionId("version-missing")
                )
            )
        ).toThrow(
            new AgentCoreError(
                "slate.invalid-version",
                "Slate version parent must exist in the same Slate"
            )
        );
    });

    test("uses the shared taxonomy for graph and reservation invariants", () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-invariants");
        const slate = Slate.initial(new SlateId("slate-invariants"), workspace, ref("source"));
        store.compareAndSetSlate(undefined, slate);

        expectCode(
            () =>
                store.compareAndSetSlate(
                    slate.revision,
                    new Slate({
                        id: slate.id,
                        workspaceId: workspace,
                        source: ref("skipped"),
                        revision: new Revision(2)
                    })
                ),
            "protocol.invalid-state"
        );
        expectCode(
            () =>
                store.addVersion(
                    new SlateVersion(
                        new SlateVersionId("version-unowned"),
                        workspace,
                        new SlateId("slate-missing"),
                        slate.source
                    )
                ),
            "protocol.invalid-state"
        );
        expectCode(
            () =>
                store.addPublication(
                    new SlatePublication(
                        new SlatePublicationId("publication-missing-version"),
                        workspace,
                        slate.id,
                        new SlateVersionId("version-missing"),
                        ref("publication")
                    )
                ),
            "slate.invalid-version"
        );

        const invocation = new InvocationId("invocation-invariants");
        expectCode(
            () =>
                store.reserveDeployment(
                    new SlateDeploymentReservation({
                        id: new SlateDeploymentId("deployment-unpublished"),
                        workspaceId: workspace,
                        slateId: slate.id,
                        publicationId: new SlatePublicationId("publication-missing"),
                        publicationMaterialization: ref("publication"),
                        target: "production",
                        externalKey: `external-${externalKeyCounter++}`,
                        invocationId: invocation
                    })
                ),
            "slate.unpublished"
        );
        expectCode(
            () =>
                store.addDeployment(
                    new SlateDeployment(
                        new SlateDeploymentId("deployment-unreserved"),
                        workspace,
                        slate.id,
                        new SlatePublicationId("publication-missing"),
                        "production",
                        ref("deployment"),
                        invocation,
                        new ReceiptId("receipt-unreserved")
                    )
                ),
            "protocol.invalid-state"
        );
        expectCode(
            () =>
                store.reserveResource(
                    new SlateResourceReservation({
                        id: new SlateResourceId("resource-missing-deployment"),
                        workspaceId: workspace,
                        slateId: slate.id,
                        deploymentId: new SlateDeploymentId("deployment-missing"),
                        deploymentMaterialization: ref("deployment"),
                        name: "database",
                        source: ref("schema"),
                        invocationId: invocation
                    })
                ),
            "protocol.invalid-state"
        );

        const capability = new EnvironmentSessionCapability(
            new EnvironmentId("environment-invariants"),
            new EnvironmentSessionId("session-invariants"),
            Revision.initial(),
            0
        );
        expectCode(
            () =>
                store.addPreview(
                    new SlatePreview(
                        new SlatePreviewId("preview-stale"),
                        workspace,
                        slate.id,
                        capability,
                        new PortExposureId("exposure-stale"),
                        ref("stale")
                    )
                ),
            "protocol.revision-conflict"
        );
        expectCode(
            () =>
                store.addPreview(
                    new SlatePreview(
                        new SlatePreviewId("preview-invalid-version"),
                        workspace,
                        slate.id,
                        capability,
                        new PortExposureId("exposure-invalid-version"),
                        slate.source,
                        new SlateVersionId("version-missing")
                    )
                ),
            "slate.invalid-version"
        );

        expectCode(
            () =>
                new MemorySlateStore({
                    ...store.snapshot(),
                    slates: [...store.snapshot().slates, store.snapshot().slates[0]!]
                }),
            "protocol.duplicate"
        );
        expectCode(
            () =>
                new MemorySlateStore({
                    ...store.snapshot(),
                    slates: [
                        ...store.snapshot().slates,
                        {
                            id: "slate-missing-head",
                            workspaceId: workspace,
                            revision: 0,
                            bytes: Slate.encode(
                                new Slate({
                                    id: new SlateId("slate-missing-head"),
                                    workspaceId: workspace,
                                    source: ref("head"),
                                    headVersionId: new SlateVersionId("version-missing"),
                                    revision: Revision.initial()
                                })
                            )
                        }
                    ]
                }),
            "slate.invalid-version"
        );
        expectCode(
            () =>
                store.compareAndSetSlate(
                    undefined,
                    new Slate({
                        id: new SlateId("slate-unpublished-head"),
                        workspaceId: workspace,
                        source: ref("unpublished"),
                        latestPublicationId: new SlatePublicationId("publication-missing"),
                        revision: Revision.initial()
                    })
                ),
            "slate.unpublished"
        );
    });

    test("[slate.deployment-reservation] [slate.resource-reservation] validates reservation constructors and immutable reservation replay", () => {
        const graph = completeGraph("reservation-replay");
        expect(
            () =>
                new SlateDeploymentReservation({
                    id: graph.deployment.id,
                    workspaceId: graph.workspace,
                    slateId: graph.slate.id,
                    publicationId: graph.publication.id,
                    publicationMaterialization: graph.publication.materialization,
                    target: graph.deployment.target,
                    externalKey: "external-invalid-invocation",
                    invocationId: "invalid" as unknown as InvocationId
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new SlateResourceReservation({
                    id: graph.resource.id,
                    workspaceId: graph.workspace,
                    slateId: graph.slate.id,
                    deploymentId: graph.deployment.id,
                    deploymentMaterialization: graph.deployment.materialization,
                    name: graph.resource.name,
                    source: graph.resource.source,
                    invocationId: "invalid" as unknown as InvocationId
                })
        ).toThrow(TypeError);

        const deploymentReservation = graph.store.getDeploymentReservation(graph.deployment.id)!;
        expect(Object.isFrozen(deploymentReservation)).toBe(true);
        expect(
            SlateDeploymentReservation.decode(
                SlateDeploymentReservation.encode(deploymentReservation)
            )
        ).toEqual(deploymentReservation);
        graph.store.reserveDeployment(deploymentReservation);
        expect(() =>
            graph.store.reserveDeployment(
                new SlateDeploymentReservation({
                    id: deploymentReservation.id,
                    workspaceId: deploymentReservation.workspaceId,
                    slateId: deploymentReservation.slateId,
                    publicationId: deploymentReservation.publicationId,
                    publicationMaterialization: deploymentReservation.publicationMaterialization,
                    target: "different",
                    externalKey: `external-${externalKeyCounter++}`,
                    invocationId: deploymentReservation.invocationId
                })
            )
        ).toThrowError(expect.objectContaining({ code: "protocol.duplicate" }));

        const resourceReservation = graph.store.getResourceReservation(graph.resource.id)!;
        expect(Object.isFrozen(resourceReservation)).toBe(true);
        expect(
            SlateResourceReservation.decode(SlateResourceReservation.encode(resourceReservation))
        ).toEqual(resourceReservation);
        graph.store.reserveResource(resourceReservation);
        expect(() =>
            graph.store.reserveResource(
                new SlateResourceReservation({
                    id: resourceReservation.id,
                    workspaceId: resourceReservation.workspaceId,
                    slateId: resourceReservation.slateId,
                    deploymentId: resourceReservation.deploymentId,
                    deploymentMaterialization: resourceReservation.deploymentMaterialization,
                    name: "different",
                    source: resourceReservation.source,
                    invocationId: resourceReservation.invocationId
                })
            )
        ).toThrowError(expect.objectContaining({ code: "protocol.duplicate" }));
    });

    test("rejects missing replay roots and dangling owned graph records", () => {
        const graph = completeGraph("dangling-replay");
        const snapshot = graph.store.snapshot();
        const invalidSnapshots: MemorySlateSnapshot[] = [
            { ...snapshot, slates: snapshot.slates.slice(1) },
            { ...snapshot, versions: [] },
            { ...snapshot, publications: [] },
            { ...snapshot, deploymentReservations: [] },
            { ...snapshot, resourceReservations: [] },
            {
                ...snapshot,
                deploymentReservations: snapshot.deploymentReservations.map((row) => ({
                    ...row,
                    id: "wrong-deployment-reservation"
                }))
            },
            {
                ...snapshot,
                resources: snapshot.resources.map((row) => ({ ...row, id: "wrong-resource" }))
            }
        ];
        for (const invalid of invalidSnapshots) {
            expect(() => new MemorySlateStore(invalid)).toThrow(AgentCoreError);
        }
    });

    test("rejects fork-origin mutation and accepts exact parent-version lineage", () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-lineage");
        const slate = Slate.initial(new SlateId("slate-lineage"), workspace, ref("source"));
        store.compareAndSetSlate(undefined, slate);
        const parent = new SlateVersion(
            new SlateVersionId("version-lineage-parent"),
            workspace,
            slate.id,
            slate.source
        );
        store.addVersion(parent);
        const child = new SlateVersion(
            new SlateVersionId("version-lineage-child"),
            workspace,
            slate.id,
            slate.source,
            parent.id
        );
        expect(() => store.addVersion(child)).not.toThrow();

        const fork = new Slate({
            id: new SlateId("slate-lineage-fork"),
            workspaceId: workspace,
            source: parent.source,
            forkedFrom: { slateId: slate.id, versionId: parent.id },
            revision: Revision.initial()
        });
        store.compareAndSetSlate(undefined, fork);
        expect(() =>
            store.compareAndSetSlate(
                fork.revision,
                new Slate({
                    id: fork.id,
                    workspaceId: workspace,
                    source: ref("changed"),
                    revision: fork.revision.next()
                })
            )
        ).toThrowError(expect.objectContaining({ code: "protocol.invalid-state" }));
        expect(store.getSlateRevision(slate.id, new Revision(99))).toBeUndefined();

        const graph = completeGraph("resource-reservation-mismatch");
        expect(() =>
            graph.store.addResource(
                new SlateResource(
                    graph.resource.id,
                    graph.workspace,
                    graph.slate.id,
                    graph.deployment.id,
                    "different",
                    graph.resource.source,
                    graph.resource.materialization,
                    graph.resource.invocationId,
                    graph.resource.receiptId
                )
            )
        ).toThrowError(expect.objectContaining({ code: "protocol.invalid-state" }));
    });

    test("restores unordered history and rejects dangling parent, deployment, resource, and preview graphs", () => {
        const complete = completeGraph("restart-edges");
        const completeSnapshot = complete.store.snapshot();
        expect(
            new MemorySlateStore({
                ...completeSnapshot,
                slates: [...completeSnapshot.slates].reverse()
            }).getSlate(complete.slate.id)?.revision
        ).toEqual(complete.current.revision);

        const lineageStore = new MemorySlateStore();
        const lineageWorkspace = new WorkspaceId("workspace-dangling-parent");
        const lineageSlate = Slate.initial(
            new SlateId("slate-dangling-parent"),
            lineageWorkspace,
            ref("dangling-parent")
        );
        lineageStore.compareAndSetSlate(undefined, lineageSlate);
        const parent = new SlateVersion(
            new SlateVersionId("version-dangling-parent-root"),
            lineageWorkspace,
            lineageSlate.id,
            lineageSlate.source
        );
        const child = new SlateVersion(
            new SlateVersionId("version-dangling-parent-child"),
            lineageWorkspace,
            lineageSlate.id,
            lineageSlate.source,
            parent.id
        );
        lineageStore.addVersion(parent);
        lineageStore.addVersion(child);
        const lineageSnapshot = lineageStore.snapshot();
        expect(
            () =>
                new MemorySlateStore({
                    ...lineageSnapshot,
                    versions: lineageSnapshot.versions.filter((row) => row.id !== parent.id.value)
                })
        ).toThrow(/dangling parent/);

        const publishedHistory = completeSnapshot.slates.slice(0, -1);
        expect(
            () =>
                new MemorySlateStore({
                    ...completeSnapshot,
                    slates: publishedHistory,
                    deployments: []
                })
        ).toThrow(/dangling deployment/);
        expect(
            () =>
                new MemorySlateStore({
                    ...completeSnapshot,
                    slates: publishedHistory,
                    deployments: [],
                    resources: []
                })
        ).toThrow(/resource reservation has a dangling deployment/);

        const previewStore = new MemorySlateStore();
        const previewWorkspace = new WorkspaceId("workspace-versioned-preview");
        const previewSlate = Slate.initial(
            new SlateId("slate-versioned-preview"),
            previewWorkspace,
            ref("versioned-preview")
        );
        previewStore.compareAndSetSlate(undefined, previewSlate);
        const previewVersion = new SlateVersion(
            new SlateVersionId("version-versioned-preview"),
            previewWorkspace,
            previewSlate.id,
            previewSlate.source
        );
        previewStore.addVersion(previewVersion);
        previewStore.addPreview(
            new SlatePreview(
                new SlatePreviewId("preview-versioned"),
                previewWorkspace,
                previewSlate.id,
                new EnvironmentSessionCapability(
                    new EnvironmentId("environment-versioned"),
                    new EnvironmentSessionId("session-versioned"),
                    Revision.initial(),
                    0
                ),
                new PortExposureId("exposure-versioned"),
                previewVersion.source,
                previewVersion.id
            )
        );
        const previewSnapshot = previewStore.snapshot();
        expect(() => new MemorySlateStore({ ...previewSnapshot, versions: [] })).toThrow(
            /preview has a dangling or inexact source/
        );
    });

    test("rejects fork closure and resource finalization after their durable dependencies disappear", () => {
        const store = new MemorySlateStore();
        const workspace = new WorkspaceId("workspace-fork-closure");
        const source = Slate.initial(new SlateId("slate-fork-source"), workspace, ref("source"));
        store.compareAndSetSlate(undefined, source);
        expect(() =>
            store.compareAndSetSlate(
                undefined,
                new Slate({
                    id: new SlateId("slate-invalid-fork"),
                    workspaceId: workspace,
                    source: source.source,
                    forkedFrom: {
                        slateId: source.id,
                        versionId: new SlateVersionId("version-missing-fork")
                    },
                    revision: Revision.initial()
                })
            )
        ).toThrowError(expect.objectContaining({ code: "slate.invalid-version" }));

        const graph = completeGraph("resource-dependency-loss");
        const hidden = new HiddenDeploymentSlateStore(graph.store.snapshot());
        hidden.hideDeployments = true;
        expect(() => hidden.addResource(graph.resource)).toThrow(/deployment must exist/);
    });
});

class HiddenDeploymentSlateStore extends MemorySlateStore {
    public hideDeployments = false;

    public override getDeployment(id: SlateDeploymentId): SlateDeployment | undefined {
        return this.hideDeployments ? undefined : super.getDeployment(id);
    }
}

function completeGraph(label: string) {
    const store = new MemorySlateStore();
    const workspace = new WorkspaceId(`workspace-${label}`);
    const slate = Slate.initial(new SlateId(`slate-${label}`), workspace, ref(`${label}-source`));
    store.compareAndSetSlate(undefined, slate);
    const version = new SlateVersion(
        new SlateVersionId(`version-${label}`),
        workspace,
        slate.id,
        slate.source
    );
    store.addVersion(version);
    const committed = slate.commit(version.id);
    store.compareAndSetSlate(slate.revision, committed);
    const publication = new SlatePublication(
        new SlatePublicationId(`publication-${label}`),
        workspace,
        slate.id,
        version.id,
        ref(`${label}-publication`)
    );
    store.addPublication(publication);
    const published = committed.publish(publication.id);
    store.compareAndSetSlate(committed.revision, published);
    const invocation = new InvocationId(`invocation-${label}`);
    const deployment = new SlateDeployment(
        new SlateDeploymentId(`deployment-${label}`),
        workspace,
        slate.id,
        publication.id,
        "production",
        ref(`${label}-deployment`),
        invocation,
        new ReceiptId(`receipt-deployment-${label}`)
    );
    store.reserveDeployment(
        new SlateDeploymentReservation({
            id: deployment.id,
            workspaceId: workspace,
            slateId: slate.id,
            publicationId: publication.id,
            publicationMaterialization: publication.materialization,
            target: deployment.target,
            externalKey: `external-${externalKeyCounter++}`,
            invocationId: invocation
        })
    );
    store.addDeployment(deployment);
    const current = published.selectDeployment(deployment.id);
    store.compareAndSetSlate(published.revision, current);
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
    const preview = new SlatePreview(
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
        current.source
    );
    store.addPreview(preview);
    return {
        store,
        workspace,
        slate,
        version,
        publication,
        deployment,
        resource,
        preview,
        current
    };
}

function ref(label: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(label)));
}

function expectCode(operation: () => unknown, code: AgentCoreError["code"]): void {
    let error: unknown;
    try {
        operation();
    } catch (caught) {
        error = caught;
    }
    expect(error).toBeInstanceOf(AgentCoreError);
    expect((error as AgentCoreError).code).toBe(code);
}

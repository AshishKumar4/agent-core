import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    ContentOwnerEdge,
    ContentRecordCustody,
    MemoryContentStore,
    contentOwnerKey,
    type ContentCustodyPort,
    type RetainedContentRecord
} from "../../src/content";
import { ContentRef, Digest, Revision } from "../../src/core";
import {
    MetadataSnapshot,
    metadataSnapshotContentRetention,
    packageReleaseContentRetention
} from "../../src/definition";
import { memoryPackageStore, packageRelease } from "../definition/package-store-contract";
import {
    Environment,
    EnvironmentId,
    EnvironmentRevisionRecord,
    EnvironmentSession,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    EnvironmentSessionState,
    EnvironmentSnapshot,
    EnvironmentSnapshotId,
    EnvironmentSnapshotState,
    MemoryEnvironmentStore,
    PortExposureId,
    ProviderDescriptor,
    ProviderId
} from "../../src/environments";
import { WorkspaceId } from "../../src/identity";
import { InvocationId } from "../../src/interaction-references";
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
    SlateVersionId
} from "../../src/slates";
import { ReceiptId } from "../../src/invocation-references";
import {
    AttemptCompletion,
    AttemptReceipt,
    ClaimWorkerId,
    EffectAttempt,
    EffectAttemptId,
    ItemClaim,
    ItemClaimId
} from "../../src/invocations";
import { AuditRecordId } from "../../src/interaction-references";
import {
    SqliteContentRetention,
    SqliteContentStore,
    SqliteWorkspaceRecords,
    type TransactionalSqlite
} from "../../src/substrates";
import { WorkspaceContentRetention, WorkspacePersistence } from "../../src/workspaces";
import { TestSqlite } from "../helpers/sqlite";
import {
    eventFixture,
    eventRetention,
    sourceActor,
    tenant as workspaceTenant
} from "../workspaces/fixtures";
import { createSqliteInvocationPersistence } from "../substrates/sqlite/invocations/fixture";
import { admissionFor, prepared } from "../invocations/fixture";
import { at, contentOwner } from "./retention-contract";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const owner = contentOwner();

/**
 * The custody a store with no transaction of its own registers through: each registration
 * commits in the content plane's own transaction, which is the seam a Slate, Environment or
 * Tenant package plane offers today. Retention itself — retain, release, restart, rollback,
 * collection — is proven once for both substrates by test/content/retention-contract.ts;
 * what these cases prove is that each wave's write path reaches it for every declared kind.
 */
function storeCustody<Token>(
    store: MemoryContentStore,
    actor: ActorRef = owner.actor
): ContentCustodyPort<Token> {
    const inner = new ContentRecordCustody(store.retention(owner.tenant, actor), () => at(10));
    return {
        retain(_token: Token, record: RetainedContentRecord, previous?: RetainedContentRecord) {
            store.transaction((transaction) => inner.retain(transaction, record, previous));
        },
        release(_token: Token, record: RetainedContentRecord) {
            store.transaction((transaction) => inner.release(transaction, record));
        }
    };
}

function collect(store: MemoryContentStore, actor: ActorRef = owner.actor): readonly string[] {
    const retention = store.retention(owner.tenant, actor);
    return store
        .transaction((transaction) =>
            retention.collect(transaction, { allowsCollection: () => true }, at(1_000))
        )
        .map((ref) => ref.value);
}

function expectExactCustody(
    store: MemoryContentStore,
    expected: readonly ContentOwnerEdge[],
    actor: ActorRef = owner.actor
): void {
    const retention = store.retention(owner.tenant, actor);
    store.transaction((transaction) =>
        retention.verifyExactNamespace(transaction, ["record:"], expected)
    );
}

function edge(kind: string, key: string, field: string, ref: ContentRef, actor = owner.actor) {
    return new ContentOwnerEdge(owner.tenant, actor, contentOwnerKey(kind, key, field), ref);
}

async function put(store: MemoryContentStore, label: string): Promise<ContentRef> {
    return (await store.put(encode(label))).ref;
}

describe("record custody registration", () => {
    test(
        "[C13-CONTENT-CUSTODY] a Slate plane write registers every declared ContentRef of all eight Slate kinds",
        { tags: "p0" },
        async () => {
            const content = new MemoryContentStore();
            const store = new MemorySlateStore(storeCustody(content));
            const workspace = new WorkspaceId("workspace-custody");
            const source = await put(content, "slate-source");
            const publicationMaterialization = await put(content, "publication-materialization");
            const deploymentMaterialization = await put(content, "deployment-materialization");
            const resourceMaterialization = await put(content, "resource-materialization");
            const resourceSource = await put(content, "resource-source");
            const unnamed = await put(content, "named-by-nothing");

            const slate = Slate.initial(new SlateId("slate-custody"), workspace, source);
            store.compareAndSetSlate(undefined, slate);
            const version = new SlateVersion(
                new SlateVersionId("version-custody"),
                workspace,
                slate.id,
                source
            );
            store.addVersion(version);
            const committed = slate.commit(version.id);
            store.compareAndSetSlate(slate.revision, committed);
            const publication = new SlatePublication(
                new SlatePublicationId("publication-custody"),
                workspace,
                slate.id,
                version.id,
                publicationMaterialization,
                []
            );
            store.addPublication(publication);
            const published = committed.publish(publication.id);
            store.compareAndSetSlate(committed.revision, published);
            const invocation = new InvocationId("invocation-custody");
            const deployment = new SlateDeployment(
                new SlateDeploymentId("deployment-custody"),
                workspace,
                slate.id,
                publication.id,
                "production",
                deploymentMaterialization,
                invocation,
                new ReceiptId("receipt-deployment-custody")
            );
            store.reserveDeployment(
                new SlateDeploymentReservation({
                    id: deployment.id,
                    workspaceId: workspace,
                    slateId: slate.id,
                    publicationId: publication.id,
                    publicationMaterialization,
                    target: deployment.target,
                    externalKey: "external-custody",
                    invocationId: invocation
                })
            );
            store.addDeployment(deployment);
            const resource = new SlateResource(
                new SlateResourceId("resource-custody"),
                workspace,
                slate.id,
                deployment.id,
                "database",
                resourceSource,
                resourceMaterialization,
                invocation,
                new ReceiptId("receipt-resource-custody")
            );
            store.reserveResource(
                new SlateResourceReservation({
                    id: resource.id,
                    workspaceId: workspace,
                    slateId: slate.id,
                    deploymentId: deployment.id,
                    deploymentMaterialization,
                    name: resource.name,
                    source: resourceSource,
                    invocationId: invocation
                })
            );
            store.addResource(resource);
            const preview = new SlatePreview(
                new SlatePreviewId("preview-custody"),
                workspace,
                slate.id,
                new EnvironmentSessionCapability(
                    new EnvironmentId("environment-custody"),
                    new EnvironmentSessionId("session-custody"),
                    Revision.initial(),
                    0
                ),
                new PortExposureId("exposure-custody"),
                published.source
            );
            store.addPreview(preview);

            expectExactCustody(content, [
                edge("slate", `${slate.id.value}\u00000`, "source", source),
                edge("slate", `${slate.id.value}\u00001`, "source", source),
                edge("slate", `${slate.id.value}\u00002`, "source", source),
                edge("slate.version", version.id.value, "source", source),
                edge(
                    "slate.publication",
                    publication.id.value,
                    "materialization",
                    publicationMaterialization
                ),
                edge(
                    "slate.deployment-reservation",
                    deployment.id.value,
                    "publicationMaterialization",
                    publicationMaterialization
                ),
                edge(
                    "slate.deployment",
                    deployment.id.value,
                    "materialization",
                    deploymentMaterialization
                ),
                edge(
                    "slate.resource-reservation",
                    resource.id.value,
                    "deploymentMaterialization",
                    deploymentMaterialization
                ),
                edge("slate.resource-reservation", resource.id.value, "source", resourceSource),
                edge(
                    "slate.resource",
                    resource.id.value,
                    "materialization",
                    resourceMaterialization
                ),
                edge("slate.resource", resource.id.value, "source", resourceSource),
                edge("slate.preview", preview.id.value, "source", source)
            ]);
            // Every named ContentRef is held, and content no record ever named is outside
            // this rule: the seam never offers a blob with no Tenant relation at all.
            expect(collect(content)).toEqual([]);
            await expect(content.get(unnamed)).resolves.toEqual(encode("named-by-nothing"));
            for (const ref of [
                source,
                publicationMaterialization,
                deploymentMaterialization,
                resourceMaterialization,
                resourceSource
            ]) {
                await expect(content.get(ref)).resolves.toBeInstanceOf(Uint8Array);
            }
        }
    );

    test(
        "[C13-CONTENT-CUSTODY] a Slate write whose content the Actor does not hold is refused before its row lands",
        { tags: "p0" },
        () => {
            const content = new MemoryContentStore();
            const store = new MemorySlateStore(storeCustody(content));
            const workspace = new WorkspaceId("workspace-missing");
            const missing = ContentRef.fromDigest(Digest.sha256(encode("never-put")));
            const slate = Slate.initial(new SlateId("slate-missing"), workspace, missing);

            expect(() => store.compareAndSetSlate(undefined, slate)).toThrow(
                expect.objectContaining({ code: "content.not-found" })
            );
            expect(store.getSlate(slate.id)).toBeUndefined();
            expectExactCustody(content, []);
        }
    );

    test(
        "[C13-CONTENT-CUSTODY] a faulted Slate transaction leaves neither its records nor its custody",
        { tags: "p0" },
        async () => {
            const content = new MemoryContentStore();
            const store = new MemorySlateStore(storeCustody(content));
            const workspace = new WorkspaceId("workspace-rollback");
            const source = await put(content, "rollback-source");
            const slate = Slate.initial(new SlateId("slate-rollback"), workspace, source);

            expect(() =>
                store.transaction((draft) => {
                    draft.compareAndSetSlate(undefined, slate);
                    throw new TypeError("slate fault");
                })
            ).toThrow("slate fault");

            expect(store.getSlate(slate.id)).toBeUndefined();
            expectExactCustody(content, []);
            expect(collect(content)).toEqual([]);
            await expect(content.get(source)).resolves.toEqual(encode("rollback-source"));

            // The same write, committed, registers exactly the edge the faulted one did not.
            store.transaction((draft) => draft.compareAndSetSlate(undefined, slate));
            expectExactCustody(content, [
                edge("slate", `${slate.id.value}\u00000`, "source", source)
            ]);
        }
    );

    test(
        "[C13-CONTENT-CUSTODY] an Environment revision retains and a re-captured snapshot swaps its content",
        { tags: "p0" },
        async () => {
            const content = new MemoryContentStore();
            const actor = new ActorRef("environment", new ActorId("environment-custody"));
            const store = new MemoryEnvironmentStore(storeCustody(content, actor));
            const configuration = await put(content, "provider-configuration");
            const captured = await put(content, "snapshot-content");
            const recaptured = await put(content, "snapshot-content-second");
            const environmentId = new EnvironmentId("environment-custody");
            const revision = new EnvironmentRevisionRecord(
                environmentId,
                Revision.initial(),
                0,
                new ProviderDescriptor(new ProviderId("provider-custody"), "1.0.0", configuration)
            );
            const environment = new Environment(
                environmentId,
                Revision.initial(),
                0,
                Revision.initial()
            );
            expect(store.compareAndSetEnvironment(undefined, revision, environment)).toBe(true);

            const sessionId = new EnvironmentSessionId("session-custody");
            expect(
                store.compareAndSetSession(
                    undefined,
                    new EnvironmentSession(
                        sessionId,
                        environmentId,
                        Revision.initial(),
                        0,
                        0,
                        EnvironmentSessionState.open,
                        undefined,
                        Revision.initial()
                    )
                )
            ).toBe(true);
            const snapshotId = new EnvironmentSnapshotId("snapshot-custody");
            const snapshot = new EnvironmentSnapshot(
                snapshotId,
                environmentId,
                sessionId,
                Revision.initial(),
                0,
                0,
                EnvironmentSnapshotState.ready,
                captured,
                Revision.initial()
            );
            expect(store.compareAndSetSnapshot(undefined, snapshot)).toBe(true);
            expectExactCustody(
                content,
                [
                    edge(
                        "environment.revision",
                        `${environmentId.value}\u00000`,
                        "provider.configuration",
                        configuration,
                        actor
                    ),
                    edge("environment.snapshot", snapshotId.value, "content", captured, actor)
                ],
                actor
            );

            const replaced = new EnvironmentSnapshot(
                snapshotId,
                environmentId,
                sessionId,
                Revision.initial(),
                0,
                0,
                EnvironmentSnapshotState.ready,
                recaptured,
                new Revision(1)
            );
            expect(store.compareAndSetSnapshot(Revision.initial(), replaced)).toBe(true);
            expectExactCustody(
                content,
                [
                    edge(
                        "environment.revision",
                        `${environmentId.value}\u00000`,
                        "provider.configuration",
                        configuration,
                        actor
                    ),
                    edge("environment.snapshot", snapshotId.value, "content", recaptured, actor)
                ],
                actor
            );
            expect(collect(content, actor)).toEqual([captured.value]);
            await expect(content.get(recaptured)).resolves.toEqual(
                encode("snapshot-content-second")
            );
        }
    );

    test(
        "[C13-CONTENT-CUSTODY] a Tenant package release and metadata snapshot retain every module they name",
        { tags: "p0" },
        async () => {
            const content = new MemoryContentStore();
            const actor = new ActorRef("tenant", new ActorId("tenant-custody"));
            const store = memoryPackageStore(storeCustody(content, actor));
            const moduleBytes = encode("package-module");
            const moduleDigest = Digest.sha256(moduleBytes);
            const moduleContent = (await content.put(moduleBytes)).ref;
            const release = packageRelease("package-custody", "1.0.0", moduleDigest);
            store.add(release);
            const snapshot = new MetadataSnapshot({
                revision: new Revision(1),
                releases: [release]
            });
            store.addSnapshot(snapshot);

            expect(packageReleaseContentRetention(release).map((field) => field.field)).toEqual([
                "codeManifest.modules[0].content"
            ]);
            expect(metadataSnapshotContentRetention(snapshot).map((field) => field.field)).toEqual([
                "releases[0].codeManifest.modules[0].content"
            ]);
            expectExactCustody(
                content,
                [
                    edge(
                        "definition.package-release",
                        `${release.id.value}\u0000${release.version.toString()}`,
                        "codeManifest.modules[0].content",
                        moduleContent,
                        actor
                    ),
                    edge(
                        "definition.metadata-snapshot",
                        snapshot.digest.value,
                        "releases[0].codeManifest.modules[0].content",
                        moduleContent,
                        actor
                    )
                ],
                actor
            );
            expect(collect(content, actor)).toEqual([]);
        }
    );
});

describe("co-transacted record custody on SQLite", () => {
    test(
        "[C13-CONTENT-CUSTODY] an appended Receipt retains its result in the transaction that wrote it and never releases",
        { tags: "p0" },
        async () => {
            const database = new TestSqlite();
            const actor = new ActorRef("workspace", new ActorId("receipt-custody"));
            const store = new SqliteContentStore(database);
            SqliteContentStore.initializeOwner(database, owner.tenant, actor);
            const retention = new SqliteContentRetention(database, owner.tenant, actor);
            const persistence = createSqliteInvocationPersistence(
                database,
                new ContentRecordCustody(retention, () => at(10))
            );
            const result = (await store.put(encode("attempt-result"))).ref;
            const invocation = prepared("receipt-custody");
            const claim = new ItemClaim<string>(
                new ItemClaimId("receipt-custody-claim"),
                invocation.header.id,
                0,
                0,
                {
                    kind: "system",
                    actor: invocation.header.actor,
                    worker: new ClaimWorkerId("receipt-custody-worker")
                },
                at(5_000)
            );
            const attempt = new EffectAttempt<string, string>(
                new EffectAttemptId("receipt-custody-attempt"),
                invocation.header.id,
                0,
                claim.attemptOrdinal,
                claim.id,
                undefined,
                admissionFor(invocation.header.id.value, 0, claim.attemptOrdinal),
                at(2_000),
                invocation.item(0).idempotencyKey,
                new AuditRecordId("receipt-custody-audit")
            );
            const receipt = new AttemptReceipt(
                new ReceiptId("receipt-custody"),
                attempt.id,
                AttemptCompletion.succeeded,
                undefined,
                at(20),
                result
            );

            database.transaction(() => {
                persistence.insertPrepared(database, invocation);
                persistence.appendClaim(database, claim);
                persistence.appendAttempt(database, attempt);
                persistence.appendReceipt(database, receipt);
            });

            const expected = new ContentOwnerEdge(
                owner.tenant,
                actor,
                contentOwnerKey("invocation.receipt", receipt.id.value, "result"),
                result
            );
            database.transaction(() =>
                retention.verifyExactNamespace(database, ["record:"], [expected])
            );
            const collected = database.transaction(() =>
                retention.collect(database, { allowsCollection: () => true }, at(1_000))
            );
            expect(collected).toEqual([]);
            await expect(store.get(result)).resolves.toEqual(encode("attempt-result"));
        }
    );

    test(
        "[C13-CONTENT-CUSTODY] an appended Event registers its payload through the workspaces retention port",
        { tags: "p0" },
        async () => {
            const database = new TestSqlite();
            const store = new SqliteContentStore(database);
            SqliteContentStore.initializeOwner(database, workspaceTenant, sourceActor);
            const retention = new SqliteContentRetention(database, workspaceTenant, sourceActor);
            const records = new SqliteWorkspaceRecords(database);
            const persistence = new WorkspacePersistence<TransactionalSqlite>(
                () => records,
                new WorkspaceContentRetention(retention, () => at(10)),
                sourceActor,
                workspaceTenant
            );
            const event = eventFixture("sqlite-custody");
            await store.put(encode("event-payload-sqlite-custody"));

            database.transaction(() =>
                persistence.appendEvent(database, event, eventRetention(event))
            );

            const expected = new ContentOwnerEdge(
                workspaceTenant,
                sourceActor,
                contentOwnerKey("workspace.event", event.id.value, "content"),
                event.payload
            );
            database.transaction(() =>
                retention.verifyExactNamespace(database, ["record:"], [expected])
            );
            expect(
                database.transaction(() =>
                    retention.collect(database, { allowsCollection: () => true }, at(1_000))
                )
            ).toEqual([]);
        }
    );

    test(
        "[C13-CONTENT-CUSTODY] an Event naming content the Actor does not hold is refused before the record lands",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            SqliteContentStore.initializeOwner(database, workspaceTenant, sourceActor);
            const retention = new SqliteContentRetention(database, workspaceTenant, sourceActor);
            const records = new SqliteWorkspaceRecords(database);
            const persistence = new WorkspacePersistence<TransactionalSqlite>(
                () => records,
                new WorkspaceContentRetention(retention, () => at(10)),
                sourceActor,
                workspaceTenant
            );
            const event = eventFixture("sqlite-unheld");

            expect(() =>
                database.transaction(() =>
                    persistence.appendEvent(database, event, eventRetention(event))
                )
            ).toThrow(expect.objectContaining({ code: "protocol.invalid-state" }));
            database.transaction(() => retention.verifyExactNamespace(database, ["record:"], []));
        }
    );
});


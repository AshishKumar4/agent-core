import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    MemoryContentRetentionState,
    MemoryContentStore,
    type MemoryContentSnapshot
} from "../../src/content/memory";
import { ContentOwnerEdge } from "../../src/content/retention";
import { TransientContentLeaseState } from "../../src/content/transient";
import { ContentRef, Digest } from "../../src/core";
import { TenantId } from "../../src/identity";
import {
    at,
    bindingFor,
    contentOwner,
    expectAgentCoreDiagnostic,
    expectAgentCoreError,
    expectAgentCoreRejection,
    expectAgentCoreRejectionDiagnostic
} from "./retention-contract";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function defined<Value>(value: Value | undefined): Value {
    if (value === undefined) {
        throw new TypeError("Expected a defined value");
    }
    return value;
}

async function populatedSnapshot(): Promise<MemoryContentSnapshot> {
    const store = new MemoryContentStore();
    const owner = contentOwner();
    const retention = store.retention(owner.tenant, owner.actor);
    const stored = await store.put(encode("snapshot-corruption"));
    const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "snapshot-owner", stored.ref);
    store.transaction((transaction) => retention.retain(transaction, edge, at(10)));
    const binding = {
        ...bindingFor("snapshot-corruption", "snapshot-corruption", at(50)),
        ref: stored.ref,
        digest: stored.digest
    };
    await store.transient(owner.tenant, owner.actor, () => at(20)).acquire(binding);
    return store.snapshot();
}

async function leaseOnlySnapshot(): Promise<MemoryContentSnapshot> {
    const store = new MemoryContentStore();
    const owner = contentOwner();
    store.retention(owner.tenant, owner.actor);
    await store
        .transient(owner.tenant, owner.actor, () => at(10))
        .acquire(
            bindingFor("lease-only-snapshot", "lease-only-snapshot", at(50)),
            encode("lease-only-snapshot")
        );
    return store.snapshot();
}

function expectCorrupt(snapshot: MemoryContentSnapshot): void {
    expectAgentCoreError(() => MemoryContentStore.restore(snapshot), "codec.invalid");
}

describe("MemoryContentStore snapshot validation", () => {
    test("rejects malformed snapshot roots and bindings", () => {
        const malformed: readonly unknown[] = [
            null,
            {},
            { version: 2, binding: null, content: [], edges: [], relations: [], leases: [] },
            { version: 1, binding: null, content: null, edges: [], relations: [], leases: [] },
            { version: 1, binding: null, content: [], edges: null, relations: [], leases: [] },
            { version: 1, binding: null, content: [], edges: [], relations: null, leases: [] },
            { version: 1, binding: null, content: [], edges: [], relations: [], leases: null },
            {
                version: 1,
                binding: { tenant: "", actor: { kind: "workspace", id: "actor" } },
                content: [],
                edges: [],
                relations: [],
                leases: []
            }
        ];
        for (const snapshot of malformed) {
            expectCorrupt(snapshot as MemoryContentSnapshot);
        }

        const unbound = new MemoryContentStore().snapshot();
        expect(unbound.binding).toBeNull();
        expect(MemoryContentStore.restore(unbound).snapshot()).toEqual(unbound);
    });

    test("rejects duplicate, malformed, and cryptographically inconsistent content rows", async () => {
        const snapshot = await populatedSnapshot();
        const row = snapshot.content[0]!;
        const otherDigest = Digest.sha256(encode("other-snapshot-content"));
        const corruptions: readonly MemoryContentSnapshot[] = [
            { ...snapshot, content: [row, row] },
            { ...snapshot, content: [{ ...row, ref: "bad" }] },
            { ...snapshot, content: [{ ...row, digest: "bad" }] },
            { ...snapshot, content: [{ ...row, bytes: encode("tampered") }] },
            { ...snapshot, content: [{ ...row, mediaType: "" }] },
            {
                ...snapshot,
                content: [{ ...row, ref: ContentRef.fromDigest(otherDigest).value }]
            }
        ];
        for (const corruption of corruptions) expectCorrupt(corruption);
        expectCorrupt({
            ...snapshot,
            content: [{ ...row, bytes: "not-bytes" as unknown as Uint8Array }]
        });
    });

    test("rejects malformed, duplicate, foreign, and inconsistent owner relations", async () => {
        const snapshot = await populatedSnapshot();
        const edgeBytes = snapshot.edges[0]!;
        const relation = snapshot.relations[0]!;
        const owner = contentOwner();
        const foreignEdge = new ContentOwnerEdge(
            new TenantId("foreign-tenant"),
            owner.actor,
            "foreign-edge",
            new ContentRef(relation.ref)
        );
        const missingDigest = Digest.sha256(encode("missing-relation"));
        const corruptions: readonly MemoryContentSnapshot[] = [
            { ...snapshot, edges: [edgeBytes, edgeBytes] },
            { ...snapshot, edges: [Uint8Array.of(1, 2, 3)] },
            { ...snapshot, edges: [ContentOwnerEdge.encode(foreignEdge)] },
            { ...snapshot, edges: ["not-bytes" as unknown as Uint8Array] },
            { ...snapshot, relations: [relation, relation] },
            { ...snapshot, relations: [{ ...relation, unownedSince: -1 }] },
            { ...snapshot, relations: [{ ...relation, unownedSince: 1.5 }] },
            {
                ...snapshot,
                relations: [{ ref: ContentRef.fromDigest(missingDigest).value, unownedSince: 10 }]
            },
            { ...snapshot, relations: [{ ...relation, unownedSince: 10 }] },
            { ...snapshot, relations: [] }
        ];
        for (const corruption of corruptions) expectCorrupt(corruption);
    });

    test("rejects malformed, duplicate, foreign, and disconnected lease records", async () => {
        const snapshot = await leaseOnlySnapshot();
        const leaseBytes = snapshot.leases[0]!;
        const decoded = TransientContentLeaseState.decode(leaseBytes);
        const foreign = new TransientContentLeaseState(
            new TenantId("foreign-tenant"),
            decoded.actor,
            decoded.envelopeDigest,
            decoded.ref,
            decoded.digest,
            decoded.acquiredAt,
            decoded.expiresAt
        );
        const missingDigest = Digest.sha256(encode("missing-lease-content"));
        const disconnected = new TransientContentLeaseState(
            decoded.tenant,
            decoded.actor,
            Digest.sha256(encode("disconnected-envelope")),
            ContentRef.fromDigest(missingDigest),
            missingDigest,
            decoded.acquiredAt,
            decoded.expiresAt
        );
        const corruptions: readonly MemoryContentSnapshot[] = [
            { ...snapshot, leases: [leaseBytes, leaseBytes] },
            { ...snapshot, leases: [Uint8Array.of(1, 2, 3)] },
            { ...snapshot, leases: ["not-bytes" as unknown as Uint8Array] },
            { ...snapshot, leases: [TransientContentLeaseState.encode(foreign)] },
            { ...snapshot, leases: [TransientContentLeaseState.encode(disconnected)] },
            { ...snapshot, relations: [] },
            {
                ...snapshot,
                relations: snapshot.relations.map((relation) => ({
                    ...relation,
                    unownedSince: null
                }))
            }
        ];
        for (const corruption of corruptions) expectCorrupt(corruption);
    });

    test("enforces snapshot owner binding and supports detached state clones", async () => {
        const snapshot = await populatedSnapshot();
        const owner = contentOwner();
        expectAgentCoreError(
            () =>
                MemoryContentRetentionState.restore(
                    new TenantId("foreign-tenant"),
                    owner.actor,
                    snapshot
                ),
            "codec.invalid"
        );
        expectAgentCoreError(
            () =>
                MemoryContentRetentionState.restore(
                    owner.tenant,
                    new ActorRef("workspace", new ActorId("foreign-actor")),
                    snapshot
                ),
            "codec.invalid"
        );

        const restored = MemoryContentRetentionState.restore(owner.tenant, owner.actor, snapshot);
        const clone = restored.clone();
        expect(clone.snapshot()).toEqual(restored.snapshot());
        expect(clone.snapshot()).not.toBe(restored.snapshot());
    });

    test("names every snapshot restoration diagnostic exactly", { tags: "p0" }, async () => {
        const snapshot = await populatedSnapshot();
        const owner = contentOwner();
        const row = defined(snapshot.content[0]);
        const edgeBytes = defined(snapshot.edges[0]);
        const relation = defined(snapshot.relations[0]);
        const leaseBytes = defined(snapshot.leases[0]);
        const storedLease = TransientContentLeaseState.decode(leaseBytes);
        const foreignEdge = new ContentOwnerEdge(
            new TenantId("foreign-tenant"),
            owner.actor,
            "foreign-edge",
            new ContentRef(relation.ref)
        );
        const foreignLease = new TransientContentLeaseState(
            new TenantId("foreign-tenant"),
            storedLease.actor,
            storedLease.envelopeDigest,
            storedLease.ref,
            storedLease.digest,
            storedLease.acquiredAt,
            storedLease.expiresAt
        );
        const cases: readonly {
            readonly corruption: MemoryContentSnapshot;
            readonly message: string;
        }[] = [
            {
                corruption: { ...snapshot, version: 2 } as unknown as MemoryContentSnapshot,
                message: "Memory content snapshot is malformed"
            },
            {
                corruption: { ...snapshot, content: [row, row] },
                message: "Duplicate content snapshot row"
            },
            {
                corruption: { ...snapshot, content: [{ ...row, ref: "bad" }] },
                message: "Memory content snapshot is malformed"
            },
            {
                corruption: { ...snapshot, content: [{ ...row, bytes: encode("tampered") }] },
                message: "Stored content or retention state is malformed"
            },
            {
                corruption: { ...snapshot, edges: ["not-bytes" as unknown as Uint8Array] },
                message: "Malformed owner edge snapshot"
            },
            {
                corruption: { ...snapshot, edges: [edgeBytes, edgeBytes] },
                message: "Duplicate owner edge snapshot"
            },
            {
                corruption: { ...snapshot, edges: [ContentOwnerEdge.encode(foreignEdge)] },
                message: "Stored content state has foreign Actor or Tenant ownership"
            },
            {
                corruption: { ...snapshot, relations: [{ ...relation, unownedSince: -1 }] },
                message: "Malformed content relation snapshot"
            },
            {
                corruption: { ...snapshot, relations: [relation, relation] },
                message: "Malformed content relation snapshot"
            },
            {
                corruption: { ...snapshot, leases: ["not-bytes" as unknown as Uint8Array] },
                message: "Malformed lease snapshot"
            },
            {
                corruption: { ...snapshot, leases: [leaseBytes, leaseBytes] },
                message: "Duplicate lease snapshot"
            },
            {
                corruption: {
                    ...snapshot,
                    leases: [TransientContentLeaseState.encode(foreignLease)]
                },
                message: "Stored content state has foreign Actor or Tenant ownership"
            }
        ];

        for (const entry of cases) {
            expectAgentCoreDiagnostic(
                () => MemoryContentStore.restore(entry.corruption),
                "codec.invalid",
                entry.message
            );
        }

        for (const restore of [
            () =>
                MemoryContentRetentionState.restore(
                    new TenantId("foreign-tenant"),
                    owner.actor,
                    snapshot
                ),
            () =>
                MemoryContentRetentionState.restore(
                    owner.tenant,
                    owner.actor,
                    new MemoryContentStore().snapshot()
                )
        ]) {
            expectAgentCoreDiagnostic(
                restore,
                "codec.invalid",
                "Memory content snapshot belongs to a different Actor or Tenant"
            );
        }
    });

    test("names every restored-state validation diagnostic exactly", { tags: "p0" }, async () => {
        const snapshot = await populatedSnapshot();
        const leaseSnapshot = await leaseOnlySnapshot();
        const owner = contentOwner();
        const relation = defined(snapshot.relations[0]);
        const missingRef = ContentRef.fromDigest(Digest.sha256(encode("missing-owned-content")));
        const orphanEdge = new ContentOwnerEdge(
            owner.tenant,
            owner.actor,
            "orphan-owner",
            missingRef
        );
        const unboundStore = new MemoryContentStore();
        const unboundPut = await unboundStore.put(encode("unbound-relation"));
        const unbound = unboundStore.snapshot();

        expectAgentCoreDiagnostic(
            () =>
                MemoryContentStore.restore({
                    ...snapshot,
                    relations: [{ ...relation, unownedSince: 10 }]
                }),
            "codec.invalid",
            "Owned content relation is malformed"
        );
        expectAgentCoreDiagnostic(
            () =>
                MemoryContentStore.restore({
                    ...snapshot,
                    content: [],
                    edges: [ContentOwnerEdge.encode(orphanEdge)],
                    relations: [{ ref: missingRef.value, unownedSince: null }],
                    leases: []
                }),
            "codec.invalid",
            "Owned content relation is malformed"
        );
        expectAgentCoreDiagnostic(
            () =>
                MemoryContentStore.restore({
                    ...snapshot,
                    content: [],
                    edges: [],
                    relations: [{ ref: missingRef.value, unownedSince: 10 }],
                    leases: []
                }),
            "codec.invalid",
            "Content relation is malformed"
        );
        expectAgentCoreDiagnostic(
            () => MemoryContentStore.restore({ ...leaseSnapshot, relations: [] }),
            "codec.invalid",
            "Transient content lease storage is malformed"
        );
        expectAgentCoreDiagnostic(
            () =>
                MemoryContentStore.restore({
                    ...unbound,
                    relations: [{ ref: unboundPut.ref.value, unownedSince: 10 }]
                }),
            "protocol.invalid-state",
            "Memory content storage is not bound to an Actor and Tenant"
        );
    });
});

describe("MemoryContentStore transaction and lease isolation", () => {
    test("requires binding, rejects nesting and foreign transactions, and expires callbacks", async () => {
        const unbound = new MemoryContentStore();
        expectAgentCoreError(() => unbound.transaction(() => undefined), "protocol.invalid-state");

        const owner = contentOwner();
        const first = new MemoryContentStore();
        const second = new MemoryContentStore();
        const firstRetention = first.retention(owner.tenant, owner.actor);
        const secondRetention = second.retention(owner.tenant, owner.actor);
        let captured: MemoryContentRetentionState | undefined;
        first.transaction((transaction) => {
            captured = transaction;
            expectAgentCoreError(
                () => first.transaction(() => undefined),
                "protocol.invalid-state"
            );
            expectAgentCoreError(
                () =>
                    secondRetention.collect(transaction, { allowsCollection: () => true }, at(10)),
                "protocol.invalid-state"
            );
        });
        expectAgentCoreError(() => captured!.snapshot(), "actor.closed");

        const stored = await first.put(encode("binding"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "binding", stored.ref);
        expectAgentCoreError(
            () => first.retention(new TenantId("foreign"), owner.actor),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () => first.retention(owner.tenant, new ActorRef("workspace", new ActorId("foreign"))),
            "protocol.invalid-state"
        );
        first.transaction((transaction) => firstRetention.retain(transaction, edge, at(10)));
    });

    test("rolls back asynchronous transaction results and leaves captured state inactive", () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);
        let captured: MemoryContentRetentionState | undefined;
        const invokeWithAsyncResult = store.transaction.bind(store) as unknown as (
            operation: (transaction: MemoryContentRetentionState) => Promise<string>
        ) => Promise<string>;
        expect(() =>
            invokeWithAsyncResult((transaction) => {
                captured = transaction;
                return Promise.resolve("not synchronous");
            })
        ).toThrow(TypeError);
        expectAgentCoreError(() => captured!.snapshot(), "actor.closed");
    });

    test("handles missing bytes, immutable lease-key collision, collection, and stale handles", async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        let now = at(10);
        const access = store.transient(owner.tenant, owner.actor, () => now);
        const missing = bindingFor("missing-memory-lease", "missing-memory", at(40));
        await expect(access.acquire(missing)).resolves.toBeUndefined();

        const binding = bindingFor("memory-collision", "memory-collision", at(40));
        const lease = await access.acquire(binding, encode("memory-collision"));
        const otherDigest = Digest.sha256(encode("other-memory-content"));
        await expectAgentCoreRejection(
            access.acquire({
                ...binding,
                ref: ContentRef.fromDigest(otherDigest),
                digest: otherDigest
            }),
            "protocol.invalid-state"
        );
        expect(lease!.matches({ ...binding, expiresAt: at(41) }, at(20))).toBe(false);
        now = at(30);
        await lease!.close();
        await lease!.close();
        store.transaction((transaction) =>
            retention.collect(transaction, { allowsCollection: () => true }, at(30))
        );
        expectAgentCoreError(() => lease!.read(), "codec.invalid");
    });

    test("names every transaction and retention diagnostic exactly", { tags: "p1" }, async () => {
        const owner = contentOwner();
        const store = new MemoryContentStore();
        const foreignStore = new MemoryContentStore();
        const retention = store.retention(owner.tenant, owner.actor);
        const foreignRetention = foreignStore.retention(owner.tenant, owner.actor);
        const stored = await store.put(encode("diagnostics"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "diagnostics", stored.ref);
        const missingRef = ContentRef.fromDigest(Digest.sha256(encode("diagnostics-missing")));

        expectAgentCoreDiagnostic(
            () => new MemoryContentStore().transaction(() => undefined),
            "protocol.invalid-state",
            "Memory content storage is not bound to an Actor and Tenant"
        );
        expectAgentCoreDiagnostic(
            () => store.retention(new TenantId("foreign-tenant"), owner.actor),
            "protocol.invalid-state",
            "Memory content storage is bound to a different Actor or Tenant"
        );

        let captured: MemoryContentRetentionState | undefined;
        store.transaction((transaction) => {
            captured = transaction;
            expectAgentCoreDiagnostic(
                () => store.transaction(() => undefined),
                "protocol.invalid-state",
                "Nested Memory content transactions are not supported"
            );
            expectAgentCoreDiagnostic(
                () =>
                    foreignRetention.collect(transaction, { allowsCollection: () => true }, at(10)),
                "protocol.invalid-state",
                "Memory content transaction belongs to a different store"
            );
            retention.retain(transaction, edge, at(10));
            expectAgentCoreDiagnostic(
                () =>
                    retention.retain(
                        transaction,
                        new ContentOwnerEdge(owner.tenant, owner.actor, "diagnostics", missingRef),
                        at(11)
                    ),
                "protocol.invalid-state",
                "Content owner key is already retained: diagnostics"
            );
            expectAgentCoreDiagnostic(
                () =>
                    retention.retain(
                        transaction,
                        new ContentOwnerEdge(
                            owner.tenant,
                            owner.actor,
                            "diagnostics-missing",
                            missingRef
                        ),
                        at(12)
                    ),
                "content.not-found",
                `Content not found: ${missingRef.value}`
            );
        });
        expectAgentCoreDiagnostic(
            () => defined(captured).snapshot(),
            "actor.closed",
            "Memory content transaction is no longer active"
        );

        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("diagnostic-lease", "diagnostic-lease", at(50));
        await expectAgentCoreRejectionDiagnostic(
            access.acquire(
                { ...binding, tenant: new TenantId("foreign-tenant") },
                encode("diagnostic-lease")
            ),
            "protocol.invalid-state",
            "Transient content binding belongs to a different Tenant"
        );
        await expectAgentCoreRejectionDiagnostic(
            access.acquire(
                { ...binding, actor: new ActorRef("workspace", new ActorId("foreign-actor")) },
                encode("diagnostic-lease")
            ),
            "protocol.invalid-state",
            "Transient content binding belongs to a different Actor"
        );

        const lease = defined(await access.acquire(binding, encode("diagnostic-lease")));
        const conflicting = Digest.sha256(encode("diagnostic-conflict"));
        await expectAgentCoreRejectionDiagnostic(
            access.acquire(
                { ...binding, ref: ContentRef.fromDigest(conflicting), digest: conflicting },
                encode("diagnostic-conflict")
            ),
            "protocol.invalid-state",
            "Active transient lease key is bound to different content"
        );

        store.transaction((transaction) =>
            retention.collect(transaction, { allowsCollection: () => true }, at(60))
        );
        expectAgentCoreDiagnostic(
            () => lease.read(),
            "codec.invalid",
            "Transient content lease is missing"
        );
        await expectAgentCoreRejectionDiagnostic(
            store.get(binding.ref),
            "content.not-found",
            `Content not found: ${binding.ref.value}`
        );
    });

    test("uses the default observation clock for transient acquisition", async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor);
        const binding = bindingFor(
            "default-clock",
            "default-clock",
            new Date(8_000_000_000_000_000)
        );
        const lease = await access.acquire(binding, encode("default-clock"));
        expect(lease?.read()).toEqual(encode("default-clock"));
    });
});

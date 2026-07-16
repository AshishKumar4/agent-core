// @ts-nocheck
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
    expectAgentCoreError,
    expectAgentCoreRejection
} from "./retention-contract";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

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

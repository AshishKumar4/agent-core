import { compareCanonicalText } from "../../src/core";
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../src/actors";
import * as content from "../../src/content";
import { MemoryContentRetentionState, MemoryContentStore } from "../../src/content/memory";
import { ByteRange } from "../../src/content/range";
import { ContentOwnerEdge } from "../../src/content/retention";
import { ContentStat } from "../../src/content/stat";
import { TransientContentLeaseState } from "../../src/content/transient";
import { decodeCanonicalJson, encodeCanonicalJson, isJsonObject } from "../../src/core";
import { TenantId } from "../../src/identity";
import { contentStoreContract } from "./contract";
import { at, bindingFor, contentOwner, contentRetentionContract } from "./retention-contract";
import { expectAgentCoreError, expectAgentCoreRejection } from "../protocol/error-assertion";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function defined<Value>(value: Value | undefined): Value {
    if (value === undefined) {
        throw new TypeError("Expected a defined value");
    }
    return value;
}

contentStoreContract("memory", () => new MemoryContentStore());
contentRetentionContract("memory", () => {
    const store = new MemoryContentStore();
    const owner = contentOwner();
    const retention = store.retention(owner.tenant, owner.actor);
    let now = at(0);
    const transient = store.transient(owner.tenant, owner.actor, () => now);
    return {
        store,
        retention,
        transient,
        setNow(value: Date): void {
            now = value;
        },
        transaction<Result>(
            operation: (transaction: MemoryContentRetentionState) => Result,
            ...guard: SynchronousResultGuard<Result>
        ): Result {
            return store.transaction(operation, ...guard);
        },
        acquireInTransaction(transaction, binding, operationAt, bytes) {
            return transient.acquireInTransaction(transaction, binding, operationAt, bytes);
        }
    };
});

describe("MemoryContentStore records", () => {
    test("keeps transient hold authority out of the public content surface", { tags: "p0" }, () => {
        for (const name of [
            "ContentHoldAuthority",
            "ContentHoldProof",
            "ContentHoldVerifier",
            "HeldContent"
        ]) {
            expect(content).not.toHaveProperty(name);
        }
        expect(MemoryContentStore.prototype).not.toHaveProperty("putHeld");
        expect(MemoryContentStore.prototype).not.toHaveProperty("getHeld");
        expect(MemoryContentStore.prototype).not.toHaveProperty("release");
        expect(MemoryContentStore.prototype).not.toHaveProperty("reap");
    });

    test(
        "keeps stored and returned bytes detached from hostile range behavior",
        { tags: "p0" },
        async () => {
            const store = new MemoryContentStore();
            const stored = await store.put(new TextEncoder().encode("private"));
            let observed: Uint8Array | undefined;
            const hostile = {
                read(bytes: Uint8Array): Uint8Array {
                    observed = bytes;
                    bytes.fill(0);
                    return bytes;
                }
            };

            // @ts-expect-error Host JavaScript can supply a structural ByteRange lookalike.
            const returned = await store.get(stored.ref, hostile);
            expect(returned).not.toBe(observed);
            returned.fill(1);
            observed?.fill(2);
            await expect(store.get(stored.ref)).resolves.toEqual(
                new TextEncoder().encode("private")
            );
        }
    );

    test("exposes only frozen, non-subclassable ByteRange values", { tags: "p0" }, () => {
        const range = ByteRange.slice(1, 2);
        expect(Object.isFrozen(range)).toBe(true);
        expect(Object.isFrozen(ByteRange.prototype)).toBe(true);
        // @ts-expect-error ByteRange deliberately has a private constructor.
        class DerivedRange extends ByteRange {}
        expect(
            () =>
                // @ts-expect-error Runtime subclass construction must fail too.
                new DerivedRange()
        ).toThrow(TypeError);
        expect(() =>
            Object.defineProperty(range, "read", {
                value: (bytes: Uint8Array): Uint8Array => bytes
            })
        ).toThrow(TypeError);
    });

    test(
        "[C13-CODEC-VERSIONING] round-trips stat and owner-edge records through versioned codecs",
        { tags: "p1" },
        async () => {
            const store = new MemoryContentStore();
            const stored = await store.put(new TextEncoder().encode("codec"));
            const stat = await store.stat(stored.ref);
            const owner = contentOwner();
            const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "codec-owner", stored.ref);

            const storedStat = defined(stat);
            const decoded = ContentStat.decode(ContentStat.encode(storedStat));
            expect(decoded.ref.equals(stored.ref)).toBe(true);
            expect(decoded.digest.equals(stored.digest)).toBe(true);
            expect(decoded.size).toBe(5);
            const decodedEdge = ContentOwnerEdge.decode(ContentOwnerEdge.encode(edge));
            expect(decodedEdge.equals(edge)).toBe(true);
            expect(Object.isFrozen(decodedEdge)).toBe(true);
            const binding = bindingFor("codec", "codec", at(50));
            const leaseState = new TransientContentLeaseState(
                binding.tenant,
                binding.actor,
                binding.envelopeDigest,
                binding.ref,
                binding.digest,
                at(10),
                binding.expiresAt,
                at(20)
            );
            const decodedLease = TransientContentLeaseState.decode(
                TransientContentLeaseState.encode(leaseState)
            );
            expect(decodedLease.matches(binding)).toBe(true);
            expect(decodedLease.closedAt).toEqual(at(20));

            const envelope = decodeCanonicalJson(ContentStat.encode(storedStat));
            if (!isJsonObject(envelope)) {
                throw new TypeError("Expected content stat record envelope");
            }
            const payload = envelope["payload"];
            if (!isJsonObject(payload)) {
                throw new TypeError("Expected content stat record payload");
            }
            expect(() =>
                ContentStat.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...payload, unknown: true }
                    })
                )
            ).toThrow(/malformed/);
        }
    );

    test(
        "[content.owner-edge] [content.transient-lease] restores content, owner, tombstone, and lease state",
        { tags: "p0" },
        async () => {
            const store = new MemoryContentStore();
            const owner = contentOwner();
            const retention = store.retention(owner.tenant, owner.actor);
            const stored = await store.put(new TextEncoder().encode("snapshot"));
            const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "snapshot", stored.ref);
            store.transaction((transaction) => {
                retention.retain(transaction, edge, at(10));
                retention.release(transaction, edge, at(20));
            });
            let now = at(25);
            const access = store.transient(owner.tenant, owner.actor, () => now);
            const binding = bindingFor("snapshot", "snapshot", at(50));
            await access.acquire(binding);

            const snapshot = store.snapshot();
            const restarted = MemoryContentStore.restore(snapshot);
            const restartedAccess = restarted.transient(owner.tenant, owner.actor, () => now);
            const lease = await restartedAccess.acquire(binding);
            expect(lease?.read()).toEqual(new TextEncoder().encode("snapshot"));
            expect(lease?.matches(binding, at(49))).toBe(true);
            now = at(30);
            await lease?.close();
            expect(restarted.snapshot().relations).toEqual([
                { ref: stored.ref.value, unownedSince: 30 }
            ]);

            expectAgentCoreError(
                () =>
                    MemoryContentStore.restore({
                        ...snapshot,
                        relations: [{ ref: stored.ref.value, unownedSince: -1 }]
                    }),
                "codec.invalid"
            );
            expectAgentCoreError(
                () =>
                    MemoryContentStore.restore({
                        ...snapshot,
                        leases: [Uint8Array.of(1, 2, 3)]
                    }),
                "codec.invalid"
            );
        }
    );

    test("rolls back transient bytes, relation, and lease together", { tags: "p0" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("atomic memory", "atomic-memory", at(30));

        expect(() =>
            store.transaction((transaction) => {
                access.acquireInTransaction(
                    transaction,
                    binding,
                    at(10),
                    new TextEncoder().encode("atomic memory")
                );
                throw new TypeError("fault");
            })
        ).toThrow("fault");
        await expect(store.stat(binding.ref)).resolves.toBeUndefined();
        expect(store.snapshot().relations).toEqual([]);
        expect(store.snapshot().leases).toEqual([]);
        await expect(
            access.acquire(binding, new TextEncoder().encode("atomic memory"))
        ).resolves.toBeDefined();
    });

    test(
        "reacquires a closed same-envelope lease after snapshot restart",
        { tags: "p1" },
        async () => {
            const store = new MemoryContentStore();
            const owner = contentOwner();
            store.retention(owner.tenant, owner.actor);
            let now = at(10);
            const access = store.transient(owner.tenant, owner.actor, () => now);
            const initial = bindingFor("memory crash retry", "memory-crash", at(30));
            const lease = await access.acquire(
                initial,
                new TextEncoder().encode("memory crash retry")
            );
            now = at(20);
            await lease!.close();

            const restarted = MemoryContentStore.restore(store.snapshot());
            restarted.retention(owner.tenant, owner.actor);
            now = at(25);
            const replacementBinding = { ...initial, expiresAt: at(50) };
            const replacement = await restarted
                .transient(owner.tenant, owner.actor, () => now)
                .acquire(replacementBinding);
            expect(replacement?.matches(replacementBinding, at(49))).toBe(true);
        }
    );
});

describe("MemoryContentStore canonical state", () => {
    test("constructs a frozen retention state bound to its owner", { tags: "p0" }, () => {
        const owner = contentOwner();
        const state = new MemoryContentRetentionState(owner.tenant, owner.actor);

        expect(Object.isFrozen(state)).toBe(true);
        expect(state.snapshot()).toEqual({
            version: 1,
            binding: { tenant: "tenant-a", actor: { kind: "workspace", id: "actor-a" } },
            content: [],
            edges: [],
            relations: [],
            leases: []
        });
        expect(state.clone().snapshot()).toEqual(state.snapshot());
    });

    test("detaches every snapshot copy from the stored backend", { tags: "p0" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const stored = await store.put(encode("detached"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "detached", stored.ref);
        store.transaction((transaction) => retention.retain(transaction, edge, at(10)));
        const binding = {
            ...bindingFor("detached", "detached", at(50)),
            ref: stored.ref,
            digest: stored.digest
        };
        await store.transient(owner.tenant, owner.actor, () => at(20)).acquire(binding);

        const first = store.snapshot();
        const second = store.snapshot();
        expect(first).toEqual(second);
        expect(defined(first.content[0]).bytes).not.toBe(defined(second.content[0]).bytes);
        expect(defined(first.edges[0])).not.toBe(defined(second.edges[0]));
        expect(defined(first.leases[0])).not.toBe(defined(second.leases[0]));

        const restored = MemoryContentStore.restore(first);
        defined(first.content[0]).bytes.fill(0);
        await expect(restored.get(stored.ref)).resolves.toEqual(encode("detached"));
        expect(restored.snapshot()).toEqual(second);
    });

    test("orders every snapshot collection deterministically", { tags: "p0" }, () => {
        const owner = contentOwner();
        const store = new MemoryContentStore();
        const retention = store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const entries = ["order-a", "order-b", "order-c", "order-d"].map((label, index) => {
            const binding = bindingFor(label, label, at(100));
            const edge = new ContentOwnerEdge(
                owner.tenant,
                owner.actor,
                `owner-${index}`,
                binding.ref
            );
            return {
                binding,
                edge,
                bytes: encode(label),
                edgeBytes: ContentOwnerEdge.encode(edge),
                leaseBytes: TransientContentLeaseState.encode(
                    new TransientContentLeaseState(
                        owner.tenant,
                        owner.actor,
                        binding.envelopeDigest,
                        binding.ref,
                        binding.digest,
                        at(10),
                        binding.expiresAt
                    )
                )
            };
        });
        const contentOrder = [...entries].sort((left, right) =>
            compareCanonicalText(right.binding.ref.value, left.binding.ref.value)
        );
        const edgeOrder = [...entries].sort((left, right) =>
            Buffer.compare(right.edgeBytes, left.edgeBytes)
        );
        const expectedRefs = entries
            .map((entry) => entry.binding.ref.value)
            .sort((left, right) => compareCanonicalText(left, right));
        const expectedEdges = entries.map((entry) => entry.edgeBytes).sort(Buffer.compare);
        const expectedLeases = entries.map((entry) => entry.leaseBytes).sort(Buffer.compare);

        expect(contentOrder.map((entry) => entry.binding.ref.value)).not.toEqual(expectedRefs);
        expect(edgeOrder.map((entry) => entry.edgeBytes)).not.toEqual(expectedEdges);
        expect(contentOrder.map((entry) => entry.leaseBytes)).not.toEqual(expectedLeases);

        const snapshot = store.transaction((transaction) => {
            for (const entry of contentOrder) {
                access.acquireInTransaction(transaction, entry.binding, at(10), entry.bytes);
            }
            for (const entry of edgeOrder) {
                retention.retain(transaction, entry.edge, at(10));
            }
            return transaction.snapshot();
        });

        expect(snapshot.content.map((row) => row.ref)).toEqual(expectedRefs);
        expect(snapshot.relations.map((row) => row.ref)).toEqual(expectedRefs);
        expect([...snapshot.edges]).toEqual(expectedEdges);
        expect([...snapshot.leases]).toEqual(expectedLeases);
    });

    test("revalidates deduplicated empty content byte for byte", { tags: "p0" }, async () => {
        const store = new MemoryContentStore();
        const first = await store.put(new Uint8Array());
        const second = await store.put(new Uint8Array());

        expect(second.ref.equals(first.ref)).toBe(true);
        await expect(store.get(first.ref)).resolves.toEqual(new Uint8Array());
        await expect(store.stat(first.ref)).resolves.toMatchObject({ size: 0 });
    });

    test("accepts a tombstone recorded at the epoch instant", { tags: "p1" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const stored = await store.put(encode("epoch-tombstone"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "epoch", stored.ref);

        store.transaction((transaction) => {
            retention.retain(transaction, edge, at(0));
            retention.release(transaction, edge, at(0));
        });

        expect(store.snapshot().relations).toEqual([{ ref: stored.ref.value, unownedSince: 0 }]);
        expect(MemoryContentStore.restore(store.snapshot()).snapshot()).toEqual(store.snapshot());
    });
});

describe("MemoryContentStore collection and lease generations", () => {
    test("collects unowned content in ascending reference order", { tags: "p1" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const edges: ContentOwnerEdge[] = [];
        for (const [index, label] of ["gc-a", "gc-b", "gc-c", "gc-d"].entries()) {
            const stored = await store.put(encode(label));
            edges.push(new ContentOwnerEdge(owner.tenant, owner.actor, `gc-${index}`, stored.ref));
        }
        const ascending = [...edges]
            .map((edge) => edge.ref.value)
            .sort((left, right) => compareCanonicalText(left, right));
        const descending = [...ascending].reverse();
        const releaseOrder = descending.map((value) =>
            defined(edges.find((edge) => edge.ref.value === value))
        );
        expect(descending).not.toEqual(ascending);

        const collected = store.transaction((transaction) => {
            for (const edge of releaseOrder) retention.retain(transaction, edge, at(10));
            for (const edge of releaseOrder) retention.release(transaction, edge, at(20));
            return retention.collect(transaction, { allowsCollection: () => true }, at(30));
        });

        expect(collected.map((ref) => ref.value)).toEqual(ascending);
    });

    test("withholds owned and actively leased content from policy", { tags: "p1" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const owned = await store.put(encode("policy-owned"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "policy-owned", owned.ref);
        store.transaction((transaction) => retention.retain(transaction, edge, at(10)));
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const leased = bindingFor("policy-leased", "policy-leased", at(100));
        await access.acquire(leased, encode("policy-leased"));

        const offered: string[] = [];
        const collected = store.transaction((transaction) =>
            retention.collect(
                transaction,
                {
                    allowsCollection(_transaction, candidate): boolean {
                        offered.push(candidate.stat.ref.value);
                        return true;
                    }
                },
                at(50)
            )
        );

        expect(offered).toEqual([]);
        expect(collected).toEqual([]);
        await expect(store.get(owned.ref)).resolves.toEqual(encode("policy-owned"));
        await expect(store.get(leased.ref)).resolves.toEqual(encode("policy-leased"));
    });

    test("recollects only while the tombstone instant is unchanged", { tags: "p0" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const stored = await store.put(encode("tombstone-race"));
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "tombstone-race", stored.ref);
        store.transaction((transaction) => {
            retention.retain(transaction, edge, at(10));
            retention.release(transaction, edge, at(20));
        });
        const binding = bindingFor("tombstone-race", "tombstone-race", at(60));
        const access = store.transient(owner.tenant, owner.actor, () => at(25));
        const acquired = new TransientContentLeaseState(
            owner.tenant,
            owner.actor,
            binding.envelopeDigest,
            binding.ref,
            binding.digest,
            at(25),
            binding.expiresAt
        );

        const collected = store.transaction((transaction) =>
            retention.collect(
                transaction,
                {
                    allowsCollection(): boolean {
                        access.acquireInTransaction(transaction, binding, at(25));
                        access.closeInTransaction(transaction, acquired, at(30));
                        return true;
                    }
                },
                at(35)
            )
        );

        expect(collected).toEqual([]);
        await expect(store.get(stored.ref)).resolves.toEqual(encode("tombstone-race"));
        expect(store.snapshot().relations).toEqual([{ ref: stored.ref.value, unownedSince: 30 }]);
    });

    test(
        "advances the tombstone of content a replacement lease drops",
        { tags: "p1" },
        async () => {
            const store = new MemoryContentStore();
            const owner = contentOwner();
            const retention = store.retention(owner.tenant, owner.actor);
            let now = at(10);
            const access = store.transient(owner.tenant, owner.actor, () => now);
            const first = bindingFor("displaced-first", "displaced", at(30));
            await access.acquire(first, encode("displaced-first"));
            now = at(35);
            const second = bindingFor("displaced-second", "displaced", at(60));
            await access.acquire(second, encode("displaced-second"));

            const offered = new Map<string, number>();
            const collected = store.transaction((transaction) =>
                retention.collect(
                    transaction,
                    {
                        allowsCollection(_transaction, candidate): boolean {
                            offered.set(candidate.stat.ref.value, candidate.unownedSince.getTime());
                            return false;
                        }
                    },
                    at(40)
                )
            );

            expect(collected).toEqual([]);
            expect(offered).toEqual(new Map([[first.ref.value, 30]]));
        }
    );

    test("keeps the later tombstone when a lease is acquired earlier", { tags: "p1" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);
        let now = at(10);
        const access = store.transient(owner.tenant, owner.actor, () => now);
        const initial = bindingFor("earlier-lease", "earlier-first", at(100));
        const lease = defined(await access.acquire(initial, encode("earlier-lease")));
        now = at(50);
        await lease.close();
        expect(store.snapshot().relations).toEqual([{ ref: initial.ref.value, unownedSince: 50 }]);

        now = at(20);
        expect(
            await access.acquire(bindingFor("earlier-lease", "earlier-second", at(200)))
        ).toBeDefined();
        expect(store.snapshot().relations).toEqual([{ ref: initial.ref.value, unownedSince: 50 }]);
    });

    test("removes only the collected content's transient leases", { tags: "p1" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        const retention = store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const expiring = bindingFor("lease-expiring", "lease-expiring", at(30));
        const surviving = bindingFor("lease-surviving", "lease-surviving", at(100));
        await access.acquire(expiring, encode("lease-expiring"));
        await access.acquire(surviving, encode("lease-surviving"));

        const collected = store.transaction((transaction) =>
            retention.collect(transaction, { allowsCollection: () => true }, at(35))
        );

        expect(collected.map((ref) => ref.value)).toEqual([expiring.ref.value]);
        const leases = store.snapshot().leases;
        expect(leases).toHaveLength(1);
        expect(
            TransientContentLeaseState.decode(defined(leases[0])).ref.equals(surviving.ref)
        ).toBe(true);
    });

    test("detaches transient lease reads from the stored bytes", { tags: "p0" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("lease-detach", "lease-detach", at(50));
        const lease = defined(await access.acquire(binding, encode("lease-detach")));
        const acquired = new TransientContentLeaseState(
            owner.tenant,
            owner.actor,
            binding.envelopeDigest,
            binding.ref,
            binding.digest,
            at(10),
            binding.expiresAt
        );

        expect(lease.read()).toEqual(encode("lease-detach"));
        store.transaction((transaction) => {
            const view = access.readInTransaction(transaction, acquired);
            expect(view).toEqual(encode("lease-detach"));
            expect(view).not.toBe(access.readInTransaction(transaction, acquired));
            view.fill(0);
            expect(access.readInTransaction(transaction, acquired)).toEqual(encode("lease-detach"));
        });
        await expect(store.get(binding.ref)).resolves.toEqual(encode("lease-detach"));
    });

    test("rejects lease bytes that contradict the binding digest", { tags: "p1" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);
        let now = at(10);
        const access = store.transient(owner.tenant, owner.actor, () => now);
        const binding = bindingFor("binding-bytes", "binding-bytes", at(50));

        await expectAgentCoreRejection(
            access.acquire(binding, encode("contradiction")),
            "codec.invalid",
            "Transient content binding does not match bytes"
        );
        await expect(store.stat(binding.ref)).resolves.toBeUndefined();

        const lease = defined(await access.acquire(binding, encode("binding-bytes")));
        now = at(20);
        await expectAgentCoreRejection(
            access.acquire(binding, encode("contradiction")),
            "codec.invalid",
            "Transient content binding does not match bytes"
        );
        expect(lease.read()).toEqual(encode("binding-bytes"));
    });

    test("rejects a lease handle from a replaced generation", { tags: "p1" }, async () => {
        for (const shift of ["acquisition", "expiration"] as const) {
            const store = new MemoryContentStore();
            const owner = contentOwner();
            store.retention(owner.tenant, owner.actor);
            let now = at(10);
            const access = store.transient(owner.tenant, owner.actor, () => now);
            const binding = bindingFor("generation", `generation-${shift}`, at(30));
            const lease = defined(await access.acquire(binding, encode("generation")));
            now = at(20);
            await lease.close();

            now = shift === "acquisition" ? at(25) : at(10);
            const replacement =
                shift === "acquisition" ? binding : { ...binding, expiresAt: at(50) };
            expect(await access.acquire(replacement)).toBeDefined();

            expectAgentCoreError(
                () => lease.read(),
                "protocol.invalid-state",
                "Transient content lease handle refers to a replaced generation"
            );
        }
    });

    test("rejects lease handles carrying a foreign Tenant or Actor", { tags: "p0" }, async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);
        const access = store.transient(owner.tenant, owner.actor, () => at(10));
        const binding = bindingFor("foreign-handle", "foreign-handle", at(30));
        const lease = defined(await access.acquire(binding, encode("foreign-handle")));
        expect(lease.read()).toEqual(encode("foreign-handle"));

        const handle = (tenant: TenantId, actor: ActorRef): TransientContentLeaseState =>
            new TransientContentLeaseState(
                tenant,
                actor,
                binding.envelopeDigest,
                binding.ref,
                binding.digest,
                at(10),
                binding.expiresAt
            );

        // The handle differs from the stored lease in exactly one identity field, so each
        // rejection names the conjunct under test rather than a neighbour catching it.
        for (const expected of [
            handle(new TenantId("tenant-foreign"), owner.actor),
            handle(owner.tenant, new ActorRef("workspace", new ActorId("actor-foreign")))
        ]) {
            expectAgentCoreError(
                () =>
                    store.transaction((transaction) =>
                        access.readInTransaction(transaction, expected)
                    ),
                "protocol.invalid-state",
                "Transient content lease handle refers to a replaced generation"
            );
        }
    });
});

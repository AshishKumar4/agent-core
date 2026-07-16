// @ts-nocheck
import { describe, expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../src/actors";
import * as content from "../../src/content";
import { type MemoryContentRetentionState, MemoryContentStore } from "../../src/content/memory";
import { ByteRange } from "../../src/content/range";
import { ContentOwnerEdge } from "../../src/content/retention";
import { ContentStat } from "../../src/content/stat";
import { TransientContentLeaseState } from "../../src/content/transient";
import { decodeCanonicalJson, encodeCanonicalJson } from "../../src/core";
import { contentStoreContract } from "./contract";
import {
    at,
    bindingFor,
    contentOwner,
    contentRetentionContract,
    expectAgentCoreError
} from "./retention-contract";

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
            operation: (transaction: MemoryContentRetentionState) => Result
        ): Result {
            return store.transaction(operation, ...([] as SynchronousResultGuard<Result>));
        },
        acquireInTransaction(transaction, binding, operationAt, bytes): unknown {
            return transient.acquireInTransaction(transaction, binding, operationAt, bytes);
        }
    };
});

describe("MemoryContentStore records", () => {
    test("keeps transient hold authority out of the public content surface", () => {
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

    test("keeps stored and returned bytes detached from hostile range behavior", async () => {
        const store = new MemoryContentStore();
        const stored = await store.put(new TextEncoder().encode("private"));
        let observed: Uint8Array | undefined;
        const hostile = {
            read(bytes: Uint8Array): Uint8Array {
                observed = bytes;
                bytes.fill(0);
                return bytes;
            }
        } as unknown as ByteRange;

        const returned = await store.get(stored.ref, hostile);
        expect(returned).not.toBe(observed);
        returned.fill(1);
        observed?.fill(2);
        await expect(store.get(stored.ref)).resolves.toEqual(new TextEncoder().encode("private"));
    });

    test("exposes only frozen, non-subclassable ByteRange values", () => {
        const range = ByteRange.slice(1, 2);
        expect(Object.isFrozen(range)).toBe(true);
        expect(Object.isFrozen(ByteRange.prototype)).toBe(true);
        expect(() =>
            Reflect.construct(
                ByteRange as unknown as Function,
                [0, undefined],
                function DerivedRange() {}
            )
        ).toThrow(TypeError);
        expect(() =>
            Object.defineProperty(range, "read", {
                value: (bytes: Uint8Array): Uint8Array => bytes
            })
        ).toThrow(TypeError);
    });

    test("[C13-CODEC-VERSIONING] round-trips stat and owner-edge records through versioned codecs", async () => {
        const store = new MemoryContentStore();
        const stored = await store.put(new TextEncoder().encode("codec"));
        const stat = await store.stat(stored.ref);
        const owner = contentOwner();
        const edge = new ContentOwnerEdge(owner.tenant, owner.actor, "codec-owner", stored.ref);

        expect(stat).toBeDefined();
        const decoded = ContentStat.decode(ContentStat.encode(stat!));
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

        const envelope = decodeCanonicalJson(ContentStat.encode(stat!));
        if (envelope === null || Array.isArray(envelope) || typeof envelope !== "object") {
            throw new TypeError("Expected content stat record envelope");
        }
        const envelopeObject = envelope as {
            readonly [key: string]: import("../../src/core").JsonValue;
        };
        const payload = envelopeObject["payload"];
        if (
            payload === null ||
            payload === undefined ||
            Array.isArray(payload) ||
            typeof payload !== "object"
        ) {
            throw new TypeError("Expected content stat record payload");
        }
        expect(() =>
            ContentStat.decode(
                encodeCanonicalJson({
                    ...envelopeObject,
                    payload: { ...payload, unknown: true }
                })
            )
        ).toThrow(/malformed/);
    });

    test("[content.owner-edge] [content.transient-lease] restores content, owner, tombstone, and lease state", async () => {
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
    });

    test("rolls back transient bytes, relation, and lease together", async () => {
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

    test("reacquires a closed same-envelope lease after snapshot restart", async () => {
        const store = new MemoryContentStore();
        const owner = contentOwner();
        store.retention(owner.tenant, owner.actor);
        let now = at(10);
        const access = store.transient(owner.tenant, owner.actor, () => now);
        const initial = bindingFor("memory crash retry", "memory-crash", at(30));
        const lease = await access.acquire(initial, new TextEncoder().encode("memory crash retry"));
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
    });
});

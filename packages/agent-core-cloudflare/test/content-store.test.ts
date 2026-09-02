import { describe, expect, test } from "vitest";
import { ByteRange, ContentRef, Digest, MediaHint, TenantId } from "@agent-core/core";
import { SqliteContentStore } from "@agent-core/core/substrates/sqlite";
import {
    CloudflareSqlite,
    R2ContentObjectRepository,
    R2ContentStore,
    R2_BUFFERED_OBJECT_LIMIT_BYTES,
    contentStoreFromR2Binding
} from "../src/index.js";
import { malformedInput } from "./assertions.js";
import { contentStoreContract } from "./content-store-contract.js";
import { FakeR2Bucket, fakeErrors } from "./fakes.js";
import { NodeDurableObjectStorage } from "./node-sqlite.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

// One bucket for every R2 store the contract builds, each store on its own Tenant: the
// substrate a deployment has is one bucket per environment, and Tenant scoping is what
// separates two stores inside it.
const contractBucket = new FakeR2Bucket();
let contractTenant = 0;

contentStoreContract("R2", async () => {
    contractTenant += 1;
    return new R2ContentStore(
        new R2ContentObjectRepository(contractBucket, fakeErrors),
        new TenantId(`content-contract-${contractTenant}`),
        fakeErrors
    );
});

contentStoreContract("Durable Object SQLite", async () => {
    return new SqliteContentStore(new CloudflareSqlite(new NodeDurableObjectStorage(), fakeErrors));
});

describe("R2ContentStore", () => {
    test(
        "[C13-CONTENT-RESOLUTION] answers a window from R2 rather than from a buffered whole",
        { tags: "p1" },
        async () => {
            const bucket = new FakeR2Bucket();
            const store = new R2ContentStore(
                new R2ContentObjectRepository(bucket, fakeErrors),
                new TenantId("windowed"),
                fakeErrors
            );
            const stored = await store.put(bytes("abcdefghij"));
            bucket.getCalls.length = 0;
            bucket.headCalls.length = 0;

            expect(await store.get(stored.ref, ByteRange.slice(3, 4))).toEqual(bytes("defg"));

            // The window R2 was asked for is the window the caller named: the range is not
            // a slice taken after buffering the object. It costs the stat that bounded it
            // and one ranged read, and nothing else.
            expect(bucket.getCalls.map((call) => call.range)).toEqual([{ offset: 3, length: 4 }]);
            expect(bucket.headCalls).toHaveLength(1);

            // A whole read names no window, so it stays one unranged call.
            bucket.getCalls.length = 0;
            bucket.headCalls.length = 0;
            expect(await store.get(stored.ref)).toEqual(bytes("abcdefghij"));
            expect(bucket.getCalls.map((call) => call.range)).toEqual([undefined]);
            expect(bucket.headCalls).toEqual([]);
        }
    );

    test(
        "[C13-CONTENT-RESOLUTION] refuses an over-long window R2 would have clamped",
        { tags: "p0" },
        async () => {
            const bucket = new FakeR2Bucket();
            const store = new R2ContentStore(
                new R2ContentObjectRepository(bucket, fakeErrors),
                new TenantId("clamping"),
                fakeErrors
            );
            const stored = await store.put(bytes("abcdef"));
            const key = bucket.putCalls[0]?.key ?? "";
            bucket.getCalls.length = 0;
            bucket.bodyReads.length = 0;

            // The substrate itself would answer the over-long window with fewer bytes.
            const clamped = await bucket.get(key, { range: { offset: 4, length: 10 } });
            expect(new Uint8Array((await clamped?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
                bytes("ef")
            );

            bucket.getCalls.length = 0;
            bucket.bodyReads.length = 0;
            await expect(store.get(stored.ref, ByteRange.slice(4, 10))).rejects.toMatchObject({
                code: "content.invalid-range"
            });
            // Refused from the stat alone: no window was requested and no body buffered.
            expect(bucket.getCalls).toEqual([]);
            expect(bucket.bodyReads).toEqual([]);
        }
    );

    test(
        "[C13-CONTENT-RESOLUTION] serves an empty window without asking R2 for a body",
        { tags: "p2" },
        async () => {
            const bucket = new FakeR2Bucket();
            const store = new R2ContentStore(
                new R2ContentObjectRepository(bucket, fakeErrors),
                new TenantId("empty-window"),
                fakeErrors
            );
            const stored = await store.put(bytes("abc"));
            bucket.getCalls.length = 0;

            expect(await store.get(stored.ref, ByteRange.slice(3, 0))).toEqual(new Uint8Array());
            expect(bucket.getCalls).toEqual([]);
        }
    );

    test(
        "[C13-CLOUDFLARE-STORAGE-LIMIT] refuses an oversized object and window before buffering either",
        { tags: "p0" },
        async () => {
            const bucket = new FakeR2Bucket();
            const repository = new R2ContentObjectRepository(bucket, fakeErrors);
            const store = new R2ContentStore(repository, new TenantId("bounded"), fakeErrors);
            const stored = await store.put(bytes("small"));
            const key = bucket.putCalls[0]?.key ?? "";
            // What R2 reports is what the bound is measured against, so an object past it
            // is refused without the bytes ever existing in this isolate.
            bucket.declareSize(key, R2_BUFFERED_OBJECT_LIMIT_BYTES + 1);
            bucket.bodyReads.length = 0;

            await expect(store.get(stored.ref)).rejects.toMatchObject({
                code: "operation.invalid-input"
            });
            await expect(
                store.get(stored.ref, ByteRange.slice(0, R2_BUFFERED_OBJECT_LIMIT_BYTES + 1))
            ).rejects.toMatchObject({ code: "operation.invalid-input" });
            expect(bucket.bodyReads).toEqual([]);

            // stat buffers nothing, so it answers for the object the reads refuse — which is
            // how a caller learns it must read the object in windows.
            await expect(store.stat(stored.ref)).resolves.toMatchObject({
                size: R2_BUFFERED_OBJECT_LIMIT_BYTES + 1
            });
            // A window inside the bound is served from an object past it.
            expect(await store.get(stored.ref, ByteRange.slice(0, 5))).toEqual(bytes("small"));
        }
    );

    test(
        "[C13-CONTENT-RESOLUTION] refuses a platform size and a stored media type it could not have written",
        { tags: "p1" },
        async () => {
            const bucket = new FakeR2Bucket();
            const store = new R2ContentStore(
                new R2ContentObjectRepository(bucket, fakeErrors),
                new TenantId("stored-values"),
                fakeErrors
            );
            const stored = await store.put(bytes("value"), new MediaHint("text/plain"));
            const key = bucket.putCalls[0]?.key ?? "";

            bucket.declareSize(key, Number.NaN);
            await expect(store.stat(stored.ref)).rejects.toMatchObject({
                code: "operation.invalid-output"
            });

            bucket.declareSize(key, 5);
            bucket.corruptMetadata(key, "agent-core-media-type", " ");
            await expect(store.stat(stored.ref)).rejects.toMatchObject({
                code: "codec.invalid"
            });
        }
    );

    test(
        "[C13-CONTENT-RESOLUTION] refuses a reference and a hint that are not the seam's own values",
        { tags: "p2" },
        async () => {
            const bucket = new FakeR2Bucket();
            const store = contentStoreFromR2Binding(
                { CONTENT: bucket },
                (environment) => environment.CONTENT,
                new TenantId("hostile"),
                fakeErrors
            );

            await expect(store.get(malformedInput("sha256:not-a-ref"))).rejects.toMatchObject({
                code: "operation.invalid-input"
            });
            await expect(
                store.stat(malformedInput({ digest: { value: "0" } }))
            ).rejects.toMatchObject({ code: "operation.invalid-input" });
            await expect(
                store.put(bytes("x"), malformedInput({ mediaType: "text/plain" }))
            ).rejects.toMatchObject({ code: "operation.invalid-input" });
        }
    );

    test(
        "[C13-CONTENT-RESOLUTION] resolves a digest R2 answers with the wrong body length",
        { tags: "p1" },
        async () => {
            const bucket = new FakeR2Bucket();
            const store = new R2ContentStore(
                new R2ContentObjectRepository(bucket, fakeErrors),
                new TenantId("short-answer"),
                fakeErrors
            );
            const stored = await store.put(bytes("abcdef"));
            const key = bucket.putCalls[0]?.key ?? "";
            // The object still declares six bytes while holding three, so the ranged read
            // is answered short: a platform that serves a window it did not honour.
            bucket.corruptBody(key, bytes("abc"));
            bucket.declareSize(key, 6);

            await expect(store.get(stored.ref, ByteRange.slice(0, 5))).rejects.toMatchObject({
                code: "operation.invalid-output"
            });
        }
    );

    test(
        "[C13-CONTENT-RESOLUTION] keeps one Tenant's content unreachable through another's store",
        { tags: "p0" },
        async () => {
            const bucket = new FakeR2Bucket();
            const repository = new R2ContentObjectRepository(bucket, fakeErrors);
            const owner = new R2ContentStore(repository, new TenantId("owner"), fakeErrors);
            const other = new R2ContentStore(repository, new TenantId("other"), fakeErrors);
            const stored = await owner.put(bytes("tenant-owned"));

            await expect(other.stat(stored.ref)).resolves.toBeUndefined();
            await expect(other.get(stored.ref)).rejects.toMatchObject({
                code: "content.not-found"
            });
            await expect(other.get(stored.ref, ByteRange.from(1))).rejects.toMatchObject({
                code: "content.not-found"
            });
            expect(
                (await owner.stat(new ContentRef(`sha256:${"0".repeat(64)}`))) ?? undefined
            ).toBeUndefined();
            expect(stored.digest.equals(Digest.sha256(bytes("tenant-owned")))).toBe(true);
        }
    );

    test(
        "[C13-CONTENT-RESOLUTION] verifies a whole-object window and refuses an object that changed under it",
        { tags: "p1" },
        async () => {
            const bucket = new FakeR2Bucket();
            const store = new R2ContentStore(
                new R2ContentObjectRepository(bucket, fakeErrors),
                new TenantId("verified-window"),
                fakeErrors
            );
            const stored = await store.put(bytes("abcdef"));
            const key = bucket.putCalls[0]?.key ?? "";
            bucket.corruptBody(key, bytes("uvwxyz"));

            // A window covering the whole object is the one window the address can check,
            // and it is checked: same length, different bytes, refused.
            await expect(store.get(stored.ref, ByteRange.slice(0, 6))).rejects.toMatchObject({
                code: "codec.invalid"
            });
            // A declared size disagreeing with the body it stores is the object itself
            // being inconsistent, whichever read reaches it.
            bucket.declareSize(key, 4);
            await expect(store.get(stored.ref)).rejects.toMatchObject({ code: "codec.invalid" });
        }
    );

    test(
        "[C13-CONTENT-RESOLUTION] reports content lost between the stat and the window read",
        { tags: "p2" },
        async () => {
            const bucket = new FakeR2Bucket();
            // A store whose object is deleted after the stat that bounded the window: the
            // window was inside the object when it was resolved and there is nothing to
            // serve it from now, which is an unresolved reference and not a range error.
            const racing = new R2ContentStore(
                new R2ContentObjectRepository(
                    {
                        put: (key, value, options) => bucket.put(key, value, options),
                        head: (key) => bucket.head(key),
                        get: async () => null
                    },
                    fakeErrors
                ),
                new TenantId("racing"),
                fakeErrors
            );
            const stored = await new R2ContentStore(
                new R2ContentObjectRepository(bucket, fakeErrors),
                new TenantId("racing"),
                fakeErrors
            ).put(bytes("vanishing"));

            await expect(racing.get(stored.ref, ByteRange.from(2))).rejects.toMatchObject({
                code: "content.not-found"
            });
        }
    );
});

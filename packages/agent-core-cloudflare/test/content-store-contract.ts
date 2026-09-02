import { describe, expect, test } from "vitest";
import { AgentCoreError, ByteRange, MediaHint, type ContentStore } from "@agent-core/core";

/**
 * The §8.2 ContentStore contract, run against every substrate this package offers one on.
 * The body is the one in the core package's test/content/contract.ts — same claims, same
 * order, same titles — restated here rather than imported: a cross-package import of that
 * file would pull the core store, ByteRange and AgentCoreError in from source while the
 * substrate under test carries the built package, and two AgentCoreError classes make
 * `toBeInstanceOf` and every code assertion meaningless. Restating it keeps one body per
 * runtime with one class identity, and this module is the single body both the structural
 * and the workerd suite run.
 *
 * `create` is asynchronous because a Cloudflare substrate is reached through a binding: an
 * R2 store is bound to a bucket and a Durable Object's SQLite store to its instance. It
 * MUST answer an independently addressed store on every call — a fresh database, or a
 * fresh Tenant over the same bucket, which is the R2 substrate's own form of independence
 * and what makes the unresolved-reference case a Tenant-scoping claim as well.
 */
export type ContentStoreFactory = () => Promise<ContentStore>;

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

export function contentStoreContract(name: string, create: ContentStoreFactory): void {
    describe(`${name} ContentStore contract`, () => {
        test("puts, resolves, and stats content-addressed bytes", { tags: "p1" }, async () => {
            const store = await create();
            const stored = await store.put(encode("content"), new MediaHint("text/plain"));

            expect(stored.ref.digest.equals(stored.digest)).toBe(true);
            expect(stored.ref.value).toBe(`sha256:${stored.digest.value}`);
            expect(decode(await store.get(stored.ref))).toBe("content");
            await expect(store.stat(stored.ref)).resolves.toMatchObject({
                ref: stored.ref,
                digest: stored.digest,
                size: 7,
                hint: { mediaType: "text/plain" }
            });
        });

        test("deduplicates equal bytes by content address", { tags: "p1" }, async () => {
            const store = await create();
            const first = await store.put(encode("same"), new MediaHint("text/plain"));
            const second = await store.put(
                encode("same"),
                new MediaHint("application/octet-stream")
            );

            expect(second.ref.equals(first.ref)).toBe(true);
            expect(second.digest.equals(first.digest)).toBe(true);
            await expect(store.stat(first.ref)).resolves.toMatchObject({
                hint: { mediaType: "text/plain" }
            });
        });

        test("detaches input and every returned byte range", { tags: "p0" }, async () => {
            const store = await create();
            const input = encode("abcdef");
            const stored = await store.put(input);
            input[0] = 0;

            const first = await store.get(stored.ref);
            first[1] = 0;

            expect(decode(await store.get(stored.ref))).toBe("abcdef");
            expect(decode(await store.get(stored.ref, ByteRange.from(2)))).toBe("cdef");
            expect(decode(await store.get(stored.ref, ByteRange.slice(1, 3)))).toBe("bcd");
            expect(await store.get(stored.ref, ByteRange.slice(6, 0))).toEqual(new Uint8Array());
        });

        test("rejects ranges outside the content bounds", { tags: "p1" }, async () => {
            const store = await create();
            const stored = await store.put(encode("abc"));

            await expect(store.get(stored.ref, ByteRange.from(4))).rejects.toMatchObject({
                code: "content.invalid-range"
            });
            await expect(store.get(stored.ref, ByteRange.slice(2, 2))).rejects.toMatchObject({
                code: "content.invalid-range"
            });
            expect(() => ByteRange.from(-1)).toThrow(TypeError);
            expect(() => ByteRange.slice(Number.MAX_SAFE_INTEGER, 1)).toThrow(TypeError);
        });

        test("distinguishes an unresolved store-produced reference", { tags: "p1" }, async () => {
            const source = await create();
            const target = await create();
            const stored = await source.put(encode("only in source"));

            await expect(target.stat(stored.ref)).resolves.toBeUndefined();
            const missing = target.get(stored.ref);
            await expect(missing).rejects.toBeInstanceOf(AgentCoreError);
            await expect(missing).rejects.toMatchObject({ code: "content.not-found" });
        });
    });
}

// @ts-nocheck
import { describe, expect, test } from "vitest";
import { MediaHint } from "../../src/content/media";
import { ByteRange } from "../../src/content/range";
import type { ContentStore } from "../../src/content/store";
import { AgentCoreError } from "../../src/errors";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

export function contentStoreContract(name: string, create: () => ContentStore): void {
    describe(`${name} ContentStore contract`, () => {
        test("puts, resolves, and stats content-addressed bytes", async () => {
            const store = create();
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

        test("deduplicates equal bytes by content address", async () => {
            const store = create();
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

        test("detaches input and every returned byte range", async () => {
            const store = create();
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

        test("rejects ranges outside the content bounds", async () => {
            const store = create();
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

        test("distinguishes an unresolved store-produced reference", async () => {
            const source = create();
            const target = create();
            const stored = await source.put(encode("only in source"));

            await expect(target.stat(stored.ref)).resolves.toBeUndefined();
            await expect(target.get(stored.ref)).rejects.toSatisfy(
                (error: unknown) =>
                    error instanceof AgentCoreError && error.code === "content.not-found"
            );
        });
    });
}

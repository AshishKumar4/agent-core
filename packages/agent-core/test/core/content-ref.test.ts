import { describe, expect, test } from "vitest";
import { ContentRef, Digest } from "../../src/core";

const DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("ContentRef", () => {
    test("round-trips a SHA-256 content address through a detached digest", () => {
        const digest = new Digest(DIGEST);
        const ref = ContentRef.fromDigest(digest);

        expect(ref.value).toBe(`sha256:${DIGEST}`);
        expect(ref.digest.equals(digest)).toBe(true);
        expect(ref.digest).not.toBe(digest);
        expect(ref.equals(new ContentRef(ref.value))).toBe(true);
    });

    test("is deeply runtime immutable", () => {
        const ref = new ContentRef(`sha256:${DIGEST}`);

        expect(Object.isFrozen(ref)).toBe(true);
        expect(Object.isFrozen(ref.digest)).toBe(true);
        expect(() => {
            (ref as { digest: Digest }).digest = new Digest("0".repeat(64));
        }).toThrow(TypeError);
    });

    test("rejects noncanonical addresses and counterfeit digests", () => {
        for (const value of [
            DIGEST,
            `SHA256:${DIGEST}`,
            `sha256:${DIGEST.toUpperCase()}`,
            "sha256:0"
        ]) {
            expect(() => new ContentRef(value)).toThrow(TypeError);
        }
        expect(() =>
            ContentRef.fromDigest({
                algorithm: "sha256",
                value: DIGEST
            } as Digest)
        ).toThrow(TypeError);
    });
});

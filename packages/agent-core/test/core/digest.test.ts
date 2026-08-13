import { describe, expect, test } from "vitest";
import { Digest, type DigestAlgorithm } from "../../src/core";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** The digest's own fields without their readonly modifier, so a write can be attempted. */
interface WritableDigest {
    algorithm: string;
}

describe("Digest", () => {
    test("matches the SHA-256 abc vector", { tags: "p0" }, () => {
        const bytes = new TextEncoder().encode("abc");

        expect(Digest.sha256(bytes).value).toBe(ABC_SHA256);
        expect(bytes).toEqual(new TextEncoder().encode("abc"));
    });

    test("is runtime immutable", { tags: "p0" }, () => {
        const digest = new Digest(ABC_SHA256);
        const writable: WritableDigest = digest;

        expect(Object.isFrozen(digest)).toBe(true);
        expect(() => {
            writable.algorithm = "sha512";
        }).toThrow(TypeError);
        expect(digest.algorithm).toBe("sha256");
    });

    test("rejects malformed values, unsupported algorithms, and non-byte input", { tags: "p0" }, () => {
        for (const value of ["", "A".repeat(64), "0".repeat(63), "g".repeat(64)]) {
            expect(() => new Digest(value)).toThrow(TypeError);
        }
        // SAFETY: DigestAlgorithm admits only "sha256", so the unsupported algorithm the
        // constructor has to reject is unreachable from typed code; offering it is the test.
        expect(() => new Digest(ABC_SHA256, "sha512" as DigestAlgorithm)).toThrow(TypeError);
        expect(() => digestOf("abc")).toThrow(TypeError);
    });

    test("anchors the hexadecimal pattern at both ends", { tags: "p0" }, () => {
        for (const value of [`z${ABC_SHA256}`, `${ABC_SHA256}z`, ` ${ABC_SHA256}`]) {
            expectTypeFailure(
                () => new Digest(value),
                "Digest must be a lowercase SHA-256 hexadecimal value"
            );
        }
        expectTypeFailure(() => new Digest(""), "Digest must contain between 1 and 256 characters");
    });
});

/**
 * Hashes a value `Digest.sha256` declares it will not receive. Its `instanceof Uint8Array`
 * guard exists for JavaScript callers, so the suite has to cross the declared parameter
 * type to reach it; this is the one place it does.
 */
function digestOf(input: Uint8Array | string): Digest {
    // SAFETY: the argument is deliberately not a Uint8Array. It reaches `sha256` only so
    // the byte-input guard can reject it before any hashing happens.
    return Digest.sha256(input as Uint8Array);
}

function expectTypeFailure(action: () => void, message: string): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ message });
}

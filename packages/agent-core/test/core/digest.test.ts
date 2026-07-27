import { describe, expect, test } from "vitest";
import { Digest, type DigestAlgorithm } from "../../src/core";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("Digest", () => {
    test("matches the SHA-256 abc vector", () => {
        const bytes = new TextEncoder().encode("abc");

        expect(Digest.sha256(bytes).value).toBe(ABC_SHA256);
        expect(bytes).toEqual(new TextEncoder().encode("abc"));
    });

    test("is runtime immutable", () => {
        const digest = new Digest(ABC_SHA256);

        expect(Object.isFrozen(digest)).toBe(true);
        expect(() => {
            (digest as { algorithm: string }).algorithm = "sha512";
        }).toThrow(TypeError);
        expect(digest.algorithm).toBe("sha256");
    });

    test("rejects malformed values, unsupported algorithms, and non-byte input", () => {
        for (const value of ["", "A".repeat(64), "0".repeat(63), "g".repeat(64)]) {
            expect(() => new Digest(value)).toThrow(TypeError);
        }
        expect(() => new Digest(ABC_SHA256, "sha512" as DigestAlgorithm)).toThrow(TypeError);
        expect(() => Digest.sha256("abc" as unknown as Uint8Array)).toThrow(TypeError);
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

function expectTypeFailure(action: () => unknown, message: string): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ message });
}

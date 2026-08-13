import { describe, expect, test } from "vitest";
import { SecretRef } from "../../src/core";

/** A reference's own fields without their readonly modifier, so a write can be attempted. */
interface WritableSecretRef {
    id: string;
}

/** The public fields of a reference, carried by a value that never ran the constructor. */
interface SecretRefFields {
    readonly source: string;
    readonly provider: string;
    readonly id: string;
}

describe("SecretRef", () => {
    test("validates and compares structured references", { tags: "p1" }, () => {
        const ref = new SecretRef("tenant", "vault", "credentials/service");

        expect(ref).toEqual({
            source: "tenant",
            provider: "vault",
            id: "credentials/service"
        });
        expect(ref.equals(new SecretRef("tenant", "vault", "credentials/service"))).toBe(true);
        expect(ref.equals(new SecretRef("tenant", "vault", "credentials/other"))).toBe(false);
    });

    test("is runtime immutable", { tags: "p0" }, () => {
        const ref = new SecretRef("tenant", "vault", "id");
        const writable: WritableSecretRef = ref;

        expect(Object.isFrozen(ref)).toBe(true);
        expect(() => {
            writable.id = "changed";
        }).toThrow(TypeError);
        expect(ref.id).toBe("id");
    });

    test("rejects blank, oversized, non-string, and invalid Unicode components", { tags: "p2" }, () => {
        for (const value of ["", "   ", "x".repeat(2049), "\ud800", null, 1]) {
            const component = candidateComponent(value);

            expect(() => new SecretRef(component, "vault", "id")).toThrow(TypeError);
            expect(() => new SecretRef("tenant", component, "id")).toThrow(TypeError);
            expect(() => new SecretRef("tenant", "vault", component)).toThrow(TypeError);
        }
    });

    test("compares source, provider, and id independently", { tags: "p1" }, () => {
        const ref = new SecretRef("tenant", "vault", "id");

        expect(ref.equals(new SecretRef("other", "vault", "id"))).toBe(false);
        expect(ref.equals(new SecretRef("tenant", "other", "id"))).toBe(false);
        expect(ref.equals(new SecretRef("tenant", "vault", "other"))).toBe(false);
        expect(
            ref.equals(candidateComparand({ id: "id", provider: "vault", source: "tenant" }))
        ).toBe(false);
        expect(ref.equals(candidateComparand(null))).toBe(false);
    });

    test("names the failing component and admits the exact bound", { tags: "p1" }, () => {
        const longest = "x".repeat(2048);

        expect(new SecretRef(longest, "vault", "id").source).toBe(longest);
        expect(new SecretRef("tenant", longest, "id").provider).toBe(longest);
        expect(new SecretRef("tenant", "vault", longest).id).toBe(longest);
        expectTypeFailure(
            () => new SecretRef(candidateComponent(1), "vault", "id"),
            "Secret reference source must not be blank or exceed 2048 characters"
        );
        expectTypeFailure(
            () => new SecretRef("tenant", candidateComponent(1), "id"),
            "Secret reference provider must not be blank or exceed 2048 characters"
        );
        expectTypeFailure(
            () => new SecretRef("tenant", "vault", "x".repeat(2049)),
            "Secret reference id must not be blank or exceed 2048 characters"
        );
    });
});

/**
 * Offers a value where the constructor declares a string component. Deciding is the
 * guard's job — blank, oversized, lone-surrogate, and non-string values must all be
 * rejected — so the suite has to be able to offer what the declaration excludes.
 */
function candidateComponent(value: string | number | null): string {
    // SAFETY: the value is a candidate, not a proven component. It reaches the constructor
    // only so `requireSecretComponent` can reject it; nothing here reads it as a string.
    return value as string;
}

/**
 * Presents a comparand `equals` declares it will not receive: a structural twin that never
 * ran the constructor, or no reference at all. Its `instanceof` check exists for exactly
 * those, so reaching it means crossing the declared parameter type.
 */
function candidateComparand(value: SecretRefFields | null): SecretRef {
    // SAFETY: the argument is deliberately not a SecretRef. It reaches `equals` only so the
    // instanceof check can answer false for it.
    return value as SecretRef;
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

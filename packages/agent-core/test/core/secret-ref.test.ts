import { describe, expect, test } from "vitest";
import { SecretRef } from "../../src/core";

describe("SecretRef", () => {
    test("validates and compares structured references", () => {
        const ref = new SecretRef("tenant", "vault", "credentials/service");

        expect(ref).toEqual({
            source: "tenant",
            provider: "vault",
            id: "credentials/service"
        });
        expect(ref.equals(new SecretRef("tenant", "vault", "credentials/service"))).toBe(true);
        expect(ref.equals(new SecretRef("tenant", "vault", "credentials/other"))).toBe(false);
    });

    test("is runtime immutable", () => {
        const ref = new SecretRef("tenant", "vault", "id");

        expect(Object.isFrozen(ref)).toBe(true);
        expect(() => {
            (ref as { id: string }).id = "changed";
        }).toThrow(TypeError);
        expect(ref.id).toBe("id");
    });

    test("rejects blank, oversized, non-string, and invalid Unicode components", () => {
        for (const value of ["", "   ", "x".repeat(2049), "\ud800", null, 1]) {
            expect(() => new SecretRef(value as string, "vault", "id")).toThrow(TypeError);
            expect(() => new SecretRef("tenant", value as string, "id")).toThrow(TypeError);
            expect(() => new SecretRef("tenant", "vault", value as string)).toThrow(TypeError);
        }
    });

    test("compares source, provider, and id independently", { tags: "p1" }, () => {
        const ref = new SecretRef("tenant", "vault", "id");

        expect(ref.equals(new SecretRef("other", "vault", "id"))).toBe(false);
        expect(ref.equals(new SecretRef("tenant", "other", "id"))).toBe(false);
        expect(ref.equals(new SecretRef("tenant", "vault", "other"))).toBe(false);
        expect(
            ref.equals({ id: "id", provider: "vault", source: "tenant" } as unknown as SecretRef)
        ).toBe(false);
        expect(ref.equals(null as unknown as SecretRef)).toBe(false);
    });

    test("names the failing component and admits the exact bound", { tags: "p1" }, () => {
        const longest = "x".repeat(2048);

        expect(new SecretRef(longest, "vault", "id").source).toBe(longest);
        expect(new SecretRef("tenant", longest, "id").provider).toBe(longest);
        expect(new SecretRef("tenant", "vault", longest).id).toBe(longest);
        expectTypeFailure(
            () => new SecretRef(1 as unknown as string, "vault", "id"),
            "Secret reference source must not be blank or exceed 2048 characters"
        );
        expectTypeFailure(
            () => new SecretRef("tenant", 1 as unknown as string, "id"),
            "Secret reference provider must not be blank or exceed 2048 characters"
        );
        expectTypeFailure(
            () => new SecretRef("tenant", "vault", "x".repeat(2049)),
            "Secret reference id must not be blank or exceed 2048 characters"
        );
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

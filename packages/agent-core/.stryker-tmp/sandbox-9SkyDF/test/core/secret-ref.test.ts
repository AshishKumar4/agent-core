// @ts-nocheck
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
});

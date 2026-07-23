import { describe, expect, test } from "vitest";
import { ProtectionDomain } from "../../src/facets";

describe("ProtectionDomain", () => {
    test("accepts labels at both length boundaries and rejects beyond them", { tags: "p0" }, () => {
        expect(new ProtectionDomain("backend", "x", "no-secrets").label).toBe("x");
        expect(new ProtectionDomain("backend", "x".repeat(128), "no-secrets").label).toBe(
            "x".repeat(128)
        );
        expect(() => new ProtectionDomain("backend", "", "no-secrets")).toThrow(
            /between 1 and 128 characters/
        );
        expect(() => new ProtectionDomain("backend", "x".repeat(129), "no-secrets")).toThrow(
            /between 1 and 128 characters/
        );
    });

    test("derives secret holding from the secret policy alone", { tags: "p0" }, () => {
        expect(new ProtectionDomain("backend", "api", "may-hold-secrets").canHoldSecrets).toBe(
            true
        );
        expect(new ProtectionDomain("backend", "api", "no-secrets").canHoldSecrets).toBe(false);
        expect(new ProtectionDomain("frontend", "ui", "no-secrets").canHoldSecrets).toBe(false);
        expect(() => new ProtectionDomain("frontend", "ui", "may-hold-secrets")).toThrow(
            /cannot hold secrets/
        );
    });

    test("equality requires kind, label, and secret policy to all match", { tags: "p0" }, () => {
        const domain = new ProtectionDomain("backend", "api", "no-secrets");
        expect(domain.equals(new ProtectionDomain("backend", "api", "no-secrets"))).toBe(true);
        expect(domain.equals(new ProtectionDomain("frontend", "api", "no-secrets"))).toBe(false);
        expect(domain.equals(new ProtectionDomain("backend", "other", "no-secrets"))).toBe(false);
        expect(domain.equals(new ProtectionDomain("backend", "api", "may-hold-secrets"))).toBe(
            false
        );
    });
});

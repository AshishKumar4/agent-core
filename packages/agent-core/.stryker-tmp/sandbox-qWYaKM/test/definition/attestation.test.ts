// @ts-nocheck
import { describe, expect, test } from "vitest";
import { Digest, SemVer } from "../../src/core";
import { PlatformCompatibility, ValidationAttestation } from "../../src/definition";

const encoder = new TextEncoder();

describe("ValidationAttestation", () => {
    test("[definition.validation-attestation] round-trips every validation input under one content-derived identity", () => {
        const attestation = createAttestation();
        const bytes = ValidationAttestation.encode(attestation);
        const decoded = ValidationAttestation.decode(bytes);
        expect(ValidationAttestation.encode(decoded)).toEqual(bytes);
        expect(decoded.id.equals(attestation.id)).toBe(true);
        expect(Object.isFrozen(decoded)).toBe(true);
        const { id: _id, ...attestationInput } = attestation;
        expect(
            new ValidationAttestation({
                ...attestationInput,
                validatorVersion: "custom-validator.v1"
            }).validatorVersion
        ).toBe("custom-validator.v1");
    });

    test("rejects forged identities malformed data and noncanonical validator versions", () => {
        const attestation = createAttestation();
        expect(
            () =>
                new ValidationAttestation({
                    ...attestation,
                    id: digest("forged")
                })
        ).toThrow(/attestation ID/);
        expect(
            () =>
                new ValidationAttestation({
                    ...attestation,
                    validatorVersion: " padded "
                })
        ).toThrow(/canonical/);
        expect(() => ValidationAttestation.fromData(null)).toThrow(/must be an object/);
        expect(() =>
            ValidationAttestation.fromData({
                ...(attestation.toData() as object),
                unknown: true
            })
        ).toThrow(/missing or unknown/);
        expect(() =>
            ValidationAttestation.fromData({
                ...(attestation.toData() as object),
                definitionDigest: 7
            })
        ).toThrow(/must be a string/);
    });
});

describe("PlatformCompatibility", () => {
    test("[definition.platform-compatibility] round-trips exact target versions and rejects malformed targets", () => {
        const target = new PlatformCompatibility({
            spec: new SemVer("1.2.3"),
            host: new SemVer("4.5.6")
        });
        expect(
            PlatformCompatibility.decode(PlatformCompatibility.encode(target)).equals(target)
        ).toBe(true);
        expect(() => PlatformCompatibility.fromData(null)).toThrow(/must be an object/);
        expect(() => PlatformCompatibility.fromData({ spec: "1.0.0" })).toThrow(/missing/);
        expect(() => PlatformCompatibility.fromData({ spec: 1, host: "1.0.0" })).toThrow(/missing/);
    });
});

function createAttestation(): ValidationAttestation {
    return new ValidationAttestation({
        definitionDigest: digest("definition"),
        blueprintDigest: digest("blueprint"),
        packageLockDigest: digest("lock"),
        snapshotDigest: digest("snapshot"),
        configSchemaDigest: digest("schema"),
        declarationDigest: digest("declarations"),
        placementDigest: digest("placements"),
        target: new PlatformCompatibility({
            spec: new SemVer("1.0.0"),
            host: new SemVer("1.0.0")
        })
    });
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

import {
    Digest,
    RecordCodec,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";
import { PlatformCompatibility } from "./compatibility";

export interface ValidationAttestationInit {
    readonly definitionDigest: Digest;
    readonly blueprintDigest: Digest;
    readonly packageLockDigest: Digest;
    readonly snapshotDigest: Digest;
    readonly configSchemaDigest: Digest;
    readonly declarationDigest: Digest;
    readonly placementDigest: Digest;
    readonly target: PlatformCompatibility;
    readonly validatorVersion?: string;
    readonly id?: Digest;
}

class ValidationAttestationCodec extends RecordCodec<ValidationAttestation> {
    public constructor() {
        super("definition.validation-attestation", { major: 1, minor: 0 });
    }

    protected encodePayload(attestation: ValidationAttestation): JsonValue {
        return attestation.toData();
    }

    protected decodePayload(payload: JsonValue): ValidationAttestation {
        return ValidationAttestation.fromData(payload);
    }
}

export class ValidationAttestation {
    public static readonly codec: RecordCodec<ValidationAttestation> =
        new ValidationAttestationCodec();
    public static readonly currentValidatorVersion = "definition-validator.v1";

    public readonly id: Digest;
    public readonly definitionDigest: Digest;
    public readonly blueprintDigest: Digest;
    public readonly packageLockDigest: Digest;
    public readonly snapshotDigest: Digest;
    public readonly configSchemaDigest: Digest;
    public readonly declarationDigest: Digest;
    public readonly placementDigest: Digest;
    public readonly target: PlatformCompatibility;
    public readonly validatorVersion: string;

    public constructor(init: ValidationAttestationInit) {
        const validatorVersion = requireCanonicalName(
            init.validatorVersion ?? ValidationAttestation.currentValidatorVersion,
            "Validator version"
        );
        const data = attestationData({ ...init, validatorVersion });
        const id = Digest.sha256(encodeCanonicalJson(data));
        if (init.id !== undefined && !init.id.equals(id)) {
            throw new TypeError("Validation attestation ID does not match its canonical contents");
        }
        this.id = id;
        this.definitionDigest = init.definitionDigest;
        this.blueprintDigest = init.blueprintDigest;
        this.packageLockDigest = init.packageLockDigest;
        this.snapshotDigest = init.snapshotDigest;
        this.configSchemaDigest = init.configSchemaDigest;
        this.declarationDigest = init.declarationDigest;
        this.placementDigest = init.placementDigest;
        this.target = PlatformCompatibility.fromData(init.target.toData());
        this.validatorVersion = validatorVersion;
        Object.freeze(this);
    }

    public static encode(attestation: ValidationAttestation): Uint8Array {
        return ValidationAttestation.codec.encode(attestation);
    }

    public static decode(bytes: Uint8Array): ValidationAttestation {
        return ValidationAttestation.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): ValidationAttestation {
        const object = requireObject(value, "Validation attestation");
        const fields = [
            "blueprintDigest",
            "configSchemaDigest",
            "declarationDigest",
            "definitionDigest",
            "id",
            "packageLockDigest",
            "placementDigest",
            "snapshotDigest",
            "target",
            "validatorVersion"
        ];
        if (!hasExactJsonKeys(object, fields)) {
            throw new TypeError("Validation attestation contains missing or unknown fields");
        }
        return new ValidationAttestation({
            id: digest(object["id"], "Validation attestation ID"),
            definitionDigest: digest(object["definitionDigest"], "Definition digest"),
            blueprintDigest: digest(object["blueprintDigest"], "Blueprint digest"),
            packageLockDigest: digest(object["packageLockDigest"], "Package lock digest"),
            snapshotDigest: digest(object["snapshotDigest"], "Snapshot digest"),
            configSchemaDigest: digest(object["configSchemaDigest"], "Config schema digest"),
            declarationDigest: digest(object["declarationDigest"], "Declaration digest"),
            placementDigest: digest(object["placementDigest"], "Placement digest"),
            target: PlatformCompatibility.fromData(object["target"]!),
            validatorVersion: requireString(object["validatorVersion"], "Validator version")
        });
    }

    public toData(): JsonValue {
        return {
            blueprintDigest: this.blueprintDigest.value,
            configSchemaDigest: this.configSchemaDigest.value,
            declarationDigest: this.declarationDigest.value,
            definitionDigest: this.definitionDigest.value,
            id: this.id.value,
            packageLockDigest: this.packageLockDigest.value,
            placementDigest: this.placementDigest.value,
            snapshotDigest: this.snapshotDigest.value,
            target: this.target.toData(),
            validatorVersion: this.validatorVersion
        };
    }
}

function attestationData(
    init: Omit<ValidationAttestationInit, "id" | "validatorVersion"> & {
        readonly validatorVersion: string;
    }
): JsonValue {
    return {
        blueprintDigest: init.blueprintDigest.value,
        configSchemaDigest: init.configSchemaDigest.value,
        declarationDigest: init.declarationDigest.value,
        definitionDigest: init.definitionDigest.value,
        packageLockDigest: init.packageLockDigest.value,
        placementDigest: init.placementDigest.value,
        snapshotDigest: init.snapshotDigest.value,
        target: init.target.toData(),
        validatorVersion: init.validatorVersion
    };
}

function digest(value: JsonValue | undefined, subject: string): Digest {
    return new Digest(requireString(value, subject));
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") throw new TypeError(`${subject} must be a string`);
    return value;
}

function requireCanonicalName(value: string, subject: string): string {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
    return value;
}

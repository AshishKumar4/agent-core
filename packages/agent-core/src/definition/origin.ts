import {
    type JsonObject,
    type JsonFields,
    Digest,
    RecordCodec,
    hasExactJsonKeys,
    isJsonObject,
    type JsonValue
} from "../core";
import { TenantId } from "../identity";
import { DeploymentId } from "./id";

export interface ManagedOriginInit {
    readonly tenantId: TenantId;
    readonly deploymentId: DeploymentId;
    readonly attestationDigest: Digest;
    readonly blueprintDigest: Digest;
    readonly packageLockDigest: Digest;
    readonly configDigest: Digest;
    readonly generation: number;
}

class ManagedOriginCodec extends RecordCodec<ManagedOrigin> {
    public constructor() {
        super("definition.managed-origin", { major: 2, minor: 0 });
    }

    protected encodePayload(origin: ManagedOrigin): JsonValue {
        return origin.toData();
    }

    protected decodePayload(payload: JsonValue): ManagedOrigin {
        return ManagedOrigin.fromData(payload);
    }
}

export class ManagedOrigin {
    public static readonly codec: RecordCodec<ManagedOrigin> = new ManagedOriginCodec();

    public readonly blueprintDigest: Digest;
    public readonly tenantId: TenantId;
    public readonly deploymentId: DeploymentId;
    public readonly attestationDigest: Digest;
    public readonly packageLockDigest: Digest;
    public readonly configDigest: Digest;
    public readonly generation: number;

    public constructor(init: ManagedOriginInit) {
        if (!Number.isSafeInteger(init.generation) || init.generation < 0) {
            throw new TypeError("Managed origin generation must be a non-negative safe integer");
        }
        this.tenantId = new TenantId(init.tenantId.value);
        this.deploymentId = new DeploymentId(init.deploymentId.value);
        this.attestationDigest = init.attestationDigest;
        this.blueprintDigest = init.blueprintDigest;
        this.packageLockDigest = init.packageLockDigest;
        this.configDigest = init.configDigest;
        this.generation = init.generation;
        Object.freeze(this);
    }

    public static encode(origin: ManagedOrigin): Uint8Array {
        return ManagedOrigin.codec.encode(origin);
    }

    public static decode(bytes: Uint8Array): ManagedOrigin {
        return ManagedOrigin.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): ManagedOrigin {
        const object = requireObject(payload, "Managed origin");
        requireFields(
            object,
            [
                "attestationDigest",
                "blueprintDigest",
                "configDigest",
                "deploymentId",
                "generation",
                "packageLockDigest",
                "tenantId"
            ],
            "Managed origin"
        );
        return new ManagedOrigin({
            tenantId: new TenantId(requireString(object["tenantId"], "Managed origin Tenant ID")),
            deploymentId: new DeploymentId(
                requireString(object["deploymentId"], "Managed origin deployment ID")
            ),
            attestationDigest: new Digest(
                requireString(object["attestationDigest"], "Managed origin attestation digest")
            ),
            blueprintDigest: new Digest(
                requireString(object["blueprintDigest"], "Blueprint digest")
            ),
            packageLockDigest: new Digest(
                requireString(object["packageLockDigest"], "Package lock digest")
            ),
            configDigest: new Digest(requireString(object["configDigest"], "Config digest")),
            generation: requireNumber(object["generation"], "Managed origin generation")
        });
    }

    public equals(other: ManagedOrigin): boolean {
        return (
            this.tenantId.equals(other.tenantId) &&
            this.deploymentId.equals(other.deploymentId) &&
            this.attestationDigest.equals(other.attestationDigest) &&
            this.blueprintDigest.equals(other.blueprintDigest) &&
            this.packageLockDigest.equals(other.packageLockDigest) &&
            this.configDigest.equals(other.configDigest) &&
            this.generation === other.generation
        );
    }

    public toData(): JsonValue {
        return {
            attestationDigest: this.attestationDigest.value,
            blueprintDigest: this.blueprintDigest.value,
            configDigest: this.configDigest.value,
            deploymentId: this.deploymentId.value,
            generation: this.generation,
            packageLockDigest: this.packageLockDigest.value,
            tenantId: this.tenantId.value
        };
    }
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
    return value;
}

function requireFields<Field extends string>(
    value: JsonObject,
    fields: readonly Field[],
    subject: string
): asserts value is JsonFields<Field> {
    if (!hasExactJsonKeys(value, fields)) {
        throw new TypeError(`${subject} contains missing or unknown fields`);
    }
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

// Decoding narrows the field to a number and stops there. The constructor states the
// generation's range for every caller in the same words, so repeating it here left that
// rule unfalsifiable through this path: no decoded value could reach the constructor's
// check without passing an identical one first.
function requireNumber(value: JsonValue | undefined, subject: string): number {
    if (typeof value !== "number") {
        throw new TypeError(`${subject} must be a number`);
    }
    return value;
}

import {
    Digest,
    SemVer,
    hasExactJsonKeys,
    isJsonObject,
    type JsonObject,
    type JsonFields,
    type JsonValue
} from "../core";
import { PackageId } from "./id";

export class PackagePin {
    public constructor(
        public readonly id: PackageId,
        public readonly version: SemVer,
        public readonly manifestDigest: Digest,
        public readonly codeDigest: Digest
    ) {
        Object.freeze(this);
    }

    public static fromData(value: JsonValue): PackagePin {
        const object = requireObject(value, "Package pin");
        requireFields(object, ["codeDigest", "id", "manifestDigest", "version"], "Package pin");
        return new PackagePin(
            new PackageId(requireString(object["id"], "Package pin ID")),
            new SemVer(requireString(object["version"], "Package pin version")),
            new Digest(requireString(object["manifestDigest"], "Package manifest digest")),
            new Digest(requireString(object["codeDigest"], "Package code digest"))
        );
    }

    public equals(other: PackagePin): boolean {
        return (
            this.id.equals(other.id) &&
            this.version.equals(other.version) &&
            this.manifestDigest.equals(other.manifestDigest) &&
            this.codeDigest.equals(other.codeDigest)
        );
    }

    public toData(): JsonValue {
        return {
            codeDigest: this.codeDigest.value,
            id: this.id.value,
            manifestDigest: this.manifestDigest.value,
            version: this.version.toString()
        };
    }
}

function requireObject(value: JsonValue, subject: string): JsonObject {
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
    if (!isStringValue(value)) {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

function isStringValue(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

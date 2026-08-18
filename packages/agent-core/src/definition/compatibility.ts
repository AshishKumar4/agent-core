import { Range, satisfies } from "semver";
import { RecordCodec, SemVer, hasExactJsonKeys, isJsonObject, type JsonValue } from "../core";

export interface PlatformCompatibilityInit {
    readonly spec: SemVer;
    readonly host: SemVer;
}

class PlatformCompatibilityCodec extends RecordCodec<PlatformCompatibility> {
    public constructor() {
        super([PlatformCompatibility, SemVer], "definition.platform-compatibility", {
            major: 1,
            minor: 0
        });
    }

    protected encodePayload(target: PlatformCompatibility): JsonValue {
        return target.toData();
    }

    protected decodePayload(payload: JsonValue): PlatformCompatibility {
        return PlatformCompatibility.fromData(payload);
    }
}

export class PlatformCompatibility {
    public static get codec(): RecordCodec<PlatformCompatibility> {
        return platformCompatibilityCodecInstance;
    }

    public readonly spec: SemVer;
    public readonly host: SemVer;

    public constructor(init: PlatformCompatibilityInit) {
        this.spec = new SemVer(init.spec.toString());
        this.host = new SemVer(init.host.toString());
        Object.freeze(this);
    }

    public static encode(target: PlatformCompatibility): Uint8Array {
        return PlatformCompatibility.codec.encode(target);
    }

    public static decode(bytes: Uint8Array): PlatformCompatibility {
        return PlatformCompatibility.codec.decode(bytes);
    }

    public static fromData(value: JsonValue): PlatformCompatibility {
        const object = requireObject(value);
        if (
            !hasExactJsonKeys(object, ["host", "spec"]) ||
            !isCompatibilityText(object["host"]) ||
            !isCompatibilityText(object["spec"])
        ) {
            throw new TypeError("Platform compatibility contains missing or unknown fields");
        }
        return new PlatformCompatibility({
            spec: new SemVer(object["spec"]),
            host: new SemVer(object["host"])
        });
    }

    public equals(other: PlatformCompatibility): boolean {
        return this.spec.equals(other.spec) && this.host.equals(other.host);
    }

    public toData(): JsonValue {
        return { host: this.host.toString(), spec: this.spec.toString() };
    }
}

const platformCompatibilityCodecInstance = new PlatformCompatibilityCodec();

function isCompatibilityText(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (!isJsonObject(value)) throw new TypeError("Platform compatibility must be an object");
    return value;
}

export function canonicalCompatibilityRange(value: string, subject: string): string {
    if (value.length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical range`);
    }
    try {
        return new Range(value).range || "*";
    } catch {
        throw new TypeError(`${subject} must be a valid semantic version range`);
    }
}

export function compatibilityAdmits(
    range: { readonly spec: string; readonly host: string },
    target: PlatformCompatibility
): boolean {
    const spec = canonicalCompatibilityRange(range.spec, "Spec compatibility range");
    const host = canonicalCompatibilityRange(range.host, "Host compatibility range");
    return satisfies(target.spec.toString(), spec) && satisfies(target.host.toString(), host);
}

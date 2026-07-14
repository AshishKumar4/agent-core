import { Range, satisfies } from "semver";
import { RecordCodec, SemVer, hasExactJsonKeys, type JsonValue } from "../core";

export interface PlatformCompatibilityInit {
    readonly spec: SemVer;
    readonly host: SemVer;
}

class PlatformCompatibilityCodec extends RecordCodec<PlatformCompatibility> {
    public constructor() {
        super("definition.platform-compatibility", { major: 1, minor: 0 });
    }

    protected encodePayload(target: PlatformCompatibility): JsonValue {
        return target.toData();
    }

    protected decodePayload(payload: JsonValue): PlatformCompatibility {
        return PlatformCompatibility.fromData(payload);
    }
}

export class PlatformCompatibility {
    public static readonly codec: RecordCodec<PlatformCompatibility> =
        new PlatformCompatibilityCodec();

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
            typeof object["host"] !== "string" ||
            typeof object["spec"] !== "string"
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

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Platform compatibility must be an object");
    }
    return value as { readonly [key: string]: JsonValue };
}

export function canonicalCompatibilityRange(value: string, subject: string): string {
    if (value.trim().length === 0 || value !== value.trim()) {
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

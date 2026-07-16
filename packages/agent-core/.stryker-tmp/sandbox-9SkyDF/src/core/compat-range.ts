// @ts-nocheck
import { AgentCoreError } from "../errors";
import { RecordCodec, type RecordVersion } from "./codec";
import { hasExactJsonKeys, type JsonValue } from "./json";
import { hasOnlyUnicodeScalarValues } from "./unicode";

class CompatRangeCodec extends RecordCodec<CompatRange> {
    public constructor() {
        super("core.compat-range", { major: 1, minor: 0 });
    }

    protected encodePayload(range: CompatRange): JsonValue {
        return { host: range.host, spec: range.spec };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): CompatRange {
        if (
            !isObject(payload) ||
            !hasExactJsonKeys(payload, ["host", "spec"]) ||
            typeof payload["host"] !== "string" ||
            typeof payload["spec"] !== "string"
        ) {
            throw new AgentCoreError("codec.invalid", "Compatibility range payload is malformed");
        }
        return new CompatRange(payload["spec"], payload["host"]);
    }
}

const compatRangeCodec = new CompatRangeCodec();

export class CompatRange {
    public readonly spec: string;
    public readonly host: string;

    public constructor(spec: string, host: string) {
        requireRange(spec, "Spec compatibility range");
        requireRange(host, "Host compatibility range");
        this.spec = spec;
        this.host = host;
        Object.freeze(this);
    }

    public static any(): CompatRange {
        return anyCompatRange;
    }

    public static encode(range: CompatRange): Uint8Array {
        return compatRangeCodec.encode(range);
    }

    public static decode(bytes: Uint8Array): CompatRange {
        return compatRangeCodec.decode(bytes);
    }

    public equals(other: CompatRange): boolean {
        return other instanceof CompatRange && this.spec === other.spec && this.host === other.host;
    }
}

function requireRange(value: string, name: string): void {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value !== value.trim() ||
        !hasOnlyUnicodeScalarValues(value)
    ) {
        throw new TypeError(`${name} must be a nonblank canonical string`);
    }
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

const anyCompatRange = new CompatRange("*", "*");

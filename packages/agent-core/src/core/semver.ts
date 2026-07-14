import { AgentCoreError } from "../errors";
import { RecordCodec, type RecordVersion } from "./codec";
import { hasExactJsonKeys, type JsonValue } from "./json";

const SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

class SemVerCodec extends RecordCodec<SemVer> {
    public constructor() {
        super("core.semver", { major: 1, minor: 0 });
    }

    protected encodePayload(version: SemVer): JsonValue {
        return { value: version.toString() };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): SemVer {
        if (
            !isObject(payload) ||
            !hasExactJsonKeys(payload, ["value"]) ||
            typeof payload["value"] !== "string"
        ) {
            throw new AgentCoreError("codec.invalid", "Semantic version payload is malformed");
        }
        return new SemVer(payload["value"]);
    }
}

const semVerCodec = new SemVerCodec();

export class SemVer {
    public readonly major: number;
    public readonly minor: number;
    public readonly patch: number;
    public readonly prerelease: readonly string[];
    public readonly build: readonly string[];

    public constructor(
        ...args:
            | [value: string]
            | [
                  major: number,
                  minor: number,
                  patch: number,
                  prerelease?: readonly string[],
                  build?: readonly string[]
              ]
    ) {
        const [valueOrMajor, minor, patch, prerelease = [], build = []] = args;
        const value =
            typeof valueOrMajor === "string"
                ? parseSemVer(valueOrMajor)
                : parseSemVer(
                      validateAndFormatSemVer(valueOrMajor, minor, patch, prerelease, build)
                  );
        this.major = value.major;
        this.minor = value.minor;
        this.patch = value.patch;
        this.prerelease = Object.freeze([...value.prerelease]);
        this.build = Object.freeze([...value.build]);
        Object.freeze(this);
    }

    public static parse(value: string): SemVer {
        if (typeof value !== "string") {
            throw new TypeError("Semantic version must follow SemVer 2.0.0");
        }
        return new SemVer(value);
    }

    public static encode(version: SemVer): Uint8Array {
        return semVerCodec.encode(version);
    }

    public static decode(bytes: Uint8Array): SemVer {
        return semVerCodec.decode(bytes);
    }

    public compare(other: SemVer): number {
        const releaseComparison =
            compareNumber(this.major, other.major) ||
            compareNumber(this.minor, other.minor) ||
            compareNumber(this.patch, other.patch);
        return releaseComparison || comparePrerelease(this.prerelease, other.prerelease);
    }

    public equals(other: SemVer): boolean {
        return other instanceof SemVer && this.toString() === other.toString();
    }

    public toString(): string {
        const prerelease = this.prerelease.length === 0 ? "" : `-${this.prerelease.join(".")}`;
        const build = this.build.length === 0 ? "" : `+${this.build.join(".")}`;
        return `${this.major}.${this.minor}.${this.patch}${prerelease}${build}`;
    }
}

interface ParsedSemVer {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly prerelease: string[];
    readonly build: string[];
}

function parseSemVer(value: string): ParsedSemVer {
    const match = SEMVER_PATTERN.exec(value);
    if (match === null) {
        throw new TypeError("Semantic version must follow SemVer 2.0.0");
    }
    return {
        major: requireSafeComponent(match[1]!, "major"),
        minor: requireSafeComponent(match[2]!, "minor"),
        patch: requireSafeComponent(match[3]!, "patch"),
        prerelease: match[4] === undefined ? [] : match[4].split("."),
        build: match[5] === undefined ? [] : match[5].split(".")
    };
}

function validateAndFormatSemVer(
    major: number,
    minor: number | undefined,
    patch: number | undefined,
    prerelease: readonly string[],
    build: readonly string[]
): string {
    if (minor === undefined || patch === undefined) {
        throw new TypeError("Semantic version requires major, minor, and patch components");
    }
    for (const [name, component] of [
        ["major", major],
        ["minor", minor],
        ["patch", patch]
    ] as const) {
        if (!Number.isSafeInteger(component) || component < 0) {
            throw new TypeError(`Semantic version ${name} must be a non-negative safe integer`);
        }
    }
    const prereleaseIdentifiers = copyIdentifiers(prerelease);
    const buildIdentifiers = copyIdentifiers(build);
    const prereleaseValue =
        prereleaseIdentifiers.length === 0 ? "" : `-${prereleaseIdentifiers.join(".")}`;
    const buildValue = buildIdentifiers.length === 0 ? "" : `+${buildIdentifiers.join(".")}`;
    return `${major}.${minor}.${patch}${prereleaseValue}${buildValue}`;
}

function copyIdentifiers(value: readonly string[]): string[] {
    if (!Array.isArray(value) || value.some((identifier) => typeof identifier !== "string")) {
        throw new TypeError("Semantic version identifiers must be string arrays");
    }
    return [...value];
}

function requireSafeComponent(value: string, name: string): number {
    const component = Number(value);
    if (!Number.isSafeInteger(component)) {
        throw new TypeError(`Semantic version ${name} exceeds the maximum safe integer`);
    }
    return component;
}

function compareNumber(left: number, right: number): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
    if (left.length === 0 || right.length === 0) {
        return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
    }
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const leftPart = left[index];
        const rightPart = right[index];
        if (leftPart === undefined || rightPart === undefined) {
            return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
        }
        if (leftPart === rightPart) continue;
        const leftNumeric = /^\d+$/.test(leftPart);
        const rightNumeric = /^\d+$/.test(rightPart);
        if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftPart, rightPart);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftPart < rightPart ? -1 : 1;
    }
    return 0;
}

function compareNumericIdentifier(left: string, right: string): number {
    return compareNumber(left.length, right.length) || (left < right ? -1 : left > right ? 1 : 0);
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

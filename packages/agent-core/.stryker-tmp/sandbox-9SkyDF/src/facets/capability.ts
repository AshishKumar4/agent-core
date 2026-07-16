// @ts-nocheck
import {
    RecordCodec,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue,
    type RecordVersion
} from "../core";
import type { Impact } from "./contribution";
import {
    canonicalFacetData,
    requireArray,
    requireDataObject,
    requireString,
    type FacetDataMap
} from "./data";

const impacts: readonly Impact[] = [
    "observe",
    "mutate",
    "externalSend",
    "execute",
    "delegate",
    "administer"
];

export type CapabilityEffect = "allow" | "deny";

export function isCapabilityEffect(value: unknown): value is CapabilityEffect {
    return value === "allow" || value === "deny";
}

export interface CapabilitySpecInit {
    readonly facetPattern: string;
    readonly operations?: readonly string[];
    readonly impacts: readonly [Impact, ...Impact[]];
    readonly argumentConstraints?: Readonly<Record<string, JsonValue>>;
}

export interface CapabilityIntent {
    readonly facet: string;
    readonly operation: string;
    readonly impact: Impact;
    readonly arguments: Readonly<Record<string, JsonValue>>;
}

class CapabilitySpecCodecV1 extends RecordCodec<CapabilitySpec> {
    public constructor() {
        // Preserve the established wire identity while W3 takes canonical ownership.
        super("authority.capability-spec", { major: 1, minor: 0 });
    }

    protected encodePayload(spec: CapabilitySpec): JsonValue {
        return spec.toData();
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): CapabilitySpec {
        return CapabilitySpec.fromData(payload);
    }
}

export class CapabilitySpec {
    public static readonly codec: RecordCodec<CapabilitySpec> = new CapabilitySpecCodecV1();
    public readonly facetPattern: string;
    public readonly operations: readonly string[];
    public readonly impacts: readonly [Impact, ...Impact[]];
    public readonly argumentConstraints: Readonly<Record<string, JsonValue>>;

    public constructor(init: CapabilitySpecInit) {
        validatePattern(init.facetPattern);
        this.facetPattern = init.facetPattern;
        this.operations = canonicalStrings(init.operations ?? [], "Capability operations");
        this.impacts = canonicalImpacts(init.impacts);
        this.argumentConstraints = canonicalConstraints(init.argumentConstraints ?? {});
        Object.freeze(this);
    }

    public static encode(spec: CapabilitySpec): Uint8Array {
        return CapabilitySpec.codec.encode(spec);
    }

    public static decode(bytes: Uint8Array): CapabilitySpec {
        return CapabilitySpec.codec.decode(bytes);
    }

    public matches(intent: CapabilityIntent): boolean {
        return (
            matchesPattern(this.facetPattern, intent.facet) &&
            (this.operations.length === 0 || this.operations.includes(intent.operation)) &&
            this.impacts.includes(intent.impact) &&
            Object.entries(this.argumentConstraints).every(([path, expected]) => {
                const actual = valueAtPath(intent.arguments, path);
                return actual !== undefined && canonicalEqual(actual, expected);
            })
        );
    }

    public covers(candidate: CapabilitySpec): boolean {
        return (
            patternCovers(this.facetPattern, candidate.facetPattern) &&
            (this.operations.length === 0 ||
                (candidate.operations.length > 0 &&
                    candidate.operations.every((operation) =>
                        this.operations.includes(operation)
                    ))) &&
            candidate.impacts.every((impact) => this.impacts.includes(impact)) &&
            Object.entries(this.argumentConstraints).every(([path, expected]) => {
                const actual = candidate.argumentConstraints[path];
                return actual !== undefined && canonicalEqual(actual, expected);
            })
        );
    }

    public grantsElevation(): boolean {
        return this.impacts.includes("delegate") || this.impacts.includes("administer");
    }

    public equals(other: CapabilitySpec): boolean {
        return other instanceof CapabilitySpec && canonicalEqual(this.toData(), other.toData());
    }

    public toData(): FacetDataMap {
        return {
            argumentConstraints: this.argumentConstraints,
            facetPattern: this.facetPattern,
            impacts: this.impacts,
            operations: this.operations
        };
    }

    public static fromData(value: JsonValue | undefined): CapabilitySpec {
        const object = requireDataObject(value ?? null, "Capability spec");
        if (
            !hasExactJsonKeys(object, [
                "argumentConstraints",
                "facetPattern",
                "impacts",
                "operations"
            ])
        ) {
            throw new TypeError("Capability spec contains missing or unknown fields");
        }
        const operationValues = requireArray(object["operations"], "Capability operations");
        const impactValues = requireArray(object["impacts"], "Capability impacts");
        if (impactValues.length === 0) throw new TypeError("Capability impacts must not be empty");
        return new CapabilitySpec({
            facetPattern: requireString(object["facetPattern"], "Facet pattern"),
            operations: operationValues.map((entry, index) =>
                requireArrayString(entry, `Operation ${index}`)
            ),
            impacts: impactValues.map(requireImpact) as [Impact, ...Impact[]],
            argumentConstraints: requireDataObject(
                object["argumentConstraints"] ?? null,
                "Argument constraints"
            )
        });
    }
}

function canonicalStrings(values: readonly string[], name: string): readonly string[] {
    for (const value of values) {
        if (value.length === 0 || value !== value.trim()) {
            throw new TypeError(`${name} must contain canonical nonblank strings`);
        }
    }
    return Object.freeze([...new Set(values)].sort());
}

function canonicalImpacts(values: readonly Impact[]): readonly [Impact, ...Impact[]] {
    if (values.length === 0 || values.some((value) => !impacts.includes(value))) {
        throw new TypeError("Capability impacts must contain known values");
    }
    const ordered = impacts.filter((value) => values.includes(value));
    if (ordered.length !== values.length) throw new TypeError("Capability impacts must be unique");
    return Object.freeze(ordered) as unknown as readonly [Impact, ...Impact[]];
}

function canonicalConstraints(
    constraints: Readonly<Record<string, JsonValue>>
): Readonly<Record<string, JsonValue>> {
    for (const path of Object.keys(constraints)) {
        if (!isConstraintPath(path))
            throw new TypeError(`Invalid argument constraint path ${path}`);
    }
    return canonicalFacetData(constraints) as Readonly<Record<string, JsonValue>>;
}

function validatePattern(pattern: string): void {
    if (
        pattern.length === 0 ||
        pattern !== pattern.trim() ||
        /[^a-zA-Z0-9._:/@*-]/u.test(pattern)
    ) {
        throw new TypeError("Facet pattern must be a canonical glob containing only '*' wildcards");
    }
}

function matchesPattern(pattern: string, value: string): boolean {
    const expression = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*");
    return new RegExp(`^${expression}$`, "u").test(value);
}

function patternCovers(parent: string, child: string): boolean {
    if (parent === "*" || parent === child) return true;
    const wildcard = parent.indexOf("*");
    if (wildcard < 0 || parent.indexOf("*", wildcard + 1) >= 0) return false;
    const prefix = parent.slice(0, wildcard);
    const suffix = parent.slice(wildcard + 1);
    const childWildcard = child.indexOf("*");
    const childPrefix = childWildcard < 0 ? child : child.slice(0, childWildcard);
    const childSuffix = childWildcard < 0 ? child : child.slice(child.lastIndexOf("*") + 1);
    return childPrefix.startsWith(prefix) && childSuffix.endsWith(suffix);
}

function valueAtPath(
    value: Readonly<Record<string, JsonValue>>,
    path: string
): JsonValue | undefined {
    let current: JsonValue = value;
    for (const segment of path.split(".")) {
        if (current === null || Array.isArray(current) || typeof current !== "object")
            return undefined;
        const next: JsonValue | undefined = (
            current as { readonly [key: string]: JsonValue | undefined }
        )[segment];
        if (next === undefined) return undefined;
        current = next;
    }
    return current;
}

function isConstraintPath(path: string): boolean {
    return path.length > 0 && path.split(".").every((segment) => /^[a-zA-Z0-9_-]+$/u.test(segment));
}

function canonicalEqual(left: JsonValue, right: JsonValue): boolean {
    const leftBytes = encodeCanonicalJson(left);
    const rightBytes = encodeCanonicalJson(right);
    return (
        leftBytes.byteLength === rightBytes.byteLength &&
        leftBytes.every((value, index) => value === rightBytes[index])
    );
}

function requireArrayString(value: JsonValue, name: string): string {
    if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
    return value;
}

function requireImpact(value: JsonValue): Impact {
    if (typeof value === "string" && impacts.includes(value as Impact)) return value as Impact;
    throw new TypeError("Capability impact is invalid");
}

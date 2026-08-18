import {
    RecordCodec,
    canonicalJsonEqual,
    hasExactJsonKeys,
    isJsonObject,
    isMember,
    requireNonempty,
    type JsonValue,
    type RecordVersion
} from "../core";
import type { Impact } from "./contribution";
import { matchesGlob } from "./glob";
import {
    canonicalFacetDataMap,
    canonicalOrder,
    requireArray,
    requireDataObject,
    requireString,
    type FacetData,
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

export function isCapabilityEffect(value: FacetData | undefined): value is CapabilityEffect {
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
            matchesGlob(this.facetPattern, intent.facet) &&
            (this.operations.length === 0 || this.operations.includes(intent.operation)) &&
            this.impacts.includes(intent.impact) &&
            Object.entries(this.argumentConstraints).every(([path, expected]) => {
                const actual = valueAtPath(intent.arguments, path);
                return actual !== undefined && canonicalJsonEqual(actual, expected);
            })
        );
    }

    /**
     * SPEC §3.4 rule 2: the candidate admits no Invocation this capability would refuse.
     *
     * A pattern covers another exactly when it matches the other pattern's own text —
     * `'*'` is the only metacharacter and a validated pattern never contains one as a
     * literal, so a parent literal can never absorb a child wildcard. That equivalence
     * with glob language containment is proved in both directions by the formal model
     * (`AgentCore.glob_covering_iff_containment`).
     */
    public covers(candidate: CapabilitySpec): boolean {
        return (
            matchesGlob(this.facetPattern, candidate.facetPattern) &&
            (this.operations.length === 0 ||
                (candidate.operations.length > 0 &&
                    candidate.operations.every((operation) =>
                        this.operations.includes(operation)
                    ))) &&
            candidate.impacts.every((impact) => this.impacts.includes(impact)) &&
            Object.entries(this.argumentConstraints).every(([path, expected]) => {
                const actual = candidate.argumentConstraints[path];
                return actual !== undefined && canonicalJsonEqual(actual, expected);
            })
        );
    }

    public grantsElevation(): boolean {
        return this.impacts.includes("delegate") || this.impacts.includes("administer");
    }

    public equals(other: CapabilitySpec): boolean {
        return other instanceof CapabilitySpec && canonicalJsonEqual(this.toData(), other.toData());
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
        const impacts = requireNonempty(impactValues.map(requireImpact), "Capability impacts");
        return new CapabilitySpec({
            facetPattern: requireString(object["facetPattern"], "Facet pattern"),
            operations: operationValues.map((entry, index) =>
                requireString(entry, `Operation ${index}`)
            ),
            impacts,
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
    return canonicalOrder(values, impacts, "Capability impacts");
}

function canonicalConstraints(
    constraints: Readonly<Record<string, JsonValue>>
): Readonly<Record<string, JsonValue>> {
    for (const path of Object.keys(constraints)) {
        if (!isConstraintPath(path))
            throw new TypeError(`Invalid argument constraint path ${path}`);
    }
    return canonicalFacetDataMap(constraints);
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

function valueAtPath(
    value: Readonly<Record<string, JsonValue>>,
    path: string
): JsonValue | undefined {
    let current: JsonValue | undefined = value;
    for (const segment of path.split(".")) {
        if (!isJsonObject(current)) return undefined;
        current = current[segment];
    }
    return current;
}

function isConstraintPath(path: string): boolean {
    return path.length > 0 && path.split(".").every((segment) => /^[a-zA-Z0-9_-]+$/u.test(segment));
}


function requireImpact(value: JsonValue): Impact {
    if (isMember(impacts, value)) return value;
    throw new TypeError("Capability impact is invalid");
}

import { RecordCodec, isMember, type JsonValue } from "../../core";
import { CodecRecord, requireExactFields, requireInteger, requireObject } from "../record-data";

// SPEC §5.2 names exactly three ceiling dimensions. `depth` and `wallClockMs` are
// derived from existing structure; only `tokens` needs a running total.
export const RESOURCE_DIMENSIONS = Object.freeze(["depth", "tokens", "wallClockMs"] as const);

export type ResourceDimension = (typeof RESOURCE_DIMENSIONS)[number];

export function requireResourceDimension(
    value: JsonValue | undefined,
    subject: string
): ResourceDimension {
    if (isMember(RESOURCE_DIMENSIONS, value)) return value;
    throw new TypeError(`${subject} is not a declared resource dimension`);
}

export type ResourceLimits = { readonly [Dimension in ResourceDimension]?: number };

// A declared ceiling. A dimension the ceiling omits is undeclared, which is not the same
// as zero: an undeclared dimension inherits its parent's remainder (SPEC §5.2), and a
// Run under no declaration at all is unbounded.
export class ResourceCeiling {
    readonly #limits: ResourceLimits;

    public constructor(limits: ResourceLimits) {
        const declared: { [Dimension in ResourceDimension]?: number } = {};
        for (const dimension of RESOURCE_DIMENSIONS) {
            const limit = limits[dimension];
            if (limit === undefined) continue;
            if (!Number.isSafeInteger(limit) || limit < 0) {
                throw new TypeError(
                    `Resource ceiling ${dimension} must be a non-negative safe integer`
                );
            }
            declared[dimension] = limit;
        }
        if (Object.keys(declared).length === 0) {
            throw new TypeError("Resource ceiling must declare at least one dimension");
        }
        this.#limits = Object.freeze(declared);
        Object.freeze(this);
    }

    // Declared dimensions paired with their limits, so readers never have to assert that
    // a declared dimension has one.
    public get entries(): readonly (readonly [ResourceDimension, number])[] {
        return RESOURCE_DIMENSIONS.flatMap((dimension) => {
            const limit = this.#limits[dimension];
            return limit === undefined ? [] : [[dimension, limit] as const];
        });
    }

    public get declared(): readonly ResourceDimension[] {
        return this.entries.map(([dimension]) => dimension);
    }

    public limit(dimension: ResourceDimension): number | undefined {
        return this.#limits[dimension];
    }

    public equals(other: ResourceCeiling): boolean {
        return RESOURCE_DIMENSIONS.every(
            (dimension) => this.limit(dimension) === other.limit(dimension)
        );
    }

    public toData(): JsonValue {
        const data: { [key: string]: JsonValue } = {};
        for (const [dimension, limit] of this.entries) data[dimension] = limit;
        return data;
    }

    public static fromData(value: JsonValue): ResourceCeiling {
        const object = requireObject(value, "Resource ceiling");
        requireExactFields(object, [], [...RESOURCE_DIMENSIONS], "Resource ceiling");
        const limits: { [Dimension in ResourceDimension]?: number } = {};
        for (const dimension of RESOURCE_DIMENSIONS) {
            if (object[dimension] === undefined) continue;
            limits[dimension] = requireInteger(object[dimension], `Resource ceiling ${dimension}`);
        }
        return new ResourceCeiling(limits);
    }
}

// A Run's own consumption. SPEC §5.2 measures both of these against the Run itself: its
// durable token total, and the wall clock since the Run started.
export interface ResourceUsage {
    readonly tokens: number;
    readonly wallClockMs: number;
}

// Depth is the only dimension a Run does not spend from its own activity: it spends one
// level of whatever it inherited by being spawned, and none of its own declaration, which
// is measured from the Run that declared it.
function spent(usage: ResourceUsage, dimension: ResourceDimension, inherited: boolean): number {
    return dimension === "depth" ? (inherited ? 1 : 0) : usage[dimension];
}

function narrow(
    remaining: { [Dimension in ResourceDimension]?: number },
    ceiling: ResourceCeiling | undefined,
    usage: ResourceUsage,
    inherited: boolean
): void {
    for (const [dimension, limit] of ceiling?.entries ?? []) {
        const left = Math.max(0, limit - spent(usage, dimension, inherited));
        const current = remaining[dimension];
        if (current === undefined || left < current) remaining[dimension] = left;
    }
}

// What a Run may still spend: its own declaration and the remainder it inherited from its
// parent, each reduced by what this Run has consumed, with the tighter of the two winning.
// A dimension neither side declares stays absent — unbounded, which is what a Run under no
// ceiling anywhere gets. Folding the parent's *remainder* rather than the parent's limit is
// what makes an undeclared dimension inherit rather than reset (SPEC §5.2).
export function narrowResources(
    parentRemainder: ResourceCeiling | undefined,
    declared: ResourceCeiling | undefined,
    usage: ResourceUsage
): ResourceCeiling | undefined {
    const remaining: { [Dimension in ResourceDimension]?: number } = {};
    narrow(remaining, declared, usage, false);
    narrow(remaining, parentRemainder, usage, true);
    return Object.keys(remaining).length === 0 ? undefined : new ResourceCeiling(remaining);
}

// SPEC §3.4 rule 2 applied to resources: a child ceiling never widens the parent's
// remainder. `undefined` means the parent bounds nothing, so any child ceiling holds.
export function widensResourceCeiling(
    parentRemainder: ResourceCeiling | undefined,
    child: ResourceCeiling
): boolean {
    if (parentRemainder === undefined) return false;
    return child.entries.some(([dimension, limit]) => {
        const allowance = parentRemainder.limit(dimension);
        return allowance !== undefined && limit > allowance;
    });
}

// The first dimension, in declaration order, with nothing left to spend.
export function exhaustedResource(
    remainder: ResourceCeiling | undefined
): ResourceDimension | undefined {
    return remainder?.declared.find((dimension) => remainder.limit(dimension) === 0);
}

export interface SpawnAttenuationInit {
    readonly ceiling?: ResourceCeiling;
}

// The content `SpawnReservation.attenuation` digests. Resources ride on the attenuation
// the spawn already commits to rather than on a record of their own (SPEC §5.2).
export class SpawnAttenuation extends CodecRecord {
    public static get codec(): RecordCodec<SpawnAttenuation> {
        return SpawnAttenuationCodec;
    }

    public readonly ceiling: ResourceCeiling | undefined;

    public constructor(init: SpawnAttenuationInit = {}) {
        super();
        if (init.ceiling !== undefined && init.ceiling.constructor !== ResourceCeiling) {
            throw new TypeError("Spawn attenuation ceiling must use the exact context class");
        }
        this.ceiling = init.ceiling;
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return { ceiling: this.ceiling === undefined ? null : this.ceiling.toData() };
    }

    public static fromData(value: JsonValue): SpawnAttenuation {
        const object = requireObject(value, "Spawn attenuation");
        requireExactFields(object, ["ceiling"], [], "Spawn attenuation");
        const ceiling = object["ceiling"];
        return new SpawnAttenuation(
            ceiling === null ? {} : { ceiling: ResourceCeiling.fromData(ceiling) }
        );
    }
}

class SpawnAttenuationRecordCodec extends RecordCodec<SpawnAttenuation> {
    public constructor() {
        super([SpawnAttenuation, ResourceCeiling, CodecRecord], "run.spawn-attenuation", {
            major: 1,
            minor: 0
        });
    }
    protected encodePayload(value: SpawnAttenuation): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): SpawnAttenuation {
        return SpawnAttenuation.fromData(value);
    }
}

export const SpawnAttenuationCodec: RecordCodec<SpawnAttenuation> =
    new SpawnAttenuationRecordCodec();

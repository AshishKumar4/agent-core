import { JsonSchema } from "../core";
import type { FacetData } from "./data";
import {
    DataRecordCodec,
    canonicalFacetData,
    compareText,
    requireArray,
    requireBoolean,
    requireDataObject,
    requireExactFields,
    requireNonblank,
    requireOptionalString,
    requireSchemaDocument,
    requireString
} from "./data";
import { OperationName, SlotName, SurfaceId } from "./id";

export type Impact = "observe" | "mutate" | "externalSend" | "execute" | "delegate" | "administer";

export type EnforcementTier = "direct" | "mediated";

/**
 * SPEC §7.2's enforcement floor: `observe` is always direct; `execute` is direct only
 * inside a Turn-owned Session; `mutate` is direct only against that Session's own
 * filesystem; every other case — `externalSend`, `delegate`, `administer`, and any
 * `mutate`/`execute` outside those conditions — is mediated. Lives at the facets layer
 * (not `definition`, which imports `Impact` from here) so both the definition plane's
 * PolicySet evaluation and a facet profile deriving its own seam-bound impact (§7.1,
 * `claimHonorsEnforcementFloor` below) share one computation instead of each
 * reimplementing it.
 */
export function enforcementFloor(
    impact: Impact,
    turnOwnedSession: boolean,
    sessionFilesystemTarget: boolean
): EnforcementTier {
    if (
        impact === "observe" ||
        (impact === "execute" && turnOwnedSession) ||
        (impact === "mutate" && turnOwnedSession && sessionFilesystemTarget)
    ) {
        return "direct";
    }
    return "mediated";
}

/**
 * SPEC §7.1 (C13-POLICY-IMPACT-BOUNDARY): the host derives an Operation's impact from
 * the seam its request crosses, never from what the callee declares about itself; a
 * callee's own claim may replace the derived impact only when it never admits a floor
 * (§7.2) the derived impact would have mediated. Checked across both Turn-owned-Session
 * conditions because a claim recorded once (typically at discovery or install time) has
 * to hold safe for every call site it is later used at, regardless of which condition
 * holds there. `sessionFilesystemTarget` is fixed per caller: pass `false` for a seam
 * whose target is never a Turn-owned Session's own filesystem — a discovered,
 * externally configured endpoint, for instance — and thread the real value through for
 * a seam that can legitimately have one.
 */
export function claimHonorsEnforcementFloor(
    claimed: Impact,
    derived: Impact,
    sessionFilesystemTarget: boolean
): boolean {
    return [true, false].every(
        (turnOwnedSession) =>
            enforcementFloor(claimed, turnOwnedSession, sessionFilesystemTarget) !== "direct" ||
            enforcementFloor(derived, turnOwnedSession, sessionFilesystemTarget) === "direct"
    );
}

export class OperationDescriptor {
    public readonly help: string | undefined;

    public constructor(
        public readonly name: OperationName,
        public readonly impact: Impact,
        public readonly input: JsonSchema,
        public readonly output: JsonSchema,
        help?: string,
        public readonly interceptable = false
    ) {
        if (help !== undefined) {
            requireNonblank(help, "Operation help");
        }
        this.help = help;
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): OperationDescriptor {
        const object = requireDataObject(payload, "Operation descriptor");
        requireExactFields(
            object,
            ["impact", "input", "interceptable", "name", "output"],
            ["help"]
        );
        return new OperationDescriptor(
            new OperationName(requireString(object["name"], "Operation name")),
            requireImpact(object["impact"]),
            new JsonSchema(requireSchemaDocument(object["input"], "Operation input schema")),
            new JsonSchema(requireSchemaDocument(object["output"], "Operation output schema")),
            requireOptionalString(object["help"], "Operation help"),
            requireBoolean(object["interceptable"], "Operation interceptable flag")
        );
    }

    public static encode(descriptor: OperationDescriptor): Uint8Array {
        return operationDescriptorCodec.encode(descriptor);
    }

    public static decode(bytes: Uint8Array): OperationDescriptor {
        return operationDescriptorCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            impact: this.impact,
            input: this.input.document,
            interceptable: this.interceptable,
            name: this.name.value,
            output: this.output.document,
            ...(this.help === undefined ? {} : { help: this.help })
        };
    }
}

const operationDescriptorCodec = new DataRecordCodec(
    "facet.operation-descriptor",
    (descriptor: OperationDescriptor) => descriptor.toData(),
    (payload) => OperationDescriptor.fromData(payload)
);

export class SurfaceDescriptor {
    public readonly help: string | undefined;

    public constructor(
        public readonly id: SurfaceId,
        public readonly title: string,
        help?: string
    ) {
        requireNonblank(title, "Surface title");
        if (help !== undefined) {
            requireNonblank(help, "Surface help");
        }
        this.help = help;
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): SurfaceDescriptor {
        const object = requireDataObject(payload, "Surface descriptor");
        requireExactFields(object, ["id", "title"], ["help"]);
        return new SurfaceDescriptor(
            new SurfaceId(requireString(object["id"], "Surface ID")),
            requireString(object["title"], "Surface title"),
            requireOptionalString(object["help"], "Surface help")
        );
    }

    public static encode(descriptor: SurfaceDescriptor): Uint8Array {
        return surfaceDescriptorCodec.encode(descriptor);
    }

    public static decode(bytes: Uint8Array): SurfaceDescriptor {
        return surfaceDescriptorCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            id: this.id.value,
            title: this.title,
            ...(this.help === undefined ? {} : { help: this.help })
        };
    }
}

const surfaceDescriptorCodec = new DataRecordCodec(
    "facet.surface-descriptor",
    (descriptor: SurfaceDescriptor) => descriptor.toData(),
    (payload) => SurfaceDescriptor.fromData(payload)
);

export class Contribution {
    public readonly entries: readonly FacetData[];

    public constructor(
        public readonly slot: SlotName,
        entries: readonly FacetData[]
    ) {
        if (entries.length === 0) {
            throw new TypeError("Contribution must contain at least one entry");
        }
        this.entries = Object.freeze(entries.map(canonicalFacetData));
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): Contribution {
        const object = requireDataObject(payload, "Contribution");
        requireExactFields(object, ["entries", "slot"]);
        return new Contribution(
            new SlotName(requireString(object["slot"], "Contribution slot")),
            requireArray(object["entries"], "Contribution entries")
        );
    }

    public static encode(contribution: Contribution): Uint8Array {
        return contributionCodec.encode(contribution);
    }

    public static decode(bytes: Uint8Array): Contribution {
        return contributionCodec.decode(bytes);
    }

    public toData(): FacetData {
        return { entries: this.entries, slot: this.slot.value };
    }
}

const contributionCodec = new DataRecordCodec(
    "facet.contribution",
    (contribution: Contribution) => contribution.toData(),
    (payload) => Contribution.fromData(payload)
);

export class Contributions {
    public readonly entries: readonly Contribution[];

    public constructor(entries: readonly Contribution[]) {
        const ordered = [...entries].sort((left, right) =>
            compareText(left.slot.value, right.slot.value)
        );
        if (new Set(ordered.map((entry) => entry.slot.value)).size !== ordered.length) {
            throw new TypeError("Contribution slots must be unique");
        }
        this.entries = Object.freeze(ordered);
        Object.freeze(this);
    }

    public static empty(): Contributions {
        return emptyContributions;
    }

    public static encode(contributions: Contributions): Uint8Array {
        return contributionsCodec.encode(contributions);
    }

    public static decode(bytes: Uint8Array): Contributions {
        return contributionsCodec.decode(bytes);
    }

    public static fromMap(entries: Readonly<Record<string, readonly FacetData[]>>): Contributions {
        return new Contributions(
            Object.entries(entries).map(
                ([slot, values]) => new Contribution(new SlotName(slot), values)
            )
        );
    }

    public get(slot: SlotName): readonly FacetData[] | undefined {
        return this.entries.find((entry) => entry.slot.equals(slot))?.entries;
    }

    public toData(): FacetData {
        return canonicalFacetData(
            Object.fromEntries(this.entries.map((entry) => [entry.slot.value, entry.entries]))
        );
    }
}

const contributionsCodec = new DataRecordCodec(
    "facet.contributions",
    (contributions: Contributions) => contributions.toData(),
    (payload) => Contributions.fromMap(requireContributionMap(payload)),
    { major: 2, minor: 0 }
);

function requireContributionMap(
    payload: FacetData
): Readonly<Record<string, readonly FacetData[]>> {
    const object = requireDataObject(payload, "Contributions");
    return Object.fromEntries(
        Object.entries(object).map(([slot, values]) => [
            slot,
            requireArray(values, `Contribution ${slot}`)
        ])
    );
}

function requireImpact(value: FacetData | undefined): Impact {
    if (
        value === "observe" ||
        value === "mutate" ||
        value === "externalSend" ||
        value === "execute" ||
        value === "delegate" ||
        value === "administer"
    ) {
        return value;
    }
    throw new TypeError("Operation impact is invalid");
}

const emptyContributions = new Contributions([]);

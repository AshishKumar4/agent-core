import { JsonSchema, TextId } from "../core";
import type { FacetData } from "./data";
import {
    DataRecordCodec,
    dataRecord,
    canonicalFacetData,
    compareText,
    requireArray,
    requireDataObject,
    requireExactFields,
    requireNonblank,
    requireOfferedCapability,
    requireOptionalString,
    requireSchemaDocument,
    requireString
} from "./data";
import { OperationName, SlotName, SurfaceId } from "./id";
import type { Impact } from "./enforcement";

// The §7.1/§7.2 impact vocabulary and floor live in their own module because the generated
// lowering of `AgentCore.Facets.Enforcement` substitutes for exactly that surface; the
// re-export keeps every existing importer of this module unaffected.
export { claimHonorsEnforcementFloor, enforcementFloor } from "./enforcement";
export type { EnforcementTier, Impact } from "./enforcement";

export class OperationDescriptor {
    public readonly help: string | undefined;
    /**
     * SPEC §4.1 (C13-FACET-CAPABILITY-ABSENCE): §4.4's target consent is a capability the
     * manifest offers by declaring it, so `true` and absence are the only two forms. A
     * mandatory boolean would answer "did the author consider interception" with the same
     * value it answers "did the author refuse it", give one meaning two `manifestDigest`
     * values under §5.2, and leave a field a later edit could flip.
     */
    public readonly interceptable: true | undefined;

    public constructor(
        public readonly name: OperationName,
        public readonly impact: Impact,
        public readonly input: JsonSchema,
        public readonly output: JsonSchema,
        help?: string,
        interceptable?: true
    ) {
        if (help !== undefined) {
            requireNonblank(help, "Operation help");
        }
        this.help = help;
        this.interceptable = requireOfferedCapability(
            interceptable,
            "Operation interceptable declaration"
        );
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): OperationDescriptor {
        const object = requireDataObject(payload, "Operation descriptor");
        requireExactFields(
            object,
            ["impact", "input", "name", "output"],
            ["help", "interceptable"]
        );
        return new OperationDescriptor(
            new OperationName(requireString(object["name"], "Operation name")),
            requireImpact(object["impact"]),
            new JsonSchema(requireSchemaDocument(object["input"], "Operation input schema")),
            new JsonSchema(requireSchemaDocument(object["output"], "Operation output schema")),
            requireOptionalString(object["help"], "Operation help"),
            requireOfferedCapability(object["interceptable"], "Operation interceptable declaration")
        );
    }

    public static encode(descriptor: OperationDescriptor): Uint8Array {
        return operationDescriptorCodec.encode(descriptor);
    }

    public static decode(bytes: Uint8Array): OperationDescriptor {
        return operationDescriptorCodec.decode(bytes);
    }

    public toData(): FacetData {
        return dataRecord({
            impact: this.impact,
            input: this.input.document,
            interceptable: this.interceptable,
            name: this.name.value,
            output: this.output.document,
            help: this.help
        });
    }
}

const operationDescriptorCodec = new DataRecordCodec(
    [OperationDescriptor, TextId, JsonSchema, OperationName],
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
        return dataRecord({
            id: this.id.value,
            title: this.title,
            help: this.help
        });
    }
}

const surfaceDescriptorCodec = new DataRecordCodec(
    [SurfaceDescriptor, TextId, SurfaceId],
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
    [Contribution, TextId, SlotName],
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
    [Contributions, SlotName, TextId, Contribution],
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

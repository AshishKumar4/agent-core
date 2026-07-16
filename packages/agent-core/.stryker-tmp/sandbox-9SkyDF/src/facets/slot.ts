// @ts-nocheck
import { JsonSchema } from "../core";
import type { FacetData } from "./data";
import {
    DataRecordCodec,
    compareText,
    requireArray,
    requireDataObject,
    requireExactFields,
    requireNonblank,
    requireString
} from "./data";
import { SlotName } from "./id";

export class SlotAuthorityPolicy {
    public readonly contribute: readonly string[];
    public readonly visibility: readonly string[];

    public constructor(contribute: readonly string[], visibility: readonly string[]) {
        this.contribute = canonicalSelectors(contribute, "Slot contribute authority");
        this.visibility = canonicalSelectors(visibility, "Slot visibility authority");
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): SlotAuthorityPolicy {
        const object = requireDataObject(payload, "Slot authority policy");
        requireExactFields(object, ["contribute", "visibility"]);
        return new SlotAuthorityPolicy(
            requireArray(object["contribute"], "Slot contribute authority").map((value) =>
                requireString(value, "Slot contribute selector")
            ),
            requireArray(object["visibility"], "Slot visibility authority").map((value) =>
                requireString(value, "Slot visibility selector")
            )
        );
    }

    public static encode(policy: SlotAuthorityPolicy): Uint8Array {
        return slotAuthorityPolicyCodec.encode(policy);
    }

    public static decode(bytes: Uint8Array): SlotAuthorityPolicy {
        return slotAuthorityPolicyCodec.decode(bytes);
    }

    public toData(): FacetData {
        return { contribute: this.contribute, visibility: this.visibility };
    }
}

const slotAuthorityPolicyCodec = new DataRecordCodec(
    "facet.slot-authority-policy",
    (policy: SlotAuthorityPolicy) => policy.toData(),
    (payload) => SlotAuthorityPolicy.fromData(payload)
);

export class SlotDeclaration {
    public constructor(
        public readonly name: SlotName,
        public readonly entrySchema: JsonSchema,
        public readonly authority: SlotAuthorityPolicy
    ) {
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): SlotDeclaration {
        const object = requireDataObject(payload, "Slot declaration");
        requireExactFields(object, ["authority", "entrySchema", "name"]);
        return new SlotDeclaration(
            new SlotName(requireString(object["name"], "Slot name")),
            new JsonSchema(requireSchemaDocument(object["entrySchema"])),
            SlotAuthorityPolicy.fromData(object["authority"]!)
        );
    }

    public static encode(slot: SlotDeclaration): Uint8Array {
        return slotDeclarationCodec.encode(slot);
    }

    public static decode(bytes: Uint8Array): SlotDeclaration {
        return slotDeclarationCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            authority: this.authority.toData(),
            entrySchema: this.entrySchema.document,
            name: this.name.value
        };
    }
}

const slotDeclarationCodec = new DataRecordCodec(
    "facet.slot-declaration",
    (slot: SlotDeclaration) => slot.toData(),
    (payload) => SlotDeclaration.fromData(payload)
);

function canonicalSelectors(values: readonly string[], subject: string): readonly string[] {
    if (values.length === 0) {
        throw new TypeError(`${subject} must not be empty`);
    }
    for (const value of values) {
        requireNonblank(value, `${subject} selector`);
    }
    const ordered = [...values].sort(compareText);
    if (new Set(ordered).size !== ordered.length) {
        throw new TypeError(`${subject} selectors must be unique`);
    }
    return Object.freeze(ordered);
}

function requireSchemaDocument(
    value: FacetData | undefined
): boolean | { readonly [key: string]: FacetData } {
    if (typeof value === "boolean") {
        return value;
    }
    if (
        value === undefined ||
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
    ) {
        throw new TypeError("Slot entry schema must be an object or boolean");
    }
    return value as { readonly [key: string]: FacetData };
}

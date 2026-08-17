import { Digest, RecordCodec, encodeCanonicalJson, type RecordVersion } from "../core";
import { ContributionAttribution } from "./attribution";
import type { FacetData } from "./data";
import {
    canonicalFacetData,
    requireDataObject,
    requireExactFields,
    requireSafeInteger,
    requireString
} from "./data";
import { SlotEntryId, SlotName } from "./id";

/**
 * Major 3 carries the §4.2 source `PackagePin` alongside the contributing FacetRef. The
 * pin is a declared field, so it moves the entry's identity digest, and bytes written
 * before it existed decode as an unsupported major rather than as an unpinned entry.
 */
class SlotEntryCodecV3 extends RecordCodec<SlotEntry> {
    public constructor() {
        super("facet.slot-entry", { major: 3, minor: 0 });
        Object.freeze(this.version);
        Object.freeze(this);
    }

    protected encodePayload(entry: SlotEntry): FacetData {
        return entry.toData();
    }

    protected decodePayload(payload: FacetData, _version: RecordVersion): SlotEntry {
        return SlotEntry.fromData(payload);
    }
}

export class SlotEntry {
    public static readonly codec: RecordCodec<SlotEntry> = new SlotEntryCodecV3();

    public readonly value: FacetData;
    public readonly id: SlotEntryId;

    public constructor(
        public readonly slot: SlotName,
        public readonly attribution: ContributionAttribution,
        public readonly ordinal: number,
        value: FacetData,
        id?: SlotEntryId
    ) {
        if (!(attribution instanceof ContributionAttribution)) {
            throw new TypeError("Slot entry requires its contribution attribution");
        }
        if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
            throw new TypeError("Slot entry ordinal must be a non-negative safe integer");
        }
        this.value = canonicalFacetData(value);
        const expectedId = slotEntryId(slot, attribution, ordinal, this.value);
        if (id !== undefined && !id.equals(expectedId)) {
            throw new TypeError("Slot entry ID does not match its canonical contents");
        }
        this.id = expectedId;
        Object.freeze(this);
    }

    public static encode(entry: SlotEntry): Uint8Array {
        return SlotEntry.codec.encode(entry);
    }

    public static decode(bytes: Uint8Array): SlotEntry {
        return SlotEntry.codec.decode(bytes);
    }

    public static fromData(payload: FacetData): SlotEntry {
        const object = requireDataObject(payload, "Slot entry");
        requireExactFields(object, ["contributor", "id", "ordinal", "package", "slot", "value"]);
        return new SlotEntry(
            new SlotName(requireString(object["slot"], "Slot entry slot")),
            ContributionAttribution.decodeFields(object, "Slot entry"),
            requireSafeInteger(object["ordinal"], "Slot entry ordinal"),
            object["value"]!,
            new SlotEntryId(requireString(object["id"], "Slot entry ID"))
        );
    }

    public toData(): FacetData {
        return {
            ...this.attribution.encodeFields(),
            id: this.id.value,
            ordinal: this.ordinal,
            slot: this.slot.value,
            value: this.value
        };
    }
}

function slotEntryId(
    slot: SlotName,
    attribution: ContributionAttribution,
    ordinal: number,
    value: FacetData
): SlotEntryId {
    const digest = Digest.sha256(
        encodeCanonicalJson({
            ...attribution.encodeFields(),
            ordinal,
            slot: slot.value,
            value
        })
    );
    return new SlotEntryId(`slot:${digest.value}`);
}

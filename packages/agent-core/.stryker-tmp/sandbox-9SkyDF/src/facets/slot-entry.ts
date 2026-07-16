// @ts-nocheck
import { Digest, RecordCodec, encodeCanonicalJson, type RecordVersion } from "../core";
import type { FacetData } from "./data";
import {
    canonicalFacetData,
    requireDataObject,
    requireExactFields,
    requireSafeInteger,
    requireString
} from "./data";
import { FacetRef, SlotEntryId, SlotName } from "./id";

class SlotEntryCodecV2 extends RecordCodec<SlotEntry> {
    public constructor() {
        super("facet.slot-entry", { major: 2, minor: 0 });
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
    public static readonly codec: RecordCodec<SlotEntry> = new SlotEntryCodecV2();

    public readonly value: FacetData;
    public readonly id: SlotEntryId;

    public constructor(
        public readonly slot: SlotName,
        public readonly contributor: FacetRef,
        public readonly ordinal: number,
        value: FacetData,
        id?: SlotEntryId
    ) {
        if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
            throw new TypeError("Slot entry ordinal must be a non-negative safe integer");
        }
        this.value = canonicalFacetData(value);
        const expectedId = slotEntryId(slot, contributor, ordinal, this.value);
        if (id !== undefined && !id.equals(expectedId)) {
            throw new TypeError("Slot entry ID does not match its canonical contents");
        }
        this.id = expectedId;
        Object.freeze(this);
    }

    public static create(
        slot: SlotName,
        contributor: string,
        ordinal: number,
        value: FacetData
    ): SlotEntry {
        return new SlotEntry(slot, new FacetRef(contributor), ordinal, value);
    }

    public static encode(entry: SlotEntry): Uint8Array {
        return SlotEntry.codec.encode(entry);
    }

    public static decode(bytes: Uint8Array): SlotEntry {
        return SlotEntry.codec.decode(bytes);
    }

    public static fromData(payload: FacetData): SlotEntry {
        const object = requireDataObject(payload, "Slot entry");
        requireExactFields(object, ["contributor", "id", "ordinal", "slot", "value"]);
        return new SlotEntry(
            new SlotName(requireString(object["slot"], "Slot entry slot")),
            new FacetRef(requireString(object["contributor"], "Slot entry contributor")),
            requireSafeInteger(object["ordinal"], "Slot entry ordinal"),
            object["value"]!,
            new SlotEntryId(requireString(object["id"], "Slot entry ID"))
        );
    }

    public toData(): FacetData {
        return {
            contributor: this.contributor.value,
            id: this.id.value,
            ordinal: this.ordinal,
            slot: this.slot.value,
            value: this.value
        };
    }
}

function slotEntryId(
    slot: SlotName,
    contributor: FacetRef,
    ordinal: number,
    value: FacetData
): SlotEntryId {
    const digest = Digest.sha256(
        encodeCanonicalJson({
            contributor: contributor.value,
            ordinal,
            slot: slot.value,
            value
        })
    );
    return new SlotEntryId(`slot:${digest.value}`);
}

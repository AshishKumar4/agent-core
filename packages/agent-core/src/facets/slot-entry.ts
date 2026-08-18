import { Digest, RecordCodec, encodeCanonicalJson, type RecordVersion, TextId } from "../core";
import { ContributionAttribution } from "./attribution";
import type { FacetData } from "./data";
import {
    canonicalFacetData,
    requireDataObject,
    requireExactFields,
    requireSafeInteger,
    requireString
} from "./data";
import { FacetPackageId, FacetRef, SlotEntryId, SlotName } from "./id";

/**
 * SPEC §4.2: the position a contribution occupies — the exact triple a slot holds at most
 * one entry for. It is deliberately a different shape from `SlotEntryId`, because the two
 * answer different questions. The id digests every declared field, so it answers whether
 * two materializations are the same record; the origin names the position a changed
 * contribution supersedes. Collapsing them makes a contribution re-read from a later
 * release indistinguishable from an illegal rewrite of the record it replaces.
 */
export class SlotContributionOrigin {
    /** Lookup key for the at-most-one-entry-per-contributor-per-ordinal index. */
    public readonly key: string;

    public constructor(
        public readonly slot: SlotName,
        public readonly contributor: FacetRef,
        public readonly ordinal: number
    ) {
        if (!(slot instanceof SlotName) || !(contributor instanceof FacetRef)) {
            throw new TypeError("A slot contribution origin names its slot and contributor");
        }
        if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
            throw new TypeError(
                "Slot contribution origin ordinal must be a non-negative safe integer"
            );
        }
        // Both halves are canonical ids, so NUL separation is injective without a digest.
        this.key = `${slot.value}\0${contributor.value}\0${ordinal}`;
        Object.freeze(this);
    }

    public equals(other: SlotContributionOrigin): boolean {
        return this.key === other.key;
    }
}

/**
 * Major 3 carries the §4.2 source `PackagePin` alongside the contributing FacetRef. The
 * pin is a declared field, so it moves the entry's identity digest, and bytes written
 * before it existed decode as an unsupported major rather than as an unpinned entry.
 */
class SlotEntryCodecV3 extends RecordCodec<SlotEntry> {
    public constructor() {
        super(
            [
                SlotEntry,
                SlotContributionOrigin,
                ContributionAttribution,
                TextId,
                FacetRef,
                Digest,
                SlotName,
                SlotEntryId,
                FacetPackageId
            ],
            "facet.slot-entry",
            { major: 3, minor: 0 }
        );
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
    public static get codec(): RecordCodec<SlotEntry> {
        return slotEntryCodecInstance;
    }

    public readonly value: FacetData;
    public readonly id: SlotEntryId;
    /**
     * The §4.2 position this entry occupies. It is derived from declared fields rather than
     * stored, so it adds nothing to the record's shape and cannot drift from it.
     */
    public readonly origin: SlotContributionOrigin;

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
        this.origin = new SlotContributionOrigin(slot, attribution.contributor, ordinal);
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

const slotEntryCodecInstance = new SlotEntryCodecV3();

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

import {
    Digest,
    RecordCodec,
    SemVer,
    TextId,
    canonicalTupleKey,
    encodeCanonicalJson,
    type RecordVersion
} from "../core";
import { PackageId, PackagePin } from "../definition-references";
import { ContributionAttribution } from "./attribution";
import type { FacetData } from "./data";
import {
    compareText,
    requireDataObject,
    requireExactFields,
    requireNonblank,
    requireSafeInteger,
    requireString
} from "./data";
import { FacetPackageId, FacetRef, PromptSectionId } from "./id";

/**
 * SPEC §4.2: the position one contributed prompt section occupies — the exact pair a
 * contribution holds at most one section for. It mirrors `SlotContributionOrigin`: the id
 * digests every declared field and answers whether two materializations are the same
 * record, the origin names the slot a changed contribution supersedes. Collapsing them
 * makes a contribution re-read from a later release indistinguishable from an illegal
 * rewrite of the record it replaces.
 */
export class PromptSectionContributionOrigin {
    /** Lookup key for the at-most-one-section-per-contributor-per-position index. */
    public readonly key: string;

    public constructor(
        public readonly contributor: FacetRef,
        public readonly position: number
    ) {
        if (!(contributor instanceof FacetRef)) {
            throw new TypeError("A prompt contribution origin names its contributor");
        }
        if (!Number.isSafeInteger(position) || position < 0) {
            throw new TypeError(
                "Prompt contribution origin position must be a non-negative safe integer"
            );
        }
        this.key = canonicalTupleKey("prompt-section.origin", [contributor.value, position]);
        Object.freeze(this);
    }

    public equals(other: PromptSectionContributionOrigin): boolean {
        return this.key === other.key;
    }
}

/**
 * Major 1 is the initial shape: every declared field plus the §4.2 attribution. The pin
 * is a declared field, so it moves the section's identity digest, and a host that
 * materialized an unpinned section would decode as unsupported rather than as
 * unattributed.
 */
class PromptSectionCodecV1 extends RecordCodec<PromptSection> {
    public constructor() {
        super(
            [
                PromptSection,
                PromptSectionContributionOrigin,
                ContributionAttribution,
                TextId,
                FacetRef,
                Digest,
                PromptSectionId,
                FacetPackageId,
                SemVer,
                PackageId,
                PackagePin
            ],
            "facet.prompt-section",
            { major: 1, minor: 0 }
        );
        Object.freeze(this.version);
        Object.freeze(this);
    }

    protected encodePayload(section: PromptSection): FacetData {
        return section.toData();
    }

    protected decodePayload(payload: FacetData, _version: RecordVersion): PromptSection {
        return PromptSection.fromData(payload);
    }
}

/**
 * SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): one prompt-assembly section as the owning
 * Workspace holds it, carrying the exact `FacetRef` whose `prompt` contribution materialized
 * it and the `PackagePin` of the release it was read from. The declaration half is authored
 * in a manifest before any release exists, so the pin lives here rather than on `Prompt` —
 * the same split `SurfaceRegistration` makes for Surfaces — and a section the host cannot
 * attribute cannot be built. That is what lets a host answer from records alone which Facet
 * is responsible for a prompt section, what puts the section in that Facet's §4.1 withdrawal
 * set, and what keeps unrelated sections' order stable while one contributor's set retires.
 */
export class PromptSection {
    public static get codec(): RecordCodec<PromptSection> {
        return promptSectionCodecInstance;
    }

    /**
     * The order a host assembles stored sections in: declared priority first, then the
     * declared text, then the origin. Every key is a declared field or the origin, so two
     * stores of the same records list them in the same order without consulting anything
     * outside this record.
     */
    public static compare(left: PromptSection, right: PromptSection): number {
        return (
            left.priority - right.priority ||
            compareText(left.title, right.title) ||
            compareText(left.body, right.body) ||
            compareText(left.origin.contributor.value, right.origin.contributor.value) ||
            left.origin.position - right.origin.position
        );
    }

    public readonly id: PromptSectionId;
    /**
     * The §4.2 position this section occupies. It is derived from declared fields rather
     * than stored, so it adds nothing to the record's shape and cannot drift from it.
     */
    public readonly origin: PromptSectionContributionOrigin;

    public constructor(
        public readonly title: string,
        public readonly body: string,
        public readonly priority: number,
        public readonly attribution: ContributionAttribution,
        public readonly position: number,
        id?: PromptSectionId
    ) {
        requireNonblank(title, "Prompt section title");
        requireNonblank(body, "Prompt section body");
        if (!Number.isSafeInteger(priority)) {
            throw new TypeError("Prompt section priority must be a safe integer");
        }
        if (!(attribution instanceof ContributionAttribution)) {
            throw new TypeError("Prompt section requires its contribution attribution");
        }
        if (!Number.isSafeInteger(position) || position < 0) {
            throw new TypeError("Prompt section position must be a non-negative safe integer");
        }
        this.origin = new PromptSectionContributionOrigin(attribution.contributor, position);
        const expectedId = promptSectionId(
            this.title,
            this.body,
            this.priority,
            attribution,
            position
        );
        if (id !== undefined && !id.equals(expectedId)) {
            throw new TypeError("Prompt section ID does not match its canonical contents");
        }
        this.id = expectedId;
        Object.freeze(this);
    }

    public static encode(section: PromptSection): Uint8Array {
        return PromptSection.codec.encode(section);
    }

    public static decode(bytes: Uint8Array): PromptSection {
        return PromptSection.codec.decode(bytes);
    }

    public static fromData(payload: FacetData): PromptSection {
        const object = requireDataObject(payload, "Prompt section");
        requireExactFields(object, [
            "body",
            "contributor",
            "id",
            "package",
            "position",
            "priority",
            "title"
        ]);
        return new PromptSection(
            requireString(object["title"], "Prompt section title"),
            requireString(object["body"], "Prompt section body"),
            requireSafeInteger(object["priority"], "Prompt section priority"),
            ContributionAttribution.decodeFields(object, "Prompt section"),
            requireSafeInteger(object["position"], "Prompt section position"),
            new PromptSectionId(requireString(object["id"], "Prompt section ID"))
        );
    }

    public toData(): FacetData {
        return {
            ...this.attribution.encodeFields(),
            body: this.body,
            id: this.id.value,
            position: this.position,
            priority: this.priority,
            title: this.title
        };
    }
}

const promptSectionCodecInstance = new PromptSectionCodecV1();

function promptSectionId(
    title: string,
    body: string,
    priority: number,
    attribution: ContributionAttribution,
    position: number
): PromptSectionId {
    const digest = Digest.sha256(
        encodeCanonicalJson({
            ...attribution.encodeFields(),
            body,
            position,
            priority,
            title
        })
    );
    return new PromptSectionId(`prompt:${digest.value}`);
}

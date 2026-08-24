import {
    Digest,
    JsonSchema,
    SemVer,
    TextId,
    canonicalTupleKey,
    encodeCanonicalJson
} from "../core";
import { PackageId, PackagePin } from "../definition-references";
import { ContributionAttribution } from "./attribution";
import type { FacetData } from "./data";
import {
    DataRecordCodec,
    canonicalFacetData,
    requireDataObject,
    requireExactFields,
    requireSafeInteger,
    requireSchemaDocument
} from "./data";
import { FacetPackageId, FacetRef, SettingsLayerId } from "./id";

/**
 * SPEC §4.2: the position one settings layer occupies in the merged platform config
 * view — the contributing Facet and the declared order of its fragment among that
 * Facet's own `settings` contributions. It is deliberately a different shape from
 * `SettingsLayerId`, because the two answer different questions: the id digests every
 * declared field, so it answers whether two materializations are the same record; the
 * origin names the position a changed contribution supersedes.
 */
export class SettingsLayerOrigin {
    /** Lookup key for the at-most-one-layer-per-contributor-per-ordinal index. */
    public readonly key: string;

    public constructor(
        public readonly contributor: FacetRef,
        public readonly ordinal: number
    ) {
        if (!(contributor instanceof FacetRef)) {
            throw new TypeError("A settings layer origin names its contributor");
        }
        if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
            throw new TypeError(
                "Settings layer origin ordinal must be a non-negative safe integer"
            );
        }
        this.key = canonicalTupleKey("settings-layer.origin", [contributor.value, ordinal]);
        Object.freeze(this);
    }

    public equals(other: SettingsLayerOrigin): boolean {
        return this.key === other.key;
    }
}

/**
 * SPEC §4.2: one Facet's contributed settings fragment as a Scope holds it — the declared
 * JSON-schema fragment paired with the §4.2 attribution of the release it was read from.
 * The declaration half is authored in a manifest before any release exists, so the pin
 * lives here rather than beside the fragment — the same split an InstalledSlot or a
 * SurfaceRegistration makes — and a layer the host cannot attribute cannot be built.
 * That is what lets a host answer from records alone which Facet contributed any part of
 * the merged config schema, and what puts the layer in that Facet's §4.1 withdrawal set.
 */
export class SettingsLayer {
    public static get codec(): DataRecordCodec<SettingsLayer> {
        return settingsLayerCodec;
    }

    public readonly schema: JsonSchema;
    public readonly origin: SettingsLayerOrigin;
    /**
     * Derived from the declared fields rather than stored, so it adds nothing to the
     * record's shape and cannot drift from it.
     */
    public readonly id: SettingsLayerId;

    public constructor(
        public readonly attribution: ContributionAttribution,
        public readonly ordinal: number,
        schema: FacetData
    ) {
        if (!(attribution instanceof ContributionAttribution)) {
            throw new TypeError("Settings layer requires its contribution attribution");
        }
        if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
            throw new TypeError("Settings layer ordinal must be a non-negative safe integer");
        }
        // A fragment that is not a JSON-schema document would fail at merge time instead
        // of at materialization, so the declaration-time check runs here.
        const declared = new JsonSchema(requireSchemaDocument(schema, "Settings fragment"));
        declared.assertSupported();
        this.schema = declared;
        this.origin = new SettingsLayerOrigin(attribution.contributor, ordinal);
        this.id = settingsLayerId(attribution, ordinal, declared.document);
        Object.freeze(this);
    }

    public static encode(layer: SettingsLayer): Uint8Array {
        return settingsLayerCodec.encode(layer);
    }

    public static decode(bytes: Uint8Array): SettingsLayer {
        return settingsLayerCodec.decode(bytes);
    }

    public static fromData(payload: FacetData): SettingsLayer {
        const object = requireDataObject(payload, "Settings layer");
        requireExactFields(object, ["contributor", "ordinal", "package", "schema"]);
        return new SettingsLayer(
            ContributionAttribution.decodeFields(object, "Settings layer"),
            requireSafeInteger(object["ordinal"], "Settings layer ordinal"),
            object["schema"]!
        );
    }

    public toData(): FacetData {
        return {
            ...this.attribution.encodeFields(),
            ordinal: this.ordinal,
            schema: this.schema.document
        };
    }
}

const settingsLayerCodec = new DataRecordCodec(
    [
        SettingsLayer,
        SettingsLayerOrigin,
        ContributionAttribution,
        TextId,
        FacetRef,
        Digest,
        SettingsLayerId,
        JsonSchema,
        FacetPackageId,
        SemVer,
        PackageId,
        PackagePin
    ],
    "facet.settings-layer",
    (layer: SettingsLayer) => layer.toData(),
    (payload) => SettingsLayer.fromData(payload)
);

function settingsLayerId(
    attribution: ContributionAttribution,
    ordinal: number,
    schema: JsonSchema["document"]
): SettingsLayerId {
    const digest = Digest.sha256(
        encodeCanonicalJson({
            ...attribution.encodeFields(),
            ordinal,
            schema: canonicalFacetData(schema)
        })
    );
    return new SettingsLayerId(`settings:${digest.value}`);
}

import {
    Digest,
    RecordCodec,
    encodeCanonicalJson,
    isMember,
    type JsonValue,
    Revision,
    SemVer,
    TextId
} from "../../core";
import { FacetPackageId, FacetRef, PlacementIntersection, type IsolationMode } from "../../facets";
import { PackageId, PackagePin, PLACEMENT_PREFERENCE, preferredPlacement } from "../../definition";
import { EnvironmentId } from "../../environments";
import { TurnId } from "../../execution-references";
import {
    CodecRecord,
    compareText,
    requireArray,
    requireExactFields,
    requireObject,
    requireString
} from "../record-data";
import { AgentId, AgentPolicyId, ModelPolicyId } from "../id";
import { BlueprintPin, RunPins, RunPinsCodec } from "./pins";

export interface PlacementPinInit {
    readonly facet: FacetRef;
    readonly manifest: readonly IsolationMode[];
    readonly policy: readonly IsolationMode[];
    readonly substrate: readonly IsolationMode[];
    readonly trust: readonly IsolationMode[];
    readonly selected: IsolationMode;
}

export class PlacementPin {
    public readonly facet: FacetRef;
    public readonly manifest: readonly IsolationMode[];
    public readonly policy: readonly IsolationMode[];
    public readonly substrate: readonly IsolationMode[];
    public readonly trust: readonly IsolationMode[];
    public readonly selected: IsolationMode;

    public constructor(init: PlacementPinInit) {
        this.facet = init.facet;
        this.manifest = canonicalModes(init.manifest, "Manifest modes");
        this.policy = canonicalModes(init.policy, "Policy modes");
        this.substrate = canonicalModes(init.substrate, "Substrate modes");
        this.trust = canonicalModes(init.trust, "Trust modes");
        if (
            ![this.manifest, this.policy, this.substrate, this.trust].every((modes) =>
                modes.includes(init.selected)
            )
        ) {
            throw new TypeError("Placement selection must belong to every source set");
        }
        const selected = preferredPlacement(this.manifest, this.policy, this.substrate, this.trust);
        if (selected !== init.selected) {
            throw new TypeError("Placement selection must use the fixed preference order");
        }
        this.selected = selected;
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            facet: this.facet.value,
            manifest: this.manifest,
            policy: this.policy,
            selected: this.selected,
            substrate: this.substrate,
            trust: this.trust
        };
    }

    public static fromData(value: JsonValue): PlacementPin {
        const object = requireObject(value, "Placement pin");
        requireExactFields(
            object,
            ["facet", "manifest", "policy", "selected", "substrate", "trust"],
            [],
            "Placement pin"
        );
        return new PlacementPin({
            facet: new FacetRef(requireString(object["facet"], "Placement Facet")),
            manifest: modesFromData(object["manifest"], "Manifest modes"),
            policy: modesFromData(object["policy"], "Policy modes"),
            substrate: modesFromData(object["substrate"], "Substrate modes"),
            trust: modesFromData(object["trust"], "Trust modes"),
            selected: requireIsolationMode(object["selected"], "Selected mode")
        });
    }
}

export class TurnPlacementSnapshot extends CodecRecord {
    public static get codec(): RecordCodec<TurnPlacementSnapshot> {
        return TurnPlacementSnapshotCodec;
    }
    public readonly turn: TurnId;
    public readonly pins: RunPins;
    public readonly placements: readonly PlacementPin[];
    public readonly digest: Digest;

    public constructor(turn: TurnId, pins: RunPins, placements: readonly PlacementPin[]) {
        super();
        const canonical = [...placements]
            .map((placement) => PlacementPin.fromData(placement.toData()))
            .sort((left, right) => compareText(left.facet.value, right.facet.value));
        if (
            new Set(canonical.map((placement) => placement.facet.value)).size !== canonical.length
        ) {
            throw new TypeError("Turn placement Facet references must be unique");
        }
        this.turn = turn;
        this.pins = RunPinsCodec.decode(RunPinsCodec.encode(pins));
        this.placements = Object.freeze(canonical);
        this.digest = Digest.sha256(encodeCanonicalJson(this.toData()));
        Object.freeze(this);
    }

    /**
     * The Turn's FacetSet (SPEC §4.1, §5.3): the canonical-ordered, unique FacetRef
     * membership of the Turn's one composition view. The constructor already canonicalizes
     * and deduplicates `placements`, so this reads the captured record rather than holding a
     * second membership list beside it. A second list is what would make the Turn compose
     * two views, and §5.3 fixes it to one, which is why this is a derivation and never a
     * stored field.
     */
    public get facetSet(): readonly FacetRef[] {
        return Object.freeze(this.placements.map((placement) => placement.facet));
    }

    /**
     * Whether the Turn composes this Facet, answered from the captured set. Every membership
     * question goes through here, so no caller can answer one from the Scope's current
     * install records and get a different answer for the same Turn.
     */
    public composes(facet: FacetRef): boolean {
        return this.placements.some((placement) => placement.facet.equals(facet));
    }

    public toData(): JsonValue {
        return {
            pins: this.pins.toData(),
            placements: this.placements.map((placement) => placement.toData()),
            turn: this.turn.value
        };
    }

    public static fromData(value: JsonValue): TurnPlacementSnapshot {
        const object = requireObject(value, "Turn placement snapshot");
        requireExactFields(object, ["pins", "placements", "turn"], [], "Turn placement snapshot");
        return new TurnPlacementSnapshot(
            new TurnId(requireString(object["turn"], "Placement Turn")),
            RunPins.fromData(object["pins"]),
            requireArray(object["placements"], "Placement entries").map(PlacementPin.fromData)
        );
    }
}

class PlacementSnapshotCodec extends RecordCodec<TurnPlacementSnapshot> {
    public constructor() {
        super(
            [
                TurnPlacementSnapshot,
                PlacementPin,
                Revision,
                TextId,
                SemVer,
                RunPins,
                PackagePin,
                BlueprintPin,
                Digest,
                TurnId,
                AgentId,
                CodecRecord,
                ModelPolicyId,
                EnvironmentId,
                AgentPolicyId,
                FacetRef,
                FacetPackageId,
                PackageId,
                PlacementIntersection
            ],
            "turn.placement-snapshot",
            {
                major: 1,
                minor: 0
            }
        );
    }

    protected encodePayload(value: TurnPlacementSnapshot): JsonValue {
        return value.toData();
    }

    protected decodePayload(value: JsonValue): TurnPlacementSnapshot {
        return TurnPlacementSnapshot.fromData(value);
    }
}

export const TurnPlacementSnapshotCodec: RecordCodec<TurnPlacementSnapshot> =
    new PlacementSnapshotCodec();

function canonicalModes(
    modes: readonly IsolationMode[],
    subject: string
): readonly IsolationMode[] {
    if (modes.length === 0 || new Set(modes).size !== modes.length) {
        throw new TypeError(`${subject} must be nonempty and unique`);
    }
    if (modes.some((mode) => !PLACEMENT_PREFERENCE.includes(mode))) {
        throw new TypeError(`${subject} contains an unknown mode`);
    }
    return Object.freeze(PLACEMENT_PREFERENCE.filter((mode) => modes.includes(mode)));
}

function modesFromData(value: JsonValue | undefined, subject: string): readonly IsolationMode[] {
    return requireArray(value, subject).map((entry) => requireIsolationMode(entry, subject));
}

function requireIsolationMode(value: JsonValue | undefined, subject: string): IsolationMode {
    if (isMember(PLACEMENT_PREFERENCE, value)) return value;
    throw new TypeError(`${subject} contains an unknown isolation mode`);
}

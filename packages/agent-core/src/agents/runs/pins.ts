import {
    Digest,
    RecordCodec,
    Revision,
    SemVer,
    encodeCanonicalJson,
    type JsonValue,
    TextId
} from "../../core";
import { PackageId, PackagePin } from "../../definition";
import { EnvironmentId } from "../../environments";
import { AgentId, AgentPolicyId, ModelPolicyId } from "../id";
import {
    bytesEqual,
    CodecRecord,
    compareText,
    digestFromData,
    requireArray,
    requireExactFields,
    requireObject,
    requireString,
    revisionData,
    revisionFromData
} from "../record-data";

export class BlueprintPin {
    public constructor(
        public readonly name: string,
        public readonly version: SemVer,
        public readonly digest: Digest
    ) {
        if (name.trim().length === 0) throw new TypeError("Blueprint pin name must not be blank");
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return { digest: this.digest.value, name: this.name, version: this.version.toString() };
    }

    public static fromData(value: JsonValue): BlueprintPin {
        const object = requireObject(value, "Blueprint pin");
        requireExactFields(object, ["digest", "name", "version"], [], "Blueprint pin");
        return new BlueprintPin(
            requireString(object["name"], "Blueprint pin name"),
            new SemVer(requireString(object["version"], "Blueprint pin version")),
            digestFromData(object["digest"], "Blueprint pin digest")
        );
    }
}

export interface RunPinsInit {
    readonly blueprint: BlueprintPin;
    readonly packages: readonly PackagePin[];
    readonly agent: SourcePin<AgentId>;
    readonly effectivePolicy: SourcePin<AgentPolicyId>;
    readonly modelPolicy: SourcePin<ModelPolicyId>;
    readonly environment: SourcePin<EnvironmentId>;
}

export interface SourcePin<Id> {
    readonly id: Id;
    readonly revision: Revision;
    readonly digest: Digest;
}

export class RunPins extends CodecRecord {
    public static get codec(): RecordCodec<RunPins> {
        return RunPinsCodec;
    }
    public readonly blueprint: BlueprintPin;
    public readonly packages: readonly PackagePin[];
    public readonly agent: SourcePin<AgentId>;
    public readonly effectivePolicy: SourcePin<AgentPolicyId>;
    public readonly modelPolicy: SourcePin<ModelPolicyId>;
    public readonly environment: SourcePin<EnvironmentId>;
    public readonly digest: Digest;

    public constructor(init: RunPinsInit) {
        super();
        const packages = [...init.packages]
            .map((pin) => PackagePin.fromData(pin.toData()))
            .sort((left, right) => compareText(left.id.value, right.id.value));
        if (
            packages.length === 0 ||
            new Set(packages.map((pin) => pin.id.value)).size !== packages.length
        ) {
            throw new TypeError(
                "Run pins package closure must be nonempty with unique Package IDs"
            );
        }
        this.blueprint = BlueprintPin.fromData(init.blueprint.toData());
        this.packages = Object.freeze(packages);
        this.agent = requireSourcePin(init.agent, AgentId, "Agent pin");
        this.effectivePolicy = requireSourcePin(
            init.effectivePolicy,
            AgentPolicyId,
            "Effective policy pin"
        );
        this.modelPolicy = requireSourcePin(init.modelPolicy, ModelPolicyId, "Model policy pin");
        this.environment = requireSourcePin(init.environment, EnvironmentId, "Environment pin");
        this.digest = Digest.sha256(encodeCanonicalJson(this.toData()));
        Object.freeze(this);
    }

    public equals(other: RunPins): boolean {
        return bytesEqual(RunPinsCodec.encode(this), RunPinsCodec.encode(other));
    }

    /**
     * The dimensions in which this pin set differs from another, with the exact identities
     * that differ in each. Derived from the two records whenever it is asked for and stored
     * nowhere: a merge names both of its parents, so both pin records are already durable,
     * and recording their difference would be a second copy of what the graph holds. Empty
     * exactly when `equals` holds.
     */
    public divergence(other: RunPins): readonly RunPinDivergence[] {
        const divergence: RunPinDivergence[] = [];
        for (const dimension of RunPinDimension.all) {
            const identities = dimension.divergentIdentities(this, other);
            if (identities.length > 0) divergence.push(Object.freeze({ dimension, identities }));
        }
        return Object.freeze(divergence);
    }

    public toData(): JsonValue {
        return {
            agent: pinData(this.agent),
            blueprint: this.blueprint.toData(),
            effectivePolicy: pinData(this.effectivePolicy),
            environment: pinData(this.environment),
            modelPolicy: pinData(this.modelPolicy),
            packages: this.packages.map((pin) => pin.toData())
        };
    }

    public static fromData(value: JsonValue): RunPins {
        const object = requireObject(value, "Run pins");
        requireExactFields(
            object,
            ["agent", "blueprint", "effectivePolicy", "environment", "modelPolicy", "packages"],
            [],
            "Run pins"
        );
        return new RunPins({
            blueprint: BlueprintPin.fromData(object["blueprint"]),
            packages: requireArray(object["packages"], "Run pin packages").map(PackagePin.fromData),
            agent: pinFromData(object["agent"], AgentId, "Agent pin"),
            effectivePolicy: pinFromData(
                object["effectivePolicy"],
                AgentPolicyId,
                "Effective policy pin"
            ),
            modelPolicy: pinFromData(object["modelPolicy"], ModelPolicyId, "Model policy pin"),
            environment: pinFromData(object["environment"], EnvironmentId, "Environment pin")
        });
    }
}

class RunPinsRecordCodec extends RecordCodec<RunPins> {
    public constructor() {
        super(
            [
                RunPins,
                BlueprintPin,
                Revision,
                TextId,
                SemVer,
                PackagePin,
                Digest,
                AgentId,
                CodecRecord,
                ModelPolicyId,
                EnvironmentId,
                AgentPolicyId,
                PackageId
            ],
            "run.pins",
            {
                major: 1,
                minor: 0
            }
        );
    }

    protected encodePayload(value: RunPins): JsonValue {
        return value.toData();
    }

    protected decodePayload(value: JsonValue): RunPins {
        return RunPins.fromData(value);
    }
}

export const RunPinsCodec: RecordCodec<RunPins> = new RunPinsRecordCodec();

/** One dimension of a RunPins comparison, with the exact identities that differ in it. */
export interface RunPinDivergence {
    readonly dimension: RunPinDimension;
    /** Nonempty: the identities this dimension disagrees about. */
    readonly identities: readonly string[];
}

/**
 * The closed set of dimensions RunPins carries. A merge requires equal pins on both parents,
 * and a refusal saying only that two pin sets were unequal leaves the caller to search for the
 * disagreement the platform already found — so each case owns the comparison for its own
 * dimension and names what differs. `all` is the one place the dimensions are enumerated, so a
 * pin field nobody taught to compare is visible here rather than silently equal.
 */
export abstract class RunPinDimension {
    public static get blueprint(): RunPinDimension {
        return blueprintDimension;
    }
    public static get packages(): RunPinDimension {
        return packagesDimension;
    }
    public static get agent(): RunPinDimension {
        return agentDimension;
    }
    public static get effectivePolicy(): RunPinDimension {
        return effectivePolicyDimension;
    }
    public static get modelPolicy(): RunPinDimension {
        return modelPolicyDimension;
    }
    public static get environment(): RunPinDimension {
        return environmentDimension;
    }
    /** Every dimension, in the order a refusal names them. */
    public static get all(): readonly RunPinDimension[] {
        return allDimensions;
    }

    public abstract readonly label: string;

    /** The identities that differ in this dimension, empty when it agrees. */
    public abstract divergentIdentities(left: RunPins, right: RunPins): readonly string[];

    public equals(other: RunPinDimension): boolean {
        return this === other;
    }
}

class BlueprintDimension extends RunPinDimension {
    public readonly label = "blueprint";
    public divergentIdentities(left: RunPins, right: RunPins): readonly string[] {
        const first = left.blueprint;
        const second = right.blueprint;
        if (
            first.name === second.name &&
            first.version.equals(second.version) &&
            first.digest.equals(second.digest)
        ) {
            return [];
        }
        return distinctIdentities([first.name, second.name]);
    }
}

class SourceDimension extends RunPinDimension {
    public constructor(
        public readonly label: string,
        private readonly select: (pins: RunPins) => SourcePin<{ readonly value: string }>
    ) {
        super();
    }
    public divergentIdentities(left: RunPins, right: RunPins): readonly string[] {
        const first = this.select(left);
        const second = this.select(right);
        if (
            first.id.value === second.id.value &&
            first.revision.equals(second.revision) &&
            first.digest.equals(second.digest)
        ) {
            return [];
        }
        return distinctIdentities([first.id.value, second.id.value]);
    }
}

class PackagesDimension extends RunPinDimension {
    public readonly label = "packages";
    public divergentIdentities(left: RunPins, right: RunPins): readonly string[] {
        const remaining = new Map(right.packages.map((pin) => [pin.id.value, pin]));
        const divergent: string[] = [];
        for (const pin of left.packages) {
            const other = remaining.get(pin.id.value);
            if (other === undefined || !pin.equals(other)) divergent.push(pin.id.value);
            remaining.delete(pin.id.value);
        }
        return distinctIdentities([...divergent, ...remaining.keys()]);
    }
}

function distinctIdentities(values: readonly string[]): readonly string[] {
    return Object.freeze([...new Set(values)].sort(compareText));
}

const blueprintDimension = new BlueprintDimension();
const packagesDimension = new PackagesDimension();
const agentDimension = new SourceDimension("agent", (pins) => pins.agent);
const effectivePolicyDimension = new SourceDimension(
    "effectivePolicy",
    (pins) => pins.effectivePolicy
);
const modelPolicyDimension = new SourceDimension("modelPolicy", (pins) => pins.modelPolicy);
const environmentDimension = new SourceDimension("environment", (pins) => pins.environment);
const allDimensions: readonly RunPinDimension[] = Object.freeze([
    blueprintDimension,
    packagesDimension,
    agentDimension,
    effectivePolicyDimension,
    modelPolicyDimension,
    environmentDimension
]);

export interface RunConfigurationSnapshotInit {
    readonly pins: RunPins;
}

export class RunConfigurationSnapshot extends CodecRecord {
    public static get codec(): RecordCodec<RunConfigurationSnapshot> {
        return RunConfigurationSnapshotCodec;
    }
    public readonly pins: RunPins;
    public readonly id: Digest;

    public constructor(init: RunConfigurationSnapshotInit) {
        super();
        this.pins = RunPins.fromData(init.pins.toData());
        this.id = Digest.sha256(encodeCanonicalJson(this.toData()));
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return { pins: this.pins.toData() };
    }

    public static fromData(value: JsonValue): RunConfigurationSnapshot {
        const object = requireObject(value, "Run configuration snapshot");
        requireExactFields(object, ["pins"], [], "Run configuration snapshot");
        return new RunConfigurationSnapshot({
            pins: RunPins.fromData(object["pins"])
        });
    }
}

class RunConfigurationCodec extends RecordCodec<RunConfigurationSnapshot> {
    public constructor() {
        super(
            [
                RunConfigurationSnapshot,
                BlueprintPin,
                Revision,
                TextId,
                SemVer,
                RunPins,
                PackagePin,
                Digest,
                AgentId,
                CodecRecord,
                ModelPolicyId,
                EnvironmentId,
                AgentPolicyId,
                PackageId
            ],
            "run.configuration-snapshot",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(value: RunConfigurationSnapshot): JsonValue {
        return value.toData();
    }

    protected decodePayload(value: JsonValue): RunConfigurationSnapshot {
        return RunConfigurationSnapshot.fromData(value);
    }
}

export const RunConfigurationSnapshotCodec: RecordCodec<RunConfigurationSnapshot> =
    new RunConfigurationCodec();

type TextIdConstructor<Id> = new (value: string) => Id;

function requireSourcePin<Id>(
    pin: SourcePin<Id>,
    idType: TextIdConstructor<Id>,
    subject: string
): SourcePin<Id> {
    if (
        !(pin.id instanceof idType) ||
        !(pin.revision instanceof Revision) ||
        !(pin.digest instanceof Digest)
    ) {
        throw new TypeError(`${subject} must contain the canonical ID, Revision, and Digest`);
    }
    return Object.freeze({ id: pin.id, revision: pin.revision, digest: pin.digest });
}

function pinData(pin: SourcePin<{ readonly value: string }>): JsonValue {
    return { digest: pin.digest.value, id: pin.id.value, revision: revisionData(pin.revision) };
}

function pinFromData<Id>(
    value: JsonValue,
    idType: TextIdConstructor<Id>,
    subject: string
): SourcePin<Id> {
    const object = requireObject(value, subject);
    requireExactFields(object, ["digest", "id", "revision"], [], subject);
    return requireSourcePin(
        {
            id: new idType(requireString(object["id"], `${subject} ID`)),
            revision: revisionFromData(object["revision"], `${subject} revision`),
            digest: digestFromData(object["digest"], `${subject} digest`)
        },
        idType,
        subject
    );
}

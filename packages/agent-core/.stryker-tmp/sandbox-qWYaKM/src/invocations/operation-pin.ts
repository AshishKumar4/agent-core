// @ts-nocheck
import { Digest, SemVer, type JsonValue } from "../core";
import { OperationRef, type Impact, type IsolationMode } from "../facets";
import { POLICY_IMPACTS, PackageId, PLACEMENT_PREFERENCE } from "../definition";
import {
    requireArray,
    requireCanonicalText,
    requireDigest,
    requireExactObject,
    requireString
} from "./codec";

const MODES: readonly IsolationMode[] = PLACEMENT_PREFERENCE;
const IMPACTS: readonly Impact[] = POLICY_IMPACTS;

export interface PlacementPinInit {
    readonly manifest: readonly IsolationMode[];
    readonly policy: readonly IsolationMode[];
    readonly substrate: readonly IsolationMode[];
    readonly trust: readonly IsolationMode[];
    readonly selected: IsolationMode;
}

export class InvocationPlacementPin {
    public readonly manifest: readonly IsolationMode[];
    public readonly policy: readonly IsolationMode[];
    public readonly substrate: readonly IsolationMode[];
    public readonly trust: readonly IsolationMode[];

    public constructor(init: PlacementPinInit) {
        this.manifest = canonicalModes(init.manifest, "manifest");
        this.policy = canonicalModes(init.policy, "policy");
        this.substrate = canonicalModes(init.substrate, "substrate");
        this.trust = canonicalModes(init.trust, "trust");
        requireMode(init.selected);
        if (
            ![this.manifest, this.policy, this.substrate, this.trust].every((modes) =>
                modes.includes(init.selected)
            )
        ) {
            throw new TypeError("Selected placement must occur in every admissible set");
        }
        const selected = MODES.find((mode) =>
            [this.manifest, this.policy, this.substrate, this.trust].every((modes) =>
                modes.includes(mode)
            )
        );
        if (selected !== init.selected) {
            throw new TypeError("Selected placement must follow the canonical preference order");
        }
        this.selected = init.selected;
        Object.freeze(this);
    }

    public readonly selected: IsolationMode;

    public toData(): JsonValue {
        return {
            manifest: this.manifest,
            policy: this.policy,
            selected: this.selected,
            substrate: this.substrate,
            trust: this.trust
        };
    }

    public static fromData(value: JsonValue): InvocationPlacementPin {
        const object = requireExactObject(
            value,
            ["manifest", "policy", "selected", "substrate", "trust"],
            "Invocation placement pin"
        );
        return new InvocationPlacementPin({
            manifest: decodeModes(requireArray(object, "manifest")),
            policy: decodeModes(requireArray(object, "policy")),
            selected: requireMode(requireString(object, "selected")),
            substrate: decodeModes(requireArray(object, "substrate")),
            trust: decodeModes(requireArray(object, "trust"))
        });
    }
}

export interface OperationPinInit {
    readonly operation: OperationRef;
    readonly target: string;
    readonly package: PackageId;
    readonly version: SemVer;
    readonly manifestDigest: Digest;
    readonly descriptorDigest: Digest;
    readonly configurationDigest: Digest;
    readonly runtimeDigest: Digest;
    readonly activationGeneration: string;
    readonly registration: string;
    readonly impact: Impact;
    readonly approvalRequired: boolean;
    readonly placement: InvocationPlacementPin;
}

export class OperationPin {
    public constructor(
        public readonly operation: OperationRef,
        public readonly target: string,
        public readonly packageId: PackageId,
        public readonly version: SemVer,
        public readonly manifestDigest: Digest,
        public readonly descriptorDigest: Digest,
        public readonly configurationDigest: Digest,
        public readonly runtimeDigest: Digest,
        public readonly activationGeneration: string,
        public readonly registration: string,
        public readonly impact: Impact,
        public readonly approvalRequired: boolean,
        public readonly placement: InvocationPlacementPin
    ) {
        for (const [value, subject] of [
            [target, "Operation target"],
            [packageId.value, "Package pin"],
            [version.toString(), "Package version"],
            [activationGeneration, "Activation generation"],
            [registration, "Operation registration"]
        ] as const)
            requireCanonicalText(value, subject);
        requireImpact(impact);
        if (typeof approvalRequired !== "boolean") {
            throw new TypeError("Operation approval requirement must be boolean");
        }
        for (const digest of [manifestDigest, descriptorDigest, configurationDigest, runtimeDigest])
            Object.freeze(digest);
        Object.freeze(this);
    }

    public static create(init: OperationPinInit): OperationPin {
        return new OperationPin(
            init.operation,
            init.target,
            init.package,
            init.version,
            init.manifestDigest,
            init.descriptorDigest,
            init.configurationDigest,
            init.runtimeDigest,
            init.activationGeneration,
            init.registration,
            init.impact,
            init.approvalRequired,
            init.placement
        );
    }

    public toData(): JsonValue {
        return {
            activationGeneration: this.activationGeneration,
            approvalRequired: this.approvalRequired,
            configurationDigest: this.configurationDigest.value,
            descriptorDigest: this.descriptorDigest.value,
            impact: this.impact,
            manifestDigest: this.manifestDigest.value,
            operation: this.operation.value,
            package: this.packageId.value,
            placement: this.placement.toData(),
            registration: this.registration,
            runtimeDigest: this.runtimeDigest.value,
            target: this.target,
            version: this.version.toString()
        };
    }

    public static fromData(value: JsonValue): OperationPin {
        const object = requireExactObject(
            value,
            [
                "activationGeneration",
                "approvalRequired",
                "configurationDigest",
                "descriptorDigest",
                "impact",
                "manifestDigest",
                "operation",
                "package",
                "placement",
                "registration",
                "runtimeDigest",
                "target",
                "version"
            ],
            "Operation pin"
        );
        return new OperationPin(
            new OperationRef(requireString(object, "operation")),
            requireString(object, "target"),
            new PackageId(requireString(object, "package")),
            new SemVer(requireString(object, "version")),
            requireDigest(object, "manifestDigest"),
            requireDigest(object, "descriptorDigest"),
            requireDigest(object, "configurationDigest"),
            requireDigest(object, "runtimeDigest"),
            requireString(object, "activationGeneration"),
            requireString(object, "registration"),
            requireImpact(requireString(object, "impact")),
            requireBoolean(object["approvalRequired"]),
            InvocationPlacementPin.fromData(object["placement"]!)
        );
    }
}

function canonicalModes(
    values: readonly IsolationMode[],
    subject: string
): readonly IsolationMode[] {
    if (values.length === 0 || new Set(values).size !== values.length) {
        throw new TypeError(`${subject} placement modes must be nonempty and unique`);
    }
    for (const value of values) requireMode(value);
    return Object.freeze(MODES.filter((mode) => values.includes(mode)));
}

function decodeModes(values: readonly JsonValue[]): readonly IsolationMode[] {
    return values.map((value) => requireMode(typeof value === "string" ? value : ""));
}

function requireMode(value: string): IsolationMode {
    if (!MODES.includes(value as IsolationMode)) throw new TypeError("Isolation mode is invalid");
    return value as IsolationMode;
}

function requireImpact(value: string): Impact {
    if (!IMPACTS.includes(value as Impact)) throw new TypeError("Operation impact is invalid");
    return value as Impact;
}

function requireBoolean(value: JsonValue | undefined): boolean {
    if (typeof value !== "boolean") throw new TypeError("Approval requirement must be boolean");
    return value;
}

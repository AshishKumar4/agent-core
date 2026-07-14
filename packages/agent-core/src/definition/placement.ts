import { RecordCodec, hasExactJsonKeys, type JsonValue } from "../core";
import type { IsolationMode } from "../facets";
import { AgentCoreError } from "../errors";

export const PLACEMENT_PREFERENCE: readonly IsolationMode[] = Object.freeze([
    "dynamic",
    "provider",
    "bundled"
]);

export type NonemptyIsolationModes = readonly [IsolationMode, ...IsolationMode[]];
export type PlacementErrorCode = "operation.invalid-input";

export class PlacementUnavailableError extends AgentCoreError {
    public constructor(message: string) {
        super("operation.invalid-input", message);
        this.name = "PlacementUnavailableError";
    }
}

class PlacementPolicyCodec extends RecordCodec<PlacementPolicy> {
    public constructor() {
        super("definition.placement-policy", { major: 1, minor: 0 });
    }

    protected encodePayload(policy: PlacementPolicy): JsonValue {
        return policy.toData();
    }

    protected decodePayload(payload: JsonValue): PlacementPolicy {
        return PlacementPolicy.fromData(payload);
    }
}

export class PlacementPolicy {
    public static readonly codec: RecordCodec<PlacementPolicy> = new PlacementPolicyCodec();
    public readonly allowed: NonemptyIsolationModes;

    public constructor(allowed: readonly IsolationMode[]) {
        this.allowed = canonicalModes(allowed, "Placement policy");
        Object.freeze(this);
    }

    public static all(): PlacementPolicy {
        return allPlacementPolicy;
    }

    public static encode(policy: PlacementPolicy): Uint8Array {
        return PlacementPolicy.codec.encode(policy);
    }

    public static decode(bytes: Uint8Array): PlacementPolicy {
        return PlacementPolicy.codec.decode(bytes);
    }

    public static fromData(payload: JsonValue): PlacementPolicy {
        const object = requireObject(payload, "Placement policy");
        if (!hasExactJsonKeys(object, ["allowed"])) {
            throw new TypeError("Placement policy contains missing or unknown fields");
        }
        return new PlacementPolicy(requireModeArray(object["allowed"], "Placement policy modes"));
    }

    public admits(mode: IsolationMode): boolean {
        return this.allowed.includes(mode);
    }

    public toData(): JsonValue {
        return { allowed: this.allowed };
    }
}

export interface PlacementInputInit {
    readonly manifest: readonly IsolationMode[];
    readonly policy: readonly IsolationMode[];
    readonly substrate: readonly IsolationMode[];
    readonly trust: readonly IsolationMode[];
}

export class PlacementInput {
    public readonly manifest: NonemptyIsolationModes;
    public readonly policy: NonemptyIsolationModes;
    public readonly substrate: NonemptyIsolationModes;
    public readonly trust: NonemptyIsolationModes;

    public constructor(init: PlacementInputInit) {
        this.manifest = canonicalModes(init.manifest, "Manifest placement source");
        this.policy = canonicalModes(init.policy, "Policy placement source");
        this.substrate = canonicalModes(init.substrate, "Substrate placement source");
        this.trust = canonicalModes(init.trust, "Trust placement source");
        Object.freeze(this);
    }
}

export class PlacementSelection {
    public readonly manifest: NonemptyIsolationModes;
    public readonly policy: NonemptyIsolationModes;
    public readonly substrate: NonemptyIsolationModes;
    public readonly trust: NonemptyIsolationModes;

    public constructor(
        input: PlacementInput,
        public readonly selected: IsolationMode
    ) {
        if (
            !input.manifest.includes(selected) ||
            !input.policy.includes(selected) ||
            !input.substrate.includes(selected) ||
            !input.trust.includes(selected)
        ) {
            throw new TypeError("Selected placement must belong to every admissible source");
        }
        this.manifest = input.manifest;
        this.policy = input.policy;
        this.substrate = input.substrate;
        this.trust = input.trust;
        Object.freeze(this);
    }
}

export function selectPlacement(input: PlacementInput | PlacementInputInit): PlacementSelection {
    const recorded = input instanceof PlacementInput ? input : new PlacementInput(input);
    const selected = PLACEMENT_PREFERENCE.find(
        (mode) =>
            recorded.manifest.includes(mode) &&
            recorded.policy.includes(mode) &&
            recorded.substrate.includes(mode) &&
            recorded.trust.includes(mode)
    );
    if (selected === undefined) {
        throw new PlacementUnavailableError(
            "No isolation mode is admitted by every placement source"
        );
    }
    return new PlacementSelection(recorded, selected);
}

export function trustPlacementModes(trustedPackage: boolean): NonemptyIsolationModes {
    return trustedPackage ? trustedPlacementModes : untrustedPlacementModes;
}

function canonicalModes(modes: readonly IsolationMode[], subject: string): NonemptyIsolationModes {
    if (modes.length === 0) {
        throw new PlacementUnavailableError(`${subject} must not be empty`);
    }
    if (modes.some((mode) => !PLACEMENT_PREFERENCE.includes(mode))) {
        throw new TypeError(`${subject} contains an unknown isolation mode`);
    }
    if (new Set(modes).size !== modes.length) {
        throw new TypeError(`${subject} modes must be unique`);
    }
    return Object.freeze(
        PLACEMENT_PREFERENCE.filter((mode) => modes.includes(mode))
    ) as NonemptyIsolationModes;
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireModeArray(value: JsonValue | undefined, subject: string): readonly IsolationMode[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value.map((mode) => requireMode(mode, subject));
}

function requireMode(value: JsonValue, subject: string): IsolationMode {
    if (value === "dynamic" || value === "provider" || value === "bundled") {
        return value;
    }
    throw new TypeError(`${subject} contains an unknown isolation mode`);
}

const trustedPlacementModes = Object.freeze([...PLACEMENT_PREFERENCE]) as NonemptyIsolationModes;
const untrustedPlacementModes = Object.freeze(["dynamic", "provider"] as const);
const allPlacementPolicy = new PlacementPolicy(PLACEMENT_PREFERENCE);

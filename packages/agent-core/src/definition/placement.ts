import { RecordCodec, hasExactJsonKeys, isJsonObject, isMember, type JsonValue } from "../core";
import {
    AuthoredCodeBackingPolicy,
    PLACEMENT_PREFERENCE,
    type AuthoredCodeBackingId,
    type AuthoredCodeConsumer,
    type IsolationMode
} from "../facets";
import { AgentCoreError } from "../errors";
import type { PackageId } from "./id";
import { compareText } from "./order";

// The vocabulary and its preference order are declared once, in facets/manifest.ts
// beside the IsolationMode type itself; re-exported here so existing importers of
// definition's PLACEMENT_PREFERENCE are unaffected. The consumer → backing declaration
// this record now carries (SPEC §4.7) lives beside the §4.7 shape for the same reason.
export { PLACEMENT_PREFERENCE, AuthoredCodeBackingPolicy };
export type { AuthoredCodeConsumer };

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
        super("definition.placement-policy", { major: 2, minor: 1 });
    }

    protected encodePayload(policy: PlacementPolicy): JsonValue {
        return policy.toData();
    }

    protected decodePayload(payload: JsonValue): PlacementPolicy {
        return PlacementPolicy.fromData(payload);
    }
}

// Matches "core.*" against a PackageId the way SPEC §9.2's example intends: '*' is a
// wildcard for any sequence of characters, the rest of the pattern is literal, and the
// match covers the package's whole id (no partial/substring matches).
function globMatches(pattern: string, value: string): boolean {
    const escaped = pattern
        .split("*")
        .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*");
    return new RegExp(`^${escaped}$`, "u").test(value);
}

export class PlacementPolicy {
    public static readonly codec: RecordCodec<PlacementPolicy> = new PlacementPolicyCodec();
    public readonly allowed: NonemptyIsolationModes;
    // Package-name globs admitted to the trust set (SPEC §9.2 policies.placement.trusted).
    // Defaults to "everything" so callers that only care about `allowed` (most tests, and
    // PlacementPolicy.all()) are unaffected; a Blueprint parsed from data always states
    // this explicitly (see fromData), so no platform silently inherits a permissive default.
    public readonly trusted: readonly string[];
    // Which backing serves which §4.7 consumer. Partial by design: an unnamed consumer
    // falls back to the substrate profile's declared default, which is why this record
    // needs no "everything" default of its own.
    public readonly backings: AuthoredCodeBackingPolicy;

    public constructor(
        allowed: readonly IsolationMode[],
        trusted: readonly string[] = ["*"],
        backings: AuthoredCodeBackingPolicy = AuthoredCodeBackingPolicy.unmapped
    ) {
        this.allowed = canonicalModes(allowed, "Placement policy");
        this.trusted = canonicalGlobs(trusted);
        if (!(backings instanceof AuthoredCodeBackingPolicy)) {
            throw new TypeError("Placement policy backings must be a backing policy");
        }
        this.backings = backings;
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
        // `backings` is additive and optional on read: a Blueprint that maps no §4.7
        // consumer is a complete statement, because §4.7 sends every unmapped consumer
        // to the profile's declared default. That is a defined fallback rather than a
        // permissive one, so unlike `trusted` it needs no explicit declaration.
        if (
            !hasExactJsonKeys(object, ["allowed", "trusted"]) &&
            !hasExactJsonKeys(object, ["allowed", "backings", "trusted"])
        ) {
            throw new TypeError("Placement policy contains missing or unknown fields");
        }
        return new PlacementPolicy(
            requireModeArray(object["allowed"], "Placement policy modes"),
            requireGlobArray(object["trusted"], "Placement policy trust pattern"),
            AuthoredCodeBackingPolicy.fromData(object["backings"])
        );
    }

    public admits(mode: IsolationMode): boolean {
        return this.allowed.includes(mode);
    }

    // SPEC §9.2 / C13-PLACEMENT-UNTRUSTED-BUNDLED: a Package is trusted exactly when its
    // id matches one of the configured glob patterns.
    public trusts(packageId: PackageId): boolean {
        return this.trusted.some((pattern) => globMatches(pattern, packageId.value));
    }

    public trustedModes(packageId: PackageId): NonemptyIsolationModes {
        return trustPlacementModes(this.trusts(packageId));
    }

    // The backing that serves `consumer` under this declaration, falling back to the
    // substrate profile's declared default (SPEC §4.7).
    public backingFor(
        consumer: AuthoredCodeConsumer,
        profileDefault: AuthoredCodeBackingId
    ): AuthoredCodeBackingId {
        return this.backings.backingFor(consumer, profileDefault);
    }

    public toData(): JsonValue {
        return {
            allowed: this.allowed,
            ...(this.backings.isEmpty ? {} : { backings: this.backings.toData() }),
            trusted: this.trusted
        };
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

// The single implementation of the four-set admissible intersection (SPEC §9.2):
// the first mode, in preference order, admitted by every one of the four sources.
// selectPlacement uses it to compute a fresh selection; a Pin re-derives it to
// check a previously recorded selection still matches the canonical algorithm.
export function preferredPlacement(
    manifest: readonly IsolationMode[],
    policy: readonly IsolationMode[],
    substrate: readonly IsolationMode[],
    trust: readonly IsolationMode[]
): IsolationMode | undefined {
    return PLACEMENT_PREFERENCE.find(
        (mode) =>
            manifest.includes(mode) &&
            policy.includes(mode) &&
            substrate.includes(mode) &&
            trust.includes(mode)
    );
}

export function selectPlacement(input: PlacementInput | PlacementInputInit): PlacementSelection {
    const recorded = input instanceof PlacementInput ? input : new PlacementInput(input);
    const selected = preferredPlacement(
        recorded.manifest,
        recorded.policy,
        recorded.substrate,
        recorded.trust
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

function canonicalGlobs(patterns: readonly string[]): readonly string[] {
    for (const pattern of patterns) requireGlob(pattern, "Placement policy trust pattern");
    if (new Set(patterns).size !== patterns.length) {
        throw new TypeError("Placement policy trust patterns must be unique");
    }
    return Object.freeze([...patterns].sort(compareText));
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
    return value;
}

function requireGlobArray(value: JsonValue | undefined, subject: string): readonly string[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value.map((pattern) => requireGlob(pattern, subject));
}

function requireGlob(value: JsonValue, subject: string): string {
    if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
    return value;
}

function requireModeArray(value: JsonValue | undefined, subject: string): readonly IsolationMode[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value.map((mode) => requireMode(mode, subject));
}

function requireMode(value: JsonValue, subject: string): IsolationMode {
    if (isMember(PLACEMENT_PREFERENCE, value)) {
        return value;
    }
    throw new TypeError(`${subject} contains an unknown isolation mode`);
}

const trustedPlacementModes = Object.freeze([...PLACEMENT_PREFERENCE]) as NonemptyIsolationModes;
const untrustedPlacementModes = Object.freeze(["dynamic", "provider"] as const);
const allPlacementPolicy = new PlacementPolicy(PLACEMENT_PREFERENCE);

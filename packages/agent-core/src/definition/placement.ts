import {
    RecordCodec,
    hasExactJsonKeys,
    isJsonObject,
    isMember,
    requireNonempty,
    TextId,
    type JsonObject,
    type JsonValue
} from "../core";
import {
    AuthoredCodeBackingId,
    PLACEMENT_PREFERENCE,
    matchesGlob,
    preferredPlacement as servedPlacement,
    requireAuthoredCodeConsumer,
    type AuthoredCodeConsumer,
    type IsolationMode
} from "../facets";
import { AgentCoreError } from "../errors";
import type { PackageId } from "./id";
import { compareText } from "./order";

// The vocabulary and its preference order are declared once, in facets/manifest.ts
// beside the IsolationMode type itself; re-exported here so existing importers of
// definition's PLACEMENT_PREFERENCE are unaffected. The §4.7 consumer set and backing
// identifier live there for the same reason; the policy that maps between them is a
// §9.2 Blueprint declaration and so lives here, beside PlacementPolicy itself.
export { PLACEMENT_PREFERENCE, AuthoredCodeBackingId };
export type { AuthoredCodeConsumer };

/**
 * Which backing serves which §4.7 consumer, as `policies.placement` declares it
 * (§9.2). The mapping is partial on purpose: a consumer the Blueprint does not name
 * uses the substrate profile's declared default backing rather than an arbitrary one.
 * Backings differ operationally and never in authority, so this record is a hosting
 * choice and carries no capability.
 */
export class AuthoredCodeBackingPolicy {
    readonly #backings: ReadonlyMap<AuthoredCodeConsumer, AuthoredCodeBackingId>;

    public constructor(backings: ReadonlyMap<AuthoredCodeConsumer, AuthoredCodeBackingId>) {
        // The consumer set and the identifier type are proved by the constructor's own
        // signature; `fromData` is the one place an unproved key or value can arrive,
        // and it validates there rather than here.
        this.#backings = new Map([...backings].sort(([left], [right]) => compareText(left, right)));
        Object.freeze(this);
    }

    public static get unmapped(): AuthoredCodeBackingPolicy {
        return unmappedBackingPolicy;
    }

    public static fromData(payload: JsonValue | undefined): AuthoredCodeBackingPolicy {
        if (payload === undefined) return unmappedBackingPolicy;
        const object = requireObject(payload, "Agent-authored code backing policy");
        return new AuthoredCodeBackingPolicy(
            new Map(
                Object.entries(object).map(([consumer, backing]) => [
                    requireAuthoredCodeConsumer(consumer, "Agent-authored code backing consumer"),
                    new AuthoredCodeBackingId(
                        requireCanonicalString(
                            backing,
                            `Agent-authored code backing for ${consumer}`
                        )
                    )
                ])
            )
        );
    }

    /**
     * The backing that serves `consumer`: the declared mapping when the Blueprint names
     * one, and otherwise the profile's declared default. There is no third outcome —
     * an unmapped consumer never reaches an arbitrary offered backing.
     */
    public backingFor(
        consumer: AuthoredCodeConsumer,
        profileDefault: AuthoredCodeBackingId
    ): AuthoredCodeBackingId {
        return this.#backings.get(consumer) ?? profileDefault;
    }

    public get isEmpty(): boolean {
        return this.#backings.size === 0;
    }

    public get consumers(): readonly AuthoredCodeConsumer[] {
        return Object.freeze([...this.#backings.keys()]);
    }

    public toData(): JsonValue {
        return Object.fromEntries(
            [...this.#backings].map(([consumer, backing]) => [consumer, backing.value] as const)
        );
    }
}

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
        super(
            [PlacementPolicy, AuthoredCodeBackingPolicy, AuthoredCodeBackingId, TextId],
            "definition.placement-policy",
            {
                major: 2,
                minor: 1
            }
        );
    }

    protected encodePayload(policy: PlacementPolicy): JsonValue {
        return policy.toData();
    }

    protected decodePayload(payload: JsonValue): PlacementPolicy {
        return PlacementPolicy.fromData(payload);
    }
}

export class PlacementPolicy {
    public static get codec(): RecordCodec<PlacementPolicy> {
        return placementPolicyCodecInstance;
    }
    public readonly allowed: NonemptyIsolationModes;
    // Package-name globs admitted to the trust set (SPEC §9.2 policies.placement.trusted).
    // The trust globs are required at construction — exactly as the wire form requires
    // them — so no caller silently inherits a permissive trust set: a PlacementPolicy
    // built without one is a construction error, not a policy (C13-PLACEMENT-
    // UNTRUSTED-BUNDLED: the trust set excludes `bundled` for every Package no glob
    // matches, and an implicit `*` would admit every Package instead).
    public readonly trusted: readonly string[];
    // Which backing serves which §4.7 consumer. Partial by design: an unnamed consumer
    // falls back to the substrate profile's declared default, which is why this record
    // needs no "everything" default of its own.
    public readonly backings: AuthoredCodeBackingPolicy;

    public constructor(
        allowed: readonly IsolationMode[],
        trusted: readonly string[],
        backings: AuthoredCodeBackingPolicy = AuthoredCodeBackingPolicy.unmapped
    ) {
        this.allowed = canonicalModes(allowed, "Placement policy");
        if (!Array.isArray(trusted)) {
            throw new TypeError("Placement policy trust patterns must be an array");
        }
        this.trusted = canonicalGlobs(trusted);
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
        return this.trusted.some((pattern) => matchesGlob(pattern, packageId.value));
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
        let data: JsonObject = {
            allowed: this.allowed,
            trusted: this.trusted
        };
        if (!this.backings.isEmpty) data = { ...data, backings: this.backings.toData() };
        return data;
    }
}

const placementPolicyCodecInstance = new PlacementPolicyCodec();

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

// SPEC §9.2's four-set admissible intersection: the first mode, in preference order,
// admitted by every one of the four sources. The decision itself is lowered from
// `formal/AgentCore/Extract/Placement.lean` and re-exported through `../facets`; what is
// written here is only the shape conversion, because the lowering answers with the
// admitted fragment's `Option` and this context's callers answer absence with `undefined`.
// selectPlacement uses it to compute a fresh selection; a Pin re-derives it to check a
// previously recorded selection still matches the canonical algorithm.
export function preferredPlacement(
    manifest: readonly IsolationMode[],
    policy: readonly IsolationMode[],
    substrate: readonly IsolationMode[],
    trust: readonly IsolationMode[]
): IsolationMode | undefined {
    const served = servedPlacement(manifest, policy, substrate, trust);
    return served.kind === "some" ? served.value : undefined;
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
    const snapshot = [...modes];
    if (snapshot.length === 0) {
        throw new PlacementUnavailableError(`${subject} must not be empty`);
    }
    if (snapshot.some((mode) => !PLACEMENT_PREFERENCE.includes(mode))) {
        throw new TypeError(`${subject} contains an unknown isolation mode`);
    }
    if (new Set(snapshot).size !== snapshot.length) {
        throw new TypeError(`${subject} modes must be unique`);
    }
    const canonical = PLACEMENT_PREFERENCE.filter((mode) => snapshot.includes(mode));
    return Object.freeze(requireNonempty(canonical, subject));
}

function canonicalGlobs(patterns: readonly string[]): readonly string[] {
    for (const pattern of patterns) {
        requireCanonicalString(pattern, "Placement policy trust pattern");
    }
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
    return value.map((pattern) => requireCanonicalString(pattern, subject));
}

// Nonblank, already-canonical text: a trust glob and a backing identifier are both
// exactly that, and neither is normalized on the caller's behalf.
function requireCanonicalString(value: JsonValue, subject: string): string {
    if (!isStringValue(value) || value.length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
    return value;
}

function isStringValue(value: JsonValue): value is string {
    return typeof value === "string";
}

function requireModeArray(value: JsonValue | undefined, subject: string): readonly IsolationMode[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value.map((mode) => parseIsolationMode(mode, subject));
}

export function parseIsolationMode(value: JsonValue, subject: string): IsolationMode {
    if (isMember(PLACEMENT_PREFERENCE, value)) {
        return value;
    }
    throw new TypeError(`${subject} contains an unknown isolation mode`);
}

const trustedPlacementModes = Object.freeze(
    requireNonempty([...PLACEMENT_PREFERENCE], "Placement")
);
const untrustedPlacementModes = Object.freeze(["dynamic", "provider"] as const);
const unmappedBackingPolicy = new AuthoredCodeBackingPolicy(new Map());
// The all-trusting singleton is the one place that states "every Package is trusted for
// bundled placement" (SPEC §9.2 policies.placement.trusted `["*"]`), so a reader looking
// for who admitted everything finds it here and nowhere else.
const allPlacementPolicy = new PlacementPolicy(PLACEMENT_PREFERENCE, ["*"]);

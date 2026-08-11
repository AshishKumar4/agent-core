import { hasExactJsonKeys, type JsonValue } from "../core";
import { Automation, type IsolationMode } from "../facets";
import { AgentCoreError } from "../errors";
import { invalidDefinition } from "./error";
import { PlacementInput, selectPlacement } from "./placement";
import { PolicySet } from "./policy";

type MaterializationKindValidator = (desired: JsonValue) => JsonValue;

/**
 * Named so the stored-record decode path can tell "this build does not know this
 * materialization kind" (forward compatible; the store may be reset and rebuilt) from
 * "these bytes are corrupt". Both surface as codec.invalid, so a substring test on the
 * message was the only thing carrying the distinction -- and RecordCodec.decode wraps a
 * TypeError into a new message, so that test survived only by textual coincidence. An
 * AgentCoreError subclass is rethrown by that wrapper unchanged.
 */
export class UnsupportedMaterializationKindError extends AgentCoreError {
    public constructor(recordKind: string) {
        super("codec.invalid", `Unsupported materialization record kind ${recordKind}`);
        this.name = "UnsupportedMaterializationKindError";
    }
}

const materializationKinds: Readonly<Record<string, MaterializationKindValidator>> = Object.freeze({
    "agent-profile": declarationMapValidator("Agent profile"),
    environment: declarationMapValidator("Environment"),
    "facet-install": validateFacetInstall,
    "facet-placement": validateFacetPlacement,
    "policy-set": (desired) => PolicySet.fromData(desired).toData(),
    "scope-scaffold": declarationMapValidator("Scope scaffold"),
    "slot-entry": validateSlotEntry,
    subscription: (desired) => Automation.fromData(desired).toData(),
    "surface-layout": declarationMapValidator("Surface layout")
});
const materializationKindNames: readonly string[] = Object.freeze(
    Object.keys(materializationKinds)
);

export function supportedMaterializationKinds(): readonly string[] {
    return materializationKindNames;
}

export function requireMaterializationKind(recordKind: string): void {
    requireMaterializationKindValidator(recordKind);
}

export function validateMaterializationKind(recordKind: string, desired: JsonValue): void {
    requireMaterializationKindValidator(recordKind)(desired);
}

export function canonicalMaterializationDesired(recordKind: string, desired: JsonValue): JsonValue {
    return requireMaterializationKindValidator(recordKind)(desired);
}

function requireMaterializationKindValidator(recordKind: string): MaterializationKindValidator {
    if (typeof recordKind !== "string" || !Object.hasOwn(materializationKinds, recordKind)) {
        throw new UnsupportedMaterializationKindError(recordKind);
    }
    return materializationKinds[recordKind]!;
}

function validateFacetPlacement(desired: JsonValue): JsonValue {
    const object = requireObject(desired, "Facet placement");
    if (
        !hasExactJsonKeys(object, ["facet", "manifest", "policy", "selected", "substrate", "trust"])
    ) {
        throw new TypeError("Facet placement contains missing or unknown fields");
    }
    requireCanonicalName(object["facet"], "Placement facet");
    const input = new PlacementInput({
        manifest: requireModes(object["manifest"], "Manifest placement source"),
        policy: requireModes(object["policy"], "Policy placement source"),
        substrate: requireModes(object["substrate"], "Substrate placement source"),
        trust: requireModes(object["trust"], "Trust placement source")
    });
    requireCanonicalModes(object["manifest"], input.manifest, "Manifest placement source");
    requireCanonicalModes(object["policy"], input.policy, "Policy placement source");
    requireCanonicalModes(object["substrate"], input.substrate, "Substrate placement source");
    requireCanonicalModes(object["trust"], input.trust, "Trust placement source");
    if (selectPlacement(input).selected !== object["selected"]) {
        throw new TypeError(
            "Facet placement selection does not match its four-source intersection"
        );
    }
    return desired;
}

function validateFacetInstall(desired: JsonValue): JsonValue {
    const object = requireObject(desired, "Facet install");
    if (!hasExactJsonKeys(object, ["facetId", "facetVersion", "packageId"])) {
        throw new TypeError("Facet install contains missing or unknown fields");
    }
    requireCanonicalName(object["facetId"], "Facet install facet ID");
    requireCanonicalName(object["facetVersion"], "Facet install facet version");
    requireCanonicalName(object["packageId"], "Facet install package ID");
    return desired;
}

function validateSlotEntry(desired: JsonValue): JsonValue {
    const object = requireObject(desired, "Slot entry");
    if (!hasExactJsonKeys(object, ["contributor", "index", "slot", "value"])) {
        throw new TypeError("Slot entry contains missing or unknown fields");
    }
    requireCanonicalName(object["contributor"], "Slot entry contributor");
    requireCanonicalName(object["slot"], "Slot entry slot");
    requireNonnegativeInteger(object["index"], "Slot entry index");
    return desired;
}

function declarationMapValidator(subject: string): MaterializationKindValidator {
    return (desired) => {
        const object = requireObject(desired, subject);
        if (Object.keys(object).length === 0) {
            throw invalidDefinition(`${subject} declaration must not be empty`);
        }
        return desired;
    };
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireCanonicalName(value: JsonValue | undefined, subject: string): void {
    if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be a nonblank canonical string`);
    }
}

function requireNonnegativeInteger(value: JsonValue | undefined, subject: string): void {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
}

function requireModes(value: JsonValue | undefined, subject: string): readonly IsolationMode[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array`);
    }
    return value as unknown as readonly IsolationMode[];
}

function requireCanonicalModes(
    value: JsonValue | undefined,
    canonical: readonly IsolationMode[],
    subject: string
): void {
    if (
        !Array.isArray(value) ||
        value.length !== canonical.length ||
        value.some((mode, index) => mode !== canonical[index])
    ) {
        throw new TypeError(`${subject} must use canonical placement order`);
    }
}

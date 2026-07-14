import { hasExactJsonKeys, type JsonValue } from "../core";
import type { IsolationMode } from "../facets";
import { PlacementInput, selectPlacement } from "./placement";
import { PolicySet } from "./policy";

type MaterializationKindValidator = (desired: JsonValue) => JsonValue;

const materializationKinds: Readonly<Record<string, MaterializationKindValidator>> = Object.freeze({
    "facet-placement": validateFacetPlacement,
    "policy-set": (desired) => {
        return PolicySet.fromData(desired).toData();
    }
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
        throw new TypeError(`Unsupported materialization record kind ${recordKind}`);
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

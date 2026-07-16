// @ts-nocheck
import { CompatRange, JsonSchema, SemVer } from "../core";
import type { FacetData } from "./data";
import {
    DataRecordCodec,
    compareText,
    requireArray,
    requireDataObject,
    requireExactFields,
    requireString
} from "./data";
import { Contributions } from "./contribution";
import { BindingName, FacetPackageId } from "./id";

export type IsolationMode = "dynamic" | "provider" | "bundled";

const isolationPreference: readonly IsolationMode[] = ["dynamic", "provider", "bundled"];

export class BindingRequirement {
    public constructor(
        public readonly name: BindingName,
        public readonly facet: FacetPackageId,
        public readonly compat: CompatRange
    ) {
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): BindingRequirement {
        const object = requireDataObject(payload, "Binding requirement");
        requireExactFields(object, ["compat", "facet", "name"]);
        const compat = requireDataObject(object["compat"]!, "Binding compatibility range");
        requireExactFields(compat, ["host", "spec"]);
        return new BindingRequirement(
            new BindingName(requireString(object["name"], "Binding name")),
            new FacetPackageId(requireString(object["facet"], "Binding facet")),
            new CompatRange(
                requireString(compat["spec"], "Binding spec compatibility"),
                requireString(compat["host"], "Binding host compatibility")
            )
        );
    }

    public static encode(requirement: BindingRequirement): Uint8Array {
        return bindingRequirementCodec.encode(requirement);
    }

    public static decode(bytes: Uint8Array): BindingRequirement {
        return bindingRequirementCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            compat: { host: this.compat.host, spec: this.compat.spec },
            facet: this.facet.value,
            name: this.name.value
        };
    }
}

const bindingRequirementCodec = new DataRecordCodec(
    "facet.binding-requirement",
    (requirement: BindingRequirement) => requirement.toData(),
    (payload) => BindingRequirement.fromData(payload)
);

export interface FacetManifestInit {
    readonly id: FacetPackageId;
    readonly version: SemVer;
    readonly compat: CompatRange;
    readonly isolation: readonly [IsolationMode, ...IsolationMode[]];
    readonly bindings: readonly BindingRequirement[];
    readonly configSchema?: JsonSchema;
    readonly contributions: Contributions;
}

export class FacetManifest {
    public readonly id: FacetPackageId;
    public readonly version: SemVer;
    public readonly compat: CompatRange;
    public readonly isolation: readonly [IsolationMode, ...IsolationMode[]];
    public readonly bindings: readonly BindingRequirement[];
    public readonly configSchema: JsonSchema | undefined;
    public readonly contributions: Contributions;

    public constructor(init: FacetManifestInit) {
        const bindings = [...init.bindings].sort((left, right) =>
            compareText(left.name.value, right.name.value)
        );
        if (new Set(bindings.map((binding) => binding.name.value)).size !== bindings.length) {
            throw new TypeError("Manifest binding names must be unique");
        }
        this.id = init.id;
        this.version = init.version;
        this.compat = init.compat;
        this.isolation = canonicalIsolationModes(init.isolation);
        this.bindings = Object.freeze(bindings);
        this.configSchema = init.configSchema;
        this.contributions = init.contributions;
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): FacetManifest {
        const object = requireDataObject(payload, "Facet manifest");
        requireExactFields(
            object,
            ["bindings", "compat", "contributions", "id", "isolation", "version"],
            ["configSchema"]
        );
        const compat = requireDataObject(object["compat"]!, "Manifest compatibility range");
        requireExactFields(compat, ["host", "spec"]);
        const isolation = requireArray(object["isolation"], "Manifest isolation modes").map(
            requireIsolationMode
        );
        if (isolation.length === 0) {
            throw new TypeError("Manifest isolation modes must not be empty");
        }
        const configSchema = object["configSchema"];
        const decodedConfigSchema =
            configSchema === undefined
                ? undefined
                : new JsonSchema(requireSchemaDocument(configSchema));
        return new FacetManifest({
            id: new FacetPackageId(requireString(object["id"], "Facet package ID")),
            version: new SemVer(requireString(object["version"], "Facet version")),
            compat: new CompatRange(
                requireString(compat["spec"], "Manifest spec compatibility"),
                requireString(compat["host"], "Manifest host compatibility")
            ),
            isolation: isolation as [IsolationMode, ...IsolationMode[]],
            bindings: requireArray(object["bindings"], "Manifest bindings").map(
                BindingRequirement.fromData
            ),
            contributions: Contributions.fromMap(requireContributionMap(object["contributions"])),
            ...(decodedConfigSchema === undefined ? {} : { configSchema: decodedConfigSchema })
        });
    }

    public static encode(manifest: FacetManifest): Uint8Array {
        return facetManifestCodec.encode(manifest);
    }

    public static decode(bytes: Uint8Array): FacetManifest {
        return facetManifestCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            bindings: this.bindings.map((binding) => binding.toData()),
            compat: { host: this.compat.host, spec: this.compat.spec },
            contributions: this.contributions.toData(),
            id: this.id.value,
            isolation: this.isolation,
            version: this.version.toString(),
            ...(this.configSchema === undefined ? {} : { configSchema: this.configSchema.document })
        };
    }
}

function requireContributionMap(
    value: FacetData | undefined
): Readonly<Record<string, readonly FacetData[]>> {
    const object = requireDataObject(value ?? null, "Manifest contributions");
    return Object.fromEntries(
        Object.entries(object).map(([slot, entries]) => [
            slot,
            requireArray(entries, `Manifest contribution ${slot}`)
        ])
    );
}

const facetManifestCodec = new DataRecordCodec(
    "facet.manifest",
    (manifest: FacetManifest) => manifest.toData(),
    (payload) => FacetManifest.fromData(payload),
    { major: 2, minor: 0 }
);

export function canonicalIsolationModes(
    modes: readonly [IsolationMode, ...IsolationMode[]]
): readonly [IsolationMode, ...IsolationMode[]] {
    if (modes.length === 0 || modes.some((mode) => !isolationPreference.includes(mode))) {
        throw new TypeError("Manifest isolation modes must contain known values");
    }
    if (new Set(modes).size !== modes.length) {
        throw new TypeError("Manifest isolation modes must be unique");
    }
    const ordered = isolationPreference.filter((mode) => modes.includes(mode));
    return Object.freeze(ordered) as unknown as readonly [IsolationMode, ...IsolationMode[]];
}

function requireIsolationMode(value: FacetData): IsolationMode {
    if (value === "dynamic" || value === "provider" || value === "bundled") {
        return value;
    }
    throw new TypeError("Manifest isolation mode is invalid");
}

function requireSchemaDocument(value: FacetData): boolean | { readonly [key: string]: FacetData } {
    if (typeof value === "boolean") {
        return value;
    }
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Manifest config schema must be an object or boolean");
    }
    return value as { readonly [key: string]: FacetData };
}

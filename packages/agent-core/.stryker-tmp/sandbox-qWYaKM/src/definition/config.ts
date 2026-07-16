// @ts-nocheck
import {
    JsonSchema,
    RecordCodec,
    SecretRef,
    decodeCanonicalJson,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";
import { SlotName, type FacetDataMap } from "../facets";
import type { PackageRelease } from "./package";
import { compareText } from "./order";

const SECRET_TAG = "$secret";
const SETTINGS_SLOT = new SlotName("settings");

export type ConfigInput =
    | null
    | boolean
    | number
    | string
    | SecretRef
    | readonly ConfigInput[]
    | { readonly [name: string]: ConfigInput };

export type ConfigInputMap = { readonly [name: string]: ConfigInput };
export type ConfigData = { readonly [name: string]: JsonValue };

export type SecretRefData = {
    readonly $secret: {
        readonly source: string;
        readonly provider: string;
        readonly id: string;
    };
};

class ConfigCodec extends RecordCodec<Config> {
    public constructor() {
        super("definition.config", { major: 1, minor: 0 });
    }

    protected encodePayload(config: Config): JsonValue {
        return { value: config.value };
    }

    protected decodePayload(payload: JsonValue): Config {
        const object = requireObject(payload, "Config payload");
        if (!hasExactJsonKeys(object, ["value"])) {
            throw new TypeError("Config payload contains missing or unknown fields");
        }
        return Config.fromData(requireObject(object["value"]!, "Config value"));
    }
}

export class Config {
    public static readonly codec: RecordCodec<Config> = new ConfigCodec();
    public readonly value: ConfigData;

    public constructor(value: ConfigInputMap) {
        this.value = canonicalConfig(value);
        Object.freeze(this);
    }

    public static empty(): Config {
        return emptyConfig;
    }

    public static encode(config: Config): Uint8Array {
        return Config.codec.encode(config);
    }

    public static decode(bytes: Uint8Array): Config {
        return Config.codec.decode(bytes);
    }

    public static fromData(value: ConfigData): Config {
        return new Config(value);
    }

    public toData(): ConfigData {
        return this.value;
    }
}

export const SECRET_REF_SCHEMA = new JsonSchema({
    additionalProperties: false,
    properties: {
        [SECRET_TAG]: {
            additionalProperties: false,
            properties: {
                id: { minLength: 1, type: "string" },
                provider: { minLength: 1, type: "string" },
                source: { minLength: 1, type: "string" }
            },
            required: ["id", "provider", "source"],
            type: "object"
        }
    },
    required: [SECRET_TAG],
    type: "object"
});

export const BASE_CONFIG_SCHEMA = new JsonSchema({ type: "object" });

export function encodeSecretRef(reference: SecretRef): SecretRefData {
    return canonicalJson({
        [SECRET_TAG]: {
            id: reference.id,
            provider: reference.provider,
            source: reference.source
        }
    }) as unknown as SecretRefData;
}

export function decodeSecretRef(value: JsonValue): SecretRef {
    const object = requireObject(value, "Secret reference");
    if (!hasExactJsonKeys(object, [SECRET_TAG])) {
        throw new TypeError("Secret reference must use the tagged representation");
    }
    const reference = requireObject(object[SECRET_TAG]!, "Secret reference value");
    if (!hasExactJsonKeys(reference, ["id", "provider", "source"])) {
        throw new TypeError("Secret reference contains missing or unknown fields");
    }
    return new SecretRef(
        requireString(reference["source"], "Secret reference source"),
        requireString(reference["provider"], "Secret reference provider"),
        requireString(reference["id"], "Secret reference ID")
    );
}

export function isSecretRefData(value: JsonValue): value is JsonValue & SecretRefData {
    try {
        decodeSecretRef(value);
        return true;
    } catch {
        return false;
    }
}

export function canonicalConfig(value: ConfigInputMap): ConfigData {
    return canonicalJson(canonicalConfigValue(value)) as ConfigData;
}

export function composeConfigSchema(
    base: JsonSchema,
    releases: readonly PackageRelease[]
): JsonSchema {
    const ordered = [...releases].sort((left, right) => compareText(left.id.value, right.id.value));
    validateUniquePackageReleases(ordered);

    const properties: Record<string, JsonValue> = {};
    for (const release of ordered) {
        const fragments = packageConfigFragments(release);
        properties[release.id.value] =
            fragments.length === 0
                ? {}
                : fragments.length === 1
                  ? fragments[0]!
                  : { allOf: fragments };
    }

    return new JsonSchema({
        allOf: [
            base.document,
            {
                additionalProperties: false,
                properties,
                required: ordered.map((release) => release.id.value),
                type: "object"
            }
        ]
    });
}

function packageConfigFragments(release: PackageRelease): JsonValue[] {
    const fragments: JsonValue[] = [];
    if (release.configSchema !== undefined) {
        fragments.push(release.configSchema.document);
    }
    for (const manifest of release.manifests) {
        if (manifest.configSchema !== undefined) {
            fragments.push(manifest.configSchema.document);
        }
        for (const fragment of manifest.contributions.get(SETTINGS_SLOT) ?? []) {
            fragments.push(requireSchemaDocument(fragment, "Settings contribution"));
        }
    }
    return fragments;
}

function canonicalConfigValue(value: ConfigInput): JsonValue {
    if (value instanceof SecretRef) {
        return encodeSecretRef(value) as unknown as JsonValue;
    }
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError("Config numbers must be finite");
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
        return value.map(canonicalConfigValue);
    }
    if (!isPlainObject(value)) {
        throw new TypeError("Config values must be canonical JSON data or SecretRef values");
    }
    if (SECRET_TAG in value) {
        const normalized = Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, canonicalConfigValue(entry)])
        ) as FacetDataMap;
        return encodeSecretRef(decodeSecretRef(normalized)) as unknown as JsonValue;
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, canonicalConfigValue(entry)])
    );
}

function validateUniquePackageReleases(releases: readonly PackageRelease[]): void {
    if (new Set(releases.map((release) => release.id.value)).size !== releases.length) {
        throw new TypeError("Config schemas require one release per package ID");
    }
}

function requireSchemaDocument(value: JsonValue, subject: string): JsonValue {
    if (typeof value === "boolean") {
        return value;
    }
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be a JSON Schema object or boolean`);
    }
    return new JsonSchema(value as { readonly [name: string]: JsonValue }).document;
}

function canonicalJson(value: JsonValue): JsonValue {
    return freezeJson(decodeCanonicalJson(encodeCanonicalJson(value)));
}

function freezeJson(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        for (const entry of value) freezeJson(entry);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) freezeJson(entry);
        return Object.freeze(value);
    }
    return value;
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

function isPlainObject(value: object): value is { readonly [name: string]: ConfigInput } {
    return Object.getPrototypeOf(value) === Object.prototype;
}

const emptyConfig = new Config({});

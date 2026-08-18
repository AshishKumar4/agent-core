import {
    JsonSchema,
    RecordCodec,
    SecretRef,
    hasExactJsonKeys,
    isJsonObject,
    type JsonValue
} from "../core";
import { SlotName } from "../facets";
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
        super([Config, SecretRef], "definition.config", { major: 1, minor: 0 });
    }

    protected encodePayload(config: Config): JsonValue {
        return { value: config.value };
    }

    protected decodePayload(payload: JsonValue): Config {
        const object = requireObject(payload, "Config payload");
        if (!hasExactJsonKeys(object, ["value"])) {
            throw new TypeError("Config payload contains missing or unknown fields");
        }
        return Config.fromData(requireObject(object["value"], "Config value"));
    }
}

export class Config {
    public static get codec(): RecordCodec<Config> {
        return configCodecInstance;
    }
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

const configCodecInstance = new ConfigCodec();

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
    const data: SecretRefData = {
        [SECRET_TAG]: {
            id: reference.id,
            provider: reference.provider,
            source: reference.source
        }
    };
    freezeJson(data);
    return data;
}

export function decodeSecretRef(value: JsonValue): SecretRef {
    const object = requireObject(value, "Secret reference");
    if (!hasExactJsonKeys(object, [SECRET_TAG])) {
        throw new TypeError("Secret reference must use the tagged representation");
    }
    const reference = requireObject(object[SECRET_TAG], "Secret reference value");
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
    const canonical = canonicalConfigMap(value);
    freezeJson(canonical);
    return canonical;
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
            fragments.length > 1
                ? { allOf: fragments }
                : fragments.reduce<JsonValue>((_empty, fragment) => fragment, {});
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
        return encodeSecretRef(value);
    }
    if (isConfigScalar(value)) {
        return value;
    }
    if (isConfigNumber(value)) {
        if (!Number.isFinite(value)) {
            throw new TypeError("Config numbers must be finite");
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (isConfigArray(value)) {
        return value.map(canonicalConfigValue);
    }
    return canonicalConfigMap(value);
}

function canonicalConfigMap(value: ConfigInputMap): ConfigData {
    if (!hasPlainConfigPrototype(value)) {
        throw new TypeError("Config values must be canonical JSON data or SecretRef values");
    }
    const normalized = Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => compareText(left, right))
            .map(([key, entry]) => [key, canonicalConfigValue(entry)])
    );
    if (SECRET_TAG in value) {
        return encodeSecretRef(decodeSecretRef(normalized));
    }
    return normalized;
}

function validateUniquePackageReleases(releases: readonly PackageRelease[]): void {
    if (new Set(releases.map((release) => release.id.value)).size !== releases.length) {
        throw new TypeError("Config schemas require one release per package ID");
    }
}

function requireSchemaDocument(value: JsonValue, subject: string): JsonValue {
    if (isBooleanSchema(value)) {
        return value;
    }
    if (!isJsonObject(value)) {
        throw new TypeError(`${subject} must be a JSON Schema object or boolean`);
    }
    return new JsonSchema(value).document;
}

function freezeJson(value: JsonValue): void {
    if (Array.isArray(value)) {
        for (const entry of value) freezeJson(entry);
        Object.freeze(value);
        return;
    }
    if (isJsonObject(value)) {
        for (const entry of Object.values(value)) freezeJson(entry);
        Object.freeze(value);
    }
}

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (!isJsonObject(value)) throw new TypeError(`${subject} must be an object`);
    return value;
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (!isStringValue(value)) {
        throw new TypeError(`${subject} must be a string`);
    }
    return value;
}

function hasPlainConfigPrototype(value: ConfigInputMap): boolean {
    return Object.getPrototypeOf(value) === Object.prototype;
}

function isConfigScalar(value: ConfigInput): value is null | boolean | string {
    return value === null || typeof value === "boolean" || typeof value === "string";
}

function isConfigNumber(value: ConfigInput): value is number {
    return typeof value === "number";
}

function isConfigArray(value: ConfigInput): value is readonly ConfigInput[] {
    return Array.isArray(value);
}

function isBooleanSchema(value: JsonValue): value is boolean {
    return typeof value === "boolean";
}

function isStringValue(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

const emptyConfig = new Config({});

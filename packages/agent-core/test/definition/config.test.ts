import { describe, expect, test } from "vitest";
import { MediaHint } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    SecretRef,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    strictJsonSchemaValidator,
    type JsonValue
} from "../../src/core";
import {
    BASE_CONFIG_SCHEMA,
    Config,
    SECRET_REF_SCHEMA,
    composeConfigSchema,
    decodeSecretRef,
    encodeSecretRef,
    isSecretRefData
} from "../../src/definition/config";
import {
    PackageCodeEntrypoint,
    PackageCodeManifest,
    PackageCodeModule
} from "../../src/definition/code-manifest";
import { PackageId } from "../../src/definition/id";
import { PackageRelease } from "../../src/definition/package";
import {
    Contribution,
    Contributions,
    FacetManifest,
    FacetPackageId,
    SlotName
} from "../../src/facets";

const encoder = new TextEncoder();

describe("Blueprint config", () => {
    test("[C13-CONFIG-SECRET-REF] [definition.config] uses one tagged SecretRef representation and round-trips canonical nested refs", () => {
        const reference = new SecretRef("tenant", "vault", "services/deploy");
        const source = {
            nested: { token: reference },
            z: 2,
            a: 1
        };
        const config = new Config(source);

        expect(config.toData()).toEqual({
            a: 1,
            nested: {
                token: {
                    $secret: {
                        id: "services/deploy",
                        provider: "vault",
                        source: "tenant"
                    }
                }
            },
            z: 2
        });
        expect(
            decodeSecretRef(encodeSecretRef(reference) as unknown as JsonValue).equals(reference)
        ).toBe(true);
        expect(isSecretRefData(encodeSecretRef(reference) as unknown as JsonValue)).toBe(true);
        expect(Config.encode(Config.decode(Config.encode(config)))).toEqual(Config.encode(config));
        expect(Object.isFrozen(config.toData().nested)).toBe(true);
    });

    test("rejects alternate SecretRef forms and raw values at credential-typed positions", () => {
        const tagged = encodeSecretRef(new SecretRef("tenant", "vault", "deploy"));

        expect(
            strictJsonSchemaValidator.validate(
                SECRET_REF_SCHEMA.document,
                tagged as unknown as JsonValue
            )
        ).toBe(true);
        expect(strictJsonSchemaValidator.validate(SECRET_REF_SCHEMA.document, "raw-token")).toBe(
            false
        );
        expect(
            strictJsonSchemaValidator.validate(SECRET_REF_SCHEMA.document, {
                id: "deploy",
                provider: "vault",
                source: "tenant"
            })
        ).toBe(false);
        expect(
            strictJsonSchemaValidator.validate(SECRET_REF_SCHEMA.document, { $secret: "deploy" })
        ).toBe(false);
        expect(() => new Config({ token: { $secret: "deploy" } })).toThrow(
            /Secret reference value/
        );
        expect(() =>
            decodeSecretRef({
                $secret: { id: "deploy", provider: "vault", source: "tenant" },
                legacy: true
            })
        ).toThrow(/tagged representation/);
    });

    test("composes base, release, manifest, and settings contribution schemas", () => {
        const release = packageRelease();
        const schema = composeConfigSchema(
            new JsonSchema({
                properties: { "acme.deploy": { type: "object" } },
                required: ["acme.deploy"],
                type: "object"
            }),
            [release]
        );
        const secret = encodeSecretRef(new SecretRef("tenant", "vault", "deploy"));
        const valid = {
            "acme.deploy": {
                endpoint: "https://deploy.example",
                region: "wnam",
                token: secret
            }
        };

        expect(strictJsonSchemaValidator.validate(schema.document, valid as JsonValue)).toBe(true);
        expect(
            strictJsonSchemaValidator.validate(schema.document, {
                "acme.deploy": { endpoint: "https://deploy.example", region: "wnam", token: "raw" }
            })
        ).toBe(false);
        expect(
            strictJsonSchemaValidator.validate(schema.document, {
                "acme.deploy": { region: "wnam", token: secret }
            } as JsonValue)
        ).toBe(false);
        expect(
            strictJsonSchemaValidator.validate(schema.document, {
                "acme.deploy": valid["acme.deploy"],
                unknown: {}
            } as JsonValue)
        ).toBe(false);
        expect(composeConfigSchema(BASE_CONFIG_SCHEMA, [release]).document).toEqual(
            composeConfigSchema(BASE_CONFIG_SCHEMA, [release]).document
        );
    });

    test("rejects malformed canonical config and exercises empty and scalar schema paths", () => {
        expect(Config.empty().toData()).toEqual({});
        expect(new Config({ value: -0 }).toData()).toEqual({ value: 0 });
        expect(new Config({ values: [true, null, "text", 1] }).toData()).toEqual({
            values: [true, null, "text", 1]
        });
        expect(() => new Config({ value: Number.NaN })).toThrow(/finite/);
        expect(() => new Config({ value: new Date() as never })).toThrow(/canonical JSON/);
        expect(isSecretRefData({ legacy: true })).toBe(false);
        expect(() => decodeSecretRef({ $secret: { id: "id", provider: "provider" } })).toThrow(
            /missing or unknown/
        );
        expect(() =>
            decodeSecretRef({ $secret: { id: 1, provider: "provider", source: "tenant" } })
        ).toThrow(/must be a string/);

        const encoded = requireObject(decodeCanonicalJson(Config.encode(new Config({}))));
        expect(() =>
            Config.decode(
                encodeCanonicalJson({
                    ...encoded,
                    payload: { value: {}, extra: true }
                })
            )
        ).toThrow(/missing or unknown/);
        const bare = packageReleaseWithoutSchemas();
        expect(composeConfigSchema(BASE_CONFIG_SCHEMA, [bare]).document).toMatchObject({
            allOf: expect.any(Array)
        });
        expect(() => composeConfigSchema(BASE_CONFIG_SCHEMA, [bare, bare])).toThrow(/one release/);
        expect(() => composeConfigSchema(BASE_CONFIG_SCHEMA, [releaseWithSetting(7)])).toThrow(
            /JSON Schema/
        );
        expect(() =>
            composeConfigSchema(BASE_CONFIG_SCHEMA, [releaseWithSetting(true)])
        ).not.toThrow();
    });
});

function packageRelease(): PackageRelease {
    const configSchema = new JsonSchema({
        properties: { token: SECRET_REF_SCHEMA.document },
        required: ["token"],
        type: "object"
    });
    const manifest = new FacetManifest({
        id: new FacetPackageId("acme.deploy.facet"),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        configSchema: new JsonSchema({
            properties: { endpoint: { format: "uri", type: "string" } },
            required: ["endpoint"],
            type: "object"
        }),
        contributions: new Contributions([
            new Contribution(new SlotName("settings"), [
                {
                    properties: { region: { minLength: 1, type: "string" } },
                    required: ["region"],
                    type: "object"
                }
            ])
        ])
    });
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digest("code")),
                media: new MediaHint("application/javascript")
            })
        ],
        entrypoints: [
            new PackageCodeEntrypoint({
                facet: manifest.id,
                version: manifest.version,
                module: "./main.js"
            })
        ]
    });
    return new PackageRelease({
        id: new PackageId("acme.deploy"),
        version: new SemVer("1.0.0"),
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests: [manifest],
        codeManifest,
        provenance: { registry: "test" },
        configSchema
    });
}

function packageReleaseWithoutSchemas(): PackageRelease {
    const manifest = new FacetManifest({
        id: new FacetPackageId("bare.facet"),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        contributions: Contributions.empty()
    });
    return releaseFromManifest("bare", manifest);
}

function releaseWithSetting(setting: JsonValue): PackageRelease {
    const manifest = new FacetManifest({
        id: new FacetPackageId("setting.facet"),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["dynamic"],
        bindings: [],
        contributions: new Contributions([new Contribution(new SlotName("settings"), [setting])])
    });
    return releaseFromManifest("setting", manifest);
}

function releaseFromManifest(id: string, manifest: FacetManifest): PackageRelease {
    const codeManifest = new PackageCodeManifest({
        compatibilityDate: "2026-07-10",
        modules: [
            new PackageCodeModule({
                specifier: "./main.js",
                content: ContentRef.fromDigest(digest(`code:${id}`)),
                media: new MediaHint("application/javascript")
            })
        ],
        entrypoints: [
            new PackageCodeEntrypoint({
                facet: manifest.id,
                version: manifest.version,
                module: "./main.js"
            })
        ]
    });
    return new PackageRelease({
        id: new PackageId(id),
        version: manifest.version,
        compatibility: CompatRange.any(),
        dependencies: [],
        manifests: [manifest],
        codeManifest,
        provenance: { registry: "test" }
    });
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected object");
    }
    return value as { readonly [key: string]: JsonValue };
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

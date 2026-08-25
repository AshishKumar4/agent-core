import { describe, expect, test } from "vitest";
import { Digest, JsonSchema, SemVer, isJsonObject } from "../../src/core";
import { PackageId, PackagePin } from "../../src/definition-references";
import {
    ContributionAttribution,
    FacetRef,
    SettingsLayer,
    SettingsLayerOrigin
} from "../../src/facets";
import { MemoryWorkspaceRecords, WorkspacePersistence } from "../../src/workspaces";
import { malformed } from "../helpers/malformed";
import { sourceActor, tenant } from "../workspaces/fixtures";

const firstPin = new PackagePin(
    new PackageId("settings.package"),
    new SemVer("1.0.0"),
    new Digest("a".repeat(64)),
    new Digest("b".repeat(64))
);
const secondPin = new PackagePin(
    new PackageId("other.settings"),
    new SemVer("1.0.0"),
    new Digest("c".repeat(64)),
    new Digest("d".repeat(64))
);
const first = new ContributionAttribution(new FacetRef("workspace:settings"), firstPin);
const second = new ContributionAttribution(new FacetRef("workspace:other-settings"), secondPin);

describe("SettingsLayer record and composition", () => {
    test(
        "[facet.settings-layer] round-trips identity, attribution, and schema",
        { tags: "p0" },
        () => {
            const layer = new SettingsLayer(first, 0, {
                type: "object",
                properties: { enabled: { type: "boolean" } }
            });
            const decoded = SettingsLayer.decode(SettingsLayer.encode(layer));

            expect(decoded.id.equals(layer.id)).toBe(true);
            expect(decoded.origin.equals(layer.origin)).toBe(true);
            expect(decoded.attribution.equals(first)).toBe(true);
            expect(decoded.schema.document).toEqual(layer.schema.document);
            expect(
                SettingsLayer.codec.decode(SettingsLayer.codec.encode(layer)).id.equals(layer.id)
            ).toBe(true);
        }
    );

    test("refuses malformed origins, state, and schema data", { tags: "p1" }, () => {
        expect(() => new SettingsLayerOrigin(malformed<FacetRef>("not-a-facet"), 0)).toThrow(
            /names its contributor/
        );
        expect(() => new SettingsLayerOrigin(first.contributor, -1)).toThrow(
            /non-negative safe integer/
        );
        expect(() => new SettingsLayer(malformed<ContributionAttribution>(null), 0, {})).toThrow(
            /requires its contribution attribution/
        );
        expect(() => new SettingsLayer(first, -1, {})).toThrow(/non-negative safe integer/);
        const data = new SettingsLayer(first, 0, { type: "object" }).toData();
        if (!isJsonObject(data)) throw new TypeError("Expected settings data object");
        const withoutSchema = { ...data };
        delete withoutSchema["schema"];
        expect(() => SettingsLayer.fromData(withoutSchema)).toThrow(/missing or unknown fields/);
        expect(() => SettingsLayer.fromData({ ...data, ordinal: -1 })).toThrow(
            /non-negative safe integer/
        );
    });

    test(
        "composes one package group directly and multiple fragments through allOf",
        { tags: "p0" },
        () => {
            const records = new MemoryWorkspaceRecords();
            const persistence = new WorkspacePersistence<MemoryWorkspaceRecords>(
                (transaction) => transaction,
                { verify: () => true, release: () => {}, discard: () => {} },
                sourceActor,
                tenant
            );
            persistence.putSettingsLayer(
                records,
                new SettingsLayer(first, 0, { type: "object", required: ["enabled"] })
            );
            persistence.putSettingsLayer(
                records,
                new SettingsLayer(first, 1, { type: "object", required: ["mode"] })
            );
            persistence.putSettingsLayer(
                records,
                new SettingsLayer(second, 0, { type: "object", required: ["other"] })
            );

            const composed = persistence.composedSettingsSchema(
                records,
                new JsonSchema({ type: "object" })
            );
            expect(composed.document).toEqual({
                allOf: [
                    { type: "object" },
                    {
                        additionalProperties: false,
                        properties: {
                            "other.settings": { type: "object", required: ["other"] },
                            "settings.package": {
                                allOf: [
                                    { type: "object", required: ["enabled"] },
                                    { type: "object", required: ["mode"] }
                                ]
                            }
                        },
                        required: ["other.settings", "settings.package"],
                        type: "object"
                    }
                ]
            });
        }
    );
});

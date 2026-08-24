import { describe, expect, test } from "vitest";
import { Digest, SemVer, encodeCanonicalJson, isJsonObject } from "../../src/core";
import { PackageId, PackagePin } from "../../src/definition-references";
import {
    ContributionAttribution,
    FacetRef,
    PromptSection,
    PromptSectionContributionOrigin,
    type PromptSectionId
} from "../../src/facets";
import { malformed } from "../helpers/malformed";
import { expectAgentCoreError } from "../protocol/error-assertion";

const pin = new PackagePin(
    new PackageId("acme.codec"),
    new SemVer("1.2.3"),
    new Digest("a".repeat(64)),
    new Digest("b".repeat(64))
);
const attribution = new ContributionAttribution(new FacetRef("workspace:codec.facet"), pin);

describe("PromptSection record and codec", () => {
    test(
        "[facet.prompt-section] round-trips through bytes and canonical data with its identity intact",
        { tags: "p0" },
        () => {
            const section = new PromptSection(
                "Overview",
                "Renders the workspace overview.",
                2,
                attribution,
                1
            );

            const decoded = PromptSection.decode(PromptSection.encode(section));
            expect(decoded.toData()).toEqual(section.toData());
            expect(decoded.id.equals(section.id)).toBe(true);
            expect(decoded.origin.equals(section.origin)).toBe(true);
            expect(Object.isFrozen(decoded)).toBe(true);
            expect(Object.isFrozen(decoded.origin)).toBe(true);
            expect(PromptSection.fromData(section.toData()).id.equals(section.id)).toBe(true);

            const wire = JSON.parse(new TextDecoder().decode(PromptSection.encode(section)));
            expect(wire.kind).toBe("facet.prompt-section");
            expect(wire.version).toEqual({ major: 1, minor: 0 });
            expect(Object.keys(wire.payload).sort()).toEqual([
                "body",
                "contributor",
                "id",
                "package",
                "position",
                "priority",
                "title"
            ]);
            expect(wire.payload.id.startsWith("prompt:")).toBe(true);
        }
    );

    test(
        "derives identity from exactly the declared fields plus attribution",
        { tags: "p0" },
        () => {
            const base = new PromptSection("Title", "Body", 1, attribution, 0);
            const variants = [
                new PromptSection("Titled", "Body", 1, attribution, 0),
                new PromptSection("Title", "Bodies", 1, attribution, 0),
                new PromptSection("Title", "Body", 2, attribution, 0),
                new PromptSection("Title", "Body", 1, attribution, 1),
                new PromptSection(
                    "Title",
                    "Body",
                    1,
                    new ContributionAttribution(attribution.contributor, upgradedPin()),
                    0
                )
            ];
            const identities = new Set([base, ...variants].map((section) => section.id.value));
            expect(identities.size).toBe(variants.length + 1);
        }
    );

    test(
        "refuses a forged identity, an unattributed build, and a malformed wire form",
        { tags: "p0" },
        () => {
            const section = new PromptSection("Title", "Body", 1, attribution, 0);

            expect(
                () =>
                    new PromptSection(
                        "Title",
                        "Body",
                        1,
                        attribution,
                        0,
                        forgedId<PromptSectionId>("prompt:forged")
                    )
            ).toThrow(TypeError);
            expect(
                () => new PromptSection("Title", "Body", 1, malformed("no attribution"), 0)
            ).toThrow(/requires its contribution attribution/);
            expect(() => new PromptSection("Title", "Body", 1, attribution, -1)).toThrow(
                /non-negative safe integer/
            );

            const data = section.toData();
            if (!isJsonObject(data)) throw new TypeError("Prompt section data is not an object");
            const withExtra = { ...data, extra: true };
            expect(() => PromptSection.fromData(withExtra)).toThrow(/missing or unknown fields/);
            // Exact-field checking refuses a payload with no package field at all; the
            // attribution seam owns the deeper refusal for a payload that names no pin.
            const withoutPin = { ...data };
            delete withoutPin["package"];
            expect(() => PromptSection.fromData(withoutPin)).toThrow(/missing or unknown fields/);
            expect(() =>
                ContributionAttribution.decodeFields(
                    { contributor: "workspace:codec.facet" },
                    "Prompt section"
                )
            ).toThrow(/carries no source Package pin/);

            const bytes = encodeCanonicalJson({
                kind: "facet.prompt-section",
                payload: section.toData(),
                version: { major: 99, minor: 0 }
            });
            expectAgentCoreError(() => PromptSection.decode(bytes), "codec.unknown-major");
        }
    );

    test("orders every declared tie-breaker and validates direct origins", { tags: "p1" }, () => {
        const base = new PromptSection("A", "A", 0, attribution, 0);
        expect(
            PromptSection.compare(base, new PromptSection("A", "A", 1, attribution, 0))
        ).toBeLessThan(0);
        expect(
            PromptSection.compare(base, new PromptSection("B", "A", 0, attribution, 0))
        ).toBeLessThan(0);
        expect(
            PromptSection.compare(base, new PromptSection("A", "B", 0, attribution, 0))
        ).toBeLessThan(0);
        expect(
            PromptSection.compare(
                base,
                new PromptSection(
                    "A",
                    "A",
                    0,
                    new ContributionAttribution(new FacetRef("workspace:other"), pin),
                    0
                )
            )
        ).toBeLessThan(0);
        expect(
            PromptSection.compare(base, new PromptSection("A", "A", 0, attribution, 1))
        ).toBeLessThan(0);
        expect(
            () => new PromptSectionContributionOrigin(malformed<FacetRef>("not-a-facet"), 0)
        ).toThrow(/names its contributor/);
        expect(() => new PromptSectionContributionOrigin(attribution.contributor, -1)).toThrow(
            /non-negative safe integer/
        );
    });
});

function upgradedPin(): PackagePin {
    return new PackagePin(
        new PackageId("acme.codec"),
        new SemVer("2.0.0"),
        new Digest("a".repeat(64)),
        new Digest("b".repeat(64))
    );
}

function forgedId<TActual>(value: string): TActual {
    // SAFETY: not a PromptSectionId. The constructor must verify it against the contents.
    return value as TActual;
}

import { describe, expect, test } from "vitest";
import type { JsonObject, JsonValue } from "../../src/core";
import { DesiredProjection, PolicySet, selectPlacement } from "../../src/definition";

const packagePin = {
    codeDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    id: "acme.deploy",
    manifestDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    version: "1.2.3"
} satisfies JsonObject;

const slotEntry = {
    contributor: "acme.deploy",
    index: 0,
    slot: "chat.composer",
    value: { command: "deploy" },
    package: packagePin
} satisfies JsonObject;

function slotEntryProjection(desired: JsonValue): DesiredProjection {
    return new DesiredProjection({
        logicalKey: "contribution:acme.deploy:chat.composer:0",
        recordKind: "slot-entry",
        desired
    });
}

describe("materialization kind validation", () => {
    test("rejects an unsupported record kind with its typed message", { tags: "p1" }, () => {
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: "unsupported:kind",
                    recordKind: "definitely-unsupported",
                    desired: PolicySet.empty().toData()
                })
        ).toThrow(/Unsupported materialization record kind definitely-unsupported/);
    });

    test("rejects slot entries with unknown fields through exact key closure", { tags: "p1" }, () => {
        expect(() => slotEntryProjection({ ...slotEntry, extra: true })).toThrow(
            /Slot entry contains missing or unknown fields/
        );
        expect(() => slotEntryProjection({ contributor: "acme.deploy" })).toThrow(
            /Slot entry contains missing or unknown fields/
        );
    });

    test("rejects non-object slot entries with the object subject", { tags: "p1" }, () => {
        expect(() => slotEntryProjection(null)).toThrow(/Slot entry must be an object/);
        expect(() => slotEntryProjection(["not", "an", "object"])).toThrow(
            /Slot entry must be an object/
        );
        expect(() => slotEntryProjection("text")).toThrow(/Slot entry must be an object/);
    });

    test("rejects every non-canonical slot entry contributor shape", { tags: "p1" }, () => {
        const invalidContributors: readonly JsonValue[] = [7, "", " ", "acme.deploy ", " acme"];
        for (const contributor of invalidContributors) {
            expect(() => slotEntryProjection({ ...slotEntry, contributor })).toThrow(
                /Slot entry contributor must be a nonblank canonical string/
            );
        }
    });

    test("rejects every malformed slot entry index shape", { tags: "p1" }, () => {
        const invalidIndexes: readonly JsonValue[] = ["3", 1.5, -1, Number.MAX_SAFE_INTEGER + 2];
        for (const index of invalidIndexes) {
            expect(() => slotEntryProjection({ ...slotEntry, index })).toThrow(
                /Slot entry index must be a non-negative safe integer/
            );
        }
    });

    test("carries the source pin of release-backed entries through validation", { tags: "p1" }, () => {
        expect(slotEntryProjection(slotEntry).desired).toEqual(slotEntry);
    });

    test("refuses a release-backed slot entry without its source pin", { tags: "p1" }, () => {
        const { package: _package, ...unpinned } = slotEntry;
        expect(() => slotEntryProjection(unpinned)).toThrow(
            /Slot entry contains missing or unknown fields/
        );
    });

    test("admits a Blueprint-declared slot entry without a source pin", { tags: "p1" }, () => {
        const declared = {
            contributor: "blueprint",
            index: 0,
            slot: "slots",
            value: { name: "dashboard.card" }
        } satisfies JsonObject;
        expect(slotEntryProjection(declared).desired).toEqual(declared);
    });

    test("refuses a source pin on a Blueprint-declared slot entry", { tags: "p1" }, () => {
        expect(() =>
            slotEntryProjection({
                contributor: "blueprint",
                index: 0,
                slot: "slots",
                value: { name: "dashboard.card" },
                package: packagePin
            })
        ).toThrow(/Slot entry contains missing or unknown fields/);
    });

    test("rejects every malformed slot entry source pin shape", { tags: "p1" }, () => {
        const cases: readonly (readonly [JsonValue, RegExp])[] = [
            [7, /Package pin must be an object/],
            [
                { id: "acme.deploy", version: "1.2.3" },
                /Package pin contains missing or unknown fields/
            ],
            [
                {
                    codeDigest: "nothex",
                    id: "acme.deploy",
                    manifestDigest:
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    version: "1.2.3"
                },
                /Digest must be a lowercase SHA-256 hexadecimal value/
            ],
            [
                {
                    codeDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    id: "acme.deploy",
                    manifestDigest:
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    version: "not-a-version"
                },
                /Semantic version must follow SemVer 2\.0\.0/
            ]
        ];
        for (const [pin, message] of cases) {
            expect(() => slotEntryProjection({ ...slotEntry, package: pin })).toThrow(message);
        }
    });

    test("rejects partially reordered placement sources as non-canonical", { tags: "p1" }, () => {
        const selection = selectPlacement({
            manifest: ["dynamic", "provider", "bundled"],
            policy: ["dynamic", "provider", "bundled"],
            substrate: ["dynamic", "provider", "bundled"],
            trust: ["dynamic", "provider", "bundled"]
        });
        const desired = {
            facet: "acme.deploy",
            manifest: [...selection.manifest],
            policy: [...selection.policy],
            selected: selection.selected,
            substrate: [...selection.substrate],
            trust: [...selection.trust]
        };
        expect(
            () =>
                new DesiredProjection({
                    logicalKey: "placement:acme:acme.deploy",
                    recordKind: "facet-placement",
                    desired: { ...desired, manifest: ["dynamic", "bundled", "provider"] }
                })
        ).toThrow(/Manifest placement source must use canonical placement order/);
    });
});

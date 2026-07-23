import { describe, expect, test } from "vitest";
import type { JsonValue } from "../../src/core";
import { DesiredProjection, PolicySet, selectPlacement } from "../../src/definition";

const slotEntry: { readonly [key: string]: JsonValue } = {
    contributor: "acme.deploy",
    index: 0,
    slot: "chat.composer",
    value: { command: "deploy" }
};

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

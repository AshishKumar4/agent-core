import { describe, expect, test } from "vitest";
import { JsonSchema } from "../../src/core";
import {
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotEntry,
    SlotName,
    type FacetData
} from "../../src/facets";

describe("Slot declaration vocabulary", () => {
    test("canonicalizes authority selectors into sorted lists", { tags: "p1" }, () => {
        const policy = new SlotAuthorityPolicy(["b.selector", "a.selector"], ["z.read", "y.read"]);
        expect(policy.contribute).toEqual(["a.selector", "b.selector"]);
        expect(policy.visibility).toEqual(["y.read", "z.read"]);
    });

    test("names the offending authority list in every policy validation error", { tags: "p2" }, () => {
        expect(() => new SlotAuthorityPolicy([], ["read"])).toThrow(
            /Slot contribute authority must not be empty/
        );
        expect(() => new SlotAuthorityPolicy(["write"], [])).toThrow(
            /Slot visibility authority must not be empty/
        );
        expect(() => new SlotAuthorityPolicy([" "], ["read"])).toThrow(
            /Slot contribute authority selector must be a nonblank canonical string/
        );
        expect(() => new SlotAuthorityPolicy(["write"], [" "])).toThrow(
            /Slot visibility authority selector must be a nonblank canonical string/
        );
    });

    test("freezes constructed declarations", { tags: "p1" }, () => {
        const declaration = new SlotDeclaration(
            new SlotName("dashboard.card"),
            new JsonSchema({ type: "object" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        expect(Object.isFrozen(declaration)).toBe(true);
        expect(declaration.name.value).toBe("dashboard.card");
    });

    test("names each malformed declaration and entry field", { tags: "p2" }, () => {
        expect(() =>
            SlotDeclaration.fromData({
                authority: { contribute: ["installed"], visibility: ["scope.read"] },
                entrySchema: true,
                name: 1
            })
        ).toThrow(/Slot name must be a string/);
        expect(() => SlotEntry.fromData(entryData({ slot: 1 }))).toThrow(
            /Slot entry slot must be a string/
        );
        expect(() => SlotEntry.fromData(entryData({ contributor: 1 }))).toThrow(
            /Slot entry contributor must be a string/
        );
        expect(() => SlotEntry.fromData(entryData({ id: 1 }))).toThrow(
            /Slot entry ID must be a string/
        );
    });
});

function entryData(overrides: Readonly<Record<string, FacetData>>): FacetData {
    const canonical = SlotEntry.create(new SlotName("dashboard.card"), "workspace:facet", 0, null);
    return {
        contributor: "workspace:facet",
        id: canonical.id.value,
        ordinal: 0,
        slot: "dashboard.card",
        value: null,
        ...overrides
    };
}

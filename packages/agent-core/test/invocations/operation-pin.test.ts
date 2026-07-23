import { describe, expect, test } from "vitest";
import {
    InvocationPlacementPin,
    OperationPin,
    requireObject,
    sameJson
} from "../../src/invocations";
import { operationPin } from "./fixture";

describe("Operation pin placement and decoding", () => {
    test(
        "selects the first placement admissible in every set, not merely in some set",
        { tags: "p1" },
        () => {
            const pin = new InvocationPlacementPin({
                manifest: ["dynamic", "provider"],
                policy: ["provider", "bundled"],
                substrate: ["provider"],
                trust: ["provider"],
                selected: "provider"
            });
            expect(pin.selected).toBe("provider");
            expect(pin.manifest).toEqual(["dynamic", "provider"]);
            expect(pin.policy).toEqual(["provider", "bundled"]);
        }
    );

    test("names the placement facet that fails canonicalization", { tags: "p2" }, () => {
        const base = {
            manifest: ["provider"],
            policy: ["provider"],
            substrate: ["provider"],
            trust: ["provider"],
            selected: "provider"
        } as const;
        const facets = [
            ["manifest", { ...base, manifest: [] }],
            ["policy", { ...base, policy: [] }],
            ["substrate", { ...base, substrate: [] }],
            ["trust", { ...base, trust: [] }]
        ] as const;
        for (const [subject, init] of facets) {
            expect(() => new InvocationPlacementPin(init)).toThrow(
                new RegExp(`^${subject} placement modes must be nonempty and unique$`)
            );
        }
    });

    test("round-trips operation pins through canonical data", { tags: "p1" }, () => {
        const pin = operationPin("roundtrip-pin", true);
        const decoded = OperationPin.fromData(pin.toData());
        expect(sameJson(decoded.toData(), pin.toData())).toBe(true);
        expect(decoded.approvalRequired).toBe(true);
        expect(decoded.placement.selected).toBe(pin.placement.selected);
    });

    test("rejects non-boolean approval requirements at decode time", { tags: "p2" }, () => {
        const data = requireObject(operationPin("approval-pin").toData(), "Operation pin");
        expect(() => OperationPin.fromData({ ...data, approvalRequired: 1 })).toThrow(
            /^Approval requirement must be boolean$/
        );
    });
});

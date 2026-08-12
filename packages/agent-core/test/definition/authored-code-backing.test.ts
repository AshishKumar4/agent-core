import { describe, expect, test } from "vitest";
import {
    AuthoredCodeBackingId,
    AuthoredCodeBackingPolicy,
    PlacementPolicy
} from "../../src/definition";
import { AUTHORED_CODE_CONSUMERS } from "../../src/facets";

const workerLoader = new AuthoredCodeBackingId("workerLoader");
const dispatchNamespace = new AuthoredCodeBackingId("dispatchNamespace");

describe("declaring which backing serves which §4.7 consumer", () => {
    test(
        "[C13-PLACEMENT-AUTHORED-BACKING] serves a declared consumer from the backing the Blueprint named",
        { tags: "p0" },
        () => {
            const declared = new PlacementPolicy(
                ["dynamic"],
                ["*"],
                new AuthoredCodeBackingPolicy(new Map([["slateBackend", dispatchNamespace]]))
            );

            expect(declared.backingFor("slateBackend", workerLoader).value).toBe(
                dispatchNamespace.value
            );
            expect(declared.backings.consumers).toEqual(["slateBackend"]);
        }
    );

    test(
        "[C13-PLACEMENT-AUTHORED-BACKING] sends an unmapped consumer to the profile's declared default",
        { tags: "p0" },
        () => {
            const declared = new PlacementPolicy(
                ["dynamic"],
                ["*"],
                new AuthoredCodeBackingPolicy(new Map([["slateBackend", dispatchNamespace]]))
            );

            // Not the other declared backing, and not an arbitrary one: the profile's.
            expect(declared.backingFor("programmaticToolCall", workerLoader).value).toBe(
                workerLoader.value
            );
            expect(declared.backingFor("agentAuthoredFacet", workerLoader).value).toBe(
                workerLoader.value
            );
            expect(
                AuthoredCodeBackingPolicy.unmapped.backingFor("slateBackend", workerLoader).value
            ).toBe(workerLoader.value);
        }
    );

    test(
        "[C13-PLACEMENT-AUTHORED-BACKING] round-trips the declaration through the placement record",
        { tags: "p0" },
        () => {
            const declared = new PlacementPolicy(
                ["dynamic", "provider"],
                ["core.*"],
                new AuthoredCodeBackingPolicy(
                    new Map([
                        ["slateBackend", dispatchNamespace],
                        ["agentAuthoredFacet", dispatchNamespace]
                    ])
                )
            );
            const restored = PlacementPolicy.decode(PlacementPolicy.encode(declared));

            expect(restored.toData()).toEqual(declared.toData());
            expect(restored.backingFor("slateBackend", workerLoader).value).toBe(
                dispatchNamespace.value
            );
            expect(restored.backingFor("programmaticToolCall", workerLoader).value).toBe(
                workerLoader.value
            );
            // A Blueprint that maps nothing states that completely without the field:
            // the empty mapping and an absent one mean the same thing (§4.7).
            expect(PlacementPolicy.all().toData()).toEqual({
                allowed: ["dynamic", "provider", "bundled"],
                trusted: ["*"]
            });
            expect(
                PlacementPolicy.fromData({ allowed: ["dynamic"], trusted: ["*"] }).backings.isEmpty
            ).toBe(true);
        }
    );

    test(
        "[C13-PLACEMENT-AUTHORED-BACKING] admits only the three §4.7 consumers",
        { tags: "p0" },
        () => {
            expect([...AUTHORED_CODE_CONSUMERS]).toEqual([
                "programmaticToolCall",
                "slateBackend",
                "agentAuthoredFacet"
            ]);
            expect(
                AuthoredCodeBackingPolicy.fromData({ slateBackend: "dispatchNamespace" }).consumers
            ).toEqual(["slateBackend"]);
            // Anything outside the closed set is not a consumer of agent-authored code,
            // so it has no backing to declare.
            expect(() =>
                AuthoredCodeBackingPolicy.fromData({ agentAuthoredExecutor: "workerLoader" })
            ).toThrow(TypeError);
            expect(() => AuthoredCodeBackingPolicy.fromData({ slateBackend: 7 })).toThrow(
                TypeError
            );
            expect(() => AuthoredCodeBackingPolicy.fromData("dispatchNamespace")).toThrow(
                TypeError
            );
        }
    );

    test(
        "[C13-PLACEMENT-AUTHORED-BACKING] rejects a placement record whose declaration is malformed",
        { tags: "p1" },
        () => {
            expect(() =>
                PlacementPolicy.fromData({
                    allowed: ["dynamic"],
                    backings: { slateBackend: "" },
                    trusted: ["*"]
                })
            ).toThrow(TypeError);
            expect(() =>
                PlacementPolicy.fromData({
                    allowed: ["dynamic"],
                    backings: {},
                    trusted: ["*"],
                    extra: 1
                })
            ).toThrow(TypeError);
        }
    );
});

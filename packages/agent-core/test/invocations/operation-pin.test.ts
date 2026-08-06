import { describe, expect, test } from "vitest";
import { Digest, JsonSchema } from "../../src/core";
import { FacetRef, OperationDescriptor, OperationName } from "../../src/facets";
import { OperationRequestKey } from "../../src/operations";
import type { InterceptorTrace, OperationInterceptionEvidence } from "../../src/operations";
import {
    InvocationPlacementPin,
    OperationPin,
    ReplayOperationInvocationPort,
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

    test("rejects a placement admitted by only some of the four sets", { tags: "p1" }, () => {
        expect(
            () =>
                new InvocationPlacementPin({
                    manifest: ["provider"],
                    policy: ["provider"],
                    substrate: ["bundled"],
                    trust: ["bundled"],
                    selected: "provider"
                })
        ).toThrow(/^Selected placement must occur in every admissible set$/);
    });

    test("rejects non-boolean approval requirements at decode time", { tags: "p2" }, () => {
        const data = requireObject(operationPin("approval-pin").toData(), "Operation pin");
        expect(() => OperationPin.fromData({ ...data, approvalRequired: 1 })).toThrow(
            /^Approval requirement must be boolean$/
        );
    });

    test(
        "[C13-INTERCEPTOR-REPLAY] refuses interception evidence offered on the direct tier",
        { tags: "p1" },
        () => {
            const port = Object.create(
                ReplayOperationInvocationPort.prototype
            ) as ReplayOperationInvocationPort<unknown, unknown, unknown>;
            const schema = new JsonSchema({ type: "object", additionalProperties: true });
            const evidence = (
                traces: readonly (readonly InterceptorTrace[])[]
            ): OperationInterceptionEvidence => ({
                requestKey: new OperationRequestKey("direct-attribution"),
                facet: new FacetRef("workspace:runtime.instance"),
                descriptor: new OperationDescriptor(
                    new OperationName("run"),
                    "observe",
                    schema,
                    schema,
                    "aa"
                ),
                shape: { kind: "single" },
                traces
            });
            const trace: InterceptorTrace = {
                itemIndex: 0,
                interceptor: "rewriter",
                contributor: "contributor",
                cutPoint: "operation.before",
                before: Digest.sha256(new Uint8Array([1])),
                after: Digest.sha256(new Uint8Array([2])),
                outcome: "rewritten"
            };

            // An applicable interceptor raises the call to mediated (§7.2), so the direct
            // tier can only ever offer empty evidence. Accepting a trace here would discard
            // the one record that attributes a rewrite.
            expect(() => port.recordDirectInterceptions(evidence([[]]))).not.toThrow();
            expect(() => port.recordDirectInterceptions(evidence([[trace]]))).toThrow(
                /only the mediated tier attributes/u
            );
        }
    );
});

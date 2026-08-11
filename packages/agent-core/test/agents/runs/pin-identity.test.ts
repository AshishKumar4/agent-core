import { describe, expect, it } from "vitest";
import { JsonSchema } from "../../../src/core";
import { PackageId } from "../../../src/definition";
import {
    BindingName,
    FacetPackageId,
    FacetRef,
    OperationDescriptor,
    OperationName,
    OperationRef
} from "../../../src/facets";
import { TurnBoundTool } from "../../../src/agents/runs";
import { RunPins } from "../../../src/agents/runs/pins";
import { pins } from "./fixture";

describe("Run pin identity types", () => {
    it(
        "[C13-RUN-PIN-IDENTITY-TYPES] keeps PackageId and FacetPackageId distinct opaque identities",
        { tags: "p0" },
        () => {
            const packageId = new PackageId("shared-identity");
            const facetPackageId = new FacetPackageId("shared-identity");

            expect(packageId.equals(facetPackageId)).toBe(false);
            expect(facetPackageId.equals(packageId)).toBe(false);
            expect(packageId.equals(new PackageId("shared-identity"))).toBe(true);
            expect(facetPackageId.equals(new FacetPackageId("shared-identity"))).toBe(true);
        }
    );

    it(
        "[C13-RUN-PIN-IDENTITY-TYPES] round-trips Run pin Package identities as PackageId, never a facet-package substitute",
        { tags: "p1" },
        () => {
            const decoded = RunPins.fromData(pins().toData());
            for (const pin of decoded.packages) {
                expect(pin.id).toBeInstanceOf(PackageId);
                expect(pin.id.equals(new FacetPackageId(pin.id.value))).toBe(false);
                expect(pin.id.equals(new PackageId(pin.id.value))).toBe(true);
            }
        }
    );

    it(
        "[C13-RUN-PIN-IDENTITY-TYPES] binds Turn tools through the derived FacetPackageId identity",
        { tags: "p1" },
        () => {
            const descriptor = new OperationDescriptor(
                new OperationName("read"),
                "observe",
                new JsonSchema({ type: "object" }),
                new JsonSchema({ type: "object" })
            );
            const tool = new TurnBoundTool(
                new BindingName("memory"),
                new FacetRef("memory:primary"),
                new OperationRef("memory:read"),
                descriptor
            );
            expect(tool.operation.facet.equals(new FacetPackageId("memory"))).toBe(true);
            expect(
                () =>
                    new TurnBoundTool(
                        new BindingName("memory"),
                        new FacetRef("memory:primary"),
                        new OperationRef("other:read"),
                        descriptor
                    )
            ).toThrow(/one operation/);
        }
    );
});

import { describe, expect, test } from "vitest";
import {
    AuthoredCodeBackingId,
    BindingName,
    EventKind,
    FacetPackageId,
    FacetRef,
    InterceptorId,
    OperationName,
    OperationRef,
    SlotEntryId,
    SlotName,
    SurfaceId
} from "../../src/facets";

describe("Facet identifier vocabulary", () => {
    test("names each identifier subject in empty-value errors", { tags: "p2" }, () => {
        expect(() => new FacetPackageId("")).toThrow(
            "Facet package ID must contain between 1 and 256 characters"
        );
        expect(() => new BindingName("")).toThrow(
            "Binding name must contain between 1 and 256 characters"
        );
        expect(() => new OperationName("")).toThrow(
            "Operation name must contain between 1 and 256 characters"
        );
        expect(() => new OperationRef("")).toThrow(
            "Operation reference must contain between 1 and 256 characters"
        );
        expect(() => new EventKind("")).toThrow(
            "Event kind must contain between 1 and 256 characters"
        );
        expect(() => new SurfaceId("")).toThrow(
            "Surface ID must contain between 1 and 256 characters"
        );
        expect(() => new SlotName("")).toThrow(
            "Slot name must contain between 1 and 256 characters"
        );
        expect(() => new InterceptorId("")).toThrow(
            "Interceptor ID must contain between 1 and 256 characters"
        );
        expect(() => new SlotEntryId("")).toThrow(
            "Slot entry ID must contain between 1 and 256 characters"
        );
    });

    test("rejects noncanonical identifier values", { tags: "p1" }, () => {
        expect(() => new BindingName(" x")).toThrow(/nonblank canonical string/);
        expect(() => new BindingName("x ")).toThrow(/nonblank canonical string/);
        expect(new BindingName("x").value).toBe("x");
    });

    test("requires exactly one interior operation reference separator", { tags: "p1" }, () => {
        const separatorRefusal =
            "Operation reference must be '<facet-package-id>:<operation-name>'";
        expect(() => new OperationRef(":run")).toThrow(separatorRefusal);
        expect(() => new OperationRef("core.deploy:")).toThrow(separatorRefusal);
        expect(() => new OperationRef("a:b:c")).toThrow(separatorRefusal);
        expect(() => new OperationRef("run")).toThrow(separatorRefusal);

        const reference = new OperationRef("acme.deploy:run");
        expect(reference.facet.value).toBe("acme.deploy");
        expect(reference.operation.value).toBe("run");
    });

    test("accepts multi-character dotted facet reference segments", { tags: "p1" }, () => {
        const reference = new FacetRef("ab.cd:ef.gh");
        expect(reference.value).toBe("ab.cd:ef.gh");
        expect(reference.packageId).toEqual(new FacetPackageId("ab.cd"));
        expect(new FacetRef("a-b2:c-d3").value).toBe("a-b2:c-d3");
        expect(() => new FacetRef("Upper:case")).toThrow(/canonical segments/);
    });

    test("requires exactly one interior facet reference separator", { tags: "p1" }, () => {
        const separatorRefusal = /canonical segments/;
        expect(() => new FacetRef("noseparator")).toThrow(separatorRefusal);
        expect(() => new FacetRef(":instance")).toThrow(separatorRefusal);
        expect(() => new FacetRef("facet:")).toThrow(separatorRefusal);
        expect(() => new FacetRef("facet:instance:extra")).toThrow(separatorRefusal);
        expect(() => new FacetRef(" facet:instance")).toThrow(
            "Facet reference must be a nonblank canonical string"
        );
    });

    test("names the agent-authored code backing subject in its own errors", { tags: "p2" }, () => {
        expect(() => new AuthoredCodeBackingId("")).toThrow(
            "Agent-authored code backing ID must contain between 1 and 256 characters"
        );
        expect(() => new AuthoredCodeBackingId(" durable-object")).toThrow(
            "Agent-authored code backing ID must be a nonblank canonical string"
        );
        expect(new AuthoredCodeBackingId("durable-object").value).toBe("durable-object");
    });
});

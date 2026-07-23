import { describe, expect, test } from "vitest";
import {
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
        const separatorShape = "Operation reference must be '<facet-package-id>:<operation-name>'";
        expect(() => new OperationRef(":run")).toThrow(separatorShape);
        expect(() => new OperationRef("core.deploy:")).toThrow(separatorShape);
        expect(() => new OperationRef("a:b:c")).toThrow(separatorShape);
        expect(() => new OperationRef("run")).toThrow(separatorShape);

        const reference = new OperationRef("acme.deploy:run");
        expect(reference.facet.value).toBe("acme.deploy");
        expect(reference.operation.value).toBe("run");
    });

    test("accepts multi-character dotted facet reference segments", { tags: "p1" }, () => {
        expect(new FacetRef("ab.cd:ef.gh").value).toBe("ab.cd:ef.gh");
        expect(new FacetRef("a-b2:c-d3").value).toBe("a-b2:c-d3");
        expect(() => new FacetRef("Upper:case")).toThrow(/canonical segments/);
    });
});

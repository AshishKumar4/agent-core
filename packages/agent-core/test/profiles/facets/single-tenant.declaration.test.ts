import { SINGLE_TENANT_EVENTS, SINGLE_TENANT_OPERATIONS } from "../../../src/facets";
import { describe, expect, test } from "vitest";

describe("Single-tenant policy profile", () => {
    test("[P11-SINGLE-TENANT-NO-OPERATIONS] exposes no Operation entry point", () => {
        expect(SINGLE_TENANT_OPERATIONS).toEqual([]);
    });

    test("[P11-SINGLE-TENANT-NO-EVENTS] exposes no Event or impact declaration", () => {
        expect(SINGLE_TENANT_EVENTS).toEqual([]);
        expect(SINGLE_TENANT_OPERATIONS.map((operation) => operation.impact)).toEqual([]);
    });

    test("[P11-SINGLE-TENANT-NO-MACHINERY] declares no Operations, Events, Facet runtime, or installation machinery", async () => {
        expect(SINGLE_TENANT_OPERATIONS).toEqual([]);
        expect(SINGLE_TENANT_EVENTS).toEqual([]);
        const module = await import("../../../src/facets");
        expect("SingleTenantFacet" in module).toBe(false);
        expect("SingleTenantAuthorityBackend" in module).toBe(false);
        expect("SINGLE_TENANT_INSTALL_CONTROL" in module).toBe(false);
        expect("SingleTenantPolicy" in module).toBe(false);
    });
});

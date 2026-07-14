import { describe, expect, test } from "vitest";
import * as operations from "../../src/operations";

describe("W3 operations context barrel", () => {
    test("exports contracts without trusted host constructors", () => {
        expect("Facet" in operations).toBe(true);
        expect("Operation" in operations).toBe(true);
        expect("Interceptor" in operations).toBe(true);
        expect("Surface" in operations).toBe(true);
        expect("OperationGateway" in operations).toBe(true);
        expect("ResolvedFacet" in operations).toBe(true);
        expect("OperationGatewayHost" in operations).toBe(false);
        expect("FacetRuntimeHost" in operations).toBe(false);
        expect("WorkspaceSlotCatalog" in operations).toBe(false);
        expect("MemoryWorkspaceSlotStore" in operations).toBe(false);
        expect("SqliteWorkspaceSlotStore" in operations).toBe(false);
        expect("FacetSlotInstallCommand" in operations).toBe(false);
    });
});

import { describe, expect, test } from "vitest";
import { ContentRef, Digest } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import * as operations from "../../src/operations";

describe("W3 operations context barrel", () => {
    test("exports contracts without trusted host constructors", { tags: "p2" }, () => {
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

    test("names the Operation request key it rejects", { tags: "p1" }, () => {
        expect(() => new operations.OperationRequestKey("")).toThrowError(
            new TypeError("Operation request key must contain between 1 and 256 characters")
        );
        expect(new operations.OperationRequestKey("request-1").value).toBe("request-1");
    });

    test("reports a confirmed Operation failure as an invalid invocation with its evidence", { tags: "p0" }, () => {
        const evidence = ContentRef.fromDigest(Digest.sha256(new Uint8Array([1, 2, 3])));
        const failure = new operations.ConfirmedOperationFailure("handler refused", evidence);
        expect(failure).toBeInstanceOf(AgentCoreError);
        expect(failure.code).toBe("invocation.invalid");
        expect(failure.message).toBe("handler refused");
        expect(failure.evidence).toBe(evidence);
    });
});

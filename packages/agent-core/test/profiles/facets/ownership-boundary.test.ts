import * as Facets from "../../../src/facets-public";
import { expect, test } from "vitest";

test("keeps incomplete profile runtime contracts off the public Facet barrel", () => {
    expect("ProtectedProfileRuntimePort" in Facets).toBe(false);
});

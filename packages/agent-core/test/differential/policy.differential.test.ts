import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { evaluatePolicy } from "../../src/definition";
import { PlacementUnavailableError, selectPlacement } from "../../src/definition";
import type { Impact, IsolationMode } from "../../src/facets";
import { LeanOracle } from "./oracle";

/*
 * Differential testing of enforcement-tier derivation (SPEC §7.2) and placement
 * selection (SPEC §4.1) against the verified Lean model.
 *
 * One divergence is *documented and expected*: the formal model conservatively
 * classifies every `execute` as mediated (traceability nonclaim
 * NC-ENVIRONMENT-TURN-OWNED-DIRECT-EXECUTE), while the implementation grants direct
 * to a Turn-owned bundled session. The tier property below asserts agreement
 * everywhere else — and asserts the divergence is exactly the documented one, so a
 * silent widening on either side fails the suite.
 */

const IMPACTS: readonly Impact[] = [
    "observe",
    "mutate",
    "externalSend",
    "execute",
    "delegate",
    "administer"
];
const MODES: readonly IsolationMode[] = ["bundled", "provider", "dynamic"];

let oracle: LeanOracle;
beforeAll(() => {
    oracle = LeanOracle.start();
}, 900_000);
afterAll(() => {
    oracle?.stop();
});

describe("enforcement tier agrees with the verified model", () => {
    test("tier agreement over the full (impact, session, placement) domain", async () => {
        for (const impact of IMPACTS) {
            for (const sessionScoped of [true, false]) {
                for (const placement of MODES) {
                    const implementation = evaluatePolicy({
                        impact,
                        turnOwnedSession: sessionScoped,
                        placement,
                        policies: []
                    }).tier;
                    const model = (
                        await oracle.ask({
                            op: "policy.tier",
                            impact,
                            sessionScoped,
                            placement
                        })
                    )["tier"];
                    const documentedDivergence =
                        impact === "execute" && sessionScoped && placement === "bundled";
                    if (documentedDivergence) {
                        // NC-ENVIRONMENT-TURN-OWNED-DIRECT-EXECUTE, exactly.
                        expect(implementation).toBe("direct");
                        expect(model).toBe("mediated");
                    } else {
                        expect(implementation, `${impact}/${sessionScoped}/${placement}`).toBe(
                            model
                        );
                    }
                }
            }
        }
    });
});

describe("placement selection agrees with the verified model", () => {
    const modeSubset = fc.uniqueArray(fc.constantFrom(...MODES), { minLength: 0, maxLength: 3 });

    test("selection agreement over random four-source intersections", async () => {
        await fc.assert(
            fc.asyncProperty(
                modeSubset,
                modeSubset,
                modeSubset,
                modeSubset,
                async (manifest, policy, substrate, trust) => {
                    let implementation: IsolationMode | null;
                    try {
                        implementation = selectPlacement({
                            manifest,
                            policy,
                            substrate,
                            trust
                        }).selected;
                    } catch (error) {
                        if (!(error instanceof PlacementUnavailableError)) throw error;
                        implementation = null;
                    }
                    const asSet = (modes: readonly IsolationMode[]) => ({
                        bundled: modes.includes("bundled"),
                        provider: modes.includes("provider"),
                        dynamic: modes.includes("dynamic")
                    });
                    const model = (
                        await oracle.ask({
                            op: "policy.placement",
                            manifest: asSet(manifest),
                            policy: asSet(policy),
                            substrate: asSet(substrate),
                            trust: asSet(trust)
                        })
                    )["selected"];
                    expect(implementation).toBe(model);
                }
            ),
            { numRuns: 250 }
        );
    });
});

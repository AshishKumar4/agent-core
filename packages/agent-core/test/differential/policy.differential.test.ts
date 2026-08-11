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
 * The model carries the §7.2 floor with the Turn-owned Environment Session
 * direct-execute exception, so the tier property asserts agreement over the entire
 * (impact, session, placement) domain — any divergence on either side fails the
 * suite. The own-filesystem mutate exception is intentionally outside the model
 * (AC-PLACEMENT-001 boundary), so the sweep pins sessionFilesystemTarget false;
 * the runtime branch is covered by the exhaustive floor tests in
 * test/definition/policy.test.ts and the P11-FILESYSTEM-SESSION-DIRECT profile test.
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
    test(
        "tier agreement over the full (impact, session, placement) domain",
        { tags: "p0" },
        async () => {
            for (const impact of IMPACTS) {
                for (const sessionScoped of [true, false]) {
                    for (const placement of MODES) {
                        const implementation = evaluatePolicy({
                            impact,
                            turnOwnedSession: sessionScoped,
                            sessionFilesystemTarget: false,
                            placement,
                            policies: []
                        }).tier;
                        const model = (
                            await oracle.ask({
                                op: "policy.tier",
                                impact,
                                sessionScoped,
                                placement,
                                intercepted: false
                            })
                        )["tier"];
                        expect(implementation, `${impact}/${sessionScoped}/${placement}`).toBe(
                            model
                        );
                    }
                }
            }
        }
    );

    test(
        "an applicable interceptor forces mediated for every impact, session, and placement",
        { tags: "p0" },
        async () => {
            // The implementation side of this raise is asserted at its real seam —
            // TenantOperationAuthority.tier with hasInterceptors — in
            // test/composition/tier-policy.test.ts ("interceptors force mediated
            // regardless of policy"). Here the verified model sweeps the whole domain:
            // rewrite evidence has no direct channel to be recorded through (SPEC §7.2).
            for (const impact of IMPACTS) {
                for (const sessionScoped of [true, false]) {
                    for (const placement of MODES) {
                        const model = (
                            await oracle.ask({
                                op: "policy.tier",
                                impact,
                                sessionScoped,
                                placement,
                                intercepted: true
                            })
                        )["tier"];
                        expect(model, `${impact}/${sessionScoped}/${placement}`).toBe("mediated");
                    }
                }
            }
        }
    );
});

describe("placement selection agrees with the verified model", () => {
    const modeSubset = fc.uniqueArray(fc.constantFrom(...MODES), { minLength: 0, maxLength: 3 });

    test("selection agreement over random four-source intersections", { tags: "p1" }, async () => {
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

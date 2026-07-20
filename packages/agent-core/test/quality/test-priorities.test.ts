import { describe, expect, test } from "vitest";
import {
    discoverPriorityTestFiles,
    validatePriorityEvidence,
    validatePriorityLanes
} from "../../scripts/quality/test-priorities.mjs";
import { requireNonP2ConformanceEvidence } from "../../scripts/quality/test-priority-evidence.mjs";

describe("executed behavioral test priorities", () => {
    test("discovers native tag declarations as lane collection hints", async () => {
        const files = await discoverPriorityTestFiles();

        expect(files.p0).toEqual(
            expect.arrayContaining([
                "test/agents/runs/lease-state-machine.test.ts",
                "test/invocations/canonical-batch.test.ts"
            ])
        );
        expect(files.p1).toContain("test/environments/runtime.test.ts");
        expect(files.p2).toContain("test/agents/runs/lease.test.ts");
    });

    test("accepts disjoint, nonempty native P0/P1/P2 lanes", () => {
        const lanes = {
            p0: report([assertion("security behavior", ["p0"])]),
            p1: report([assertion("recovery behavior", ["p1"])]),
            p2: report([assertion("compatibility behavior", ["p2"])])
        };

        expect(validatePriorityLanes(lanes)).toEqual({ p0: 1, p1: 1, p2: 1 });
        expect(
            validatePriorityEvidence(
                report([
                    assertion("security behavior", ["p0"]),
                    assertion("recovery behavior", ["p1"]),
                    assertion("compatibility behavior", ["p2"]),
                    assertion("not classified yet", [])
                ]),
                lanes,
                "building"
            )
        ).toEqual({ p0: 1, p1: 1, p2: 1, unclassified: 1 });
    });

    test("requires complete classification at the final stage", () => {
        const lanes = {
            p0: report([assertion("security behavior", ["p0"])]),
            p1: report([assertion("recovery behavior", ["p1"])]),
            p2: report([assertion("compatibility behavior", ["p2"])])
        };

        expect(() =>
            validatePriorityEvidence(
                report([
                    assertion("security behavior", ["p0"]),
                    assertion("recovery behavior", ["p1"]),
                    assertion("compatibility behavior", ["p2"]),
                    assertion("not classified", [])
                ]),
                lanes,
                "final"
            )
        ).toThrow(/unclassified/);
    });

    test("rejects multiply tagged, empty, overlapping, and fabricated lane evidence", () => {
        expect(() =>
            validatePriorityLanes({
                p0: report([assertion("ambiguous", ["p0", "p1"])]),
                p1: report([assertion("ambiguous", ["p0", "p1"])]),
                p2: report([assertion("edge", ["p2"])])
            })
        ).toThrow(/exactly one priority/);

        expect(() =>
            validatePriorityLanes({
                p0: report([]),
                p1: report([assertion("recovery", ["p1"])]),
                p2: report([assertion("edge", ["p2"])])
            })
        ).toThrow(/P0 lane is empty/);

        const lanes = {
            p0: report([assertion("security", ["p0"])]),
            p1: report([assertion("recovery", ["p1"])]),
            p2: report([assertion("fabricated", ["p2"])])
        };
        expect(() =>
            validatePriorityEvidence(
                report([
                    assertion("security", ["p0"]),
                    assertion("recovery", ["p1"]),
                    assertion("edge", ["p2"])
                ]),
                lanes,
                "building"
            )
        ).toThrow(/absent from/);
    });

    test("uses native tags rather than filenames or title conventions", () => {
        const lanes = {
            p0: report([assertion("plain descriptive title", ["p0"], "ordinary.test.ts")]),
            p1: report([assertion("another title", ["p1"], "ordinary.test.ts")]),
            p2: report([assertion("[P0] text is not metadata", ["p2"], "ordinary.test.ts")])
        };

        expect(validatePriorityLanes(lanes)).toEqual({ p0: 1, p1: 1, p2: 1 });
    });

    test("rejects P2-only verified conformance evidence", () => {
        const selectors = {
            p0: ["test/security.test.ts#prevents authority expansion"],
            p1: ["test/runtime.test.ts#preserves the public contract"],
            p2: ["test/codec.test.ts#rejects an uncommon malformed encoding"]
        };

        expect(() =>
            requireNonP2ConformanceEvidence(
                "C13-EXAMPLE",
                ["test/codec.test.ts#rejects an uncommon malformed encoding"],
                selectors
            )
        ).toThrow(/relies only on P2/);
        expect(() =>
            requireNonP2ConformanceEvidence(
                "C13-EXAMPLE",
                [
                    "test/unclassified.test.ts#has no priority yet",
                    "test/codec.test.ts#rejects an uncommon malformed encoding"
                ],
                selectors
            )
        ).toThrow(/relies only on P2/);
        expect(() =>
            requireNonP2ConformanceEvidence(
                "C13-EXAMPLE",
                [
                    "test/runtime.test.ts#preserves the public contract",
                    "test/codec.test.ts#rejects an uncommon malformed encoding"
                ],
                selectors
            )
        ).not.toThrow();
    });
});

function assertion(title: string, tags: string[], path = "behavior.test.ts") {
    return { title, fullName: title, status: "passed", tags, meta: {}, path };
}

function report(assertions: ReturnType<typeof assertion>[]) {
    return {
        success: true,
        numTotalTests: assertions.length,
        numPassedTests: assertions.length,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: assertions.map((value) => ({
            name: `/repo/packages/agent-core/test/${value.path}`,
            assertionResults: [value]
        }))
    };
}

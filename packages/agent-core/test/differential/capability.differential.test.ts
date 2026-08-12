import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { encodeCanonicalJson, type JsonValue } from "../../src/core";
import { CapabilitySpec, type CapabilityIntent, type Impact } from "../../src/facets";
import { LeanOracle } from "./oracle";

/*
 * Differential testing of capability admission and attenuation (SPEC §3.3, §3.4 rule 2)
 * against the verified Lean model.
 *
 * The attenuation half is not a mirror check. `AgentCore.capability_covering_is_sound`
 * proves that when the model's decision says a delegation covers, the child admits no
 * intent the parent refuses — over the whole infinite intent domain — and
 * `AgentCore.glob_covering_iff_containment` proves the pattern layer is exactly glob
 * language containment. Agreement here is therefore agreement with the SPEC rule, not with
 * a restatement of the implementation's own check.
 *
 * Covering is a conjunction, and its other conjuncts mask the pattern layer under naive
 * random generation: a child whose impacts already exceed the parent's is refused before
 * the patterns are compared, and both sides then agree on a refusal that proves nothing.
 * The pattern sweeps below therefore hold every other conjunct trivially satisfied and
 * enumerate the pattern domain exhaustively, while the random sweeps draw Operations and
 * impacts from a two-element pool so that subset relations arise often enough for those
 * conjuncts to be compared rather than merely to refuse.
 *
 * The model represents an intent's arguments by their path projection rather than as a JSON
 * tree, so this harness projects each spec's constraint paths and hands the oracle the
 * canonical encoding found at each. The projection is written here independently of the
 * implementation's private `valueAtPath`, but both sides do resolve paths, so this suite
 * discriminates the decision and not the projection: a projection bug the two share would
 * pass. The Lean soundness theorem is stated over projections for the same reason, and the
 * boundary is recorded under AC-CAPABILITY-001.
 */

const IMPACTS: readonly Impact[] = [
    "observe",
    "mutate",
    "externalSend",
    "execute",
    "delegate",
    "administer"
];
const OPERATIONS = ["read", "write"] as const;
const CONSTRAINT_PATHS = ["tier", "a", "a.b"] as const;
const CONSTRAINT_VALUES: readonly JsonValue[] = ["gold", "silver", 12, true, null];

/** Every pattern over `{a, b, *}` up to four characters: 120 in all. */
const SWEEP_PATTERNS = enumerate(["a", "b", "*"], 4);
/** Every Facet name over `{a, b}` up to four characters, including the empty one. */
const SWEEP_FACETS = ["", ...enumerate(["a", "b"], 4)];

interface ProjectionEntry {
    readonly path: readonly string[];
    readonly value: string;
}

let oracle: LeanOracle;
beforeAll(() => {
    oracle = LeanOracle.start();
}, 900_000);
afterAll(() => {
    oracle?.stop();
});

describe("capability admission agrees with the verified model", () => {
    test(
        "admission agreement over every pattern and Facet name up to length four",
        { tags: "p0", timeout: 300_000 },
        async () => {
            for (const pattern of SWEEP_PATTERNS) {
                const spec = patternCapability(pattern);
                for (const facet of SWEEP_FACETS) {
                    const intent = facetIntent(facet);
                    const model = (
                        await oracle.ask({
                            op: "capability.matches",
                            capability: modelCapability(spec),
                            intent: modelIntent(spec, intent)
                        })
                    )["matches"];
                    expect(spec.matches(intent), `${pattern} matches ${facet}`).toBe(model);
                }
            }
        }
    );

    test(
        "admission agreement over random Operations, impacts, and constraints",
        { tags: "p0", timeout: 120_000 },
        async () => {
            await fc.assert(
                fc.asyncProperty(capabilityArbitrary, intentArbitrary, async (spec, intent) => {
                    const model = (
                        await oracle.ask({
                            op: "capability.matches",
                            capability: modelCapability(spec),
                            intent: modelIntent(spec, intent)
                        })
                    )["matches"];
                    expect(spec.matches(intent), `${spec.facetPattern} / ${intent.facet}`).toBe(
                        model
                    );
                }),
                { numRuns: 500 }
            );
        }
    );
});

describe("capability attenuation agrees with the verified model", () => {
    test(
        "covering agreement over every pattern pair up to length four",
        { tags: "p0", timeout: 600_000 },
        async () => {
            for (const parentPattern of SWEEP_PATTERNS) {
                const parent = patternCapability(parentPattern);
                for (const childPattern of SWEEP_PATTERNS) {
                    const child = patternCapability(childPattern);
                    const model = (
                        await oracle.ask({
                            op: "capability.covers",
                            parent: modelCapability(parent),
                            child: modelCapability(child)
                        })
                    )["covers"];
                    expect(parent.covers(child), `${parentPattern} covers ${childPattern}`).toBe(
                        model
                    );
                }
            }
        }
    );

    test(
        "covering agreement over random Operations, impacts, and constraints",
        { tags: "p0", timeout: 120_000 },
        async () => {
            await fc.assert(
                fc.asyncProperty(
                    capabilityArbitrary,
                    capabilityArbitrary,
                    async (parent, child) => {
                        const model = (
                            await oracle.ask({
                                op: "capability.covers",
                                parent: modelCapability(parent),
                                child: modelCapability(child)
                            })
                        )["covers"];
                        expect(
                            parent.covers(child),
                            `${parent.facetPattern} covers ${child.facetPattern}`
                        ).toBe(model);
                    }
                ),
                { numRuns: 500 }
            );
        }
    );

    test("an admitted attenuation admits no Facet the parent refuses", { tags: "p0" }, () => {
        // The executable reading of `capability_covering_is_sound`, asserted against the
        // implementation alone and exhaustively over the sweep domain: wherever the
        // implementation approves a delegation, no Facet name the child admits is refused
        // by the parent. A counterexample is a privilege escalation, which is exactly what
        // a prefix/suffix approximation of containment produces.
        let admitted = 0;
        for (const parentPattern of SWEEP_PATTERNS) {
            const parent = patternCapability(parentPattern);
            for (const childPattern of SWEEP_PATTERNS) {
                const child = patternCapability(childPattern);
                if (!parent.covers(child)) continue;
                admitted += 1;
                for (const facet of SWEEP_FACETS) {
                    const intent = facetIntent(facet);
                    if (!child.matches(intent)) continue;
                    expect(
                        parent.matches(intent),
                        `${parentPattern} covers ${childPattern} yet refuses ${facet}`
                    ).toBe(true);
                }
            }
        }
        expect(admitted).toBeGreaterThan(0);
    });
});

/** Every nonempty string over `alphabet` up to `maxLength` characters. */
function enumerate(alphabet: readonly string[], maxLength: number): readonly string[] {
    let level: readonly string[] = [""];
    const all: string[] = [];
    for (let length = 0; length < maxLength; length += 1) {
        level = level.flatMap((prefix) => alphabet.map((character) => prefix + character));
        all.push(...level);
    }
    return all;
}

/** A capability whose every conjunct but the Facet pattern is trivially satisfied. */
function patternCapability(pattern: string): CapabilitySpec {
    return new CapabilitySpec({ facetPattern: pattern, impacts: ["observe"] });
}

function facetIntent(facet: string): CapabilityIntent {
    return { facet, operation: "read", impact: "observe", arguments: {} };
}

const patternArbitrary = fc
    .array(fc.constantFrom("a", "b", ".", "*"), { minLength: 1, maxLength: 6 })
    .map((characters) => characters.join(""));

const facetNameArbitrary = fc
    .array(fc.constantFrom("a", "b", "."), { minLength: 0, maxLength: 6 })
    .map((characters) => characters.join(""));

const constraintEntriesArbitrary = fc.uniqueArray(
    fc.tuple(fc.constantFrom(...CONSTRAINT_PATHS), fc.constantFrom(...CONSTRAINT_VALUES)),
    { maxLength: 2, selector: ([path]) => path }
);

const capabilityArbitrary = fc
    .record({
        facetPattern: patternArbitrary,
        operations: fc.uniqueArray(fc.constantFrom(...OPERATIONS), { maxLength: 2 }),
        impacts: fc.uniqueArray(fc.constantFrom<Impact>("observe", "mutate"), {
            minLength: 1,
            maxLength: 2
        }),
        constraints: constraintEntriesArbitrary
    })
    .map(
        (init) =>
            new CapabilitySpec({
                facetPattern: init.facetPattern,
                operations: init.operations,
                impacts: init.impacts as [Impact, ...Impact[]],
                argumentConstraints: Object.fromEntries(init.constraints)
            })
    );

const intentArbitrary: fc.Arbitrary<CapabilityIntent> = fc.record({
    facet: facetNameArbitrary,
    operation: fc.constantFrom(...OPERATIONS),
    impact: fc.constantFrom(...IMPACTS),
    arguments: constraintEntriesArbitrary.map(nestPaths)
});

/** Canonical encoding of a value, as the implementation's own comparison sees it. */
function canonical(value: JsonValue): string {
    return new TextDecoder().decode(encodeCanonicalJson(value));
}

/** Build the arguments object that satisfies a list of dotted path constraints. */
function nestPaths(
    entries: readonly (readonly [string, JsonValue])[]
): Readonly<Record<string, JsonValue>> {
    const root: Record<string, JsonValue> = {};
    for (const [path, value] of entries) {
        const segments = path.split(".");
        let cursor = root;
        for (const segment of segments.slice(0, -1)) {
            const existing = cursor[segment];
            const child =
                existing !== undefined &&
                existing !== null &&
                typeof existing === "object" &&
                !Array.isArray(existing)
                    ? (existing as Record<string, JsonValue>)
                    : {};
            cursor[segment] = child;
            cursor = child;
        }
        cursor[segments[segments.length - 1]!] = value;
    }
    return root;
}

/** Resolve a dotted constraint path against an arguments object; undefined when absent. */
function resolvePath(
    args: Readonly<Record<string, JsonValue>>,
    path: string
): JsonValue | undefined {
    let current: JsonValue = args;
    for (const segment of path.split(".")) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
        }
        const next: JsonValue | undefined = (
            current as { readonly [key: string]: JsonValue | undefined }
        )[segment];
        if (next === undefined) return undefined;
        current = next;
    }
    return current;
}

function modelCapability(spec: CapabilitySpec): Record<string, unknown> {
    const constraints: ProjectionEntry[] = Object.entries(spec.argumentConstraints).map(
        ([path, value]) => ({ path: path.split("."), value: canonical(value) })
    );
    return {
        facetPattern: spec.facetPattern,
        operations: spec.operations,
        impacts: spec.impacts,
        constraints
    };
}

/** The intent's projection at exactly the paths the capability constrains. */
function modelIntent(spec: CapabilitySpec, intent: CapabilityIntent): Record<string, unknown> {
    const projection: ProjectionEntry[] = [];
    for (const path of Object.keys(spec.argumentConstraints)) {
        const resolved = resolvePath(intent.arguments, path);
        if (resolved !== undefined) {
            projection.push({ path: path.split("."), value: canonical(resolved) });
        }
    }
    return {
        facet: intent.facet,
        operation: intent.operation,
        impact: intent.impact,
        arguments: projection
    };
}

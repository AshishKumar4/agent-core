import { describe, expect, test } from "vitest";
import {
    IsolationMode,
    PlacementIntersection,
    admitsMode,
    preferredPlacement,
    requireList,
    type GeneratedData,
    type IsolationMode as IsolationModeValue,
    type Option
} from "../../src/facets/generated/placement/AgentCore/Extract/Placement";

/*
 * `src/facets/generated/placement/` is what the TSLean compiler lowers from the Lean
 * module the kernel checks, `formal/AgentCore/Extract/Placement.lean`. SPEC §9.2 derives
 * four admissible-mode sets independently — the Facet's manifest, the Blueprint's policy,
 * the substrate profile and the trust policy — intersects them, and serves the first
 * member of the intersection in one fixed preference order.
 *
 * test/definition/placement.test.ts drives the consumer, with its decoded and deduplicated
 * inputs and its typed unavailability. This suite drives the generated surface itself over
 * its whole domain: every subset of the vocabulary against every mode, all four sources
 * across the full 8^4 combination space, the intersection value and its codec, and the
 * list decoder the four sets arrive through. Every expectation is computed from SPEC §9.2's
 * statement rather than from the lowering, so the two cannot agree with each other and
 * both be wrong about the SPEC.
 */

/** The one fixed preference order (SPEC §9.2), which is also the whole vocabulary. */
const PREFERENCE: readonly IsolationModeValue[] = ["dynamic", "provider", "bundled"];

/** Every subset of the vocabulary, as a bit per mode in preference order. */
const MASKS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7];

function subset(mask: number): readonly IsolationModeValue[] {
    return PREFERENCE.filter((_mode, index) => (mask & (1 << index)) !== 0);
}


/** SPEC §9.2's preference: the first member of a set in the fixed order, or nothing. */
function firstAdmitted(modes: readonly IsolationModeValue[]): IsolationModeValue | "none" {
    return PREFERENCE.find((mode) => modes.includes(mode)) ?? "none";
}

function servedMode(next: Option<IsolationModeValue>): IsolationModeValue | "none" {
    return next.kind === "none" ? "none" : next.value;
}

function intersectionOf(modes: readonly IsolationModeValue[]): PlacementIntersection {
    return new PlacementIntersection({
        dynamic: modes.includes("dynamic"),
        provider: modes.includes("provider"),
        bundled: modes.includes("bundled")
    });
}


const NOT_MODE_DATA: readonly GeneratedData[] = [
    "",
    "Dynamic",
    "dynamic ",
    "isolate",
    "local",
    0,
    1,
    true,
    false,
    null,
    undefined,
    {},
    { mode: "dynamic" }
];

describe("the TSLean-generated placement lowering", () => {
    test(
        "[C13-PLACEMENT-INTERSECTION] answers membership per mode for every source set, whatever order it is listed in",
        { tags: "p1" },
        () => {
            for (const mask of MASKS) {
                const modes = subset(mask);
                for (const mode of PREFERENCE) {
                    expect(admitsMode(modes, mode)).toBe(modes.includes(mode));
                    // The same set listed backwards, with every member repeated, is the
                    // same set: membership never depends on the order a source happened
                    // to list its modes in, which is why it is decided per mode.
                    expect(admitsMode([...modes].reverse().concat([...modes]), mode)).toBe(
                        modes.includes(mode)
                    );
                }
            }
            // A source that admits nothing admits no mode.
            for (const mode of PREFERENCE) expect(admitsMode([], mode)).toBe(false);
        }
    );

    test(
        "[C13-PLACEMENT-ORDER] walks SPEC §9.2's one fixed preference order through every intersection",
        { tags: "p1" },
        () => {
            for (const mask of MASKS) {
                const modes = subset(mask);
                const intersection = intersectionOf(modes);

                // The served mode is the first member in the preference order, never the
                // first listed and never a second ordering's answer. An empty
                // intersection has no answer at all: there is no fallback, and the
                // caller rejects.
                expect(servedMode(intersection.preferred())).toBe(firstAdmitted(modes));
                expect(intersection.preferred().kind).toBe(mask === 0 ? "none" : "some");
            }
            expect(servedMode(intersectionOf(["provider", "bundled"]).preferred())).toBe("provider");
            expect(servedMode(intersectionOf(["bundled"]).preferred())).toBe("bundled");
            expect(servedMode(intersectionOf([]).preferred())).toBe("none");
        }
    );

    test(
        "[C13-PLACEMENT-INTERSECTION] [C13-PLACEMENT-ORDER] answers SPEC §9.2 end to end over all four sources and the whole combination space",
        { tags: "p0" },
        () => {
            // 8^4 combinations: every independently derived set against every other. The
            // reference intersection is membership over the vocabulary and the reference
            // answer is its first member in the fixed order, so a lowering that dropped
            // a source, reordered the preference, or served a mode outside the
            // intersection fails here.
            for (const manifest of MASKS) {
                for (const policy of MASKS) {
                    for (const substrate of MASKS) {
                        for (const trust of MASKS) {
                            const sources = [
                                subset(manifest),
                                subset(policy),
                                subset(substrate),
                                subset(trust)
                            ] as const;
                            const [fromManifest, fromPolicy, fromSubstrate, fromTrust] = sources;
                            const expected = firstAdmitted(
                                PREFERENCE.filter((mode) =>
                                    sources.every((source) => source.includes(mode))
                                )
                            );
                            const served = servedMode(
                                preferredPlacement(fromManifest, fromPolicy, fromSubstrate, fromTrust)
                            );

                            expect(served).toBe(expected);
                            if (served !== "none") {
                                // What is served is admitted by all four sources, or it
                                // was never admissible.
                                for (const source of sources) {
                                    expect(admitsMode(source, served)).toBe(true);
                                }
                            }
                        }
                    }
                }
            }
        }
    );

    test(
        "[C13-PLACEMENT-INTERSECTION] carries the intersection as a value the preference is applied to",
        { tags: "p1" },
        () => {
            // Admissible and preferred stay separate: the intersection is derived once
            // and survives the order being applied to it, which is what lets a caller
            // reject an empty one instead of being handed a fallback.
            const intersection = new PlacementIntersection({
                dynamic: false,
                provider: true,
                bundled: true
            });
            expect(intersection.dynamic).toBe(false);
            expect(intersection.provider).toBe(true);
            expect(intersection.bundled).toBe(true);
            expect(servedMode(intersection.preferred())).toBe("provider");
            expect(servedMode(intersection.preferred())).toBe("provider");

            // A placement derived once is shared, so the lowering freezes it: a holder
            // that could flip a member would move every other holder's answer.
            for (const mask of MASKS) {
                expect(Object.isFrozen(intersectionOf(subset(mask)))).toBe(true);
            }
        }
    );

    test(
        "[C13-PLACEMENT-INTERSECTION] round-trips intersection data and decides equality per member",
        { tags: "p1" },
        () => {
            const values = MASKS.map((mask) => intersectionOf(subset(mask)));

            for (const value of values) {
                const data = value.toData();
                // The record states exactly the three members: an extra one would be a
                // decision this value never made, and a missing one would be a mode
                // nobody decided about.
                expect(Object.keys(data).sort()).toEqual(["bundled", "dynamic", "provider"]);
                // The emitted record type states its three members exactly and carries
                // no index signature, so the fields cross back one by one — which is
                // also what proves `toData` reported all three and nothing else.
                const decoded = PlacementIntersection.fromData({
                    dynamic: data.dynamic,
                    provider: data.provider,
                    bundled: data.bundled
                });
                expect(decoded.equals(value)).toBe(true);
                // A record read back is the same decision, so it answers the same
                // preference — which is the point of carrying it as data at all.
                expect(servedMode(decoded.preferred())).toBe(servedMode(value.preferred()));
            }

            for (const left of values) {
                for (const right of values) {
                    // Equality is per member, over the whole 8×8 domain: a comparison
                    // that dropped a member would call two different placements equal.
                    expect(left.equals(right)).toBe(
                        left.dynamic === right.dynamic &&
                            left.provider === right.provider &&
                            left.bundled === right.bundled
                    );
                }
            }
        }
    );

    test(
        "[C13-PLACEMENT-INTERSECTION] refuses intersection data that is not exactly its three members",
        { tags: "p1" },
        () => {
            // A record with a member missing, a member added, or a member that is not a
            // boolean is not a decision anyone derived: defaulting one would place a
            // Facet where no source admitted it.
            const wrong: readonly GeneratedData[] = [
                {},
                { dynamic: true },
                { dynamic: true, provider: true },
                { dynamic: true, provider: true, bundled: true, trusted: true },
                { dynamic: true, provider: true, extra: true },
                [],
                ["dynamic"],
                "dynamic",
                1,
                true,
                null,
                undefined
            ];
            for (const value of wrong) {
                expect(() => PlacementIntersection.fromData(value)).toThrow(TypeError);
            }

            expect(() =>
                PlacementIntersection.fromData({ dynamic: 1, provider: true, bundled: true })
            ).toThrow(/PlacementIntersection dynamic must be a boolean/u);
            expect(() =>
                PlacementIntersection.fromData({ dynamic: true, provider: "false", bundled: true })
            ).toThrow(/PlacementIntersection provider must be a boolean/u);
            expect(() =>
                PlacementIntersection.fromData({ dynamic: true, provider: true, bundled: null })
            ).toThrow(/PlacementIntersection bundled must be a boolean/u);
            expect(() => PlacementIntersection.fromData("dynamic")).toThrow(
                /PlacementIntersection data must be an object/u
            );
            expect(() => PlacementIntersection.fromData([true, true, true])).toThrow(
                /PlacementIntersection data must be an object/u
            );
            expect(() => PlacementIntersection.fromData({ dynamic: true, extra: true })).toThrow(
                /PlacementIntersection data fields must be exactly dynamic, provider, bundled/u
            );
        }
    );

    test(
        "decodes a source's mode list through the generated decoders, and refuses what is not one",
        { tags: "p1" },
        () => {
            for (const mode of PREFERENCE) {
                expect(IsolationMode.fromData(mode)).toBe(mode);
            }
            for (const value of NOT_MODE_DATA) {
                // A mode outside the vocabulary is refused rather than defaulted: a
                // default would place a Package under a mode no profile offers.
                expect(() => IsolationMode.fromData(value)).toThrow(TypeError);
                expect(() => IsolationMode.fromData(value)).toThrow(/must name a IsolationMode/u);
            }

            expect(
                requireList<IsolationModeValue>(["bundled", "dynamic"], "substrate modes", (element) =>
                    IsolationMode.fromData(element)
                )
            ).toEqual(["bundled", "dynamic"]);

            // A source arrives as a list of the modes it admits; nothing else is one.
            for (const value of [0, 1, true, "dynamic", null, undefined, {}] as const) {
                expect(() =>
                    requireList<IsolationModeValue>(value, "substrate modes", (element) =>
                        IsolationMode.fromData(element)
                    )
                ).toThrow(/substrate modes must be an array/u);
            }

            // A hole is a member that is not there to read, so it is refused by index
            // rather than skipped; skipping would drop a mode a source declared.
            const holed: GeneratedData[] = ["dynamic", "provider"];
            holed.length = 3;
            expect(() =>
                requireList<IsolationModeValue>(holed, "substrate modes", (element) =>
                    IsolationMode.fromData(element)
                )
            ).toThrow(/substrate modes\[2\] is missing/u);

            // A member outside the vocabulary is refused by the element decoder, so the
            // list decoder neither swallows it nor renames it.
            expect(() =>
                requireList<IsolationModeValue>(
                    ["dynamic", "container"],
                    "substrate modes",
                    (element) => IsolationMode.fromData(element)
                )
            ).toThrow(/must name a IsolationMode/u);

            // Every member is handed to the decoder with the position it arrived at, so
            // a decoder that reports names says which member of which source failed
            // rather than only that one did.
            const named: string[] = [];
            expect(
                requireList<IsolationModeValue>(
                    ["dynamic", "provider"],
                    "manifest modes",
                    (element, name) => {
                        named.push(name);
                        return IsolationMode.fromData(element);
                    }
                )
            ).toEqual(["dynamic", "provider"]);
            expect(named).toEqual(["manifest modes[0]", "manifest modes[1]"]);
        }
    );

    test(
        "[C13-PLACEMENT-ORDER] serves a placement decided through the generated decoders",
        { tags: "p1" },
        () => {
            const decode = (value: GeneratedData): readonly IsolationModeValue[] =>
                requireList<IsolationModeValue>(value, "modes", (element) =>
                    IsolationMode.fromData(element)
                );

            // The four sets as they actually arrive — data, decoded by the generated
            // decoders, then answered end to end.
            expect(
                servedMode(
                    preferredPlacement(
                        decode(["dynamic", "bundled"]),
                        decode(["bundled", "provider", "dynamic"]),
                        decode([]),
                        decode(["bundled"])
                    )
                )
            ).toBe("none");
            expect(
                servedMode(
                    preferredPlacement(
                        decode(["dynamic", "bundled"]),
                        decode(["bundled", "provider", "dynamic"]),
                        decode(["bundled", "dynamic"]),
                        decode(["bundled"])
                    )
                )
            ).toBe("bundled");
            expect(
                servedMode(
                    preferredPlacement(
                        decode(["dynamic"]),
                        decode(["bundled", "provider", "dynamic"]),
                        decode(["bundled", "dynamic"]),
                        decode(["bundled", "dynamic"])
                    )
                )
            ).toBe("dynamic");
        }
    );
});

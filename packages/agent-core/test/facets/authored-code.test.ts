import { describe, expect, test } from "vitest";
import { ContentRef, Digest, JsonSchema } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    AuthoredCodeSource,
    BindingName,
    FacetRef,
    OperationAvailability,
    OperationDescriptor,
    OperationName,
    isFacetDataMap,
    type FacetDataMap
} from "../../src/facets";
import { AuthoredCodeCapability, AuthoredCodeCapabilitySet } from "../../src/operations";

const mailBinding = new BindingName("mail");
const mailFacet = new FacetRef("mail:instance");
const objectSchema = new JsonSchema({ type: "object" });

describe("Agent-authored code source", () => {
    test("carries its modules in canonical name order", { tags: "p1" }, () => {
        const source = new AuthoredCodeSource(
            "main.js",
            new Map([
                ["zeta.js", contentRef("zeta")],
                ["main.js", contentRef("main")],
                ["alpha.js", contentRef("alpha")]
            ])
        );

        expect([...source.modules.keys()]).toEqual(["alpha.js", "main.js", "zeta.js"]);
        expect(Object.keys(requireModules(source))).toEqual(["alpha.js", "main.js", "zeta.js"]);
    });

    test("names the empty module set apart from an unresolvable entry", { tags: "p1" }, () => {
        expect(() => new AuthoredCodeSource("main.js", new Map())).toThrow(
            "Agent-authored code must carry at least one module"
        );
        expect(
            () => new AuthoredCodeSource("main.js", new Map([["other.js", contentRef("other")]]))
        ).toThrow("Agent-authored code entry must name one of its own modules");
    });

    test("rejects blank and noncanonical module names", { tags: "p1" }, () => {
        const message = "Agent-authored code module names must be nonblank and canonical";
        expect(
            () =>
                new AuthoredCodeSource(
                    "main.js",
                    new Map([
                        ["main.js", contentRef("main")],
                        ["", contentRef("blank")]
                    ])
                )
        ).toThrow(message);
        expect(
            () =>
                new AuthoredCodeSource(
                    "main.js",
                    new Map([
                        ["main.js", contentRef("main")],
                        [" leading.js", contentRef("leading")]
                    ])
                )
        ).toThrow(message);
        expect(
            () =>
                new AuthoredCodeSource(
                    "main.js",
                    new Map([
                        ["main.js", contentRef("main")],
                        ["trailing.js ", contentRef("trailing")]
                    ])
                )
        ).toThrow(message);
    });

    test("rejects modules that are not content-addressed", { tags: "p1" }, () => {
        expect(
            () =>
                new AuthoredCodeSource(
                    "main.js",
                    // @ts-expect-error Module values are statically restricted to ContentRef.
                    new Map([["main.js", contentRef("main").value]])
                )
        ).toThrow("Agent-authored code modules must be content-addressed");
    });

    test(
        "names the offending field when decoded source is not string-shaped",
        { tags: "p1" },
        () => {
            expect(() =>
                AuthoredCodeSource.fromData({
                    entry: 7,
                    modules: { "main.js": contentRef("main").value }
                })
            ).toThrow("Agent-authored code entry must be a string");
            expect(() =>
                AuthoredCodeSource.fromData({ entry: "main.js", modules: { "main.js": 7 } })
            ).toThrow("Agent-authored code module main.js must be a string");
        }
    );
});

describe("Agent-authored code availability bound", () => {
    test(
        "[C13-FACET-CODE-AVAILABILITY] passes a code- and a both-available Operation into an isolate",
        { tags: "p0" },
        () => {
            const passed = new AuthoredCodeCapabilitySet([
                new AuthoredCodeCapability(mailBinding, mailFacet, undefined, [
                    declaredOperation("send", OperationAvailability.code),
                    declaredOperation("list", OperationAvailability.both)
                ])
            ]);

            const capability = passed.capability(mailBinding);
            expect(capability?.operations.map((entry) => entry.name.value)).toEqual([
                "send",
                "list"
            ]);
            expect(
                capability?.operations.every((entry) => entry.availability.reachableByAuthoredCode)
            ).toBe(true);
        }
    );

    test(
        "[C13-FACET-CODE-AVAILABILITY] refuses a passed set that names a native Operation rather than dropping it",
        { tags: "p0" },
        () => {
            const build = (): AuthoredCodeCapabilitySet =>
                new AuthoredCodeCapabilitySet([
                    new AuthoredCodeCapability(mailBinding, mailFacet, undefined, [
                        declaredOperation("send", OperationAvailability.code),
                        declaredOperation("purge", OperationAvailability.native)
                    ])
                ]);

            // Refused, not filtered: a set that quietly kept `send` and dropped `purge`
            // would be a catalog the model was offered and the isolate cannot reach.
            expect(build).toThrow(AgentCoreError);
            expect(build).toThrow(
                "Operation purge is declared native and is not passable to agent-authored code"
            );
        }
    );

    test(
        "[C13-FACET-CODE-AVAILABILITY] refuses the whole set when a second passed name carries the native Operation",
        { tags: "p0" },
        () => {
            expect(
                () =>
                    new AuthoredCodeCapabilitySet([
                        new AuthoredCodeCapability(mailBinding, mailFacet, undefined, [
                            declaredOperation("send", OperationAvailability.both)
                        ]),
                        new AuthoredCodeCapability(
                            new BindingName("secrets"),
                            new FacetRef("secrets:instance"),
                            undefined,
                            [declaredOperation("read", OperationAvailability.native)]
                        )
                    ])
            ).toThrow(
                "Operation read is declared native and is not passable to agent-authored code"
            );
        }
    );

    test(
        "[C13-FACET-CODE-AVAILABILITY] detaches the declared Operations a passed name conveys",
        { tags: "p1" },
        () => {
            const declared = [declaredOperation("send", OperationAvailability.code)];
            const capability = new AuthoredCodeCapability(
                mailBinding,
                mailFacet,
                undefined,
                declared
            );
            declared.push(declaredOperation("purge", OperationAvailability.native));

            // The screen the set ran cannot be widened after the fact by whatever the
            // capability was built from.
            expect(capability.operations.map((entry) => entry.name.value)).toEqual(["send"]);
            expect(new AuthoredCodeCapabilitySet([capability]).capability(mailBinding)).toBe(
                capability
            );
        }
    );

    test(
        "[C13-FACET-CODE-AVAILABILITY] freezes every availability singleton the codec tuples reach",
        { tags: "p1" },
        () => {
            // OperationDescriptor's codec reaches these three, and so now do the catalog
            // entry and Turn model input codecs that carry a descriptor, so a decoded
            // Operation hands out the same shared instances. A mutable one would let one
            // holder widen a native Operation into code mode for every other holder.
            for (const availability of [
                OperationAvailability.native,
                OperationAvailability.code,
                OperationAvailability.both
            ]) {
                expect(Object.isFrozen(availability)).toBe(true);
                expect(() => {
                    Object.defineProperty(availability, "label", { value: "tampered" });
                }).toThrow(TypeError);
                expect(OperationAvailability.fromData(availability.toData())).toBe(availability);
            }
            expect(OperationAvailability.native.reachableByAuthoredCode).toBe(false);
            expect(OperationAvailability.both.reachableByAuthoredCode).toBe(true);
        }
    );
});

function declaredOperation(name: string, availability: OperationAvailability): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName(name),
        "observe",
        objectSchema,
        objectSchema,
        undefined,
        undefined,
        availability
    );
}

function requireModules(source: AuthoredCodeSource): FacetDataMap {
    const data = source.toData();
    if (!isFacetDataMap(data) || !isFacetDataMap(data["modules"])) {
        throw new TypeError("Agent-authored code source data must carry a module object");
    }
    return data["modules"];
}

function contentRef(text: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(text)));
}

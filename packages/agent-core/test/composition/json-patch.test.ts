import { describe, expect, test } from "vitest";
import type { JsonValue } from "../../src/core";
import { DetachedJsonPatchEngine } from "../../src/composition/json-patch";
import { AgentCoreError } from "../../src/errors";

describe("detached RFC 6902 composition", () => {
    test("applies every standard operation with JSON Pointer escaping", () => {
        const engine = new DetachedJsonPatchEngine();
        const document = {
            list: ["first", "second"],
            object: { value: 1 },
            "escaped/path": { "~value": true }
        } as const;
        const patch: readonly JsonValue[] = [
            { op: "test", path: "/list/0", value: "first" },
            { op: "add", path: "/list/-", value: "third" },
            { op: "replace", path: "/object/value", value: 2 },
            { op: "copy", from: "/object/value", path: "/object/copy" },
            { op: "move", from: "/list/1", path: "/list/0" },
            { op: "remove", path: "/escaped~1path/~0value" }
        ];

        expect(engine.apply(document, patch)).toEqual({
            list: ["second", "first", "third"],
            object: { value: 2, copy: 2 },
            "escaped/path": {}
        });
    });

    test("keeps the source document and operations detached", () => {
        const engine = new DetachedJsonPatchEngine();
        const document = Object.freeze({
            nested: Object.freeze({ value: "original" }),
            list: Object.freeze(["kept"])
        });
        const operation = Object.freeze({
            op: "replace",
            path: "/nested/value",
            value: "changed"
        });
        const patch = Object.freeze([operation]);

        const result = engine.apply(document, patch);

        expect(result).toEqual({ nested: { value: "changed" }, list: ["kept"] });
        expect(result).not.toBe(document);
        expect(document).toEqual({ nested: { value: "original" }, list: ["kept"] });
        expect(patch).toEqual([operation]);
    });

    test.each([
        [{ op: "unknown", path: "/value" }],
        [{ op: "replace", value: true }],
        [{ op: "remove", path: "value" }],
        [{ op: "remove", path: "/missing" }],
        [{ op: "test", path: "/value", value: "forged" }],
        [{ op: "move", from: "/value", path: "/value/child" }]
    ] as const)("rejects malformed or inapplicable patch %#", (operation) => {
        expect(() =>
            new DetachedJsonPatchEngine().apply({ value: "original" }, [operation])
        ).toThrow(expect.objectContaining({ code: "codec.invalid" }));
    });

    test(
        "rejects malformed and inapplicable patches with the exact typed error",
        { tags: "p1" },
        () => {
            const engine = new DetachedJsonPatchEngine();
            const cases: readonly {
                readonly document: JsonValue;
                readonly patch: readonly JsonValue[];
            }[] = [
                { document: { value: "original" }, patch: [{ op: "unknown", path: "/value" }] },
                {
                    document: { value: "original" },
                    patch: [{ op: "test", path: "/value", value: "forged" }]
                },
                { document: {}, patch: [{ op: "add", path: "/__proto__/polluted", value: true }] },
                // A falsy document is validated structurally only, so an inapplicable
                // operation can only surface from the application step.
                { document: null, patch: [{ op: "remove", path: "/missing" }] },
                { document: null, patch: [{ op: "move", from: "/a", path: "/b" }] }
            ];

            for (const { document, patch } of cases) {
                let failure: unknown;
                try {
                    engine.apply(document, patch);
                } catch (error) {
                    failure = error;
                }
                expect(failure, JSON.stringify(patch)).toBeInstanceOf(AgentCoreError);
                expect(failure, JSON.stringify(patch)).toMatchObject({
                    code: "codec.invalid",
                    message: "Invalid RFC 6902 patch"
                });
            }
        }
    );

    test("rejects prototype modification without polluting global objects", () => {
        const patch: readonly JsonValue[] = [
            { op: "add", path: "/__proto__/polluted", value: true }
        ];

        expect(() => new DetachedJsonPatchEngine().apply({}, patch)).toThrow(
            expect.objectContaining({ code: "codec.invalid" })
        );
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
});

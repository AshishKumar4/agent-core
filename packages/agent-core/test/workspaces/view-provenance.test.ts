import { describe, expect, test } from "vitest";
import {
    decodeCanonicalJson,
    Digest,
    encodeCanonicalJson,
    isJsonObject,
    Revision,
    type JsonObject,
    type JsonValue
} from "../../src/core";
import { SurfaceId } from "../../src/facets";
import { EventCursor } from "../../src/workspaces/id";
import {
    View,
    ViewDelta,
    ViewMark,
    viewDocument,
    viewFromDocument
} from "../../src/workspaces/view";
import { DeterministicJsonPatchEngine, viewFixture } from "./fixtures";

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

function viewPayload(view: View): JsonObject {
    const envelope = decodeCanonicalJson(View.encode(view));
    if (!isJsonObject(envelope) || !isJsonObject(envelope["payload"])) {
        throw new TypeError("View envelope fixture changed shape");
    }
    return envelope["payload"];
}

function viewBytes(payload: JsonValue, major = 2): Uint8Array {
    return encodeCanonicalJson({
        kind: View.codec.kind,
        payload,
        version: { major, minor: 0 }
    });
}

function decisionView(): View {
    const base = viewFixture(0, "decision");
    return new View({
        ...base,
        body: {
            request: "delete the account",
            source: { "display/name": "Guest" }
        },
        intentDigest: digest("decision-intent"),
        marks: [
            new ViewMark("/source/display~1name", "authenticated"),
            new ViewMark("/request", "external")
        ]
    });
}

describe("View approval provenance", () => {
    test(
        "omits decision provenance from an ordinary View and its durable forms",
        { tags: "p0" },
        () => {
            const view = viewFixture(0, "ordinary");
            const payload = viewPayload(view);

            expect(Object.hasOwn(view, "intentDigest")).toBe(false);
            expect(Object.hasOwn(view, "marks")).toBe(false);
            expect(Object.hasOwn(payload, "intentDigest")).toBe(false);
            expect(Object.hasOwn(payload, "marks")).toBe(false);
            expect(View.encode(View.decode(View.encode(view)))).toEqual(View.encode(view));
            const document = viewDocument(view);
            if (!isJsonObject(document)) throw new TypeError("View document fixture changed shape");
            expect(Object.hasOwn(document, "intentDigest")).toBe(false);
            expect(Object.hasOwn(document, "marks")).toBe(false);
        }
    );

    test(
        "rejects every incomplete or nullable provenance shape without erasing marks",
        { tags: "p0" },
        () => {
            const ordinary = viewFixture(0, "malformed-provenance");
            const payload = viewPayload(ordinary);
            const intentDigest = digest("malformed-provenance").value;
            const mark = { path: "/count", tier: "external" };
            const malformed = [
                { ...payload, intentDigest },
                { ...payload, marks: [mark] },
                { ...payload, intentDigest: null, marks: null },
                { ...payload, intentDigest: null, marks: [mark] },
                { ...payload, intentDigest, marks: null }
            ] satisfies readonly JsonValue[];

            for (const candidate of malformed) {
                expect(() => View.decode(viewBytes(candidate))).toThrow(
                    expect.objectContaining({ code: "codec.invalid" })
                );
            }

            const delta = new ViewDelta({
                surface: ordinary.surface,
                baseRevision: ordinary.revision,
                revision: ordinary.revision.next(),
                patch: [],
                cursor: new EventCursor("cursor-malformed-provenance")
            });
            const document = viewDocument(ordinary);
            if (!isJsonObject(document)) throw new TypeError("View document fixture changed shape");
            const malformedDocuments = [
                { ...document, intentDigest },
                { ...document, marks: [mark] },
                { ...document, intentDigest: null, marks: null },
                { ...document, intentDigest: null, marks: [mark] },
                { ...document, intentDigest, marks: null }
            ] satisfies readonly JsonValue[];
            for (const candidate of malformedDocuments) {
                expect(() => viewFromDocument(ordinary, delta, candidate)).toThrow(TypeError);
            }
            expect(
                () =>
                    new View({
                        ...ordinary,
                        intentDigest: digest("missing-marks")
                    })
            ).toThrow(TypeError);
            expect(
                () =>
                    new View({
                        ...ordinary,
                        intentDigest: undefined,
                        marks: undefined
                    })
            ).toThrow(TypeError);
        }
    );

    test(
        "round-trips the exact intent and canonical body marks in codec major two",
        { tags: "p0" },
        () => {
            const view = decisionView();

            const marks = view.marks;
            if (marks === undefined) throw new TypeError("Expected decision View marks");
            expect(marks.map((mark) => [mark.path, mark.tier])).toEqual([
                ["/request", "external"],
                ["/source/display~1name", "authenticated"]
            ]);
            const encoded = View.encode(view);
            const envelope = decodeCanonicalJson(encoded);
            expect(isJsonObject(envelope) && isJsonObject(envelope["version"])).toBe(true);
            if (!isJsonObject(envelope) || !isJsonObject(envelope["version"])) {
                throw new TypeError("View envelope fixture changed shape");
            }
            const payload = viewPayload(view);
            expect(envelope["version"]).toEqual({ major: 2, minor: 0 });
            expect(Object.hasOwn(view, "intentDigest")).toBe(true);
            expect(Object.hasOwn(view, "marks")).toBe(true);
            expect(Object.hasOwn(payload, "intentDigest")).toBe(true);
            expect(Object.hasOwn(payload, "marks")).toBe(true);
            expect(View.encode(View.decode(encoded))).toEqual(encoded);
            expect(() => View.decode(viewBytes(payload, 1))).toThrow(
                expect.objectContaining({ code: "codec.unknown-major" })
            );
            const intentDigest = view.intentDigest;
            if (intentDigest === undefined) throw new TypeError("Expected a decision View");
            expect(View.decode(encoded).intentDigest?.equals(intentDigest)).toBe(true);
        }
    );

    test("accepts escaped pointers that resolve to exact body values", { tags: "p0" }, () => {
        const base = viewFixture(0, "escaped-mark");
        const value = new View({
            ...base,
            body: { "a/b": { "~": "marked" } },
            intentDigest: digest("escaped-mark"),
            marks: [new ViewMark("/a~1b/~0", "owner")]
        });

        expect(value.marks?.[0]).toEqual(new ViewMark("/a~1b/~0", "owner"));
    });

    test(
        "resolves root, arrays, and prototype-named own values with exact-node overlap semantics",
        { tags: "p0" },
        () => {
            const base = viewFixture(0, "pointer-matrix");
            const body = decodeCanonicalJson(
                new TextEncoder().encode(
                    '{"-":4,"__proto__":{"value":1},"constructor":{"value":2},"dictionary":{"01":"object-key"},"items":[{"name":"first"}],"parent":{"child":true},"prototype":{"value":3}}'
                )
            );
            const marks = [
                new ViewMark("/parent/child", "authenticated"),
                new ViewMark("/prototype/value", "owner"),
                new ViewMark("", "external"),
                new ViewMark("/-", "self"),
                new ViewMark("/items/0/name", "self"),
                new ViewMark("/dictionary/01", "external"),
                new ViewMark("/constructor/value", "authenticated"),
                new ViewMark("/parent", "external"),
                new ViewMark("/__proto__/value", "owner")
            ];
            const value = new View({
                ...base,
                body,
                intentDigest: digest("pointer-matrix"),
                marks
            });

            marks.push(new ViewMark("/items", "owner"));
            expect(value.marks?.map((mark) => mark.path)).toEqual([
                "",
                "/-",
                "/__proto__/value",
                "/constructor/value",
                "/dictionary/01",
                "/items/0/name",
                "/parent",
                "/parent/child",
                "/prototype/value"
            ]);
            expect(value.marks?.[0]).not.toBe(marks[2]);
            expect(Object.isFrozen(value.marks)).toBe(true);
            expect(Object.isFrozen(value.marks?.[0])).toBe(true);
            if (!isJsonObject(value.body)) throw new TypeError("View body fixture changed shape");
            expect(Object.hasOwn(value.body, "__proto__")).toBe(true);
            expect(Object.getPrototypeOf(value.body)).toBe(Object.prototype);
        }
    );

    test("rejects non-resolving and noncanonical array paths", { tags: "p0" }, () => {
        const base = viewFixture(0, "array-pointer-errors");
        for (const path of [
            "/items/-",
            "/items/01",
            "/items/1",
            "/items/9007199254740992",
            "/items/0/missing",
            "/items/0/name/child"
        ]) {
            expect(
                () =>
                    new View({
                        ...base,
                        body: { items: [{ name: "first" }] },
                        intentDigest: digest("array-pointer-errors"),
                        marks: [new ViewMark(path, "external")]
                    })
            ).toThrow(/does not resolve/);
        }
    });

    test("rejects malformed, duplicate, missing, and ordinary-View marks", { tags: "p0" }, () => {
        const base = viewFixture(0, "invalid-mark");
        const intentDigest = digest("invalid-mark");

        for (const path of ["request", "/request~", "/request~2value"]) {
            expect(() => new ViewMark(path, "external")).toThrow(TypeError);
        }
        expect(
            () =>
                // @ts-expect-error Unknown trust vocabulary must also fail at runtime.
                new ViewMark("/count", "trusted")
        ).toThrow(TypeError);
        expect(
            () =>
                new View({
                    ...base,
                    intentDigest,
                    marks: [new ViewMark("/missing", "external")]
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new View({
                    ...base,
                    intentDigest,
                    marks: [
                        new ViewMark("/count", "external"),
                        new ViewMark("/count", "authenticated")
                    ]
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new View({
                    ...base,
                    marks: [new ViewMark("/count", "external")]
                })
        ).toThrow(TypeError);
    });

    test(
        "carries intent and marks through the same ViewDelta document replay",
        { tags: "p0" },
        () => {
            const previous = decisionView();
            const nextIntent = digest("next-decision-intent");
            const delta = new ViewDelta({
                surface: previous.surface,
                baseRevision: previous.revision,
                revision: previous.revision.next(),
                patch: [
                    { op: "replace", path: "/body/request", value: "rotate the key" },
                    { op: "replace", path: "/intentDigest", value: nextIntent.value },
                    {
                        op: "replace",
                        path: "/marks",
                        value: [{ path: "/request", tier: "authenticated" }]
                    }
                ],
                cursor: new EventCursor("cursor-decision-1")
            });
            const engine = new DeterministicJsonPatchEngine();

            const replayed = viewFromDocument(
                previous,
                delta,
                engine.apply(viewDocument(previous), delta.patch)
            );

            expect(replayed).toMatchObject({
                surface: new SurfaceId("surface-decision"),
                revision: new Revision(1),
                body: {
                    request: "rotate the key",
                    source: { "display/name": "Guest" }
                }
            });
            expect(replayed.intentDigest?.equals(nextIntent)).toBe(true);
            expect(replayed.marks).toEqual([new ViewMark("/request", "authenticated")]);
        }
    );
});

import { describe, expect, test } from "vitest";
import { decodeCanonicalJson, Digest, isJsonObject, Revision } from "../../src/core";
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
            expect(envelope["version"]).toEqual({ major: 2, minor: 0 });
            expect(View.encode(View.decode(encoded))).toEqual(encoded);
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

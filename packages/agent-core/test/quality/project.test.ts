import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
    assertUniqueIds,
    parseCanonicalJson,
    readCanonicalJson,
    readJson
} from "../../scripts/quality/project.mjs";

// The ACQ-OUTCOME incident: a merge that kept both sides of a conflicted hunk
// produced two top-level "edition" keys and two top-level "rules" arrays in
// artifacts/quality/rules.json. JSON.parse silently kept the second occurrence
// of each and discarded the first — along with the rule it carried, ACQ-OUTCOME
// — and every checker that read the file through JSON.parse reported 14 clean
// rules instead of noticing 15 had shrunk to 14. These tests re-enact exactly
// that shape and prove the strict loader refuses it instead of laundering it.
function conflictedRulesDocument() {
    // Both sides of the resolved hunk were kept, so both "edition" and "rules"
    // occur twice; the parser reports the first duplicate it reaches, which
    // scanning left to right is "edition" — the second "rules" occurrence is
    // never even reached, exactly as it would not have been noticed by eye.
    const oursHunk = `{"edition":"1.0.0","rules":[{"id":"ACQ-OUTCOME","node":"outcome"}]`;
    const theirsHunk = `"edition":"1.0.1","rules":[{"id":"ACQ-OTHER","node":"other"}]}`;
    return `${oursHunk},${theirsHunk}`;
}

function conflictedRulesArrayOnlyDocument() {
    // Isolates the "rules" duplication specifically, as if only that hunk of
    // the merge conflict had been resolved by keeping both sides.
    const oursHunk = `{"edition":"1.0.0","rules":[{"id":"ACQ-OUTCOME","node":"outcome"}]`;
    const theirsHunk = `"rules":[{"id":"ACQ-OTHER","node":"other"}]}`;
    return `${oursHunk},${theirsHunk}`;
}

function resolvedRulesDocument() {
    return JSON.stringify(
        {
            edition: "1.0.1",
            rules: [
                { id: "ACQ-OUTCOME", node: "outcome" },
                { id: "ACQ-OTHER", node: "other" }
            ]
        },
        null,
        2
    );
}

describe("strict canonical JSON parsing", () => {
    test("parses well-formed JSON identically to JSON.parse", () => {
        const source = JSON.stringify({
            edition: "1.0.0",
            rules: [{ id: "A" }, { id: "B" }],
            nested: { a: 1, b: [1, 2, { c: true, d: null }] }
        });
        expect(parseCanonicalJson(source, "fixture.json")).toEqual(JSON.parse(source));
    });

    test("refuses the exact incident shape: two top-level rules arrays merged as sibling keys", () => {
        const conflicted = conflictedRulesDocument();
        // Confirms the fixture really does reproduce the incident against the
        // native parser first: JSON.parse resolves it and silently drops ACQ-OUTCOME.
        const lastWins = JSON.parse(conflicted) as { rules: Array<{ id: string }> };
        expect(lastWins.rules.map((rule) => rule.id)).toEqual(["ACQ-OTHER"]);

        expect(() => parseCanonicalJson(conflicted, "artifacts/quality/rules.json")).toThrow(
            /Duplicate key "edition" .* in artifacts\/quality\/rules\.json/
        );
    });

    test("names the rules key itself when only the rules array is duplicated", () => {
        const conflicted = conflictedRulesArrayOnlyDocument();
        const lastWins = JSON.parse(conflicted) as { rules: Array<{ id: string }> };
        expect(lastWins.rules.map((rule) => rule.id)).toEqual(["ACQ-OTHER"]);

        expect(() => parseCanonicalJson(conflicted, "artifacts/quality/rules.json")).toThrow(
            /Duplicate key "rules" .* in artifacts\/quality\/rules\.json/
        );
    });

    test("passes once the duplicate is resolved, keeping every rule", () => {
        const resolved = resolvedRulesDocument();
        const value = parseCanonicalJson(resolved, "artifacts/quality/rules.json") as {
            rules: Array<{ id: string }>;
        };
        expect(value.rules.map((rule) => rule.id)).toEqual(["ACQ-OUTCOME", "ACQ-OTHER"]);
    });

    test("names the file for a duplicated top-level key", () => {
        expect(() =>
            parseCanonicalJson('{"edition":"1.0.0","edition":"1.0.1"}', "agents-compliance.json")
        ).toThrow(/Duplicate key "edition" .* in agents-compliance\.json/);
    });

    test("names the key and its path for a duplicate nested inside an array", () => {
        expect(() =>
            parseCanonicalJson('{"rules":[{"id":"A"},{"id":"B","id":"C"}]}', "rules.json")
        ).toThrow(/Duplicate key "id" at \$\.rules\[1\] in rules\.json/);
    });

    test("does not flag repeated values under different keys, only repeated keys", () => {
        expect(() =>
            parseCanonicalJson('{"a":"x","b":"x","c":["x","x"]}', "fixture.json")
        ).not.toThrow();
    });

    test("rejects malformed JSON with a located, file-named error", () => {
        expect(() => parseCanonicalJson('{"a":1,}', "fixture.json")).toThrow(/fixture\.json/);
        expect(() => parseCanonicalJson("", "empty.json")).toThrow(/empty\.json/);
        expect(() => parseCanonicalJson('{"a":1} trailing', "fixture.json")).toThrow(
            /trailing content/
        );
    });
});

describe("readCanonicalJson and readJson refuse duplicate keys on disk", () => {
    test("readCanonicalJson refuses a rules.json carrying the incident's duplicate rules key", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "agent-core-strict-json-"));
        try {
            const path = resolve(root, "rules.json");
            await writeFile(path, conflictedRulesArrayOnlyDocument(), "utf8");
            // portablePath renders the failing file relative to the repository root; from
            // a temp directory outside the repo that is a "../.../rules.json" path, so the
            // assertion only pins the filename, not the full relative prefix.
            await expect(readCanonicalJson(path)).rejects.toThrow(
                /Duplicate key "rules" .*rules\.json/
            );

            await writeFile(path, resolvedRulesDocument(), "utf8");
            const value = (await readCanonicalJson(path)) as { rules: Array<{ id: string }> };
            expect(value.rules.map((rule) => rule.id)).toEqual(["ACQ-OUTCOME", "ACQ-OTHER"]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("readJson refuses the same duplicate-key document", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "agent-core-strict-json-"));
        try {
            const path = resolve(root, "agents-compliance.json");
            await writeFile(path, conflictedRulesArrayOnlyDocument(), "utf8");
            await expect(readJson(path)).rejects.toThrow(/Duplicate key "rules"/);

            await writeFile(path, resolvedRulesDocument(), "utf8");
            await expect(readJson(path)).resolves.toMatchObject({ edition: "1.0.1" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("assertUniqueIds", () => {
    test("passes an array whose ids are unique", () => {
        const rules = [{ id: "ACQ-OUTCOME" }, { id: "ACQ-OTHER" }];
        expect(
            assertUniqueIds(rules, (rule: { id: string }) => rule.id, "quality/rules.json rules")
        ).toBe(rules);
    });

    test("refuses two array entries that shadow one id, even with distinct JSON keys", () => {
        // This is the array-entry analog of the incident: no duplicated object
        // key survives to trip parseCanonicalJson, but reducing the array to a
        // Set/Map keyed by id would still silently let the second entry win.
        const rules = [
            { id: "ACQ-OUTCOME", node: "outcome" },
            { id: "ACQ-OUTCOME", node: "outcome-relaxed" }
        ];
        expect(() =>
            assertUniqueIds(rules, (rule: { id: string }) => rule.id, "quality/rules.json rules")
        ).toThrow(/quality\/rules\.json rules contains duplicate id ACQ-OUTCOME/);
    });
});

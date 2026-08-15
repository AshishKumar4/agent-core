import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { canonicalSpec, specRequirements } from "../../scripts/quality/spec.mjs";
const packageRoot = resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
let original: string;
let originalRequirements: Awaited<ReturnType<typeof specRequirements>>;

beforeAll(async () => {
    original = await readFile(resolve(packageRoot, "SPEC.md"), "utf8");
    originalRequirements = await specRequirements();
});

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe("SPEC Markdown model", () => {
    test("ignores atomic labels in fenced examples and comments", async () => {
        const source = original.replace(
            "## 13. Conformance",
            [
                "<!-- **C13-AUTH-COMMENT** is not normative. -->",
                "",
                "```md",
                "**C13-AUTH-EXAMPLE** is not normative.",
                "```",
                "",
                "## 13. Conformance"
            ].join("\n")
        );

        expect(await specRequirements(await specFixture(source))).toEqual(originalRequirements);
    });

    test("rejects raw HTML and comments that split conformance labels", async () => {
        const bodies = [
            "- **<span>C13-AUTH-REAL</span>** The real requirement.",
            "- <span>**C13-AUTH-REAL**</span> The real requirement.",
            "- **C13-AUTH-<!--split-->REAL** The real requirement.",
            "- **C13-AUTH-REAL** The <!--inline--> requirement."
        ];
        for (const body of bodies) {
            const source = original.replace(
                "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
                body
            );
            await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(/raw HTML/);
        }

        const block = original.replace(
            "## 13. Conformance",
            "<div>\n- **C13-AUTH-HTML** A hidden requirement.\n</div>\n\n## 13. Conformance"
        );
        await expect(canonicalSpec(await specFixture(block))).rejects.toThrow(/raw HTML/);
    });

    test("ignores non-structural profile labels outside the profile section", async () => {
        const path = await specFixture(
            original.replace(
                "## 11. Profiles",
                [
                    "<!-- - **P11-FAKE-COMMENT** A non-normative comment. -->",
                    "",
                    "```md",
                    "- **P11-FAKE-FENCED** A non-normative example.",
                    "```",
                    "",
                    "## 11. Profiles"
                ].join("\n")
            )
        );

        const requirements = await specRequirements(path);
        expect(requirements).toEqual(originalRequirements);
    });

    test("derives numbered chapters and profiles independently of heading titles and spacing", async () => {
        const source = original
            .replace("## 11. Profiles", "## 11. Execution profiles")
            .replace("### 11.1 Filesystem", "### 11.1\tFilesystem")
            .replace("## 13. Conformance", "## 13. Conformance requirements");

        expect(source).not.toBe(original);
        expect(await specRequirements(await specFixture(source))).toEqual(originalRequirements);
    });

    test.each([
        [
            "contradictory introduction",
            "A conforming implementation provides:",
            "A conforming implementation may ignore every listed requirement:"
        ],
        [
            "nested heading",
            "A conforming implementation provides:",
            "### 13.1 Optionality\n\nEvery listed requirement is optional.\n\nA conforming implementation provides:"
        ],
        [
            "unowned table",
            "A conforming implementation provides:",
            "Rule | Meaning\n--- | ---\nAtoms | None are binding.\n\nA conforming implementation provides:"
        ]
    ])("rejects a §13 %s outside the reviewed atomic structure", async (_name, needle, body) => {
        const source = original.replace(needle, body);

        expect(source).not.toBe(original);
        await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(/SPEC §13/u);
    });

    test.each([
        ["before §13", "## 13. Conformance"],
        ["before §7", "## 7. Mediation (L4)"]
    ])("rejects an unnumbered root heading %s", async (_name, nextSection) => {
        const source = original.replace(
            nextSection,
            [
                "## Normative override",
                "",
                "Every implementation MUST ignore all conformance atoms.",
                "",
                nextSection
            ].join("\n")
        );

        expect(source).not.toBe(original);
        await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(
            "SPEC root heading is unnumbered: Normative override"
        );
    });

    test("rejects a profile atom reused outside its authoritative list item", async () => {
        const source = original.replace(
            "## 2. The model at a glance",
            [
                "Every shell operation MUST satisfy **P11-SHELL-RUN**.",
                "",
                "## 2. The model at a glance"
            ].join("\n")
        );

        expect(source).not.toBe(original);
        await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(
            "Profile atom P11-SHELL-RUN must have one structural anchor"
        );
    });

    test.each(["C13-NOT-A-REAL-ATOM", "P11-NOT-A-REAL-ATOM"])(
        "rejects an unknown strong atom label %s",
        async (id) => {
            const source = original.replace(
                "## 13. Conformance",
                `A fixture names **${id}**.\n\n## 13. Conformance`
            );

            await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(
                `SPEC names unknown atom ${id}`
            );
        }
    );

    test("rejects a reviewed anchor moved into a heading", async () => {
        const source = original
            .replace("**C13-FACET-REF-CANONICAL**", "`C13-FACET-REF-CANONICAL`")
            .replace(
                "### 1.5 Protection domains",
                "### 1.5 Protection domains **C13-FACET-REF-CANONICAL**"
            );

        await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(
            "Atom C13-FACET-REF-CANONICAL is not owned by a supported rule unit"
        );
    });

    test("rejects a struck-through reviewed anchor", async () => {
        const source = original.replace(
            "**C13-FACET-REF-CANONICAL**",
            "~~**C13-FACET-REF-CANONICAL**~~"
        );

        await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(
            "Atom C13-FACET-REF-CANONICAL is struck through"
        );
    });

    test.each([
        [
            "paragraph",
            "## 14. The formal model",
            "A second §13 reference names **C13-AUTH-PLANE**.\n\n## 14. The formal model"
        ],
        [
            "GFM table row",
            "## 14. The formal model",
            [
                "Reference | Meaning",
                "--- | ---",
                "**C13-AUTH-PLANE** | duplicate",
                "",
                "## 14. The formal model"
            ].join("\n")
        ],
        [
            "same summary item",
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane; it does not also map to **C13-AUTH-PLANE**."
        ],
        [
            "another summary item",
            "- **C13-AUTH-PRINCIPAL-REF** Security-sensitive Principal references are tenant-qualified and exact-matched.",
            "- **C13-AUTH-PRINCIPAL-REF** Security-sensitive Principal references are tenant-qualified and exact-matched; this is not **C13-AUTH-PLANE**."
        ],
        [
            "contradictory wrapped prose",
            "## 14. The formal model",
            "The preceding summaries explicitly exclude [**C13-AUTH-PLANE**](#not-a-map).\n\n## 14. The formal model"
        ]
    ])("rejects a duplicate C13 anchor in a §13 %s", async (_name, needle, replacement) => {
        const source = original.replace(needle, replacement);

        await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(
            /SPEC §13|Conformance atom C13-AUTH-PLANE must have exactly one leading §13 summary anchor/u
        );
    });

    test("rejects conformance labels after the conformance section", async () => {
        const afterConformance = (label: string): string =>
            original.replace(
                "## 14. The formal model",
                `## 14. The formal model\n\nPost-conformance **${label}** reference.`
            );
        const reviewed = afterConformance("C13-AUTH-PRINCIPAL-REF");
        const sectionOnly = afterConformance("C13-ADV-STALE-LEASE");

        await expect(specRequirements(await specFixture(reviewed))).rejects.toBeInstanceOf(
            TypeError
        );
        await expect(specRequirements(await specFixture(sectionOnly))).rejects.toBeInstanceOf(
            TypeError
        );
    });

    test("preserves UTF-16 offsets while masking emoji in comments and fences", async () => {
        const source = original.replace(
            "## 1. Introduction",
            [
                "<!-- 😀 **P11-SHELL-RUN** is not an anchor. -->",
                "",
                "~~~md",
                "😀 **P11-SHELL-RUN** is not an anchor.",
                "~~~",
                "",
                "## 1. Introduction"
            ].join("\n")
        );
        const parsed = await canonicalSpec(await specFixture(source));
        const laterAnchors = parsed.anchors
            .filter((anchor) => anchor.id === "P11-SHELL-RUN")
            .map((anchor) => source.slice(anchor.start, anchor.end));

        expect(source).not.toBe(original);
        expect(laterAnchors).toContain("**P11-SHELL-RUN**");
    });

    test("exports rendered blocks and structurally nested section ranges", async () => {
        const source = original.replace(
            "## 11. Profiles",
            [
                "> ### 10.97 Quoted",
                "",
                "- ### 10.98 Listed",
                "",
                "###\t10.99 Fixture",
                "",
                "W**7** refers to §8.**99**.",
                "",
                "## 11. Profiles"
            ].join("\n")
        );
        const parsed = await canonicalSpec(await specFixture(source));
        const heading = parsed.headings.find((candidate) => candidate.prose === "10.99 Fixture");
        const section = parsed.sections.find((candidate) => candidate.id === "10.99");
        if (heading === undefined || section === undefined) {
            throw new TypeError("Fixture section was not parsed");
        }

        expect(heading).toMatchObject({ depth: 3, prose: "10.99 Fixture" });
        expect(section).toMatchObject({
            depth: 3,
            start: heading.start,
            bodyStart: heading.end
        });
        expect(source.slice(section.start, section.bodyStart)).toBe("###\t10.99 Fixture");
        expect(source.slice(section.end)).toMatch(/^## 11\. Profiles/u);
        expect(parsed.visibleBlocks).toContainEqual(
            expect.objectContaining({ prose: "W7 refers to §8.99." })
        );
        expect(parsed.headings.map((candidate) => candidate.prose)).not.toContain("10.97 Quoted");
        expect(parsed.headings.map((candidate) => candidate.prose)).not.toContain("10.98 Listed");
        expect(parsed.normativeSections).toContain("10.99");
        expect(parsed.normativeSections).not.toContain("10.97");
        expect(parsed.normativeSections).not.toContain("10.98");
        expect(parsed.normativeKeywords).toEqual(["MUST", "SHOULD", "MAY"]);
        expect(parsed.unsupportedBlocks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ prose: "10.97 Quoted" }),
                expect.objectContaining({ prose: "10.98 Listed" })
            ])
        );
    });

    test("rejects empty or reversed normative section ranges", async () => {
        for (const replacement of [
            "Sections 1.4, 1.5, and 10–2 are normative;",
            "Sections 1.4, 1.5, 2–10, and 8.5–3.1 are normative;",
            "Sections 1.4, 1.5, and 20–30 are normative;"
        ]) {
            const source = original.replace(
                "Sections 1.4, 1.5, and 2–10 are normative;",
                replacement
            );

            await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(
                "SPEC §1.3 names an empty or reversed section range"
            );
        }
    });

    test("expands forward dotted normative section ranges by structural order", async () => {
        const source = original.replace(
            "Sections 1.4, 1.5, and 2–10 are normative;",
            "Sections 1.4, 1.5, 2–10, and 3.1–3.3 are normative;"
        );

        expect(source).not.toBe(original);
        expect(await specRequirements(await specFixture(source))).toEqual(originalRequirements);
    });

    test("rejects raw HTML and comments that split profile labels", async () => {
        const bodies = [
            "- **<span>P11-SHELL-CANCEL</span>** The real profile rule.",
            "- <span>**P11-SHELL-CANCEL**</span> The real profile rule.",
            "- **P11-SHELL-<!--split-->CANCEL** The real profile rule.",
            "- **P11-SHELL-CANCEL** The <!--inline--> profile rule."
        ];
        for (const body of bodies) {
            const source = original.replace(
                "- **P11-SHELL-CANCEL** Operation `cancel` has `mutate` impact.",
                body
            );
            await expect(specRequirements(await specFixture(source))).rejects.toThrow(/raw HTML/);
        }

        const block = original.replace(
            "## 11. Profiles",
            "## 11. Profiles\n\n<div>\n- **P11-BASE-HTML** A hidden profile rule.\n</div>"
        );
        await expect(specRequirements(await specFixture(block))).rejects.toThrow(/raw HTML/);
    });

    test("recognizes a leading strong conformance label through transparent wrappers", async () => {
        const labels = [
            { label: "**[C13-AUTH-PLANE](#authority-rule)**", linked: true },
            { label: "[**C13-AUTH-PLANE**](#authority-rule)", linked: true },
            { label: "***C13-AUTH-PLANE***", linked: false },
            { label: "*[**C13-AUTH-PLANE**](#authority-rule)*", linked: true }
        ];
        const expected = originalRequirements.find(
            (requirement) => requirement.id === "C13-AUTH-PLANE"
        );
        if (expected === undefined) throw new TypeError("Fixture conformance atom is missing");
        for (const { label, linked } of labels) {
            const source = original.replace(
                "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
                `- ${label} One durable allow/deny Grant plane.`
            );
            expect(source).not.toBe(original);
            const parsed = await canonicalSpec(await specFixture(source));
            const actual = parsed.atoms.find((atom) => atom.id === "C13-AUTH-PLANE");

            expect(actual).toMatchObject({ id: expected.id, owner: expected.owner });
            expect(actual?.digest === expected.digest).toBe(!linked);
        }
    });

    test("recognizes a leading strong profile label through transparent wrappers", async () => {
        const labels = [
            { label: "**[P11-SHELL-CANCEL](#profile-rule)**", linked: true },
            { label: "[**P11-SHELL-CANCEL**](#profile-rule)", linked: true },
            { label: "***P11-SHELL-CANCEL***", linked: false },
            { label: "*[**P11-SHELL-CANCEL**](#profile-rule)*", linked: true }
        ];
        const expected = originalRequirements.find(
            (requirement) => requirement.id === "P11-SHELL-CANCEL"
        );
        if (expected === undefined) throw new TypeError("Fixture profile atom is missing");
        for (const { label, linked } of labels) {
            const source = original.replace("**P11-SHELL-CANCEL**", label);
            const requirements = await specRequirements(await specFixture(source));
            const actual = requirements.find(
                (requirement) => requirement.id === "P11-SHELL-CANCEL"
            );

            expect(actual).toMatchObject({ id: expected.id, owner: expected.owner });
            expect(actual?.digest === expected.digest).toBe(!linked);
        }
    });

    test("recognizes standard reference links around leading atomic labels", async () => {
        const source = `${original
            .replace(
                "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
                "- [**C13-AUTH-PLANE**][authority-rule] One durable allow/deny Grant plane."
            )
            .replace(
                "- **P11-SHELL-CANCEL** Operation `cancel` has `mutate` impact.",
                "- [**P11-SHELL-CANCEL**][profile-rule] Operation `cancel` has `mutate` impact."
            )}\n[authority-rule]: #authority-rule\n[profile-rule]: #profile-rule\n`;
        const requirements = await specRequirements(await specFixture(source));

        for (const id of ["C13-AUTH-PLANE", "P11-SHELL-CANCEL"]) {
            const actual = requirements.find((requirement) => requirement.id === id);
            const expected = originalRequirements.find((requirement) => requirement.id === id);
            expect(actual).toMatchObject({ id: expected?.id, owner: expected?.owner });
            expect(actual?.digest).not.toBe(expected?.digest);
        }
    });

    test.each([
        [
            "duplicate",
            "## 14. The formal model",
            "A duplicate [**C13-AUTH-PLANE**][fixture].\n\n## 14. The formal model",
            /SPEC §13|exactly one leading §13 summary anchor/u
        ],
        [
            "unknown",
            "## 13. Conformance",
            "An unknown [**C13-NOT-A-REAL-ATOM**][fixture].\n\n## 13. Conformance",
            /SPEC names unknown atom C13-NOT-A-REAL-ATOM/u
        ],
        [
            "struck",
            "**C13-FACET-REF-CANONICAL**",
            "[~~**C13-FACET-REF-CANONICAL**~~][fixture]",
            /Atom C13-FACET-REF-CANONICAL is struck through/u
        ]
    ])("rejects a %s atom through a reference link", async (_name, needle, replacement, error) => {
        const source = `${original.replace(needle, replacement)}\n[fixture]: #fixture\n`;

        await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(error);
    });

    test.each([
        [
            "struck-through conformance label content",
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
            "- **~~C13-AUTH-PLANE~~** One durable allow/deny Grant plane."
        ],
        [
            "inline-code conformance label content",
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
            "- **`C13-AUTH-PLANE`** One durable allow/deny Grant plane."
        ],
        [
            "image-bearing conformance label content",
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
            "- **C13-AUTH-PLANE![No durable plane exists.](fixture.svg)** One durable allow/deny Grant plane."
        ],
        [
            "image-bearing profile label content",
            "- **P11-SHELL-CANCEL** Operation `cancel` has `mutate` impact.",
            "- **P11-SHELL-CANCEL![Cancellation is optional.](fixture.svg)** Operation `cancel` has `mutate` impact."
        ]
    ])("rejects %s", async (_name, needle, replacement) => {
        const source = original.replace(needle, replacement);

        expect(source).not.toBe(original);
        await expect(canonicalSpec(await specFixture(source))).rejects.toThrow(
            /unsupported label markup|unlabeled atomic requirement/u
        );
    });

    test("binds reference-definition titles to exactly the referencing atom", async () => {
        const id = "C13-AUTH-PLANE";
        const referenced = `${original.replace(
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
            "- [**C13-AUTH-PLANE**][authority-rule] One durable allow/deny Grant plane."
        )}\n[authority-rule]: #authority-rule "Reviewed authority title"\n`;
        const changed = referenced.replace("Reviewed authority title", "Changed authority title");
        const baseline = await specRequirements(await specFixture(referenced));
        const after = await specRequirements(await specFixture(changed));
        const baselineById = new Map(
            baseline.map((requirement) => [requirement.id, requirement.digest])
        );

        expect(
            after
                .filter((requirement) => baselineById.get(requirement.id) !== requirement.digest)
                .map((requirement) => requirement.id)
        ).toEqual([id]);
    });

    test.each([
        [
            "inline conformance label",
            "C13-AUTH-PLANE",
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
            (url: string) => `- [**C13-AUTH-PLANE**](${url}) One durable allow/deny Grant plane.`
        ],
        [
            "inline profile label",
            "P11-SHELL-CANCEL",
            "- **P11-SHELL-CANCEL** Operation `cancel` has `mutate` impact.",
            (url: string) =>
                `- [**P11-SHELL-CANCEL**](${url}) Operation \`cancel\` has \`mutate\` impact.`
        ]
    ])("binds an %s URL to exactly its atom", async (_name, id, summary, linked) => {
        const before = original.replace(summary, linked("https://example.test/required"));
        const after = original.replace(summary, linked("https://example.test/optional"));
        const baseline = await specRequirements(await specFixture(before));
        const changed = await specRequirements(await specFixture(after));
        const baselineById = new Map(
            baseline.map((requirement) => [requirement.id, requirement.digest])
        );

        expect(
            changed
                .filter((requirement) => baselineById.get(requirement.id) !== requirement.digest)
                .map((requirement) => requirement.id)
        ).toEqual([id]);
    });

    test("binds a reference-definition URL to exactly the referencing atom", async () => {
        const id = "C13-AUTH-PLANE";
        const before = `${original.replace(
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
            "- [**C13-AUTH-PLANE**][authority-rule] One durable allow/deny Grant plane."
        )}\n[authority-rule]: https://example.test/required\n`;
        const after = before.replace("example.test/required", "example.test/optional");
        const baseline = await specRequirements(await specFixture(before));
        const changed = await specRequirements(await specFixture(after));
        const baselineById = new Map(
            baseline.map((requirement) => [requirement.id, requirement.digest])
        );

        expect(
            changed
                .filter((requirement) => baselineById.get(requirement.id) !== requirement.digest)
                .map((requirement) => requirement.id)
        ).toEqual([id]);
    });

    test("binds a reference-definition URL in evidence to exactly its atom", async () => {
        const id = "C13-AUTH-PLANE";
        const before = `${original.replace(
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
            "- **C13-AUTH-PLANE** One durable [allow/deny Grant plane][authority-plane]."
        )}\n[authority-plane]: https://example.test/required\n`;
        const after = before.replace("example.test/required", "example.test/optional");
        const baseline = await specRequirements(await specFixture(before));
        const changed = await specRequirements(await specFixture(after));
        const baselineById = new Map(
            baseline.map((requirement) => [requirement.id, requirement.digest])
        );

        expect(
            changed
                .filter((requirement) => baselineById.get(requirement.id) !== requirement.digest)
                .map((requirement) => requirement.id)
        ).toEqual([id]);
    });

    test.each([
        ["strong", (title: string) => `**[C13-AUTH-PLANE](#authority-rule "${title}")**`],
        [
            "emphasis and strong",
            (title: string) => `***[C13-AUTH-PLANE](#authority-rule "${title}")***`
        ]
    ])("binds an inline-link title nested inside %s label markup", async (_name, label) => {
        const summary = "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.";
        const source = original.replace(
            summary,
            `- ${label("Reviewed authority title")} One durable allow/deny Grant plane.`
        );
        const changed = source.replace("Reviewed authority title", "Changed authority title");
        const baseline = await specRequirements(await specFixture(source));
        const after = await specRequirements(await specFixture(changed));
        const baselineById = new Map(
            baseline.map((requirement) => [requirement.id, requirement.digest])
        );

        expect(
            after
                .filter((requirement) => baselineById.get(requirement.id) !== requirement.digest)
                .map((requirement) => requirement.id)
        ).toEqual(["C13-AUTH-PLANE"]);
    });

    test.each([
        ["strong", "**[C13-AUTH-PLANE][authority-rule]**"],
        ["emphasis and strong", "***[C13-AUTH-PLANE][authority-rule]***"]
    ])("binds a reference-link title nested inside %s label markup", async (_name, label) => {
        const summary = "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.";
        const source = `${original.replace(
            summary,
            `- ${label} One durable allow/deny Grant plane.`
        )}\n[authority-rule]: #authority-rule "Reviewed authority title"\n`;
        const changed = source.replace("Reviewed authority title", "Changed authority title");
        const baseline = await specRequirements(await specFixture(source));
        const after = await specRequirements(await specFixture(changed));
        const baselineById = new Map(
            baseline.map((requirement) => [requirement.id, requirement.digest])
        );

        expect(
            after
                .filter((requirement) => baselineById.get(requirement.id) !== requirement.digest)
                .map((requirement) => requirement.id)
        ).toEqual(["C13-AUTH-PLANE"]);
    });

    test("binds each conformance summary to exactly its corresponding atom evidence", async () => {
        const id = "C13-AUTH-PLANE";
        const source = original.replace(
            "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
            "- **C13-AUTH-PLANE** No durable allow/deny Grant plane exists."
        );
        const changed = await specRequirements(await specFixture(source));
        const baselineById = new Map(
            originalRequirements.map((requirement) => [requirement.id, requirement.digest])
        );
        const changedIds = changed
            .filter((requirement) => baselineById.get(requirement.id) !== requirement.digest)
            .map((requirement) => requirement.id);

        expect(source).not.toBe(original);
        expect(changedIds).toEqual([id]);
    });

    test("exposes each atom's source-local structural digest", async () => {
        const parsed = await canonicalSpec();

        expect(parsed.atoms.length).toBeGreaterThan(0);
        expect(parsed.atoms.every((atom) => /^sha256:[0-9a-f]{64}$/u.test(atom.sourceDigest))).toBe(
            true
        );
    });

    test("binds structurally adjacent GFM tables without a leading pipe", async () => {
        const before = relocateAtoms(
            `
Case | Outcome
--- | ---
valid | admitted

This table maps to **C13-FACET-REF-CANONICAL**.
`,
            ["C13-FACET-REF-CANONICAL"]
        );
        const after = before.replace("valid | admitted", "valid | denied");

        expect(await atomDigest(after, "C13-FACET-REF-CANONICAL")).not.toBe(
            await atomDigest(before, "C13-FACET-REF-CANONICAL")
        );
    });

    test("gives each tight list item its own atom digest", async () => {
        const before = relocateAtoms(
            `
- First rule maps to **C13-AUTH-PRINCIPAL-REF**.
- Second rule maps to **C13-FACET-REF-CANONICAL**.
`,
            ["C13-AUTH-PRINCIPAL-REF", "C13-FACET-REF-CANONICAL"]
        );
        const after = before.replace("Second rule", "Changed second rule");
        const baseline = await atomDigests(before, [
            "C13-AUTH-PRINCIPAL-REF",
            "C13-FACET-REF-CANONICAL"
        ]);
        const changed = await atomDigests(after, [
            "C13-AUTH-PRINCIPAL-REF",
            "C13-FACET-REF-CANONICAL"
        ]);

        expect(baseline[0]).not.toBe(baseline[1]);
        expect(changed[0]).toBe(baseline[0]);
        expect(changed[1]).not.toBe(baseline[1]);
    });

    test("gives nested list items source-local atom digests", async () => {
        const ids = ["C13-AUTH-PRINCIPAL-REF", "C13-FACET-REF-CANONICAL"];
        const before = relocateAtoms(
            `
- Parent rule maps to **C13-AUTH-PRINCIPAL-REF**.
  - Child rule maps to **C13-FACET-REF-CANONICAL**.
`,
            ids
        );
        const parentChanged = before.replace("Parent rule", "Changed parent rule");
        const childChanged = before.replace("Child rule", "Changed child rule");
        const baseline = await atomDigests(before, ids);
        const afterParent = await atomDigests(parentChanged, ids);
        const afterChild = await atomDigests(childChanged, ids);

        expect(afterParent[0]).not.toBe(baseline[0]);
        expect(afterParent[1]).toBe(baseline[1]);
        expect(afterChild[0]).toBe(baseline[0]);
        expect(afterChild[1]).not.toBe(baseline[1]);
    });

    test.each([
        ["conformance", "- **C13-AUTH-PLANE** One durable allow/deny Grant plane."],
        ["profile", "- **P11-SHELL-CANCEL** Operation `cancel` has `mutate` impact."]
    ])("rejects unlabeled nested list prose in an atomic %s item", async (_name, summary) => {
        const source = original.replace(
            summary,
            `${summary}\n  - Contradiction: the parent requirement does not hold.`
        );

        expect(source).not.toBe(original);
        await expect(specRequirements(await specFixture(source))).rejects.toThrow(
            "SPEC atomic requirements cannot contain nested list items"
        );
    });

    test("gives each GFM table row its own atom digest", async () => {
        const before = relocateAtoms(
            `
Rule | Atom
--- | ---
first | **C13-AUTH-PRINCIPAL-REF**
second | **C13-FACET-REF-CANONICAL**
`,
            ["C13-AUTH-PRINCIPAL-REF", "C13-FACET-REF-CANONICAL"]
        );
        const after = before.replace("second |", "changed | ");
        const baseline = await atomDigests(before, [
            "C13-AUTH-PRINCIPAL-REF",
            "C13-FACET-REF-CANONICAL"
        ]);
        const changed = await atomDigests(after, [
            "C13-AUTH-PRINCIPAL-REF",
            "C13-FACET-REF-CANONICAL"
        ]);

        expect(baseline[0]).not.toBe(baseline[1]);
        expect(changed[0]).toBe(baseline[0]);
        expect(changed[1]).not.toBe(baseline[1]);
    });

    test("binds table headers to every row without coupling sibling rows", async () => {
        const ids = ["C13-AUTH-PRINCIPAL-REF", "C13-FACET-REF-CANONICAL"];
        const before = relocateAtoms(
            `
Rule | Atom
--- | ---
first | **C13-AUTH-PRINCIPAL-REF**
second | **C13-FACET-REF-CANONICAL**
`,
            ids
        );
        const headerChanged = before.replace("Rule | Atom", "Requirement | Atom");
        const rowChanged = before.replace("second |", "changed | ");
        const baseline = await atomDigests(before, ids);
        const afterHeader = await atomDigests(headerChanged, ids);
        const afterRow = await atomDigests(rowChanged, ids);

        expect(afterHeader[0]).not.toBe(baseline[0]);
        expect(afterHeader[1]).not.toBe(baseline[1]);
        expect(afterRow[0]).toBe(baseline[0]);
        expect(afterRow[1]).not.toBe(baseline[1]);
    });

    test.each([
        ["a standalone comment", "<!-- review note -->"],
        ["a reference definition", "[review-note]: https://example.test/review"]
    ])("keeps a mapped table adjacent across %s", async (_name, separator) => {
        const before = relocateAtoms(
            `
Case | Outcome
--- | ---
valid | admitted

${separator}

This table maps to **C13-FACET-REF-CANONICAL**.
`,
            ["C13-FACET-REF-CANONICAL"]
        );
        const after = before.replace("valid | admitted", "valid | denied");

        expect(await atomDigest(after, "C13-FACET-REF-CANONICAL")).not.toBe(
            await atomDigest(before, "C13-FACET-REF-CANONICAL")
        );
    });

    test("normalizes harmless line wrapping without changing an atom digest", async () => {
        const compact = relocateAtoms(
            `
**C13-FACET-REF-CANONICAL** A real normative requirement.
`,
            ["C13-FACET-REF-CANONICAL"]
        );
        const wrapped = compact.replace(
            "A real normative requirement.",
            "A real normative\nrequirement."
        );

        expect(await atomDigest(wrapped, "C13-FACET-REF-CANONICAL")).toBe(
            await atomDigest(compact, "C13-FACET-REF-CANONICAL")
        );
    });
});

function relocateAtoms(body: string, ids: readonly string[]): string {
    const source = ids.reduce((current, id) => current.replace(`**${id}**`, `\`${id}\``), original);
    return source.replace(
        "\n---\n\n## 2. The model at a glance",
        `\n${body}\n---\n\n## 2. The model at a glance`
    );
}

async function atomDigests(source: string, ids: readonly string[]): Promise<string[]> {
    const parsed = await canonicalSpec(await specFixture(source));
    return ids.map((id) => {
        const digest = parsed.atoms.find((atom) => atom.id === id)?.digest;
        if (digest === undefined) throw new TypeError(`Fixture atom ${id} is missing`);
        return digest;
    });
}

async function atomDigest(source: string, id: string): Promise<string> {
    const [digest] = await atomDigests(source, [id]);
    if (digest === undefined) throw new TypeError(`Fixture atom ${id} is missing`);
    return digest;
}

async function specFixture(source: string): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-spec-parser-"));
    temporary.push(root);
    const path = resolve(root, "SPEC.md");
    await writeFile(path, source, "utf8");
    return path;
}

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeAll, afterEach, describe, expect, test } from "vitest";
import {
    type QualitySubprocessResult,
    runQualitySubprocess,
    subprocessTestOptions
} from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/coherence.mjs");
const temporary: string[] = [];
let original: string;

beforeAll(async () => {
    original = await readFile(resolve(packageRoot, "SPEC.md"), "utf8");
});

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe("SPEC coherence rules", subprocessTestOptions, () => {
    test("stays green at HEAD against the committed baseline", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, "--stage", "building"],
            packageRoot
        );

        expect(result.status, result.stderr).toBe(0);
        // 61 baselined join findings: 49 citations carrying the wrong label or none, and
        // 12 atoms whose labels no citation of theirs carries. Debt, not an allowance —
        // a finding that stops reproducing must leave the baseline or this goes red.
        expect(result.stdout).toContain("coherence incomplete: 61 issue(s), 0 resolved");
    });

    test("binds bracketed atom labels in test titles and nowhere else", async () => {
        const unbound = await fixture({
            tests: {
                "bad.test.ts": 'describe("[C13-NOT-AN-ATOM] fixture", () => {});\n'
            }
        });
        const unboundResult = run(unbound);
        expect(unboundResult.status).toBe(1);
        expect(unboundResult.stderr).toContain("COH-TEST-LABEL:test/bad.test.ts:C13-NOT-AN-ATOM");

        const bound = await fixture({
            tests: {
                "good.test.ts": [
                    "// [P11-NOT-A-PROFILE] prose in a comment names no atom.",
                    'const label = "[NC-NOT-A-CLAIM]";',
                    'describe("[C13-AUTH-PLANE] grants", () => {',
                    '    it.each([1])("[P11-SHELL-RUN] runs %i", () => label);',
                    "});"
                ].join("\n")
            }
        });
        const boundResult = run(bound);
        expect(boundResult.status, boundResult.stderr).toBe(0);
        expect(boundResult.stderr).not.toContain("COH-TEST-LABEL");
    });

    test("rejects invalid profile labels before admitting them to the known set", async () => {
        const wrongFamily = await fixture({
            spec: original.replace(
                "- **P11-SHELL-CANCEL** Operation `cancel` has `mutate` impact.",
                "- **P11-WEB-CANCEL** Operation `cancel` has `mutate` impact."
            ),
            tests: {
                "wrong-family.test.ts":
                    'test("[P11-WEB-CANCEL] is not a Shell profile atom", () => {});\n'
            }
        });
        const wrongFamilyResult = run(wrongFamily);
        expect(wrongFamilyResult.status).toBe(1);
        expect(wrongFamilyResult.stderr).toContain(
            "SPEC profile label P11-WEB-CANCEL is outside family SHELL"
        );

        const duplicate = await fixture({
            spec: original.replace(
                "- **P11-SHELL-CANCEL** Operation `cancel` has `mutate` impact.",
                [
                    "- **P11-SHELL-FIXTURE** First duplicate fixture label.",
                    "- **P11-SHELL-FIXTURE** Second duplicate fixture label."
                ].join("\n")
            ),
            tests: {
                "duplicate.test.ts":
                    'test("[P11-SHELL-FIXTURE] names a duplicated profile atom", () => {});\n'
            }
        });
        const duplicateResult = run(duplicate);
        expect(duplicateResult.status).toBe(1);
        expect(duplicateResult.stderr).toContain("SPEC contains duplicate atomic labels");
    });

    test("rejects wave codenames outside the allowlisted example and code", async () => {
        const leaked = await fixture({
            spec: original.replace(
                "The order is always the same: identify,",
                "The W7 order is always the same: identify,"
            )
        });
        const leakedResult = run(leaked);
        expect(leakedResult.status).toBe(1);
        expect(leakedResult.stderr).toContain(
            "Undefined wave codename W7 in §1.4 visible SPEC prose"
        );

        // The §3.3 Grant-precedence example names Workspaces W1 and W2, which the
        // allowlisted sentence exempts, so the injected §1.4 leak above is the only
        // codename the leaked fixture reports.
        expect(leakedResult.stderr).not.toContain("§3.3 visible SPEC prose");

        const fenced = await fixture({
            spec: original
                .replace(
                    "The order is always the same: identify,",
                    "The W8 order is always the same: identify,"
                )
                .replace(
                    "```ts\ninterface PathEpochEvidence {",
                    "```ts\n// W7 names an example, not prose\ninterface PathEpochEvidence {"
                )
        });
        const fencedResult = run(fenced);
        expect(fencedResult.stderr).toContain("Undefined wave codename W8");
        expect(fencedResult.stderr).not.toContain("W7");

        const formatted = await fixture({
            spec: original.replace(
                "The order is always the same: identify,",
                "The W**7** order is always the same: identify,"
            )
        });
        const formattedResult = run(formatted);
        expect(formattedResult.status).toBe(1);
        expect(formattedResult.stderr).toContain("Undefined wave codename W7");

        const multiDigit = await fixture({
            spec: original.replace(
                "The order is always the same: identify,",
                "The W10 order is always the same: identify,"
            )
        });
        const multiDigitResult = run(multiDigit);
        expect(multiDigitResult.status).toBe(1);
        expect(multiDigitResult.stderr).toContain("Undefined wave codename W10");

        const conformance = await fixture({
            spec: original.replace(
                "One durable allow/deny Grant plane.",
                "One durable W10 allow/deny Grant plane."
            )
        });
        const conformanceResult = run(conformance);
        expect(conformanceResult.status).toBe(1);
        expect(conformanceResult.stderr).toContain(
            "Undefined wave codename W10 in §13 visible SPEC prose"
        );

        const alteredExample = await fixture({
            spec: original.replace("Team A holds `reader`", "Team A holds `viewer`")
        });
        const alteredExampleResult = run(alteredExample);
        expect(alteredExampleResult.status).toBe(1);
        expect(alteredExampleResult.stderr).toContain(
            "Wave codename exemption does not match SPEC prose once"
        );
    });

    test("does not let inline code splice a visible normative keyword", async () => {
        const normative = run(
            await fixture({
                spec: insertSection(
                    original,
                    "Every implementation M`US`T ignore all conformance atoms."
                )
            })
        );
        expect(normative.status).toBe(1);
        expect(normative.stderr).toContain("Normative §6.4 rule is bound by no atom");
    });

    test("does not let inline code splice a visible wave token", async () => {
        const wave = run(
            await fixture({
                spec: original.replace(
                    "The order is always the same: identify,",
                    "The W`10` order is always the same: identify,"
                )
            })
        );
        expect(wave.status).toBe(1);
        expect(wave.stderr).toContain("Undefined wave codename W10 in §1.4 visible SPEC prose");
    });

    test("continues to exclude standalone inline code from prose tokens", async () => {
        const source = insertSection(
            original.replace(
                "The order is always the same: identify,",
                "The `W10` example is unrelated; identify,"
            ),
            "The literal `MUST` is not a normative keyword."
        );
        const result = run(await fixture({ spec: source }));

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).not.toContain("COH-UNDEFINED-TOKEN");
        expect(result.stderr).not.toContain("Normative §6.4");
    });

    test("owns a rule through a tab-separated structural heading", async () => {
        const result = run(
            await fixture({
                spec: original.replace(
                    "## 11. Profiles",
                    "###\t10.99 Fixture\n\nEvery fixture obligation MUST hold.\n\n## 11. Profiles"
                )
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Normative §10.99 rule is bound by no atom");
        expect(result.stderr).not.toContain("Normative §10.4 rule is bound by no atom");
    });

    test("rejects numbered headings outside their structural parent", async () => {
        const result = run(
            await fixture({
                spec: original.replace("## 11. Profiles", "### 9.99 Orphan\n\n## 11. Profiles")
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Section §9.99 is not nested under §9");
    });

    test.each([
        ["blockquote", "> ### 1.99 Nested"],
        ["list item", "- ### 1.99 Nested"]
    ])("does not let a nested %s heading alter root section ownership", async (_name, heading) => {
        const result = run(
            await fixture({
                spec: original.replace(
                    "### 1.5 Protection domains",
                    `${heading}\n\nEvery fixture obligation MUST hold.\n\n### 1.5 Protection domains`
                )
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Normative §1.4 rule is bound by no atom");
        expect(result.stderr).not.toContain("Normative §1.99");
    });

    test("rejects an authoritative atom moved outside the declared normative sections", async () => {
        const result = run(
            await fixture({
                spec: original.replace(
                    "Identifiers ending in `Id` or `Name`",
                    [
                        "### 1.99 Informative fixture",
                        "",
                        "Identifiers ending in `Id` or `Name`"
                    ].join("\n")
                )
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "Authoritative normative atom C13-AUTH-PRINCIPAL-REF is anchored in non-normative §1.99"
        );
    });

    test("rejects a malformed numbered heading instead of accepting its valid prefix", async () => {
        const result = run(
            await fixture({
                spec: original.replace(
                    "## 10. The Cloudflare profile (normative)",
                    "## 10..1 The Cloudflare profile (normative)"
                )
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "SPEC heading is malformed: 10..1 The Cloudflare profile (normative)"
        );
    });

    test("reports normative sections that no conformance atom binds", async () => {
        const unbound = await fixture({
            spec: insertSection(original, "Every fixture obligation MUST hold.")
        });
        const unboundResult = run(unbound);
        expect(unboundResult.status).toBe(1);
        expect(unboundResult.stderr).toContain("Normative §6.4 carries no conformance atom");

        const bound = await fixture({
            spec: insertSection(
                relocateFixtureAnchor(original),
                "Every fixture obligation MUST hold. This maps to **C13-FACET-REF-CANONICAL**."
            )
        });
        const boundResult = run(bound);
        expect(boundResult.status, boundResult.stderr).toBe(0);
        expect(boundResult.stderr).not.toContain("§6.4");
        expect(boundResult.stderr).not.toContain("Normative §5.2 carries no conformance atom");
    });

    test.each([
        ["standalone comment", "Every fixture obligation MUST hold.\n<!-- **P11-SHELL-RUN** -->"],
        [
            "tilde-fenced example",
            "Every fixture obligation MUST hold.\n~~~md\n**P11-SHELL-RUN**\n~~~"
        ],
        ["indented code", "    **P11-SHELL-RUN**\nEvery fixture obligation MUST hold."]
    ])("does not accept an atom inside %s as a normative anchor", async (_name, body) => {
        const result = run(await fixture({ spec: insertSection(original, body) }));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Normative §6.4 rule is bound by no atom");
    });

    test.each([
        ["blockquote", "Every fixture obligation MUST hold.\n> **P11-SHELL-NOT-REAL**"],
        ["plus-list item", "Every fixture obligation MUST hold.\n+ **P11-SHELL-NOT-REAL**"],
        [
            "parenthesized list item",
            "Every fixture obligation MUST hold.\n1) **P11-SHELL-NOT-REAL**"
        ],
        ["heading", "Every fixture obligation MUST hold.\n#### **P11-SHELL-NOT-REAL**"],
        [
            "no-leading-pipe table row",
            [
                "Every fixture obligation MUST hold.",
                "Anchor | Meaning",
                "--- | ---",
                "**P11-SHELL-NOT-REAL** | Example only"
            ].join("\n")
        ]
    ])("rejects an unknown atom in a following %s", async (_name, body) => {
        const result = run(await fixture({ spec: insertSection(original, body) }));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("SPEC names unknown atom P11-SHELL-NOT-REAL");
    });

    test.each([
        ["strong", "Every fixture M**UST** hold."],
        ["emphasis", "Every fixture M*UST* hold."],
        ["link", "Every fixture M[UST](#keyword) hold."]
    ])("recognizes a normative keyword split by transparent %s markup", async (_name, body) => {
        const result = run(await fixture({ spec: insertSection(original, body) }));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Normative §6.4 rule is bound by no atom");
    });

    test.each([
        ["link", '[Fixture](#fixture "Every fixture MUST hold.")', "Every fixture MUST hold."],
        [
            "image",
            '![Fixture](fixture.svg "Every fixture SHOULD hold.")',
            "Every fixture SHOULD hold."
        ],
        [
            "reference definition",
            '[Fixture][fixture]\n\n[fixture]: #fixture "Every fixture MUST hold."',
            "Every fixture MUST hold."
        ]
    ])("owns normative prose in a %s title", async (_name, body, title) => {
        const result = run(await fixture({ spec: insertSection(original, body) }));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Normative §6.4 rule is bound by no atom");
        expect(result.stderr).toContain(title);
    });

    test.each([
        [
            "heading",
            "#### Every fixture MUST hold.\n\nThis maps nowhere.",
            "heading is not a supported rule unit"
        ],
        [
            "formatted heading",
            "#### Every fixture M**UST** hold.\n\nThis maps nowhere.",
            "heading is not a supported rule unit"
        ],
        [
            "image alternative text",
            "![Every fixture MUST hold.](fixture.svg)\n\nThis maps nowhere.",
            "rule is bound by no atom"
        ]
    ])("does not let normative text in a %s escape ownership", async (_name, body, message) => {
        const result = run(await fixture({ spec: insertSection(original, body) }));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Normative §6.4 ${message}`);
    });

    test("rejects a structurally bold undefined requirement ID", async () => {
        const result = run(
            await fixture({
                spec: insertSection(
                    original,
                    "Every fixture obligation MUST hold. This maps to **P11-SHELL-NOT-REAL**."
                )
            })
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("SPEC names unknown atom P11-SHELL-NOT-REAL");
    });

    test.each([
        "**[C13-FACET-REF-CANONICAL](#fixture-rule)**",
        "[**C13-FACET-REF-CANONICAL**](#fixture-rule)"
    ])("accepts a canonical anchor through wrapper order %s", async (anchor) => {
        const result = run(
            await fixture({
                spec: insertSection(
                    relocateFixtureAnchor(original),
                    `Every fixture obligation MUST hold. This maps to ${anchor}.`
                )
            })
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).not.toContain("§6.4");
    });

    test("reports one structural rule unit hashed into more atoms than the bound allows", async () => {
        const root = await fixture({ spec: combineTurnRetryRules(original) });
        const bounded = run(root);
        expect(bounded.status).toBe(1);
        expect(bounded.stderr).toContain(
            "One structural rule unit is the hash input for 5 atoms: C13-TURN-NO-RETRY"
        );

        const relaxed = run(root, ["--max-shared-atoms", "20"]);
        expect(relaxed.status, relaxed.stderr).toBe(0);
        expect(relaxed.stderr).not.toContain("COH-SHARED-BLOCK");
    });

    test("resolves every section cross-reference to a heading", async () => {
        const dangling = await fixture({ spec: original.replace("(§8.2)", "(§8.9)") });
        const danglingResult = run(dangling);
        expect(danglingResult.status).toBe(1);
        expect(danglingResult.stderr).toContain("Cross-reference §8.9 resolves to no §8.9 heading");

        const resolved = run(await fixture({}));
        expect(resolved.status, resolved.stderr).toBe(0);
        expect(resolved.stderr).not.toContain("COH-XREF");

        const formatted = await fixture({ spec: original.replace("(§8.2)", "(§8.**99**)") });
        const formattedResult = run(formatted);
        expect(formattedResult.status).toBe(1);
        expect(formattedResult.stderr).toContain(
            "Cross-reference §8.99 resolves to no §8.99 heading"
        );

        const malformed = await fixture({ spec: original.replace("(§8.2)", "(§8..99)") });
        const malformedResult = run(malformed);
        expect(malformedResult.status).toBe(1);
        expect(malformedResult.stderr).toContain("Malformed cross-reference §8..99");
        expect(malformedResult.stderr).not.toContain("resolves to no §8 heading");
    });

    test.each(["§10–2", "§8.5–8.1"])(
        "rejects reversed cross-reference range %s",
        async (reference) => {
            const result = run(
                await fixture({ spec: original.replace("(§8.2)", `(${reference})`) })
            );

            expect(result.status).toBe(1);
            expect(result.stderr).toContain(`Cross-reference ${reference} is reversed`);
        }
    );

    test("rejects atom anchoring that contradicts the normative map", async () => {
        const unanchored = await fixture({
            spec: original.replace("**C13-FACET-REF-CANONICAL**", "`C13-FACET-REF-CANONICAL`")
        });
        const unanchoredResult = run(unanchored);
        expect(unanchoredResult.status).toBe(1);
        expect(unanchoredResult.stderr).toContain(
            "Authoritative normative atom C13-FACET-REF-CANONICAL must appear exactly once outside §13"
        );

        // An adversarial atom is the stable choice here: the C13-ADV-* family states
        // attack cases the suite must refuse, not obligations the prose declares, so no
        // anchoring pass makes one authoritative. A normative atom would only hold this
        // fixture until the next sweep bound its prose — which is how C13-AUTH-PLANE,
        // named here before, stopped being §13-only.
        const unreviewed = await fixture({
            spec: insertSection(original, "This fixture clause maps to **C13-ADV-STALE-LEASE**.")
        });
        expect(run(unreviewed).stderr).toContain(
            "Unreviewed outside-§13 normative mapping for C13-ADV-STALE-LEASE"
        );

        const agreed = run(await fixture({}));
        expect(agreed.status, agreed.stderr).toBe(0);
        expect(agreed.stderr).not.toContain("COH-ATOM-UNBOUND");
    });

    test("refuses a normative rule that no atom anchors and no disposition judges", async () => {
        const unrecorded = await fixture({
            spec: insertSection(original, "Every fixture obligation MUST hold.")
        });
        const unrecordedResult = run(unrecorded);
        expect(unrecordedResult.status).toBe(1);
        expect(unrecordedResult.stderr).toContain(
            "Normative §6.4 rule is bound by no atom and no disposition judges it"
        );
        expect(unrecordedResult.stderr).toContain("Every fixture obligation MUST hold.");

        const anchored = await fixture({
            spec: insertSection(
                relocateFixtureAnchor(original),
                "Every fixture obligation MUST hold. This maps to **C13-FACET-REF-CANONICAL**."
            )
        });
        const anchoredResult = run(anchored);
        expect(anchoredResult.status, anchoredResult.stderr).toBe(0);
        expect(anchoredResult.stderr).not.toContain("§6.4");
    });

    test("refuses a baseline that accepts an unjudged normative rule as debt", async () => {
        const spec = insertSection(original, "Every fixture obligation MUST hold.");
        const fingerprint = /ACQ-NORM:\S+:6\.4:\S+/u.exec(run(await fixture({ spec })).stderr)?.[0];
        expect(fingerprint).toBeDefined();

        const accepted = await fixture({
            spec,
            baseline: JSON.stringify({
                edition: "1.0.0",
                issues: [
                    {
                        rule: "ACQ-NORM",
                        file: "SPEC.md",
                        symbol: "6.4",
                        message: "accepted as debt",
                        fingerprint
                    }
                ]
            })
        });
        const acceptedResult = run(accepted);
        expect(acceptedResult.status).toBe(1);
        expect(acceptedResult.stderr).toContain(
            "Baseline accepts normative rules with no recorded disposition"
        );
    });

    test("counts each rule of a numbered list, not the block its neighbour anchors", async () => {
        const sibling = [
            "8. `operation.after` may rewrite only the returned presentation value;",
            "   These replay clauses map to **C13-INTERCEPTOR-REPLAY**.",
            "9. A fixture interceptor MUST decline an unknown cut point."
        ].join("\n");
        const diluted = await fixture({
            spec: original.replace(
                /8\. `operation\.after` may rewrite only[\S\s]*?\*\*C13-INTERCEPTOR-REPLAY\*\*\./u,
                sibling
            )
        });
        const dilutedResult = run(diluted);
        expect(dilutedResult.status).toBe(1);
        expect(dilutedResult.stderr).toContain(
            "9. A fixture interceptor MUST decline an unknown cut point."
        );

        const named = await fixture({
            spec: relocateFixtureAnchor(
                original.replace(
                    /8\. `operation\.after` may rewrite only[\S\s]*?\*\*C13-INTERCEPTOR-REPLAY\*\*\./u,
                    `${sibling} This maps to **C13-FACET-REF-CANONICAL**.`
                )
            )
        });
        expect(run(named).stderr).not.toContain("A fixture interceptor MUST decline");
    });

    test("reopens a disposition when the prose it judged changes", async () => {
        const normative = original.replace("A Turn may carry", "A Turn MAY carry");
        const reworded = await fixture({
            spec: normative.replace("Purely advisory; no correctness semantics.", "It binds."),
            coverage: cacheLineageDisposition
        });
        const rewordedResult = run(reworded);
        expect(rewordedResult.status).toBe(1);
        expect(rewordedResult.stderr).toContain(
            "Normative disposition matches no §5.5 unit; the prose it judged was reworded"
        );
    });

    test("gates exactly the sections and keywords §1.3 declares", async () => {
        // §10 binds only because §1.3 says 2–10, so an unanchored §10.1 obligation is a
        // finding under the declared range and invisible once the range stops covering it.
        const injected = original.replace(
            "![Cloudflare topology](diagrams/cloudflare.svg)",
            "Every fixture profile obligation MUST hold.\n\n![Cloudflare topology](diagrams/cloudflare.svg)"
        );
        const included = run(await fixture({ spec: injected }));
        expect(included.status).toBe(1);
        expect(included.stderr).toContain(
            "Normative §10.1 rule is bound by no atom and no disposition judges it"
        );

        const narrowed = await fixture({
            spec: injected.replace(
                "Sections 1.4, 1.5, and 2–10 are normative;",
                "Sections 1.4, 1.5, and 2–9 are normative;"
            )
        });
        const narrowedResult = run(narrowed);
        expect(narrowedResult.status).toBe(1);
        expect(narrowedResult.stderr).toContain("Authoritative normative atom");
        expect(narrowedResult.stderr).toContain("is anchored in non-normative §10.1");

        const optional = original.replace(
            "![Cloudflare topology](diagrams/cloudflare.svg)",
            "A fixture profile MAY omit nothing.\n\n![Cloudflare topology](diagrams/cloudflare.svg)"
        );
        expect(run(await fixture({ spec: optional })).stderr).toContain(
            "A fixture profile MAY omit nothing."
        );
        const renamed = await fixture({
            spec: optional.replace(
                "MUST, SHOULD, and MAY are RFC 2119 keywords.",
                "MUST and SHOULD are RFC 2119 keywords."
            )
        });
        const renamedResult = run(renamed);
        expect(renamedResult.status, renamedResult.stderr).toBe(0);
        expect(renamedResult.stderr).not.toContain("A fixture profile MAY omit nothing.");
    });

    test("joins a row's citation to the atom label the cited test carries", async () => {
        const unlabelled = run(
            await fixture({
                rows: [
                    {
                        id: "C13-AUTH-PLANE",
                        testSelectors: ["test/join.test.ts#authority planes hold"]
                    }
                ],
                tests: { "join.test.ts": 'test("authority planes hold", () => {});\n' }
            })
        );
        expect(unlabelled.status).toBe(1);
        expect(unlabelled.stderr).toContain("New SPEC coherence violations");
        expect(unlabelled.stderr).toContain("COH-CITATION-LABEL:test/join.test.ts:C13-AUTH-PLANE");
        expect(unlabelled.stderr).toContain(
            "Row C13-AUTH-PLANE cites a test carrying no atom label: authority planes hold"
        );

        const labelled = run(
            await fixture({
                rows: [
                    {
                        id: "C13-AUTH-PLANE",
                        testSelectors: ["test/join.test.ts#[C13-AUTH-PLANE] authority planes hold"]
                    }
                ],
                tests: {
                    "join.test.ts": 'test("[C13-AUTH-PLANE] authority planes hold", () => {});\n'
                }
            })
        );
        expect(labelled.status, labelled.stderr).toBe(0);
        expect(labelled.stderr).not.toContain("COH-CITATION-LABEL");
    });

    test("names the other atom a citation carries and exempts a shared witness by pair", async () => {
        const selector = "test/witness.test.ts#[C13-AUTH-DENY-PATH] one test answers two atoms";
        const tests = {
            "witness.test.ts":
                'test("[C13-AUTH-DENY-PATH] one test answers two atoms", () => {});\n'
        };
        const rows = [
            { id: "C13-AUTH-PLANE", testSelectors: [selector] },
            { id: "C13-AUTH-DENY-PATH", testSelectors: [selector] }
        ];
        const shared = run(await fixture({ rows, tests }));
        expect(shared.status).toBe(1);
        // The repair differs from the unlabelled case, so the diagnostic must differ too:
        // a shared witness earns the citing atom's label, it does not lose the citation.
        expect(shared.stderr).toContain(
            "Row C13-AUTH-PLANE cites a test carrying C13-AUTH-DENY-PATH instead"
        );
        expect(shared.stderr).not.toContain("Row C13-AUTH-DENY-PATH cites");

        const exempted = run(
            await fixture({
                rows,
                tests,
                exemptions: [
                    {
                        atom: "C13-AUTH-PLANE",
                        reason: "The one case answers both atoms and can wear one label.",
                        selector
                    }
                ]
            })
        );
        expect(exempted.status, exempted.stderr).toBe(0);
    });

    test("fails loudly on a citation exemption that no longer resolves", async () => {
        const selector = "test/witness.test.ts#[C13-AUTH-DENY-PATH] one test answers two atoms";
        const reason = "The one case answers both atoms and can wear one label.";
        const dropped = run(
            await fixture({
                rows: [{ id: "C13-AUTH-PLANE", testSelectors: [] }],
                exemptions: [{ atom: "C13-AUTH-PLANE", reason, selector }]
            })
        );
        expect(dropped.status).toBe(1);
        expect(dropped.stderr).toContain("Citation label exemptions no longer resolve");
        expect(dropped.stderr).toContain(`C13-AUTH-PLANE no longer cites ${selector}`);

        const unknown = run(
            await fixture({ exemptions: [{ atom: "C13-AUTH-PLANE", reason, selector }] })
        );
        expect(unknown.status).toBe(1);
        expect(unknown.stderr).toContain("C13-AUTH-PLANE is no §13 row");

        const own = "test/witness.test.ts#[C13-AUTH-PLANE] one test answers one atom";
        const pointless = run(
            await fixture({
                rows: [{ id: "C13-AUTH-PLANE", testSelectors: [own] }],
                exemptions: [{ atom: "C13-AUTH-PLANE", reason, selector: own }]
            })
        );
        expect(pointless.status).toBe(1);
        expect(pointless.stderr).toContain(`C13-AUTH-PLANE now carries its own label in ${own}`);
    });

    test("backs a worn label with one cited case rather than with every case", async () => {
        const suite = [
            'describe("[C13-AUTH-PLANE] authority planes", () => {',
            '    it("hold across a restart", () => {});',
            '    it("reject a foreign plane", () => {});',
            '    it("survive a rename", () => {});',
            "});"
        ].join("\n");
        const unbacked = run(
            await fixture({
                rows: [{ id: "C13-AUTH-PLANE", testSelectors: [] }],
                tests: { "planes.test.ts": suite }
            })
        );
        expect(unbacked.status).toBe(1);
        expect(unbacked.stderr).toContain("COH-LABEL-CITATION:SPEC.md:C13-AUTH-PLANE");
        expect(unbacked.stderr).toContain(
            "Test titles carry the label of C13-AUTH-PLANE, whose row cites no test carrying it"
        );

        // One of the three cases discharges the label; a suite does not owe a citation each.
        const backed = run(
            await fixture({
                rows: [
                    {
                        id: "C13-AUTH-PLANE",
                        testSelectors: [
                            "test/planes.test.ts#[C13-AUTH-PLANE] authority planes hold across a restart"
                        ]
                    }
                ],
                tests: { "planes.test.ts": suite }
            })
        );
        expect(backed.status, backed.stderr).toBe(0);
        expect(backed.stderr).not.toContain("COH-LABEL-CITATION");
    });

    test("ratchets a join violation through the baseline in both directions", async () => {
        const rows = [
            { id: "C13-AUTH-PLANE", testSelectors: ["test/join.test.ts#authority planes hold"] }
        ];
        const tests = { "join.test.ts": 'test("authority planes hold", () => {});\n' };
        const added = run(await fixture({ rows, tests }));
        expect(added.status).toBe(1);
        expect(added.stderr).toContain("New SPEC coherence violations");

        const { fingerprint, baseline } = admitted(added.stderr, "COH-CITATION-LABEL");
        const accepted = run(await fixture({ rows, tests, baseline }));
        expect(accepted.status, accepted.stderr).toBe(0);
        expect(accepted.stdout).toContain("coherence incomplete: 1 issue(s), 0 resolved");

        const fixedRows = [
            {
                id: "C13-AUTH-PLANE",
                testSelectors: ["test/join.test.ts#[C13-AUTH-PLANE] authority planes hold"]
            }
        ];
        const fixedTests = {
            "join.test.ts": 'test("[C13-AUTH-PLANE] authority planes hold", () => {});\n'
        };
        const retained = run(await fixture({ rows: fixedRows, tests: fixedTests, baseline }));
        expect(retained.status).toBe(1);
        expect(retained.stderr).toContain("Coherence baseline retains resolved findings");
        expect(retained.stderr).toContain(fingerprint);

        const cleared = run(await fixture({ rows: fixedRows, tests: fixedTests }));
        expect(cleared.status, cleared.stderr).toBe(0);
        expect(cleared.stdout).toContain("coherence complete: 0 issue(s), 0 resolved");
    });
});

const cacheLineageDisposition = JSON.stringify({
    edition: "1.0.0",
    dispositions: [
        {
            disposition: "exempt",
            excerpt:
                "A Turn MAY carry an advisory `cacheLineage` hint identifying the Turn and prompt prefix it…",
            reason: "The field is expressly advisory and has no correctness semantics.",
            section: "5.5",
            sha256: "sha256:36f96e9e8d2594b42cb6bf2e86f8beb54110005c518f8132b6b61409d84fac94"
        }
    ]
});

function combineTurnRetryRules(spec: string): string {
    const start = spec.indexOf("The Turn lifecycle above is closed.");
    const end = spec.indexOf("\n\n---", start);
    if (start < 0 || end < 0) throw new TypeError("Turn retry rules are missing from the fixture");
    const combined = [
        "The Turn lifecycle and every integration surface MUST contain no Turn retry:",
        "**C13-TURN-NO-RETRY**, **C13-TURN-NO-RETRY-RUNTIME**",
        "**C13-TURN-NO-RETRY-PROTOCOL**, **C13-TURN-NO-RETRY-EXPORT**, and",
        "**C13-TURN-NO-RETRY-RECORD**."
    ].join("\n");
    return `${spec.slice(0, start)}${combined}${spec.slice(end)}`;
}

/** A §6.4 that §7 does not yet occupy, so the fixture adds prose without moving any atom. */
function insertSection(spec: string, body: string): string {
    return spec.replace(
        "## 7. Mediation (L4)",
        `### 6.4 Fixture\n\n${body}\n\n## 7. Mediation (L4)`
    );
}

function relocateFixtureAnchor(spec: string): string {
    const relocated = spec.replace("**C13-FACET-REF-CANONICAL**", "`C13-FACET-REF-CANONICAL`");
    if (relocated === spec) throw new TypeError("Fixture anchor is missing");
    return relocated;
}

async function fixture({
    spec,
    tests = {},
    baseline = '{\n  "edition": "1.0.0",\n  "issues": []\n}\n',
    coverage,
    rows = [],
    exemptions = []
}: {
    spec?: string;
    tests?: Record<string, string>;
    baseline?: string;
    coverage?: string;
    rows?: LedgerRow[];
    exemptions?: CitationExemption[];
}): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-coherence-"));
    temporary.push(root);
    await writeFile(resolve(root, "SPEC.md"), spec ?? original, "utf8");
    await mkdir(resolve(root, "test"), { recursive: true });
    for (const [name, source] of Object.entries(tests)) {
        await writeFile(resolve(root, "test", name), source, "utf8");
    }
    await writeFile(resolve(root, "baseline.json"), baseline, "utf8");
    if (coverage !== undefined) await writeFile(resolve(root, "coverage.json"), coverage, "utf8");
    // The join rule reads §13 rows, so a fixture carries its own ledger; pointed at the
    // repository's it would report every real citation against the fixture's baseline.
    await mkdir(resolve(root, "conformance"), { recursive: true });
    await writeJson(resolve(root, "conformance/index.json"), {
        edition: "1.0.0",
        seed: "seed.json",
        fragments: ["fixture.json"]
    });
    await writeJson(resolve(root, "conformance/seed.json"), {
        edition: "1.0.0",
        owner: "W0-seed",
        requirements: []
    });
    await writeJson(resolve(root, "conformance/fixture.json"), {
        edition: "1.0.0",
        owner: "W9",
        requirements: rows
    });
    await writeJson(resolve(root, "exemptions.json"), { edition: "1.0.0", entries: exemptions });
    return root;
}

/** One §13 row as the join rule reads it: an id and the tests it cites. */
type LedgerRow = { id: string; testSelectors: string[] };
type CitationExemption = { atom: string; reason: string; selector: string };
type FixtureArtifact =
    | { edition: string; seed: string; fragments: string[] }
    | { edition: string; owner: string; requirements: LedgerRow[] }
    | { edition: string; entries: CitationExemption[] };

async function writeJson(path: string, value: FixtureArtifact): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** The gate's own report of a finding, folded into the one-entry baseline that admits it. */
function admitted(stderr: string, rule: string): AdmittedFinding {
    const [line = ""] = stderr
        .split("\n")
        .map((item) => item.trim())
        .filter((item) => item.startsWith(`${rule}:`));
    expect(line, stderr).not.toBe("");
    const separator = line.indexOf(" ");
    const fingerprint = line.slice(0, separator);
    const baseline = {
        edition: "1.0.0",
        issues: [{ fingerprint, message: line.slice(separator + 1) }]
    };
    return { fingerprint, baseline: `${JSON.stringify(baseline, null, 2)}\n` };
}

/** A reported finding and the one-entry baseline that admits it as debt. */
type AdmittedFinding = { fingerprint: string; baseline: string };

function run(root: string, extra: string[] = []): QualitySubprocessResult {
    return runQualitySubprocess(
        process.execPath,
        [
            checker,
            "--stage",
            "building",
            "--root",
            root,
            "--spec",
            resolve(root, "SPEC.md"),
            "--baseline",
            resolve(root, "baseline.json"),
            "--conformance",
            resolve(root, "conformance/index.json"),
            "--citation-exemptions",
            resolve(root, "exemptions.json"),
            ...(extraCoverage(root) ?? []),
            ...extra
        ],
        packageRoot
    );
}

function extraCoverage(root: string): string[] | undefined {
    const coverage = resolve(root, "coverage.json");
    return existsSync(coverage) ? ["--normative-coverage", coverage] : undefined;
}

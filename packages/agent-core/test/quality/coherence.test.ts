import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeAll, afterEach, describe, expect, test } from "vitest";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

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
        expect(result.stdout).toContain("coherence incomplete");
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
        expect(boundResult.stderr).toContain("COH-SHARED-BLOCK");
        expect(boundResult.stderr).not.toContain("COH-TEST-LABEL");
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
        expect(leakedResult.stderr).toContain("Undefined wave codename W7 in §1.4 normative prose");

        // The §3.3 Grant-precedence example names Workspaces W1 and W2, which the
        // allowlisted sentence exempts, so the injected §1.4 leak above is the only
        // codename the leaked fixture reports.
        expect(leakedResult.stderr).not.toContain("§3.3 normative prose");

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
                original,
                "Every fixture obligation MUST hold. This maps to **P11-SHELL-RUN**."
            )
        });
        const boundResult = run(bound);
        expect(boundResult.stderr).toContain("COH-SECTION-NO-ATOM");
        expect(boundResult.stderr).not.toContain("§6.4");
        expect(boundResult.stderr).not.toContain("Normative §5.2 carries no conformance atom");
    });

    test("reports one prose block hashed into more atoms than the bound allows", async () => {
        const root = await fixture({});
        const bounded = run(root);
        expect(bounded.status).toBe(1);
        expect(bounded.stderr).toContain(
            "One prose block is the hash input for 5 atoms: C13-TURN-NO-RETRY"
        );

        const relaxed = run(root, ["--max-shared-atoms", "20"]);
        expect(relaxed.stderr).toContain("COH-SECTION-NO-ATOM");
        expect(relaxed.stderr).not.toContain("COH-SHARED-BLOCK");
    });

    test("resolves every section cross-reference to a heading", async () => {
        const dangling = await fixture({ spec: original.replace("(§8.2)", "(§8.9)") });
        const danglingResult = run(dangling);
        expect(danglingResult.status).toBe(1);
        expect(danglingResult.stderr).toContain("Cross-reference §8.9 resolves to no §8.9 heading");

        const resolved = run(await fixture({}));
        expect(resolved.stderr).toContain("COH-SHARED-BLOCK");
        expect(resolved.stderr).not.toContain("COH-XREF");
    });

    test("flags atom anchoring that contradicts the normative map", async () => {
        const unanchored = await fixture({
            spec: original.replace("**C13-FACET-REF-CANONICAL**", "`C13-FACET-REF-CANONICAL`")
        });
        const unanchoredResult = run(unanchored);
        expect(unanchoredResult.status).toBe(1);
        expect(unanchoredResult.stderr).toContain(
            "Reviewed authoritative atom C13-FACET-REF-CANONICAL is anchored 0 times outside §13"
        );

        const unreviewed = await fixture({
            spec: insertSection(original, "This fixture clause maps to **C13-AUTH-PLANE**.")
        });
        expect(run(unreviewed).stderr).toContain(
            "§13-only summary C13-AUTH-PLANE is anchored 1 times outside §13"
        );

        const agreed = run(await fixture({}));
        expect(agreed.stderr).toContain("COH-SHARED-BLOCK");
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
                original,
                "Every fixture obligation MUST hold. This maps to **P11-SHELL-RUN**."
            )
        });
        const anchoredResult = run(anchored);
        expect(anchoredResult.status).toBe(1);
        // The checker still reached its findings report; the anchored clause is simply
        // no longer one of them.
        expect(anchoredResult.stderr).toContain("COH-SHARED-BLOCK");
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
            spec: original.replace(
                /8\. `operation\.after` may rewrite only[\S\s]*?\*\*C13-INTERCEPTOR-REPLAY\*\*\./u,
                `${sibling} This maps to **P11-SHELL-RUN**.`
            )
        });
        expect(run(named).stderr).not.toContain("A fixture interceptor MUST decline");
    });

    test("reopens a disposition when the prose it judged changes", async () => {
        const reworded = await fixture({
            spec: original.replace("Purely advisory; no correctness semantics.", "It binds.")
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
        expect(narrowedResult.stderr).not.toContain("Every fixture profile obligation MUST hold.");

        const renamed = await fixture({
            spec: original.replace(
                "MUST, SHOULD, and MAY are RFC 2119 keywords.",
                "MUST and SHOULD are RFC 2119 keywords."
            )
        });
        expect(run(renamed).stderr).toContain("Normative disposition matches no §5.5 unit");
    });
});

/** A §6.4 that §7 does not yet occupy, so the fixture adds prose without moving any atom. */
function insertSection(spec: string, body: string): string {
    return spec.replace(
        "## 7. Mediation (L4)",
        `### 6.4 Fixture\n\n${body}\n\n## 7. Mediation (L4)`
    );
}

async function fixture({
    spec,
    tests = {},
    baseline = '{\n  "edition": "1.0.0",\n  "issues": []\n}\n'
}: {
    spec?: string;
    tests?: Record<string, string>;
    baseline?: string;
}): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-coherence-"));
    temporary.push(root);
    await writeFile(resolve(root, "SPEC.md"), spec ?? original, "utf8");
    await mkdir(resolve(root, "test"), { recursive: true });
    for (const [name, source] of Object.entries(tests)) {
        await writeFile(resolve(root, "test", name), source, "utf8");
    }
    await writeFile(resolve(root, "baseline.json"), baseline, "utf8");
    return root;
}

function run(root: string, extra: string[] = []): ReturnType<typeof runQualitySubprocess> {
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
            ...extra
        ],
        packageRoot
    );
}

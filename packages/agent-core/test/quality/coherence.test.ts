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
            "One prose block is the hash input for 11 atoms: C13-RUN-ADMISSION-REGISTRY"
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
    tests = {}
}: {
    spec?: string;
    tests?: Record<string, string>;
}): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-coherence-"));
    temporary.push(root);
    await writeFile(resolve(root, "SPEC.md"), spec ?? original, "utf8");
    await mkdir(resolve(root, "test"), { recursive: true });
    for (const [name, source] of Object.entries(tests)) {
        await writeFile(resolve(root, "test", name), source, "utf8");
    }
    await writeFile(
        resolve(root, "baseline.json"),
        '{\n  "edition": "1.0.0",\n  "issues": []\n}\n',
        "utf8"
    );
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

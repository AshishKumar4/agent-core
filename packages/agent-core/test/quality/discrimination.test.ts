import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { sourceSymbolLines } from "../../scripts/quality/evidence.mjs";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/discrimination.mjs");
const temporary: string[] = [];

// Real citations, fixture evidence: the atom cites a stable production symbol and a
// mutation-executable test lane, while every kill record — the thing under test — is
// injected, so these tests never depend on the production evidence store being wrong.
const citedFile = "src/errors.ts";
const citedSymbol = `${citedFile}#AgentCoreError`;
const citedTest = "test/actors/actor.test.ts#fixture discrimination probe";

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function currentHash(file: string): Promise<string> {
    const text = await readFile(resolve(packageRoot, file), "utf8");
    return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

interface FixtureRequirement {
    id: string;
    status: string;
    sourceSymbols: string[];
    testSelectors: string[];
    checkerInvariants: string[];
}

interface FixtureEvidence {
    area: string;
    files: Record<string, { mutants: number; sha256: string }>;
    killed: Record<string, Record<string, number[]>>;
}

async function fixtureRoot(
    requirements: FixtureRequirement[],
    evidence: FixtureEvidence[],
    baselineIssues?: Array<{
        rule: string;
        file: string;
        symbol: string;
        message: string;
        fingerprint: string;
    }>
): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "discrimination-"));
    temporary.push(root);
    await mkdir(join(root, "conformance"), { recursive: true });
    await mkdir(join(root, "quality/discrimination"), { recursive: true });
    await writeFile(
        join(root, "conformance/index.json"),
        JSON.stringify({ edition: "1.0.0", seed: "seed.json", fragments: ["wave.json"] })
    );
    await writeFile(
        join(root, "conformance/seed.json"),
        JSON.stringify({ edition: "1.0.0", owner: "W0-seed", requirements: [] })
    );
    await writeFile(
        join(root, "conformance/wave.json"),
        JSON.stringify({ edition: "1.0.0", owner: "W2", requirements })
    );
    for (const artifact of evidence) {
        await writeFile(
            join(root, `quality/discrimination/${artifact.area}.json`),
            JSON.stringify({
                edition: "1.0.0",
                area: artifact.area,
                measuredAt: "0".repeat(40),
                fingerprint: "sha256:fixture",
                files: artifact.files,
                killed: artifact.killed
            })
        );
    }
    if (baselineIssues !== undefined) {
        await writeFile(
            join(root, "quality/discrimination-baseline.json"),
            JSON.stringify({ edition: "1.0.0", issues: baselineIssues })
        );
    }
    return root;
}

function verifiedAtom(overrides: Partial<FixtureRequirement> = {}): FixtureRequirement {
    return {
        id: "C13-FIXTURE-DISCRIMINATION",
        status: "verified",
        sourceSymbols: [citedSymbol],
        testSelectors: [citedTest],
        checkerInvariants: ["ACQ-IMPORT"],
        ...overrides
    };
}

function runChecker(root: string): ReturnType<typeof runQualitySubprocess> {
    return runQualitySubprocess(
        process.execPath,
        [checker, "--stage", "building", "--artifact-root", root],
        packageRoot
    );
}

describe("discrimination gate", subprocessTestOptions, () => {
    test("accepts a cited test that killed a mutant inside the cited symbol", async () => {
        const span = sourceSymbolLines(citedSymbol);
        const root = await fixtureRoot(
            [verifiedAtom()],
            [
                {
                    area: "errors",
                    files: { [citedFile]: { mutants: 6, sha256: await currentHash(citedFile) } },
                    killed: { [citedTest]: { [citedFile]: [span.startLine] } }
                }
            ]
        );

        const result = runChecker(root);

        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("1 symbol + 0 file tier of 1 mutation-kind atoms");
    });

    test("rejects a kill outside the cited symbol in an unchanged file", async () => {
        // The injected defect: the cited test killed a mutant in the same file but in
        // a different declaration — the exact "test that merely runs nearby" failure.
        const span = sourceSymbolLines(citedSymbol);
        const root = await fixtureRoot(
            [verifiedAtom()],
            [
                {
                    area: "errors",
                    files: { [citedFile]: { mutants: 6, sha256: await currentHash(citedFile) } },
                    killed: { [citedTest]: { [citedFile]: [span.endLine + 1] } }
                }
            ]
        );

        const result = runChecker(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("New undiscriminated conformance evidence");
        expect(result.stderr).toContain("C13-FIXTURE-DISCRIMINATION");
    });

    test("rejects kills attributed only to tests the atom does not cite", async () => {
        const span = sourceSymbolLines(citedSymbol);
        const root = await fixtureRoot(
            [verifiedAtom()],
            [
                {
                    area: "errors",
                    files: { [citedFile]: { mutants: 6, sha256: await currentHash(citedFile) } },
                    killed: {
                        "test/actors/actor.test.ts#some uncited neighbour": {
                            [citedFile]: [span.startLine]
                        }
                    }
                }
            ]
        );

        const result = runChecker(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("New undiscriminated conformance evidence");
    });

    test("degrades to file tier when the measured file has drifted", async () => {
        const root = await fixtureRoot(
            [verifiedAtom()],
            [
                {
                    area: "errors",
                    files: { [citedFile]: { mutants: 6, sha256: "sha256:drifted" } },
                    killed: { [citedTest]: { [citedFile]: [1] } }
                }
            ]
        );

        const result = runChecker(root);

        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("0 symbol + 1 file tier of 1 mutation-kind atoms");
    });

    test("ratchets debt: baselined findings pass, retained resolved findings fail", async () => {
        const undiscriminated = await fixtureRoot([verifiedAtom()], []);
        const failing = runChecker(undiscriminated);
        expect(failing.status).toBe(1);
        const fingerprint = /DISC-ATOM:\S+/u.exec(failing.stderr)?.[0];
        expect(fingerprint).toBeDefined();

        const baselineIssue = {
            rule: "DISC-ATOM",
            file: "wave.json",
            symbol: "C13-FIXTURE-DISCRIMINATION",
            message: "baselined",
            fingerprint: fingerprint as string
        };
        const baselined = await fixtureRoot([verifiedAtom()], [], [baselineIssue]);
        const passing = runChecker(baselined);
        expect(passing.stderr).toBe("");
        expect(passing.status).toBe(0);
        expect(passing.stdout).toContain("1 issue(s)");

        const span = sourceSymbolLines(citedSymbol);
        const stale = await fixtureRoot(
            [verifiedAtom()],
            [
                {
                    area: "errors",
                    files: { [citedFile]: { mutants: 6, sha256: await currentHash(citedFile) } },
                    killed: { [citedTest]: { [citedFile]: [span.startLine] } }
                }
            ],
            [baselineIssue]
        );
        const retained = runChecker(stale);
        expect(retained.status).toBe(1);
        expect(retained.stderr).toContain("Discrimination baseline retains resolved findings");
    });

    test("classifies exempt evidence kinds explicitly instead of gating them", async () => {
        const root = await fixtureRoot(
            [
                verifiedAtom({
                    id: "C13-FIXTURE-LIVE",
                    testSelectors: ["cloudflare/test/workers/live.test.ts#live scenario"],
                    checkerInvariants: ["ACQ-LIVE"]
                }),
                verifiedAtom({
                    id: "C13-FIXTURE-INFRASTRUCTURE",
                    sourceSymbols: ["scripts/quality/project.mjs#sha256"]
                }),
                verifiedAtom({ id: "C13-FIXTURE-PLANNED", status: "planned" })
            ],
            []
        );

        const result = runChecker(root);

        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const report = JSON.parse(
            await readFile(resolve(packageRoot, "reports/quality/discrimination.json"), "utf8")
        ) as { atoms: { live: string[]; infrastructure: string[]; mutation: number } };
        expect(report.atoms.live).toEqual(["C13-FIXTURE-LIVE"]);
        expect(report.atoms.infrastructure).toEqual(["C13-FIXTURE-INFRASTRUCTURE"]);
        expect(report.atoms.mutation).toBe(0);
    });

    test("flags evidence that lives only in lanes mutation never executes", async () => {
        const root = await fixtureRoot(
            [
                verifiedAtom({
                    testSelectors: ["test/quality/dag.test.ts#never runs under mutation"]
                })
            ],
            []
        );

        const result = runChecker(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("can never demonstrate discrimination");
    });

    test("rejects a kill recorded in a file the area never measured", async () => {
        const root = await fixtureRoot(
            [verifiedAtom()],
            [
                {
                    area: "errors",
                    files: {},
                    killed: { [citedTest]: { [citedFile]: [1] } }
                }
            ]
        );

        const result = runChecker(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("records a kill in an unmeasured file");
    });

    test("refuses to write the baseline without the explicit override", async () => {
        const root = await fixtureRoot([verifiedAtom()], []);

        const result = runQualitySubprocess(
            process.execPath,
            [checker, "--stage", "building", "--artifact-root", root, "--write-baseline"],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("QUALITY_WRITE_BASELINE=1");
    });
});

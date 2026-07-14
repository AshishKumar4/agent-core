import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, test } from "vitest";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";
import { validateFinalRequestArchive } from "../../scripts/quality/request-archive.mjs";
import { validateBomImportDenominator } from "../../scripts/quality/bom.mjs";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/governance.mjs");
const formatter = resolve(packageRoot, "scripts/quality/format.mjs");
const integrationRoot = resolve(packageRoot, "artifacts/integration");

describe("R1 integration governance", subprocessTestOptions, () => {
    test("accepts exact finalized inputs during building and stays fail-closed at final", () => {
        const building = run("building");
        expect(building.status).toBe(0);
        expect(building.stdout).toContain("48 artifact(s)");
        expect(building.stdout).toContain("0 pending disposition(s)");
        expect(building.stdout).toContain("0 pending resolution(s)");

        const final = run("final");
        expect(final.status).toBe(1);
        expect(final.stderr).toContain("integration BOM stage building does not match final");
    });

    test("schemas reject unsigned final claims and incomplete wave dispositions", async () => {
        const bom = await json<{ entries: Array<Record<string, unknown>> }>("bom.json");
        const bomValidate = await validator("bom-schema.json");
        expect(
            bomValidate({ ...bom, entries: [{ ...bom.entries[0]!, commitSignature: {} }] })
        ).toBe(false);
        expect(
            bomValidate({
                ...bom,
                entries: [
                    {
                        ...bom.entries[0]!,
                        artifacts: [
                            {
                                ...(bom.entries[0]!.artifacts as Array<Record<string, unknown>>)[0],
                                normalization: "canonical-json-v1"
                            }
                        ]
                    }
                ]
            })
        ).toBe(false);

        const dispositions = await json<{ waves: unknown[] }>("dispositions.json");
        const dispositionValidate = await validator("disposition-schema.json");
        expect(dispositionValidate({ ...dispositions, waves: dispositions.waves.slice(1) })).toBe(
            false
        );
    });

    test("imports every request file from every supplied head", async () => {
        const bom = await json<{
            entries: Array<{
                owner: string;
                commit: string;
                artifacts: Array<{ source: string }>;
            }>;
        }>("bom.json");
        for (const entry of bom.entries) {
            const root =
                entry.owner === "W8"
                    ? `artifacts/requests/${entry.owner}`
                    : `packages/agent-core/artifacts/requests/${entry.owner}`;
            const source = runQualitySubprocess(
                "git",
                ["ls-tree", "-r", "--name-only", entry.commit, "--", root],
                resolve(packageRoot, "../..")
            );
            expect(source.status).toBe(0);
            expect(
                entry.artifacts
                    .map((artifact) => artifact.source)
                    .filter((path) => path.startsWith(`${root}/`))
                    .sort()
            ).toEqual(source.stdout.split("\n").filter(Boolean).sort());
        }
    });

    test("imports only exact request files and genuinely pending immutable inputs", async () => {
        const bom = await json<{
            entries: Array<{
                artifacts: Array<{ source: string; destination: string }>;
            }>;
        }>("bom.json");
        const denominator = validateBomImportDenominator(bom.entries, new Set());
        expect(denominator).toEqual({ requestCount: 48, pendingCount: 0 });
        expect(
            bom.entries
                .flatMap((entry) => entry.artifacts)
                .some((artifact) =>
                    /^packages\/agent-core\/artifacts\/(?:records|seams|conformance)\//u.test(
                        artifact.destination
                    )
                )
        ).toBe(false);

        const active = structuredClone(bom.entries);
        active[0]!.artifacts.push({
            source: "packages/agent-core/artifacts/records/foundation.json",
            destination: "packages/agent-core/artifacts/records/foundation.json"
        });
        expect(() => validateBomImportDenominator(active, new Set())).toThrow(
            "exact pending immutable registry inputs"
        );

        expect(() =>
            validateBomImportDenominator(
                active,
                new Set(["packages/agent-core/artifacts/records/foundation.json"])
            )
        ).not.toThrow();
    });

    test("verifies immutable BOM bytes before excluding imports from formatting", async () => {
        const request = await readFile(
            resolve(
                packageRoot,
                "artifacts/integration/request-archive/W8/normative-clarifications.md"
            )
        );
        expect(createHash("sha256").update(request).digest("hex")).toBe(
            "ff84559cc58d93d09ff4ee08170bd55c47c9e3b4e43465584e7d3b854cd9b325"
        );
        const result = runQualitySubprocess(
            process.execPath,
            [formatter, "--owner", "W8", "--base", "9283246"],
            packageRoot
        );
        expect(result.status).toBe(0);
    });

    test("marks every coordinated transition complete with immutable evidence", async () => {
        const index = await json<{ manifests: string[] }>("transitions/index.json");
        const transitions = await Promise.all(
            index.manifests.map((name) =>
                json<{ id: string; state: string; completion: unknown }>(`transitions/${name}`)
            )
        );
        expect(transitions.filter((transition) => transition.state === "pending-inputs")).toEqual(
            []
        );
        expect(transitions.map((item) => item.id).sort()).toEqual([
            "TRANSITION-ENVIRONMENT-PIN-IDENTITY",
            "TRANSITION-FACET-CAPABILITY-IDENTITY",
            "TRANSITION-FOUNDATION-PUBLIC-CONTRACT",
            "TRANSITION-INTERACTION-IDENTITIES",
            "TRANSITION-W9-INTEGRATION-CANDIDATE"
        ]);
        expect(transitions.every((transition) => transition.state === "completed")).toBe(true);
        expect(transitions.every((transition) => transition.completion !== null)).toBe(true);
    });

    test("keeps the foundation transition exact and incomplete until checkpoint identity exists", async () => {
        const transition = await json<{
            state: string;
            canonicalOwner: string;
            inputs: Array<{ owner: string }>;
            allowedForeignPaths: string[];
            completion: unknown;
        }>("transitions/foundation-public-contract.json");
        const validate = await validator("transition-schema.json");

        expect(validate(transition)).toBe(true);
        expect(transition.state).toBe("completed");
        expect(transition.canonicalOwner).toBe("W0");
        expect(transition.inputs.map((input) => input.owner)).toEqual(["W0", "W1"]);
        expect(transition.completion).not.toBeNull();
        expect(transition.allowedForeignPaths).toContain(
            "packages/agent-core/artifacts/quality/exports.json"
        );
        expect(
            validate({ ...transition, allowedForeignPaths: ["packages/agent-core/scripts/**"] })
        ).toBe(false);
    });

    test("requires a change manifest for integration candidates", async () => {
        const transition = await json<Record<string, unknown>>(
            "transitions/w9-integration-candidate.json"
        );
        const validate = await validator("transition-schema.json");
        const { changeManifest: _, ...withoutManifest } = transition;
        expect(validate(transition)).toBe(true);
        expect(validate(withoutManifest)).toBe(false);
    });

    test("maps every archived request to one completed resolution and rejects W5 retry", async () => {
        const resolutions = await json<{
            entries: Array<{
                source: string;
                state: string;
                completion: null | Record<string, unknown>;
            }>;
            decisions: Array<{
                id: string;
                disposition: string;
                integrationAction: string;
            }>;
        }>("resolutions.json");
        expect(resolutions.entries).toHaveLength(48);
        expect(new Set(resolutions.entries.map(({ source }) => source)).size).toBe(48);
        expect(resolutions.entries.filter(({ state }) => state === "applied")).toHaveLength(47);
        expect(resolutions.entries.filter(({ state }) => state === "external-gated")).toHaveLength(
            1
        );
        expect(resolutions.entries.every(({ completion }) => completion !== null)).toBe(true);
        expect(resolutions.decisions.find((entry) => entry.id === "W5-RETRY")).toMatchObject({
            disposition: "rejected"
        });
        expect(
            resolutions.decisions.find((entry) => entry.id === "W5-RETRY")?.integrationAction
        ).toContain("must remove");
    });

    test("resolution schema requires completion evidence after pending", async () => {
        const resolutions = await json<{ entries: unknown[] }>("resolutions.json");
        const validate = await validator("resolution-schema.json");
        const appliedWithoutCompletion = structuredClone(resolutions);
        appliedWithoutCompletion.entries[0] = {
            ...(appliedWithoutCompletion.entries[0] as Record<string, unknown>),
            completion: null
        };
        expect(validate(appliedWithoutCompletion)).toBe(false);
    });

    test("requires immutable blobs for completed transitions and dispositions", async () => {
        const transition = await json<Record<string, unknown>>(
            "transitions/w9-integration-candidate.json"
        );
        const transitionValidate = await validator("transition-schema.json");
        const completion = {
            commit: "a".repeat(40),
            tree: "b".repeat(40),
            artifacts: [
                {
                    path: "packages/agent-core/package.json",
                    blob: "c".repeat(40),
                    sha256: "d".repeat(64)
                }
            ],
            tests: ["Packed negative: removed exports are unavailable"]
        };
        expect(
            transitionValidate({
                ...transition,
                state: "completed",
                blockers: [],
                completion
            })
        ).toBe(true);
        const withoutBlob = structuredClone(completion);
        delete (withoutBlob.artifacts[0] as { blob?: string }).blob;
        expect(
            transitionValidate({
                ...transition,
                state: "completed",
                blockers: [],
                completion: withoutBlob
            })
        ).toBe(false);

        const dispositions = await json<{ waves: Array<Record<string, unknown>> }>(
            "dispositions.json"
        );
        const dispositionValidate = await validator("disposition-schema.json");
        dispositions.waves[9] = {
            owner: "W9",
            state: "completed",
            commit: completion.commit,
            tree: completion.tree,
            clean: true,
            artifacts: completion.artifacts,
            blockers: []
        };
        expect(dispositionValidate(dispositions)).toBe(true);
    });

    test("reconciles final BOM, archive, and resolutions one-to-one", async () => {
        const source = "packages/agent-core/artifacts/requests/W1/request.json";
        const archivePath =
            "packages/agent-core/artifacts/integration/request-archive/W1/request.json";
        const sha256 = "a".repeat(64);
        const completion = {
            commit: "b".repeat(40),
            tree: "c".repeat(40),
            artifacts: [{ path: archivePath, blob: "d".repeat(40), sha256 }]
        };
        const context = {
            archive: {
                entries: [
                    {
                        owner: "W1",
                        source,
                        sourceSha256: sha256,
                        path: archivePath,
                        sha256
                    }
                ]
            },
            resolutions: {
                entries: [
                    {
                        source,
                        sourceSha256: sha256,
                        archive: archivePath,
                        archiveSha256: sha256,
                        state: "applied",
                        completion
                    }
                ]
            },
            bom: {
                entries: [
                    {
                        owner: "W1",
                        artifacts: [
                            {
                                source,
                                sourceSha256: sha256,
                                destination: archivePath,
                                sha256
                            }
                        ]
                    }
                ]
            },
            archiveFiles: [archivePath]
        };
        const validateArchive = (value: typeof context) =>
            validateFinalRequestArchive({
                ...value,
                verifyCompletionEvidence: () => undefined
            });
        await expect(validateArchive(context)).resolves.toBeInstanceOf(Map);
        const rejected = structuredClone(context);
        rejected.resolutions.entries[0]!.state = "rejected";
        await expect(validateArchive(rejected)).resolves.toBeInstanceOf(Map);

        const pending = structuredClone(context);
        pending.resolutions.entries[0]!.state = "pending";
        await expect(validateArchive(pending)).rejects.toThrow("resolution is incomplete");

        const activeDestination = structuredClone(context);
        activeDestination.bom.entries[0]!.artifacts[0]!.destination = source;
        await expect(validateArchive(activeDestination)).rejects.toThrow("differs from BOM source");

        const omitted = structuredClone(context);
        omitted.archive.entries = [];
        await expect(validateArchive(omitted)).rejects.toThrow("different denominators");
    });

    test("indexes zero-violation owned paths and the exact W8 split", async () => {
        const verification = await json<{
            owner: string;
            waves: Array<{
                owner: string;
                splitPaths: Array<{ path: string; owner: string }>;
                violations: unknown[];
            }>;
            violations: unknown[];
        }>("owned-path-verification.json");
        const validate = await validator("owned-path-verification-schema.json");

        expect(validate(verification)).toBe(true);
        expect(verification.owner).toBe("W0");
        expect(verification.waves).toHaveLength(9);
        expect(verification.waves.flatMap((wave) => wave.violations)).toEqual([]);
        expect(verification.violations).toEqual([]);
        expect(verification.waves.find((wave) => wave.owner === "W8")?.splitPaths).toEqual([
            { path: "packages/agent-core-cloudflare/tsconfig.build.json", owner: "W0" },
            { path: "packages/agent-core-cloudflare/tsconfig.json", owner: "W0" }
        ]);
    });
});

function run(stage: string): ReturnType<typeof runQualitySubprocess> {
    return runQualitySubprocess(process.execPath, [checker, "--stage", stage], packageRoot);
}

async function json<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(resolve(integrationRoot, path), "utf8"));
}

async function validator(path: string): Promise<(value: unknown) => boolean> {
    const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
    return ajv.compile(await json<Record<string, unknown>>(path));
}

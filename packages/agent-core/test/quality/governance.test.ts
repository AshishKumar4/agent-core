import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, test } from "vitest";
import {
    type QualitySubprocessResult,
    runQualitySubprocess,
    subprocessTestOptions
} from "./subprocess";
import { arrayAt, objectsAt, readArtifact, stringAt, stringsAt } from "./artifacts";
import { validateFinalRequestArchive } from "../../scripts/quality/request-archive.mjs";
import { validateBomImportDenominator } from "../../scripts/quality/bom.mjs";
import type { JsonObject, JsonValue } from "../../scripts/quality/project.mjs";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/governance.mjs");
const formatter = resolve(packageRoot, "scripts/quality/format.mjs");

describe("R1 integration governance", subprocessTestOptions, () => {
    test("verifies published process evidence at building and rejects a premature final claim", () => {
        const building = run("building");
        expect(building.stderr).toBe("");
        expect(building.status).toBe(0);
        expect(building.stdout).toContain("governance inputs verified");

        const final = run("final");
        expect(final.status).toBe(1);
        expect(final.stderr).toContain("integration BOM stage building does not match final");
    });

    test("schemas reject unsigned final claims and incomplete wave dispositions", async () => {
        const bom = await integrationArtifact("bom.json");
        const firstEntry = objectsAt(bom, "entries")[0]!;
        const bomValidate = await validator("bom-schema.json");
        expect(bomValidate({ ...bom, entries: [{ ...firstEntry, commitSignature: {} }] })).toBe(
            false
        );
        expect(
            bomValidate({
                ...bom,
                entries: [
                    {
                        ...firstEntry,
                        artifacts: [
                            {
                                ...objectsAt(firstEntry, "artifacts")[0],
                                normalization: "canonical-json-v1"
                            }
                        ]
                    }
                ]
            })
        ).toBe(false);

        const dispositions = await integrationArtifact("dispositions.json");
        const dispositionValidate = await validator("disposition-schema.json");
        expect(
            dispositionValidate({
                ...dispositions,
                waves: objectsAt(dispositions, "waves").slice(1)
            })
        ).toBe(false);
    });

    test("binds every BOM source to one exact self-contained archive entry", async () => {
        const bom = await integrationArtifact("bom.json");
        const archive = await integrationArtifact("request-archive.json");
        const imported = objectsAt(bom, "entries").flatMap((entry) =>
            objectsAt(entry, "artifacts").map((artifact) => ({
                owner: stringAt(entry, "owner"),
                source: stringAt(artifact, "source"),
                sourceSha256: stringAt(artifact, "sourceSha256"),
                path: stringAt(artifact, "destination"),
                sha256: stringAt(artifact, "sha256")
            }))
        );
        const archived = objectsAt(archive, "entries").map((entry) => ({
            owner: stringAt(entry, "owner"),
            source: stringAt(entry, "source"),
            sourceSha256: stringAt(entry, "sourceSha256"),
            path: stringAt(entry, "path"),
            sha256: stringAt(entry, "sha256")
        }));

        const bySource = (left: { source: string }, right: { source: string }) =>
            left.source.localeCompare(right.source);
        expect([...archived].sort(bySource)).toEqual([...imported].sort(bySource));
    });

    test("imports only exact request files and genuinely pending immutable inputs", async () => {
        const bom = await integrationArtifact("bom.json");
        const entries = objectsAt(bom, "entries").map((entry) => ({
            artifacts: objectsAt(entry, "artifacts").map((artifact) => ({
                source: stringAt(artifact, "source"),
                destination: stringAt(artifact, "destination")
            }))
        }));
        const denominator = validateBomImportDenominator(entries, new Set());
        expect(denominator).toEqual({ requestCount: 48, pendingCount: 0 });
        expect(
            entries
                .flatMap((entry) => entry.artifacts)
                .some((artifact) =>
                    /^packages\/agent-core\/artifacts\/(?:records|seams|conformance)\//u.test(
                        artifact.destination
                    )
                )
        ).toBe(false);

        const active = structuredClone(entries);
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
            [formatter, "--owner", "W1", "--base", "HEAD"],
            packageRoot
        );
        expect(result.status).toBe(0);
    });

    test("marks every coordinated transition complete with immutable evidence", async () => {
        const index = await integrationArtifact("transitions/index.json");
        const transitions = await Promise.all(
            stringsAt(index, "manifests").map((name) => integrationArtifact(`transitions/${name}`))
        );
        expect(
            transitions.filter((transition) => stringAt(transition, "state") === "pending-inputs")
        ).toEqual([]);
        expect(transitions.map((item) => stringAt(item, "id")).sort()).toEqual([
            "TRANSITION-BINDING-AUTHORITY-PLANE",
            "TRANSITION-ENVIRONMENT-PIN-IDENTITY",
            "TRANSITION-FACET-CAPABILITY-IDENTITY",
            "TRANSITION-FOUNDATION-PUBLIC-CONTRACT",
            "TRANSITION-INTERACTION-IDENTITIES",
            "TRANSITION-W9-INTEGRATION-CANDIDATE"
        ]);
        expect(
            transitions.every((transition) => stringAt(transition, "state") === "completed")
        ).toBe(true);
        expect(transitions.every((transition) => transition["completion"] !== null)).toBe(true);
    });

    test("keeps the foundation transition exact and incomplete until checkpoint identity exists", async () => {
        const transition = await integrationArtifact("transitions/foundation-public-contract.json");
        const validate = await validator("transition-schema.json");

        expect(validate(transition)).toBe(true);
        expect(stringAt(transition, "state")).toBe("completed");
        expect(stringAt(transition, "canonicalOwner")).toBe("W0");
        expect(objectsAt(transition, "inputs").map((input) => stringAt(input, "owner"))).toEqual([
            "W0",
            "W1"
        ]);
        expect(transition["completion"]).not.toBeNull();
        expect(stringsAt(transition, "allowedForeignPaths")).toContain(
            "packages/agent-core/artifacts/quality/exports.json"
        );
        expect(
            validate({ ...transition, allowedForeignPaths: ["packages/agent-core/scripts/**"] })
        ).toBe(false);
    });

    test("requires a change manifest for integration candidates", async () => {
        const transition = await integrationArtifact("transitions/w9-integration-candidate.json");
        const validate = await validator("transition-schema.json");
        const { changeManifest: _, ...withoutManifest } = transition;
        expect(validate(transition)).toBe(true);
        expect(validate(withoutManifest)).toBe(false);
    });

    test("maps every archived request to one completed resolution and rejects W5 retry", async () => {
        const resolutions = await integrationArtifact("resolutions.json");
        const entries = objectsAt(resolutions, "entries");
        const decisions = objectsAt(resolutions, "decisions");
        const retry = decisions.find((entry) => stringAt(entry, "id") === "W5-RETRY");
        expect(entries).toHaveLength(48);
        expect(new Set(entries.map((entry) => stringAt(entry, "source"))).size).toBe(48);
        expect(entries.filter((entry) => stringAt(entry, "state") === "applied")).toHaveLength(47);
        expect(
            entries.filter((entry) => stringAt(entry, "state") === "external-gated")
        ).toHaveLength(1);
        expect(entries.every((entry) => entry["completion"] !== null)).toBe(true);
        expect(retry).toMatchObject({ disposition: "rejected" });
        expect(stringAt(retry!, "integrationAction")).toContain("must remove");
    });

    test("resolution schema requires completion evidence after pending", async () => {
        const resolutions = await integrationArtifact("resolutions.json");
        const validate = await validator("resolution-schema.json");
        const entries = objectsAt(resolutions, "entries");
        expect(
            validate({
                ...resolutions,
                entries: [{ ...entries[0]!, completion: null }, ...entries.slice(1)]
            })
        ).toBe(false);
    });

    test("requires immutable blobs for completed transitions and dispositions", async () => {
        const transition = await integrationArtifact("transitions/w9-integration-candidate.json");
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
        const withoutBlob = {
            ...completion,
            artifacts: completion.artifacts.map(({ blob: _blob, ...rest }) => rest)
        };
        expect(
            transitionValidate({
                ...transition,
                state: "completed",
                blockers: [],
                completion: withoutBlob
            })
        ).toBe(false);

        const dispositions = await integrationArtifact("dispositions.json");
        const dispositionValidate = await validator("disposition-schema.json");
        const waves = objectsAt(dispositions, "waves").slice(0, 9);
        expect(
            dispositionValidate({
                ...dispositions,
                waves: [
                    ...waves,
                    {
                        owner: "W9",
                        state: "completed",
                        commit: completion.commit,
                        tree: completion.tree,
                        clean: true,
                        artifacts: completion.artifacts,
                        blockers: []
                    }
                ]
            })
        ).toBe(true);
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
        const verification = await integrationArtifact("owned-path-verification.json");
        const waves = objectsAt(verification, "waves");
        const validate = await validator("owned-path-verification-schema.json");

        expect(validate(verification)).toBe(true);
        expect(stringAt(verification, "owner")).toBe("W0");
        expect(waves).toHaveLength(9);
        expect(waves.flatMap((wave) => arrayAt(wave, "violations"))).toEqual([]);
        expect(arrayAt(verification, "violations")).toEqual([]);
        expect(waves.find((wave) => stringAt(wave, "owner") === "W8")?.["splitPaths"]).toEqual([
            { path: "packages/agent-core-cloudflare/tsconfig.build.json", owner: "W0" },
            { path: "packages/agent-core-cloudflare/tsconfig.json", owner: "W0" }
        ]);
    });
});

function run(stage: string): QualitySubprocessResult {
    return runQualitySubprocess(process.execPath, [checker, "--stage", stage], packageRoot);
}

function integrationArtifact(path: string): Promise<JsonObject> {
    return readArtifact(`artifacts/integration/${path}`);
}

async function validator(path: string): Promise<(value: JsonValue) => boolean> {
    const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
    return ajv.compile(await integrationArtifact(path));
}

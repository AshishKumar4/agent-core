import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { objectAt, objectsAt, readArtifactSync, stringAt, stringsAt } from "./artifacts";
import { isJsonObject } from "../../scripts/quality/project.mjs";
import type { JsonObject, JsonValue } from "../../scripts/quality/project.mjs";

const packageRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = resolve(packageRoot, "../..");
const archiveRoot = resolve(packageRoot, "artifacts/integration/request-archive");

describe("request outcome reconciliation", () => {
    test("supersedes W1 and W2 detached Vitest configs with aggregate exact-source coverage", () => {
        const w1 = readFileSync(resolve(archiveRoot, "W1/vitest.config.mjs"), "utf8");
        const w2 = readFileSync(resolve(archiveRoot, "W2/vitest.config.mjs"), "utf8");
        const integrated = readFileSync(resolve(packageRoot, "vitest.config.mjs"), "utf8");
        for (const config of [w1, w2, integrated]) {
            expect(config).toContain('provider: "v8"');
            expect(config).toContain("all: true");
        }
        expect(w1).toContain("exclude: []");
        expect(integrated).toContain('include: ["src/**/*.ts"]');
    });

    test("subsumes W2, W5, and W6 detached coverage evidence under owner-complete global coverage", () => {
        const coverage = objectAt(readArtifactSync("artifacts/quality/policy.json"), "coverage");
        const w2 = archivedArtifact("W2/coverage-manifest.json");
        const w5 = archivedArtifact("W5/coverage.json");
        const w5Minimum = numberAt(w5, "minimumPercent");
        const w6 = readFileSync(resolve(archiveRoot, "W6/coverage.md"), "utf8");
        expect(coverage["threshold"]).toBe(95);
        // The universe set is the workspace package set, derived rather than listed, so
        // a new package cannot be covered by nothing and still satisfy this evidence.
        const workspaceRoots = readdirSync(resolve(repositoryRoot, "packages"), {
            withFileTypes: true
        })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `packages/${entry.name}/src`)
            .sort();
        expect(
            objectsAt(coverage, "sourceUniverses")
                .map((universe) => stringAt(universe, "root"))
                .sort()
        ).toEqual(workspaceRoots);
        expect(stringsAt(w2, "sourceFiles").length).toBeGreaterThan(30);
        expect(stringsAt(w2, "testFiles").length).toBeGreaterThan(10);
        expect(
            Object.values(objectAt(w5, "metrics")).every((metric) => {
                const counts = isJsonObject(metric) ? metric : {};
                return numberAt(counts, "covered") * 100 >= w5Minimum * numberAt(counts, "total");
            })
        ).toBe(true);
        expect(w6).toContain("covered * 100 >= 95 * total");
    });

    test("keeps interceptor public export closed until exact Turn-bound context exists", () => {
        const packageJson = readArtifactSync("package.json");
        const exportsRegistry = readArtifactSync("artifacts/quality/exports.json");
        expect(Object.keys(objectAt(packageJson, "exports"))).not.toContain("./interceptors");
        for (const section of ["runtime", "declarations"]) {
            expect(
                Object.values(objectAt(exportsRegistry, section))
                    .flatMap((names) => (Array.isArray(names) ? names : []))
                    .some((name) => name === "InterceptorContext")
            ).toBe(false);
        }
    });

    test("normalizes W8 package scripts into aggregate lanes while retaining exact dependencies", () => {
        const request = archivedArtifact("W8/shared-integration.json");
        const dependencyRequest = objectsAt(request, "requests").find(
            (entry) => stringAt(entry, "id") === "W8-W0-DEPENDENCIES"
        );
        const exactDependencies = objectAt(dependencyRequest!, "exactDependencies");
        const packageJson = readArtifactSync("../../packages/agent-core-cloudflare/package.json");
        // The archived request is byte-frozen evidence of what W8 asked for. The live
        // package may gain dependencies afterwards, and every requested pin must still
        // hold — unless the resolution ledger records that pin as superseded, and its
        // rationale states the dependency, the version W8 reviewed and the version that
        // replaced it. A drifted pin with no recorded supersession fails here, and so
        // does a supersession whose prose no longer describes the live manifest, which is
        // what keeps the rationale evidence rather than decoration.
        expect(objectAt(packageJson, "dependencies")).toEqual(
            expect.objectContaining(objectAt(exactDependencies, "dependencies"))
        );
        const reviewed = objectAt(exactDependencies, "devDependencies");
        const live = objectAt(packageJson, "devDependencies");
        const held: Record<string, JsonValue> = {};
        const superseded: { name: string; reviewed: string; live: string }[] = [];
        for (const [name, pin] of Object.entries(reviewed)) {
            if (live[name] === pin) held[name] = pin;
            else superseded.push({ name, reviewed: String(pin), live: String(live[name]) });
        }
        expect(live).toEqual(expect.objectContaining(held));
        if (superseded.length > 0) {
            const rationale = supersededRationale(
                "artifacts/requests/W8/shared-integration.json::integration::W8-W0-DEPENDENCIES"
            );
            for (const pin of superseded) {
                expect(rationale).toContain(pin.name);
                expect(rationale).toContain(pin.reviewed);
                expect(rationale).toContain(pin.live);
            }
        }
        expect(objectAt(packageJson, "scripts")).toEqual(
            expect.objectContaining({
                build: expect.any(String),
                "check:cloudflare-types": expect.any(String),
                "check:coverage": expect.any(String),
                "check:consumer": expect.any(String),
                "check:exports": expect.any(String),
                "check:types": expect.any(String),
                lint: expect.any(String),
                test: expect.any(String),
                "test:structural": expect.any(String),
                "test:cloudflare": expect.any(String)
            })
        );
    });
});

/**
 * The rationale the resolution ledger records for one superseded obligation. An
 * obligation the ledger does not classify as superseded has no rationale to offer, and
 * saying so is the point: that is the case where a drifted pin is an ungoverned change.
 */
function supersededRationale(obligationId: string): string {
    const resolutions = readArtifactSync("artifacts/integration/resolutions.json");
    for (const entry of objectsAt(resolutions, "entries")) {
        const outcome = entry["outcome"];
        if (!isJsonObject(outcome)) continue;
        for (const item of objectsAt(outcome, "items")) {
            if (stringAt(item, "obligationId") !== obligationId) continue;
            expect(stringAt(item, "treatment")).toBe("superseded");
            return stringAt(item, "rationale");
        }
    }
    throw new TypeError(`Resolution ledger records no outcome for ${obligationId}`);
}

function archivedArtifact(path: string): JsonObject {
    return readArtifactSync(`artifacts/integration/request-archive/${path}`);
}

function numberAt(owner: JsonObject, field: string): number {
    const value = owner[field];
    if (!Number.isFinite(value)) {
        throw new TypeError(`${field} must be a number`);
    }
    return Number(value);
}

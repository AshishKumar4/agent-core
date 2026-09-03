import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { objectAt, objectsAt, readArtifact, stringsAt } from "./artifacts";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/check-service-contracts.mjs");
const artifactPath = resolve(packageRoot, "artifacts/service-contracts.json");
const temporary: string[] = [];
let committed: string;

beforeAll(async () => {
    committed = await readFile(artifactPath, "utf8");
});

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

/**
 * The gate's own discrimination. `scripts/check-service-contracts.mjs` reads every
 * vocabulary, code union, adapter, mechanism and selector from source and compares it to
 * what `artifacts/service-contracts.json` claims — so the only thing that can show it is
 * doing that is a claim it refuses. Each case here substitutes one wrong claim and
 * asserts the gate names it; the control asserts the committed artifact is green, because
 * a checker that rejects everything discriminates nothing.
 */
describe("service contract gate", subprocessTestOptions, () => {
    test("agrees with the committed artifact", async () => {
        const result = runQualitySubprocess(process.execPath, [checker], packageRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("agrees with its source and its suite");
    });

    test("refuses a vocabulary the suite does not declare", async () => {
        const drifted = await mutate('"operations": ["complete"],', '"operations": ["complete", "stream"],');

        expect(drifted.status).not.toBe(0);
        expect(drifted.output).toContain("lists operations [complete, stream] and");
    });

    test("refuses a reordered refusal tuple", async () => {
        // Order, not just membership: the suite proves its taxonomy total by iterating its
        // own tuple, so an artifact listing another order describes another iteration.
        const reordered = await mutate(
            '"model.malformed-response",\n        "model.rejected",',
            '"model.rejected",\n        "model.malformed-response",'
        );

        expect(reordered.status).not.toBe(0);
        expect(reordered.output).toContain("lists refusals [");
    });

    test("refuses a code its declared union does not carry", async () => {
        const invented = await mutate('"code": "model.unavailable",', '"code": "model.overloaded",');

        expect(invented.status).not.toBe(0);
        expect(invented.output).toContain(
            "model.overloaded, which its declared code union does not carry"
        );
    });

    test("refuses a union member no service maps and no entry excuses", async () => {
        const unexcused = await mutate(
            '          "code": "loop.step-budget-exhausted",',
            '          "code": "model.rejected",'
        );

        expect(unexcused.status).not.toBe(0);
        expect(unexcused.output).toContain(
            "carries loop.step-budget-exhausted and no service taxonomy maps it"
        );
    });

    test("refuses a reply vocabulary in which a failure is not a value", async () => {
        for (const kind of ["refused", "indeterminate"]) {
            const collapsed = await mutate(`"${kind}", `, "").catch(() => undefined);
            const result = collapsed ?? (await mutate(`, "${kind}"`, ""));

            expect(result.status).not.toBe(0);
            expect(result.output).toContain(`declares no ${kind} reply`);
        }
    });

    test("refuses a paraphrased case", async () => {
        const paraphrased = await mutate(
            "refuses an unrenderable request without reaching the service",
            "refuses an unrenderable request before reaching the service"
        );

        expect(paraphrased.status).not.toBe(0);
        expect(paraphrased.output).toContain("cites a case no suite text spells");
    });

    test("refuses an implementation no case ran under", async () => {
        const fabricated = await mutate(
            '"name": "OpenAI-compatible adapter",',
            '"name": "Anthropic adapter",'
        );

        expect(fabricated.status).not.toBe(0);
        expect(fabricated.output).toContain("cites no case that ran under it");
    });

    test("refuses a gap premise that does not say what is owed", async () => {
        const silent = await mutate('"premise": "modelAbortStopsTheInference"', '"premise": "modelAbortStopsTheInference2"');

        expect(silent.status).not.toBe(0);
        // Renaming a premise orphans it from the service that rests on it, which is the
        // same class of break as dropping the obligation.
        expect(silent.output).toMatch(/premise modelAbortStopsTheInference\b/u);
    });

    test("refuses a citation to a substrate seam that does not exist", async () => {
        const stale = await mutate('"seam": "content",', '"seam": "objects",');

        expect(stale.status).not.toBe(0);
        expect(stale.output).toContain("names substrate seam objects, which does not exist");
    });

    test("refuses a mechanism citing a file that does not exist", async () => {
        const missing = await mutate(
            "packages/agent-core-harness/src/model/port.ts:96-108",
            "packages/agent-core-harness/src/model/tools.ts:96-108"
        );

        expect(missing.status).not.toBe(0);
        expect(missing.output).toContain("which does not exist");
    });

    test("holds every service to a reference and a real adapter", async () => {
        const artifact = await readArtifact("artifacts/service-contracts.json");
        for (const service of objectsAt(artifact, "services")) {
            const kinds = objectsAt(objectAt(service, "suite"), "implementations").map(
                (implementation) => implementation["kind"]
            );
            const adapters = stringsAt(service, "adapters");

            expect(kinds).toContain("reference");
            // An absent adapter is the one admissible reason to run a contract against a
            // reference alone, and the artifact has to say so in its adapter list rather
            // than leave the omission to be read as an oversight.
            expect(kinds.includes("adapter") || adapters.includes("absent")).toBe(true);
        }
    });
});

/** The committed artifact with one substitution, judged by the real checker. */
async function mutate(find: string, replace: string) {
    if (!committed.includes(find)) {
        throw new TypeError(`Service contract fixture no longer contains ${find}`);
    }
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-service-contracts-"));
    temporary.push(root);
    const path = resolve(root, "service-contracts.json");
    await writeFile(path, committed.replace(find, replace), "utf8");
    const result = runQualitySubprocess(
        process.execPath,
        [checker, "--artifact", path],
        packageRoot
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { objectAt, objectsAt, readArtifact, stringsAt } from "./artifacts";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";
import {
    assertArray,
    assertObject,
    assertString,
    parseCanonicalJson,
    type JsonObject,
    type JsonValue
} from "../../scripts/quality/project.mjs";

/**
 * A validated artifact opened for one substitution. `JsonObject`'s index signature is
 * read-only, which is right for every reader of a committed artifact and wrong for a
 * fixture whose whole job is to hold one wrong claim.
 */
type MutableArtifact = { [key: string]: JsonValue };

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/check-service-contracts.mjs");
const artifactPath = resolve(packageRoot, "artifacts/service-contracts.json");
const temporary: string[] = [];
let committed: JsonObject;

beforeAll(async () => {
    committed = assertObject(
        parseCanonicalJson(
            await readFile(artifactPath, "utf8"),
            "artifacts/service-contracts.json"
        ),
        "artifacts/service-contracts.json"
    );
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
 * doing that is a claim it refuses. Each case here substitutes one wrong claim and asserts
 * the gate names it; the control asserts the committed artifact is green, because a
 * checker that rejects everything discriminates nothing.
 *
 * Mutations edit the parsed artifact rather than its text. A text fixture would break
 * whenever the artifact was reformatted or a service was added, and a discrimination test
 * that fails for that reason teaches a reader to loosen it.
 */
describe("service contract gate", subprocessTestOptions, () => {
    test("agrees with the committed artifact", async () => {
        const result = runQualitySubprocess(process.execPath, [checker], packageRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("agrees with its source and its suite");
    });

    test("refuses a vocabulary the suite does not declare", async () => {
        const drifted = await mutate((artifact) => {
            first(artifact)["operations"] = ["complete", "stream"];
        });

        expect(drifted.status).not.toBe(0);
        expect(drifted.output).toContain("lists operations [complete, stream] and");
    });

    test("refuses a reordered refusal tuple", async () => {
        // Order, not just membership: a suite proves its taxonomy total by iterating its
        // own tuple, so an artifact listing another order describes another iteration.
        const reordered = await mutate((artifact) => {
            first(artifact)["refusals"] = [...stringsOf(first(artifact), "refusals")].reverse();
        });

        expect(reordered.status).not.toBe(0);
        expect(reordered.output).toContain("lists refusals [");
    });

    test("refuses a code its declared union does not carry", async () => {
        const invented = await mutate((artifact) => {
            row(first(artifact), "taxonomy", 0)["code"] = "model.overloaded";
        });

        expect(invented.status).not.toBe(0);
        expect(invented.output).toContain(
            "model.overloaded, which its declared code union does not carry"
        );
    });

    test("refuses a union member no service maps and no entry excuses", async () => {
        const unexcused = await mutate((artifact) => {
            union(artifact, "HarnessErrorCode")["outsideServiceTaxonomy"] = [];
        });

        expect(unexcused.status).not.toBe(0);
        expect(unexcused.output).toContain(
            "carries loop.step-budget-exhausted and no service taxonomy maps it"
        );
    });

    test("refuses a reply vocabulary in which a failure is not a value", async () => {
        for (const kind of ["refused", "indeterminate"]) {
            const collapsed = await mutate((artifact) => {
                const service = first(artifact);
                service["replies"] = stringsOf(service, "replies").filter((name) => name !== kind);
            });

            expect(collapsed.status).not.toBe(0);
            expect(collapsed.output).toContain(`declares no ${kind} reply`);
        }
    });

    test("refuses a paraphrased case", async () => {
        const paraphrased = await mutate((artifact) => {
            const suite = objectOf(first(artifact), "suite");
            suite["selectors"] = stringsOf(suite, "selectors").map((selector, index) =>
                index === 2 ? selector.replace("without reaching", "before reaching") : selector
            );
        });

        expect(paraphrased.status).not.toBe(0);
        expect(paraphrased.output).toContain("cites a case no suite text spells");
    });

    test("refuses an implementation no case ran under", async () => {
        const fabricated = await mutate((artifact) => {
            row(objectOf(first(artifact), "suite"), "implementations", 1)["name"] =
                "Anthropic adapter";
        });

        expect(fabricated.status).not.toBe(0);
        expect(fabricated.output).toContain("cites no case that ran under it");
    });

    test("refuses a gap premise that does not say what is owed", async () => {
        const silent = await mutate((artifact) => {
            const gap = objectsOf(artifact, "premises").find(
                (premise) => premise["channel"] === "gap"
            );
            if (gap === undefined) throw new TypeError("The artifact states no gap premise");
            gap["owed"] = null;
        });

        expect(silent.status).not.toBe(0);
        expect(silent.output).toContain("is a gap and does not say what is owed");
    });

    test("refuses an invariant with neither a case nor a scope", async () => {
        const bare = await mutate((artifact) => {
            const invariant = row(first(artifact), "invariants", 0);
            invariant["selectors"] = [];
            invariant["scope"] = null;
        });

        expect(bare.status).not.toBe(0);
        expect(bare.output).toContain("with neither a case nor a scope");
    });

    test("refuses a citation to a substrate seam that does not exist", async () => {
        const stale = await mutate((artifact) => {
            objectsOf(artifact, "citedElsewhere")[0]!["seam"] = "objects";
        });

        expect(stale.status).not.toBe(0);
        expect(stale.output).toContain("names substrate seam objects, which does not exist");
    });

    test("refuses a mechanism citing a symbol its file does not spell", async () => {
        const missing = await mutate((artifact) => {
            row(first(artifact), "taxonomy", 0)["mechanism"] =
                "packages/agent-core-harness/src/model/openai-compatible.ts#NoSuchSymbol prose";
        });

        expect(missing.status).not.toBe(0);
        expect(missing.output).toContain("absent from");
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

/** The same accessors `objectsAt` gives, on a value this test is about to mutate. */
function objectsOf(owner: MutableArtifact, field: string): MutableArtifact[] {
    // SAFETY: every entry is validated as a JSON object by assertObject; the only thing
    // widened is the index signature's mutability, on a clone this file owns.
    return assertArray(owner[field], field).map(
        (entry, index) => assertObject(entry, `${field}[${index}]`) as MutableArtifact
    );
}

function objectOf(owner: MutableArtifact, field: string): MutableArtifact {
    // SAFETY: assertObject proves the value is a JSON object; only the index signature's
    // mutability is widened, on a clone this file owns.
    return assertObject(owner[field], field) as MutableArtifact;
}

function stringsOf(owner: MutableArtifact, field: string): string[] {
    return assertArray(owner[field], field).map((entry, index) =>
        assertString(entry, `${field}[${index}]`)
    );
}

function row(owner: MutableArtifact, field: string, index: number): MutableArtifact {
    const entry = objectsOf(owner, field)[index];
    if (entry === undefined) throw new TypeError(`${field}[${index}] is absent`);
    return entry;
}

function first(artifact: MutableArtifact): MutableArtifact {
    return row(artifact, "services", 0);
}

function union(artifact: MutableArtifact, name: string): MutableArtifact {
    const entry = objectsOf(artifact, "codeUnions").find(
        (candidate) => candidate["union"] === name
    );
    if (entry === undefined) throw new TypeError(`No code union ${name}`);
    return entry;
}

/** The committed artifact with one wrong claim, judged by the real checker. */
async function mutate(apply: (artifact: MutableArtifact) => void) {
    // SAFETY: a structured clone of a JsonObject is JSON data of the same shape, and this
    // copy is the call's own — nothing else reads it and the committed artifact is
    // untouched — so dropping the read-only index signature cannot affect anything else.
    const artifact = structuredClone(committed) as MutableArtifact;
    apply(artifact);
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-service-contracts-"));
    temporary.push(root);
    const path = resolve(root, "service-contracts.json");
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const result = runQualitySubprocess(
        process.execPath,
        [checker, "--artifact", path],
        packageRoot
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

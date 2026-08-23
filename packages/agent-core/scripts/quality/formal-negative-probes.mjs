import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Planted-negative harness for the formal traceability gate. Each probe edits a
// tracked file, runs `node scripts/check-traceability.mjs`, requires a nonzero
// exit whose output matches the intended rejection, and restores the exact
// original bytes before moving on.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const gate = join(packageRoot, "scripts", "check-traceability.mjs");

function snapshot(path) {
    const bytes = readFileSync(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
        restore() {
            writeFileSync(path, bytes);
            if (
                createHash("sha256").update(readFileSync(path)).digest("hex") !== sha256
            ) {
                throw new Error(`failed to restore ${path}`);
            }
        }
    };
}

function runGate(scriptPath = gate) {
    const result = spawnSync(process.execPath, [scriptPath], {
        cwd: packageRoot,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024
    });
    return { exit: result.status, output: `${result.stdout}${result.stderr}` };
}

const normativeGate = join(packageRoot, "scripts", "check-normative.mjs");

const probes = [
    {
        name: "designation deletion",
        target: join(packageRoot, "formal", "AgentCore", "Axioms.lean"),
        pattern: /owned theorem is not designated by Axioms\.lean: AgentCore\.prepared_item_key_is_derived/u,
        plant(source) {
            return source.replace(
                "#print axioms AgentCore.prepared_item_key_is_derived\n",
                ""
            );
        }
    },
    {
        name: "witness-link (family) deletion",
        target: join(packageRoot, "artifacts", "traceability.yaml"),
        pattern: /crossRequirementWitnessFamil/u,
        plant(source) {
            const value = JSON.parse(source);
            value.crossRequirementWitnessFamilies.shift();
            return `${JSON.stringify(value, null, 2)}\n`;
        },
    },
    {
        name: "sorry injection",
        target: join(packageRoot, "formal", "AgentCore", "CanonicalJson.lean"),
        pattern: /depends on sorryAx: AgentCore\.foreign_subject_key_separates_verification_schemes/u,
        plant(source) {
            const anchor =
                "subjectKeyText (.foreign homeTenant principal \"callback\".toList) := by\n" +
                "  intro equal\n" +
                "  have same := subject_key_injective equal\n" +
                "  simp [SubjectRefText.foreign.injEq] at same";
            if (!source.includes(anchor)) throw new Error("sorry anchor not found");
            return source.replace(
                anchor,
                "subjectKeyText (.foreign homeTenant principal \"callback\".toList) := by\n" +
                    "  intro equal\n" +
                    "  exact sorry"
            );
        }
    },
    {
        name: "forbidden axiom via native_decide",
        target: join(packageRoot, "formal", "AgentCore", "Examples.lean"),
        pattern: /disallowed axiom (Lean\.ofReduceBool|AgentCore\.\S*_native\.native_decide\.ax_\S*)/u,
        plant(source) {
            const anchor =
                'test "nonvacuous_glob_match_discriminates"'; // documentation only
            void anchor;
            const marker = source.indexOf("nonvacuous_glob_match_discriminates");
            if (marker === -1) throw new Error("glob discriminates theorem not found");
            const decideIndex = source.indexOf("by decide", marker);
            if (decideIndex === -1) throw new Error("by decide not found after marker");
            return (
                source.slice(0, decideIndex) +
                "by native_decide" +
                source.slice(decideIndex + "by decide".length)
            );
        }
    },
    {
        // Regression for the 4.33.1 under-closure: applyDelta is reachable
        // only through the internal replay._f artifact, so a semantic edit to
        // it must turn the normative gate red instead of hiding behind the
        // cutoff that once emptied the view-chain closures.
        name: "semantic mutation behind internal artifact",
        target: join(packageRoot, "formal", "AgentCore", "View.lean"),
        script: normativeGate,
        pattern: /normative\.lock is stale|check:normative Lean build failed/u,
        plant(source) {
            const anchor =
                "def applyDelta (view : ViewState) (delta : ViewDelta) : Option ViewState :=";
            if (!source.includes(anchor)) throw new Error("applyDelta anchor not found");
            const start = source.indexOf(anchor);
            const end = source.indexOf("def replay", start);
            if (end === -1) throw new Error("replay anchor not found");
            const segment = source.slice(start, end);
            if (!segment.includes("view.revision + 1")) {
                throw new Error("revision increment not found in applyDelta");
            }
            return (
                source.slice(0, start) +
                segment.replace("view.revision + 1", "view.revision + 2") +
                source.slice(end)
            );
        }
    }
];

let failures = 0;
for (const probe of probes) {
    const snap = snapshot(probe.target);
    let outcome;
    try {
        writeFileSync(probe.target, probe.plant(readFileSync(probe.target, "utf8")));
        outcome = runGate(probe.script);
    } finally {
        snap.restore();
    }
    const red = outcome.exit !== 0;
    const intended = red && probe.pattern.test(outcome.output);
    if (!intended) failures += 1;
    console.log(
        `${intended ? "PASS" : "FAIL"} ${probe.name}: exit=${outcome.exit} ` +
            `${red ? "red" : "green"}${intended ? "" : `\n${outcome.output.slice(0, 800)}`}`
    );
}

console.log(
    failures === 0
        ? "all planted negatives failed their gates for the intended reasons"
        : `${failures} planted negative(s) did not produce the intended rejection`
);
if (failures !== 0) {
    process.exitCode = 1;
    console.error(
        execFileSync("git", ["status", "--short"], { cwd: packageRoot }).toString()
    );
}

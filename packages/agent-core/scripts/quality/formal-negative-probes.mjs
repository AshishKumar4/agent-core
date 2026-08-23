import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

function runGate() {
    const result = spawnSync(process.execPath, [gate], {
        cwd: packageRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
    });
    return {
        exit: result.status,
        output: `${result.stdout}${result.stderr}`
    };
}

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
    }
];

let failures = 0;
for (const probe of probes) {
    const snap = snapshot(probe.target);
    let outcome;
    try {
        writeFileSync(probe.target, probe.plant(readFileSync(probe.target, "utf8")));
        outcome = runGate();
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

// Closure-mutation negative against the parity auditor itself.
{
    const headLock = execFileSync(
        "git",
        ["show", "HEAD:packages/agent-core/artifacts/normative.lock"],
        { cwd: packageRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }
    );
    const original = JSON.parse(headLock);
    const mutated = JSON.parse(headLock);
    const designation = mutated.designations.find(
        (entry) => entry.name === "AgentCore.prepared_item_key_is_derived"
    );
    const closure = mutated.semanticClosures.find(
        (entry) => entry.sha256 === designation.semanticClosureSha256
    );
    const [removedMember] = closure.declarations.splice(0, 1);
    const basePath = join(tmpdir(), "tmp-parity-base.lock");
    const mutatedPath = join(tmpdir(), "tmp-parity-mutated.lock");
    writeFileSync(basePath, headLock);
    writeFileSync(mutatedPath, `${JSON.stringify(mutated, null, 2)}\n`);
    const audit = spawnSync(
        process.execPath,
        [
            join(packageRoot, "scripts", "quality", "lock-parity-audit.mjs"),
            basePath,
            mutatedPath
        ],
        { cwd: packageRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }
    );
    const report = JSON.parse(audit.stdout);
    const delta = report.closureDeltas.deltas.find(
        (entry) => entry.designation === "claim:AgentCore.prepared_item_key_is_derived"
    );
    const detected =
        delta !== undefined &&
        delta.lost.some((member) => member.name === removedMember);
    console.log(
        `${detected ? "PASS" : "FAIL"} one-designation closure mutation: ` +
            `auditor ${detected ? "reports" : "misses"} lost member ${removedMember}`
    );
    if (!detected) failures += 1;
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

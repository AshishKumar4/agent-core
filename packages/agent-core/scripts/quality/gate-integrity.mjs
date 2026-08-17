// Gate integrity: a gate that cannot go red is not a gate.
//
// invariants.mjs certifies that every ACQ rule's checker node reported "passed". That
// cannot separate a checker which examined its whole input and found nothing from one a
// refactor turned into a no-op. discrimination.mjs already answered the identical
// question one layer down — a verified atom needs a recorded mutant of its cited symbol
// killed by its cited test, because the ledger "proves a verified atom's cited tests
// exist and pass; it cannot tell a test that proves the rule from one that merely runs
// nearby". This gate applies that argument to the checkers themselves.
//
// For each registered gate it copies the gate's real input into a scratch tree, applies
// one known-bad mutation from artifacts/quality/gate-corpus.json, runs the real checker
// against that tree, and fails when the checker PASSES. The unmutated copy runs first as
// a control: a checker that rejects everything discriminates nothing, and a scaffolding
// mistake that makes every run red would otherwise read as proof.
//
// Spawning another checker is the measurement, not a check of this repository. Every run
// reads a scratch tree under the OS temporary directory and its verdict is discarded;
// nothing here consults the repository's own gate results.
//
// Rules with no mutation harness are carried as a ratcheted debt list, exactly as
// discrimination.mjs carries undiscriminated atoms: an unlisted uncovered rule fails, a
// listed rule that gained a corpus fails until its entry is dropped, and the final stage
// admits no debt at all.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
    artifactRoot,
    assertArray,
    assertExactKeys,
    assertString,
    assertUniqueIds,
    assertUniqueStrings,
    packageRoot,
    readCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";

const subprocessTimeout = 120_000;
const mutationFields = ["defect", "diagnostic", "expects", "find", "id", "replace"];

/**
 * How to run one gate against a substituted input. The corpus artifact owns which
 * mutations to apply; this table owns the scratch tree each checker needs in order to
 * read one, because a gate's input is a tree of artifacts and not a single file.
 * `sources` is the checker's own source set: a corpus entry may only pin a diagnostic
 * those files state, so rewording a message cannot leave the corpus describing prose
 * nothing emits.
 */
const harnesses = {
    coherence: {
        input: "SPEC.md",
        sources: ["scripts/quality/coherence.mjs", "scripts/quality/spec.mjs"],
        async scaffold(root, input) {
            await writeFile(resolve(root, "SPEC.md"), input, "utf8");
            // The gate reads test titles from <root>/test and reports the issues absent
            // from its baseline. An empty tree of each keeps the verdict about the
            // mutation and nothing else.
            await mkdir(resolve(root, "test"), { recursive: true });
            await writeCanonicalJson(resolve(root, "coherence-baseline.json"), {
                edition: "1.0.0",
                issues: []
            });
        },
        argv(root) {
            return [
                resolve(packageRoot, "scripts/quality/coherence.mjs"),
                "--stage",
                "building",
                "--root",
                root,
                "--spec",
                resolve(root, "SPEC.md"),
                "--baseline",
                resolve(root, "coherence-baseline.json")
            ];
        }
    }
};

const options = parseArguments(process.argv.slice(2));
const graph = await readCanonicalJson(resolve(artifactRoot, "quality/check-dag.json"));
const rules = await readCanonicalJson(resolve(artifactRoot, "quality/rules.json"));
const corpus = await readCanonicalJson(options.corpus);
const checkerSources = new Map(
    await Promise.all(
        Object.entries(harnesses).map(async ([node, harness]) => [
            node,
            await Promise.all(
                harness.sources.map((path) => readFile(resolve(packageRoot, path), "utf8"))
            )
        ])
    )
);
validateCorpus(corpus, rules, graph, checkerSources);

const ruleIds = new Set(rules.rules.map((rule) => rule.id));
const registered = new Set(corpus.gates.map((gate) => gate.rule));
const debt = new Set(corpus.unregistered);
const unproven = [...ruleIds].filter((id) => !registered.has(id) && !debt.has(id)).sort();
const resolved = [...debt].filter((id) => registered.has(id)).sort();
const stale = [...debt].filter((id) => !ruleIds.has(id)).sort();

const controls = [];
const measurements = [];
for (const gate of corpus.gates) {
    const harness = harnesses[gate.node];
    const input = await readFile(resolve(packageRoot, harness.input), "utf8");
    const control = await runGate(harness, input);
    controls.push({
        gate: gate.rule,
        node: gate.node,
        red: control.status !== 0,
        detail: diagnosis(control.output)
    });
    for (const mutation of gate.mutations) {
        const parts = input.split(mutation.find);
        if (parts.length !== 2) {
            throw new TypeError(
                `Gate mutation ${mutation.id} locates ${parts.length - 1} occurrences in ${harness.input}`
            );
        }
        const measured = await runGate(harness, parts.join(mutation.replace));
        measurements.push({
            gate: gate.rule,
            node: gate.node,
            mutation: mutation.id,
            expects: mutation.expects,
            red: measured.status !== 0,
            diagnosed: measured.output.includes(mutation.expects),
            detail: diagnosis(measured.output)
        });
    }
}

const alwaysRed = controls.filter((control) => control.red);
const survivors = measurements.filter((measured) => !measured.red);
const misdiagnosed = measurements.filter((measured) => measured.red && !measured.diagnosed);
const report = {
    edition: "1.0.0",
    stage: options.stage,
    rules: ruleIds.size,
    registered: [...registered].sort(),
    unregistered: [...debt].sort(),
    controls,
    measurements,
    complete:
        alwaysRed.length === 0 &&
        survivors.length === 0 &&
        misdiagnosed.length === 0 &&
        unproven.length === 0 &&
        resolved.length === 0 &&
        stale.length === 0 &&
        debt.size === 0
};
await writeCanonicalJson(resolve(reportRoot, "gate-integrity.json"), report);

if (alwaysRed.length > 0) {
    fail(
        "Gate rejects its own unmutated input, so no mutation of it proves anything",
        alwaysRed.map((control) => `${control.node}: ${control.detail}`)
    );
}
if (survivors.length > 0) {
    fail(
        "Gate passed under a known-bad mutation of its own input",
        survivors.map((measured) => `${measured.node} survived ${measured.mutation}`)
    );
}
if (misdiagnosed.length > 0) {
    fail(
        "Gate went red for the wrong reason under a known-bad mutation",
        misdiagnosed.map(
            (measured) =>
                `${measured.mutation} expected ${JSON.stringify(measured.expects)} and reported ${JSON.stringify(measured.detail)}`
        )
    );
}
if (unproven.length > 0) {
    fail("Quality rule has no mutation corpus and no recorded debt", unproven);
}
// The debt list is debt, not a permanent allowance: a rule that gained a corpus must
// leave it, or the gate silently re-accepts an unproven checker if the corpus is lost.
if (resolved.length > 0) fail("Gate corpus debt retains registered rules", resolved);
if (stale.length > 0) fail("Gate corpus debt names rules no rule registry states", stale);
if (options.stage === "final" && debt.size > 0) {
    fail("Final gate integrity admits no unproven quality rule", [...debt].sort());
}
console.log(
    `gate integrity ${report.complete ? "complete" : "incomplete"}: ` +
        `${measurements.length} mutation(s) turned ${registered.size} of ${ruleIds.size} rule(s) red, ` +
        `${debt.size} unproven`
);

async function runGate(harness, input) {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-gate-integrity-"));
    try {
        await harness.scaffold(root, input);
        const result = spawnSync(process.execPath, harness.argv(root), {
            cwd: packageRoot,
            encoding: "utf8",
            timeout: subprocessTimeout,
            killSignal: "SIGKILL"
        });
        if (result.error !== undefined) throw result.error;
        return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

/**
 * A checker reports by throwing, so its output starts with the runtime's file-and-line
 * banner and ends in a stack. The reported detail is the thrown message alone: the
 * banner names gate-integrity's own scratch run and would read as the finding.
 */
function diagnosis(output) {
    const lines = output.split("\n");
    const thrown = lines.findIndex((line) => /^[A-Za-z]*Error: /u.test(line));
    if (thrown < 0) return lines.map((line) => line.trim()).find((line) => line !== "") ?? "";
    const stack = lines.slice(thrown).findIndex((line) => /^\s+at /u.test(line));
    return lines
        .slice(thrown, stack < 0 ? undefined : thrown + stack)
        .join("\n")
        .trim();
}

/**
 * The corpus is data this gate trusts to describe real inputs and real diagnostics, so
 * every field is checked before a subprocess runs: a mutation that does not change its
 * input, or that pins prose no checker states, would report proof it never obtained.
 */
function validateCorpus(value, ruleRegistry, dag, sources) {
    assertExactKeys(value, ["edition", "gates", "unregistered"], "quality/gate-corpus.json");
    if (value.edition !== "1.0.0") throw new TypeError("Gate corpus edition is unsupported");
    assertArray(value.gates, "quality/gate-corpus.json gates");
    assertUniqueStrings(value.unregistered, "quality/gate-corpus.json unregistered");
    assertUniqueIds(value.gates, (gate) => gate.rule, "quality/gate-corpus.json gates");
    const nodes = new Map(ruleRegistry.rules.map((rule) => [rule.id, rule.node]));
    const seen = new Set();
    for (const gate of value.gates) {
        assertExactKeys(gate, ["mutations", "node", "rule"], "quality/gate-corpus.json gate");
        assertString(gate.rule, "quality/gate-corpus.json gate rule");
        assertString(gate.node, "quality/gate-corpus.json gate node");
        if (nodes.get(gate.rule) !== gate.node) {
            throw new TypeError(
                `Gate corpus binds ${gate.rule} to ${gate.node}, which is not its rule registry node`
            );
        }
        if (dag.nodes[gate.node] === undefined) {
            throw new TypeError(`Gate corpus names quality node ${gate.node}, which the DAG omits`);
        }
        if (harnesses[gate.node] === undefined) {
            throw new TypeError(`Gate corpus registers ${gate.node} with no mutation harness`);
        }
        assertArray(gate.mutations, `quality/gate-corpus.json ${gate.rule} mutations`);
        if (gate.mutations.length === 0) {
            throw new TypeError(`Gate ${gate.rule} registers no mutation of its own input`);
        }
        assertUniqueIds(
            gate.mutations,
            (mutation) => mutation.id,
            `quality/gate-corpus.json ${gate.rule} mutations`
        );
        for (const mutation of gate.mutations) {
            validateMutation(mutation, gate, sources.get(gate.node), seen);
        }
    }
    const unused = Object.keys(harnesses).filter(
        (node) => !value.gates.some((gate) => gate.node === node)
    );
    if (unused.length > 0) {
        throw new TypeError(`Mutation harness registers no gate: ${unused.join(", ")}`);
    }
}

function validateMutation(mutation, gate, sources, seen) {
    assertExactKeys(mutation, mutationFields, `quality/gate-corpus.json ${gate.rule} mutation`);
    for (const field of mutationFields) {
        assertString(mutation[field], `quality/gate-corpus.json mutation ${field}`);
    }
    if (!mutation.id.startsWith(`${gate.rule}/`)) {
        throw new TypeError(`Gate mutation ${mutation.id} is not named for rule ${gate.rule}`);
    }
    if (mutation.find === mutation.replace) {
        throw new TypeError(`Gate mutation ${mutation.id} leaves its input unchanged`);
    }
    if (!mutation.expects.includes(mutation.diagnostic)) {
        throw new TypeError(
            `Gate mutation ${mutation.id} expects prose that does not carry its pinned diagnostic`
        );
    }
    // One fixture never proves two gates: a repeated mutation would let one defect stand
    // in for two independent rules.
    const key = `${mutation.find}\u0000${mutation.replace}`;
    if (seen.has(key)) throw new TypeError(`Gate mutation ${mutation.id} repeats another mutation`);
    seen.add(key);
    if (!sources.some((source) => source.includes(mutation.diagnostic))) {
        throw new TypeError(
            `Gate mutation ${mutation.id} pins a diagnostic no ${gate.node} checker source states`
        );
    }
}

function fail(title, values) {
    throw new TypeError(`${title}:\n${values.map((value) => `  ${value}`).join("\n")}`);
}

function parseArguments(args) {
    let stage = "building";
    let corpusPath = resolve(artifactRoot, "quality/gate-corpus.json");
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--corpus") corpusPath = resolve(required(args, ++index, argument));
        else throw new TypeError(`Unknown gate integrity argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return { stage, corpus: corpusPath };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}

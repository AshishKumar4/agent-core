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
// For each registered gate it copies the repository into a scratch tree, applies one
// known-bad mutation from artifacts/quality/gate-corpus.json to the one file that gate
// names, runs the real checker against that tree, and fails when the checker PASSES. An
// unmutated copy of every input is measured beside them and judged first, as a control: a
// checker that rejects everything discriminates nothing, and a scaffolding mistake that
// makes every run red would otherwise read as proof.
//
// Spawning another checker is the measurement, not a check of this repository. Every run
// reads and writes a scratch tree under the OS temporary directory and its verdict is
// discarded; nothing here consults, or leaves anything in, the repository's own reports.
//
// Rules with no mutation harness are carried as a ratcheted debt list, exactly as
// discrimination.mjs carries undiscriminated atoms: an unlisted uncovered rule fails, a
// listed rule that gained a corpus fails until its entry is dropped, and the final stage
// admits no debt at all.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { updateOutcomeBaseline } from "./outcome-baseline.mjs";
import {
    artifactRoot,
    assertArray,
    assertExactKeys,
    assertString,
    assertUniqueIds,
    assertUniqueStrings,
    collectFiles,
    jsonKind,
    packageRoot,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";

const subprocessTimeout = 120_000;
/**
 * How many measurements run at once. Each one copies the whole repository into a scratch
 * tree and spawns a real checker inside it, so the cost per worker is a repository's
 * working set rather than a thread; on a machine with many cores and a memory ceiling,
 * `availableParallelism()` workers exhaust the ceiling and the run is killed with no
 * report written at all — a SIGKILL that reads as every control being red with an empty
 * diagnostic, which is the one failure shape that looks like a finding and is not.
 *
 * The bound is stated here rather than left to the host because the host's core count is
 * not the resource this saturates. A run under it is slower and finishes; a run over it
 * measures nothing.
 */
const MEASUREMENT_CONCURRENCY = 4;
const gateFields = ["input", "mutations", "node", "rule"];
const mutationFields = ["defect", "diagnostic", "expects", "find", "id", "replace"];
const corePackage = "packages/agent-core";
// Every checker resolves its artifacts, its reports, its sources, its built declarations
// and the SPEC from its own module location, so the tree a measurement runs in has to be a
// repository rather than a directory of fixtures. Everything but the reports is copied,
// because the reports are what the harnesses state. Node modules and the git directory are
// shared by name: the checkers only ever read them, and the recorded evidence some of them
// verify is bound to git objects that exist nowhere else.
const uncopied = new Set([".git", "node_modules", "reports"]);
const shared = [
    ".git",
    "node_modules",
    `${corePackage}/node_modules`,
    "packages/agent-core-cloudflare/node_modules",
    "packages/agent-core-harness/node_modules"
];
/**
 * The constant proof text the ACQ-REPAIR measurements agree on: the seed ledger accepts
 * it, and the scaffold plants it in the scratch formal tree. Both sides are this module's
 * own constant, so neither the committed ledger's advancement nor the reviewed formal
 * tree's own evolution can move the corpus's mutation base.
 */
const PROOF_REPAIR_DRIFT_PROBE_TEXT = "theorem gate_drift_probe : True := trivial\n";

const coveredSpan = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };

/**
 * The scratch repository. Harness scratch files sit beside it and never inside it: an
 * untracked file in the clone is a path the exclusive-ownership rule reports as unowned.
 */
function tree(root) {
    return resolve(root, "tree");
}

function core(root, ...segments) {
    return resolve(tree(root), corePackage, ...segments);
}

function script(root, name) {
    return core(root, "scripts", name);
}

/**
 * How to run one gate against a substituted input. The corpus artifact owns which file to
 * mutate and how; this table owns the scratch tree each checker needs in order to read
 * one, because a gate's input is one file inside a tree of artifacts, sources and evidence.
 * `sources` is the checker's own source set: a corpus entry may only pin a diagnostic
 * those files state, so rewording a message cannot leave the corpus describing prose
 * nothing emits.
 */
const harnesses = {
    coherence: {
        sources: ["scripts/quality/coherence.mjs", "scripts/quality/spec.mjs"],
        async scaffold(root, input) {
            // The gate reads test titles from its root's test tree and reports the issues
            // absent from its baseline. An empty tree of each keeps the verdict about the
            // mutation and nothing else.
            await mkdir(resolve(root, "spec/test"), { recursive: true });
            await writeFile(resolve(root, "spec/SPEC.md"), input.content, "utf8");
            await writeCanonicalJson(resolve(root, "spec/coherence-baseline.json"), {
                edition: "1.0.0",
                issues: []
            });
        },
        argv(root) {
            return [
                script(root, "quality/coherence.mjs"),
                "--stage",
                "building",
                "--root",
                resolve(root, "spec"),
                "--spec",
                resolve(root, "spec/SPEC.md"),
                "--baseline",
                resolve(root, "spec/coherence-baseline.json")
            ];
        }
    },
    mutation: {
        sources: [
            "scripts/quality/mutation.mjs",
            "scripts/quality/mutation-equivalence.mjs",
            "scripts/quality/mutation-instrumenter.mjs"
        ],
        async scaffold(root, input) {
            await mkdir(resolve(root, "mutation"), { recursive: true });
            await writeFile(resolve(root, "mutation/equivalence.json"), input.content, "utf8");
            // The gate's other two inputs are neutralized rather than copied. An empty
            // baseline records no measured area, and at the building stage an unmeasured
            // area is a note; so the only thing left that can turn this run red is the
            // register, which is what the corpus mutates. Copying the real baseline would
            // let a stale fingerprint — the tree's normal state while tests are being
            // written — stand in for a defect the checker never caught.
            await writeCanonicalJson(resolve(root, "mutation/baseline.json"), {
                edition: "1.0.0",
                areas: {}
            });
            await writeCanonicalJson(resolve(root, "mutation/stage.json"), {
                edition: "1.0.0",
                stage: "building"
            });
        },
        argv(root) {
            return [
                script(root, "quality/mutation.mjs"),
                "--gate",
                "--register",
                resolve(root, "mutation/equivalence.json"),
                "--baseline",
                resolve(root, "mutation/baseline.json"),
                "--stage-artifact",
                resolve(root, "mutation/stage.json")
            ];
        }
    },
    architecture: {
        sources: ["scripts/quality/architecture.mjs"],
        scaffold: substitute,
        // The building stage is what the corpus measures against: it fails on a finding
        // the baseline and the owed list do not already carry, which is exactly "this
        // mutation introduced a defect the checker saw". The final stage would refuse the
        // tree's standing debt before any mutation was applied.
        argv: (root) => [script(root, "quality/architecture.mjs"), "--stage", "building"]
    },
    "tslean-consumer": {
        sources: ["scripts/quality/tslean-consumer.mjs"],
        scaffold: substitute,
        argv: (root) => [script(root, "quality/tslean-consumer.mjs"), "--stage", "building"]
    },
    "proof-repair-ledger": {
        // The gate decodes the committed ledger through the protocol's own record module,
        // so the codec's refusals are the checker's refusals and a corpus entry may pin
        // either one: both files are the checker here.
        sources: [
            "scripts/quality/proof-repair-ledger.mjs",
            "scripts/quality/proof-repair-record.ts"
        ],
        // The committed ledger is the protocol's own state and advances the moment a
        // repair is accepted, so a corpus mutation keyed to today's bytes would stop
        // locating its input the moment this gate did its job. Every measurement —
        // control and mutation alike — therefore runs against one fixed synthetic
        // question: `seed` hands runGate the stable accepted ledger the corpus's
        // find/replace splits, and the scaffold plants that same ledger's artifact text
        // in the scratch formal tree, so the control is green by construction and only
        // the mutated defect can turn it red.
        seed: () => syntheticProofRepairLedger(),
        async scaffold(root, input) {
            await writeFile(
                core(root, "formal/SpecCnl/Proofs.lean"),
                PROOF_REPAIR_DRIFT_PROBE_TEXT,
                "utf8"
            );
            await substitute(root, input);
        },
        argv: (root) => [script(root, "quality/proof-repair-ledger.mjs"), "--stage", "building"]
    },
    coverage: {
        sources: ["scripts/quality/coverage.mjs", "scripts/quality/coverage-policy.mjs"],
        async scaffold(root, input) {
            await substitute(root, input);
            await neutralizeTestEvidence(root);
            await neutralizeCoverageCounters(root);
        },
        argv: (root) => [script(root, "quality/coverage.mjs"), "--stage", "final"]
    },
    dag: probe(["scripts/quality/dag.mjs"], (root) => [
        `import { validateGraph } from ${specifier(script(root, "quality/dag.mjs"))};`,
        `import { readCanonicalJson } from ${specifier(script(root, "quality/project.mjs"))};`,
        `const graph = await readCanonicalJson(${literal(core(root, "artifacts/quality/check-dag.json"))});`,
        "validateGraph(graph);",
        "console.log(`quality graph validated: ${Object.keys(graph.nodes).length} node(s)`);"
    ]),
    doctrine: {
        sources: ["scripts/quality/doctrine.mjs"],
        scaffold: substitute,
        argv: (root) => [script(root, "quality/doctrine.mjs")]
    },
    heuristics: {
        sources: ["scripts/quality/heuristics.mjs"],
        scaffold: substitute,
        // The building stage is the whole check: this gate carries no stage-dependent
        // leniency, because a heuristic the register does not answer is a defect at every
        // stage rather than debt the building stage tolerates.
        argv: (root) => [script(root, "quality/heuristics.mjs"), "--stage", "building"]
    },
    imports: {
        sources: ["scripts/check-import-boundaries.mjs"],
        scaffold: substitute,
        argv: (root) => [script(root, "check-import-boundaries.mjs")]
    },
    integration: {
        sources: [
            "scripts/quality/integration.mjs",
            "scripts/quality/outcome-baseline.mjs",
            "scripts/quality/completion.mjs"
        ],
        async scaffold(root, input) {
            await substitute(root, input);
            await neutralizeTestEvidence(root);
            await neutralizeNodeEvidence(root);
            await neutralizeOutcomeBaseline(root);
        },
        // The building stage, because the final one refuses the tree's own standing
        // integration debt — an external resolution still awaiting remote evidence — before
        // it reaches the outcome ledger this gate mutates. The ledger check itself is
        // unconditional, so nothing the mutation is about is skipped.
        argv: (root) => [script(root, "quality/integration.mjs"), "--stage", "building"]
    },
    "live-evidence": {
        sources: ["scripts/quality/live-substrate-evidence.mjs"],
        scaffold: substitute,
        argv: (root) => [script(root, "quality/live-evidence.mjs")]
    },
    records: {
        sources: [
            "scripts/quality/records.mjs",
            "scripts/quality/record-ownership.mjs",
            "scripts/quality/evidence.mjs"
        ],
        async scaffold(root, input) {
            await substitute(root, input);
            await neutralizeTestEvidence(root);
        },
        argv: (root) => [script(root, "quality/records.mjs"), "--stage", "final"]
    },
    scope: probe(["scripts/quality/ownership.mjs"], (root) => [
        `import { validateCompleteOwnership } from ${specifier(script(root, "quality/ownership.mjs"))};`,
        "console.log(`exclusive ownership: ${await validateCompleteOwnership()} path(s)`);"
    ]),
    "service-contracts": {
        sources: ["scripts/check-service-contracts.mjs"],
        scaffold: substitute,
        argv: (root) => [script(root, "check-service-contracts.mjs")]
    },
    "substrate-contracts": {
        sources: ["scripts/check-substrate-contracts.mjs"],
        scaffold: substitute,
        argv: (root) => [script(root, "check-substrate-contracts.mjs")]
    },
    seams: {
        sources: [
            "scripts/quality/seams.mjs",
            "scripts/quality/seam-discovery.mjs",
            "scripts/quality/evidence.mjs"
        ],
        async scaffold(root, input) {
            await substitute(root, input);
            await neutralizeTestEvidence(root);
        },
        argv: (root) => [script(root, "quality/seams.mjs"), "--stage", "final"]
    }
};

const options = parseArguments(process.argv.slice(2));
const graph = await readCanonicalJson(resolve(artifactRoot, "quality/check-dag.json"));
const rules = await readCanonicalJson(options.rules);
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

// Selector citations read from the repository's own registries rather than from a scratch
// copy: a mutation that rewrites a citation has to be measured, never satisfied.
const citations = await citedTestSelectors();
// The tree's own identity, which a cited evidence node's report has to carry. The clone
// shares this repository's git directory, so a checker reading HEAD inside it reads this.
const headCommit = gitIdentity(["rev-parse", "HEAD"]);
const headTree = gitIdentity(["show", "-s", "--format=%T", "HEAD"]);
const inputs = new Map();
for (const gate of corpus.gates) {
    const path = resolve(packageRoot, gate.input);
    if (!inputs.has(path)) inputs.set(path, await readFile(path, "utf8"));
}

// One control per distinct input, not per gate: the control is a property of the harness
// and the file it reads, and nine gates over one source file would otherwise pay for the
// same unmutated run nine times. Controls and mutations are independent runs in
// independent trees, so they are measured together and judged in order afterwards.
const controlled = [
    ...new Map(corpus.gates.map((gate) => [`${gate.node}\u0000${gate.input}`, gate])).values()
];
const runs = await inParallel([
    ...controlled.map((gate) => async () => {
        const run = await runGate(harnesses[gate.node], gate);
        return {
            control: {
                node: gate.node,
                input: gate.input,
                red: run.status !== 0,
                detail: diagnosis(run.output)
            }
        };
    }),
    ...corpus.gates.flatMap((gate) =>
        gate.mutations.map((mutation) => async () => {
            const run = await runGate(harnesses[gate.node], gate, mutation);
            return {
                measured: {
                    gate: gate.rule,
                    node: gate.node,
                    mutation: mutation.id,
                    expects: mutation.expects,
                    red: run.status !== 0,
                    diagnosed: run.output.includes(mutation.expects),
                    detail: diagnosis(run.output)
                }
            };
        })
    )
]);
const controls = runs.filter((run) => run.control !== undefined).map((run) => run.control);
const measurements = runs.filter((run) => run.measured !== undefined).map((run) => run.measured);

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
        alwaysRed.map((control) => `${control.node} on ${control.input}: ${control.detail}`)
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

/**
 * One measurement: a fresh clone, the gate's own file substituted, the real checker
 * spawned inside it. Passing no mutation runs the control.
 */
async function runGate(harness, gate, mutation) {
    // A harness may seed the measurement from a stable synthetic input rather than the
    // committed bytes, because the corpus's find/replace has to keep locating its input
    // while the real file advances. The seed is the base the mutation splits, and the
    // scaffold — which may need to prepare more than one file — receives the result.
    const source =
        harness.seed === undefined
            ? inputs.get(resolve(packageRoot, gate.input))
            : await harness.seed();
    let content = source;
    if (mutation !== undefined) {
        const parts = source.split(mutation.find);
        if (parts.length !== 2) {
            throw new TypeError(
                `Gate mutation ${mutation.id} locates ${parts.length - 1} occurrences in ${gate.input}`
            );
        }
        content = parts.join(mutation.replace);
    }
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-gate-integrity-"));
    try {
        await cloneRepository(root);
        await harness.scaffold(root, { path: gate.input, content });
        return await spawnChecker(harness.argv(root), core(root));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

async function cloneRepository(root) {
    await cp(repositoryRoot, tree(root), {
        recursive: true,
        filter: (source) => !uncopied.has(basename(source))
    });
    for (const path of shared) {
        await symlink(resolve(repositoryRoot, path), resolve(tree(root), path));
    }
}

function spawnChecker(argv, cwd) {
    return new Promise((settle, reject) => {
        const child = spawn(process.execPath, argv, {
            cwd,
            timeout: subprocessTimeout,
            killSignal: "SIGKILL"
        });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            output += chunk;
        });
        child.stderr.on("data", (chunk) => {
            output += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => settle({ status, output }));
    });
}

/**
 * Bounded-concurrency map preserving order. Every run owns its own scratch tree, so the
 * only reason to bound it is the machine this runs on.
 */
async function inParallel(tasks) {
    const results = Array.from({ length: tasks.length });
    let next = 0;
    const workers = Math.min(tasks.length, MEASUREMENT_CONCURRENCY, availableParallelism());
    await Promise.all(
        Array.from({ length: workers }, async () => {
            for (let index = next++; index < tasks.length; index = next++) {
                results[index] = await tasks[index]();
            }
        })
    );
    return results;
}

/**
 * The stable accepted ledger every proof-repair gate measurement runs against.
 *
 * The committed ledger is the protocol's own state and advances the moment a repair is
 * accepted, so a corpus mutation whose `find` is today's committed bytes would stop
 * locating its input the moment this gate did its job. The synthetic record is therefore
 * the measurement's fixed question: one accepted closure over the one corpus artifact
 * the protocol lets a candidate write, carrying the constant probe text the scaffold
 * also plants in the scratch formal tree — so the control is genuinely green (the gate's
 * byte-identity comparison succeeds against the planted file) and only a byte drift or a
 * doctored version can turn it red.
 *
 * The record is rendered by hand rather than through the protocol's own store: the
 * corpus's mutations key into these exact bytes, and the store would re-derive the
 * digest field from any text change — which is precisely what a mutation must not
 * depend on.
 */
function syntheticProofRepairLedger() {
    const text = PROOF_REPAIR_DRIFT_PROBE_TEXT;
    const candidate = "c".repeat(64);
    return [
        "{",
        '  "artifacts": [',
        "    {",
        `      "digest": "${sha256Text(text)}",`,
        '      "path": "SpecCnl/Proofs.lean",',
        `      "text": ${JSON.stringify(text)}`,
        "    }",
        "  ],",
        `  "candidate": "${candidate}",`,
        '  "closed": [',
        "    {",
        '      "artifacts": ["SpecCnl/Proofs.lean"],',
        `      "candidate": "${candidate}",`,
        '      "obligation": {',
        `        "anchor": "SPEC.md:1601",`,
        '        "atoms": ["C13-RUN-ANCESTRY"],',
        `        "unit": "${"a".repeat(64)}"`,
        "      }",
        "    }",
        "  ],",
        '  "kind": "proof.repair.ledger",',
        '  "version": "1.0"',
        "}",
        ""
    ].join("\n");
}

function sha256Text(value) {
    return createHash("sha256").update(value).digest("hex");
}

/** The mutated file, at the path it occupies in the package the checkers read. */
async function substitute(root, input) {
    await writeFile(core(root, input.path), input.content, "utf8");
}

/**
 * A checker the quality runner calls as a function rather than spawning. The probe imports
 * the scratch tree's own copy of that module and calls it, so a red run is the real
 * checker's own throw and the substituted file is the only thing it read differently.
 */
function probe(sources, body) {
    return {
        sources,
        async scaffold(root, input) {
            await substitute(root, input);
            await writeFile(resolve(root, "probe.mjs"), `${body(root).join("\n")}\n`, "utf8");
        },
        argv: (root) => [resolve(root, "probe.mjs")]
    };
}

function specifier(path) {
    return JSON.stringify(pathToFileURL(path).href);
}

function literal(path) {
    return JSON.stringify(path);
}

/**
 * Every test selector the record, seam and integration registries cite. What those gates
 * measure is whether a registry check discriminates its own input, not whether a suite
 * ran, and no suite is runnable from inside a gate; so each of them gets a report stating
 * that exactly these selectors passed, exactly as the mutation harness neutralizes its
 * area baseline. The set is read from the repository, so a mutation that rewrites a
 * citation is measured against it rather than satisfied by it.
 */
async function citedTestSelectors() {
    const files = (
        await Promise.all(
            ["records", "seams", "integration"].map((name) =>
                collectFiles(resolve(artifactRoot, name), (path) => path.endsWith(".json"))
            )
        )
    ).flat();
    const selectors = new Set();
    for (const path of files) collectSelectors(await readCanonicalJson(path), selectors);
    return [...selectors].sort();
}

function collectSelectors(value, selectors) {
    const kind = jsonKind(value);
    if (kind === "string") {
        if (/^(?:cloudflare\/)?test\/[^#]+\.test\.ts#./u.test(value)) selectors.add(value);
    } else if (kind === "array") {
        for (const item of value) collectSelectors(item, selectors);
    } else if (kind === "object") {
        for (const item of Object.values(value)) collectSelectors(item, selectors);
    }
}

async function neutralizeTestEvidence(root) {
    const lanes = new Map();
    for (const selector of citations) {
        const separator = selector.indexOf("#");
        const file = selector.slice(0, separator);
        const name = file.startsWith("cloudflare/")
            ? `/packages/agent-core-cloudflare/${file.slice("cloudflare/".length)}`
            : `/${corePackage}/${file}`;
        const assertions = lanes.get(name) ?? [];
        assertions.push({ fullName: selector.slice(separator + 1), status: "passed" });
        lanes.set(name, assertions);
    }
    await writeTestReport(
        core(root, "reports/quality/tests/vitest.json"),
        citations.length,
        [...lanes].map(([name, assertionResults]) => ({ name, assertionResults }))
    );
    // The remaining lanes exist so the integration gate's explicit report set resolves;
    // every selector any registry cites is already stated in the report above.
    for (const path of [
        core(root, "reports/quality/tests/quality.json"),
        core(root, "reports/quality/tests/governance.json"),
        adjunctReport(root, "agent-core-cloudflare", "structural"),
        adjunctReport(root, "agent-core-cloudflare", "workers")
    ]) {
        await writeTestReport(path, 0, []);
    }
}

/**
 * The evidence-node reports a completed transition may cite. What the integration gate's
 * mutation measures is the outcome ledger, not whether an evidence lane ran, so the node
 * set the graph fixes is stated as passing at the tree's own commit.
 */
async function neutralizeNodeEvidence(root) {
    for (const node of graph.evidenceNodes) {
        await writeCanonicalJson(core(root, "reports/quality/nodes", `${node}.json`), {
            edition: "1.0.0",
            stage: "building",
            commit: headCommit,
            tree: headTree,
            status: "passed"
        });
    }
}

/**
 * An outcome baseline pinned to this repository's own resolution ledger. What the
 * integration gate's mutation measures is whether the checker still notices a ratified
 * record that no longer matches its pin, and it is measured against a pin taken before the
 * mutation. Copying the committed baseline instead would make the control carry whatever
 * drift the ledger currently owes — a finding the integration node itself reports, and one
 * no mutation of the ledger is responsible for.
 */
async function neutralizeOutcomeBaseline(root) {
    const ledger = await readCanonicalJson(resolve(artifactRoot, "integration/resolutions.json"));
    const committed = await readCanonicalJson(
        resolve(artifactRoot, "quality/outcome-baseline.json")
    );
    const { baseline } = updateOutcomeBaseline(
        ledger,
        committed,
        "Scratch pin taken by the gate integrity harness from the ledger it measures against."
    );
    await writeCanonicalJson(core(root, "artifacts/quality/outcome-baseline.json"), baseline);
}

function adjunctReport(root, workspace, lane) {
    return resolve(tree(root), "packages", workspace, "reports/quality/tests", `${lane}.json`);
}

async function writeTestReport(path, total, testResults) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
        path,
        `${JSON.stringify(
            {
                success: true,
                numTotalTests: total,
                numPassedTests: total,
                numFailedTests: 0,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults
            },
            null,
            2
        )}\n`,
        "utf8"
    );
}

/**
 * Coverage counters stating that every source in the scratch tree is covered at least as
 * well as the seed recorded. The measured numbers come from a test run no gate can
 * perform, and they are not what the coverage gate's mutation is about: what it measures
 * is whether the checker still discriminates its policy artifact. Counters that regress
 * nowhere cannot make a run red, so a red run is the mutation's. The policy read here is
 * the repository's and never the substituted copy, so a mutation cannot shrink the
 * evidence it has to survive.
 */
async function neutralizeCoverageCounters(root) {
    const policy = await readCanonicalJson(resolve(artifactRoot, "quality/policy.json"));
    const seed = await readCanonicalJson(resolve(artifactRoot, "quality/coverage-seed.json"));
    for (const universe of policy.coverage.sourceUniverses) {
        const sources = await collectFiles(
            resolve(tree(root), universe.root),
            (path) =>
                universe.extensions.some((extension) => path.endsWith(extension)) &&
                !/\.d\.[cm]?ts$/u.test(path)
        );
        const final = {};
        const summary = {};
        for (const path of sources) {
            const relative = path.slice(tree(root).length + 1).replaceAll("\\", "/");
            final[path] = fullyCovered(seed.files[relative]?.metrics);
            summary[path] = countersOf(final[path]);
        }
        for (const directory of universe.reports) {
            const target = resolve(tree(root), directory);
            await mkdir(target, { recursive: true });
            await writeFile(
                resolve(target, "coverage-final.json"),
                `${JSON.stringify(final, null, 2)}\n`,
                "utf8"
            );
            await writeFile(
                resolve(target, "coverage-summary.json"),
                `${JSON.stringify(summary, null, 2)}\n`,
                "utf8"
            );
        }
    }
}

/**
 * Raw coverage for one file with every counter hit. Statements each occupy their own line,
 * because the line counters are derived from the statement map; the widths come from the
 * seed so that no file reports fewer covered counters than it did when the seed was taken.
 */
function fullyCovered(seeded) {
    const width = (metric) => Math.max(1, seeded?.[metric]?.covered ?? 1);
    const statements = Math.max(width("statements"), width("lines"));
    const counters = (size) =>
        Object.fromEntries(Array.from({ length: size }, (_unused, index) => [index, 1]));
    return {
        statementMap: Object.fromEntries(
            Array.from({ length: statements }, (_unused, index) => [
                index,
                { start: { line: index + 1, column: 0 }, end: { line: index + 1, column: 1 } }
            ])
        ),
        s: counters(statements),
        fnMap: Object.fromEntries(
            Array.from({ length: width("functions") }, (_unused, index) => [
                index,
                { decl: coveredSpan, loc: coveredSpan }
            ])
        ),
        f: counters(width("functions")),
        branchMap: { 0: { loc: coveredSpan, locations: [coveredSpan] } },
        b: { 0: Array.from({ length: width("branches") }, () => 1) }
    };
}

function countersOf(raw) {
    const counted = (values) => ({ covered: values.length, total: values.length });
    return {
        statements: counted(Object.values(raw.s)),
        branches: counted(Object.values(raw.b).flat()),
        functions: counted(Object.values(raw.f)),
        lines: counted(Object.values(raw.statementMap))
    };
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
    // A rule may guard more than one input — ACQ-GENERATED holds four generated packages,
    // one per catalog entry — so a gate is identified by the pair, not by the rule alone.
    // Keying by rule alone did not merely collide: it made the whole corpus unvalidatable,
    // and a control keyed by rule would have proven one input and left the rest unguarded.
    // Every input still gets its own control and its own mutation below, and a genuine
    // duplicate — the same rule against the same input twice — is still refused here.
    assertUniqueIds(
        value.gates,
        (gate) => `${gate.rule}\u0000${gate.input}`,
        "quality/gate-corpus.json gates"
    );
    const nodes = new Map(ruleRegistry.rules.map((rule) => [rule.id, rule.node]));
    const seen = new Set();
    const mutationIds = new Set();
    for (const gate of value.gates) {
        assertExactKeys(gate, gateFields, "quality/gate-corpus.json gate");
        assertString(gate.rule, "quality/gate-corpus.json gate rule");
        assertString(gate.node, "quality/gate-corpus.json gate node");
        assertString(gate.input, "quality/gate-corpus.json gate input");
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
        for (const mutation of gate.mutations) {
            validateMutation(mutation, gate, sources.get(gate.node), seen, mutationIds);
        }
    }
    // A harness for a node no rule is bound to can never be exercised by any corpus, so it
    // is dead scaffolding claiming to measure something. Whether each rule actually carries
    // a mutation is the debt ratchet's question, not this one.
    const unbound = Object.keys(harnesses).filter(
        (node) => !ruleRegistry.rules.some((rule) => rule.node === node)
    );
    if (unbound.length > 0) {
        throw new TypeError(`Mutation harness binds no quality rule: ${unbound.join(", ")}`);
    }
}

function validateMutation(mutation, gate, sources, seen, mutationIds) {
    assertExactKeys(mutation, mutationFields, `quality/gate-corpus.json ${gate.rule} mutation`);
    for (const field of mutationFields) {
        assertString(mutation[field], `quality/gate-corpus.json mutation ${field}`);
    }
    if (!mutation.id.startsWith(`${gate.rule}/`)) {
        throw new TypeError(`Gate mutation ${mutation.id} is not named for rule ${gate.rule}`);
    }
    if (mutationIds.has(mutation.id)) {
        throw new TypeError(`Gate mutation ${mutation.id} is named twice`);
    }
    mutationIds.add(mutation.id);
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
    let rulesPath = resolve(artifactRoot, "quality/rules.json");
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--corpus") corpusPath = resolve(required(args, ++index, argument));
        else if (argument === "--rules") rulesPath = resolve(required(args, ++index, argument));
        else throw new TypeError(`Unknown gate integrity argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return { stage, corpus: corpusPath, rules: rulesPath };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}

function gitIdentity(args) {
    const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
    if (result.status !== 0) throw new TypeError(`Git identity is unavailable: ${args.join(" ")}`);
    return result.stdout.trim();
}

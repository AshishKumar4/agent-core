import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
    artifactRoot,
    packageRoot,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    writeCanonicalJson
} from "./project.mjs";
import { run } from "./process.mjs";
import {
    deriveOwner,
    validateCompleteOwnership,
    validateOwnershipDiff,
    validateStageTransition
} from "./ownership.mjs";
import { dependencyClosure, hermeticEdges, topologicalOrder, validateGraph } from "./dag.mjs";
import { validateNonrecursiveQualityScripts } from "./recursion.mjs";
import { cloudflareRoot, cloudflareTestLanes, hasCloudflareSource } from "./workspaces.mjs";
import { requireSuccessfulTestReport } from "./evidence.mjs";
import { discoverPriorityTestFiles, validatePriorityLanes } from "./test-priorities.mjs";

const options = parseArguments(process.argv.slice(2));
const runCommit = gitIdentity(["rev-parse", "HEAD"]);
const runTree = gitIdentity(["show", "-s", "--format=%T", "HEAD"]);
if (options.stage === "final" && options.target !== undefined) {
    throw new TypeError("Final quality cannot run a partial target");
}
if (options.transition !== undefined && options.owner === undefined) {
    throw new TypeError("--transition requires --owner");
}
if (options.stage === "building" && options.owner === undefined) {
    const closure = await completedIntegrationClosure();
    if (closure === undefined) {
        options.owner = await deriveOwner(options.base);
    } else {
        options.owner = "W0";
        options.base = closure;
        options.transition = "TRANSITION-W9-INTEGRATION-CANDIDATE";
    }
}
const graph = await readCanonicalJson(resolve(artifactRoot, "quality/check-dag.json"));
validateGraph(graph);
await validateNonrecursiveQualityScripts();
// The hermetic stage runs the product-correctness closure over the intersected edge set,
// bypassing the multi-agent change-review governance (owner/base/transition, attestation).
const edges = options.stage === "hermetic" ? hermeticEdges(graph) : graph.nodes;
const targets =
    options.stage === "hermetic"
        ? Object.keys(edges)
        : options.target === undefined
          ? graph.stages[options.stage]
          : [options.target];
if (!Array.isArray(targets) || targets.length === 0)
    throw new TypeError("Quality target set is empty");
const selected = dependencyClosure(targets, edges);
const order = topologicalOrder(selected, edges);
const status = new Map();
const results = [];
// Node reports record the strictness the checks ran at; hermetic runs execute every
// product node with final semantics, so downstream evidence readers see "final".
const effectiveStage = options.stage === "hermetic" ? "final" : options.stage;
await rm(reportRoot, { recursive: true, force: true });
await rm(resolve(cloudflareRoot, "reports/quality"), { recursive: true, force: true });
await mkdir(resolve(reportRoot, "tests"), { recursive: true });

for (const node of order) {
    const failedDependencies = edges[node].filter(
        (dependency) => status.get(dependency) !== "passed"
    );
    if (failedDependencies.length > 0) {
        status.set(node, "skipped");
        results.push({
            node,
            status: "skipped",
            detail: `failed dependencies: ${failedDependencies.join(", ")}`
        });
        continue;
    }
    try {
        if (node === "attestation" || node === "building-attestation") {
            await rm(resolve(reportRoot, "nodes", `${node}.json`), { force: true });
            await writeCanonicalJson(resolve(reportRoot, "checks-input.json"), {
                edition: "1.0.0",
                stage: options.stage,
                owner: options.owner ?? null,
                base: options.base,
                transition: options.transition ?? null,
                results
            });
        }
        await execute(node, options);
        status.set(node, "passed");
        results.push({ node, status: "passed", detail: "" });
        await writeCanonicalJson(resolve(reportRoot, "nodes", `${node}.json`), {
            edition: "1.0.0",
            stage: effectiveStage,
            commit: runCommit,
            tree: runTree,
            status: "passed"
        });
    } catch (error) {
        status.set(node, "failed");
        results.push({
            node,
            status: "failed",
            detail: error instanceof Error ? error.message : String(error)
        });
        await writeCanonicalJson(resolve(reportRoot, "nodes", `${node}.json`), {
            edition: "1.0.0",
            stage: effectiveStage,
            commit: runCommit,
            tree: runTree,
            status: "failed"
        });
    }
}

await writeCanonicalJson(resolve(reportRoot, "checks.json"), {
    edition: "1.0.0",
    stage: options.stage,
    owner: options.owner ?? null,
    base: options.base,
    transition: options.transition ?? null,
    targets,
    results
});
const failures = results.filter((result) => result.status === "failed");
for (const result of results)
    console.log(
        `${result.status.padEnd(7)} ${result.node}${result.detail ? `: ${result.detail}` : ""}`
    );
if (failures.length > 0) process.exitCode = 1;

async function execute(node, context) {
    const nodeScript = (name) => [
        process.execPath,
        [resolve(packageRoot, `scripts/quality/${name}.mjs`)]
    ];
    const commands = {
        "core-declarations": () =>
            run(process.execPath, [resolve(packageRoot, "scripts/build.mjs")], {
                cwd: packageRoot
            }),
        format: () => {
            const [command, args] = nodeScript("format");
            args.push("--base", context.base, "--stage", context.stage);
            if (context.owner !== undefined && context.transition === undefined)
                args.push("--owner", context.owner);
            run(command, args, { cwd: packageRoot });
        },
        lint: async () => {
            const paths = [
                "packages/agent-core/src",
                "packages/agent-core/test",
                "packages/agent-core/scripts"
            ];
            if (await hasCloudflareSource())
                paths.push(
                    "packages/agent-core-cloudflare/src",
                    "packages/agent-core-cloudflare/test",
                    "packages/agent-core-cloudflare/scripts"
                );
            run(
                resolve(repositoryRoot, "node_modules/oxlint/bin/oxlint"),
                ["--deny-warnings", ...paths],
                { cwd: repositoryRoot }
            );
        },
        types: async () => {
            run(
                process.execPath,
                [resolve(packageRoot, "node_modules/typescript/bin/tsc"), "--noEmit"],
                { cwd: packageRoot }
            );
            if (await hasCloudflareSource()) {
                run(
                    process.execPath,
                    [
                        resolve(cloudflareRoot, "node_modules/typescript/bin/tsc"),
                        "-p",
                        "tsconfig.json",
                        "--noEmit"
                    ],
                    { cwd: cloudflareRoot }
                );
                run(
                    process.execPath,
                    [
                        resolve(cloudflareRoot, "node_modules/typescript/bin/tsc"),
                        "-p",
                        "test/tsconfig.json",
                        "--noEmit"
                    ],
                    { cwd: cloudflareRoot }
                );
                run(
                    process.execPath,
                    [
                        resolve(cloudflareRoot, "node_modules/typescript/bin/tsc"),
                        "-p",
                        "test/cloudflare/tsconfig.json",
                        "--noEmit"
                    ],
                    { cwd: cloudflareRoot }
                );
                run(
                    process.execPath,
                    [
                        resolve(cloudflareRoot, "node_modules/wrangler/bin/wrangler.js"),
                        "types",
                        "test/cloudflare/worker-configuration.d.ts",
                        "--config",
                        "wrangler.test.jsonc",
                        "--check"
                    ],
                    { cwd: cloudflareRoot }
                );
            }
        },
        dag: () => undefined,
        governance: () => runNode("governance", context),
        "governance-tests": () => runQualityTests("governance", "vitest.governance.config.mjs"),
        "quality-tests": () => runQualityTests("quality", "vitest.quality.config.mjs"),
        "priority-tests": () => runPriorityTests(),
        scope: async () => {
            if (context.stage === "final") {
                await validateCompleteOwnership();
                await validateStageTransition(context.base);
            }
            if (context.owner !== undefined)
                await validateOwnershipDiff(context.owner, context.base, context.transition);
        },
        imports: () =>
            run(process.execPath, [resolve(packageRoot, "scripts/check-import-boundaries.mjs")], {
                cwd: packageRoot
            }),
        records: () => runNode("records", context),
        "live-evidence": () => runNode("live-evidence", context),
        requests: () => runNode("requests", context),
        seams: () => runNode("seams", context),
        migrations: () => runNode("migrations", context),
        architecture: () => runNode("architecture", context),
        ledger: () =>
            runNode("ledger", context, false, [
                ...(options.stage === "hermetic" ? ["--hermetic"] : []),
                "--priority-report",
                resolve(reportRoot, "test-priorities.json")
            ]),
        tests: async () => {
            const coreReport = resolve(reportRoot, "tests/vitest.json");
            run(
                process.execPath,
                [
                    resolve(packageRoot, "node_modules/vitest/vitest.mjs"),
                    "run",
                    "--coverage",
                    "--reporter=json",
                    `--outputFile=${coreReport}`
                ],
                { cwd: packageRoot }
            );
            await requireSuccessfulTestReport(coreReport);
            if (await hasCloudflareSource()) {
                await mkdir(resolve(cloudflareRoot, "reports/quality/tests"), { recursive: true });
                for (const lane of await cloudflareTestLanes()) {
                    const cloudflareReport = resolve(
                        cloudflareRoot,
                        "reports/quality/tests",
                        `${lane.id}.json`
                    );
                    run(
                        process.execPath,
                        [
                            resolve(cloudflareRoot, "node_modules/vitest/vitest.mjs"),
                            "run",
                            "--config",
                            lane.config,
                            ...(lane.coverage
                                ? [
                                      "--coverage",
                                      "--coverage.provider=v8",
                                      "--coverage.include=src/**/*.ts",
                                      "--coverage.reporter=text",
                                      "--coverage.reporter=json",
                                      "--coverage.reporter=json-summary",
                                      `--coverage.reportsDirectory=reports/quality/coverage/${lane.id}`
                                  ]
                                : []),
                            "--reporter=json",
                            `--outputFile=${cloudflareReport}`
                        ],
                        { cwd: cloudflareRoot }
                    );
                    await requireSuccessfulTestReport(cloudflareReport);
                }
            }
        },
        "test-priorities": () => runNode("test-priorities", context),
        coverage: () => runNode("coverage", context),
        mutation: () =>
            run(
                process.execPath,
                [resolve(packageRoot, "scripts/quality/mutation.mjs"), "--gate"],
                {
                    cwd: packageRoot
                }
            ),
        agents: () => runNode("agents", context),
        invariants: () =>
            runNode(
                "invariants",
                context,
                false,
                options.stage === "hermetic" ? ["--hermetic"] : []
            ),
        build: async () => {
            if (await hasCloudflareSource()) {
                run(process.execPath, [resolve(cloudflareRoot, "scripts/build.mjs")], {
                    cwd: cloudflareRoot
                });
            }
        },
        exports: async () => {
            run(process.execPath, [resolve(packageRoot, "scripts/check-exports.mjs")], {
                cwd: packageRoot
            });
            if (await hasCloudflareSource()) {
                run(process.execPath, [resolve(cloudflareRoot, "scripts/check-consumer.mjs")], {
                    cwd: cloudflareRoot
                });
            }
        },
        traceability: () =>
            run(process.execPath, [resolve(packageRoot, "scripts/check-traceability.mjs")], {
                cwd: packageRoot
            }),
        integration: () => runNode("integration", context),
        conformance: () => undefined,
        "building-attestation": () => runNode("attest", context, true),
        attestation: () => runNode("attest", context, true)
    };
    const command = commands[node];
    if (command === undefined) throw new TypeError(`Quality node ${node} has no command`);
    await command();
}

async function runQualityTests(name, config) {
    const report = resolve(reportRoot, "tests", `${name}.json`);
    run(
        process.execPath,
        [
            resolve(packageRoot, "node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            config,
            "--reporter=json",
            `--outputFile=${report}`
        ],
        { cwd: packageRoot }
    );
    await requireSuccessfulTestReport(report);
}

async function runPriorityTests() {
    const files = await discoverPriorityTestFiles();
    const reports = {};
    for (const priority of ["p0", "p1", "p2"]) {
        const report = resolve(reportRoot, "tests", `priority-${priority}.json`);
        run(
            process.execPath,
            [
                resolve(packageRoot, "node_modules/vitest/vitest.mjs"),
                "run",
                ...files[priority],
                "--tagsFilter",
                priority,
                "--reporter=json",
                `--outputFile=${report}`
            ],
            { cwd: packageRoot }
        );
        reports[priority] = await readCanonicalJson(report);
    }
    validatePriorityLanes(reports);
}

function runNode(name, context, orchestrated = false, extraArgs = []) {
    // Node scripts know only building/final. Hermetic runs product checks at their
    // strictest (final) setting without the governance the final orchestration stage adds.
    const scriptStage = context.stage === "hermetic" ? "final" : context.stage;
    const args = [
        resolve(packageRoot, `scripts/quality/${name}.mjs`),
        "--stage",
        scriptStage,
        ...extraArgs
    ];
    if (context.owner !== undefined && name === "coverage")
        args.push("--owner", context.owner, "--base", context.base);
    run(process.execPath, args, {
        cwd: packageRoot,
        env: orchestrated ? { ...process.env, QUALITY_ORCHESTRATED: "1" } : undefined
    });
}

function parseArguments(args) {
    let stage = "building";
    let owner;
    let target;
    let transition;
    let base = process.env.QUALITY_BASE || "f558d0ff3f7e93308481ea09c3bf369abbdd19ba";
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--owner") owner = required(args, ++index, argument);
        else if (argument === "--target") target = required(args, ++index, argument);
        else if (argument === "--base") base = required(args, ++index, argument);
        else if (argument === "--transition") transition = required(args, ++index, argument);
        else throw new TypeError(`Unknown quality argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final" && stage !== "hermetic")
        throw new TypeError(`Unknown quality stage ${stage}`);
    if (stage === "hermetic" && (owner !== undefined || target !== undefined))
        throw new TypeError("The hermetic stage runs the full product closure with no owner");
    return { stage, owner, target, base, transition };
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

async function completedIntegrationClosure() {
    const transition = await readCanonicalJson(
        resolve(artifactRoot, "integration/transitions/w9-integration-candidate.json")
    );
    return transition.state === "completed" ? transition.closureManifest?.commit : undefined;
}

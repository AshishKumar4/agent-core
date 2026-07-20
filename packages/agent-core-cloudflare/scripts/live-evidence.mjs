/**
 * Live Cloudflare evidence lane: deploys the live harness worker to the real
 * account, drives the external-gated P11 substrate scenarios against deployed
 * Durable Objects and R2, redeploys, and replays durability scenarios against
 * the new worker version. Evidence lands in the core conformance artifacts as
 * a run manifest hash-bound to the exact provider sources it exercised.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const evidenceRoot = resolve(
    repositoryRoot,
    "packages/agent-core/artifacts/conformance/live-evidence"
);
const wranglerConfig = resolve(packageRoot, "live/wrangler.live.jsonc");
const bucket = "agent-core-live-evidence";

const fingerprintSources = [
    "packages/agent-core-cloudflare/src/environment-provider.ts",
    "packages/agent-core-cloudflare/src/slate-provider.ts",
    "packages/agent-core-cloudflare/live/worker.ts",
    "packages/agent-core-cloudflare/test/live/live.test.ts"
];

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options
    });
    if (result.status !== 0 && options.allowFailure !== true) {
        throw new TypeError(
            `${command} ${args.join(" ")} failed with status ${result.status}:\n${result.stdout}\n${result.stderr}`
        );
    }
    return result;
}

function wrangler(args, options = {}) {
    return run("corepack", ["pnpm", "exec", "wrangler", ...args], {
        ...options,
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "f44999d1ddda7012e9a87729eba250f1" }
    });
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

const commit = run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }).stdout.trim();
const dirty =
    run("git", ["status", "--porcelain", "--", ...fingerprintSources], {
        cwd: repositoryRoot
    }).stdout.trim().length > 0;

const bucketCreate = wrangler(["r2", "bucket", "create", bucket], { allowFailure: true });
if (bucketCreate.status !== 0 && !/already (exists|owns)/iu.test(bucketCreate.stderr + bucketCreate.stdout)) {
    throw new TypeError(`R2 bucket provisioning failed:\n${bucketCreate.stderr}`);
}

function deploy() {
    const result = wrangler([
        "deploy",
        "--config",
        wranglerConfig,
        "--var",
        `GIT_COMMIT:${commit}`
    ]);
    const output = result.stdout + result.stderr;
    const urlMatch = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/u);
    const versionMatch = output.match(/Current Version ID:\s*([a-f0-9-]+)/u);
    if (urlMatch === null) throw new TypeError(`Deploy output has no workers.dev URL:\n${output}`);
    return {
        url: urlMatch[0],
        versionId: versionMatch?.[1] ?? null,
        at: new Date().toISOString()
    };
}

async function awaitReady(url) {
    // A first-ever workers.dev route can lag deployment; wait until the deployed
    // harness answers with the exact commit this run is evidencing.
    for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
            const response = await fetch(`${url}/meta`);
            if (response.ok && (await response.json()).commit === commit) return;
        } catch {
            // Edge not ready yet.
        }
        await new Promise((settle) => setTimeout(settle, 2000));
    }
    throw new TypeError(`Live harness at ${url} never became ready for ${commit}`);
}

function runPhase(url, phase, stateFile, reportPath) {
    const result = run(
        "corepack",
        ["pnpm", "exec", "vitest", "run", "--config", "test/live/vitest.config.mjs", "--reporter=json", `--outputFile=${reportPath}`],
        {
            env: {
                ...process.env,
                LIVE_HARNESS_URL: url,
                LIVE_PHASE: String(phase),
                LIVE_STATE_FILE: stateFile
            },
            allowFailure: true
        }
    );
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (result.status !== 0 || report.numFailedTests > 0 || report.numTotalTests === 0) {
        throw new TypeError(
            `Live phase ${phase} failed (${report.numFailedTests ?? "?"} failures, ${report.numTotalTests ?? 0} tests):\n${result.stdout}\n${result.stderr}`
        );
    }
    return report;
}

mkdirSync(evidenceRoot, { recursive: true });
const stateFile = join(mkdtempSync(join(tmpdir(), "live-evidence-")), "state.json");

console.log(`deploying live harness at ${commit}${dirty ? " (dirty sources)" : ""}`);
const firstDeployment = deploy();
await awaitReady(firstDeployment.url);
console.log(`phase 1 against ${firstDeployment.url} (version ${firstDeployment.versionId})`);
const phase1 = runPhase(firstDeployment.url, 1, stateFile, resolve(evidenceRoot, "phase-1.vitest.json"));
console.log(`phase 1: ${phase1.numPassedTests} passed; redeploying for phase 2`);
const secondDeployment = deploy();
if (secondDeployment.versionId !== null && secondDeployment.versionId === firstDeployment.versionId) {
    throw new TypeError("Redeployment did not produce a new worker version");
}
await awaitReady(secondDeployment.url);
console.log(`phase 2 against ${secondDeployment.url} (version ${secondDeployment.versionId})`);
const phase2 = runPhase(secondDeployment.url, 2, stateFile, resolve(evidenceRoot, "phase-2.vitest.json"));
console.log(`phase 2: ${phase2.numPassedTests} passed`);

const manifest = {
    edition: "1.0.0",
    commit,
    dirtySources: dirty,
    accountId: "f44999d1ddda7012e9a87729eba250f1",
    worker: "agent-core-live-harness",
    bucket,
    url: secondDeployment.url,
    deployments: [firstDeployment, secondDeployment],
    sourceFingerprints: Object.fromEntries(
        fingerprintSources.map((path) => [path, sha256(readFileSync(resolve(repositoryRoot, path)))])
    ),
    reports: {
        "phase-1.vitest.json": sha256(readFileSync(resolve(evidenceRoot, "phase-1.vitest.json"))),
        "phase-2.vitest.json": sha256(readFileSync(resolve(evidenceRoot, "phase-2.vitest.json")))
    }
};
writeFileSync(resolve(evidenceRoot, "run.json"), `${JSON.stringify(manifest, null, 4)}\n`);
console.log(`live evidence recorded in ${evidenceRoot}`);

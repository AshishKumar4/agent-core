/**
 * Live Cloudflare evidence lane: deploys the live harness worker to the real
 * account, drives the external-gated P11 substrate scenarios against deployed
 * Durable Objects and R2, then walks the deployed release across the rollback
 * window the Cloudflare profile publishes — base, next, back to base, and next
 * again — replaying durability, refusal, and recovery scenarios against each
 * worker version. Evidence lands in the core conformance artifacts as a run
 * manifest hash-bound to the exact provider sources it exercised.
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
const deliveryQueue = "agent-core-live-evidence-deliveries";
const poisonQueue = "agent-core-live-evidence-poison";

const fingerprintSources = [
    "packages/agent-core-cloudflare/src/alarm-claims.ts",
    "packages/agent-core-cloudflare/src/durable-object.ts",
    "packages/agent-core-cloudflare/src/environment-provider.ts",
    "packages/agent-core-cloudflare/src/queue.ts",
    "packages/agent-core-cloudflare/src/reconciliation.ts",
    "packages/agent-core-cloudflare/src/revision-log.ts",
    "packages/agent-core-cloudflare/src/slate-provider.ts",
    "packages/agent-core-cloudflare/src/websocket.ts",
    "packages/agent-core-cloudflare/live/protocol.ts",
    "packages/agent-core-cloudflare/live/runtime-harness.ts",
    "packages/agent-core-cloudflare/live/worker.ts",
    "packages/agent-core-cloudflare/live/wrangler.live.jsonc",
    "packages/agent-core-cloudflare/test/live/harness.ts",
    "packages/agent-core-cloudflare/test/live/phase-1.test.ts",
    "packages/agent-core-cloudflare/test/live/phase-2.test.ts",
    "packages/agent-core-cloudflare/test/live/phase-3.test.ts",
    "packages/agent-core-cloudflare/test/live/phase-4.test.ts"
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

function provision(label, args) {
    const result = wrangler(args, { allowFailure: true });
    const output = result.stdout + result.stderr;
    // R2 says "already exists" or "already owns"; Queues says "is already taken".
    if (result.status !== 0 && !/already (exists|owns|taken)|409/iu.test(output)) {
        throw new TypeError(`${label} provisioning failed:\n${output}`);
    }
}

provision("R2 bucket", ["r2", "bucket", "create", bucket]);
// The consumer registration in the deploy below fails outright unless both queues exist.
provision("Delivery queue", ["queues", "create", deliveryQueue]);
provision("Dead-letter queue", ["queues", "create", poisonQueue]);

/**
 * Deploys one release of the harness. `release` selects the schema the deployed Durable
 * Object declares, which is the only difference between the two releases this lane walks.
 */
function deploy(release) {
    const result = wrangler([
        "deploy",
        "--config",
        wranglerConfig,
        "--var",
        `GIT_COMMIT:${commit}`,
        "--define",
        `LIVE_SCHEMA_RELEASE:"${release}"`
    ]);
    const output = result.stdout + result.stderr;
    const urlMatch = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/u);
    const versionMatch = output.match(/Current Version ID:\s*([a-f0-9-]+)/u);
    if (urlMatch === null) throw new TypeError(`Deploy output has no workers.dev URL:\n${output}`);
    return {
        url: urlMatch[0],
        release,
        versionId: versionMatch?.[1] ?? null,
        at: new Date().toISOString()
    };
}

async function awaitReady(url) {
    // A workers.dev route can lag deployment; wait until the deployed harness answers
    // with the exact commit this run is evidencing. Three minutes because a 60-second
    // window timed out on a version that then served the right commit moments later.
    let observed = "no response";
    for (let attempt = 0; attempt < 90; attempt += 1) {
        try {
            const response = await fetch(`${url}/meta`);
            if (response.ok) {
                observed = (await response.json()).commit;
                if (observed === commit) return;
            }
        } catch {
            // Edge not ready yet.
        }
        await new Promise((settle) => setTimeout(settle, 2000));
    }
    throw new TypeError(
        `Live harness at ${url} never became ready for ${commit}; it last served ${observed}`
    );
}

function runPhase(url, phase, stateFile, reportPath) {
    const result = run(
        "corepack",
        [
            "pnpm",
            "exec",
            "vitest",
            "run",
            "--config",
            "test/live/vitest.config.mjs",
            `test/live/phase-${phase}.test.ts`,
            "--reporter=json",
            `--outputFile=${reportPath}`
        ],
        {
            env: {
                ...process.env,
                LIVE_HARNESS_URL: url,
                LIVE_RUN_ID: runId,
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
const runId = `${commit.slice(0, 12)}-${Date.now().toString(36)}`;

// The releases this lane walks, in order: the base release arms durable work, the next
// release applies its own migration over that work, the rollback to base meets a schema
// it does not declare, and the roll-forward proves the refusal cost nothing.
const releases = ["base", "next", "base", "next"];

console.log(`deploying live harness at ${commit}${dirty ? " (dirty sources)" : ""}`);
const deployments = [];
const reports = {};
for (const [index, release] of releases.entries()) {
    const phase = index + 1;
    const deployment = deploy(release);
    const previous = deployments.at(-1);
    if (
        previous !== undefined &&
        deployment.versionId !== null &&
        deployment.versionId === previous.versionId
    ) {
        throw new TypeError(`Deployment for phase ${phase} did not produce a new worker version`);
    }
    deployments.push(deployment);
    await awaitReady(deployment.url);
    console.log(
        `phase ${phase} against ${deployment.url} (release ${release}, version ${deployment.versionId})`
    );
    const reportName = `phase-${phase}.vitest.json`;
    const report = runPhase(deployment.url, phase, stateFile, resolve(evidenceRoot, reportName));
    reports[reportName] = sha256(readFileSync(resolve(evidenceRoot, reportName)));
    console.log(`phase ${phase}: ${report.numPassedTests} passed`);
}

const manifest = {
    edition: "1.0.0",
    commit,
    dirtySources: dirty,
    accountId: "f44999d1ddda7012e9a87729eba250f1",
    worker: "agent-core-live-harness",
    bucket,
    url: deployments.at(-1).url,
    deployments,
    sourceFingerprints: Object.fromEntries(
        fingerprintSources.map((path) => [
            path,
            sha256(readFileSync(resolve(repositoryRoot, path)))
        ])
    ),
    reports
};
writeFileSync(resolve(evidenceRoot, "run.json"), `${JSON.stringify(manifest, null, 4)}\n`);
console.log(`live evidence recorded in ${evidenceRoot}`);

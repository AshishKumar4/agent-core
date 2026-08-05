import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "../..");
const formalRoot = resolve(packageRoot, "formal");
const oracleBinary = resolve(formalRoot, ".lake/build/bin/oracle");
const buildLock = resolve(
    tmpdir(),
    `agent-core-oracle-${createHash("sha256").update(formalRoot).digest("hex").slice(0, 16)}.lock`
);

/**
 * A line-oriented JSON client for the verified Lean oracle. The oracle process is
 * spawned once per suite; requests are answered strictly in order, so responses are
 * matched to callers by queue position.
 */
export class LeanOracle {
    readonly #child: ChildProcess;
    readonly #pending: Array<{
        resolve: (value: Record<string, unknown>) => void;
        reject: (reason: Error) => void;
    }> = [];
    #buffer = "";

    private constructor(child: ChildProcess) {
        this.#child = child;
        if (child.stdout === null || child.stdin === null) {
            throw new Error("Lean oracle must be spawned with piped stdio");
        }
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            this.#buffer += chunk;
            for (;;) {
                const newline = this.#buffer.indexOf("\n");
                if (newline < 0) return;
                const line = this.#buffer.slice(0, newline);
                this.#buffer = this.#buffer.slice(newline + 1);
                const waiter = this.#pending.shift();
                if (waiter === undefined) continue;
                try {
                    waiter.resolve(JSON.parse(line) as Record<string, unknown>);
                } catch (error) {
                    waiter.reject(error instanceof Error ? error : new Error(String(error)));
                }
            }
        });
    }

    /** Builds the oracle if needed (cached by lake) and starts the server process. */
    public static start(): LeanOracle {
        // Concurrent suites on a cold cache race elan's toolchain installation
        // inside lake; one builder holds the lock, the rest wait and then reuse
        // lake's cached build.
        acquireBuildLock();
        try {
            const build = spawnSync("lake", ["build", "oracle"], {
                cwd: formalRoot,
                encoding: "utf8",
                timeout: 900_000
            });
            if (build.error || build.status !== 0) {
                throw new Error(
                    `Building the Lean oracle failed: ${build.error?.message ?? build.stderr}`
                );
            }
        } finally {
            rmSync(buildLock, { recursive: true, force: true });
        }
        return new LeanOracle(spawn(oracleBinary, [], { stdio: ["pipe", "pipe", "inherit"] }));
    }

    public async ask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
            this.#pending.push({ resolve: resolvePromise, reject });
            this.#child.stdin?.write(`${JSON.stringify(request)}\n`);
        });
        if (typeof response["error"] === "string") {
            throw new Error(`Lean oracle rejected the request: ${response["error"]}`);
        }
        return response;
    }

    public stop(): void {
        this.#child.stdin?.end();
        this.#child.kill();
    }
}

function acquireBuildLock(): void {
    for (let waited = 0; ; waited += 500) {
        try {
            mkdirSync(buildLock);
            writeFileSync(resolve(buildLock, "pid"), String(process.pid));
            return;
        } catch {
            let holder = Number.NaN;
            try {
                holder = Number(readFileSync(resolve(buildLock, "pid"), "utf8"));
            } catch {
                // The holder may not have written its pid yet; treat a lock that
                // stays anonymous past the build timeout as abandoned.
            }
            if (Number.isInteger(holder)) {
                try {
                    process.kill(holder, 0);
                } catch {
                    rmSync(buildLock, { recursive: true, force: true });
                    continue;
                }
            } else if (waited >= 900_000) {
                rmSync(buildLock, { recursive: true, force: true });
                continue;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        }
    }
}

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { isJsonObject, isJsonValue, isMember, type JsonObject } from "../../src/core";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    isDifferentialTestPath,
    oracleEvidenceDirectoryEnvironment,
    oracleEvidenceTestPathEnvironment
} from "../../scripts/quality/oracle-execution-evidence.js";

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
 *
 * What every suite built on this client establishes runs one way. A disagreement is a
 * genuine semantic divergence between the implementation and a model definition proved
 * sound and complete for its relation. Agreement is empirical evidence over the inputs
 * actually exercised and bounds nothing outside them — it is not a proof that the
 * implementation refines the model. The ledger records that labelling as
 * `NC-DIFFERENTIAL-EMPIRICAL`; no designated theorem depends on any run of this oracle.
 */
export class LeanOracle {
    readonly #child: ChildProcess;
    readonly #expectedOperations: ReadonlySet<string>;
    readonly #observedOperations = new Set<string>();
    readonly #pending: Array<{
        resolve: (value: JsonObject) => void;
        reject: (reason: Error) => void;
    }> = [];
    #buffer = "";

    private constructor(child: ChildProcess, expectedOperations: ReadonlySet<string>) {
        this.#child = child;
        this.#expectedOperations = expectedOperations;
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
                    waiter.resolve(decodeResponse(line));
                } catch (error) {
                    waiter.reject(error instanceof Error ? error : new Error(String(error)));
                }
            }
        });
    }

    /** Builds the oracle if needed (cached by lake) and starts the server process. */
    public static start(expectedOperations: readonly string[]): LeanOracle {
        const expected = new Set(expectedOperations);
        if (expected.size === 0 || expected.size !== expectedOperations.length) {
            throw new TypeError("Lean oracle operations must be a nonempty unique list");
        }
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
        return new LeanOracle(
            spawn(oracleBinary, [], { stdio: ["pipe", "pipe", "inherit"] }),
            expected
        );
    }

    public async ask(request: JsonObject): Promise<JsonObject> {
        const operation = request["op"];
        if (!isMember([...this.#expectedOperations], operation)) {
            throw new TypeError(`Unexpected Lean oracle operation: ${String(operation)}`);
        }
        const response = await new Promise<JsonObject>((resolvePromise, reject) => {
            this.#pending.push({ resolve: resolvePromise, reject });
            this.#child.stdin?.write(`${JSON.stringify(request)}\n`);
        });
        // The model answers a verdict object or an `error` object, never both, so an `error`
        // field present at all means the request never reached the relation under comparison.
        const error = response["error"];
        if (error !== undefined) {
            throw new Error(`Lean oracle rejected the request: ${String(error)}`);
        }
        this.#observedOperations.add(operation);
        return response;
    }

    public stop(): void {
        try {
            const missing = [...this.#expectedOperations].filter(
                (operation) => !this.#observedOperations.has(operation)
            );
            if (missing.length > 0) {
                throw new TypeError(
                    `Lean oracle operations were not exercised: ${missing.join(", ")}`
                );
            }
            recordOracleExecution(this.#expectedOperations, this.#observedOperations);
        } finally {
            this.#child.stdin?.end();
            this.#child.kill();
        }
    }
}

function recordOracleExecution(
    expectedOperations: ReadonlySet<string>,
    observedOperations: ReadonlySet<string>
): void {
    const directory = process.env[oracleEvidenceDirectoryEnvironment];
    const testPath = process.env[oracleEvidenceTestPathEnvironment];
    if (directory === undefined && testPath === undefined) return;
    if (directory === undefined || directory.length === 0 || !isDifferentialTestPath(testPath)) {
        throw new TypeError("Oracle execution evidence environment is incomplete");
    }
    const expected = [...expectedOperations].sort(codePointOrder);
    const observed = [...observedOperations].sort(codePointOrder);
    const manifest = {
        edition: "1.0.0",
        expectedOperations: expected,
        observedOperations: observed,
        testPath
    };
    const identity = `${testPath}\n${expected.join("\n")}`;
    const name = `${createHash("sha256").update(identity).digest("hex")}.json`;
    writeFileSync(join(directory, name), `${JSON.stringify(manifest)}\n`, {
        encoding: "utf8",
        flag: "wx"
    });
}

function codePointOrder(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Reads a field of a model answer as the boolean the oracle protocol defines for it. The
 * readers below all fail loudly rather than assume: an answer that does not carry the field
 * the protocol promises is a broken oracle, not a disagreement worth reporting.
 */
export function modelFlag(answer: JsonObject, field: string): boolean {
    const value = answer[field];
    if (value !== true && value !== false) {
        throw new TypeError(`The Lean oracle answered a non-boolean ${field}`);
    }
    return value;
}

/** Reads a field of a model answer as the number the oracle protocol defines for it. */
export function modelNumber(answer: JsonObject, field: string): number {
    const value = answer[field];
    // Number.isFinite answers true only for actual numbers, so the conversion is the identity.
    if (!Number.isFinite(value)) {
        throw new TypeError(`The Lean oracle answered a non-numeric ${field}`);
    }
    return Number(value);
}

/** Reads a field of a model answer as the nested object the oracle protocol defines for it. */
export function modelObject(answer: JsonObject, field: string): JsonObject {
    const value = answer[field];
    if (!isJsonObject(value)) {
        throw new TypeError(`The Lean oracle answered a non-object ${field}`);
    }
    return value;
}

/** Reads a field of a model answer as one of the names the oracle protocol defines for it. */
export function modelName<Name extends string>(
    answer: JsonObject,
    field: string,
    names: readonly Name[]
): Name {
    const value = answer[field];
    if (!isMember(names, value)) {
        throw new TypeError(`The Lean oracle answered an unknown ${field}: ${String(value)}`);
    }
    return value;
}

/**
 * Reads one line of the oracle's output as the JSON object its protocol defines. This is the
 * process boundary: nothing about the bytes is known until they are parsed here, and a line
 * that is not a JSON object is a broken oracle rather than a disagreement to report.
 */
function decodeResponse(line: string): JsonObject {
    const decoded: unknown = JSON.parse(line);
    if (!isJsonValue(decoded) || !isJsonObject(decoded)) {
        throw new TypeError(`The Lean oracle answered with a non-object line: ${line}`);
    }
    return decoded;
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

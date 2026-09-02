import { type SpawnSyncReturns, spawnSync } from "node:child_process";

const subprocessTimeout = 60_000;

/** A gate's whole stdout, not the first megabyte of it.
 *
 * `spawnSync` truncates at `maxBuffer` and reports the truncation as an `ENOBUFS` error,
 * so a checker whose report outgrows the default would fail these tests by size rather
 * than by verdict. The controlled-language report already prints a quarter of a megabyte
 * of axiom designations and one JSON ledger line, and it grows with the corpus. This is
 * the same ceiling `scripts/quality/cnl.mjs` gives its own two spawns. */
const subprocessMaxBuffer = 64 * 1024 * 1024;

export const subprocessTestOptions = { timeout: 90_000 } as const;

/** What a gate run yields: `encoding: "utf8"` fixes stdout and stderr as strings. */
export type QualitySubprocessResult = SpawnSyncReturns<string>;

export function runQualitySubprocess(
    command: string,
    args: string[],
    cwd?: string,
    timeout: number = subprocessTimeout
): QualitySubprocessResult {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: subprocessMaxBuffer,
        timeout,
        killSignal: "SIGKILL"
    });
    if (result.error) throw result.error;
    return result;
}

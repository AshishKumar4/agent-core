import { type SpawnSyncReturns, spawnSync } from "node:child_process";

const subprocessTimeout = 60_000;

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
        timeout,
        killSignal: "SIGKILL"
    });
    if (result.error) throw result.error;
    return result;
}

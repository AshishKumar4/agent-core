import { spawnSync } from "node:child_process";

const subprocessTimeout = 60_000;

export const subprocessTestOptions = { timeout: 90_000 } as const;

export function runQualitySubprocess(command: string, args: string[], cwd?: string) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        timeout: subprocessTimeout,
        killSignal: "SIGKILL"
    });
    if (result.error) throw result.error;
    return result;
}

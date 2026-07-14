import { spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env,
        maxBuffer: 64 * 1024 * 1024,
        stdio: options.capture ? "pipe" : "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
        const output = options.capture ? `${result.stdout}${result.stderr}` : "";
        throw new Error(
            `${command} failed with status ${result.status ?? 1}${output ? `\n${output}` : ""}`
        );
    }
    return result;
}

import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await rm(resolve(packageRoot, "dist"), { recursive: true, force: true });

const result = spawnSync(
    process.execPath,
    [resolve(packageRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    { cwd: packageRoot, encoding: "utf8" }
);
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0)
    throw new TypeError(`Cloudflare build failed with status ${result.status}`);

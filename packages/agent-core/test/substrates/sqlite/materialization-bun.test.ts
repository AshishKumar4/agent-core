import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// A second runtime plus native SQLite cold start can exceed Vitest's default under parallel load.
test(
    "runs the materialization schema and reset path on native Bun SQLite",
    { timeout: 30_000 },
    () => {
        const fixture = fileURLToPath(new URL("./materialization-bun.fixture.ts", import.meta.url));
        const result = spawnSync("bun", [fixture], {
            encoding: "utf8",
            env: { ...process.env, NODE_NO_WARNINGS: "1" }
        });

        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe("");
        expect(result.status).toBe(0);
    }
);

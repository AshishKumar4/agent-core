import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        globals: true,
        include: ["test/live/phase-*.test.ts"],
        // Live requests traverse real Cloudflare infrastructure.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        fileParallelism: false
    }
});

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        globals: true,
        include: ["test/live/phase-*.test.ts"],
        // Live scenarios wait on real alarms, hibernation, and queue redelivery.
        testTimeout: 240_000,
        hookTimeout: 240_000,
        fileParallelism: false
    }
});

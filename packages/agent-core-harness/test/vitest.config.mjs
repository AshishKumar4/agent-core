import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        globals: true,
        tags: [
            {
                name: "p0",
                description: "Critical safety, durability, and irreversible-integrity behavior"
            },
            {
                name: "p1",
                description: "Required runtime correctness, recovery, and integration behavior"
            },
            {
                name: "p2",
                description: "Compatibility, diagnostics, and exhaustive edge behavior"
            }
        ],
        strictTags: true,
        include: ["test/*.test.ts"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            reporter: ["text", "json", "json-summary"],
            reportsDirectory: "reports/quality/coverage/structural"
        }
    }
});

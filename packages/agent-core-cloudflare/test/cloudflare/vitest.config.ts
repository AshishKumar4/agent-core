import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.test.jsonc" }
        })
    ],
    test: {
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
        include: ["test/cloudflare/**/*.test.ts"]
    }
});

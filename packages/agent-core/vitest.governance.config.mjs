import base from "./vitest.quality.config.mjs";
import { defineConfig } from "vitest/config";

export default defineConfig({
    ...base,
    test: {
        ...base.test,
        include: [
            "test/quality/governance.test.ts",
            "test/quality/ownership.test.ts",
            "test/quality/protocols.test.ts"
        ],
        exclude: ["**/node_modules/**"]
    }
});

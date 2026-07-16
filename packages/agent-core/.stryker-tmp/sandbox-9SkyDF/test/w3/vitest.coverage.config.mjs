// @ts-nocheck
import base from "../../vitest.config.mjs";

export default {
    ...base,
    test: {
        ...base.test,
        coverage: {
            ...base.test.coverage,
            exclude: []
        }
    }
};

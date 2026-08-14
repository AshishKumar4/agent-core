import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "runtimeTypeof" };

tester.run("anti-slop/no-runtime-typeof", noRuntimeTypeofRule, {
    valid: [
        "function isString(value: unknown): value is string { return typeof value === 'string'; }",
        "const isString = (value: unknown): value is string => typeof value === 'string';",
        "function assertString(value: unknown): asserts value is string { if (typeof value !== 'string') throw new TypeError(); }",
        "function hasName(value: unknown): value is { name: string } { return typeof value === 'object' && value !== null && typeof value.name === 'string'; }",
        "const exportedKind = typeof exportedValue;",
        "expect(typeof exportedValue).toBe('function');"
    ],
    invalid: [
        {
            code: "function length(value: unknown): number { if (typeof value === 'string') return value.length; return 0; }",
            errors: [error]
        },
        {
            code: "function nonempty(value: unknown): boolean { return typeof value === 'string' && value.length > 0; }",
            errors: [error]
        },
        {
            code: "const length = typeof value === 'string' ? value.length : 0;",
            errors: [error]
        },
        {
            code: "while (typeof value === 'string') value = next();",
            errors: [error]
        },
        {
            code: "switch (typeof value) { case 'string': use(value); }",
            errors: [error]
        },
        {
            code: "function length(value: unknown): number { const kind = typeof value; if (kind === 'string') return value.length; return 0; }",
            errors: [error]
        },
        {
            code: "function isString(value: unknown, config: Config): value is string { if (typeof config.mode === 'string') use(config.mode); return typeof value === 'string'; }",
            errors: [error]
        }
    ]
});

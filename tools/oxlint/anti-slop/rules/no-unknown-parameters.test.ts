import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
    valid: [
        "function isString(value: unknown): value is string { return typeof value === 'string'; }",
        "function assertString(value: unknown): asserts value is string { if (typeof value !== 'string') throw new TypeError(); }",
        "function enrich(cause: unknown): Error { return new Error('failed', { cause }); }"
    ],
    invalid: [
        {
            code: "function handle(value: unknown): void {}",
            errors: [error]
        },
        {
            code: "function isString(value: unknown, context: unknown): value is string { return true; }",
            errors: [error]
        }
    ]
});

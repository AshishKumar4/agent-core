import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
    valid: [
        "function isString(value: unknown): value is string { return typeof value === 'string'; }",
        "function assertString(value: unknown): asserts value is string { if (typeof value !== 'string') throw new TypeError(); }",
        "type Hidden = unknown; function outer(): void { type Hidden = string; function inner(value: Hidden): void {} }"
    ],
    invalid: [
        {
            code: "function handle(value: unknown): void {}",
            errors: [error]
        },
        {
            code: "function isString(value: unknown, context: unknown): value is string { return true; }",
            errors: [error]
        },
        {
            code: "function enrich(cause: unknown): Error { return new Error('failed', { cause }); }",
            errors: [error]
        },
        {
            code: "function pass(value: string | unknown): void {}",
            errors: [error]
        },
        {
            code: "type Hidden = unknown; function pass(value: Hidden): void {}",
            errors: [error]
        },
        {
            code: "type Identity<T> = T; function pass(value: Identity<unknown>): void {}",
            errors: [error]
        },
        {
            code: "function outer(): void { type Hidden = unknown; function inner(value: Hidden): void {} }",
            errors: [error]
        }
    ]
});

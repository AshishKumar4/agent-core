import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownReturnsRule } from "./no-unknown-returns.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-unknown-returns", noUnknownReturnsRule, {
    valid: [
        "function load(): User { return user; }",
        "function identity<T>(value: T): T { return value; }",
        "function refined(): unknown & User { return user; }",
        "function values(): unknown[] { return []; }"
    ],
    invalid: [
        { code: "function load(): unknown { return value; }", errors: 1 },
        { code: "function load(): string | unknown { return value; }", errors: 1 },
        { code: "function load(): Promise<unknown> { return value; }", errors: 1 },
        {
            code: "type Identity<T> = T; function load(): Identity<unknown> { return value; }",
            errors: 1
        },
        {
            code: "type Result<T> = Promise<T>; function load(): Result<unknown> { return value; }",
            errors: 1
        }
    ]
});

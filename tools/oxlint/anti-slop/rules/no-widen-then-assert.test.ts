import { RuleTester } from "oxlint/plugins-dev";

import { noWidenThenAssertRule } from "./no-widen-then-assert.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-widen-then-assert", noWidenThenAssertRule, {
    valid: [
        "const value: User = { id: 'a' }; consume(value);",
        "function parse(value: unknown): User { return value as User; }",
        "let value: unknown = { id: 'a' }; consume(value as User);",
        "const value: unknown = getValue(); consume(value as User);"
    ],
    invalid: [
        { code: "const value: unknown = { id: 'a' }; consume(value as User);", errors: 1 },
        {
            code: "const precise = { id: 'a' }; const value: unknown = precise; consume(value as User);",
            errors: 1
        },
        {
            code: "const value: object = { id: 'a' }; consume(value as { readonly id: string });",
            errors: 1
        },
        {
            code: "const value: Record<string, unknown> = { id: 'a' }; consume(value as Record<string, string>);",
            errors: 1
        }
    ]
});

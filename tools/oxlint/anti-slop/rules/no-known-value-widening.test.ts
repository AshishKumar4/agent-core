import { RuleTester } from "oxlint/plugins-dev";

import { noKnownValueWideningRule } from "./no-known-value-widening.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-known-value-widening", noKnownValueWideningRule, {
    valid: [
        "const user: User = { id: 'a' };",
        "const users: Record<string, User> = {};",
        "const user = { id: 'a' } satisfies User;",
        "function pass(value: unknown): unknown { return value; }"
    ],
    invalid: [
        { code: "const value: unknown = { id: 'a' };", errors: 1 },
        { code: "const value: object = [1, 2];", errors: 1 },
        { code: "const value: { readonly id: string } = { id: 'a' };", errors: 1 },
        { code: "const value = { id: 'a' } as unknown;", errors: 1 },
        {
            code: "type Container<T> = Record<string, T>; const values: Container<User> = { a: user };",
            errors: 1
        }
    ]
});

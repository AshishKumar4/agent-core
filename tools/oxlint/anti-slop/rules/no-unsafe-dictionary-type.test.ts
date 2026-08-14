import { RuleTester } from "oxlint/plugins-dev";

import { noUnsafeDictionaryTypeRule } from "./no-unsafe-dictionary-type.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-unsafe-dictionary-type", noUnsafeDictionaryTypeRule, {
    valid: [
        "type Users = Record<string, User>;",
        "interface Result { readonly value: unknown }",
        "type Closed = { readonly id: string };",
        "type Generic<T> = Record<string, T>;",
        "type Hidden = unknown; function outer(): void { type Hidden = User; type Values = Record<string, Hidden>; }"
    ],
    invalid: [
        { code: "type Values = Record<string, unknown>;", errors: 1 },
        { code: "type Values = { [key: string]: object };", errors: 1 },
        { code: "interface Values { [key: string]: any }", errors: 1 },
        { code: "type Values = Record<string, User | unknown>;", errors: 1 },
        {
            code: "type Generic<T> = Record<string, T>; type Values = Generic<unknown>;",
            errors: 1
        },
        {
            code: "function outer(): void { type Hidden = unknown; type Values = Record<string, Hidden>; }",
            errors: 1
        }
    ]
});

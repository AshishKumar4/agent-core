import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-unknown-type-aliases", noUnknownTypeAliasesRule, {
    valid: [
        "type User = { readonly id: string };",
        "type Identity<T> = T;",
        "type Refined = unknown & { readonly id: string };",
        "type Values = readonly unknown[];"
    ],
    invalid: [
        {
            code: "type Hidden = unknown;",
            errors: [{ messageId: "unknownAlias", data: { alias: "Hidden" } }]
        },
        {
            code: "type Hidden = string | unknown;",
            errors: [{ messageId: "unknownAlias", data: { alias: "Hidden" } }]
        },
        {
            code: "type Identity<T> = T; type Hidden = Identity<unknown>;",
            errors: [{ messageId: "unknownAlias", data: { alias: "Hidden" } }]
        },
        {
            code: "type Identity<T> = T; type Middle<T> = Identity<T>; type Hidden = Middle<unknown>;",
            errors: [{ messageId: "unknownAlias", data: { alias: "Hidden" } }]
        }
    ]
});

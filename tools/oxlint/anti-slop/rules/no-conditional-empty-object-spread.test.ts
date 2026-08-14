import { RuleTester } from "oxlint/plugins-dev";

import { noConditionalEmptyObjectSpreadRule } from "./no-conditional-empty-object-spread.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-conditional-empty-object-spread", noConditionalEmptyObjectSpreadRule, {
    valid: [
        "const result = { ...value };",
        "const result = { ...(flag ? { id: 'a' } : { id: 'b' }) };",
        "const result = [...(flag ? [] : values)];"
    ],
    invalid: [
        { code: "const result = { ...(flag ? { id: 'a' } : {}) };", errors: 1 },
        { code: "const result = { ...(flag ? {} : { id: 'b' }) };", errors: 1 },
        { code: "const result = { ...(flag ? ({}) : { id: 'b' }) };", errors: 1 }
    ]
});

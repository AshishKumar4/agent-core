import { RuleTester } from "oxlint/plugins-dev";

import { noLocaleCompareRule } from "./no-locale-compare.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-locale-compare", noLocaleCompareRule, {
    valid: [
        "values.sort(compareText);",
        "const order = new Intl.Collator('en').compare(left, right);"
    ],
    invalid: [
        { code: "left.localeCompare(right);", errors: 1 },
        { code: "left['localeCompare'](right);", errors: 1 },
        { code: "left[`localeCompare`](right);", errors: 1 },
        { code: "left?.localeCompare(right);", errors: 1 },
        { code: "const compare = left.localeCompare;", errors: 1 },
        { code: "const { localeCompare: compare } = left;", errors: 1 },
        { code: "const { 'localeCompare': compare } = left;", errors: 1 },
        { code: "const { ['localeCompare']: compare } = left;", errors: 1 },
        { code: "const { [`localeCompare`]: compare } = left;", errors: 1 },
        { code: "({ localeCompare: compare } = left);", errors: 1 }
    ]
});

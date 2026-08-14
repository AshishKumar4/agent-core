import { RuleTester } from "oxlint/plugins-dev";

import { noReflectApplyRule } from "./no-reflect-apply.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-reflect-apply", noReflectApplyRule, {
    valid: [
        "const Reflect = { apply() {} }; Reflect.apply(fn, null, []);",
        "function run(Reflect: ReflectApi): void { Reflect.apply(fn, null, []); }"
    ],
    invalid: [
        { code: "Reflect.apply(fn, null, []);", errors: 1 },
        { code: "Reflect['apply'](fn, null, []);", errors: 1 },
        { code: "const reflect = Reflect; reflect.apply(fn, null, []);", errors: 1 },
        { code: "const apply = Reflect.apply; apply(fn, null, []);", errors: 1 },
        { code: "const { apply } = Reflect; apply(fn, null, []);", errors: 1 }
    ]
});

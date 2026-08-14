import { RuleTester } from "oxlint/plugins-dev";

import { noReflectGetRule } from "./no-reflect-get.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-reflect-get", noReflectGetRule, {
    valid: [
        "const Reflect = { get() {} }; Reflect.get(value, key);",
        "function run(Reflect: ReflectApi): void { Reflect.get(value, key); }"
    ],
    invalid: [
        { code: "Reflect.get(value, key);", errors: 1 },
        { code: "Reflect['get'](value, key);", errors: 1 },
        { code: "const reflect = Reflect; reflect.get(value, key);", errors: 1 },
        { code: "const get = Reflect.get; get(value, key);", errors: 1 },
        { code: "const { get } = Reflect; get(value, key);", errors: 1 }
    ]
});

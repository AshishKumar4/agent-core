import { RuleTester } from "oxlint/plugins-dev";

import { noObjectParametersRule } from "./no-object-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-object-parameters", noObjectParametersRule, {
    valid: [
        "function save(value: User): void {}",
        "function identity<T extends object>(value: T): T { return value; }",
        "function save(value: object & User): void {}",
        "function save(value: Record<string, object>): void {}"
    ],
    invalid: [
        { code: "function save(value: object): void {}", errors: 1 },
        { code: "function save(value: string | object): void {}", errors: 1 },
        { code: "type Payload = object; function save(value: Payload): void {}", errors: 1 },
        {
            code: "type Identity<T> = T; function save(value: Identity<object>): void {}",
            errors: 1
        }
    ]
});

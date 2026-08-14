import { RuleTester } from "oxlint/plugins-dev";

import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-chained-type-assertions", noChainedTypeAssertionsRule, {
    valid: [
        "const value = input as User;",
        "const values = [1, 2] as const;",
        "const value = input satisfies User;"
    ],
    invalid: [
        { code: "const value = input as unknown as User;", errors: 1 },
        { code: "const value = (input as unknown) as User;", errors: 1 },
        { code: "const value = <User>(<unknown>input);", errors: 1 }
    ]
});

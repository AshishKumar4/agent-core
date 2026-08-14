import { RuleTester } from "oxlint/plugins-dev";

import { noModuleMockingRule } from "./no-module-mocking.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-module-mocking", noModuleMockingRule, {
    valid: [
        "const vi = { mock() {} }; vi.mock();",
        "function run(jest: { mock(): void }): void { jest.mock(); }",
        "const helper = { mock() {} }; const mock = helper.mock; mock();"
    ],
    invalid: [
        { code: "vi.mock('./service.ts');", errors: 1 },
        { code: "vi['doMock']('./service.ts');", errors: 1 },
        {
            code: "import { vi as testApi } from 'vitest'; testApi.mock('./service.ts');",
            errors: 1
        },
        { code: "const testApi = vi; testApi.mock('./service.ts');", errors: 1 },
        { code: "const mock = vi.mock; mock('./service.ts');", errors: 1 },
        { code: "const { mock } = vi; mock('./service.ts');", errors: 1 },
        { code: "const mock = vi.mock.bind(vi); mock('./service.ts');", errors: 1 }
    ]
});

import { RuleTester } from "oxlint/plugins-dev";

import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
    valid: [
        "const payloadCardinality = 'single';",
        "const replayCases = [];",
        "interface InvocationHeader { readonly 'shape': 'single' | 'batch' }",
        "const encoded = { 'shape': 'single' }; encoded['shape'];"
    ],
    invalid: [
        { code: "const shape = 'single';", errors: 1 },
        { code: "interface InvocationShape { readonly kind: string }", errors: 1 },
        { code: "class Payload { #shape = 'single'; }", errors: 1 },
        { code: "const view = <Shape />;", errors: 1 },
        { code: "payload.shape;", errors: 1 }
    ]
});

import { RuleTester } from "oxlint/plugins-dev";

import { requireSafetyCommentForTypeAssertionRule } from "./require-safety-comment-for-type-assertion.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run(
    "anti-slop/require-safety-comment-for-type-assertion",
    requireSafetyCommentForTypeAssertionRule,
    {
        valid: [
            "const values = [1, 2] as const;",
            "// SAFETY: parseUserId validated the identifier before branding it.\nconst id = value as UserId;",
            "const id = /* SAFETY: parseUserId validated the identifier before branding it. */ value as UserId;"
        ],
        invalid: [
            {
                code: "const id = value as UserId;",
                errors: [{ messageId: "missingSafetyComment" }]
            },
            {
                code: "// SAFETY: as above.\nconst id = value as UserId;",
                errors: [{ messageId: "placeholderSafetyComment" }]
            },
            {
                code: "// SAFETY: same invariant.\nconst id = value as UserId;",
                errors: [{ messageId: "placeholderSafetyComment" }]
            },
            {
                code: "const id = value as UserId; // SAFETY: parseUserId checked this.",
                errors: [{ messageId: "missingSafetyComment" }]
            }
        ]
    }
);

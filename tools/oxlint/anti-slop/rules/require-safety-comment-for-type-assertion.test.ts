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
            "const id = /* SAFETY: parseUserId validated the identifier before branding it. */ value as UserId;",
            "const first = /* SAFETY: parseUserId validated this identifier. */ one as UserId; const second = /* SAFETY: parseUserId validated this identifier. */ two as UserId;",
            "// SAFETY: as above, for the holder member validated by parseUserId.\nconst id = value as UserId;",
            "execute(/* SAFETY: parseUserId validated this identifier. */ value as UserId);",
            "function run(): void { /* SAFETY: parseUserId validated the identifier. */ execute(value as UserId); }"
        ],
        invalid: [
            {
                code: "const id = value as UserId;",
                errors: [{ messageId: "missingSafetyComment" }]
            },
            {
                code: "const id = value as UserId; // SAFETY: parseUserId checked this.",
                errors: [{ messageId: "missingSafetyComment" }]
            },
            {
                code: "// SAFETY: parseUserId validated the identifier.\nconst first = one as UserId; const second = two as UserId;",
                errors: [{ messageId: "missingSafetyComment" }]
            },
            {
                code: "// SAFETY: parseUserId validated the identifier.\n\nconst id = value as UserId;",
                errors: [{ messageId: "missingSafetyComment" }]
            },
            {
                code: "// SAFETY: both values were parsed.\nconst ids = [one as UserId, two as UserId];",
                errors: [
                    { messageId: "missingSafetyComment" },
                    { messageId: "missingSafetyComment" }
                ]
            },
            {
                code: "// SAFETY:\nconst id = value as UserId;",
                errors: [{ messageId: "placeholderSafetyComment" }]
            },
            {
                code: "// SAFETY: as above.\nconst id = value as UserId;",
                errors: [{ messageId: "placeholderSafetyComment" }]
            },
            {
                code: "// SAFETY: same invariant!\nconst id = value as UserId;",
                errors: [{ messageId: "placeholderSafetyComment" }]
            },
            {
                code: "// SAFETY: same reason...\nconst id = value as UserId;",
                errors: [{ messageId: "placeholderSafetyComment" }]
            },
            {
                code: "// SAFETY: see above;\nconst id = value as UserId;",
                errors: [{ messageId: "placeholderSafetyComment" }]
            },
            {
                code: "// SAFETY: trust me?!\nconst id = value as UserId;",
                errors: [{ messageId: "placeholderSafetyComment" }]
            }
        ]
    }
);

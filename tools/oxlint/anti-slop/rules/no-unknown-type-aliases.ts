import { defineRule } from "@oxlint/plugins";

import { createTypeEnvironment } from "../shared/dictionary-types.ts";
import { resolvesToTopType } from "../shared/type-resolution.ts";

/** Ban named aliases that conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Disallow type aliases whose resolved top-level type includes unknown; unknown must remain visible at an allowed boundary."
        },
        messages: {
            unknownAlias:
                "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary; otherwise use the parsed owner type."
        }
    },
    create(context) {
        return {
            Program(node) {
                const environment = createTypeEnvironment(node);
                for (const alias of environment.aliases.values()) {
                    const parameters = new Set(
                        (alias.typeParameters?.params ?? []).map((parameter) => parameter.name.name)
                    );
                    if (
                        !resolvesToTopType(alias.typeAnnotation, "unknown", environment, parameters)
                    ) {
                        continue;
                    }
                    context.report({
                        node: alias.id,
                        messageId: "unknownAlias",
                        data: { alias: alias.id.name }
                    });
                }
            }
        };
    }
});

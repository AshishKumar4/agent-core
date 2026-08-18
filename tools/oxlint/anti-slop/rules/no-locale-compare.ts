import { defineRule, type ESTree } from "@oxlint/plugins";

function isLocaleCompareKey(node: ESTree.Expression | ESTree.PropertyKey): boolean {
    return (
        (node.type === "Literal" && node.value === "localeCompare") ||
        (node.type === "TemplateLiteral" &&
            node.expressions.length === 0 &&
            node.quasis[0]?.value.cooked === "localeCompare")
    );
}

function memberName(member: ESTree.MemberExpression): string | null {
    if (!member.computed) {
        return member.property.type === "Identifier" ? member.property.name : null;
    }
    return isLocaleCompareKey(member.property) ? "localeCompare" : null;
}

function propertyName(
    property: ESTree.ObjectProperty | ESTree.BindingProperty | ESTree.AssignmentTargetProperty
): string | null {
    if (property.computed) return isLocaleCompareKey(property.key) ? "localeCompare" : null;
    if (property.key.type === "Identifier") return property.key.name;
    return isLocaleCompareKey(property.key) ? "localeCompare" : null;
}

/** Require deterministic text ordering instead of host-locale collation. */
export const noLocaleCompareRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Disallow localeCompare; use an explicit deterministic comparator for persisted, canonical, or evidence order."
        },
        messages: {
            localeCompare:
                "Replace `localeCompare` with an explicit deterministic comparator. Host locale and ICU data are not canonical ordering inputs."
        }
    },
    create(context) {
        return {
            MemberExpression(node) {
                if (memberName(node) === "localeCompare") {
                    context.report({ node, messageId: "localeCompare" });
                }
            },
            Property(node) {
                if (
                    node.parent.type === "ObjectPattern" &&
                    propertyName(node) === "localeCompare"
                ) {
                    context.report({ node, messageId: "localeCompare" });
                }
            }
        };
    }
});

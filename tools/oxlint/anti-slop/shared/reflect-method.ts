import { isCallOfRootMethod, resolveVariable } from "./member-origin.ts";

import type { ESTree, SourceCode } from "@oxlint/plugins";

function isGlobalReflect(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): boolean {
    if (identifier.name !== "Reflect") return false;
    if (sourceCode.isGlobalReference(identifier)) return true;
    const variable = resolveVariable(sourceCode, identifier);
    return variable === null || variable.defs.length === 0;
}

/** Reports whether a call target resolves to one method on the global Reflect object. */
export function isGlobalReflectMethodCall(
    sourceCode: SourceCode,
    callee: ESTree.Expression,
    methodName: string
): boolean {
    return isCallOfRootMethod(sourceCode, callee, new Set([methodName]), isGlobalReflect);
}

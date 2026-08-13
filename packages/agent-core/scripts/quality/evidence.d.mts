import type ts from "typescript";

import type { JsonValue } from "./project.mjs";

export function requireSuccessfulTestReport(
    path: string,
    requireTests?: boolean
): Promise<JsonValue>;
export function sourceSymbolLines(
    selector: string,
    getSourceFile?: (path: string) => ts.SourceFile | undefined
): { startLine: number; endLine: number };

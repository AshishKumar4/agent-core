import type ts from "typescript-api";

import type { JsonValue } from "./project.mjs";

export function createProgram(): ts.Program;
export function resolveSourceSymbol(program: ts.Program, selector: string): ts.Node;
export function requireSuccessfulTestReport(
    path: string,
    requireTests?: boolean
): Promise<JsonValue>;
export function sourceSymbolLines(
    selector: string,
    getSourceFile?: (path: string) => ts.SourceFile | undefined
): { startLine: number; endLine: number };

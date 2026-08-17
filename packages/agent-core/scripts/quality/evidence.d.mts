import type { Node, SourceFile } from "typescript/unstable/ast";
import type { Project } from "typescript/unstable/sync";

import type { JsonValue } from "./project.mjs";

export function sourceProject(): Project;
export function resolveSourceSymbol(project: Project, selector: string): Node;
export function requireSuccessfulTestReport(
    path: string,
    requireTests?: boolean
): Promise<JsonValue>;
export function sourceSymbolLines(
    selector: string,
    getSourceFile?: (path: string) => SourceFile | undefined
): { startLine: number; endLine: number };

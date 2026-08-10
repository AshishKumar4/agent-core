export function requireSuccessfulTestReport(path: string, requireTests?: boolean): Promise<unknown>;
export function sourceSymbolLines(
    selector: string,
    getSourceFile?: (path: string) => unknown
): { startLine: number; endLine: number };

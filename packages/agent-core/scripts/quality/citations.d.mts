export function instructionSource(source: string, owner: string, root: string): Promise<string>;
export function requireInstructionText(
    sources: readonly string[],
    expected: string,
    owner: string,
    root: string
): Promise<void>;

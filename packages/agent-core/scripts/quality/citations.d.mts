export function citedText(citation: string, owner: string, root: string): Promise<string>;
export function requireCitedText(
    citations: readonly string[],
    expected: string,
    owner: string,
    root: string
): Promise<void>;

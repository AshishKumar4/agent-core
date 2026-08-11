export function globMatches(pattern: string, path: string): boolean;
export function readJson(path: string): Promise<unknown>;
export function readCanonicalJson(path: string): Promise<unknown>;
export function parseCanonicalJson(source: string, label: string): unknown;
export function assertUniqueIds<T>(
    items: readonly T[],
    idOf: (item: T) => string,
    owner: string
): readonly T[];

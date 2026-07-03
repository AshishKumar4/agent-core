export interface MemoryIndexChunk {
    readonly text: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly hash: string;
}

export interface MemoryIndexMatch {
    readonly id: string;
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
    readonly rank: number;
}

export abstract class MemoryIndex {
    public abstract initialize(): void;

    public abstract replaceFile(
        path: string,
        chunks: readonly MemoryIndexChunk[]
    ): void;

    public abstract removePath(path: string): void;

    public abstract indexedPaths(): readonly string[];

    public abstract search(query: string, limit: number): readonly MemoryIndexMatch[];
}

import type { ShellFileSystem, ShellStat } from "./filesystem";

export interface WalkEntry {
    readonly path: string;
    readonly stat: ShellStat;
}

export async function walkRecursive(
    files: ShellFileSystem,
    base: string,
    maxDepth: number,
    maxEntries: number
): Promise<WalkEntry[]> {
    const results: WalkEntry[] = [];

    async function walk(directory: string, depth: number): Promise<void> {
        if (depth > maxDepth || results.length >= maxEntries) {
            return;
        }

        const entries = await files.readdir(directory);

        for (const name of entries) {
            if (results.length >= maxEntries) {
                return;
            }

            const path = directory === "" ? name : `${directory}/${name}`;
            const stat = await files.stat(path);
            results.push({ path, stat });

            if (stat.isDirectory()) {
                await walk(path, depth + 1);
            }
        }
    }

    await walk(base, 0);
    return results;
}

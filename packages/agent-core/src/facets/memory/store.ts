import type { OperationContext } from "../../operations/context";
import { Durability } from "../filesystem/durability";
import { FileKind, type FileEntry } from "../filesystem/entry";
import { FileError, FileErrorCode } from "../filesystem/error";
import type { FileSystem } from "../filesystem/filesystem";
import { ListPosition } from "../filesystem/page";
import { FilePath } from "../filesystem/path";
import { ReadRange } from "../filesystem/range";
import { WriteMode } from "../filesystem/write";
import { chunkMarkdown } from "./chunker";
import type { MemoryIndex, MemoryIndexMatch } from "./memory-index";
import {
    DEFAULT_MEMORY_INDEXED_PREFIXES,
    isExcludedMemoryPath,
    isIndexableMemoryFile,
    normalizeMemoryPath,
    shouldIndexMemoryPath,
    sortMemoryIndexPaths
} from "./policy";
import { sanitizeFtsQuery } from "./query";
import type { MemorySearchResult } from "./query";

const DEFAULT_SNIPPET_MAX_CHARS = 700;
const DEFAULT_MIN_SCORE = 0.05;
const DEFAULT_OVERFETCH_MULTIPLIER = 3;
const DEFAULT_REBUILD_MAX_FILES = 500;
const DEFAULT_REBUILD_MAX_BYTES_PER_FILE = 1024 * 1024;
const DEFAULT_REBUILD_CONCURRENCY = 8;
const REBUILD_WALK_MAX_DEPTH = 10;
const REBUILD_WALK_MAX_ENTRIES = 2000;
const LIST_PAGE_SIZE = 256;

export interface SearchConfig {
    orFallback?: boolean;
    minScore?: number;
    overfetchMultiplier?: number;
    stopWords?: boolean;
}

export interface MemoryConfig {
    memoryDir?: string;
    logsDir?: string;
    curatedFile?: string;
    indexedPrefixes?: string[];
    indexedFiles?: string[];
    snippetMaxChars?: number;
    search?: SearchConfig;
}

export interface RebuildErrorContext {
    operation: string;
    path: string;
}

export interface RebuildIndexOptions {
    maxFiles?: number;
    maxBytesPerFile?: number;
    pruneMissing?: boolean;
    concurrency?: number;
    onError?: (error: Error, context: RebuildErrorContext) => void;
}

export interface RebuildIndexResult {
    indexed: number;
    pruned: number;
    skipped: number;
}

interface RebuildPathResult {
    indexed: number;
    pruned: number;
    skipped: number;
}

interface ScoredMatch extends MemoryIndexMatch {
    score: number;
}

export class MemoryStore {
    private readonly memoryDir: string;
    private readonly logsDir: string;
    public readonly curatedFile: string;
    private readonly indexedPrefixes: string[];
    private readonly indexedFiles: string[];
    private readonly snippetMaxChars: number;
    private readonly searchConfig: Required<SearchConfig>;

    public constructor(
        private readonly files: FileSystem,
        private readonly context: OperationContext,
        private readonly index: MemoryIndex,
        config?: MemoryConfig
    ) {
        this.memoryDir = normalizeMemoryPath(config?.memoryDir ?? "memory");
        this.logsDir = normalizeMemoryPath(
            config?.logsDir ?? `${this.memoryDir}/logs`
        );
        this.curatedFile = normalizeMemoryPath(
            config?.curatedFile ?? `${this.memoryDir}/MEMORY.md`
        );
        this.indexedPrefixes = config?.indexedPrefixes
            ?? [...DEFAULT_MEMORY_INDEXED_PREFIXES];
        this.indexedFiles = config?.indexedFiles ?? [];
        this.snippetMaxChars = config?.snippetMaxChars
            ?? DEFAULT_SNIPPET_MAX_CHARS;
        this.searchConfig = {
            orFallback: config?.search?.orFallback ?? true,
            minScore: config?.search?.minScore ?? DEFAULT_MIN_SCORE,
            overfetchMultiplier: config?.search?.overfetchMultiplier
                ?? DEFAULT_OVERFETCH_MULTIPLIER,
            stopWords: config?.search?.stopWords ?? true
        };
    }

    public ensureSchema(): void {
        this.index.initialize();
    }

    public shouldIndex(path: string): boolean {
        return shouldIndexMemoryPath(path, this.pathPolicy);
    }

    public shouldIndexFile(path: string): boolean {
        return isIndexableMemoryFile(path, this.pathPolicy);
    }

    public async writeFile(path: string, content: string): Promise<void> {
        await this.files.write(
            this.context,
            this.filePath(path),
            new TextEncoder().encode(content),
            WriteMode.upsert,
            Durability.accepted
        );
    }

    public async appendToFile(path: string, content: string): Promise<void> {
        let existing = "";
        try {
            existing = await this.readText(path);
        } catch (error) {
            if (!(error instanceof Error && isNotFound(error))) {
                throw error;
            }
        }
        await this.writeFile(path, existing + content);
    }

    public async readFile(
        path: string,
        lineRange?: { start: number; end: number }
    ): Promise<string | null> {
        let content: string;
        try {
            content = await this.readText(path);
        } catch (error) {
            if (error instanceof Error && isNotFound(error)) {
                return null;
            }
            throw error;
        }
        if (lineRange === undefined) {
            return content;
        }
        const lines = content.split("\n");
        const start = Math.max(0, lineRange.start - 1);
        const end = Math.min(lines.length, lineRange.end);
        return lines.slice(start, end).join("\n");
    }

    public async readCurated(): Promise<string | null> {
        return this.readFile(this.curatedFile);
    }

    public async indexFile(path: string, content: string): Promise<void> {
        const normalized = normalizeMemoryPath(path);
        this.index.replaceFile(normalized, await chunkMarkdown(content));
    }

    public async indexFileIfCurrent(
        path: string,
        content: string
    ): Promise<boolean> {
        const normalized = normalizeMemoryPath(path);
        let current: string;
        try {
            current = await this.readText(normalized);
        } catch (error) {
            if (error instanceof Error && isNotFound(error)) {
                return false;
            }
            throw error;
        }
        if (current !== content) {
            return false;
        }

        const chunks = await chunkMarkdown(content);
        try {
            current = await this.readText(normalized);
        } catch (error) {
            if (error instanceof Error && isNotFound(error)) {
                return false;
            }
            throw error;
        }
        if (current !== content) {
            return false;
        }

        this.index.replaceFile(normalized, chunks);
        return true;
    }

    public removeIndex(path: string): void {
        this.index.removePath(normalizeMemoryPath(path));
    }

    public async rebuildIndex(
        options?: RebuildIndexOptions
    ): Promise<RebuildIndexResult> {
        const maxFiles = options?.maxFiles ?? DEFAULT_REBUILD_MAX_FILES;
        const maxBytesPerFile = options?.maxBytesPerFile
            ?? DEFAULT_REBUILD_MAX_BYTES_PER_FILE;
        const concurrency = Math.max(
            1,
            Math.floor(options?.concurrency ?? DEFAULT_REBUILD_CONCURRENCY)
        );
        const paths = await this.discoverIndexedPaths(maxFiles, options);
        const existingPaths = [...this.index.indexedPaths()];
        const existingPathSet = new Set(existingPaths);
        const totals: RebuildIndexResult = {
            indexed: 0,
            pruned: 0,
            skipped: 0
        };

        if (options?.pruneMissing) {
            const results = await this.mapBatches(
                existingPaths,
                concurrency,
                path => this.pruneExistingPath(
                    path,
                    maxBytesPerFile,
                    existingPathSet,
                    options
                )
            );
            this.addResults(totals, results);
        }

        const results = await this.mapBatches(
            paths,
            concurrency,
            path => this.rebuildPath(
                path,
                maxBytesPerFile,
                options?.pruneMissing === true,
                existingPathSet,
                options
            )
        );
        this.addResults(totals, results);
        return totals;
    }

    public search(query: string, limit = 10): MemorySearchResult[] {
        if (!query.trim()) {
            return [];
        }

        const { orFallback, minScore, overfetchMultiplier, stopWords } =
            this.searchConfig;
        const safeQuery = sanitizeFtsQuery(query, { stopWords });
        const fetchLimit = limit * overfetchMultiplier;
        const andRows = [...this.index.search(safeQuery, fetchLimit)];
        const tokens = safeQuery.split(" ").filter(Boolean);
        const orFired = orFallback
            && andRows.length < limit
            && tokens.length > 1;
        let unionRows = andRows;

        if (orFired) {
            const orRows = this.index.search(tokens.join(" OR "), fetchLimit);
            const seen = new Set(andRows.map(row => row.id));
            unionRows = andRows.slice();
            for (const row of orRows) {
                if (!seen.has(row.id)) {
                    unionRows.push(row);
                    seen.add(row.id);
                }
            }
        }

        const ranked = orFired
            ? this.rerankByBm25AndCoverage(unionRows, tokens)
            : unionRows.map(row => ({
                ...row,
                score: 1 / (1 + Math.abs(row.rank))
            }));
        let results = ranked.map(row => ({
            path: row.path,
            startLine: row.startLine,
            endLine: row.endLine,
            snippet: row.text.length > this.snippetMaxChars
                ? `${row.text.slice(0, this.snippetMaxChars)}...`
                : row.text,
            score: row.score
        }));

        if (minScore > 0) {
            results = results.filter(result => result.score > minScore);
        }
        return results.slice(0, limit);
    }

    public todayLogPath(): string {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${this.logsDir}/${year}-${month}-${day}.md`;
    }

    public async listLogFiles(): Promise<string[]> {
        let entries: readonly FileEntry[];
        try {
            entries = await this.listDirectory(this.logsDir);
        } catch (error) {
            if (error instanceof Error && isNotFound(error)) {
                return [];
            }
            throw error;
        }
        return entries
            .filter(entry => /^\d{4}-\d{2}-\d{2}\.md$/.test(fileName(entry)))
            .sort((left, right) => fileName(right).localeCompare(fileName(left)))
            .map(entry => entry.path.toString());
    }

    public async listFiles(prefix?: string): Promise<string[]> {
        let entries: readonly FileEntry[];
        try {
            entries = await this.listDirectory(prefix ?? this.memoryDir);
        } catch (error) {
            if (error instanceof Error && isNotFound(error)) {
                return [];
            }
            throw error;
        }
        return entries.map(fileName);
    }

    private rerankByBm25AndCoverage(
        rows: readonly MemoryIndexMatch[],
        ftsTokens: readonly string[]
    ): ScoredMatch[] {
        const first = rows[0];
        if (first === undefined) {
            return [];
        }

        let minRank = first.rank;
        let maxRank = first.rank;
        for (const row of rows.slice(1)) {
            if (row.rank < minRank) {
                minRank = row.rank;
            }
            if (row.rank > maxRank) {
                maxRank = row.rank;
            }
        }
        const rankSpan = maxRank - minRank;
        const coverageTokens = ftsTokens
            .map(token => token.replace(/^"|"$/g, "").toLowerCase())
            .filter(Boolean);
        const tokenCount = coverageTokens.length;
        const scored = rows.map(row => {
            const bm25Norm = rankSpan === 0
                ? 1
                : (maxRank - row.rank) / rankSpan;
            const lowerText = row.text.toLowerCase();
            const coverage = tokenCount === 0
                ? 1
                : coverageTokens.filter(token => lowerText.includes(token)).length
                    / tokenCount;
            return {
                ...row,
                score: 0.6 * bm25Norm + 0.4 * coverage
            };
        });
        scored.sort((left, right) => right.score - left.score);
        return scored;
    }

    private async discoverIndexedPaths(
        maxFiles: number,
        options?: RebuildIndexOptions
    ): Promise<string[]> {
        const paths = new Set<string>();
        for (const file of this.indexedFiles) {
            await this.addRebuildCandidate(file, paths, options);
        }
        for (const prefix of this.indexedPrefixes) {
            await this.addRebuildCandidate(prefix, paths, options);
        }
        return sortMemoryIndexPaths([...paths], this.pathPolicy)
            .slice(0, maxFiles);
    }

    private async addRebuildCandidate(
        candidate: string,
        paths: Set<string>,
        options?: RebuildIndexOptions
    ): Promise<void> {
        const normalized = normalizeMemoryPath(candidate);
        if (!normalized || this.isRebuildExcluded(normalized)) {
            return;
        }

        let entry: FileEntry;
        try {
            entry = await this.files.stat(this.context, FilePath.parse(normalized));
        } catch (error) {
            if (!(error instanceof Error)) {
                throw error;
            }
            this.handleRebuildError(
                error,
                { operation: "candidate-stat", path: normalized },
                options
            );
            return;
        }

        if (entry.kind === FileKind.file) {
            if (this.isRebuildEligiblePath(normalized)) {
                paths.add(normalized);
            }
            return;
        }
        if (entry.kind !== FileKind.directory) {
            return;
        }

        await this.walkDirectory(
            FilePath.parse(normalized),
            0,
            paths,
            { count: 0 },
            options
        );
    }

    private async walkDirectory(
        directory: FilePath,
        depth: number,
        paths: Set<string>,
        state: { count: number },
        options?: RebuildIndexOptions
    ): Promise<void> {
        if (
            depth >= REBUILD_WALK_MAX_DEPTH
            || state.count >= REBUILD_WALK_MAX_ENTRIES
        ) {
            return;
        }

        let entries: readonly FileEntry[];
        try {
            entries = await this.listDirectory(directory.toString());
        } catch (error) {
            if (!(error instanceof Error)) {
                throw error;
            }
            this.handleRebuildError(
                error,
                { operation: "candidate-list", path: directory.toString() },
                options
            );
            return;
        }

        for (const entry of entries) {
            if (state.count >= REBUILD_WALK_MAX_ENTRIES) {
                return;
            }
            state.count += 1;
            const path = entry.path.toString();
            if (this.isRebuildExcluded(path)) {
                continue;
            }
            if (entry.kind === FileKind.file) {
                if (this.isRebuildEligiblePath(path)) {
                    paths.add(path);
                }
            } else if (entry.kind === FileKind.directory) {
                await this.walkDirectory(
                    entry.path,
                    depth + 1,
                    paths,
                    state,
                    options
                );
            }
        }
    }

    private isRebuildEligiblePath(path: string): boolean {
        return isIndexableMemoryFile(path, this.pathPolicy);
    }

    private isRebuildExcluded(path: string): boolean {
        return isExcludedMemoryPath(path, this.pathPolicy);
    }

    private async pruneExistingPath(
        path: string,
        maxBytesPerFile: number,
        existingPathSet: Set<string>,
        options?: RebuildIndexOptions
    ): Promise<RebuildPathResult> {
        if (this.isRebuildEligiblePath(path)) {
            try {
                const entry = await this.files.stat(
                    this.context,
                    FilePath.parse(path)
                );
                if (
                    entry.kind === FileKind.file
                    && entry.size <= maxBytesPerFile
                ) {
                    return { indexed: 0, pruned: 0, skipped: 0 };
                }
            } catch (error) {
                if (!(error instanceof Error)) {
                    throw error;
                }
                this.handleRebuildError(
                    error,
                    { operation: "prune-stat", path },
                    options
                );
            }
        }
        this.removeIndex(path);
        existingPathSet.delete(path);
        return { indexed: 0, pruned: 1, skipped: 0 };
    }

    private async rebuildPath(
        path: string,
        maxBytesPerFile: number,
        pruneMissing: boolean,
        existingPathSet: Set<string>,
        options?: RebuildIndexOptions
    ): Promise<RebuildPathResult> {
        let entry: FileEntry;
        try {
            entry = await this.files.stat(this.context, FilePath.parse(path));
        } catch (error) {
            if (!(error instanceof Error)) {
                throw error;
            }
            this.handleRebuildError(
                error,
                { operation: "path-stat", path },
                options
            );
            return { indexed: 0, pruned: 0, skipped: 1 };
        }

        if (entry.kind !== FileKind.file || entry.size > maxBytesPerFile) {
            return this.skipPath(path, pruneMissing, existingPathSet);
        }

        let content: string;
        try {
            content = await this.readText(path);
        } catch (error) {
            if (!(error instanceof Error)) {
                throw error;
            }
            this.handleRebuildError(
                error,
                { operation: "path-read", path },
                options
            );
            return this.skipPath(path, pruneMissing, existingPathSet);
        }

        const current = await this.indexFileIfCurrentQuiet(
            path,
            content,
            options
        );
        return current
            ? { indexed: 1, pruned: 0, skipped: 0 }
            : { indexed: 0, pruned: 0, skipped: 1 };
    }

    private async indexFileIfCurrentQuiet(
        path: string,
        content: string,
        options?: RebuildIndexOptions
    ): Promise<boolean> {
        try {
            return await this.indexFileIfCurrent(path, content);
        } catch (error) {
            if (!(error instanceof Error)) {
                throw error;
            }
            this.handleRebuildError(
                error,
                { operation: "path-current-check", path },
                options
            );
            return false;
        }
    }

    private skipPath(
        path: string,
        pruneMissing: boolean,
        existingPathSet: Set<string>
    ): RebuildPathResult {
        if (pruneMissing && existingPathSet.has(path)) {
            this.removeIndex(path);
            existingPathSet.delete(path);
            return { indexed: 0, pruned: 1, skipped: 1 };
        }
        return { indexed: 0, pruned: 0, skipped: 1 };
    }

    private async mapBatches<Item, Result>(
        items: readonly Item[],
        concurrency: number,
        operation: (item: Item) => Promise<Result>
    ): Promise<Result[]> {
        const results: Result[] = [];
        for (let index = 0; index < items.length; index += concurrency) {
            results.push(...await Promise.all(
                items.slice(index, index + concurrency).map(operation)
            ));
        }
        return results;
    }

    private addResults(
        total: RebuildIndexResult,
        results: readonly RebuildPathResult[]
    ): void {
        for (const result of results) {
            total.indexed += result.indexed;
            total.pruned += result.pruned;
            total.skipped += result.skipped;
        }
    }

    private handleRebuildError(
        error: Error,
        context: RebuildErrorContext,
        options?: RebuildIndexOptions
    ): void {
        if (error instanceof Error && isNotFound(error)) {
            return;
        }
        options?.onError?.(error, context);
    }

    private async readText(path: string): Promise<string> {
        const content = await this.files.read(
            this.context,
            this.filePath(path),
            ReadRange.all()
        );
        return new TextDecoder().decode(content);
    }

    private async listDirectory(path: string): Promise<readonly FileEntry[]> {
        const directory = this.filePath(path);
        const entries: FileEntry[] = [];
        let position = ListPosition.first();

        while (true) {
            const page = await this.files.list(
                this.context,
                directory,
                position,
                LIST_PAGE_SIZE
            );
            entries.push(...page.entries);
            if (page.continuation.complete) {
                return entries;
            }
            position = page.continuation.next();
        }
    }

    private filePath(path: string): FilePath {
        return FilePath.parse(normalizeMemoryPath(path));
    }

    private get pathPolicy() {
        return {
            curatedFile: this.curatedFile,
            memoryDir: this.memoryDir,
            indexedPrefixes: this.indexedPrefixes,
            indexedFiles: this.indexedFiles
        };
    }
}

function isNotFound(error: Error): boolean {
    return error instanceof FileError && error.code === FileErrorCode.notFound;
}

function fileName(entry: FileEntry): string {
    const name = entry.path.parts().at(-1);
    if (name === undefined) {
        throw new TypeError("Filesystem root has no file name");
    }
    return name;
}

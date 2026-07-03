import {
    MemoryIndex,
    type MemoryIndexChunk,
    type MemoryIndexMatch
} from "../../facets/memory/memory-index";
import {
    TransactionalSqlite,
    type SqliteRow
} from "./sqlite";

export class SQLiteMemoryIndex extends MemoryIndex {
    public constructor(private readonly database: TransactionalSqlite) {
        super();
    }

    public initialize(): void {
        this.database.transaction(() => {
            this.database.run(
                `CREATE TABLE IF NOT EXISTS memory_chunks (
                    id TEXT PRIMARY KEY,
                    path TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    hash TEXT NOT NULL,
                    text TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                )`,
                []
            );
            this.database.run(
                "CREATE INDEX IF NOT EXISTS idx_mc_path ON memory_chunks(path)",
                []
            );
            this.database.run(
                `CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
                    text,
                    content='memory_chunks',
                    content_rowid='rowid'
                )`,
                []
            );
        });
    }

    public replaceFile(
        path: string,
        chunks: readonly MemoryIndexChunk[]
    ): void {
        this.database.transaction(() => {
            const existing = this.database.all(
                "SELECT id, hash FROM memory_chunks WHERE path = ?",
                [path]
            );
            const hashes = new Map(
                existing.map(row => [text(row, "id"), text(row, "hash")])
            );
            const retained = new Set<string>();
            const updatedAt = Date.now();

            for (const chunk of chunks) {
                const id = `${path}:${chunk.startLine}-${chunk.endLine}`;
                retained.add(id);
                if (hashes.get(id) === chunk.hash) {
                    continue;
                }

                this.deleteSearchRow(id);
                this.database.run(
                    `INSERT OR REPLACE INTO memory_chunks
                     (id, path, start_line, end_line, hash, text, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        id,
                        path,
                        chunk.startLine,
                        chunk.endLine,
                        chunk.hash,
                        chunk.text,
                        updatedAt
                    ]
                );
                this.database.run(
                    `INSERT INTO memory_chunks_fts (rowid, text)
                     SELECT rowid, text FROM memory_chunks WHERE id = ?`,
                    [id]
                );
            }

            for (const id of hashes.keys()) {
                if (!retained.has(id)) {
                    this.deleteSearchRow(id);
                    this.database.run(
                        "DELETE FROM memory_chunks WHERE id = ?",
                        [id]
                    );
                }
            }
        });
    }

    public removePath(path: string): void {
        const childPrefix = `${path}/`;
        this.database.transaction(() => {
            this.database.run(
                `DELETE FROM memory_chunks_fts
                 WHERE rowid IN (
                     SELECT rowid FROM memory_chunks
                     WHERE path = ? OR substr(path, 1, ?) = ?
                 )`,
                [path, childPrefix.length, childPrefix]
            );
            this.database.run(
                `DELETE FROM memory_chunks
                 WHERE path = ? OR substr(path, 1, ?) = ?`,
                [path, childPrefix.length, childPrefix]
            );
        });
    }

    public indexedPaths(): readonly string[] {
        return this.database
            .all("SELECT DISTINCT path FROM memory_chunks", [])
            .map(row => text(row, "path"));
    }

    public search(query: string, limit: number): readonly MemoryIndexMatch[] {
        return this.database.all(
            `SELECT mc.id, mc.path, mc.start_line, mc.end_line, mc.text,
                    bm25(memory_chunks_fts) AS rank
             FROM memory_chunks_fts
             JOIN memory_chunks mc ON mc.rowid = memory_chunks_fts.rowid
             WHERE memory_chunks_fts MATCH ?
             ORDER BY rank ASC
             LIMIT ?`,
            [query, limit]
        ).map(match);
    }

    private deleteSearchRow(id: string): void {
        this.database.run(
            `DELETE FROM memory_chunks_fts
             WHERE rowid IN (SELECT rowid FROM memory_chunks WHERE id = ?)`,
            [id]
        );
    }
}

function match(row: SqliteRow): MemoryIndexMatch {
    return {
        id: text(row, "id"),
        path: text(row, "path"),
        startLine: integer(row, "start_line"),
        endLine: integer(row, "end_line"),
        text: text(row, "text"),
        rank: number(row, "rank")
    };
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string") {
        throw new TypeError(`Expected string column: ${column}`);
    }
    return value;
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TypeError(`Expected safe integer column: ${column}`);
    }
    return value;
}

function number(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`Expected finite number column: ${column}`);
    }
    return value;
}

import type { OperationContext } from "../../operations/context";
import { Durability } from "../../facets/filesystem/durability";
import { FileEntry, FileKind } from "../../facets/filesystem/entry";
import { FileError, FileErrorCode, FileOperation } from "../../facets/filesystem/error";
import { SyncFileSystem } from "../../facets/filesystem/filesystem";
import { ReplaceMode } from "../../facets/filesystem/move";
import {
    FilePage,
    ListPosition,
    PageContinuation,
    PageCursor
} from "../../facets/filesystem/page";
import { FilePath } from "../../facets/filesystem/path";
import { ReadRange } from "../../facets/filesystem/range";
import { MutationReceipt } from "../../facets/filesystem/receipt";
import { TreeMode } from "../../facets/filesystem/tree";
import { WriteMode } from "../../facets/filesystem/write";
import { TransactionalSqlite, type SqliteRow } from "./sqlite";

const chunkSize = 1_800_000;

class StoredNode {
    public constructor(
        public readonly path: FilePath,
        public readonly kind: FileKind,
        public readonly size: number,
        public readonly modifiedAt: string
    ) {
    }

    public entry(path: FilePath = this.path): FileEntry {
        return new FileEntry(path, this.kind, this.size, this.modifiedAt);
    }

    public requireDirectory(operation: FileOperation): void {
        if (this.kind !== FileKind.directory) {
            throw error(
                FileErrorCode.notDirectory,
                operation,
                this.path,
                "Path is not a directory"
            );
        }
    }

    public requireFile(operation: FileOperation): void {
        if (this.kind !== FileKind.file) {
            throw error(
                FileErrorCode.isDirectory,
                operation,
                this.path,
                "Path is a directory"
            );
        }
    }
}

export class SqliteFileSystem extends SyncFileSystem {
    public constructor(
        private readonly database: TransactionalSqlite,
        private readonly namespace: string,
        private readonly completion: Durability
    ) {
        super();

        if (namespace.length === 0) {
            throw new TypeError("Filesystem namespace must not be empty");
        }

        this.initialize();
    }

    public stat(_context: OperationContext, path: FilePath): FileEntry {
        return this.node(path, FileOperation.stat).entry();
    }

    public read(
        _context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Uint8Array {
        const node = this.node(path, FileOperation.read);
        node.requireFile(FileOperation.read);
        const rows = this.database.all(
            `SELECT data FROM agent_core_fs_chunks
             WHERE namespace = ? AND path = ?
             ORDER BY chunk_index`,
            [this.namespace, path.toString()]
        );
        const chunks = rows.map(row => bytes(row, "data"));
        const content = new Uint8Array(
            chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
        );
        let offset = 0;

        for (const chunk of chunks) {
            content.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return range.read(content);
    }

    public write(
        context: OperationContext,
        path: FilePath,
        content: Uint8Array,
        mode: WriteMode,
        durability: Durability
    ): MutationReceipt {
        this.requireCompletion(durability, path, FileOperation.write);
        this.requireNonRoot(path, FileOperation.write);

        this.database.transaction(() => {
            this.node(path.parent(), FileOperation.write).requireDirectory(
                FileOperation.write
            );
            const existing = this.find(path);
            mode.validate(path, existing !== null);

            if (existing !== null) {
                existing.requireFile(FileOperation.write);
            }

            this.database.run(
                `DELETE FROM agent_core_fs_chunks
                 WHERE namespace = ? AND path = ?`,
                [this.namespace, path.toString()]
            );
            this.upsertNode(
                new StoredNode(
                    path,
                    FileKind.file,
                    content.byteLength,
                    now()
                )
            );
            this.writeChunks(path, content);
            this.incrementRevision();
        });

        return this.receipt(context);
    }

    public list(
        _context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): FilePage {
        positive(limit, "List limit");
        this.node(path, FileOperation.list).requireDirectory(FileOperation.list);
        const revision = this.revision();
        const rows = this.database.all(
            `SELECT path, kind, size, modified_at
             FROM agent_core_fs_nodes
             WHERE namespace = ? AND parent_path = ? AND path <> ?
             ORDER BY path COLLATE BINARY`,
            [this.namespace, path.toString(), path.toString()]
        );
        const entries = rows.map(row => node(row).entry());
        const paths = entries.map(entry => entry.path.toString());
        const start = position.offset(path, revision, paths);
        const selected = entries.slice(start, start + limit);
        const end = start + selected.length;

        if (end >= entries.length) {
            return new FilePage(selected, PageContinuation.done());
        }

        const last = selected.at(-1);

        if (last === undefined) {
            throw new RangeError("A nonterminal page must contain an entry");
        }

        return new FilePage(
            selected,
            PageContinuation.more(
                new PageCursor(path.toString(), revision, last.path.toString())
            )
        );
    }

    public makeDirectory(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt {
        this.database.transaction(() => {
            const created = mode.create(path, current =>
                this.createDirectory(current)
            );

            if (created) {
                this.incrementRevision();
            }

            return created;
        });

        return this.receipt(context);
    }

    public remove(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt {
        this.requireNonRoot(path, FileOperation.remove);

        this.database.transaction(() => {
            const target = this.node(path, FileOperation.remove);
            const descendants = this.descendants(path);

            if (target.kind === FileKind.directory) {
                mode.allowChildren(
                    path,
                    FileOperation.remove,
                    descendants.length
                );
            }

            this.delete(path, descendants);
            this.incrementRevision();
        });

        return this.receipt(context);
    }

    public move(
        context: OperationContext,
        source: FilePath,
        destination: FilePath,
        mode: ReplaceMode
    ): MutationReceipt {
        this.requireNonRoot(source, FileOperation.move);
        this.requireNonRoot(destination, FileOperation.move);

        this.database.transaction(() => {
            const sourceNode = this.node(source, FileOperation.move);

            if (source.equals(destination)) {
                return;
            }

            if (source.startsWith(destination)) {
                throw error(
                    FileErrorCode.invalidPath,
                    FileOperation.move,
                    destination,
                    "Cannot replace an ancestor of the source"
                );
            }

            if (
                sourceNode.kind === FileKind.directory &&
                destination.startsWith(source)
            ) {
                throw error(
                    FileErrorCode.invalidPath,
                    FileOperation.move,
                    destination,
                    "Cannot move a directory into itself"
                );
            }

            this.node(destination.parent(), FileOperation.move).requireDirectory(
                FileOperation.move
            );
            const destinationNode = this.find(destination);
            mode.validate(destination, destinationNode !== null);

            if (destinationNode !== null) {
                this.validateReplacement(sourceNode, destinationNode);
                const descendants = this.descendants(destination);

                if (
                    destinationNode.kind === FileKind.directory &&
                    descendants.length > 0
                ) {
                    throw error(
                        FileErrorCode.directoryNotEmpty,
                        FileOperation.move,
                        destination,
                        "Destination directory is not empty"
                    );
                }

                mode.remove(() => this.delete(destination, descendants));
            }

            this.moveTree(source, destination);
            this.incrementRevision();
        });

        return this.receipt(context);
    }

    public flush(context: OperationContext): MutationReceipt {
        if (!this.completion.satisfies(Durability.durable)) {
            throw error(
                FileErrorCode.unsupported,
                FileOperation.flush,
                FilePath.root(),
                "SQLite adapter does not provide durable flush"
            );
        }

        return this.receipt(context);
    }

    private initialize(): void {
        this.database.transaction(() => {
            this.database.run(
                `CREATE TABLE IF NOT EXISTS agent_core_fs_nodes (
                    namespace TEXT NOT NULL,
                    path TEXT NOT NULL,
                    parent_path TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    modified_at TEXT NOT NULL,
                    PRIMARY KEY (namespace, path)
                )`,
                []
            );
            this.database.run(
                `CREATE INDEX IF NOT EXISTS agent_core_fs_parent
                 ON agent_core_fs_nodes (namespace, parent_path, path)`,
                []
            );
            this.database.run(
                `CREATE TABLE IF NOT EXISTS agent_core_fs_chunks (
                    namespace TEXT NOT NULL,
                    path TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    data BLOB NOT NULL,
                    PRIMARY KEY (namespace, path, chunk_index)
                )`,
                []
            );
            this.database.run(
                `CREATE TABLE IF NOT EXISTS agent_core_fs_state (
                    namespace TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL
                )`,
                []
            );
            this.database.run(
                `INSERT OR IGNORE INTO agent_core_fs_state (namespace, revision)
                 VALUES (?, 0)`,
                [this.namespace]
            );
            this.database.run(
                `INSERT OR IGNORE INTO agent_core_fs_nodes
                 (namespace, path, parent_path, kind, size, modified_at)
                 VALUES (?, '', '', 'directory', 0, ?)`,
                [this.namespace, now()]
            );
        });
    }

    private find(path: FilePath): StoredNode | null {
        const rows = this.database.all(
            `SELECT path, kind, size, modified_at
             FROM agent_core_fs_nodes
             WHERE namespace = ? AND path = ?`,
            [this.namespace, path.toString()]
        );
        const row = rows[0];
        return row === undefined ? null : node(row);
    }

    private node(path: FilePath, operation: FileOperation): StoredNode {
        const found = this.find(path);

        if (found === null) {
            throw error(
                FileErrorCode.notFound,
                operation,
                path,
                "Path does not exist"
            );
        }

        return found;
    }

    private createDirectory(path: FilePath): boolean {
        const existing = this.find(path);

        if (existing !== null) {
            existing.requireDirectory(FileOperation.makeDirectory);
            return false;
        }

        this.node(path.parent(), FileOperation.makeDirectory).requireDirectory(
            FileOperation.makeDirectory
        );
        this.upsertNode(
            new StoredNode(path, FileKind.directory, 0, now())
        );
        return true;
    }

    private upsertNode(value: StoredNode): void {
        this.database.run(
            `INSERT INTO agent_core_fs_nodes
             (namespace, path, parent_path, kind, size, modified_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(namespace, path) DO UPDATE SET
                parent_path = excluded.parent_path,
                kind = excluded.kind,
                size = excluded.size,
                modified_at = excluded.modified_at`,
            [
                this.namespace,
                value.path.toString(),
                value.path.parent().toString(),
                value.kind.name,
                value.size,
                value.modifiedAt
            ]
        );
    }

    private writeChunks(path: FilePath, content: Uint8Array): void {
        const chunks = Math.max(1, Math.ceil(content.byteLength / chunkSize));

        for (let index = 0; index < chunks; index += 1) {
            this.database.run(
                `INSERT INTO agent_core_fs_chunks
                 (namespace, path, chunk_index, data)
                 VALUES (?, ?, ?, ?)`,
                [
                    this.namespace,
                    path.toString(),
                    index,
                    content.slice(index * chunkSize, (index + 1) * chunkSize)
                ]
            );
        }
    }

    private descendants(path: FilePath): readonly StoredNode[] {
        const prefix = `${path.toString()}/`;
        return this.database.all(
            `SELECT path, kind, size, modified_at
             FROM agent_core_fs_nodes
             WHERE namespace = ?
               AND substr(path, 1, ?) = ?
             ORDER BY length(path), path COLLATE BINARY`,
            [this.namespace, prefix.length, prefix]
        ).map(row => node(row));
    }

    private delete(
        path: FilePath,
        descendants: readonly StoredNode[]
    ): void {
        for (const item of descendants) {
            this.deletePath(item.path);
        }

        this.deletePath(path);
    }

    private deletePath(path: FilePath): void {
        this.database.run(
            `DELETE FROM agent_core_fs_chunks
             WHERE namespace = ? AND path = ?`,
            [this.namespace, path.toString()]
        );
        this.database.run(
            `DELETE FROM agent_core_fs_nodes
             WHERE namespace = ? AND path = ?`,
            [this.namespace, path.toString()]
        );
    }

    private moveTree(source: FilePath, destination: FilePath): void {
        const nodes = [
            this.node(source, FileOperation.move),
            ...this.descendants(source)
        ];

        for (const sourceNode of nodes) {
            const relative = sourceNode.path.relativeTo(source);
            const targetPath = destination.append(relative);
            this.upsertNode(
                new StoredNode(
                    targetPath,
                    sourceNode.kind,
                    sourceNode.size,
                    sourceNode.modifiedAt
                )
            );
            const chunks = this.database.all(
                `SELECT chunk_index, data
                 FROM agent_core_fs_chunks
                 WHERE namespace = ? AND path = ?
                 ORDER BY chunk_index`,
                [this.namespace, sourceNode.path.toString()]
            );

            for (const chunk of chunks) {
                this.database.run(
                    `INSERT INTO agent_core_fs_chunks
                     (namespace, path, chunk_index, data)
                     VALUES (?, ?, ?, ?)`,
                    [
                        this.namespace,
                        targetPath.toString(),
                        integer(chunk, "chunk_index"),
                        bytes(chunk, "data")
                    ]
                );
            }
        }

        for (const sourceNode of nodes.reverse()) {
            this.deletePath(sourceNode.path);
        }
    }

    private validateReplacement(source: StoredNode, destination: StoredNode): void {
        if (source.kind === destination.kind) {
            return;
        }

        throw error(
            destination.kind === FileKind.directory
                ? FileErrorCode.isDirectory
                : FileErrorCode.notDirectory,
            FileOperation.move,
            destination.path,
            "Source and destination kinds differ"
        );
    }

    private revision(): number {
        const row = this.database.all(
            `SELECT revision FROM agent_core_fs_state WHERE namespace = ?`,
            [this.namespace]
        )[0];

        if (row === undefined) {
            throw new Error("Filesystem revision row is missing");
        }

        return integer(row, "revision");
    }

    private incrementRevision(): void {
        this.database.run(
            `UPDATE agent_core_fs_state
             SET revision = revision + 1
             WHERE namespace = ?`,
            [this.namespace]
        );
    }

    private requireCompletion(
        required: Durability,
        path: FilePath,
        operation: FileOperation
    ): void {
        if (!this.completion.satisfies(required)) {
            throw error(
                FileErrorCode.unsupported,
                operation,
                path,
                `SQLite adapter provides ${this.completion.name} completion`
            );
        }
    }

    private requireNonRoot(path: FilePath, operation: FileOperation): void {
        if (path.root) {
            throw error(
                FileErrorCode.invalidPath,
                operation,
                path,
                "The filesystem root cannot be mutated by this operation"
            );
        }
    }

    private receipt(context: OperationContext): MutationReceipt {
        return new MutationReceipt(context.id, this.completion);
    }
}

function node(row: SqliteRow): StoredNode {
    return new StoredNode(
        FilePath.parse(text(row, "path")),
        kind(row),
        integer(row, "size"),
        text(row, "modified_at")
    );
}

function kind(row: SqliteRow): FileKind {
    const value = text(row, "kind");

    if (value === FileKind.file.name) {
        return FileKind.file;
    }

    if (value === FileKind.directory.name) {
        return FileKind.directory;
    }

    throw new TypeError(`Invalid filesystem kind: ${value}`);
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

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];

    if (!(value instanceof Uint8Array)) {
        throw new TypeError(`Expected bytes column: ${column}`);
    }

    return value;
}

function positive(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
    }
}

function now(): string {
    return new Date().toISOString();
}

function error(
    code: FileErrorCode,
    operation: FileOperation,
    path: FilePath,
    message: string
): FileError {
    return new FileError(code, operation, path, message);
}

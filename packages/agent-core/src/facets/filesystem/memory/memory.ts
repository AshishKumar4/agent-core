import type { OperationContext } from "../../../operations/context";
import { Durability } from "../durability";
import { FileEntry, FileKind } from "../entry";
import { FileError, FileErrorCode, FileOperation } from "../error";
import { SyncFileSystem } from "../filesystem";
import { ReplaceMode } from "../move";
import {
    FilePage,
    ListPosition,
    PageContinuation,
    PageCursor
} from "../page";
import { FilePath } from "../path";
import { ReadRange } from "../range";
import { MutationReceipt } from "../receipt";
import { TreeMode } from "../tree";
import { WriteMode } from "../write";

abstract class MemoryNode {
    protected constructor(public readonly modifiedAt: number) {
    }

    public abstract get kind(): FileKind;

    public abstract get size(): number;

    public abstract read(path: FilePath, range: ReadRange): Uint8Array;

    public abstract requireDirectory(
        path: FilePath,
        operation: FileOperation
    ): void;

    public abstract requireFileTarget(path: FilePath): void;

    public abstract validateRemoval(
        path: FilePath,
        descendants: number,
        mode: TreeMode
    ): void;

    public abstract validateDestination(
        path: FilePath,
        destination: MemoryNode
    ): void;

    public abstract validateMove(source: FilePath, destination: FilePath): void;
}

class MemoryFile extends MemoryNode {
    public constructor(
        public readonly content: Uint8Array,
        modifiedAt: number
    ) {
        super(modifiedAt);
    }

    public get kind(): FileKind {
        return FileKind.file;
    }

    public get size(): number {
        return this.content.byteLength;
    }

    public read(_path: FilePath, range: ReadRange): Uint8Array {
        return range.read(this.content);
    }

    public requireDirectory(path: FilePath, operation: FileOperation): void {
        throw fileError(
            FileErrorCode.notDirectory,
            operation,
            path,
            "Path is not a directory"
        );
    }

    public requireFileTarget(_path: FilePath): void {
    }

    public validateRemoval(
        _path: FilePath,
        _descendants: number,
        _mode: TreeMode
    ): void {
    }

    public validateDestination(
        path: FilePath,
        destination: MemoryNode
    ): void {
        if (destination.kind !== FileKind.file) {
            throw fileError(
                FileErrorCode.isDirectory,
                FileOperation.move,
                path,
                "Cannot replace a directory with a file"
            );
        }
    }

    public validateMove(_source: FilePath, _destination: FilePath): void {
    }
}

class MemoryDirectory extends MemoryNode {
    public constructor(modifiedAt: number) {
        super(modifiedAt);
    }

    public get kind(): FileKind {
        return FileKind.directory;
    }

    public get size(): number {
        return 0;
    }

    public read(path: FilePath, _range: ReadRange): Uint8Array {
        throw fileError(
            FileErrorCode.isDirectory,
            FileOperation.read,
            path,
            "Cannot read a directory"
        );
    }

    public requireDirectory(_path: FilePath, _operation: FileOperation): void {
    }

    public requireFileTarget(path: FilePath): void {
        throw fileError(
            FileErrorCode.isDirectory,
            FileOperation.write,
            path,
            "Cannot replace a directory with a file"
        );
    }

    public validateRemoval(
        path: FilePath,
        descendants: number,
        mode: TreeMode
    ): void {
        mode.allowChildren(path, FileOperation.remove, descendants);
    }

    public validateDestination(
        path: FilePath,
        destination: MemoryNode
    ): void {
        if (destination.kind !== FileKind.directory) {
            throw fileError(
                FileErrorCode.notDirectory,
                FileOperation.move,
                path,
                "Cannot replace a file with a directory"
            );
        }
    }

    public validateMove(source: FilePath, destination: FilePath): void {
        if (destination.startsWith(source)) {
            throw fileError(
                FileErrorCode.invalidPath,
                FileOperation.move,
                destination,
                "Cannot move a directory into itself"
            );
        }
    }
}

export class MemoryFileSystem extends SyncFileSystem {
    readonly #nodes = new Map<string, MemoryNode>();
    #revision = 0;

    public constructor() {
        super();
        this.#nodes.set("", new MemoryDirectory(this.now()));
    }

    public stat(_context: OperationContext, path: FilePath): FileEntry {
        return this.entry(path, this.node(path, FileOperation.stat));
    }

    public read(
        _context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Uint8Array {
        return this.node(path, FileOperation.read).read(path, range);
    }

    public write(
        context: OperationContext,
        path: FilePath,
        content: Uint8Array,
        mode: WriteMode,
        durability: Durability
    ): MutationReceipt {
        this.requireAccepted(durability, path, FileOperation.write);
        this.requireNonRoot(path, FileOperation.write);
        this.directory(path.parent(), FileOperation.write);

        const existing = this.#nodes.get(path.toString());
        mode.validate(path, existing !== undefined);
        existing?.requireFileTarget(path);

        this.#nodes.set(
            path.toString(),
            new MemoryFile(content.slice(), this.now())
        );
        this.changed();

        return this.receipt(context);
    }

    public list(
        _context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): FilePage {
        this.positive(limit, "List limit");
        this.directory(path, FileOperation.list);

        const prefix = path.root ? "" : `${path.toString()}/`;
        const entries = [...this.#nodes.entries()]
            .filter(([key]) => key.startsWith(prefix) && key !== prefix)
            .filter(([key]) => !key.slice(prefix.length).includes("/"))
            .map(([key, node]) => this.entry(FilePath.parse(key), node))
            .sort((left, right) => compare(left.path.toString(), right.path.toString()));
        const paths = entries.map(entry => entry.path.toString());
        const start = position.offset(path, this.#revision, paths);
        const page = entries.slice(start, start + limit);
        const end = start + page.length;
        if (end >= entries.length) {
            return new FilePage(page, PageContinuation.done());
        }

        const last = page.at(-1);

        if (last === undefined) {
            throw new RangeError("A nonterminal page must contain an entry");
        }

        return new FilePage(
            page,
            PageContinuation.more(
                new PageCursor(
                    path.toString(),
                    this.#revision,
                    last.path.toString()
                )
            )
        );
    }

    public makeDirectory(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt {
        if (path.root) {
            return this.receipt(context);
        }

        const changed = mode.create(path, directory =>
            this.createDirectory(directory)
        );

        if (changed) {
            this.changed();
        }

        return this.receipt(context);
    }

    public remove(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt {
        this.requireNonRoot(path, FileOperation.remove);

        const node = this.node(path, FileOperation.remove);
        const descendants = this.descendants(path);
        node.validateRemoval(path, descendants.length, mode);

        this.delete(path, descendants);
        this.changed();
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

        const sourceNode = this.node(source, FileOperation.move);

        if (source.equals(destination)) {
            return this.receipt(context);
        }

        if (source.startsWith(destination)) {
            throw fileError(
                FileErrorCode.invalidPath,
                FileOperation.move,
                destination,
                "Cannot replace an ancestor of the source"
            );
        }

        sourceNode.validateMove(source, destination);
        this.directory(destination.parent(), FileOperation.move);

        const destinationNode = this.#nodes.get(destination.toString());
        mode.validate(destination, destinationNode !== undefined);

        if (destinationNode !== undefined) {
            sourceNode.validateDestination(destination, destinationNode);
            destinationNode.validateRemoval(
                destination,
                this.descendants(destination).length,
                TreeMode.node
            );
            mode.remove(() => this.deleteTree(destination));
        }

        this.moveTree(source, destination);
        this.changed();
        return this.receipt(context);
    }

    public flush(_context: OperationContext): MutationReceipt {
        throw fileError(
            FileErrorCode.unsupported,
            FileOperation.flush,
            FilePath.root(),
            "Memory filesystems do not provide durable storage"
        );
    }

    private node(path: FilePath, operation: FileOperation): MemoryNode {
        const node = this.#nodes.get(path.toString());

        if (node === undefined) {
            throw fileError(
                FileErrorCode.notFound,
                operation,
                path,
                "Path does not exist"
            );
        }

        return node;
    }

    private directory(path: FilePath, operation: FileOperation): void {
        this.node(path, operation).requireDirectory(path, operation);
    }

    private createDirectory(path: FilePath): boolean {
        this.directory(path.parent(), FileOperation.makeDirectory);
        const existing = this.#nodes.get(path.toString());

        if (existing !== undefined) {
            existing.requireDirectory(path, FileOperation.makeDirectory);
            return false;
        }

        this.#nodes.set(path.toString(), new MemoryDirectory(this.now()));
        return true;
    }

    private descendants(path: FilePath): string[] {
        const prefix = `${path.toString()}/`;
        return [...this.#nodes.keys()].filter(key => key.startsWith(prefix));
    }

    private delete(path: FilePath, descendants: readonly string[]): void {
        for (const descendant of descendants) {
            this.#nodes.delete(descendant);
        }

        this.#nodes.delete(path.toString());
    }

    private deleteTree(path: FilePath): void {
        this.delete(path, this.descendants(path));
    }

    private moveTree(source: FilePath, destination: FilePath): void {
        const sourceKey = source.toString();
        const destinationKey = destination.toString();
        const moved = [sourceKey, ...this.descendants(source)];
        const nodes = moved.map(key => ({
            key,
            node: this.node(FilePath.parse(key), FileOperation.move)
        }));

        for (const item of nodes) {
            this.#nodes.set(
                `${destinationKey}${item.key.slice(sourceKey.length)}`,
                item.node
            );
        }

        for (const item of nodes) {
            this.#nodes.delete(item.key);
        }
    }

    private entry(path: FilePath, node: MemoryNode): FileEntry {
        return new FileEntry(
            path,
            node.kind,
            node.size,
            new Date(node.modifiedAt).toISOString()
        );
    }

    private requireAccepted(
        required: Durability,
        path: FilePath,
        operation: FileOperation
    ): void {
        if (!Durability.accepted.satisfies(required)) {
            throw fileError(
                FileErrorCode.unsupported,
                operation,
                path,
                "Memory filesystems support accepted completion only"
            );
        }
    }

    private requireNonRoot(path: FilePath, operation: FileOperation): void {
        if (path.root) {
            throw fileError(
                FileErrorCode.invalidPath,
                operation,
                path,
                "The filesystem root cannot be mutated by this operation"
            );
        }
    }

    private positive(value: number, name: string): void {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new TypeError(`${name} must be a positive safe integer`);
        }
    }

    private receipt(context: OperationContext): MutationReceipt {
        return new MutationReceipt(context.id, Durability.accepted);
    }

    private changed(): void {
        this.#revision += 1;
    }

    private now(): number {
        return Date.now();
    }
}

function fileError(
    code: FileErrorCode,
    operation: FileOperation,
    path: FilePath,
    message: string
): FileError {
    return new FileError(code, operation, path, message);
}

function compare(left: string, right: string): number {
    if (left < right) {
        return -1;
    }

    if (left > right) {
        return 1;
    }

    return 0;
}

import type { OperationContext } from "../../../operations/context";
import { FileError, FileErrorCode, FileOperation } from "../error";
import { FileSystem, SyncFileSystem } from "../filesystem";
import type { ReplaceMode } from "../move";
import type { FilePage, ListPosition } from "../page";
import { FilePath } from "../path";
import type { ReadRange } from "../range";
import type { MutationReceipt } from "../receipt";
import type { TreeMode } from "../tree";
import type { Durability } from "../durability";
import type { FileEntry } from "../entry";
import type { WriteMode } from "../write";

export class SyncReadOnlyFileSystem extends SyncFileSystem {
    public constructor(private readonly files: SyncFileSystem) {
        super();
    }

    public stat(context: OperationContext, path: FilePath): FileEntry {
        return this.files.stat(context, path);
    }

    public read(
        context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Uint8Array {
        return this.files.read(context, path, range);
    }

    public list(
        context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): FilePage {
        return this.files.list(context, path, position, limit);
    }

    public write(
        _context: OperationContext,
        path: FilePath,
        _content: Uint8Array,
        _mode: WriteMode,
        _durability: Durability
    ): MutationReceipt {
        throw readOnly(path, FileOperation.write);
    }

    public makeDirectory(
        _context: OperationContext,
        path: FilePath,
        _mode: TreeMode
    ): MutationReceipt {
        throw readOnly(path, FileOperation.makeDirectory);
    }

    public remove(
        _context: OperationContext,
        path: FilePath,
        _mode: TreeMode
    ): MutationReceipt {
        throw readOnly(path, FileOperation.remove);
    }

    public move(
        _context: OperationContext,
        source: FilePath,
        _destination: FilePath,
        _mode: ReplaceMode
    ): MutationReceipt {
        throw readOnly(source, FileOperation.move);
    }

    public flush(_context: OperationContext): MutationReceipt {
        throw readOnly(FilePath.root(), FileOperation.flush);
    }
}

export class ReadOnlyFileSystem extends FileSystem {
    public constructor(private readonly files: FileSystem) {
        super();
    }

    public stat(
        context: OperationContext,
        path: FilePath
    ): Promise<FileEntry> {
        return this.files.stat(context, path);
    }

    public read(
        context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Promise<Uint8Array> {
        return this.files.read(context, path, range);
    }

    public list(
        context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): Promise<FilePage> {
        return this.files.list(context, path, position, limit);
    }

    public async write(
        _context: OperationContext,
        path: FilePath,
        _content: Uint8Array,
        _mode: WriteMode,
        _durability: Durability
    ): Promise<MutationReceipt> {
        throw readOnly(path, FileOperation.write);
    }

    public async makeDirectory(
        _context: OperationContext,
        path: FilePath,
        _mode: TreeMode
    ): Promise<MutationReceipt> {
        throw readOnly(path, FileOperation.makeDirectory);
    }

    public async remove(
        _context: OperationContext,
        path: FilePath,
        _mode: TreeMode
    ): Promise<MutationReceipt> {
        throw readOnly(path, FileOperation.remove);
    }

    public async move(
        _context: OperationContext,
        source: FilePath,
        _destination: FilePath,
        _mode: ReplaceMode
    ): Promise<MutationReceipt> {
        throw readOnly(source, FileOperation.move);
    }

    public async flush(_context: OperationContext): Promise<MutationReceipt> {
        throw readOnly(FilePath.root(), FileOperation.flush);
    }
}

function readOnly(path: FilePath, operation: FileOperation): FileError {
    return new FileError(
        FileErrorCode.readOnly,
        operation,
        path,
        "Filesystem is read-only"
    );
}

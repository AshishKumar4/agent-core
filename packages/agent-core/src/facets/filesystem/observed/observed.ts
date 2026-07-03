import type { OperationContext } from "../../../operations/context";
import { observeOperation, observeOperationAsync } from "../../../operations";
import { ObservedOperation } from "../../../observability/telemetry";
import type { Durability } from "../durability";
import type { FileEntry } from "../entry";
import { FileError } from "../error";
import { FileSystem, SyncFileSystem } from "../filesystem";
import type { ReplaceMode } from "../move";
import type { FilePage, ListPosition } from "../page";
import type { FilePath } from "../path";
import type { ReadRange } from "../range";
import type { MutationReceipt } from "../receipt";
import type { TreeMode } from "../tree";
import type { WriteMode } from "../write";

const stat = operation("filesystem.stat");
const read = operation("filesystem.read");
const write = operation("filesystem.write");
const list = operation("filesystem.list");
const makeDirectory = operation("filesystem.make_directory");
const remove = operation("filesystem.remove");
const move = operation("filesystem.move");
const flush = operation("filesystem.flush");

export class ObservedSyncFileSystem extends SyncFileSystem {
    public constructor(private readonly files: SyncFileSystem) {
        super();
    }

    public stat(context: OperationContext, path: FilePath): FileEntry {
        return this.observe(context, stat, () => this.files.stat(context, path));
    }

    public read(
        context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Uint8Array {
        return this.observe(
            context,
            read,
            () => this.files.read(context, path, range)
        );
    }

    public write(
        context: OperationContext,
        path: FilePath,
        content: Uint8Array,
        mode: WriteMode,
        durability: Durability
    ): MutationReceipt {
        return this.observe(
            context,
            write,
            () => this.files.write(
                context,
                path,
                content,
                mode,
                durability
            )
        );
    }

    public list(
        context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): FilePage {
        return this.observe(
            context,
            list,
            () => this.files.list(context, path, position, limit)
        );
    }

    public makeDirectory(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt {
        return this.observe(
            context,
            makeDirectory,
            () => this.files.makeDirectory(context, path, mode)
        );
    }

    public remove(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt {
        return this.observe(
            context,
            remove,
            () => this.files.remove(context, path, mode)
        );
    }

    public move(
        context: OperationContext,
        source: FilePath,
        destination: FilePath,
        mode: ReplaceMode
    ): MutationReceipt {
        return this.observe(
            context,
            move,
            () => this.files.move(context, source, destination, mode)
        );
    }

    public flush(context: OperationContext): MutationReceipt {
        return this.observe(context, flush, () => this.files.flush(context));
    }

    private observe<Result>(
        context: OperationContext,
        operation: ObservedOperation,
        execute: () => Result
    ): Result {
        return observeOperation(context, operation, execute, fileFailureCode);
    }
}

export class ObservedFileSystem extends FileSystem {
    public constructor(private readonly files: FileSystem) {
        super();
    }

    public stat(
        context: OperationContext,
        path: FilePath
    ): Promise<FileEntry> {
        return this.observe(context, stat, () => this.files.stat(context, path));
    }

    public read(
        context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Promise<Uint8Array> {
        return this.observe(
            context,
            read,
            () => this.files.read(context, path, range)
        );
    }

    public write(
        context: OperationContext,
        path: FilePath,
        content: Uint8Array,
        mode: WriteMode,
        durability: Durability
    ): Promise<MutationReceipt> {
        return this.observe(
            context,
            write,
            () => this.files.write(
                context,
                path,
                content,
                mode,
                durability
            )
        );
    }

    public list(
        context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): Promise<FilePage> {
        return this.observe(
            context,
            list,
            () => this.files.list(context, path, position, limit)
        );
    }

    public makeDirectory(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): Promise<MutationReceipt> {
        return this.observe(
            context,
            makeDirectory,
            () => this.files.makeDirectory(context, path, mode)
        );
    }

    public remove(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): Promise<MutationReceipt> {
        return this.observe(
            context,
            remove,
            () => this.files.remove(context, path, mode)
        );
    }

    public move(
        context: OperationContext,
        source: FilePath,
        destination: FilePath,
        mode: ReplaceMode
    ): Promise<MutationReceipt> {
        return this.observe(
            context,
            move,
            () => this.files.move(context, source, destination, mode)
        );
    }

    public flush(context: OperationContext): Promise<MutationReceipt> {
        return this.observe(context, flush, () => this.files.flush(context));
    }

    private async observe<Result>(
        context: OperationContext,
        operation: ObservedOperation,
        execute: () => Promise<Result>
    ): Promise<Result> {
        return observeOperationAsync(context, operation, execute, fileFailureCode);
    }
}

function operation(name: string): ObservedOperation {
    return new ObservedOperation(name, []);
}

function fileFailureCode(error: unknown): string {
    return error instanceof FileError ? error.code : "internal";
}

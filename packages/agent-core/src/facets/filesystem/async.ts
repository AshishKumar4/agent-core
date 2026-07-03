import type { OperationContext } from "../../operations/context";
import type { Durability } from "./durability";
import type { FileEntry } from "./entry";
import { FileSystem, SyncFileSystem } from "./filesystem";
import type { ReplaceMode } from "./move";
import type { FilePage, ListPosition } from "./page";
import type { FilePath } from "./path";
import type { ReadRange } from "./range";
import type { MutationReceipt } from "./receipt";
import type { TreeMode } from "./tree";
import type { WriteMode } from "./write";

export class AsyncFileSystem extends FileSystem {
    public constructor(private readonly files: SyncFileSystem) {
        super();
    }

    public async stat(
        context: OperationContext,
        path: FilePath
    ): Promise<FileEntry> {
        return this.files.stat(context, path);
    }

    public async read(
        context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Promise<Uint8Array> {
        return this.files.read(context, path, range);
    }

    public async write(
        context: OperationContext,
        path: FilePath,
        content: Uint8Array,
        mode: WriteMode,
        durability: Durability
    ): Promise<MutationReceipt> {
        return this.files.write(context, path, content, mode, durability);
    }

    public async list(
        context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): Promise<FilePage> {
        return this.files.list(context, path, position, limit);
    }

    public async makeDirectory(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): Promise<MutationReceipt> {
        return this.files.makeDirectory(context, path, mode);
    }

    public async remove(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): Promise<MutationReceipt> {
        return this.files.remove(context, path, mode);
    }

    public async move(
        context: OperationContext,
        source: FilePath,
        destination: FilePath,
        mode: ReplaceMode
    ): Promise<MutationReceipt> {
        return this.files.move(context, source, destination, mode);
    }

    public async flush(context: OperationContext): Promise<MutationReceipt> {
        return this.files.flush(context);
    }
}

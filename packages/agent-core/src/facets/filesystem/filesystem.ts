import type { OperationContext } from "../../operations/context";
import type { Durability } from "./durability";
import type { FileEntry } from "./entry";
import type { FilePage, ListPosition } from "./page";
import type { FilePath } from "./path";
import type { ReadRange } from "./range";
import type { MutationReceipt } from "./receipt";
import type { ReplaceMode } from "./move";
import type { TreeMode } from "./tree";
import type { WriteMode } from "./write";

export abstract class SyncFileSystem {
    public abstract stat(context: OperationContext, path: FilePath): FileEntry;

    public abstract read(
        context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Uint8Array;

    public abstract write(
        context: OperationContext,
        path: FilePath,
        content: Uint8Array,
        mode: WriteMode,
        durability: Durability
    ): MutationReceipt;

    public abstract list(
        context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): FilePage;

    public abstract makeDirectory(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt;

    public abstract remove(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt;

    public abstract move(
        context: OperationContext,
        source: FilePath,
        destination: FilePath,
        mode: ReplaceMode
    ): MutationReceipt;

    public abstract flush(context: OperationContext): MutationReceipt;
}

export abstract class FileSystem {
    public abstract stat(
        context: OperationContext,
        path: FilePath
    ): Promise<FileEntry>;

    public abstract read(
        context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Promise<Uint8Array>;

    public abstract write(
        context: OperationContext,
        path: FilePath,
        content: Uint8Array,
        mode: WriteMode,
        durability: Durability
    ): Promise<MutationReceipt>;

    public abstract list(
        context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): Promise<FilePage>;

    public abstract makeDirectory(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): Promise<MutationReceipt>;

    public abstract remove(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): Promise<MutationReceipt>;

    public abstract move(
        context: OperationContext,
        source: FilePath,
        destination: FilePath,
        mode: ReplaceMode
    ): Promise<MutationReceipt>;

    public abstract flush(context: OperationContext): Promise<MutationReceipt>;
}

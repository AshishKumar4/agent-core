import type { OperationContext } from "../../../operations/context";
import { Durability } from "../durability";
import { FileEntry } from "../entry";
import { FileError, FileErrorCode, FileOperation } from "../error";
import { SyncFileSystem } from "../filesystem";
import type { ReplaceMode } from "../move";
import {
    FilePage,
    ListPosition,
    PageContinuation,
    PageCursor
} from "../page";
import { FilePath } from "../path";
import type { ReadRange } from "../range";
import { MutationReceipt } from "../receipt";
import type { TreeMode } from "../tree";
import type { WriteMode } from "../write";
import { Mount, MountTable } from "./table";

export class SyncMountedFileSystem extends SyncFileSystem {
    readonly #mounts: MountTable<SyncFileSystem>;
    #revision = 0;

    public constructor(
        private readonly root: SyncFileSystem,
        mounts: readonly Mount<SyncFileSystem>[]
    ) {
        super();
        this.#mounts = new MountTable(mounts);
    }

    public stat(context: OperationContext, path: FilePath): FileEntry {
        const mount = this.#mounts.rootEntry(path);

        if (mount !== undefined) {
            return mount;
        }

        const route = this.#mounts.route(path, this.root);
        return route.entry(route.target.stat(context, route.path));
    }

    public read(
        context: OperationContext,
        path: FilePath,
        range: ReadRange
    ): Uint8Array {
        const route = this.#mounts.route(path, this.root);
        return route.target.read(context, route.path, range);
    }

    public write(
        context: OperationContext,
        path: FilePath,
        content: Uint8Array,
        mode: WriteMode,
        durability: Durability
    ): MutationReceipt {
        const route = this.#mounts.route(path, this.root);
        const receipt = route.target.write(
            context,
            route.path,
            content,
            mode,
            durability
        );
        this.changed();
        return receipt;
    }

    public list(
        context: OperationContext,
        path: FilePath,
        position: ListPosition,
        limit: number
    ): FilePage {
        if (!path.root) {
            const route = this.#mounts.route(path, this.root);
            const page = route.target.list(context, route.path, position, limit);
            return new FilePage(
                page.entries.map(entry => route.entry(entry)),
                page.continuation
            );
        }

        const entries = this.rootEntries(context);
        return page(path, entries, position, limit, this.#revision);
    }

    public makeDirectory(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt {
        const route = this.#mounts.route(path, this.root);
        const receipt = route.target.makeDirectory(context, route.path, mode);
        this.changed();
        return receipt;
    }

    public remove(
        context: OperationContext,
        path: FilePath,
        mode: TreeMode
    ): MutationReceipt {
        const route = this.#mounts.route(path, this.root);
        const receipt = route.target.remove(context, route.path, mode);
        this.changed();
        return receipt;
    }

    public move(
        context: OperationContext,
        source: FilePath,
        destination: FilePath,
        mode: ReplaceMode
    ): MutationReceipt {
        const from = this.#mounts.route(source, this.root);
        const to = this.#mounts.route(destination, this.root);
        from.requireSameTarget(to, destination);
        const receipt = from.target.move(
            context,
            from.path,
            to.path,
            mode
        );
        this.changed();
        return receipt;
    }

    public flush(context: OperationContext): MutationReceipt {
        for (const target of this.#mounts.targets(this.root)) {
            const receipt = target.flush(context);

            if (!receipt.completion.satisfies(Durability.durable)) {
                throw new FileError(
                    FileErrorCode.unsupported,
                    FileOperation.flush,
                    FilePath.root(),
                    "Mounted filesystem did not provide durable completion"
                );
            }
        }

        return new MutationReceipt(context.id, Durability.durable);
    }

    private rootEntries(context: OperationContext): readonly FileEntry[] {
        const entries = new Map<string, FileEntry>();
        let position = ListPosition.first();

        while (true) {
            const current = this.root.list(context, FilePath.root(), position, 256);

            for (const entry of current.entries) {
                entries.set(entry.path.toString(), entry);
            }

            if (current.continuation.complete) {
                break;
            }

            position = current.continuation.next();
        }

        for (const entry of this.#mounts.rootEntries()) {
            entries.set(entry.path.toString(), entry);
        }

        return [...entries.values()].sort((left, right) =>
            compare(left.path.toString(), right.path.toString())
        );
    }

    private changed(): void {
        this.#revision += 1;
    }
}

function page(
    path: FilePath,
    entries: readonly FileEntry[],
    position: ListPosition,
    limit: number,
    revision: number
): FilePage {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TypeError("List limit must be a positive safe integer");
    }

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

function compare(left: string, right: string): number {
    if (left < right) {
        return -1;
    }

    if (left > right) {
        return 1;
    }

    return 0;
}

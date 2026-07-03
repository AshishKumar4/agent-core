import { FileError, FileErrorCode, FileOperation } from "../error";
import { FileEntry, FileKind } from "../entry";
import { FilePath } from "../path";

export class Mount<T> {
    public constructor(
        public readonly path: FilePath,
        public readonly target: T
    ) {
        if (path.root || !path.parent().root) {
            throw new TypeError("Mount paths must be direct children of the root");
        }
    }
}

export class MountTable<T> {
    readonly #mounts: ReadonlyMap<string, Mount<T>>;

    public constructor(mounts: readonly Mount<T>[]) {
        const entries = new Map<string, Mount<T>>();

        for (const mount of mounts) {
            const path = mount.path.toString();

            if (entries.has(path)) {
                throw new TypeError("Mount paths must be unique");
            }

            entries.set(path, mount);
        }

        this.#mounts = entries;
    }

    public route(path: FilePath, root: T): Route<T> {
        const first = path.first();

        if (first === null) {
            return new Route(root, FilePath.root(), path);
        }

        const mount = this.#mounts.get(first);

        if (mount === undefined) {
            return new Route(root, FilePath.root(), path);
        }

        return new Route(
            mount.target,
            mount.path,
            path.relativeTo(mount.path)
        );
    }

    public targets(root: T): readonly T[] {
        return [...new Set([root, ...[...this.#mounts.values()].map(mount => mount.target)])];
    }

    public rootEntries(): readonly FileEntry[] {
        return [...this.#mounts.values()]
            .map(mount => new FileEntry(
                mount.path,
                FileKind.directory,
                0,
                null
            ))
            .sort((left, right) => compare(
                left.path.toString(),
                right.path.toString()
            ));
    }

    public rootEntry(path: FilePath): FileEntry | undefined {
        const mount = this.#mounts.get(path.toString());

        if (mount === undefined) {
            return undefined;
        }

        return new FileEntry(mount.path, FileKind.directory, 0, null);
    }
}

export class Route<T> {
    public constructor(
        public readonly target: T,
        public readonly prefix: FilePath,
        public readonly path: FilePath
    ) {
    }

    public entry(entry: FileEntry): FileEntry {
        return new FileEntry(
            this.prefix.append(entry.path),
            entry.kind,
            entry.size,
            entry.modifiedAt
        );
    }

    public sameTarget(other: Route<T>): boolean {
        return this.target === other.target;
    }

    public requireSameTarget(other: Route<T>, path: FilePath): void {
        if (!this.sameTarget(other)) {
            throw new FileError(
                FileErrorCode.crossDevice,
                FileOperation.move,
                path,
                "Cannot move across filesystem mounts"
            );
        }
    }
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

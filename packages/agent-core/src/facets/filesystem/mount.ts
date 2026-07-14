import { FilesystemError } from "./error";
import {
    FilesystemBackend,
    type FilesystemPage,
    type FilesystemReadRange,
    type FilesystemStat,
    type FilesystemWriteMode
} from "./facet";
import { normalizeFilesystemPath } from "./path";

export interface FilesystemMount {
    readonly path: string;
    readonly backend: FilesystemBackend;
}

interface ResolvedMount {
    readonly mount: FilesystemMount;
    readonly path: string;
}

export class MountFilesystemBackend extends FilesystemBackend {
    readonly #mounts: readonly FilesystemMount[];

    public constructor(mounts: readonly FilesystemMount[]) {
        super();
        if (mounts.length === 0)
            throw new TypeError("Mount filesystem requires at least one mount");
        const normalized = mounts.map((mount) =>
            Object.freeze({
                path: normalizeFilesystemPath(mount.path),
                backend: mount.backend
            })
        );
        if (new Set(normalized.map((mount) => mount.path)).size !== normalized.length) {
            throw new TypeError("Filesystem mount paths must be unique");
        }
        this.#mounts = Object.freeze(
            normalized.sort((left, right) => right.path.length - left.path.length)
        );
    }

    public read(path: string, range?: FilesystemReadRange): Uint8Array {
        const resolved = this.resolve(path);
        return resolved.mount.backend.read(resolved.path, range);
    }

    public stat(path: string): FilesystemStat {
        const resolved = this.resolve(path);
        return this.externalStat(resolved.mount, resolved.mount.backend.stat(resolved.path));
    }

    public list(path: string, cursor?: string, limit?: number): FilesystemPage {
        const resolved = this.resolve(path);
        const translatedCursor =
            cursor === undefined ? undefined : this.resolveForMount(cursor, resolved.mount).path;
        const page = resolved.mount.backend.list(resolved.path, translatedCursor, limit);
        return Object.freeze({
            entries: Object.freeze(
                page.entries.map((entry) => this.externalStat(resolved.mount, entry))
            ),
            ...(page.cursor === undefined
                ? {}
                : { cursor: this.externalPath(resolved.mount, page.cursor) })
        });
    }

    public write(path: string, content: Uint8Array, mode?: FilesystemWriteMode): void {
        const resolved = this.resolve(path);
        resolved.mount.backend.write(resolved.path, content, mode);
    }

    public remove(path: string): void {
        const resolved = this.resolve(path);
        resolved.mount.backend.remove(resolved.path);
    }

    public move(source: string, destination: string): void {
        const resolvedSource = this.resolve(source);
        const resolvedDestination = this.resolve(destination);
        if (resolvedSource.mount !== resolvedDestination.mount) {
            throw new FilesystemError(
                "path.invalid",
                destination,
                "Cannot move across filesystem mounts"
            );
        }
        resolvedSource.mount.backend.move(resolvedSource.path, resolvedDestination.path);
    }

    public mkdir(path: string, recursive?: boolean): void {
        const resolved = this.resolve(path);
        resolved.mount.backend.mkdir(resolved.path, recursive);
    }

    private resolve(path: string): ResolvedMount {
        const normalized = normalizeFilesystemPath(path);
        const mount = this.#mounts.find(
            (candidate) =>
                candidate.path === "/" ||
                normalized === candidate.path ||
                normalized.startsWith(`${candidate.path}/`)
        );
        if (mount === undefined)
            throw new FilesystemError(
                "not-found",
                normalized,
                "Path is outside mounted filesystems"
            );
        return this.resolveForMount(normalized, mount);
    }

    private resolveForMount(path: string, mount: FilesystemMount): ResolvedMount {
        const normalized = normalizeFilesystemPath(path);
        if (
            mount.path !== "/" &&
            normalized !== mount.path &&
            !normalized.startsWith(`${mount.path}/`)
        ) {
            throw new FilesystemError(
                "path.invalid",
                normalized,
                "Path belongs to another filesystem mount"
            );
        }
        const translated =
            mount.path === "/" ? normalized : normalized.slice(mount.path.length) || "/";
        return { mount, path: translated };
    }

    private externalStat(mount: FilesystemMount, stat: FilesystemStat): FilesystemStat {
        return Object.freeze({ ...stat, path: this.externalPath(mount, stat.path) });
    }

    private externalPath(mount: FilesystemMount, path: string): string {
        if (mount.path === "/") return path;
        return path === "/" ? mount.path : `${mount.path}${path}`;
    }
}

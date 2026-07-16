// @ts-nocheck
import {
    FilesystemReaderBackend,
    type FilesystemPage,
    type FilesystemReadRange,
    type FilesystemStat
} from "./facet";

export class ReadonlyFilesystemBackend extends FilesystemReaderBackend {
    public constructor(private readonly filesystem: FilesystemReaderBackend) {
        super();
    }

    public read(path: string, range?: FilesystemReadRange): Uint8Array {
        return this.filesystem.read(path, range);
    }

    public stat(path: string): FilesystemStat {
        return this.filesystem.stat(path);
    }

    public list(path: string, cursor?: string, limit?: number): FilesystemPage {
        return this.filesystem.list(path, cursor, limit);
    }
}

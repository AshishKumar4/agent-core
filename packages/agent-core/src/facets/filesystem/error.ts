import type { FilePath } from "./path";

export enum FileOperation {
    stat = "stat",
    read = "read",
    write = "write",
    list = "list",
    makeDirectory = "make_directory",
    remove = "remove",
    move = "move",
    flush = "flush"
}

export enum FileErrorCode {
    invalidPath = "invalid_path",
    invalidCursor = "invalid_cursor",
    notFound = "not_found",
    alreadyExists = "already_exists",
    isDirectory = "is_directory",
    notDirectory = "not_directory",
    directoryNotEmpty = "directory_not_empty",
    readOnly = "read_only",
    crossDevice = "cross_device",
    unsupported = "unsupported",
    unavailable = "unavailable",
    ioFailure = "io_failure"
}

export class FileError extends Error {
    public constructor(
        public readonly code: FileErrorCode,
        public readonly operation: FileOperation,
        public readonly path: FilePath,
        message: string
    ) {
        super(message);
        this.name = "FileError";
    }
}

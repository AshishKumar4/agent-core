import type { FilePath } from "./path";

export abstract class FileKind {
    public static get file(): FileKind {
        return file;
    }

    public static get directory(): FileKind {
        return directory;
    }

    protected constructor(public readonly name: string) {
    }
}

class Kind extends FileKind {
    public constructor(name: string) {
        super(name);
    }
}

const file = new Kind("file");
const directory = new Kind("directory");

export class FileEntry {
    public constructor(
        public readonly path: FilePath,
        public readonly kind: FileKind,
        public readonly size: number,
        public readonly modifiedAt: string | null
    ) {
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new TypeError("File size must be a nonnegative safe integer");
        }
    }
}

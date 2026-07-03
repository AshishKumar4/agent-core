import { FileError, FileErrorCode, FileOperation } from "./error";
import type { FilePath } from "./path";

export abstract class WriteMode {
    public static get create(): WriteMode {
        return create;
    }

    public static get replace(): WriteMode {
        return replace;
    }

    public static get upsert(): WriteMode {
        return upsert;
    }

    public abstract validate(path: FilePath, exists: boolean): void;
}

class Create extends WriteMode {
    public validate(path: FilePath, exists: boolean): void {
        if (exists) {
            throw new FileError(
                FileErrorCode.alreadyExists,
                FileOperation.write,
                path,
                "File already exists"
            );
        }
    }
}

class Replace extends WriteMode {
    public validate(path: FilePath, exists: boolean): void {
        if (!exists) {
            throw new FileError(
                FileErrorCode.notFound,
                FileOperation.write,
                path,
                "File does not exist"
            );
        }
    }
}

class Upsert extends WriteMode {
    public validate(_path: FilePath, _exists: boolean): void {
    }
}

const create = new Create();
const replace = new Replace();
const upsert = new Upsert();

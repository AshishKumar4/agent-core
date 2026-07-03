import { FileError, FileErrorCode, FileOperation } from "./error";
import type { FilePath } from "./path";

export abstract class ReplaceMode {
    public static get preserve(): ReplaceMode {
        return preserve;
    }

    public static get replace(): ReplaceMode {
        return replace;
    }

    public abstract validate(path: FilePath, exists: boolean): void;

    public abstract remove(remove: () => void): void;
}

class Preserve extends ReplaceMode {
    public validate(path: FilePath, exists: boolean): void {
        if (exists) {
            throw new FileError(
                FileErrorCode.alreadyExists,
                FileOperation.move,
                path,
                "Destination already exists"
            );
        }
    }

    public remove(_remove: () => void): void {
    }
}

class Replace extends ReplaceMode {
    public validate(_path: FilePath, _exists: boolean): void {
    }

    public remove(remove: () => void): void {
        remove();
    }
}

const preserve = new Preserve();
const replace = new Replace();

import { FileError, FileErrorCode, FileOperation } from "./error";
import type { FileEntry } from "./entry";
import type { FilePath } from "./path";

export class PageCursor {
    public constructor(
        public readonly directory: string,
        public readonly revision: number,
        public readonly last: string
    ) {
        if (!Number.isSafeInteger(revision) || revision < 0) {
            throw new TypeError("Page cursor revision must be a nonnegative safe integer");
        }

        if (last.length === 0) {
            throw new TypeError("Page cursor position must not be empty");
        }
    }
}

export abstract class ListPosition {
    public static first(): ListPosition {
        return first;
    }

    public static after(cursor: PageCursor): ListPosition {
        return new After(cursor);
    }

    public abstract offset(
        directory: FilePath,
        revision: number,
        orderedPaths: readonly string[]
    ): number;
}

class First extends ListPosition {
    public offset(
        _directory: FilePath,
        _revision: number,
        _orderedPaths: readonly string[]
    ): number {
        return 0;
    }
}

class After extends ListPosition {
    public constructor(private readonly cursor: PageCursor) {
        super();
    }

    public offset(
        directory: FilePath,
        revision: number,
        orderedPaths: readonly string[]
    ): number {
        if (
            this.cursor.directory !== directory.toString() ||
            this.cursor.revision !== revision
        ) {
            throw invalidCursor(directory);
        }

        const index = orderedPaths.indexOf(this.cursor.last);

        if (index < 0) {
            throw invalidCursor(directory);
        }

        return index + 1;
    }
}

const first = new First();

export abstract class PageContinuation {
    public static done(): PageContinuation {
        return done;
    }

    public static more(cursor: PageCursor): PageContinuation {
        return new More(cursor);
    }

    public abstract get complete(): boolean;

    public abstract next(): ListPosition;
}

class Done extends PageContinuation {
    public get complete(): boolean {
        return true;
    }

    public next(): ListPosition {
        throw new RangeError("The page sequence is complete");
    }
}

class More extends PageContinuation {
    public constructor(private readonly cursor: PageCursor) {
        super();
    }

    public get complete(): boolean {
        return false;
    }

    public next(): ListPosition {
        return ListPosition.after(this.cursor);
    }
}

const done = new Done();

export class FilePage {
    public readonly entries: readonly FileEntry[];

    public constructor(
        entries: readonly FileEntry[],
        public readonly continuation: PageContinuation
    ) {
        this.entries = Object.freeze([...entries]);
    }
}

function invalidCursor(path: FilePath): FileError {
    return new FileError(
        FileErrorCode.invalidCursor,
        FileOperation.list,
        path,
        "Page cursor does not belong to this directory revision"
    );
}

import { FileError, FileErrorCode, FileOperation } from "./error";
import { FilePath } from "./path";

export abstract class TreeMode {
    public static get node(): TreeMode {
        return node;
    }

    public static get tree(): TreeMode {
        return tree;
    }

    public abstract create(
        path: FilePath,
        create: (path: FilePath) => boolean
    ): boolean;

    public abstract allowChildren(
        path: FilePath,
        operation: FileOperation,
        childCount: number
    ): void;
}

class Node extends TreeMode {
    public create(
        path: FilePath,
        create: (path: FilePath) => boolean
    ): boolean {
        return create(path);
    }

    public allowChildren(
        path: FilePath,
        operation: FileOperation,
        childCount: number
    ): void {
        if (childCount > 0) {
            throw new FileError(
                FileErrorCode.directoryNotEmpty,
                operation,
                path,
                "Directory is not empty"
            );
        }
    }
}

class Tree extends TreeMode {
    public create(
        path: FilePath,
        create: (path: FilePath) => boolean
    ): boolean {
        let changed = false;
        let current = FilePath.root();

        for (const segment of path.parts()) {
            current = current.child(segment);
            changed = create(current) || changed;
        }

        return changed;
    }

    public allowChildren(
        _path: FilePath,
        _operation: FileOperation,
        _childCount: number
    ): void {
    }
}

const node = new Node();
const tree = new Tree();

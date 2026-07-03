import { resolve } from "pathe";
import type { OperationContext } from "../../operations/context";
import { Durability } from "../filesystem/durability";
import { FileKind } from "../filesystem/entry";
import { FileError, FileErrorCode } from "../filesystem/error";
import type { FileSystem } from "../filesystem/filesystem";
import { ListPosition } from "../filesystem/page";
import { FilePath } from "../filesystem/path";
import { ReadRange } from "../filesystem/range";
import { ReplaceMode } from "../filesystem/move";
import { TreeMode } from "../filesystem/tree";
import { WriteMode } from "../filesystem/write";

export class ShellStat {
    public constructor(
        private readonly kind: FileKind,
        public readonly size: number,
        public readonly mtimeMs: number
    ) {
    }

    public isFile(): boolean {
        return this.kind === FileKind.file;
    }

    public isDirectory(): boolean {
        return this.kind === FileKind.directory;
    }

    public isSymbolicLink(): boolean {
        return false;
    }

    public get type(): "file" | "dir" {
        return this.isDirectory() ? "dir" : "file";
    }

    public get mode(): number {
        return this.isDirectory() ? 0o755 : 0o644;
    }
}

export class ShellFileSystem {
    public constructor(
        private readonly files: FileSystem,
        private readonly context: OperationContext
    ) {
    }

    public readFile(path: string): Promise<Uint8Array> {
        return this.files.read(
            this.context,
            shellPath(path),
            ReadRange.all()
        );
    }

    public async readText(path: string): Promise<string> {
        return new TextDecoder().decode(await this.readFile(path));
    }

    public async writeFile(
        path: string,
        content: Uint8Array | string
    ): Promise<void> {
        await this.files.write(
            this.context,
            shellPath(path),
            typeof content === "string"
                ? new TextEncoder().encode(content)
                : content,
            WriteMode.upsert,
            Durability.accepted
        );
    }

    public async readdir(path: string): Promise<string[]> {
        const directory = shellPath(path);
        const names: string[] = [];
        let position = ListPosition.first();

        while (true) {
            const page = await this.files.list(
                this.context,
                directory,
                position,
                256
            );

            for (const entry of page.entries) {
                const name = entry.path.relativeTo(directory).first();

                if (name !== null) {
                    names.push(name);
                }
            }

            if (page.continuation.complete) {
                return names;
            }

            position = page.continuation.next();
        }
    }

    public async stat(path: string): Promise<ShellStat> {
        const entry = await this.files.stat(this.context, shellPath(path));
        return new ShellStat(
            entry.kind,
            entry.size,
            entry.modifiedAt === null ? 0 : Date.parse(entry.modifiedAt)
        );
    }

    public async unlink(path: string): Promise<void> {
        await this.files.remove(this.context, shellPath(path), TreeMode.node);
    }

    public async mkdir(path: string): Promise<void> {
        await this.files.makeDirectory(
            this.context,
            shellPath(path),
            TreeMode.node
        );
    }

    public async removeRecursive(path: string): Promise<void> {
        await this.files.remove(this.context, shellPath(path), TreeMode.tree);
    }

    public async rename(source: string, destination: string): Promise<void> {
        await this.files.move(
            this.context,
            shellPath(source),
            shellPath(destination),
            ReplaceMode.replace
        );
    }

    public async exists(path: string): Promise<boolean> {
        try {
            await this.files.stat(this.context, shellPath(path));
            return true;
        } catch (error) {
            if (error instanceof FileError && error.code === FileErrorCode.notFound) {
                return false;
            }

            throw error;
        }
    }
}

export function shellPath(value: string): FilePath {
    const normalized = resolve("/", value).slice(1);
    return FilePath.parse(normalized);
}

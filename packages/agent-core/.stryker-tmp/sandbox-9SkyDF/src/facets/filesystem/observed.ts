// @ts-nocheck
import {
    FilesystemBackend,
    type FilesystemPage,
    type FilesystemReadRange,
    type FilesystemStat,
    type FilesystemWriteMode
} from "./facet";

export interface FilesystemObservation {
    readonly operation: "read" | "stat" | "list" | "write" | "remove" | "move" | "mkdir";
    readonly paths: readonly string[];
}

export abstract class FilesystemObservationBackend {
    public abstract record(observation: FilesystemObservation): void;
}

export class ObservedFilesystemBackend extends FilesystemBackend {
    public constructor(
        private readonly backend: FilesystemBackend,
        private readonly observations: FilesystemObservationBackend
    ) {
        super();
    }

    public read(path: string, range?: FilesystemReadRange): Uint8Array {
        const result = this.backend.read(path, range);
        this.record("read", path);
        return result;
    }

    public stat(path: string): FilesystemStat {
        const result = this.backend.stat(path);
        this.record("stat", path);
        return result;
    }

    public list(path: string, cursor?: string, limit?: number): FilesystemPage {
        const result = this.backend.list(path, cursor, limit);
        this.record("list", path);
        return result;
    }

    public write(path: string, content: Uint8Array, mode?: FilesystemWriteMode): void {
        this.backend.write(path, content, mode);
        this.record("write", path);
    }

    public remove(path: string): void {
        this.backend.remove(path);
        this.record("remove", path);
    }

    public move(source: string, destination: string): void {
        this.backend.move(source, destination);
        this.observations.record(
            Object.freeze({ operation: "move", paths: Object.freeze([source, destination]) })
        );
    }

    public mkdir(path: string, recursive?: boolean): void {
        this.backend.mkdir(path, recursive);
        this.record("mkdir", path);
    }

    private record(operation: FilesystemObservation["operation"], path: string): void {
        this.observations.record(Object.freeze({ operation, paths: Object.freeze([path]) }));
    }
}

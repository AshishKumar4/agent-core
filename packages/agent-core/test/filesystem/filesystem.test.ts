import { describe, expect, test } from "vitest";
import { AsyncFileSystem } from "../../src/facets/filesystem/async";
import { Durability } from "../../src/facets/filesystem/durability";
import { FileKind } from "../../src/facets/filesystem/entry";
import { FileError, FileErrorCode } from "../../src/facets/filesystem/error";
import { MountedFileSystem } from "../../src/facets/filesystem/mount/async";
import {
    ObservedFileSystem,
    ObservedSyncFileSystem
} from "../../src/facets/filesystem/observed/observed";
import { SyncMountedFileSystem } from "../../src/facets/filesystem/mount/sync";
import { Mount } from "../../src/facets/filesystem/mount/table";
import { ReplaceMode } from "../../src/facets/filesystem/move";
import { ListPosition } from "../../src/facets/filesystem/page";
import { FilePath } from "../../src/facets/filesystem/path";
import { ReadRange } from "../../src/facets/filesystem/range";
import {
    ReadOnlyFileSystem,
    SyncReadOnlyFileSystem
} from "../../src/facets/filesystem/readonly/readonly";
import { TreeMode } from "../../src/facets/filesystem/tree";
import { WriteMode } from "../../src/facets/filesystem/write";
import { MemoryFileSystem } from "../../src/facets/filesystem/memory/memory";
import { SqliteFileSystem } from "../../src/substrates/sqlite";
import {
    fileSystemConformance,
    liftedSyncFileSystem
} from "./conformance";
import { TestSqlite } from "./sqlite";
import { testOperationContext } from "../helpers/context";

const context = testOperationContext("filesystem");

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

fileSystemConformance(
    "MemoryFileSystem through asynchronous lift",
    liftedSyncFileSystem(() => new MemoryFileSystem())
);

fileSystemConformance(
    "SqliteFileSystem through asynchronous lift",
    liftedSyncFileSystem(() => new SqliteFileSystem(
        new TestSqlite(),
        "conformance",
        Durability.accepted
    ))
);

describe("FilePath", () => {
    test("accepts strict relative paths", () => {
        const path = FilePath.parse("docs/guides/readme.txt");

        expect(path.parent().toString()).toBe("docs/guides");
        expect(path.startsWith(FilePath.parse("docs"))).toBe(true);
        expect(path.child("copy").toString()).toBe("docs/guides/readme.txt/copy");
    });

    test("rejects paths that could change authority targets", () => {
        const invalid = [
            "/root",
            "docs/",
            "docs//file",
            "docs/./file",
            "docs/../file",
            "docs\\file",
            "..\\secret",
            "C:\\absolute",
            "docs\0file"
        ];

        for (const value of invalid) {
            expect(() => FilePath.parse(value)).toThrow(TypeError);
        }
    });
});

describe("MemoryFileSystem", () => {
    test("supports synchronous filesystem operations", () => {
        const files = new MemoryFileSystem();
        const directory = FilePath.parse("docs");
        const file = FilePath.parse("docs/readme.txt");

        files.makeDirectory(context, directory, TreeMode.node);
        files.write(context, file, bytes("hello"), WriteMode.create, Durability.accepted);

        expect(text(files.read(context, file, ReadRange.all()))).toBe("hello");
        expect(files.list(context, directory, ListPosition.first(), 10).entries).toHaveLength(1);
    });

    test("implements create, replace, and upsert without ambiguity", () => {
        const files = new MemoryFileSystem();
        const file = FilePath.parse("value.txt");

        files.write(context, file, bytes("one"), WriteMode.create, Durability.accepted);
        expect(() => files.write(context, file, bytes("two"), WriteMode.create, Durability.accepted))
            .toThrow(FileError);
        files.write(context, file, bytes("two"), WriteMode.replace, Durability.accepted);
        files.write(context, file, bytes("three"), WriteMode.upsert, Durability.accepted);
        expect(text(files.read(context, file, ReadRange.all()))).toBe("three");
    });

    test("preserves real empty directories and moves directory trees", () => {
        const files = new MemoryFileSystem();
        const source = FilePath.parse("source");
        const child = FilePath.parse("source/nested/value.txt");
        const destination = FilePath.parse("destination");

        files.makeDirectory(context, FilePath.parse("empty"), TreeMode.node);
        files.makeDirectory(context, FilePath.parse("source/nested"), TreeMode.tree);
        files.write(context, child, bytes("value"), WriteMode.create, Durability.accepted);
        files.move(context, source, destination, ReplaceMode.preserve);

        expect(files.stat(context, FilePath.parse("empty")).kind).toBe(FileKind.directory);
        expect(text(files.read(context, FilePath.parse("destination/nested/value.txt"), ReadRange.all())))
            .toBe("value");
        expect(() => files.stat(context, source)).toThrow(FileError);
    });

    test("rejects moves onto ancestors without changing the tree", () => {
        const files = new MemoryFileSystem();
        const directory = FilePath.parse("a");
        const file = FilePath.parse("a/file");

        files.makeDirectory(context, directory, TreeMode.node);
        files.write(context, file, bytes("value"), WriteMode.create, Durability.accepted);

        expect(() => files.move(context, file, directory, ReplaceMode.replace)).toThrow(FileError);
        expect(text(files.read(context, file, ReadRange.all()))).toBe("value");
    });

    test("rejects nonrecursive deletion of nonempty directories", () => {
        const files = new MemoryFileSystem();
        const directory = FilePath.parse("docs");

        files.makeDirectory(context, directory, TreeMode.node);
        files.write(context, directory.child("file.txt"), bytes("value"), WriteMode.create, Durability.accepted);

        try {
            files.remove(context, directory, TreeMode.node);
            throw new Error("Expected removal to fail");
        } catch (error) {
            if (!(error instanceof FileError)) {
                throw error;
            }

            expect(error.code).toBe(FileErrorCode.directoryNotEmpty);
        }
    });

    test("fails explicitly when durable flush is unsupported", () => {
        const files = new MemoryFileSystem();

        try {
            files.flush(context);
            throw new Error("Expected flush to fail");
        } catch (error) {
            if (!(error instanceof FileError)) {
                throw error;
            }

            expect(error.code).toBe(FileErrorCode.unsupported);
        }
    });

    test("uses one deterministic ordering for pagination", () => {
        const files = new MemoryFileSystem();
        const root = FilePath.root();

        for (const name of ["a", "B", "á", "10", "2"]) {
            files.write(context, FilePath.parse(name), bytes(name), WriteMode.create, Durability.accepted);
        }

        const first = files.list(context, root, ListPosition.first(), 2);
        const second = files.list(context, root, first.continuation.next(), 2);
        const third = files.list(context, root, second.continuation.next(), 2);
        const names = [...first.entries, ...second.entries, ...third.entries]
            .map(entry => entry.path.toString());

        expect(names).toEqual(["10", "2", "B", "a", "á"]);
        expect(third.continuation.complete).toBe(true);
    });

    test("rejects stale and foreign pagination cursors", () => {
        const files = new MemoryFileSystem();
        const root = FilePath.root();

        files.write(context, FilePath.parse("a"), bytes("a"), WriteMode.create, Durability.accepted);
        files.write(context, FilePath.parse("b"), bytes("b"), WriteMode.create, Durability.accepted);
        const first = files.list(context, root, ListPosition.first(), 1);
        const next = first.continuation.next();

        files.write(context, FilePath.parse("c"), bytes("c"), WriteMode.create, Durability.accepted);
        expect(() => files.list(context, root, next, 1)).toThrow(FileError);

        files.makeDirectory(context, FilePath.parse("other"), TreeMode.node);
        expect(() => files.list(context, FilePath.parse("other"), next, 1)).toThrow(FileError);
    });

    test("routes mounted filesystems and exposes mount roots", async () => {
        const root = new MemoryFileSystem();
        const mounted = new MemoryFileSystem();
        const mountPath = FilePath.parse("shared");
        const sync = new SyncMountedFileSystem(
            root,
            [new Mount(mountPath, mounted)]
        );
        const asyncFiles = new MountedFileSystem(
            new AsyncFileSystem(root),
            [new Mount(mountPath, new AsyncFileSystem(mounted))]
        );
        const file = FilePath.parse("shared/value.txt");

        sync.write(context, file, bytes("sync"), WriteMode.create, Durability.accepted);
        expect(text(mounted.read(context, FilePath.parse("value.txt"), ReadRange.all())))
            .toBe("sync");
        expect(sync.list(context, FilePath.root(), ListPosition.first(), 10).entries
            .map(entry => entry.path.toString())).toContain("shared");
        expect(text(await asyncFiles.read(context, file, ReadRange.all()))).toBe("sync");
    });

    test("rejects cross-mount moves", () => {
        const root = new MemoryFileSystem();
        const mounted = new MemoryFileSystem();
        const files = new SyncMountedFileSystem(
            root,
            [new Mount(FilePath.parse("shared"), mounted)]
        );
        const source = FilePath.parse("source.txt");

        root.write(context, source, bytes("value"), WriteMode.create, Durability.accepted);

        try {
            files.move(
                context,
                source,
                FilePath.parse("shared/source.txt"),
                ReplaceMode.preserve
            );
            throw new Error("Expected move to fail");
        } catch (error) {
            if (!(error instanceof FileError)) {
                throw error;
            }

            expect(error.code).toBe(FileErrorCode.crossDevice);
        }
    });

    test("stores large SQLite files across chunks", () => {
        const files = new SqliteFileSystem(
            new TestSqlite(),
            "large-files",
            Durability.accepted
        );
        const path = FilePath.parse("large.bin");
        const content = new Uint8Array(2_100_000);
        content[0] = 1;
        content[2_099_999] = 2;

        files.write(
            context,
            path,
            content,
            WriteMode.create,
            Durability.accepted
        );
        const stored = files.read(context, path, ReadRange.all());

        expect(stored.byteLength).toBe(content.byteLength);
        expect(stored[0]).toBe(1);
        expect(stored[2_099_999]).toBe(2);
    });

    test("handles SQLite paths containing SQL wildcard characters", () => {
        const files = new SqliteFileSystem(
            new TestSqlite(),
            "wildcards",
            Durability.accepted
        );
        const percent = FilePath.parse("percent%/value.txt");
        const underscore = FilePath.parse("under_score/value.txt");

        files.makeDirectory(context, percent.parent(), TreeMode.node);
        files.makeDirectory(context, underscore.parent(), TreeMode.node);
        files.write(context, percent, bytes("percent"), WriteMode.create, Durability.accepted);
        files.write(context, underscore, bytes("underscore"), WriteMode.create, Durability.accepted);
        files.remove(context, percent.parent(), TreeMode.tree);

        expect(text(files.read(context, underscore, ReadRange.all()))).toBe("underscore");
    });

    test("isolates SQLite filesystem namespaces", () => {
        const database = new TestSqlite();
        const first = new SqliteFileSystem(database, "first", Durability.accepted);
        const second = new SqliteFileSystem(database, "second", Durability.accepted);
        const path = FilePath.parse("value.txt");

        first.write(context, path, bytes("first"), WriteMode.create, Durability.accepted);
        second.write(context, path, bytes("second"), WriteMode.create, Durability.accepted);

        expect(text(first.read(context, path, ReadRange.all()))).toBe("first");
        expect(text(second.read(context, path, ReadRange.all()))).toBe("second");
    });

    test("enforces read-only composition for sync and async filesystems", async () => {
        const memory = new MemoryFileSystem();
        const path = FilePath.parse("value.txt");

        memory.write(context, path, bytes("value"), WriteMode.create, Durability.accepted);
        const sync = new SyncReadOnlyFileSystem(memory);
        const asyncFiles = new ReadOnlyFileSystem(new AsyncFileSystem(memory));

        expect(text(sync.read(context, path, ReadRange.all()))).toBe("value");
        expect(() => sync.remove(context, path, TreeMode.node)).toThrow(FileError);
        await expect(asyncFiles.remove(context, path, TreeMode.node)).rejects.toBeInstanceOf(FileError);
    });

    test("composes operational telemetry without changing behavior", async () => {
        const memory = new MemoryFileSystem();
        const sync = new ObservedSyncFileSystem(memory);
        const asyncFiles = new ObservedFileSystem(new AsyncFileSystem(memory));
        const path = FilePath.parse("observed.txt");

        sync.write(context, path, bytes("value"), WriteMode.create, Durability.accepted);
        expect(text(await asyncFiles.read(context, path, ReadRange.all()))).toBe("value");
    });

    test("lifts synchronous implementations through the asynchronous API", async () => {
        const sync = new MemoryFileSystem();
        const files = new AsyncFileSystem(sync);
        const path = FilePath.parse("value.txt");

        await files.write(context, path, bytes("value"), WriteMode.create, Durability.accepted);

        expect(text(await files.read(context, path, ReadRange.all()))).toBe("value");
    });
});

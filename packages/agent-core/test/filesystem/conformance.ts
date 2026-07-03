import { describe, expect, test } from "vitest";
import { AsyncFileSystem } from "../../src/facets/filesystem/async";
import { Durability } from "../../src/facets/filesystem/durability";
import { FileKind } from "../../src/facets/filesystem/entry";
import { FileErrorCode } from "../../src/facets/filesystem/error";
import type { FileSystem, SyncFileSystem } from "../../src/facets/filesystem/filesystem";
import { ReplaceMode } from "../../src/facets/filesystem/move";
import { ListPosition } from "../../src/facets/filesystem/page";
import { FilePath } from "../../src/facets/filesystem/path";
import { ReadRange } from "../../src/facets/filesystem/range";
import { TreeMode } from "../../src/facets/filesystem/tree";
import { WriteMode } from "../../src/facets/filesystem/write";
import { testOperationContext } from "../helpers/context";

const context = testOperationContext("conformance");

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

export function fileSystemConformance(
    name: string,
    create: () => FileSystem
): void {
    describe(`${name} filesystem conformance`, () => {
        test("round-trips bytes and reports metadata", async () => {
            const files = create();
            const path = FilePath.parse("document.txt");

            await files.write(
                context,
                path,
                bytes("content"),
                WriteMode.create,
                Durability.accepted
            );

            expect(text(await files.read(context, path, ReadRange.all())))
                .toBe("content");
            const entry = await files.stat(context, path);
            expect(entry.kind).toBe(FileKind.file);
            expect(entry.size).toBe(7);
        });

        test("distinguishes absent paths", async () => {
            const files = create();

            await expect(files.stat(context, FilePath.parse("missing")))
                .rejects.toMatchObject({ code: FileErrorCode.notFound });
        });

        test("lists immediate children with complete metadata", async () => {
            const files = create();
            const directory = FilePath.parse("docs");

            await files.makeDirectory(context, directory, TreeMode.node);
            await files.makeDirectory(
                context,
                directory.child("nested"),
                TreeMode.node
            );
            await files.write(
                context,
                directory.child("a.txt"),
                bytes("a"),
                WriteMode.create,
                Durability.accepted
            );
            await files.write(
                context,
                directory.child("nested").child("b.txt"),
                bytes("b"),
                WriteMode.create,
                Durability.accepted
            );

            const page = await files.list(
                context,
                directory,
                ListPosition.first(),
                10
            );
            expect(page.entries.map(entry => entry.path.toString()))
                .toEqual(["docs/a.txt", "docs/nested"]);
            expect(page.entries.map(entry => entry.kind))
                .toEqual([FileKind.file, FileKind.directory]);
        });

        test("enforces write modes", async () => {
            const files = create();
            const path = FilePath.parse("value.txt");

            await expect(files.write(
                context,
                path,
                bytes("missing"),
                WriteMode.replace,
                Durability.accepted
            )).rejects.toMatchObject({ code: FileErrorCode.notFound });

            await files.write(
                context,
                path,
                bytes("created"),
                WriteMode.create,
                Durability.accepted
            );

            await expect(files.write(
                context,
                path,
                bytes("duplicate"),
                WriteMode.create,
                Durability.accepted
            )).rejects.toMatchObject({ code: FileErrorCode.alreadyExists });

            await files.write(
                context,
                path,
                bytes("replaced"),
                WriteMode.replace,
                Durability.accepted
            );
            expect(text(await files.read(context, path, ReadRange.all())))
                .toBe("replaced");
        });

        test("moves file and directory trees", async () => {
            const files = create();
            const source = FilePath.parse("source");
            const destination = FilePath.parse("destination");

            await files.makeDirectory(
                context,
                source.child("nested"),
                TreeMode.tree
            );
            await files.write(
                context,
                source.child("nested").child("value.txt"),
                bytes("value"),
                WriteMode.create,
                Durability.accepted
            );
            await files.move(
                context,
                source,
                destination,
                ReplaceMode.preserve
            );

            expect(text(await files.read(
                context,
                destination.child("nested").child("value.txt"),
                ReadRange.all()
            ))).toBe("value");
            await expect(files.stat(context, source))
                .rejects.toMatchObject({ code: FileErrorCode.notFound });
        });

        test("removes trees only when explicitly requested", async () => {
            const files = create();
            const directory = FilePath.parse("directory");

            await files.makeDirectory(context, directory, TreeMode.node);
            await files.write(
                context,
                directory.child("value.txt"),
                bytes("value"),
                WriteMode.create,
                Durability.accepted
            );

            await expect(files.remove(context, directory, TreeMode.node))
                .rejects.toMatchObject({
                    code: FileErrorCode.directoryNotEmpty
                });
            await files.remove(context, directory, TreeMode.tree);
            await expect(files.stat(context, directory))
                .rejects.toMatchObject({ code: FileErrorCode.notFound });
        });

        test("invalidates cursors after mutation", async () => {
            const files = create();

            for (const name of ["a", "b"]) {
                await files.write(
                    context,
                    FilePath.parse(name),
                    bytes(name),
                    WriteMode.create,
                    Durability.accepted
                );
            }

            const first = await files.list(
                context,
                FilePath.root(),
                ListPosition.first(),
                1
            );
            const next = first.continuation.next();

            await files.write(
                context,
                FilePath.parse("c"),
                bytes("c"),
                WriteMode.create,
                Durability.accepted
            );

            await expect(files.list(
                context,
                FilePath.root(),
                next,
                1
            )).rejects.toMatchObject({ code: FileErrorCode.invalidCursor });
        });

        test("returns detached byte copies", async () => {
            const files = create();
            const path = FilePath.parse("bytes.bin");
            const content = bytes("abc");

            await files.write(
                context,
                path,
                content,
                WriteMode.create,
                Durability.accepted
            );
            content[0] = 0;
            const first = await files.read(context, path, ReadRange.all());
            first[1] = 0;
            const second = await files.read(context, path, ReadRange.all());

            expect(text(second)).toBe("abc");
        });
    });
}

export function liftedSyncFileSystem(
    create: () => SyncFileSystem
): () => FileSystem {
    return () => new AsyncFileSystem(create());
}

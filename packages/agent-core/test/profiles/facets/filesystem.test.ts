import { describe, expect, test } from "vitest";
import { CompatRange, SemVer } from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import { InvocationId } from "../../../src/invocations";
import {
    FILESYSTEM_ERROR_CODES,
    FILESYSTEM_OPERATION_CONTRACTS,
    FILESYSTEM_OPERATIONS,
    FacetPackageId,
    FilesystemError,
    FilesystemFacet,
    FilesystemObservationBackend,
    type FacetData,
    type FilesystemBackend,
    type FilesystemReaderBackend,
    type OperationContext,
    MemoryFilesystemBackend,
    MountFilesystemBackend,
    ObservedFilesystemBackend,
    OperationName,
    ReadonlyFilesystemBackend,
    createFilesystemManifest,
    normalizeFilesystemPath
} from "../../../src/facets";
import {
    denyingRuntime,
    filesystemReaderBackendEvidence,
    mutableFilesystemBackendEvidence,
    operationDeclarationEvidence,
    recordingRuntime
} from "./harness";

operationDeclarationEvidence("Filesystem", FILESYSTEM_OPERATIONS, {
    read: "observe",
    stat: "observe",
    list: "observe",
    write: "mutate",
    remove: "mutate",
    move: "mutate",
    mkdir: "mutate"
});

filesystemReaderBackendEvidence("memory", () => {
    const filesystem = new MemoryFilesystemBackend();
    return { reader: filesystem, seed: filesystem };
});

filesystemReaderBackendEvidence("readonly memory wrapper", () => {
    const filesystem = new MemoryFilesystemBackend();
    return { reader: new ReadonlyFilesystemBackend(filesystem), seed: filesystem };
});

mutableFilesystemBackendEvidence("memory", () => new MemoryFilesystemBackend());
filesystemReaderBackendEvidence("observed memory wrapper", () => {
    const filesystem = new ObservedFilesystemBackend(
        new MemoryFilesystemBackend(),
        new NullObservations()
    );
    return { reader: filesystem, seed: filesystem };
});
mutableFilesystemBackendEvidence(
    "observed memory wrapper",
    () => new ObservedFilesystemBackend(new MemoryFilesystemBackend(), new NullObservations())
);
filesystemReaderBackendEvidence("root mount wrapper", () => {
    const filesystem = new MountFilesystemBackend([
        { path: "/", backend: new MemoryFilesystemBackend() }
    ]);
    return { reader: filesystem, seed: filesystem };
});
mutableFilesystemBackendEvidence(
    "root mount wrapper",
    () => new MountFilesystemBackend([{ path: "/", backend: new MemoryFilesystemBackend() }])
);

describe("Filesystem protected facade", () => {
    test("[P11-FILESYSTEM-RECEIPT] routes all seven Operations and delegates mutation receipts to the host port", async () => {
        const { runtime, admission } = recordingRuntime("filesystem");
        const backend = new MemoryFilesystemBackend();
        const facet = new FilesystemFacet(runtime, backend);

        const mkdirReceipt = await facet.mkdir({ path: "/docs" });
        const writeReceipt = await facet.write({
            path: "/docs/a",
            content: new Uint8Array([1, 2])
        });
        await expect(facet.read({ path: "/docs/a" })).resolves.toEqual(new Uint8Array([1, 2]));
        await expect(facet.stat({ path: "/docs/a" })).resolves.toMatchObject({
            kind: "file",
            size: 2
        });
        await expect(facet.list({ path: "/docs" })).resolves.toMatchObject({
            entries: [{ path: "/docs/a" }]
        });
        const moveReceipt = await facet.move({ source: "/docs/a", destination: "/docs/b" });
        expect([...backend.read("/docs/b")]).toEqual([1, 2]);
        const removeReceipt = await facet.remove({ path: "/docs/b" });
        expect(() => backend.stat("/docs/b")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );

        expect(admission.calls.map((call) => call.name)).toEqual([
            "mkdir",
            "write",
            "read",
            "stat",
            "list",
            "move",
            "remove"
        ]);
        expect(admission.calls.every((call) => call.kind === "invoke")).toBe(true);
        expect(admission.calls[1]?.input).toEqual({ path: "/docs/a", content: [1, 2] });
        expect(
            [mkdirReceipt, writeReceipt, moveReceipt, removeReceipt].map((receipt) => ({
                id: receipt.id.value,
                outcome: receipt.outcome,
                variant: receipt.variant
            }))
        ).toEqual([
            { id: "profile-receipt-1", outcome: "succeeded", variant: "attempt" },
            { id: "profile-receipt-2", outcome: "succeeded", variant: "attempt" },
            { id: "profile-receipt-3", outcome: "succeeded", variant: "attempt" },
            { id: "profile-receipt-4", outcome: "succeeded", variant: "attempt" }
        ]);
    });

    test("does not invoke a filesystem backend after denied admission", async () => {
        const backend = new MemoryFilesystemBackend();
        const { runtime } = denyingRuntime("filesystem");
        const facet = new FilesystemFacet(runtime, backend);
        await expect(
            facet.write({ path: "/denied", content: new Uint8Array() })
        ).rejects.toMatchObject({ code: "authority.denied", detailCode: "runtime.denied" });
        expect(() => backend.stat("/denied")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
    });
});

describe("Filesystem backend invariants", () => {
    test("[P11-FILESYSTEM-SUITE] uses one complete reader/mutator contract", () => {
        const filesystem = new MemoryFilesystemBackend();
        runFilesystemReaderContract(filesystem, filesystem);
        runFilesystemMutationContract(filesystem);
    });

    test("[P11-FILESYSTEM-BACKINGS] runs the shared suite against every backing and wrapper", () => {
        const readers: Array<
            readonly [string, () => { reader: FilesystemReaderBackend; seed: FilesystemBackend }]
        > = [
            ["memory", () => readerAndSeed(new MemoryFilesystemBackend())],
            [
                "readonly",
                () => {
                    const seed = new MemoryFilesystemBackend();
                    return { reader: new ReadonlyFilesystemBackend(seed), seed };
                }
            ],
            [
                "observed",
                () =>
                    readerAndSeed(
                        new ObservedFilesystemBackend(
                            new MemoryFilesystemBackend(),
                            new NullObservations()
                        )
                    )
            ],
            [
                "mount",
                () =>
                    readerAndSeed(
                        new MountFilesystemBackend([
                            { path: "/", backend: new MemoryFilesystemBackend() }
                        ])
                    )
            ]
        ];
        for (const [name, create] of readers) {
            const { reader, seed } = create();
            runFilesystemReaderContract(reader, seed, name);
        }
        for (const [name, create] of readers.filter(([candidate]) => candidate !== "readonly")) {
            runFilesystemMutationContract(create().seed, name);
        }
    });

    test("[P11-FILESYSTEM-PATHS] normalizes inside the root and publishes the fixed branchable detail codes", () => {
        expect(normalizeFilesystemPath("/a//b/../c/./")).toBe("/a/c");
        for (const path of ["", "relative", "/../escape", "/a/../../escape", "/a\\b", "/a\0b"]) {
            expect(() => normalizeFilesystemPath(path)).toThrow(FilesystemError);
        }
        expect(FILESYSTEM_ERROR_CODES).toEqual([
            "not-found",
            "exists",
            "not-a-directory",
            "is-a-directory",
            "path.invalid",
            "too-large"
        ]);
        expect(() => new FilesystemError("outside" as never, "/", "invalid")).toThrow(TypeError);
    });

    test("[P11-FILESYSTEM-ATOMIC-WRITE] rejects oversized replacements and destructive moves without partial changes", () => {
        const filesystem = new MemoryFilesystemBackend(1);
        filesystem.mkdir("/tree/child", true);
        filesystem.write("/tree/file", new Uint8Array([1]));
        expect(() => filesystem.write("/tree/file", new Uint8Array([2, 3]), "replace")).toThrow(
            expect.objectContaining({ detailCode: "too-large" })
        );
        expect(() => filesystem.move("/tree", "/tree/child/moved")).toThrow(
            expect.objectContaining({ detailCode: "path.invalid" })
        );
        expect([...filesystem.read("/tree/file")]).toEqual([1]);
    });

    test("[P11-FILESYSTEM-RANGES] rejects malformed ranges, paging, write modes, and node-kind conflicts", () => {
        expect(() => new MemoryFilesystemBackend(-1)).toThrow(TypeError);
        const filesystem = new MemoryFilesystemBackend();
        filesystem.mkdir("/docs");
        filesystem.write("/docs/file", new Uint8Array([1, 2]));

        expect(() => filesystem.read("/docs")).toThrow(
            expect.objectContaining({ detailCode: "is-a-directory" })
        );
        expect(() => filesystem.read("/docs/file", { offset: -1 })).toThrow(
            expect.objectContaining({ detailCode: "operation.invalid-input" })
        );
        expect(() => filesystem.read("/docs/file", { length: -1 })).toThrow(
            expect.objectContaining({ detailCode: "operation.invalid-input" })
        );
        expect(filesystem.read("/docs/file", { offset: 2 })).toEqual(new Uint8Array());
        expect(() => filesystem.list("/docs/file")).toThrow(
            expect.objectContaining({ detailCode: "not-a-directory" })
        );
        expect(() => filesystem.list("/docs", undefined, 0)).toThrow(
            expect.objectContaining({ detailCode: "operation.invalid-input" })
        );
        expect(filesystem.list("/docs", "/z").entries).toEqual([]);

        expect(() => filesystem.write("/docs", new Uint8Array())).toThrow(
            expect.objectContaining({ detailCode: "is-a-directory" })
        );
        expect(() => filesystem.write("/docs/file", new Uint8Array(), "invalid" as never)).toThrow(
            expect.objectContaining({ detailCode: "operation.invalid-input" })
        );
        expect(() => filesystem.write("/", new Uint8Array())).toThrow(
            expect.objectContaining({ detailCode: "path.invalid" })
        );
        expect(() => filesystem.stat("/missing")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
    });

    test("[P11-FILESYSTEM-MOVE] handles root, recursive creation, idempotent moves, and destination conflicts", () => {
        const filesystem = new MemoryFilesystemBackend();
        filesystem.mkdir("/");
        expect(() => filesystem.mkdir("/missing/child")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
        filesystem.mkdir("/missing/child", true);
        expect(() => filesystem.mkdir("/missing")).toThrow(
            expect.objectContaining({ detailCode: "exists" })
        );
        filesystem.write("/file", new Uint8Array());
        expect(() => filesystem.mkdir("/file")).toThrow(
            expect.objectContaining({ detailCode: "not-a-directory" })
        );
        expect(() => filesystem.mkdir("/file/child", true)).toThrow(
            expect.objectContaining({ detailCode: "not-a-directory" })
        );

        filesystem.move("/file", "/file");
        filesystem.write("/destination", new Uint8Array());
        expect(() => filesystem.move("/file", "/destination")).toThrow(
            expect.objectContaining({ detailCode: "exists" })
        );
        expect(filesystem.list("/").entries.map((entry) => entry.path)).toEqual([
            "/destination",
            "/file",
            "/missing"
        ]);
        filesystem.remove("/missing");
        expect(() => filesystem.stat("/missing/child")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
    });

    test("[P11-FILESYSTEM-MOVE-ASSERTIONS] rejects moves across mounts without changing either backend", () => {
        const left = new MemoryFilesystemBackend();
        const right = new MemoryFilesystemBackend();
        left.write("/file", new Uint8Array([1]));
        const mounted = new MountFilesystemBackend([
            { path: "/left", backend: left },
            { path: "/right", backend: right }
        ]);
        expect(() => mounted.move("/left/file", "/right/file")).toThrow(
            expect.objectContaining({ detailCode: "path.invalid" })
        );
        expect([...left.read("/file")]).toEqual([1]);
        expect(() => right.stat("/file")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
    });

    test("round-trips every optional filesystem wire field and rejects malformed outputs", () => {
        expect(
            FILESYSTEM_OPERATION_CONTRACTS.read.decodeInput(
                FILESYSTEM_OPERATION_CONTRACTS.read.encodeInput({
                    path: "/file",
                    range: { offset: 1, length: 2 }
                })
            )
        ).toEqual({ path: "/file", range: { offset: 1, length: 2 } });
        expect(
            FILESYSTEM_OPERATION_CONTRACTS.list.decodeInput(
                FILESYSTEM_OPERATION_CONTRACTS.list.encodeInput({
                    path: "/docs",
                    cursor: "/docs/a",
                    limit: 1
                })
            )
        ).toEqual({ path: "/docs", cursor: "/docs/a", limit: 1 });
        expect(
            FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput(
                FILESYSTEM_OPERATION_CONTRACTS.write.encodeInput({
                    path: "/file",
                    content: new Uint8Array([1]),
                    mode: "replace"
                })
            )
        ).toEqual({ path: "/file", content: new Uint8Array([1]), mode: "replace" });
        expect(
            FILESYSTEM_OPERATION_CONTRACTS.mkdir.decodeInput(
                FILESYSTEM_OPERATION_CONTRACTS.mkdir.encodeInput({
                    path: "/docs",
                    recursive: false
                })
            )
        ).toEqual({ path: "/docs", recursive: false });

        const stat = { path: "/docs/a", kind: "file", size: 1, modifiedAt: 2 } as const;
        const page = { entries: [stat], cursor: "/docs/a" } as const;
        expect(
            FILESYSTEM_OPERATION_CONTRACTS.list.decodeOutput(
                FILESYSTEM_OPERATION_CONTRACTS.list.encodeOutput(page)
            )
        ).toEqual(page);
        expect(() => FILESYSTEM_OPERATION_CONTRACTS.read.decodeOutput({} as never)).toThrow(
            TypeError
        );
        expect(() =>
            FILESYSTEM_OPERATION_CONTRACTS.list.decodeOutput({ entries: {} } as never)
        ).toThrow(TypeError);
        expect(() =>
            FILESYSTEM_OPERATION_CONTRACTS.stat.decodeOutput({
                ...stat,
                kind: "link"
            } as never)
        ).toThrow(TypeError);
        expect(() =>
            FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                path: "/file",
                content: ["not-a-byte"]
            } as never)
        ).toThrow(TypeError);

        expect(
            FILESYSTEM_OPERATION_CONTRACTS.read.decodeInput({
                path: "/file",
                range: { offset: 1 }
            })
        ).toEqual({ path: "/file", range: { offset: 1 } });
        expect(
            FILESYSTEM_OPERATION_CONTRACTS.read.decodeInput({
                path: "/file",
                range: { length: 2 }
            })
        ).toEqual({ path: "/file", range: { length: 2 } });
    });

    test("translates non-root mounts, records all effects, and rejects invalid mount topology", () => {
        expect(() => new MountFilesystemBackend([])).toThrow(TypeError);
        expect(
            () =>
                new MountFilesystemBackend([
                    { path: "/same", backend: new MemoryFilesystemBackend() },
                    { path: "/same/", backend: new MemoryFilesystemBackend() }
                ])
        ).toThrow(TypeError);

        const observations = new RecordingObservations();
        const mounted = new MountFilesystemBackend([
            {
                path: "/work",
                backend: new ObservedFilesystemBackend(new MemoryFilesystemBackend(), observations)
            }
        ]);
        mounted.mkdir("/work/docs");
        mounted.write("/work/docs/a", new Uint8Array([1]));
        mounted.write("/work/docs/b", new Uint8Array([2]));
        expect(mounted.stat("/work").path).toBe("/work");
        expect(mounted.read("/work/docs/a")).toEqual(new Uint8Array([1]));
        const first = mounted.list("/work/docs", undefined, 1);
        expect(first.cursor).toBe("/work/docs/a");
        expect(mounted.list("/work/docs", first.cursor, 1).entries[0]?.path).toBe("/work/docs/b");
        mounted.move("/work/docs/a", "/work/docs/c");
        mounted.remove("/work/docs/c");

        expect(() => mounted.stat("/outside")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
        expect(() => mounted.list("/work/docs", "/outside", 1)).toThrow(
            expect.objectContaining({ detailCode: "path.invalid" })
        );
        expect(observations.values.map((value) => value.operation)).toEqual([
            "mkdir",
            "write",
            "write",
            "stat",
            "read",
            "list",
            "list",
            "move",
            "remove"
        ]);
    });
});

describe("Filesystem memory backend boundaries", () => {
    test("accepts a zero byte limit and enforces it exactly", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend(0);
        filesystem.write("/empty", new Uint8Array());
        expect(filesystem.stat("/empty").size).toBe(0);
        expect(() => filesystem.write("/full", new Uint8Array([1]))).toThrow(
            expect.objectContaining({ detailCode: "too-large" })
        );
    });

    test("omits the cursor on final pages and copies written content", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend();
        filesystem.mkdir("/docs");
        filesystem.write("/docs/a", new Uint8Array([1]));
        filesystem.write("/docs/b", new Uint8Array([2]));
        expect(Object.keys(filesystem.list("/docs"))).toEqual(["entries"]);
        expect(Object.keys(filesystem.list("/docs", undefined, 2))).toEqual(["entries"]);
        const first = filesystem.list("/docs", undefined, 1);
        expect(first.cursor).toBe("/docs/a");
        const second = filesystem.list("/docs", first.cursor, 1);
        expect(second.entries.map((entry) => entry.path)).toEqual(["/docs/b"]);
        expect(Object.keys(second)).toEqual(["entries"]);

        const content = new Uint8Array([1, 2]);
        filesystem.write("/docs/copy", content);
        content[0] = 9;
        expect([...filesystem.read("/docs/copy")]).toEqual([1, 2]);
    });

    test("replaces and upserts existing files with the new content", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend();
        filesystem.write("/file", new Uint8Array([1]), "create");
        filesystem.write("/file", new Uint8Array([9]), "replace");
        expect([...filesystem.read("/file")]).toEqual([9]);
        filesystem.write("/file", new Uint8Array([7]), "upsert");
        expect([...filesystem.read("/file")]).toEqual([7]);
        filesystem.write("/fresh", new Uint8Array([5]));
        expect([...filesystem.read("/fresh")]).toEqual([5]);
    });

    test("removes and moves exactly the named subtree", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend();
        filesystem.mkdir("/dir");
        filesystem.write("/dir/inner", new Uint8Array([1]));
        filesystem.write("/dirfile", new Uint8Array([2]));
        filesystem.remove("/dir");
        expect(() => filesystem.stat("/dir")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
        expect(() => filesystem.stat("/dir/inner")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
        expect([...filesystem.read("/dirfile")]).toEqual([2]);

        filesystem.mkdir("/src");
        filesystem.write("/src/f", new Uint8Array([3]));
        filesystem.write("/srcfile", new Uint8Array([4]));
        filesystem.move("/src", "/moved");
        expect([...filesystem.read("/moved/f")]).toEqual([3]);
        expect(() => filesystem.stat("/src")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
        expect([...filesystem.read("/srcfile")]).toEqual([4]);
        expect([...filesystem.read("/dirfile")]).toEqual([2]);
    });

    test("reports a file parent as not-a-directory when moving under a file", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend();
        filesystem.write("/plain", new Uint8Array([1]));
        expect(() => filesystem.move("/plain", "/plain/child")).toThrow(
            expect.objectContaining({ detailCode: "not-a-directory" })
        );
    });

    test("creates recursive directories parents-first", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend();
        filesystem.mkdir("/x/y", true);
        expect(filesystem.stat("/x").modifiedAt).toBeLessThan(filesystem.stat("/x/y").modifiedAt);
    });

    test("publishes exact filesystem error metadata and messages", { tags: "p2" }, () => {
        const probe = new FilesystemError("not-found", "/probe", "Probe message");
        expect(probe.code).toBe("operation.invalid-input");
        expect(probe.name).toBe("FilesystemError");
        expect(probe.detailCode).toBe("not-found");
        expect(probe.path).toBe("/probe");
        expect(probe.message).toBe("Probe message");

        const filesystem = new MemoryFilesystemBackend(1);
        filesystem.mkdir("/dir");
        filesystem.write("/file", new Uint8Array([1]));
        expect(() => filesystem.read("/dir")).toThrow("Cannot read a directory");
        expect(() => filesystem.read("/file", { offset: -1 })).toThrow(
            "Read range values must be non-negative safe integers"
        );
        expect(() => filesystem.read("/file", { offset: -1 })).toThrow(
            expect.objectContaining({
                code: "operation.invalid-input",
                detailCode: "operation.invalid-input"
            })
        );
        expect(() => filesystem.list("/dir", undefined, 0)).toThrow("List limit must be positive");
        expect(() => filesystem.write("/file", new Uint8Array([1, 2]))).toThrow(
            "File exceeds the configured size limit"
        );
        expect(() => filesystem.write("/dir", new Uint8Array())).toThrow("Path is a directory");
        expect(() => filesystem.write("/file", new Uint8Array(), "create")).toThrow(
            "Path already exists"
        );
        expect(() => filesystem.write("/missing", new Uint8Array(), "replace")).toThrow(
            "Path does not exist"
        );
        expect(() => filesystem.write("/file", new Uint8Array(), "invalid" as never)).toThrow(
            "Write mode must be create, replace, or upsert"
        );
        expect(() => filesystem.move("/file", "/dir")).toThrow("Destination already exists");
        expect(() => filesystem.mkdir("/dir")).toThrow("Directory already exists");
        expect(() => filesystem.mkdir("/file")).toThrow("Path is not a directory");
        expect(() => filesystem.remove("/")).toThrow("Filesystem root cannot be mutated");
        expect(() => filesystem.stat("/missing")).toThrow("Path does not exist");
        expect(() => filesystem.list("/file")).toThrow("Path is not a directory");
    });
});

describe("Filesystem observation and mount boundaries", () => {
    test("records the exact observed paths for every operation", { tags: "p1" }, () => {
        const observations = new RecordingObservations();
        const filesystem = new ObservedFilesystemBackend(
            new MemoryFilesystemBackend(),
            observations
        );
        filesystem.write("/f", new Uint8Array([1]));
        filesystem.move("/f", "/g");
        expect(observations.values).toEqual([
            { operation: "write", paths: ["/f"] },
            { operation: "move", paths: ["/f", "/g"] }
        ]);
    });

    test("resolves the longest mount prefix regardless of declaration order", { tags: "p1" }, () => {
        const outer = new MemoryFilesystemBackend();
        const inner = new MemoryFilesystemBackend();
        const mounted = new MountFilesystemBackend([
            { path: "/a", backend: outer },
            { path: "/a/b", backend: inner }
        ]);
        mounted.write("/a/b/f", new Uint8Array([1]));
        expect([...inner.read("/f")]).toEqual([1]);
        expect(() => outer.stat("/b")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
        expect([...mounted.read("/a/b/f")]).toEqual([1]);
    });

    test("keeps final mount pages cursorless and refuses foreign cursors", { tags: "p1" }, () => {
        const mounted = new MountFilesystemBackend([
            { path: "/a", backend: new MemoryFilesystemBackend() },
            { path: "/b", backend: new MemoryFilesystemBackend() }
        ]);
        mounted.mkdir("/a/docs");
        mounted.write("/a/docs/f", new Uint8Array([1]));
        expect(Object.keys(mounted.list("/a/docs"))).toEqual(["entries"]);
        expect(() => mounted.list("/a", "/b/x")).toThrow(
            "Path belongs to another filesystem mount"
        );
        expect(() => mounted.list("/a", "/b/x")).toThrow(
            expect.objectContaining({ detailCode: "path.invalid" })
        );
    });
});

describe("Filesystem wire codecs", () => {
    test("keeps optional wire fields absent and decodes strict values", { tags: "p1" }, () => {
        const contracts = FILESYSTEM_OPERATION_CONTRACTS;
        expect(contracts.read.encodeInput({ path: "/file" })).toEqual({ path: "/file" });
        expect(contracts.read.decodeInput(contracts.read.encodeInput({ path: "/file" }))).toEqual({
            path: "/file"
        });
        expect(contracts.mkdir.decodeInput({ path: "/d" })).toEqual({ path: "/d" });
        expect(contracts.mkdir.decodeInput({ path: "/d", recursive: true })).toEqual({
            path: "/d",
            recursive: true
        });
        expect(
            contracts.stat.decodeOutput({ path: "/d", kind: "directory", size: 0, modifiedAt: 1 })
        ).toEqual({ path: "/d", kind: "directory", size: 0, modifiedAt: 1 });
        expect(() => contracts.write.decodeInput({ path: "/f", content: [1, "x"] })).toThrow(
            "Filesystem bytes are invalid"
        );
    });

    test("labels every malformed wire field in its error message", { tags: "p2" }, () => {
        const contracts = FILESYSTEM_OPERATION_CONTRACTS;
        expect(() => contracts.read.decodeInput({ path: 1 })).toThrow(
            "Filesystem read path must be a string"
        );
        expect(() => contracts.list.decodeInput({ path: 1 })).toThrow(
            "Filesystem list path must be a string"
        );
        expect(() => contracts.list.decodeInput({ path: "/x", cursor: 1 })).toThrow(
            "Filesystem list cursor must be a string"
        );
        expect(() => contracts.move.decodeInput({ source: 1, destination: "/d" })).toThrow(
            "Filesystem move source must be a string"
        );
        expect(() => contracts.move.decodeInput({ source: "/s", destination: 1 })).toThrow(
            "Filesystem move destination must be a string"
        );
        expect(() => contracts.mkdir.decodeInput({ path: 1 })).toThrow(
            "Filesystem mkdir path must be a string"
        );
        expect(() => contracts.write.decodeInput({ path: 1, content: [1] })).toThrow(
            "Filesystem write path must be a string"
        );
        expect(() => contracts.list.decodeOutput({ entries: {} })).toThrow(
            "Filesystem page entries must be an array"
        );
        expect(() => contracts.list.decodeOutput({ entries: [], cursor: 1 })).toThrow(
            "Filesystem page cursor must be a string"
        );
        expect(() =>
            contracts.stat.decodeOutput({ path: "/p", kind: 1, size: 0, modifiedAt: 0 })
        ).toThrow("Filesystem entry kind must be a string");
        expect(() =>
            contracts.stat.decodeOutput({ path: 1, kind: "file", size: 0, modifiedAt: 0 })
        ).toThrow("Filesystem stat path must be a string");
    });
});

describe("Filesystem internal W8 runtime", () => {
    test("executes all seven internal operations against the backend", { tags: "p1" }, async () => {
        const backend = new MemoryFilesystemBackend();
        const { runtime } = recordingRuntime("filesystem");
        const internal = new FilesystemFacet(runtime, backend).asInternalRuntime(
            createFilesystemManifest({
                id: new FacetPackageId("profile.filesystem"),
                version: new SemVer("1.0.0"),
                compat: new CompatRange("^1.0.0", "^1.0.0"),
                bindings: []
            })
        );
        const execute = (name: string, input: FacetData): Promise<FacetData> => {
            const operation = internal.operation(new OperationName(name));
            if (operation === undefined) {
                throw new TypeError(`Missing internal operation ${name}`);
            }
            return operation.execute(operationContext(), input);
        };
        await execute("mkdir", { path: "/docs", recursive: false });
        await execute("write", { path: "/docs/a", content: [1, 2, 3] });
        await expect(
            execute("read", { path: "/docs/a", range: { offset: 1, length: 1 } })
        ).resolves.toEqual([2]);
        await expect(execute("stat", { path: "/docs/a" })).resolves.toMatchObject({
            kind: "file",
            size: 3
        });
        await expect(execute("list", { path: "/docs" })).resolves.toMatchObject({
            entries: [{ path: "/docs/a" }]
        });
        await execute("move", { source: "/docs/a", destination: "/docs/b" });
        expect([...backend.read("/docs/b")]).toEqual([1, 2, 3]);
        await execute("remove", { path: "/docs/b" });
        expect(() => backend.stat("/docs/b")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
    });
});

class NullObservations extends FilesystemObservationBackend {
    public record(): void {}
}

class RecordingObservations extends FilesystemObservationBackend {
    public readonly values: Array<{
        readonly operation: "read" | "stat" | "list" | "write" | "remove" | "move" | "mkdir";
        readonly paths: readonly string[];
    }> = [];

    public record(observation: (typeof this.values)[number]): void {
        this.values.push(observation);
    }
}

function readerAndSeed(filesystem: FilesystemBackend): {
    readonly reader: FilesystemReaderBackend;
    readonly seed: FilesystemBackend;
} {
    return { reader: filesystem, seed: filesystem };
}

function runFilesystemReaderContract(
    reader: FilesystemReaderBackend,
    seed: FilesystemBackend,
    label = "filesystem"
): void {
    seed.mkdir("/suite");
    seed.write("/suite/b", new Uint8Array([1, 2, 3]));
    seed.write("/suite/a", new Uint8Array([4]));
    expect([...reader.read("/suite/b", { offset: 1, length: 1 })], label).toEqual([2]);
    const first = reader.list("/suite", undefined, 1);
    expect(first.entries, label).toEqual([reader.stat("/suite/a")]);
    expect(reader.list("/suite", first.cursor, 1).entries, label).toEqual([
        reader.stat("/suite/b")
    ]);
    expect(() => reader.read("/../escape"), label).toThrow(
        expect.objectContaining({ detailCode: "path.invalid" })
    );
}

function operationContext(): OperationContext {
    return {
        invocation: new InvocationId("filesystem-internal-invocation"),
        itemIndex: 0,
        idempotencyKey: "filesystem-internal-idempotency",
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    };
}

function runFilesystemMutationContract(filesystem: FilesystemBackend, label = "filesystem"): void {
    filesystem.mkdir("/mutable");
    filesystem.write("/mutable/file", new Uint8Array([1]), "create");
    expect(() => filesystem.write("/mutable/file", new Uint8Array(), "create"), label).toThrow(
        expect.objectContaining({ detailCode: "exists" })
    );
    filesystem.move("/mutable/file", "/mutable/moved");
    expect([...filesystem.read("/mutable/moved")], label).toEqual([1]);
    filesystem.remove("/mutable/moved");
    expect(() => filesystem.stat("/mutable/moved"), label).toThrow(
        expect.objectContaining({ detailCode: "not-found" })
    );
}

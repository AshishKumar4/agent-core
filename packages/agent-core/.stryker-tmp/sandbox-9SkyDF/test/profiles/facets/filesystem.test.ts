// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
    FILESYSTEM_ERROR_CODES,
    FILESYSTEM_OPERATION_CONTRACTS,
    FILESYSTEM_OPERATIONS,
    FilesystemError,
    FilesystemFacet,
    FilesystemObservationBackend,
    type FilesystemBackend,
    type FilesystemReaderBackend,
    MemoryFilesystemBackend,
    MountFilesystemBackend,
    ObservedFilesystemBackend,
    ReadonlyFilesystemBackend,
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
        const facet = new FilesystemFacet(runtime, new MemoryFilesystemBackend());

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
        const removeReceipt = await facet.remove({ path: "/docs/b" });

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

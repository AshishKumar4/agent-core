import { describe, expect, test } from "vitest";
import { CompatRange, Digest, SemVer } from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import { evaluatePolicy } from "../../../src/definition";
import { InvocationId } from "../../../src/invocations";
import {
    FILESYSTEM_ERROR_CODES,
    FILESYSTEM_OPERATION_CONTRACTS,
    FILESYSTEM_OPERATIONS,
    BindingName,
    DetailedProfileError,
    FacetPackageId,
    FacetRef,
    FilesystemError,
    type FilesystemErrorCode,
    FilesystemFacet,
    FilesystemObservationBackend,
    FilesystemTargetState,
    type FilesystemTargetCases,
    FilesystemWriteMode,
    InterleavedFilesystemBackend,
    type FacetData,
    FilesystemBackend,
    type FilesystemPage,
    type FilesystemReaderBackend,
    type FilesystemStat,
    type OperationContext,
    MemoryFilesystemBackend,
    MountFilesystemBackend,
    ObservedFilesystemBackend,
    OperationName,
    ProfileRuntimeHostBinding,
    type ProtectedOperationRequest,
    type ProtectedOperationResult,
    ProtectedProfileRuntimePort,
    ReadonlyFilesystemBackend,
    createFilesystemManifest,
    isFacetDataMap,
    normalizeFilesystemPath
} from "../../../src/facets";
import {
    RecordingProfileAdmission,
    RecordingProfileEffects,
    type TestReceipt,
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
    test(
        "[P11-FILESYSTEM-SESSION-DIRECT] selects direct for a mutating Operation only on the Turn-owned Session's own filesystem",
        { tags: "p0" },
        () => {
            const mutating = [
                FILESYSTEM_OPERATION_CONTRACTS.write,
                FILESYSTEM_OPERATION_CONTRACTS.remove,
                FILESYSTEM_OPERATION_CONTRACTS.move,
                FILESYSTEM_OPERATION_CONTRACTS.mkdir
            ];
            for (const contract of mutating) {
                expect(contract.descriptor.impact).toBe("mutate");
                expect(
                    evaluatePolicy({
                        impact: contract.descriptor.impact,
                        turnOwnedSession: true,
                        sessionFilesystemTarget: true,
                        placement: "bundled"
                    })
                ).toEqual({ approvalRequired: false, tier: "direct" });
                for (const decision of [
                    evaluatePolicy({
                        impact: contract.descriptor.impact,
                        turnOwnedSession: true,
                        sessionFilesystemTarget: false,
                        placement: "bundled"
                    }),
                    evaluatePolicy({
                        impact: contract.descriptor.impact,
                        turnOwnedSession: false,
                        sessionFilesystemTarget: true,
                        placement: "bundled"
                    }),
                    evaluatePolicy({
                        impact: contract.descriptor.impact,
                        turnOwnedSession: true,
                        sessionFilesystemTarget: true,
                        placement: "dynamic"
                    })
                ]) {
                    expect(decision.tier).toBe("mediated");
                }
            }
        }
    );

    test(
        "[P11-FILESYSTEM-RECEIPT] routes all seven Operations and delegates mutation receipts to the host port",
        { tags: "p1" },
        async () => {
            const { runtime, admission } = recordingRuntime("filesystem");
            const backend = new MemoryFilesystemBackend();
            const facet = new FilesystemFacet(runtime, backend);

            const mkdirReceipt = await facet.mkdir({ path: "/docs" });
            const writeReceipt = await facet.write({
                path: "/docs/a",
                content: new Uint8Array([1, 2]),
                mode: FilesystemWriteMode.create
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
            expect(admission.calls[1]?.input).toEqual({
                path: "/docs/a",
                content: [1, 2],
                mode: { name: "create" }
            });
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
        }
    );

    test(
        "does not invoke a filesystem backend after denied admission",
        { tags: "p0" },
        async () => {
            const backend = new MemoryFilesystemBackend();
            const { runtime } = denyingRuntime("filesystem");
            const facet = new FilesystemFacet(runtime, backend);
            await expect(
                facet.write({
                    path: "/denied",
                    content: new Uint8Array(),
                    mode: FilesystemWriteMode.create
                })
            ).rejects.toMatchObject({ code: "authority.denied", detailCode: "runtime.denied" });
            expect(() => backend.stat("/denied")).toThrow(
                expect.objectContaining({ detailCode: "not-found" })
            );
        }
    );

    test(
        "[P11-FILESYSTEM-WRITE-UNOBSERVED] refuses upsert before the effect while admitting create and guarded replace",
        { tags: "p0" },
        async () => {
            const observations = new RecordingObservations();
            const store = new MemoryFilesystemBackend();
            const { runtime, admission } = upsertRefusingRuntime();
            const facet = new FilesystemFacet(
                runtime,
                new ObservedFilesystemBackend(store, observations)
            );
            await facet.mkdir({ path: "/policy" });

            // The policy admits both observed shapes: `create` names an absent target and a
            // guarded `replace` names the content it replaces.
            const seeded = new Uint8Array([1]);
            await facet.write({
                path: "/policy/file",
                content: seeded,
                mode: FilesystemWriteMode.create
            });
            await facet.write({
                path: "/policy/file",
                content: new Uint8Array([2]),
                mode: FilesystemWriteMode.replace(Digest.sha256(seeded))
            });
            expect([...store.read("/policy/file")]).toEqual([2]);

            // It refuses the one unobserved overwrite on the mode alone. Nothing else about
            // the request differs: same Operation, same `mutate` impact, same target — which
            // is why refusing `upsert` specifically depends on policy reading the declared
            // mode out of the admitted intent rather than only the Operation.
            await expect(
                facet.write({
                    path: "/policy/file",
                    content: new Uint8Array([3]),
                    mode: FilesystemWriteMode.upsert
                })
            ).rejects.toMatchObject({ code: "authority.denied", detailCode: "runtime.denied" });

            // The refusal is a pre-effect outcome under §7.3 rather than a store-level
            // rejection: preparation froze the intent, read the mode, and declined before
            // any effect ran, so the store holds what the admitted writes left, recorded no
            // third write, and produced no filesystem error at all.
            expect([...store.read("/policy/file")]).toEqual([2]);
            expect(observations.values.map((value) => value.operation)).toEqual([
                "mkdir",
                "write",
                "write"
            ]);
            expect(admission.calls.filter((call) => call.name === "write")).toHaveLength(2);
        }
    );

    test(
        "[P11-FILESYSTEM-WRITE-UNOBSERVED] permits the one declared unobserved overwrite and records its mode in the mediated intent",
        { tags: "p0" },
        async () => {
            const { runtime, admission } = recordingRuntime("filesystem");
            const store = new MemoryFilesystemBackend();
            const facet = new FilesystemFacet(runtime, store);
            await facet.mkdir({ path: "/audit" });
            await facet.write({
                path: "/audit/file",
                content: new Uint8Array([1]),
                mode: FilesystemWriteMode.create
            });

            // The behaviour this rule permits rather than forbids: `upsert` over a present
            // target replaces content this caller never read — no read of the target appears
            // anywhere above, and the write still lands.
            const bytes = new Uint8Array([2]);
            const unobserved = await facet.write({
                path: "/audit/file",
                content: bytes,
                mode: FilesystemWriteMode.upsert
            });
            expect([...store.read("/audit/file")]).toEqual([2]);

            // The guarded write that follows differs from it in the mode and in nothing
            // else: same path, same bytes.
            const guarded = await facet.write({
                path: "/audit/file",
                content: bytes,
                mode: FilesystemWriteMode.replace(Digest.sha256(bytes))
            });
            expect(unobserved.id.equals(guarded.id)).toBe(false);

            // So the audit trail tells them apart after the fact. Each mediated write's
            // admitted intent names its mode, and the attempt each Receipt attests digests
            // that intent, so two writes alike but for the mode attest different intents.
            const trail = admission.calls.filter((call) => call.name === "write");
            expect(
                trail.map((call) => (isFacetDataMap(call.input) ? call.input["mode"] : undefined))
            ).toEqual([
                { name: "create" },
                { name: "upsert" },
                { name: "replace", expected: Digest.sha256(bytes).value }
            ]);
            const attested = trail.map((call) => call.context?.intentDigest?.value);
            expect(attested.every((digest) => digest !== undefined)).toBe(true);
            expect(new Set(attested).size).toBe(3);

            // No default and no absent-mode fallback on any part of the path. The wire
            // schema and the decoder both refuse an omitted mode, the typed input cannot
            // express one, and every backing takes the mode as a required argument rather
            // than minting `upsert` for a caller that stayed silent.
            expect(
                FILESYSTEM_OPERATION_CONTRACTS.write.descriptor.input.accepts({
                    path: "/audit/file",
                    content: [4]
                })
            ).toBe(false);
            expectFilesystemDetail(
                () =>
                    FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                        path: "/audit/file",
                        content: [4]
                    }),
                "operation.invalid-input"
            );
            for (const backing of [
                MemoryFilesystemBackend,
                MountFilesystemBackend,
                ObservedFilesystemBackend,
                InterleavedFilesystemBackend
            ]) {
                // Arity three: the mode is a required argument on every backing, so none of
                // them has an absent-mode branch that could mean anything.
                expect(backing.prototype.write, backing.name).toHaveLength(3);
            }
            await expect(
                // @ts-expect-error An undeclared write is unrepresentable in this input.
                facet.write({ path: "/audit/file", content: new Uint8Array([4]) })
            ).rejects.toMatchObject({ code: "operation.invalid-input", detailCode: "wire.input" });

            // And no third route to one: the wire admits exactly the three declared modes,
            // of which `upsert` is the only one carrying no precondition.
            expect(
                [
                    { name: "create" },
                    { name: "replace", expected: Digest.sha256(bytes).value },
                    { name: "upsert" }
                ].map(
                    (mode) =>
                        FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                            path: "/audit/file",
                            content: [4],
                            mode
                        }).mode.name
                )
            ).toEqual(["create", "replace", "upsert"]);
            expectFilesystemDetail(
                () =>
                    FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                        path: "/audit/file",
                        content: [4],
                        mode: { name: "overwrite" }
                    }),
                "operation.invalid-input"
            );
        }
    );
});

describe("Filesystem backend invariants", () => {
    test("[P11-FILESYSTEM-SUITE] uses one complete reader/mutator contract", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend();
        runFilesystemReaderContract(filesystem, filesystem);
        runFilesystemMutationContract(filesystem);
    });

    test(
        "[P11-FILESYSTEM-BACKINGS] runs the shared suite against every backing and wrapper",
        { tags: "p1" },
        () => {
            const readers: Array<
                readonly [
                    string,
                    () => { reader: FilesystemReaderBackend; seed: FilesystemBackend }
                ]
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
                ],
                // The interleave seam is a backing like the others when nothing is armed in
                // its window, which is what makes a rejection under an armed one attributable
                // to the landing write rather than to the split.
                [
                    "interleaved",
                    () =>
                        readerAndSeed(
                            new InterleavedFilesystemBackend(new MemoryFilesystemBackend())
                        )
                ]
            ];
            for (const [name, create] of readers) {
                const { reader, seed } = create();
                runFilesystemReaderContract(reader, seed, name);
            }
            for (const [name, create] of readers.filter(
                ([candidate]) => candidate !== "readonly"
            )) {
                runFilesystemMutationContract(create().seed, name);
            }
        }
    );

    test(
        "[P11-FILESYSTEM-WRITE-OBSERVED] admits a guarded replace only against the content it names, on every backing",
        { tags: "p0" },
        () => {
            for (const [name, create] of guardedWriteBackings()) {
                const filesystem = create();
                filesystem.mkdir("/guarded");
                const seeded = new Uint8Array([1, 2, 3]);
                filesystem.write("/guarded/file", seeded, FilesystemWriteMode.create);

                // A guard naming the target's current content is admitted, and it is the
                // content that decides: the same digest presented twice cannot pass twice.
                filesystem.write(
                    "/guarded/file",
                    new Uint8Array([9]),
                    FilesystemWriteMode.replace(Digest.sha256(seeded))
                );
                expect([...filesystem.read("/guarded/file")], name).toEqual([9]);
                expectFilesystemDetail(
                    () =>
                        filesystem.write(
                            "/guarded/file",
                            new Uint8Array([8]),
                            FilesystemWriteMode.replace(Digest.sha256(seeded))
                        ),
                    "content-mismatch",
                    name
                );
                expect([...filesystem.read("/guarded/file")], name).toEqual([9]);

                // The three-way branch: a host collapsing the middle case into either
                // neighbour denies the caller the one recovery that differs.
                expectFilesystemDetail(
                    () =>
                        filesystem.write(
                            "/guarded/absent",
                            new Uint8Array([1]),
                            FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([1])))
                        ),
                    "not-found",
                    name
                );
                expectFilesystemDetail(
                    () =>
                        filesystem.write(
                            "/guarded/file",
                            new Uint8Array([7]),
                            FilesystemWriteMode.create
                        ),
                    "exists",
                    name
                );

                // An absent target is not a target holding nothing: the digest of empty
                // content is a well-formed guard and it still cannot match an absent path.
                expectFilesystemDetail(
                    () =>
                        filesystem.write(
                            "/guarded/absent",
                            new Uint8Array([1]),
                            FilesystemWriteMode.replace(Digest.sha256(new Uint8Array()))
                        ),
                    "not-found",
                    name
                );
            }
        }
    );

    test(
        "[P11-FILESYSTEM-WRITE-OBSERVED] refuses an observation that is stale, partial, or absent",
        { tags: "p0" },
        () => {
            const filesystem = new MemoryFilesystemBackend();
            filesystem.write("/observed", new Uint8Array([1, 2, 3]), FilesystemWriteMode.create);

            // Stale but genuine: the read demonstrably happened, and a later write
            // superseded it. A host that remembers that a read occurred admits this.
            const observed = filesystem.read("/observed");
            filesystem.write("/observed", new Uint8Array([4, 5, 6]), FilesystemWriteMode.upsert);
            expectFilesystemDetail(
                () =>
                    filesystem.write(
                        "/observed",
                        new Uint8Array([7]),
                        FilesystemWriteMode.replace(Digest.sha256(observed))
                    ),
                "content-mismatch"
            );
            expect([...filesystem.read("/observed")]).toEqual([4, 5, 6]);

            // Partial: a caller that read one byte of three has not observed the content
            // it proposes to replace.
            expectFilesystemDetail(
                () =>
                    filesystem.write(
                        "/observed",
                        new Uint8Array([7]),
                        FilesystemWriteMode.replace(
                            Digest.sha256(filesystem.read("/observed", { offset: 0, length: 1 }))
                        )
                    ),
                "content-mismatch"
            );

            // Absent: a write issued without reading the target cannot produce a passing
            // guard, whatever it guesses.
            expectFilesystemDetail(
                () =>
                    filesystem.write(
                        "/observed",
                        new Uint8Array([7]),
                        FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([4, 5])))
                    ),
                "content-mismatch"
            );

            // The path is normalized before the guard is consulted, so a degenerate path
            // reports its own code rather than a mismatch against nothing.
            for (const path of ["", "/../escape"]) {
                expectFilesystemDetail(
                    () =>
                        filesystem.write(
                            path,
                            new Uint8Array([7]),
                            FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([4, 5, 6])))
                        ),
                    "path.invalid"
                );
            }

            // A refused guarded write is not an observed write: the audit trail must not
            // record a mutation that did not happen.
            const observations = new RecordingObservations();
            const wrapped = new ObservedFilesystemBackend(
                new MemoryFilesystemBackend(),
                observations
            );
            wrapped.write("/audited", new Uint8Array([1]), FilesystemWriteMode.create);
            expectFilesystemDetail(
                () =>
                    wrapped.write(
                        "/audited",
                        new Uint8Array([2]),
                        FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([9])))
                    ),
                "content-mismatch"
            );
            expect(observations.values.filter((value) => value.operation === "write")).toEqual([
                { operation: "write", paths: ["/audited"] }
            ]);
        }
    );

    test(
        "[P11-FILESYSTEM-WRITE-OBSERVED] leaves an unguarded replace unconstructable and unrepresentable",
        { tags: "p0" },
        () => {
            const guard = Digest.sha256(new Uint8Array([1]));

            // `replace` is the one parameterized case, so it is a call and not a value: an
            // unguarded replace cannot be named in the domain at all.
            expect(typeof FilesystemWriteMode.replace).toBe("function");
            // @ts-expect-error A replace that names no content it replaces is illegal.
            expect(() => FilesystemWriteMode.replace()).toThrow(TypeError);
            // @ts-expect-error A replace guarded by a bare digest string names no content.
            expect(() => FilesystemWriteMode.replace(guard.value)).toThrow(TypeError);

            // `create` and `upsert` carry no guard, so they stay argument-less getters
            // yielding one frozen value each rather than factories.
            expect(typeof FilesystemWriteMode.create).toBe("object");
            expect(typeof FilesystemWriteMode.upsert).toBe("object");
            expect(Object.isFrozen(FilesystemWriteMode.create)).toBe(true);

            const decoded = FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                path: "/file",
                content: [1],
                mode: { name: "replace", expected: guard.value }
            });
            expect(decoded.mode?.toData()).toEqual({ name: "replace", expected: guard.value });

            // Every rejected wire shape carries the profile's stable code, because a caller
            // branches on codes: an unguarded replace, a guarded create, and the pre-guard
            // bare-label form are each invalid input rather than a shape error.
            for (const mode of [
                { name: "replace" },
                { name: "replace", expected: guard.value, extra: 1 },
                { name: "create", expected: guard.value },
                { name: "upsert", expected: guard.value },
                "replace",
                "create"
            ]) {
                expectFilesystemDetail(
                    () =>
                        FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                            path: "/file",
                            content: [1],
                            mode
                        }),
                    "operation.invalid-input"
                );
            }

            // The store's report of what it found is a two-case value, so a backing store
            // cannot claim a present target without naming the content it holds.
            const bytes = new Uint8Array([1]);
            const cases: FilesystemTargetCases<string | Uint8Array> = {
                absent: () => "absent",
                present: (held) => held
            };
            expect(FilesystemTargetState.absent.fold(cases)).toBe("absent");
            expect(FilesystemTargetState.present(bytes).fold(cases)).toBe(bytes);
            // @ts-expect-error A present target without its content is illegal.
            expect(FilesystemTargetState.present().fold(cases)).toBeUndefined();
        }
    );

    test(
        "[P11-FILESYSTEM-PATHS] normalizes inside the root and publishes the fixed branchable detail codes",
        { tags: "p0" },
        () => {
            expect(normalizeFilesystemPath("/a//b/../c/./")).toBe("/a/c");
            for (const path of [
                "",
                "relative",
                "/../escape",
                "/a/../../escape",
                "/a\\b",
                "/a\0b"
            ]) {
                expect(() => normalizeFilesystemPath(path)).toThrow(FilesystemError);
            }
            expect(FILESYSTEM_ERROR_CODES).toEqual([
                "not-found",
                "exists",
                "not-a-directory",
                "is-a-directory",
                "path.invalid",
                "too-large",
                "content-mismatch"
            ]);
            expect(
                // @ts-expect-error Runtime rejection is required for a detail code excluded by the public type.
                () => new FilesystemError("outside", "/", "invalid")
            ).toThrow(TypeError);
        }
    );

    test(
        "[P11-FILESYSTEM-ATOMIC-WRITE] rejects oversized replacements and destructive moves without partial changes",
        { tags: "p0" },
        () => {
            const filesystem = new MemoryFilesystemBackend(1);
            filesystem.mkdir("/tree/child", true);
            filesystem.write("/tree/file", new Uint8Array([1]), FilesystemWriteMode.create);
            expect(() =>
                filesystem.write(
                    "/tree/file",
                    new Uint8Array([2, 3]),
                    FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([1])))
                )
            ).toThrow(expect.objectContaining({ detailCode: "too-large" }));
            expect(() => filesystem.move("/tree", "/tree/child/moved")).toThrow(
                expect.objectContaining({ detailCode: "path.invalid" })
            );
            expect([...filesystem.read("/tree/file")]).toEqual([1]);
        }
    );

    test(
        "[P11-FILESYSTEM-RANGES] rejects malformed ranges, paging, write modes, and node-kind conflicts",
        { tags: "p1" },
        () => {
            expect(() => new MemoryFilesystemBackend(-1)).toThrow(TypeError);
            const filesystem = new MemoryFilesystemBackend();
            filesystem.mkdir("/docs");
            filesystem.write("/docs/file", new Uint8Array([1, 2]), FilesystemWriteMode.create);

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

            expect(() =>
                filesystem.write("/docs", new Uint8Array(), FilesystemWriteMode.upsert)
            ).toThrow(expect.objectContaining({ detailCode: "is-a-directory" }));
            expect(() =>
                FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                    path: "/docs/file",
                    content: [],
                    mode: { name: "invalid" }
                })
            ).toThrow(expect.objectContaining({ detailCode: "operation.invalid-input" }));
            expect(() =>
                filesystem.write("/", new Uint8Array(), FilesystemWriteMode.upsert)
            ).toThrow(expect.objectContaining({ detailCode: "path.invalid" }));
            expect(() => filesystem.stat("/missing")).toThrow(
                expect.objectContaining({ detailCode: "not-found" })
            );
        }
    );

    test(
        "[P11-FILESYSTEM-MOVE] handles root, recursive creation, idempotent moves, and destination conflicts",
        { tags: "p1" },
        () => {
            const filesystem = new MemoryFilesystemBackend();
            filesystem.mkdir("/");
            expect(() => filesystem.mkdir("/missing/child")).toThrow(
                expect.objectContaining({ detailCode: "not-found" })
            );
            filesystem.mkdir("/missing/child", true);
            expect(() => filesystem.mkdir("/missing")).toThrow(
                expect.objectContaining({ detailCode: "exists" })
            );
            filesystem.write("/file", new Uint8Array(), FilesystemWriteMode.create);
            expect(() => filesystem.mkdir("/file")).toThrow(
                expect.objectContaining({ detailCode: "not-a-directory" })
            );
            expect(() => filesystem.mkdir("/file/child", true)).toThrow(
                expect.objectContaining({ detailCode: "not-a-directory" })
            );

            filesystem.move("/file", "/file");
            filesystem.write("/destination", new Uint8Array(), FilesystemWriteMode.create);
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
        }
    );

    test(
        "[P11-FILESYSTEM-MOVE-ASSERTIONS] rejects moves across mounts without changing either backend",
        { tags: "p0" },
        () => {
            const left = new MemoryFilesystemBackend();
            const right = new MemoryFilesystemBackend();
            left.write("/file", new Uint8Array([1]), FilesystemWriteMode.create);
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
        }
    );

    test(
        "round-trips every optional filesystem wire field and rejects malformed outputs",
        { tags: "p1" },
        () => {
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
            const guard = Digest.sha256(new Uint8Array([1]));
            const writeWire = FILESYSTEM_OPERATION_CONTRACTS.write.encodeInput({
                path: "/file",
                content: new Uint8Array([1]),
                mode: FilesystemWriteMode.replace(guard)
            });
            expect(writeWire).toEqual({
                path: "/file",
                content: [1],
                mode: { name: "replace", expected: guard.value }
            });
            const decodedWrite = FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput(writeWire);
            expect(decodedWrite).toEqual({
                path: "/file",
                content: new Uint8Array([1]),
                mode: FilesystemWriteMode.replace(guard)
            });
            expect(decodedWrite.mode?.name).toBe("replace");
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
            expect(() => FILESYSTEM_OPERATION_CONTRACTS.read.decodeOutput({})).toThrow(TypeError);
            expect(() => FILESYSTEM_OPERATION_CONTRACTS.list.decodeOutput({ entries: {} })).toThrow(
                TypeError
            );
            expect(() =>
                FILESYSTEM_OPERATION_CONTRACTS.stat.decodeOutput({
                    ...stat,
                    kind: "link"
                })
            ).toThrow(TypeError);
            expect(() =>
                FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                    path: "/file",
                    content: ["not-a-byte"]
                })
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
        }
    );

    test(
        "translates non-root mounts, records all effects, and rejects invalid mount topology",
        { tags: "p1" },
        () => {
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
                    backend: new ObservedFilesystemBackend(
                        new MemoryFilesystemBackend(),
                        observations
                    )
                }
            ]);
            mounted.mkdir("/work/docs");
            mounted.write("/work/docs/a", new Uint8Array([1]), FilesystemWriteMode.create);
            mounted.write("/work/docs/b", new Uint8Array([2]), FilesystemWriteMode.create);
            expect(mounted.stat("/work").path).toBe("/work");
            expect(mounted.read("/work/docs/a")).toEqual(new Uint8Array([1]));
            const first = mounted.list("/work/docs", undefined, 1);
            expect(first.cursor).toBe("/work/docs/a");
            expect(mounted.list("/work/docs", first.cursor, 1).entries[0]?.path).toBe(
                "/work/docs/b"
            );
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
        }
    );

    test(
        "[P11-FILESYSTEM-WRITE-GUARD-ATOMIC] rejects a guarded replace whose comparison passed before another write landed",
        { tags: "p0" },
        () => {
            for (const [name, create] of guardedWriteBackings()) {
                const store = create();
                store.mkdir("/atomic");
                const seeded = new Uint8Array([1, 2, 3]);
                store.write("/atomic/file", seeded, FilesystemWriteMode.create);
                const seam = new InterleavedFilesystemBackend(store);

                // The interleaving, not the sequential case: the comparison observes exactly
                // the content the guard names and passes, and only then does another write
                // land. The replacement must refuse rather than apply against content its
                // comparison never saw.
                seam.landBeforeReplacement(() =>
                    store.write("/atomic/file", new Uint8Array([9]), FilesystemWriteMode.upsert)
                );
                expectFilesystemDetail(
                    () =>
                        seam.write(
                            "/atomic/file",
                            new Uint8Array([4]),
                            FilesystemWriteMode.replace(Digest.sha256(seeded))
                        ),
                    "content-mismatch",
                    name
                );
                // The content present when the replacement would have run survived it.
                expect([...store.read("/atomic/file")], name).toEqual([9]);

                // The same window on the other branch of the target state: a landing write
                // that removes the target leaves a guard that named present content facing an
                // absent one, and `not-found` is the answer rather than a silent create.
                seam.landBeforeReplacement(() => store.remove("/atomic/file"));
                expectFilesystemDetail(
                    () =>
                        seam.write(
                            "/atomic/file",
                            new Uint8Array([5]),
                            FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([9])))
                        ),
                    "not-found",
                    name
                );
                expect(() => store.stat("/atomic/file"), name).toThrow(
                    expect.objectContaining({ detailCode: "not-found" })
                );

                // The window itself rejects nothing: with no write landing in it the same
                // guarded replace applies, so the two rejections above are the landing
                // write's doing and not an artefact of splitting the write in two.
                store.write("/atomic/file", new Uint8Array([9]), FilesystemWriteMode.create);
                seam.landBeforeReplacement(() => {});
                seam.write(
                    "/atomic/file",
                    new Uint8Array([7]),
                    FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([9])))
                );
                expect([...store.read("/atomic/file")], name).toEqual([7]);
            }

            // The seam reads the target to make the comparison observable, and `not-found`
            // is the only answer it may translate into an absent target. Every other answer
            // is about this write and reaches the caller unchanged, so a directory at the
            // target does not become a create and a failure that is not the profile's does
            // not become one.
            const store = new MemoryFilesystemBackend();
            store.mkdir("/atomic");
            const seam = new InterleavedFilesystemBackend(store);
            expectFilesystemDetail(
                () => seam.write("/atomic", new Uint8Array([1]), FilesystemWriteMode.create),
                "is-a-directory"
            );
            expectFilesystemDetail(
                () => seam.write("/../escape", new Uint8Array([1]), FilesystemWriteMode.upsert),
                "path.invalid"
            );
            expect(() =>
                new InterleavedFilesystemBackend(new UnreadableFilesystemBackend()).write(
                    "/opaque",
                    new Uint8Array([1]),
                    FilesystemWriteMode.upsert
                )
            ).toThrow(TypeError);
        }
    );

    test(
        "[P11-FILESYSTEM-WRITE-GUARD-ATOMIC] fails a host that discharges the guard at admission instead of at the atomic store step",
        { tags: "p0" },
        () => {
            const store = new MemoryFilesystemBackend();
            store.mkdir("/toctou");
            const observed = new Uint8Array([1]);
            store.write("/toctou/file", observed, FilesystemWriteMode.create);
            const guard = FilesystemWriteMode.replace(Digest.sha256(observed));
            const landing = (): void => {
                store.write("/toctou/file", new Uint8Array([2]), FilesystemWriteMode.upsert);
            };

            // The forbidden host: it discharges the guard while §7.3 preparation freezes the
            // intent, then trusts that discharge at effect time. Its comparison passes
            // against [1], the concurrent write lands [2], and it applies [3] anyway — a
            // write that passed a check against content it did not replace.
            const atAdmission = new AdmissionGuardedFilesystemBackend(store);
            atAdmission.landBeforeReplacement(landing);
            atAdmission.write("/toctou/file", new Uint8Array([3]), guard);
            expect([...store.read("/toctou/file")]).toEqual([3]);

            // The same interleave, with the guard discharged at the atomic store step: the
            // replacement refuses and the landing write's content stands. This is the outcome
            // the atom requires, and the clobber above is what requiring it rules out.
            store.write("/toctou/file", observed, FilesystemWriteMode.upsert);
            const atStore = new InterleavedFilesystemBackend(store);
            atStore.landBeforeReplacement(landing);
            expectFilesystemDetail(
                () => atStore.write("/toctou/file", new Uint8Array([3]), guard),
                "content-mismatch"
            );
            expect([...store.read("/toctou/file")]).toEqual([2]);

            // Sequentially the two hosts are indistinguishable — a stale guard fails both —
            // so the interleave is the only thing that separates them, and a conformance test
            // written as a sequential case would admit the forbidden one.
            const stale = FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([7])));
            for (const host of [atAdmission, atStore]) {
                expectFilesystemDetail(
                    () => host.write("/toctou/file", new Uint8Array([4]), stale),
                    "content-mismatch"
                );
            }
            expect([...store.read("/toctou/file")]).toEqual([2]);
        }
    );

    test(
        "[P11-FILESYSTEM-WRITE-GUARD-PORTABLE] presents one content-derived guard across backing stores and keeps stat free of a digest",
        { tags: "p0" },
        () => {
            const left = new MemoryFilesystemBackend();
            const right = new MemoryFilesystemBackend();
            const observations = new RecordingObservations();
            const mounted = new MountFilesystemBackend([
                { path: "/left", backend: left },
                { path: "/right", backend: new ObservedFilesystemBackend(right, observations) }
            ]);
            const shared = new Uint8Array([1, 2, 3]);
            mounted.mkdir("/left/docs");
            mounted.mkdir("/right/docs");
            mounted.write("/left/docs/file", shared, FilesystemWriteMode.create);
            mounted.write("/right/docs/file", shared, FilesystemWriteMode.create);

            // The guard is derived from content one backing store's read already returned...
            const guard = Digest.sha256(mounted.read("/left/docs/file"));
            // ...and it is meaningful against a different backing store holding identical
            // content. The mount routes this write to the other store, which is exactly where
            // a store-native version token would need translating and a content digest does
            // not.
            mounted.write(
                "/right/docs/file",
                new Uint8Array([9]),
                FilesystemWriteMode.replace(guard)
            );
            expect([...right.read("/docs/file")]).toEqual([9]);
            expect([...left.read("/docs/file")]).toEqual([1, 2, 3]);

            // Presented against different content on that same other store it rejects, so the
            // guard travelled without weakening.
            expectFilesystemDetail(
                () =>
                    mounted.write(
                        "/right/docs/file",
                        new Uint8Array([8]),
                        FilesystemWriteMode.replace(guard)
                    ),
                "content-mismatch"
            );
            expect([...right.read("/docs/file")]).toEqual([9]);

            // And the same guard still admits the write whose own store's content matches it,
            // so nothing about it was specific to where it was produced.
            mounted.write(
                "/left/docs/file",
                new Uint8Array([7]),
                FilesystemWriteMode.replace(guard)
            );
            expect([...left.read("/docs/file")]).toEqual([7]);

            // The negative obligation that keeps this affordable: `stat` is not extended to
            // report a content digest. It answers from metadata alone — the observed backing
            // records a stat and no read — and publishes exactly its four members, so the
            // cheap metadata Operation never pays a full read per call and the guard stays
            // something the caller derives from a read it already made.
            const before = observations.values.length;
            const stat = mounted.stat("/right/docs/file");
            expect(observations.values.slice(before).map((value) => value.operation)).toEqual([
                "stat"
            ]);
            expect(Object.keys(stat)).toEqual(["path", "kind", "size", "modifiedAt"]);
            expect(
                FILESYSTEM_OPERATION_CONTRACTS.stat.descriptor.output.accepts({
                    ...stat,
                    digest: guard.value
                })
            ).toBe(false);
        }
    );

    test(
        "[P11-FILESYSTEM-ERROR-CONTENT-MISMATCH] branches three ways and produces the seventh code from the guard alone",
        { tags: "p0" },
        () => {
            for (const [name, create] of guardedWriteBackings()) {
                const filesystem = create();
                filesystem.mkdir("/codes");
                const content = new Uint8Array([1, 2, 3]);

                // An absent target answers `not-found`, and the recovery it names is to
                // create.
                expectFilesystemDetail(
                    () =>
                        filesystem.write(
                            "/codes/file",
                            content,
                            FilesystemWriteMode.replace(Digest.sha256(content))
                        ),
                    "not-found",
                    name
                );
                filesystem.write("/codes/file", content, FilesystemWriteMode.create);

                // A present target whose content differs answers `content-mismatch`, and the
                // recovery it names is to re-read and guard against what the read returned.
                // A host collapsing this case into either neighbour would pass a two-way test
                // and deny the caller exactly this recovery.
                expectFilesystemDetail(
                    () =>
                        filesystem.write(
                            "/codes/file",
                            new Uint8Array([4]),
                            FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([9])))
                        ),
                    "content-mismatch",
                    name
                );
                filesystem.write(
                    "/codes/file",
                    new Uint8Array([4]),
                    FilesystemWriteMode.replace(Digest.sha256(filesystem.read("/codes/file")))
                );
                expect([...filesystem.read("/codes/file")], name).toEqual([4]);

                // A `create` over a present target answers `exists`.
                expectFilesystemDetail(
                    () => filesystem.write("/codes/file", content, FilesystemWriteMode.create),
                    "exists",
                    name
                );
            }

            // The guard is the code's only producer. Every mode owns its own precondition,
            // and only the `replace` comparison rejects with the seventh member: `create`
            // answers `exists`, a guard facing an absent target answers `not-found`, and
            // `upsert` refuses nothing at all.
            const present = FilesystemTargetState.present(new Uint8Array([1]));
            expectFilesystemDetail(
                () =>
                    FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([2]))).requireWritable(
                        "/codes/file",
                        present
                    ),
                "content-mismatch"
            );
            FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([1]))).requireWritable(
                "/codes/file",
                present
            );
            expectFilesystemDetail(
                () =>
                    FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([1]))).requireWritable(
                        "/codes/file",
                        FilesystemTargetState.absent
                    ),
                "not-found"
            );
            expectFilesystemDetail(
                () => FilesystemWriteMode.create.requireWritable("/codes/file", present),
                "exists"
            );
            FilesystemWriteMode.create.requireWritable("/codes/file", FilesystemTargetState.absent);
            for (const target of [present, FilesystemTargetState.absent]) {
                FilesystemWriteMode.upsert.requireWritable("/codes/file", target);
            }

            // Nothing else reaches for it either: every remaining member of the fixed set has
            // its own producer, and driving all six shows each answering with its own code,
            // so a caller that sees `content-mismatch` knows a guarded comparison failed.
            const filesystem = new MemoryFilesystemBackend(1);
            filesystem.mkdir("/dir");
            filesystem.write("/file", new Uint8Array([1]), FilesystemWriteMode.create);
            const elsewhere: ReadonlyArray<readonly [FilesystemErrorCode, () => void]> = [
                ["not-found", () => filesystem.read("/missing")],
                ["exists", () => filesystem.mkdir("/dir")],
                ["not-a-directory", () => filesystem.list("/file")],
                ["is-a-directory", () => filesystem.read("/dir")],
                [
                    "path.invalid",
                    () => filesystem.write("/", new Uint8Array(), FilesystemWriteMode.upsert)
                ],
                [
                    "too-large",
                    () =>
                        filesystem.write(
                            "/file",
                            new Uint8Array([1, 2]),
                            FilesystemWriteMode.upsert
                        )
                ]
            ];
            for (const [code, rejection] of elsewhere) {
                expectFilesystemDetail(rejection, code, code);
            }
            expect(elsewhere.map(([code]) => code).toSorted()).toEqual(
                FILESYSTEM_ERROR_CODES.filter((code) => code !== "content-mismatch").toSorted()
            );
        }
    );
});

describe("Filesystem memory backend boundaries", () => {
    test("accepts a zero byte limit and enforces it exactly", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend(0);
        filesystem.write("/empty", new Uint8Array(), FilesystemWriteMode.create);
        expect(filesystem.stat("/empty").size).toBe(0);
        expect(() =>
            filesystem.write("/full", new Uint8Array([1]), FilesystemWriteMode.create)
        ).toThrow(expect.objectContaining({ detailCode: "too-large" }));
    });

    test("omits the cursor on final pages and copies written content", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend();
        filesystem.mkdir("/docs");
        filesystem.write("/docs/a", new Uint8Array([1]), FilesystemWriteMode.create);
        filesystem.write("/docs/b", new Uint8Array([2]), FilesystemWriteMode.create);
        expect(Object.keys(filesystem.list("/docs"))).toEqual(["entries"]);
        expect(Object.keys(filesystem.list("/docs", undefined, 2))).toEqual(["entries"]);
        const first = filesystem.list("/docs", undefined, 1);
        expect(first.cursor).toBe("/docs/a");
        const second = filesystem.list("/docs", first.cursor, 1);
        expect(second.entries.map((entry) => entry.path)).toEqual(["/docs/b"]);
        expect(Object.keys(second)).toEqual(["entries"]);

        const content = new Uint8Array([1, 2]);
        filesystem.write("/docs/copy", content, FilesystemWriteMode.create);
        content[0] = 9;
        expect([...filesystem.read("/docs/copy")]).toEqual([1, 2]);
    });

    test("replaces and upserts existing files with the new content", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend();
        filesystem.write("/file", new Uint8Array([1]), FilesystemWriteMode.create);
        filesystem.write(
            "/file",
            new Uint8Array([9]),
            FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([1])))
        );
        expect([...filesystem.read("/file")]).toEqual([9]);
        filesystem.write("/file", new Uint8Array([7]), FilesystemWriteMode.upsert);
        expect([...filesystem.read("/file")]).toEqual([7]);
        // The unobserved overwrite of a fresh target is still a declaration: `upsert` is
        // named because nothing mints it when a caller stays silent.
        filesystem.write("/fresh", new Uint8Array([5]), FilesystemWriteMode.upsert);
        expect([...filesystem.read("/fresh")]).toEqual([5]);
    });

    test(
        "discharges each write mode's existence precondition by construction",
        { tags: "p1" },
        () => {
            const filesystem = new MemoryFilesystemBackend();
            filesystem.write("/present", new Uint8Array([1]), FilesystemWriteMode.create);
            expect(() =>
                filesystem.write("/present", new Uint8Array([2]), FilesystemWriteMode.create)
            ).toThrow(expect.objectContaining({ detailCode: "exists" }));
            expect(() =>
                filesystem.write(
                    "/absent",
                    new Uint8Array([2]),
                    FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([2])))
                )
            ).toThrow(expect.objectContaining({ detailCode: "not-found" }));
            filesystem.write("/absent", new Uint8Array([3]), FilesystemWriteMode.create);
            filesystem.write(
                "/present",
                new Uint8Array([4]),
                FilesystemWriteMode.replace(Digest.sha256(new Uint8Array([1])))
            );
            filesystem.write("/present", new Uint8Array([5]), FilesystemWriteMode.upsert);
            filesystem.write("/fresh", new Uint8Array([6]), FilesystemWriteMode.upsert);
            expect([...filesystem.read("/present")]).toEqual([5]);

            // The base publishes no default precondition, so every case must supply its own.
            expect(FilesystemWriteMode.prototype).not.toHaveProperty("requireWritable");
            // @ts-expect-error A write mode without its own existence precondition is illegal.
            class UnregisteredWriteMode extends FilesystemWriteMode {
                public readonly name = "unregistered";
            }

            for (const mode of [FilesystemWriteMode.create, FilesystemWriteMode.upsert]) {
                const wire = FILESYSTEM_OPERATION_CONTRACTS.write.encodeInput({
                    path: "/present",
                    content: new Uint8Array(),
                    mode
                });
                expect(FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput(wire).mode).toBe(mode);
            }
            expect(() =>
                FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                    path: "/present",
                    content: [],
                    mode: { name: new UnregisteredWriteMode().name }
                })
            ).toThrow(expect.objectContaining({ detailCode: "operation.invalid-input" }));
        }
    );

    test("removes and moves exactly the named subtree", { tags: "p1" }, () => {
        const filesystem = new MemoryFilesystemBackend();
        filesystem.mkdir("/dir");
        filesystem.write("/dir/inner", new Uint8Array([1]), FilesystemWriteMode.create);
        filesystem.write("/dirfile", new Uint8Array([2]), FilesystemWriteMode.create);
        filesystem.remove("/dir");
        expect(() => filesystem.stat("/dir")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
        expect(() => filesystem.stat("/dir/inner")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
        expect([...filesystem.read("/dirfile")]).toEqual([2]);

        filesystem.mkdir("/src");
        filesystem.write("/src/f", new Uint8Array([3]), FilesystemWriteMode.create);
        filesystem.write("/srcfile", new Uint8Array([4]), FilesystemWriteMode.create);
        filesystem.move("/src", "/moved");
        expect([...filesystem.read("/moved/f")]).toEqual([3]);
        expect(() => filesystem.stat("/src")).toThrow(
            expect.objectContaining({ detailCode: "not-found" })
        );
        expect([...filesystem.read("/srcfile")]).toEqual([4]);
        expect([...filesystem.read("/dirfile")]).toEqual([2]);
    });

    test(
        "reports a file parent as not-a-directory when moving under a file",
        { tags: "p1" },
        () => {
            const filesystem = new MemoryFilesystemBackend();
            filesystem.write("/plain", new Uint8Array([1]), FilesystemWriteMode.create);
            expect(() => filesystem.move("/plain", "/plain/child")).toThrow(
                expect.objectContaining({ detailCode: "not-a-directory" })
            );
        }
    );

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
        filesystem.write("/file", new Uint8Array([1]), FilesystemWriteMode.create);
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
        expect(() =>
            filesystem.write("/file", new Uint8Array([1, 2]), FilesystemWriteMode.upsert)
        ).toThrow("File exceeds the configured size limit");
        expect(() =>
            filesystem.write("/dir", new Uint8Array(), FilesystemWriteMode.upsert)
        ).toThrow("Path is a directory");
        expect(() =>
            filesystem.write("/file", new Uint8Array(), FilesystemWriteMode.create)
        ).toThrow("Path already exists");
        expect(() =>
            filesystem.write(
                "/missing",
                new Uint8Array(),
                FilesystemWriteMode.replace(Digest.sha256(new Uint8Array()))
            )
        ).toThrow("Path does not exist");
        expect(() =>
            FILESYSTEM_OPERATION_CONTRACTS.write.decodeInput({
                path: "/file",
                content: [],
                mode: { name: "invalid" }
            })
        ).toThrow("Write mode must be create, replace, or upsert");
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
        filesystem.write("/f", new Uint8Array([1]), FilesystemWriteMode.create);
        filesystem.move("/f", "/g");
        expect(observations.values).toEqual([
            { operation: "write", paths: ["/f"] },
            { operation: "move", paths: ["/f", "/g"] }
        ]);
    });

    test(
        "resolves the longest mount prefix regardless of declaration order",
        { tags: "p1" },
        () => {
            const outer = new MemoryFilesystemBackend();
            const inner = new MemoryFilesystemBackend();
            const mounted = new MountFilesystemBackend([
                { path: "/a", backend: outer },
                { path: "/a/b", backend: inner }
            ]);
            mounted.write("/a/b/f", new Uint8Array([1]), FilesystemWriteMode.create);
            expect([...inner.read("/f")]).toEqual([1]);
            expect(() => outer.stat("/b")).toThrow(
                expect.objectContaining({ detailCode: "not-found" })
            );
            expect([...mounted.read("/a/b/f")]).toEqual([1]);
        }
    );

    test("keeps final mount pages cursorless and refuses foreign cursors", { tags: "p1" }, () => {
        const mounted = new MountFilesystemBackend([
            { path: "/a", backend: new MemoryFilesystemBackend() },
            { path: "/b", backend: new MemoryFilesystemBackend() }
        ]);
        mounted.mkdir("/a/docs");
        mounted.write("/a/docs/f", new Uint8Array([1]), FilesystemWriteMode.create);
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
        await execute("write", { path: "/docs/a", content: [1, 2, 3], mode: { name: "create" } });
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

/** A backing whose failure is not the profile's, so nothing may retell it as an answer. */
class UnreadableFilesystemBackend extends FilesystemBackend {
    public read(): Uint8Array {
        throw new TypeError("Backing store is unreadable");
    }
    public stat(): FilesystemStat {
        throw new TypeError("Backing store is unreadable");
    }
    public list(): FilesystemPage {
        throw new TypeError("Backing store is unreadable");
    }
    public write(): void {
        throw new TypeError("Backing store is unreadable");
    }
    public remove(): void {
        throw new TypeError("Backing store is unreadable");
    }
    public move(): void {
        throw new TypeError("Backing store is unreadable");
    }
    public mkdir(): void {
        throw new TypeError("Backing store is unreadable");
    }
}

/**
 * The host `P11-FILESYSTEM-WRITE-GUARD-ATOMIC` rules out. It discharges the guard while it
 * prepares the write — §7.3's freeze of the intent — and then trusts that discharge at effect
 * time by reaching the store unguarded, so the replacement it applies is authorized by a
 * comparison against content it may no longer be replacing. It exists here so the conformance
 * assertions above are known to fail it rather than merely to pass the conforming seam.
 */
class AdmissionGuardedFilesystemBackend extends InterleavedFilesystemBackend {
    public constructor(private readonly prepareAgainst: FilesystemBackend) {
        super(prepareAgainst);
    }

    public override write(path: string, content: Uint8Array, mode: FilesystemWriteMode): void {
        // Preparation: the precondition is discharged against what the target holds while
        // the intent is being frozen.
        mode.requireWritable(path, this.prepared(path));
        // Effect: the store step carries `upsert`, so the discharge above is the only one
        // that ever happened and nothing re-checks the content being replaced.
        super.write(path, content, FilesystemWriteMode.upsert);
    }

    private prepared(path: string): FilesystemTargetState {
        try {
            return FilesystemTargetState.present(this.prepareAgainst.read(path));
        } catch {
            return FilesystemTargetState.absent;
        }
    }
}

/**
 * A Workspace policy that resolves on the declared write mode rather than only on the
 * Operation. Every `write` carries `mutate` impact whichever mode it names, so a policy meant
 * to refuse the unobserved overwrite has to read the mode out of the admitted intent — which
 * it can, because the mode is part of that intent and never a default the host supplies. The
 * refusal happens during preparation, before any effect runs.
 */
class UpsertRefusingAdmission extends RecordingProfileAdmission {
    public override async invoke(
        request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<TestReceipt>> {
        const input = request.input;
        const mode = isFacetDataMap(input) ? input["mode"] : undefined;
        if (
            request.operation.descriptor.name.value === "write" &&
            isFacetDataMap(mode) &&
            mode["name"] === "upsert"
        ) {
            throw new DetailedProfileError(
                "authority.denied",
                "runtime.denied",
                "Workspace policy refuses an unobserved overwrite"
            );
        }
        return super.invoke(request);
    }
}

function upsertRefusingRuntime() {
    const admission = new UpsertRefusingAdmission();
    const runtime = new ProtectedProfileRuntimePort(
        new ProfileRuntimeHostBinding(
            new FacetRef("profile:filesystem"),
            new BindingName("filesystem")
        ),
        admission,
        new RecordingProfileEffects(admission.calls, admission.handlerOutputs)
    );
    runtime.activate();
    return { admission, runtime };
}

function guardedWriteBackings(): ReadonlyArray<readonly [string, () => FilesystemBackend]> {
    return [
        ["memory", () => new MemoryFilesystemBackend()],
        [
            "observed",
            () =>
                new ObservedFilesystemBackend(new MemoryFilesystemBackend(), new NullObservations())
        ],
        [
            "mount",
            () =>
                new MountFilesystemBackend([{ path: "/", backend: new MemoryFilesystemBackend() }])
        ]
    ];
}

function expectFilesystemDetail(
    action: () => void,
    detailCode: FilesystemError["detailCode"] | "operation.invalid-input",
    label?: string
): void {
    expect(action, label).toThrow(expect.objectContaining({ detailCode }));
}

function readerAndSeed(filesystem: FilesystemBackend) {
    return { reader: filesystem, seed: filesystem };
}

function runFilesystemReaderContract(
    reader: FilesystemReaderBackend,
    seed: FilesystemBackend,
    label = "filesystem"
): void {
    seed.mkdir("/suite");
    seed.write("/suite/b", new Uint8Array([1, 2, 3]), FilesystemWriteMode.create);
    seed.write("/suite/a", new Uint8Array([4]), FilesystemWriteMode.create);
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
    filesystem.write("/mutable/file", new Uint8Array([1]), FilesystemWriteMode.create);
    expect(
        () => filesystem.write("/mutable/file", new Uint8Array(), FilesystemWriteMode.create),
        label
    ).toThrow(expect.objectContaining({ detailCode: "exists" }));
    filesystem.move("/mutable/file", "/mutable/moved");
    expect([...filesystem.read("/mutable/moved")], label).toEqual([1]);
    filesystem.remove("/mutable/moved");
    expect(() => filesystem.stat("/mutable/moved"), label).toThrow(
        expect.objectContaining({ detailCode: "not-found" })
    );
}

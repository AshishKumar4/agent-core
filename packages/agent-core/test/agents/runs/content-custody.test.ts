import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { ActorId, ActorRef } from "../../../src/actors";
import {
    RunCheckpoint,
    RunCheckpointId,
    RunCommit,
    RunCommitId,
    RunId,
    RunRepository,
    RunStoragePort,
    type RunTransaction,
    SpawnReservation,
    SpawnReservationId,
    Turn,
    TurnId,
    TurnInboxEntry,
    TurnInboxEntryId
} from "../../../src/agents/runs";
import {
    ContentOwnerEdge,
    contentOwnerKey,
    MemoryContentStore,
    type ContentStore
} from "../../../src/content";
import { ContentRef, Digest, Revision, compareCanonicalText } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { TenantId } from "../../../src/identity";
import { AuditRecordId, InvocationId } from "../../../src/interaction-references";
import { ReceiptId } from "../../../src/invocation-references";
import { MemoryRunStorage, type MemoryRunStorageSnapshot } from "../../../src/agents/runs/memory";
import { SpawnAttenuation } from "../../../src/agents/runs/ceiling";
import {
    SqliteContentStore,
    SqliteRunStorage,
    type SqliteRow,
    type SqliteValue,
    TransactionalSqlite
} from "../../../src/substrates";
import { FileSqlite, TestSqlite } from "../../helpers/sqlite";
import { callableRecord, malformed } from "../../helpers/malformed";
import { attenuationDigest, ids, pins } from "./fixture";

const tenant = new TenantId("run-custody-tenant");
const owner = new ActorRef("workspace", new ActorId("run-custody-owner"));
const clock = () => new Date(10);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

interface CustodyHarness {
    readonly content: ContentStore;
    readonly repository: RunRepository<RunTransaction>;
    readonly storage: RunStoragePort<RunTransaction>;
    ownerEdges(): readonly ContentOwnerEdge[];
    transaction<Result>(operation: (transaction: RunTransaction) => Result): Result;
}

function memoryHarness(
    snapshot?: MemoryRunStorageSnapshot,
    now: () => Date = clock
): CustodyHarness & {
    readonly storage: MemoryRunStorage;
} {
    const storage = new MemoryRunStorage(tenant, owner, snapshot, now);
    const repository = new RunRepository(storage);
    return {
        content: storage.content,
        ownerEdges: () =>
            storage.snapshot().content.edges.map((bytes) => ContentOwnerEdge.decode(bytes)),
        repository,
        storage,
        transaction: (operation) =>
            repository.transaction((transaction) => ({ value: operation(transaction) })).value
    };
}

function sqliteHarness(
    database: TransactionalSqlite,
    now: () => Date = clock
): CustodyHarness & {
    readonly storage: SqliteRunStorage;
} {
    const storage = new SqliteRunStorage(database, tenant, owner, now);
    const repository = new RunRepository(storage);
    return {
        content: storage.content,
        ownerEdges: () =>
            database
                .all("SELECT record FROM content_owner_edges ORDER BY owner_key", [])
                .map((row) => decodeOwnerEdge(row["record"])),
        repository,
        storage,
        transaction: (operation) =>
            repository.transaction((transaction) => ({ value: operation(transaction) })).value
    };
}

class DuplicateOwnerEdgeSqlite extends TestSqlite {
    public duplicateOwnerEdges = false;

    protected override query(
        statement: string,
        bindings: readonly SqliteValue[]
    ): readonly SqliteRow[] {
        const rows = super.query(statement, bindings);
        return this.duplicateOwnerEdges &&
            statement.includes("FROM content_owner_edges") &&
            rows[0] !== undefined
            ? [rows[0], rows[0]]
            : rows;
    }
}

class DamagedSqlite extends TestSqlite {
    public damage(statement: string, bindings: readonly SqliteValue[] = []): void {
        this.execute(statement, bindings);
    }
}

function custodyContract(
    name: string,
    create: (now?: () => Date) => CustodyHarness,
    nestedCode: AgentCoreError["code"]
): void {
    describe(`Run content custody on ${name}`, () => {
        test(
            "registers every Run record ContentRef from immutable record-adjacent projections",
            { tags: "p0" },
            async () => {
                const harness = create();
                const refs = {
                    checkpointState: await putRef(harness.content, "checkpoint-state"),
                    checkpointTree: await putRef(harness.content, "checkpoint-tree"),
                    commitContent: await putRef(harness.content, "commit-content"),
                    commitTree: await putRef(harness.content, "commit-tree"),
                    mergeContent: await putRef(harness.content, "merge-content"),
                    mergeTree: await putRef(harness.content, "merge-tree"),
                    mergeBase: await putRef(harness.content, "merge-base"),
                    spawnRoot: await putRef(harness.content, "spawn-root"),
                    turnInput: await putRef(harness.content, "turn-input"),
                    turnResult: await putRef(harness.content, "turn-result"),
                    inboxPayload: await putRef(harness.content, "inbox-payload"),
                    unrelated: await putRef(harness.content, "unrelated")
                };
                const turn = turnRecord(refs.turnInput);
                const checkpoint = new RunCheckpoint(
                    new RunCheckpointId("custody-checkpoint"),
                    turn.id,
                    ids.root,
                    refs.checkpointState,
                    0,
                    refs.checkpointTree
                );
                const commit = turnCommit(
                    new RunCommitId("custody-commit"),
                    refs.commitContent,
                    refs.commitTree
                );
                const merge = mergeCommit(refs.mergeContent, refs.mergeTree, refs.mergeBase);
                const spawn = spawnReservation(refs.spawnRoot);
                const inbox = inboxEntry(turn.id, refs.inboxPayload);

                harness.transaction((transaction) => {
                    harness.repository.insertCheckpoint(transaction, checkpoint);
                    harness.repository.insertCommit(transaction, commit);
                    harness.repository.insertCommit(transaction, merge);
                    harness.repository.insertSpawn(transaction, spawn);
                    harness.repository.insertTurn(transaction, turn);
                    harness.repository.insertInbox(transaction, inbox);
                });

                const claimed = turn.claim(ids.holder, new Date(20), new Date(100));
                const token = {
                    turn: claimed.id,
                    holder: ids.holder,
                    epoch: claimed.lease.epoch
                };
                const completed = claimed.complete(
                    token,
                    "succeeded",
                    refs.turnResult,
                    new Date(30)
                );
                harness.transaction((transaction) => {
                    harness.repository.replaceTurn(transaction, turn.revision, claimed);
                    harness.repository.replaceTurn(transaction, claimed.revision, completed);
                    harness.repository.insertCommit(transaction, commit);
                    harness.repository.insertInbox(transaction, inbox);
                });

                const expectedRefs = Object.values(refs).filter(
                    (ref) => !ref.equals(refs.unrelated)
                );
                expect(
                    harness
                        .ownerEdges()
                        .map((edge) => edge.ref.value)
                        .sort()
                ).toEqual(expectedRefs.map((ref) => ref.value).sort());
                expect(expectedRefs).toHaveLength(11);
                for (const ref of Object.values(refs)) {
                    await expect(harness.content.get(ref)).resolves.toBeInstanceOf(Uint8Array);
                }
            }
        );

        test(
            "rolls back a record and earlier field edges when a later field is missing",
            { tags: "p0" },
            async () => {
                const harness = create();
                const stateBytes = encode("partial-state");
                const state = (await harness.content.put(stateBytes)).ref;
                const missingTreeBytes = encode("partial-tree");
                const missingTree = ContentRef.fromDigest(Digest.sha256(missingTreeBytes));
                const checkpoint = new RunCheckpoint(
                    new RunCheckpointId("partial-checkpoint"),
                    ids.turn,
                    ids.root,
                    state,
                    0,
                    missingTree
                );

                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.repository.insertCheckpoint(transaction, checkpoint)
                        ),
                    "content.not-found"
                );
                expect(
                    harness.transaction((transaction) =>
                        harness.repository.loadCheckpoint(transaction, checkpoint.id)
                    )
                ).toBeUndefined();

                expect(harness.ownerEdges()).toEqual([]);

                await harness.content.put(stateBytes);
                await harness.content.put(missingTreeBytes);
                harness.transaction((transaction) =>
                    harness.repository.insertCheckpoint(transaction, checkpoint)
                );
                expect(
                    harness
                        .ownerEdges()
                        .map((edge) => edge.ref.value)
                        .sort()
                ).toEqual([state.value, missingTree.value].sort());
            }
        );

        test(
            "rolls back a Turn CAS when its newly named result is missing",
            { tags: "p0" },
            async () => {
                const harness = create();
                const input = (await harness.content.put(encode("cas-input"))).ref;
                const resultBytes = encode("cas-result");
                const result = ContentRef.fromDigest(Digest.sha256(resultBytes));
                const initial = turnRecord(input);
                const claimed = initial.claim(ids.holder, new Date(20), new Date(100));
                const completed = claimed.complete(
                    { turn: claimed.id, holder: ids.holder, epoch: claimed.lease.epoch },
                    "succeeded",
                    result,
                    new Date(30)
                );
                harness.transaction((transaction) => {
                    harness.repository.insertTurn(transaction, initial);
                    harness.repository.replaceTurn(transaction, initial.revision, claimed);
                });

                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) =>
                            harness.repository.replaceTurn(transaction, claimed.revision, completed)
                        ),
                    "content.not-found"
                );
                const afterFailure = harness.transaction((transaction) =>
                    harness.repository.loadTurn(transaction, initial.id)
                );
                expect(afterFailure?.revision.value).toBe(claimed.revision.value);
                expect(afterFailure?.result).toBeUndefined();
                expect(harness.ownerEdges().map((edge) => edge.ref.value)).toEqual([input.value]);

                await harness.content.put(resultBytes);
                harness.transaction((transaction) =>
                    harness.repository.replaceTurn(transaction, claimed.revision, completed)
                );
                expect(
                    harness
                        .ownerEdges()
                        .map((edge) => edge.ref.value)
                        .sort()
                ).toEqual([input.value, result.value].sort());
            }
        );

        test(
            "releases replaced record content before retaining its successor",
            { tags: "p0" },
            async () => {
                const harness = create();
                const first = (await harness.content.put(encode("replacement-first"))).ref;
                const second = (await harness.content.put(encode("replacement-second"))).ref;
                const initial = turnRecord(first);
                const replacement = turnRecord(second, new Revision(1));

                harness.transaction((transaction) => {
                    harness.storage.insert(transaction, {
                        kind: "turn",
                        key: initial.id.value,
                        revision: initial.revision.value,
                        bytes: Turn.codec.encode(initial)
                    });
                });
                harness.transaction((transaction) => {
                    harness.storage.replace(
                        transaction,
                        {
                            kind: "turn",
                            key: replacement.id.value,
                            revision: replacement.revision.value,
                            bytes: Turn.codec.encode(replacement)
                        },
                        initial.revision.value
                    );
                });

                expect(harness.ownerEdges().map((edge) => edge.ref.value)).toEqual([second.value]);
                const stored = harness.transaction((transaction) =>
                    harness.repository.loadTurn(transaction, initial.id)
                );
                expect(stored?.input.equals(second)).toBe(true);
                expect(stored?.revision.value).toBe(1);
            }
        );

        test(
            "restores released custody when replacement retention fails",
            { tags: "p0" },
            async () => {
                const harness = create();
                const first = (await harness.content.put(encode("rollback-first"))).ref;
                const missingBytes = encode("rollback-missing");
                const missing = ContentRef.fromDigest(Digest.sha256(missingBytes));
                const initial = turnRecord(first);
                const replacement = turnRecord(missing, new Revision(1));

                harness.transaction((transaction) => {
                    harness.storage.insert(transaction, {
                        kind: "turn",
                        key: initial.id.value,
                        revision: initial.revision.value,
                        bytes: Turn.codec.encode(initial)
                    });
                });

                expectAgentCoreError(
                    () =>
                        harness.transaction((transaction) => {
                            harness.storage.replace(
                                transaction,
                                {
                                    kind: "turn",
                                    key: replacement.id.value,
                                    revision: replacement.revision.value,
                                    bytes: Turn.codec.encode(replacement)
                                },
                                initial.revision.value
                            );
                        }),
                    "content.not-found"
                );

                expect(harness.ownerEdges().map((edge) => edge.ref.value)).toEqual([first.value]);
                const stored = harness.transaction((transaction) =>
                    harness.repository.loadTurn(transaction, initial.id)
                );
                expect(stored?.input.equals(first)).toBe(true);
                expect(stored?.revision.value).toBe(0);
            }
        );

        test(
            "raw storage writes retain their record content atomically",
            { tags: "p0" },
            async () => {
                const harness = create();
                const input = (await harness.content.put(encode("raw-storage-input"))).ref;
                const result = (await harness.content.put(encode("raw-storage-result"))).ref;
                const turn = turnRecord(input);
                const claimed = turn.claim(ids.holder, new Date(20), new Date(100));
                const completed = claimed.complete(
                    { turn: claimed.id, holder: ids.holder, epoch: claimed.lease.epoch },
                    "succeeded",
                    result,
                    new Date(30)
                );

                harness.transaction((transaction) => {
                    harness.storage.insert(transaction, {
                        kind: "turn",
                        key: turn.id.value,
                        revision: turn.revision.value,
                        bytes: Turn.codec.encode(turn)
                    });
                    harness.storage.replace(
                        transaction,
                        {
                            kind: "turn",
                            key: claimed.id.value,
                            revision: claimed.revision.value,
                            bytes: Turn.codec.encode(claimed)
                        },
                        turn.revision.value
                    );
                    harness.storage.replace(
                        transaction,
                        {
                            kind: "turn",
                            key: completed.id.value,
                            revision: completed.revision.value,
                            bytes: Turn.codec.encode(completed)
                        },
                        claimed.revision.value
                    );
                });

                expect(
                    harness
                        .ownerEdges()
                        .map((edge) => edge.ref.value)
                        .sort()
                ).toEqual([input.value, result.value].sort());
                await expect(harness.content.get(input)).resolves.toEqual(
                    encode("raw-storage-input")
                );
                await expect(harness.content.get(result)).resolves.toEqual(
                    encode("raw-storage-result")
                );
            }
        );

        test("raw storage retention ignores public codec redirection", { tags: "p0" }, async () => {
            const harness = create();
            const state = (await harness.content.put(encode("redirected-codec-state"))).ref;
            const checkpoint = new RunCheckpoint(
                new RunCheckpointId("redirected-codec-checkpoint"),
                ids.turn,
                ids.root,
                state,
                0,
                undefined
            );
            const bytes = RunCheckpoint.codec.encode(checkpoint);
            const forged = Object.assign(() => undefined, { id: checkpoint.id });
            const redirected = Reflect.defineProperty(RunCheckpoint.codec, "decode", {
                configurable: true,
                value: () => callableRecord<RunCheckpoint>(forged),
                writable: true
            });
            try {
                harness.transaction((transaction) =>
                    harness.storage.insert(transaction, {
                        kind: "checkpoint",
                        key: checkpoint.id.value,
                        revision: null,
                        bytes
                    })
                );
            } finally {
                if (redirected) Reflect.deleteProperty(RunCheckpoint.codec, "decode");
            }

            expect(harness.ownerEdges().map((edge) => edge.ref.value)).toEqual([state.value]);
        });

        test(
            "raw storage retention ignores public record decoder redirection",
            { tags: "p0" },
            async () => {
                const harness = create();
                const state = (await harness.content.put(encode("redirected-record-state"))).ref;
                const checkpoint = new RunCheckpoint(
                    new RunCheckpointId("redirected-record-checkpoint"),
                    ids.turn,
                    ids.root,
                    state,
                    0,
                    undefined
                );
                const bytes = RunCheckpoint.codec.encode(checkpoint);
                const fromData = Object.getOwnPropertyDescriptor(RunCheckpoint, "fromData");
                if (fromData === undefined) throw new TypeError("RunCheckpoint.fromData is absent");
                const forged = Object.assign(() => undefined, { id: checkpoint.id });
                const redirected = Reflect.defineProperty(RunCheckpoint, "fromData", {
                    ...fromData,
                    value: () => callableRecord<RunCheckpoint>(forged)
                });
                expect(redirected).toBe(false);
                try {
                    harness.transaction((transaction) =>
                        harness.storage.insert(transaction, {
                            kind: "checkpoint",
                            key: checkpoint.id.value,
                            revision: null,
                            bytes
                        })
                    );
                } finally {
                    if (redirected) Object.defineProperty(RunCheckpoint, "fromData", fromData);
                }

                const stored = harness.transaction((transaction) =>
                    harness.storage.get(transaction, "checkpoint", checkpoint.id.value)
                );
                if (stored === undefined) throw new TypeError("Stored checkpoint is absent");
                expect(RunCheckpoint.codec.decode(stored.bytes).state.value).toBe(state.value);
                expect(harness.ownerEdges().map((edge) => edge.ref.value)).toEqual([state.value]);
            }
        );

        test(
            "cannot commit a partial raw write after catching a custody failure",
            { tags: "p0" },
            () => {
                const harness = create();
                const missing = ContentRef.fromDigest(Digest.sha256(encode("caught-missing")));
                const turn = turnRecord(missing);
                let caught: AgentCoreError | undefined;

                const escaped = captureError(() =>
                    harness.transaction((transaction) => {
                        try {
                            harness.storage.insert(transaction, {
                                kind: "turn",
                                key: turn.id.value,
                                revision: turn.revision.value,
                                bytes: Turn.codec.encode(turn)
                            });
                        } catch (error) {
                            if (!(error instanceof AgentCoreError)) throw error;
                            caught = error;
                        }
                    })
                );

                expect(escaped).toBe(caught);
                expect(escaped).toBeInstanceOf(AgentCoreError);
                if (escaped instanceof AgentCoreError) {
                    expect(escaped.code).toBe("content.not-found");
                }
                expect(
                    harness.transaction((transaction) =>
                        harness.repository.loadTurn(transaction, turn.id)
                    )
                ).toBeUndefined();
                expect(harness.ownerEdges()).toEqual([]);
            }
        );

        test(
            "rolls back a commit and its custody when a caught parent conflict follows the record",
            { tags: "p0" },
            async () => {
                const harness = create();
                const content = (await harness.content.put(encode("parent-conflict-content"))).ref;
                const tree = (await harness.content.put(encode("parent-conflict-tree"))).ref;
                const commit = mergeCommit(content, tree, content);
                harness.transaction((transaction) =>
                    harness.storage.insertParent(transaction, {
                        commit: commit.id.value,
                        ordinal: 0,
                        parent: "conflicting-parent"
                    })
                );
                let caught: Error | undefined;

                const escaped = captureError(() =>
                    harness.transaction((transaction) => {
                        try {
                            harness.repository.insertCommit(transaction, commit);
                        } catch (error) {
                            if (!(error instanceof Error)) throw error;
                            caught = error;
                        }
                    })
                );

                expect(escaped).toBe(caught);
                expectAgentCoreError(() => {
                    throw escaped;
                }, "run.invalid-state");
                expect(
                    harness.transaction((transaction) =>
                        harness.storage.get(transaction, "commit", commit.id.value)
                    )
                ).toBeUndefined();
                expect(harness.ownerEdges()).toEqual([]);
                expect(
                    harness.transaction((transaction) =>
                        harness.storage.parents(transaction, commit.id.value)
                    )
                ).toEqual([
                    {
                        commit: commit.id.value,
                        ordinal: 0,
                        parent: "conflicting-parent"
                    }
                ]);
            }
        );

        test(
            "poisons a partial write when custody throws a non-Error value",
            { tags: "p0" },
            async () => {
                const harness = create(() => {
                    throw "non-error custody failure";
                });
                const input = (await harness.content.put(encode("non-error-input"))).ref;
                const turn = turnRecord(input);
                let caught: Error | undefined;

                const escaped = captureError(() =>
                    harness.transaction((transaction) => {
                        try {
                            harness.repository.insertTurn(transaction, turn);
                        } catch (error) {
                            if (!(error instanceof Error)) throw error;
                            caught = error;
                        }
                    })
                );

                expect(escaped).toBe(caught);
                expectAgentCoreError(() => {
                    throw escaped;
                }, "protocol.invalid-state");
                expect(
                    harness.transaction((transaction) =>
                        harness.repository.loadTurn(transaction, turn.id)
                    )
                ).toBeUndefined();
                expect(harness.ownerEdges()).toEqual([]);
            }
        );

        test(
            "poisons a partial replacement when custody throws a non-Error value",
            { tags: "p0" },
            async () => {
                let failCustody = false;
                const harness = create(() => {
                    if (failCustody) throw "non-error custody failure";
                    return clock();
                });
                const input = (await harness.content.put(encode("non-error-replace-input"))).ref;
                const result = (await harness.content.put(encode("non-error-replace-result"))).ref;
                const initial = turnRecord(input);
                const claimed = initial.claim(ids.holder, new Date(20), new Date(100));
                const completed = claimed.complete(
                    { turn: claimed.id, holder: ids.holder, epoch: claimed.lease.epoch },
                    "succeeded",
                    result,
                    new Date(30)
                );
                harness.transaction((transaction) => {
                    harness.repository.insertTurn(transaction, initial);
                    harness.repository.replaceTurn(transaction, initial.revision, claimed);
                });
                failCustody = true;
                let caught: Error | undefined;

                const escaped = captureError(() =>
                    harness.transaction((transaction) => {
                        try {
                            harness.repository.replaceTurn(
                                transaction,
                                claimed.revision,
                                completed
                            );
                        } catch (error) {
                            if (!(error instanceof Error)) throw error;
                            caught = error;
                        }
                    })
                );

                expect(escaped).toBe(caught);
                expectAgentCoreError(() => {
                    throw escaped;
                }, "protocol.invalid-state");
                const stored = harness.transaction((transaction) =>
                    harness.repository.loadTurn(transaction, initial.id)
                );
                expect(stored?.revision.value).toBe(claimed.revision.value);
                expect(stored?.result).toBeUndefined();
                expect(harness.ownerEdges().map((edge) => edge.ref.value)).toEqual([input.value]);
            }
        );

        test("does not expose its custody mutation capability", { tags: "p0" }, () => {
            const harness = create();

            expect("retention" in harness.storage).toBe(false);
            expect("retention" in harness.repository.storage).toBe(false);
            expect("retention" in harness.content).toBe(false);
            expect(Reflect.ownKeys(harness.content)).toEqual([]);
            expect(prototypeMember(harness.storage, "insertStored")).toBeUndefined();
            expect(prototypeMember(harness.storage, "replaceStored")).toBeUndefined();
            expect(prototypeMember(harness.storage, "requireStorageMutation")).toBeUndefined();
        });

        test("keeps its content aggregate bound against runtime mutation", { tags: "p0" }, () => {
            const harness = create();
            const foreign = create();
            const content = harness.storage.content;

            expect(Reflect.set(harness.storage, "content", foreign.content)).toBe(false);
            expect(
                Reflect.defineProperty(harness.storage, "content", { value: foreign.content })
            ).toBe(false);
            expect(Reflect.setPrototypeOf(content, {})).toBe(false);
            expect(Object.isFrozen(content)).toBe(true);
            expect(Object.isFrozen(Object.getPrototypeOf(content))).toBe(true);
            expect(harness.storage.content).toBe(content);
            expect(Reflect.setPrototypeOf(harness.storage, {})).toBe(false);
            expect(Object.isFrozen(harness.storage)).toBe(true);
            expect(Object.isFrozen(Object.getPrototypeOf(harness.storage))).toBe(true);

            expect(Reflect.set(harness.repository, "storage", foreign.storage)).toBe(false);
            expect(
                Reflect.defineProperty(harness.repository, "content", {
                    value: foreign.content
                })
            ).toBe(false);
            expect(Reflect.setPrototypeOf(harness.repository, {})).toBe(false);
            expect(Object.isFrozen(harness.repository)).toBe(true);
            expect(Object.isFrozen(Object.getPrototypeOf(harness.repository))).toBe(true);
            expect(harness.repository.storage).toBe(harness.storage);
            expect(harness.repository.content).toBe(content);
        });

        test(
            "rejects content writes synchronously while a Run transaction is active",
            { tags: "p0" },
            async () => {
                const harness = create();
                const bytes = encode("in-transaction-content");
                const ref = ContentRef.fromDigest(Digest.sha256(bytes));
                let pending: ReturnType<ContentStore["put"]> | undefined;
                let failure: Error | undefined;

                try {
                    harness.transaction(() => {
                        pending = harness.content.put(bytes);
                    });
                } catch (error) {
                    if (!(error instanceof Error)) throw error;
                    failure = error;
                }
                await pending?.catch(() => undefined);

                expect(pending).toBeUndefined();
                expect(failure).toBeInstanceOf(AgentCoreError);
                if (failure instanceof AgentCoreError) {
                    expect(failure.code).toBe("run.invalid-state");
                }
                await expect(harness.content.stat(ref)).resolves.toBeUndefined();
            }
        );

        test("exposes only a frozen opaque transaction token", { tags: "p0" }, () => {
            const harness = create();
            const foreign = create();
            foreign.transaction((transaction) =>
                expectAgentCoreError(
                    () => harness.storage.get(transaction, "verdict", "foreign"),
                    "protocol.invalid-state"
                )
            );
            let captured: RunTransaction | undefined;
            expectAgentCoreError(
                () =>
                    harness.transaction((transaction) => {
                        captured = transaction;
                        expect(Object.isFrozen(transaction)).toBe(true);
                        expect(Object.isFrozen(Object.getPrototypeOf(transaction))).toBe(true);
                        expect(transaction).not.toBeInstanceOf(TransactionalSqlite);
                        expect(Reflect.ownKeys(transaction)).toEqual([]);
                        expect(prototypeMember(transaction, "all")).toBeUndefined();
                        expect(prototypeMember(transaction, "run")).toBeUndefined();
                        expect(prototypeMember(transaction, "transaction")).toBeUndefined();
                        expectAgentCoreError(
                            () => harness.transaction(() => undefined),
                            nestedCode
                        );
                    }),
                nestedCode
            );
            if (captured === undefined) throw new TypeError("Run transaction was not captured");
            const inactive = captured;

            expectAgentCoreError(
                () => harness.storage.get(inactive, "verdict", "captured"),
                "protocol.invalid-state"
            );
        });

        test("record prototype redirection cannot alter projections", { tags: "p0" }, async () => {
            const harness = create();
            const input = (await harness.content.put(encode("prototype-projection-input"))).ref;
            const turn = turnRecord(input);
            const redirected = Reflect.defineProperty(Turn.prototype, "contentRetention", {
                configurable: true,
                value: () => []
            });
            expect(redirected).toBe(false);
            harness.transaction((transaction) => harness.repository.insertTurn(transaction, turn));

            expect(harness.ownerEdges().map((edge) => edge.ref.value)).toEqual([input.value]);
        });
    });
}

custodyContract("memory", (now) => memoryHarness(undefined, now), "run.invalid-state");
custodyContract("SQLite", (now) => sqliteHarness(new TestSqlite(), now), "protocol.invalid-state");

test("a retained SQLite database cannot write around Run custody", { tags: "p0" }, async () => {
    const database = new TestSqlite();
    const retainedRun = database.run.bind(database);
    const harness = sqliteHarness(database);
    const legitimateState = (await harness.content.put(encode("retained-database-legitimate"))).ref;
    const rawState = (await harness.content.put(encode("retained-database-raw"))).ref;
    const legitimate = new RunCheckpoint(
        new RunCheckpointId("retained-database-legitimate"),
        ids.turn,
        ids.root,
        legitimateState,
        0,
        undefined
    );
    const raw = new RunCheckpoint(
        new RunCheckpointId("retained-database-raw"),
        ids.turn,
        ids.root,
        rawState,
        0,
        undefined
    );
    let caught: Error | undefined;

    const escaped = captureError(() =>
        harness.transaction((transaction) => {
            harness.repository.insertCheckpoint(transaction, legitimate);
            try {
                retainedRun(
                    `INSERT INTO agent_run_records (kind, record_key, revision, record)
                         VALUES (?, ?, ?, ?)`,
                    ["checkpoint", raw.id.value, null, RunCheckpoint.codec.encode(raw)]
                );
            } catch (error) {
                if (!(error instanceof Error)) throw error;
                caught = error;
            }
        })
    );

    expect(escaped).toBe(caught);
    expectAgentCoreError(() => {
        throw escaped;
    }, "protocol.invalid-state");
    expect(
        database.all("SELECT record_key FROM agent_run_records WHERE record_key IN (?, ?)", [
            legitimate.id.value,
            raw.id.value
        ])
    ).toEqual([]);
    expect(harness.ownerEdges()).toEqual([]);
});

test(
    "memory restart restores records and custody from one aggregate snapshot",
    { tags: "p0" },
    async () => {
        const first = memoryHarness();
        const input = (await first.content.put(encode("memory-restart"))).ref;
        const turn = turnRecord(input);
        first.transaction((transaction) => first.repository.insertTurn(transaction, turn));

        const restarted = memoryHarness(first.storage.snapshot());
        expect(
            restarted.transaction((transaction) =>
                restarted.repository.loadTurn(transaction, turn.id)
            )
        ).toEqual(turn);
        expect(restarted.ownerEdges().map((edge) => edge.ref.value)).toEqual([input.value]);
        await expect(restarted.content.get(input)).resolves.toEqual(encode("memory-restart"));
        expectAgentCoreError(
            () =>
                new MemoryRunStorage(new TenantId("other-tenant"), owner, first.storage.snapshot()),
            "protocol.invalid-state"
        );
        expectAgentCoreError(
            () =>
                new MemoryRunStorage(
                    tenant,
                    new ActorRef("run", new ActorId("other-owner")),
                    first.storage.snapshot()
                ),
            "protocol.invalid-state"
        );
    }
);

test(
    "memory restart rejects missing, mismatched, stale, duplicate, or byte-less Run custody",
    { tags: "p0" },
    async () => {
        const first = memoryHarness();
        const input = (await first.content.put(encode("memory-corrupt-input"))).ref;
        const other = (await first.content.put(encode("memory-corrupt-other"))).ref;
        const turn = turnRecord(input);
        first.transaction((transaction) => first.repository.insertTurn(transaction, turn));
        const snapshot = first.storage.snapshot();
        const inputEdgeBytes = snapshot.content.edges.find((bytes) =>
            ContentOwnerEdge.decode(bytes).ownerKey.endsWith('"input"]')
        );
        if (inputEdgeBytes === undefined) throw new TypeError("Turn input edge is missing");
        const inputEdge = ContentOwnerEdge.decode(inputEdgeBytes);
        const withoutInputRelation = snapshot.content.relations.filter(
            (relation) => relation.ref !== input.value
        );
        const withoutInputEdge = snapshot.content.edges.filter(
            (bytes) => !ContentOwnerEdge.decode(bytes).equals(inputEdge)
        );
        const mismatched = new ContentOwnerEdge(tenant, owner, inputEdge.ownerKey, other);
        const stale = new ContentOwnerEdge(
            tenant,
            owner,
            contentOwnerKey("turn.record", "missing-turn", "input"),
            input
        );
        const corruptions: readonly MemoryRunStorageSnapshot[] = [
            {
                ...snapshot,
                content: {
                    ...snapshot.content,
                    edges: withoutInputEdge,
                    relations: withoutInputRelation
                }
            },
            {
                ...snapshot,
                content: {
                    ...snapshot.content,
                    edges: [...withoutInputEdge, ContentOwnerEdge.encode(mismatched)],
                    relations: [...withoutInputRelation, { ref: other.value, unownedSince: null }]
                }
            },
            {
                ...snapshot,
                content: {
                    ...snapshot.content,
                    edges: [...snapshot.content.edges, ContentOwnerEdge.encode(stale)]
                }
            },
            {
                ...snapshot,
                content: {
                    ...snapshot.content,
                    edges: [...snapshot.content.edges, inputEdgeBytes]
                }
            },
            {
                ...snapshot,
                content: {
                    ...snapshot.content,
                    content: snapshot.content.content.filter((row) => row.ref !== input.value)
                }
            }
        ];

        for (const corrupted of corruptions) {
            expectAgentCoreError(() => memoryHarness(corrupted), "codec.invalid");
        }
    }
);

test("record owner keys bind the exact kind, identity, and field", { tags: "p1" }, async () => {
    const harness = memoryHarness();
    const refs = {
        checkpointState: await putRef(harness.content, "owner-key-checkpoint-state"),
        checkpointTree: await putRef(harness.content, "owner-key-checkpoint-tree"),
        commitContent: await putRef(harness.content, "owner-key-commit-content"),
        commitTree: await putRef(harness.content, "owner-key-commit-tree"),
        mergeContent: await putRef(harness.content, "owner-key-merge-content"),
        mergeTree: await putRef(harness.content, "owner-key-merge-tree"),
        mergeBase: await putRef(harness.content, "owner-key-merge-base"),
        spawnRoot: await putRef(harness.content, "owner-key-spawn-root"),
        turnInput: await putRef(harness.content, "owner-key-turn-input"),
        turnResult: await putRef(harness.content, "owner-key-turn-result"),
        inboxPayload: await putRef(harness.content, "owner-key-inbox-payload")
    };
    const initial = turnRecord(refs.turnInput);
    const claimed = initial.claim(ids.holder, new Date(20), new Date(100));
    const completed = claimed.complete(
        { turn: claimed.id, holder: ids.holder, epoch: claimed.lease.epoch },
        "succeeded",
        refs.turnResult,
        new Date(30)
    );
    const checkpoint = new RunCheckpoint(
        new RunCheckpointId("custody-checkpoint"),
        initial.id,
        ids.root,
        refs.checkpointState,
        0,
        refs.checkpointTree
    );
    const commit = turnCommit(
        new RunCommitId("custody-commit"),
        refs.commitContent,
        refs.commitTree
    );
    const merge = mergeCommit(refs.mergeContent, refs.mergeTree, refs.mergeBase);
    const spawn = spawnReservation(refs.spawnRoot);
    const inbox = inboxEntry(initial.id, refs.inboxPayload);
    harness.transaction((transaction) => {
        harness.repository.insertCheckpoint(transaction, checkpoint);
        harness.repository.insertCommit(transaction, commit);
        harness.repository.insertCommit(transaction, merge);
        harness.repository.insertSpawn(transaction, spawn);
        harness.repository.insertTurn(transaction, initial);
        harness.repository.replaceTurn(transaction, initial.revision, claimed);
        harness.repository.replaceTurn(transaction, claimed.revision, completed);
        harness.repository.insertInbox(transaction, inbox);
    });

    const edges = harness.storage
        .snapshot()
        .content.edges.map((bytes) => ContentOwnerEdge.decode(bytes))
        .sort((left, right) => compareCanonicalText(left.ownerKey, right.ownerKey));
    const expected: Array<readonly [string, ContentRef]> = [
        ownerField(RunCheckpoint.codec.kind, checkpoint.id.value, "state", checkpoint.state),
        ownerField(RunCheckpoint.codec.kind, checkpoint.id.value, "tree", refs.checkpointTree),
        ownerField(RunCommit.codec.kind, commit.id.value, "content", commit.content),
        ownerField(RunCommit.codec.kind, commit.id.value, "treeCheckpoint", commit.treeCheckpoint),
        ownerField(RunCommit.codec.kind, merge.id.value, "content", merge.content),
        ownerField(RunCommit.codec.kind, merge.id.value, "treeCheckpoint", merge.treeCheckpoint),
        ownerField(
            RunCommit.codec.kind,
            merge.id.value,
            "treeResolution.base",
            merge.treeResolution?.base
        ),
        ownerField(SpawnReservation.codec.kind, spawn.id.value, "rootContent", spawn.rootContent),
        ownerField(Turn.codec.kind, completed.id.value, "input", completed.input),
        ownerField(Turn.codec.kind, completed.id.value, "result", completed.result),
        ownerField(TurnInboxEntry.codec.kind, inbox.id.value, "payload", inbox.payload)
    ];
    expected.sort(([left], [right]) => compareCanonicalText(left, right));
    expect(edges.map((edge) => [edge.ownerKey, edge.ref])).toEqual(expected);
});

test("SQLite restart restores records and custody from one database", { tags: "p0" }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "run-content-custody-"));
    const path = join(directory, "actor.sqlite");
    try {
        const firstDatabase = new FileSqlite(path);
        const first = sqliteHarness(firstDatabase);
        const input = (await first.content.put(encode("sqlite-restart"))).ref;
        const turn = turnRecord(input);
        first.transaction((transaction) => first.repository.insertTurn(transaction, turn));
        firstDatabase.close();

        const secondDatabase = new FileSqlite(path);
        const restarted = sqliteHarness(secondDatabase);
        expect(
            restarted.transaction((transaction) =>
                restarted.repository.loadTurn(transaction, turn.id)
            )
        ).toEqual(turn);
        expect(restarted.ownerEdges().map((edge) => edge.ref.value)).toEqual([input.value]);
        await expect(restarted.content.get(input)).resolves.toEqual(encode("sqlite-restart"));
        secondDatabase.close();
    } finally {
        rmSync(directory, { force: true, recursive: true });
    }
});

test(
    "SQLite reopen rejects missing, mismatched, stale, duplicate, or byte-less Run custody",
    { tags: "p0" },
    async () => {
        const corruptions: readonly ("missing" | "mismatched" | "stale" | "missing-bytes")[] = [
            "missing",
            "mismatched",
            "stale",
            "missing-bytes"
        ];
        for (const corruption of corruptions) {
            const database = new DamagedSqlite();
            const first = sqliteHarness(database);
            const input = (await first.content.put(encode(`sqlite-${corruption}-input`))).ref;
            const other = (await first.content.put(encode(`sqlite-${corruption}-other`))).ref;
            const turn = turnRecord(input);
            first.transaction((transaction) => first.repository.insertTurn(transaction, turn));
            const ownerKey = contentOwnerKey("turn.record", turn.id.value, "input");

            if (corruption === "missing") {
                database.damage("DELETE FROM content_owner_edges WHERE owner_key = ?", [ownerKey]);
                database.damage("DELETE FROM content_relations WHERE ref = ?", [input.value]);
            } else if (corruption === "missing-bytes") {
                database.damage("DELETE FROM content_blobs WHERE ref = ?", [input.value]);
            } else if (corruption === "mismatched") {
                const edge = new ContentOwnerEdge(tenant, owner, ownerKey, other);
                database.damage(
                    "UPDATE content_owner_edges SET ref = ?, record = ? WHERE owner_key = ?",
                    [other.value, ContentOwnerEdge.encode(edge), ownerKey]
                );
                database.damage("UPDATE content_relations SET unowned_since = 1 WHERE ref = ?", [
                    input.value
                ]);
                database.damage(
                    `INSERT INTO content_relations
                        (ref, tenant, actor_kind, actor_id, unowned_since)
                     VALUES (?, ?, ?, ?, NULL)`,
                    [other.value, tenant.value, owner.kind, owner.id.value]
                );
            } else {
                const edge = new ContentOwnerEdge(
                    tenant,
                    owner,
                    contentOwnerKey("turn.record", "missing-turn", "input"),
                    input
                );
                database.damage(
                    `INSERT INTO content_owner_edges
                        (owner_key, tenant, actor_kind, actor_id, ref, record)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        edge.ownerKey,
                        tenant.value,
                        owner.kind,
                        owner.id.value,
                        input.value,
                        ContentOwnerEdge.encode(edge)
                    ]
                );
            }

            expectAgentCoreError(() => sqliteHarness(database), "codec.invalid");
        }
    }
);

test(
    "SQLite reopen rejects duplicate custody rows returned by its substrate",
    { tags: "p0" },
    async () => {
        const database = new DuplicateOwnerEdgeSqlite();
        const first = sqliteHarness(database);
        const input = (await first.content.put(encode("sqlite-duplicate-projection"))).ref;
        const turn = turnRecord(input);
        first.transaction((transaction) => first.repository.insertTurn(transaction, turn));

        database.duplicateOwnerEdges = true;
        expectAgentCoreError(() => sqliteHarness(database), "codec.invalid");
    }
);

test("SQLite owner keys reject duplicate custody edges", { tags: "p0" }, async () => {
    const database = new DamagedSqlite();
    const harness = sqliteHarness(database);
    const input = (await harness.content.put(encode("sqlite-duplicate-input"))).ref;
    const turn = turnRecord(input);
    harness.transaction((transaction) => harness.repository.insertTurn(transaction, turn));
    const ownerKey = contentOwnerKey("turn.record", turn.id.value, "input");
    const edge = new ContentOwnerEdge(tenant, owner, ownerKey, input);

    expect(() =>
        database.damage(
            `INSERT INTO content_owner_edges
                (owner_key, tenant, actor_kind, actor_id, ref, record)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                edge.ownerKey,
                tenant.value,
                owner.kind,
                owner.id.value,
                input.value,
                ContentOwnerEdge.encode(edge)
            ]
        )
    ).toThrow();
});

test("repository exposes only the content aggregate its storage owns", { tags: "p0" }, () => {
    const memory = new MemoryRunStorage(tenant, owner);
    const memoryRepository = new RunRepository(memory);
    expect(memoryRepository.content).toBe(memory.content);

    const firstDatabase = new TestSqlite();
    const sqlite = new SqliteRunStorage(firstDatabase, tenant, owner);
    const sqliteRepository = new RunRepository(sqlite);
    expect(sqliteRepository.content).toBe(sqlite.content);
    expectAgentCoreError(
        () => new SqliteRunStorage(firstDatabase, new TenantId("other-tenant"), owner),
        "codec.invalid"
    );
    expectAgentCoreError(
        () =>
            new SqliteRunStorage(
                firstDatabase,
                tenant,
                new ActorRef("run", new ActorId("other-owner"))
            ),
        "codec.invalid"
    );
    const preboundDatabase = new TestSqlite();
    new SqliteContentStore(preboundDatabase).retention(tenant, owner);
    expectAgentCoreError(
        () => new SqliteRunStorage(preboundDatabase, new TenantId("other-tenant"), owner),
        "protocol.invalid-state"
    );
    expect(
        preboundDatabase.all(
            "SELECT name FROM sqlite_schema WHERE name LIKE 'agent_run_%' ORDER BY name",
            []
        )
    ).toEqual([]);
});

test(
    "the content facade does not follow later adapter prototype mutation",
    { tags: "p0" },
    async () => {
        const storage = new MemoryRunStorage(tenant, owner);
        const originalPut = MemoryContentStore.prototype.put;
        const originalGet = MemoryContentStore.prototype.get;
        const originalStat = MemoryContentStore.prototype.stat;
        const bytes = encode("prototype-bound-content");

        MemoryContentStore.prototype.put = async () => {
            throw new TypeError("forged put");
        };
        MemoryContentStore.prototype.get = async () => encode("forged get");
        MemoryContentStore.prototype.stat = async () => undefined;
        try {
            const stored = await storage.content.put(bytes);
            await expect(storage.content.get(stored.ref)).resolves.toEqual(bytes);
            await expect(storage.content.stat(stored.ref)).resolves.toMatchObject({
                ref: stored.ref
            });
        } finally {
            MemoryContentStore.prototype.put = originalPut;
            MemoryContentStore.prototype.get = originalGet;
            MemoryContentStore.prototype.stat = originalStat;
        }
    }
);

test("an exported Run storage subclass cannot install an unowned backend", { tags: "p0" }, () => {
    class ForgedRunStorage extends RunStoragePort<RunTransaction> {
        public constructor() {
            super(tenant, owner, new MemoryContentStore(), malformed({}));
        }
    }

    expect(() => new ForgedRunStorage()).toThrow(TypeError);
});

async function putRef(store: ContentStore, value: string): Promise<ContentRef> {
    return (await store.put(encode(value))).ref;
}

function decodeOwnerEdge(value: string | number | Uint8Array | null | undefined): ContentOwnerEdge {
    if (!(value instanceof Uint8Array)) throw new TypeError("Stored owner edge must be bytes");
    return ContentOwnerEdge.decode(value);
}

function captureError(operation: () => void): Error {
    try {
        operation();
    } catch (error) {
        if (error instanceof Error) return error;
        throw error;
    }
    throw new TypeError("Expected operation to fail");
}

function prototypeMember(
    value: RunStoragePort<RunTransaction> | RunTransaction,
    name: string
): PropertyDescriptor | undefined {
    let prototype = Object.getPrototypeOf(value);
    while (prototype !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (descriptor !== undefined) return descriptor;
        prototype = Object.getPrototypeOf(prototype);
    }
    return undefined;
}

function ownerField(
    kind: string,
    key: string,
    field: string,
    ref: ContentRef | undefined
): readonly [string, ContentRef] {
    if (ref === undefined) throw new TypeError(`Expected ${field} content`);
    return [contentOwnerKey(kind, key, field), ref];
}

function turnRecord(input: ContentRef, revision = new Revision(0)): Turn {
    return new Turn({
        id: new TurnId("custody-turn"),
        run: ids.run,
        branch: ids.branch,
        startHead: ids.root,
        effectiveInput: ids.root,
        pins: pins(),
        placement: Digest.sha256(encode("placement")),
        input,
        revision
    });
}

function turnCommit(id: RunCommitId, content: ContentRef, tree: ContentRef): RunCommit {
    return new RunCommit({
        id,
        run: ids.run,
        branch: ids.branch,
        kind: "root",
        parents: [],
        pins: pins(),
        writer: { kind: "root" },
        content,
        treeCheckpoint: tree
    });
}

function mergeCommit(content: ContentRef, tree: ContentRef, base: ContentRef): RunCommit {
    const left = new RunCommitId("custody-left");
    const right = new RunCommitId("custody-right");
    return new RunCommit({
        id: new RunCommitId("custody-merge"),
        run: ids.run,
        branch: ids.branch,
        kind: "merge",
        parents: [left, right],
        pins: pins(),
        writer: {
            kind: "system",
            cause: {
                kind: "control",
                audit: new AuditRecordId("custody-audit"),
                receipt: new ReceiptId("custody-receipt")
            }
        },
        content,
        receipt: new ReceiptId("custody-receipt"),
        resolution: { kind: "concat" },
        treeCheckpoint: tree,
        treeResolution: {
            policy: "ours",
            side: left,
            base,
            environment: "custody-environment"
        }
    });
}

function spawnReservation(rootContent: ContentRef): SpawnReservation {
    return new SpawnReservation(
        new SpawnReservationId("custody-spawn"),
        ids.run,
        ids.turn,
        new RunId("custody-child"),
        { turn: ids.turn, holder: ids.holder, epoch: 1 },
        Digest.sha256(encode("configuration")),
        rootContent,
        new InvocationId("custody-invocation"),
        new ReceiptId("custody-spawn-receipt"),
        attenuationDigest(new SpawnAttenuation()),
        new Date(10)
    );
}

function inboxEntry(turn: TurnId, payload: ContentRef): TurnInboxEntry {
    return new TurnInboxEntry(
        new TurnInboxEntryId("custody-inbox"),
        turn,
        0,
        "message",
        payload,
        payload.digest,
        "custody-inbox-key",
        undefined,
        new Date(10)
    );
}

function expectAgentCoreError(operation: () => void, code: AgentCoreError["code"]): void {
    try {
        operation();
    } catch (error) {
        if (!(error instanceof AgentCoreError)) throw error;
        expect(error.code).toBe(code);
        return;
    }
    throw new TypeError(`Expected ${code}`);
}

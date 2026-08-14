import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { AuditRecordId, EventId } from "../../../src/interaction-references";
import { ReceiptId } from "../../../src/invocations";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { RunId, TurnInboxEntryId } from "../../../src/agents/runs/id";
import { RunCommit } from "../../../src/agents/runs/commit";
import { ForcedTurnCancellation } from "../../../src/agents/runs/forced-cancellation";
import type { LeaseToken } from "../../../src/agents/runs/lease";
import { MemoryRunStorage } from "../../../src/agents/runs/memory";
import { RunRepository, type StoredRunRecord } from "../../../src/agents/runs/store";
import { TurnInboxEntry } from "../../../src/agents/runs/turn";
import { content, digest, ids, pins, seedRunningTurn, thrownBy } from "./fixture";

function expectError(
    label: string,
    operation: () => void,
    code: AgentCoreError["code"],
    message: string
): void {
    const failure = thrownBy(AgentCoreError, operation, label);
    expect(failure.code, label).toBe(code);
    expect(failure.message, label).toBe(message);
}

function rawRecord(overrides: Partial<StoredRunRecord> = {}): StoredRunRecord {
    return {
        kind: "turn",
        key: "record-key",
        revision: 0,
        bytes: new Uint8Array([1, 2]),
        ...overrides
    };
}

describe("MemoryRunStorage mutation kills", () => {
    test(
        "transactions accept synchronous results, reject thenables, and roll back on failure",
        { tags: "p0" },
        () => {
            const storage = new MemoryRunStorage();

            expect(storage.transaction(() => 42)).toBe(42);
            const plain = { value: 1 };
            expect(storage.transaction(() => plain)).toBe(plain);
            // SAFETY: SynchronousResultGuard already rejects a Promise-returning callback at
            // compile time. Defeating that guard is the only way to reach the runtime check that
            // backs it, which is what this case pins.
            expectError(
                "promise result",
                () => {
                    // @ts-expect-error Transaction callbacks are statically synchronous.
                    return storage.transaction(() => Promise.resolve());
                },
                "run.invalid-state",
                "Run storage transactions must be synchronous"
            );
            expectError(
                "thenable object result",
                () =>
                    storage.transaction(() =>
                        // oxlint-disable-next-line unicorn/no-thenable -- hostile transaction result
                        Object.defineProperty({}, "then", { value: () => null })
                    ),
                "run.invalid-state",
                "Run storage transactions must be synchronous"
            );
            // oxlint-disable-next-line unicorn/no-thenable -- hostile transaction result
            const callable = Object.defineProperty(() => null, "then", { value: () => null });
            expectError(
                "thenable function result",
                () => storage.transaction(() => callable),
                "run.invalid-state",
                "Run storage transactions must be synchronous"
            );
            const crossRealmThenable: unknown = runInNewContext(
                "Object.assign(function () {}, { then() {} })"
            );
            const crossRealmFailure = thrownBy(
                AgentCoreError,
                () => storage.transaction(() => crossRealmThenable),
                "cross-realm thenable function result"
            );
            expect(crossRealmFailure.code).toBe("run.invalid-state");

            const aborted = thrownBy(
                Error,
                () =>
                    storage.transaction((tx) => {
                        storage.insert(tx, rawRecord({ key: "rollback" }));
                        storage.insertParent(tx, {
                            commit: "commit-rollback",
                            ordinal: 0,
                            parent: "parent-rollback"
                        });
                        throw new Error("abort");
                    }),
                "aborted transaction"
            );
            expect(aborted.message).toBe("abort");
            storage.transaction((tx) => {
                expect(storage.get(tx, "turn", "rollback")).toBeUndefined();
                expect(storage.parents(tx, "commit-rollback")).toEqual([]);
            });
            expect(storage.snapshot().records).toEqual([]);
            expect(storage.snapshot().parents).toEqual([]);
        }
    );

    test("insert replay equality compares the revision and every byte", { tags: "p0" }, () => {
        const storage = new MemoryRunStorage();
        storage.transaction((tx) => storage.insert(tx, rawRecord()));
        storage.transaction((tx) => storage.insert(tx, rawRecord()));

        const rejected: readonly { readonly label: string; readonly record: StoredRunRecord }[] = [
            { label: "different revision", record: rawRecord({ revision: 1 }) },
            {
                label: "different bytes of equal length",
                record: rawRecord({ bytes: new Uint8Array([9, 2]) })
            },
            {
                label: "partially matching bytes",
                record: rawRecord({ bytes: new Uint8Array([1, 9]) })
            },
            {
                label: "longer bytes sharing a prefix",
                record: rawRecord({ bytes: new Uint8Array([1, 2, 3]) })
            }
        ];
        for (const { label, record } of rejected) {
            expectError(
                label,
                () => storage.transaction((tx) => storage.insert(tx, record)),
                "run.invalid-state",
                "Run records are immutable unless replaced by revision CAS"
            );
        }
        storage.transaction((tx) => {
            expect(storage.get(tx, "turn", "record-key")).toEqual(rawRecord());
        });
    });

    test("replace enforces exact compare-and-swap without mutating state", { tags: "p0" }, () => {
        const storage = new MemoryRunStorage();
        expectError(
            "replace on a missing record",
            () => storage.transaction((tx) => storage.replace(tx, rawRecord({ revision: 1 }), 0)),
            "protocol.revision-conflict",
            "Run record revision changed"
        );

        storage.transaction((tx) => storage.insert(tx, rawRecord()));
        expectError(
            "stale expected revision",
            () =>
                storage.transaction((tx) =>
                    storage.replace(tx, rawRecord({ revision: 5, bytes: new Uint8Array([7]) }), 4)
                ),
            "protocol.revision-conflict",
            "Run record revision changed"
        );
        expectError(
            "wrong successor revision",
            () =>
                storage.transaction((tx) =>
                    storage.replace(tx, rawRecord({ revision: 7, bytes: new Uint8Array([7]) }), 0)
                ),
            "protocol.revision-conflict",
            "Run record revision changed"
        );
        storage.transaction((tx) => {
            expect(storage.get(tx, "turn", "record-key")).toEqual(rawRecord());
        });

        storage.transaction((tx) => {
            storage.replace(tx, rawRecord({ revision: 1, bytes: new Uint8Array([3]) }), 0);
        });
        storage.transaction((tx) => {
            expect(storage.get(tx, "turn", "record-key")).toEqual(
                rawRecord({ revision: 1, bytes: new Uint8Array([3]) })
            );
        });
    });

    test("parent edges validate the ordinal and stay immutable", { tags: "p1" }, () => {
        const storage = new MemoryRunStorage();
        const ordinals: readonly (readonly [string, number])[] = [
            ["negative ordinal", -1],
            ["ordinal above one", 2],
            ["fractional ordinal", 0.5]
        ];
        for (const [label, ordinal] of ordinals) {
            expectError(
                label,
                () =>
                    storage.transaction((tx) =>
                        storage.insertParent(tx, {
                            commit: "commit-a",
                            ordinal,
                            parent: "parent-x"
                        })
                    ),
                "codec.invalid",
                "Run parent ordinal must be zero or one"
            );
        }
        storage.transaction((tx) => {
            storage.insertParent(tx, { commit: "commit-a", ordinal: 0, parent: "parent-0" });
            storage.insertParent(tx, { commit: "commit-a", ordinal: 1, parent: "parent-1" });
            storage.insertParent(tx, { commit: "commit-a", ordinal: 0, parent: "parent-0" });
        });
        expectError(
            "conflicting parent replay",
            () =>
                storage.transaction((tx) =>
                    storage.insertParent(tx, {
                        commit: "commit-a",
                        ordinal: 0,
                        parent: "parent-other"
                    })
                ),
            "run.invalid-state",
            "Run commit parent edges are immutable"
        );
    });

    test(
        "parents returns only the requested commit's edges ordered by ordinal",
        { tags: "p1" },
        () => {
            const storage = new MemoryRunStorage();
            storage.transaction((tx) => {
                storage.insertParent(tx, { commit: "commit-a", ordinal: 1, parent: "parent-1" });
                storage.insertParent(tx, { commit: "commit-a", ordinal: 0, parent: "parent-0" });
                storage.insertParent(tx, { commit: "commit-b", ordinal: 0, parent: "parent-b" });
            });

            expect(storage.transaction((tx) => storage.parents(tx, "commit-a"))).toEqual([
                { commit: "commit-a", ordinal: 0, parent: "parent-0" },
                { commit: "commit-a", ordinal: 1, parent: "parent-1" }
            ]);
            expect(storage.transaction((tx) => storage.parents(tx, "commit-missing"))).toEqual([]);
        }
    );

    test(
        "snapshots order every table canonically and deep-copy record bytes",
        { tags: "p0" },
        () => {
            const storage = new MemoryRunStorage();
            const bytes = new Uint8Array([1, 2, 3]);
            storage.transaction((tx) => {
                storage.insert(tx, { kind: "run", key: "z", revision: 0, bytes });
                storage.insert(tx, {
                    kind: "commit",
                    key: "a",
                    revision: null,
                    bytes: new Uint8Array([4])
                });
                storage.insertParent(tx, { commit: "commit-b", ordinal: 0, parent: "parent-b" });
                storage.insertParent(tx, { commit: "commit-a", ordinal: 0, parent: "parent-a" });
            });

            bytes[0] = 9;
            storage.transaction((tx) => {
                expect(storage.get(tx, "run", "z")?.bytes).toEqual(new Uint8Array([1, 2, 3]));
            });
            const fetched = storage.transaction((tx) => storage.get(tx, "run", "z"));
            fetched?.bytes.set([8], 0);
            storage.transaction((tx) => {
                expect(storage.get(tx, "run", "z")?.bytes).toEqual(new Uint8Array([1, 2, 3]));
            });

            const snapshot = storage.snapshot();
            expect(snapshot.records.map((record) => record.kind)).toEqual(["commit", "run"]);
            expect(snapshot.parents.map((edge) => edge.commit)).toEqual(["commit-a", "commit-b"]);

            const restored = new MemoryRunStorage(snapshot);
            snapshot.records[1]?.bytes.set([7], 0);
            storage.transaction((tx) => {
                expect(storage.get(tx, "run", "z")?.bytes).toEqual(new Uint8Array([1, 2, 3]));
            });
            restored.transaction((tx) => {
                expect(restored.get(tx, "run", "z")?.bytes).toEqual(new Uint8Array([1, 2, 3]));
            });
        }
    );

    test(
        "snapshot restoration rejects each single defect with the exact message",
        { tags: "p1" },
        () => {
            const record = rawRecord();
            const edge = { commit: "commit-a", ordinal: 0, parent: "parent-a" };
            const rejected: readonly {
                readonly label: string;
                readonly snapshot: unknown;
                readonly message: string;
            }[] = [
                {
                    label: "unknown version",
                    snapshot: { version: 2, records: [], parents: [] },
                    message: "Memory Run storage snapshot is malformed"
                },
                {
                    label: "records is not an array",
                    snapshot: { version: 1, records: {}, parents: [] },
                    message: "Memory Run storage snapshot is malformed"
                },
                {
                    label: "parents is not an array",
                    snapshot: { version: 1, records: [], parents: {} },
                    message: "Memory Run storage snapshot is malformed"
                },
                {
                    label: "duplicate records",
                    snapshot: { version: 1, records: [record, record], parents: [] },
                    message: "Memory Run snapshot contains duplicate records"
                },
                {
                    label: "malformed stored record",
                    snapshot: { version: 1, records: [rawRecord({ key: "" })], parents: [] },
                    message: "Stored Run record is malformed"
                },
                {
                    label: "empty edge commit",
                    snapshot: {
                        version: 1,
                        records: [],
                        parents: [{ commit: "", ordinal: 0, parent: "parent-a" }]
                    },
                    message: "Memory Run snapshot contains a malformed parent edge"
                },
                {
                    label: "empty edge parent",
                    snapshot: {
                        version: 1,
                        records: [],
                        parents: [{ commit: "commit-a", ordinal: 0, parent: "" }]
                    },
                    message: "Memory Run snapshot contains a malformed parent edge"
                },
                {
                    label: "fractional edge ordinal",
                    snapshot: {
                        version: 1,
                        records: [],
                        parents: [{ commit: "commit-a", ordinal: 0.5, parent: "parent-a" }]
                    },
                    message: "Memory Run snapshot contains a malformed parent edge"
                },
                {
                    label: "negative edge ordinal",
                    snapshot: {
                        version: 1,
                        records: [],
                        parents: [{ commit: "commit-a", ordinal: -1, parent: "parent-a" }]
                    },
                    message: "Memory Run snapshot contains a malformed parent edge"
                },
                {
                    label: "edge ordinal above one",
                    snapshot: {
                        version: 1,
                        records: [],
                        parents: [{ commit: "commit-a", ordinal: 2, parent: "parent-a" }]
                    },
                    message: "Memory Run snapshot contains a malformed parent edge"
                },
                {
                    label: "duplicate parents",
                    snapshot: { version: 1, records: [], parents: [edge, edge] },
                    message: "Memory Run snapshot contains duplicate parents"
                }
            ];
            for (const { label, snapshot, message } of rejected) {
                // SAFETY: MemoryRunStorageSnapshot pins `version` to 1 and both collections to
                // arrays, so every defect in this list is unreachable through the declared type.
                // Restoration reads a snapshot back from storage, so it must reject them anyway.
                expectError(
                    label,
                    () => {
                        // @ts-expect-error Persisted snapshots cross the static trust boundary.
                        return new MemoryRunStorage(snapshot);
                    },
                    "codec.invalid",
                    message
                );
            }

            const restored = new MemoryRunStorage({
                version: 1,
                records: [],
                parents: [
                    { commit: "commit-a", ordinal: 0, parent: "parent-0" },
                    { commit: "commit-a", ordinal: 1, parent: "parent-1" }
                ]
            });
            expect(restored.transaction((tx) => restored.parents(tx, "commit-a"))).toHaveLength(2);
        }
    );
});

describe("RunRepository over MemoryRunStorage mutation kills", () => {
    function inboxEntry(id: string, sequence: number, turn: TurnId, key: string): TurnInboxEntry {
        return new TurnInboxEntry(
            new TurnInboxEntryId(id),
            turn,
            sequence,
            "message",
            content("e"),
            digest("e"),
            key,
            undefined,
            new Date(10)
        );
    }

    function cancellation(run: RunId, turnValue: string): ForcedTurnCancellation {
        return new ForcedTurnCancellation({
            run,
            terminalTurn: new TurnId("turn-mutation-terminal"),
            turn: new TurnId(turnValue),
            priorLeaseEpoch: 1,
            fencedLeaseEpoch: 2,
            controlReceipt: new ReceiptId("receipt-mutation"),
            controlAudit: new AuditRecordId("audit-mutation-control"),
            cancellationEvent: new EventId("event-mutation"),
            cancellationAudit: new AuditRecordId("audit-mutation-cancel")
        });
    }

    function messageCommit(id: string, parent: RunCommitId, token: LeaseToken): RunCommit {
        return new RunCommit({
            id: new RunCommitId(id),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [parent],
            pins: pins(),
            writer: { kind: "turn", token },
            subjectTurn: ids.turn,
            content: content("1")
        });
    }

    test("inbox listing filters by Turn and orders by sequence", { tags: "p1" }, () => {
        const seeded = seedRunningTurn();
        seeded.repository.transaction((tx) => {
            seeded.repository.insertInbox(tx, inboxEntry("inbox-a", 1, ids.turn, "key-a"));
            seeded.repository.insertInbox(tx, inboxEntry("inbox-b", 0, ids.turn, "key-b"));
            seeded.repository.insertInbox(
                tx,
                inboxEntry("inbox-c", 5, new TurnId("turn-mutation-foreign"), "key-c")
            );
        });

        const inbox = seeded.repository.transaction((tx) =>
            seeded.repository.listInbox(tx, ids.turn)
        );
        expect(inbox.map((entry) => entry.id.value)).toEqual(["inbox-b", "inbox-a"]);
    });

    test("forced cancellation listing returns only the requested Run", { tags: "p1" }, () => {
        const seeded = seedRunningTurn();
        const otherRun = new RunId("run-mutation-other");
        seeded.repository.transaction((tx) => {
            seeded.repository.insertForcedCancellation(
                tx,
                cancellation(ids.run, "turn-mutation-cancelled-a")
            );
            seeded.repository.insertForcedCancellation(
                tx,
                cancellation(otherRun, "turn-mutation-cancelled-b")
            );
        });

        expect(
            seeded.repository
                .transaction((tx) => seeded.repository.listForcedCancellations(tx, ids.run))
                .map((value) => value.turn.value)
        ).toEqual(["turn-mutation-cancelled-a"]);
        expect(
            seeded.repository
                .transaction((tx) => seeded.repository.listForcedCancellations(tx, otherRun))
                .map((value) => value.turn.value)
        ).toEqual(["turn-mutation-cancelled-b"]);
    });

    test(
        "a restored snapshot preserves every table and its commit ancestry",
        { tags: "p0" },
        () => {
            const seeded = seedRunningTurn();
            const first = messageCommit("commit-mutation-first", ids.root, seeded.token);
            seeded.runtime.appendTurnCommit(first, new Revision(0), new Date(1500));
            const second = messageCommit("commit-mutation-second", first.id, seeded.token);
            seeded.runtime.appendTurnCommit(second, new Revision(1), new Date(1600));

            const snapshot = seeded.storage.snapshot();
            const restoredStorage = new MemoryRunStorage(snapshot);
            const restored = new RunRepository(restoredStorage);

            expect(restoredStorage.snapshot()).toEqual(snapshot);
            expect(restored.transaction((tx) => restored.isAncestor(tx, ids.root, second.id))).toBe(
                true
            );
            expect(restored.transaction((tx) => restored.isAncestor(tx, first.id, second.id))).toBe(
                true
            );
            expect(restored.transaction((tx) => restored.isAncestor(tx, second.id, ids.root))).toBe(
                false
            );
            expect(
                restored.transaction((tx) =>
                    restored.isAncestor(tx, ids.root, new RunCommitId("commit-mutation-absent"))
                )
            ).toBe(false);
            expect(restored.transaction((tx) => restored.loadTurn(tx, ids.turn))?.id.value).toBe(
                ids.turn.value
            );
            expect(restored.transaction((tx) => restored.loadRun(tx, ids.run))).toBeDefined();
        }
    );
});

describe("transaction result forwarding", () => {
    test("returns a null transaction result unchanged", { tags: "p1" }, () => {
        const storage = new MemoryRunStorage();
        expect(storage.transaction(() => null)).toBeNull();
    });
});

// @ts-nocheck
import { describe, expect, it } from "vitest";
import { AgentCoreError } from "../../../src/errors";
import { Revision } from "../../../src/core";
import { RunCommitId } from "../../../src/execution-references";
import { RunAdmissionRegistry } from "../../../src/agents/runs/admission";
import { RunCommit } from "../../../src/agents/runs/commit";
import { MemoryRunStorage } from "../../../src/agents/runs/memory";
import { RunId } from "../../../src/agents/runs/id";
import { RunRepository, type StoredRunRecord } from "../../../src/agents/runs/store";
import { content, genesis, harness, ids, pins, seedRunningTurn } from "./fixture";

function expectCode(operation: () => unknown, code: AgentCoreError["code"]): void {
    try {
        operation();
        throw new Error("Expected operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
    }
}

function rawRecord(overrides: Partial<StoredRunRecord> = {}): StoredRunRecord {
    return {
        kind: "configuration",
        key: "key",
        revision: null,
        bytes: new Uint8Array([1, 2, 3]),
        ...overrides
    };
}

describe("MemoryRunStorage exhaustive behavior", () => {
    it("rejects async and nested transactions with stable codes", () => {
        const storage = new MemoryRunStorage();
        expectCode(
            () => storage.transaction(() => Promise.resolve() as never),
            "run.invalid-state"
        );
        expectCode(
            () => storage.transaction(() => storage.transaction(() => 1)),
            "run.invalid-state"
        );
    });

    it("accepts equal immutable replay and rejects conflicting replay", () => {
        const storage = new MemoryRunStorage();
        storage.transaction((tx) => {
            storage.insert(tx, rawRecord());
            storage.insert(tx, rawRecord());
        });
        expectCode(
            () =>
                storage.transaction((tx) =>
                    storage.insert(
                        tx,
                        rawRecord({
                            bytes: new Uint8Array([9])
                        })
                    )
                ),
            "run.invalid-state"
        );
        storage.transaction((tx) => {
            storage.insertParent(tx, { commit: "commit", ordinal: 0, parent: "root" });
            storage.insertParent(tx, { commit: "commit", ordinal: 0, parent: "root" });
        });
        expectCode(
            () =>
                storage.transaction((tx) =>
                    storage.insertParent(tx, {
                        commit: "commit",
                        ordinal: 0,
                        parent: "other"
                    })
                ),
            "run.invalid-state"
        );
    });

    it("rejects every malformed raw record and snapshot projection", () => {
        const storage = new MemoryRunStorage();
        for (const record of [
            rawRecord({ key: "" }),
            rawRecord({ revision: -1 }),
            { ...rawRecord(), bytes: "bad" as never },
            { ...rawRecord(), kind: "unknown" as never }
        ]) {
            expectCode(
                () => storage.transaction((tx) => storage.insert(tx, record)),
                "codec.invalid"
            );
        }
        const duplicate = rawRecord();
        expectCode(
            () =>
                new MemoryRunStorage({
                    version: 1,
                    records: [duplicate, duplicate],
                    parents: []
                }),
            "codec.invalid"
        );
        expectCode(
            () =>
                new MemoryRunStorage({
                    version: 1,
                    records: [],
                    parents: [
                        { commit: "commit", ordinal: 0, parent: "root" },
                        { commit: "commit", ordinal: 0, parent: "root" }
                    ]
                }),
            "codec.invalid"
        );
        expectCode(
            () =>
                new MemoryRunStorage({
                    version: 1,
                    records: [],
                    parents: [{ commit: "", ordinal: 3, parent: "" }]
                }),
            "codec.invalid"
        );
    });

    it("detects key and revision projection corruption through the repository", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const snapshot = value.storage.snapshot();
        const runRow = snapshot.records.find((row) => row.kind === "run")!;
        const wrongKey = new MemoryRunStorage({
            version: 1,
            records: snapshot.records.map((row) =>
                row === runRow ? { ...row, key: "wrong-run" } : row
            ),
            parents: snapshot.parents
        });
        const wrongKeyRepository = new RunRepository(wrongKey);
        expectCode(
            () =>
                wrongKeyRepository.transaction((tx) =>
                    wrongKeyRepository.loadRun(tx, new RunId("wrong-run"))
                ),
            "codec.invalid"
        );

        const wrongRevision = new MemoryRunStorage({
            version: 1,
            records: snapshot.records.map((row) =>
                row === runRow ? { ...row, revision: 99 } : row
            ),
            parents: snapshot.parents
        });
        const wrongRevisionRepository = new RunRepository(wrongRevision);
        expectCode(
            () => wrongRevisionRepository.transaction((tx) => wrongRevisionRepository.listRuns(tx)),
            "codec.invalid"
        );
    });

    it("[C13-RUN-ANCESTRY] detects missing and foreign ancestry while preserving valid ancestry", () => {
        const value = seedRunningTurn();
        expect(
            value.repository.transaction((tx) =>
                value.repository.isAncestor(tx, ids.root, ids.root)
            )
        ).toBe(true);
        expect(
            value.repository.transaction((tx) =>
                value.repository.isAncestor(tx, new RunCommitId("missing"), ids.root)
            )
        ).toBe(false);

        const snapshot = value.storage.snapshot();
        const root = snapshot.records.find((row) => row.kind === "commit")!;
        const foreignBytes = root.bytes.slice();
        const foreign = new MemoryRunStorage({
            version: 1,
            records: [
                ...snapshot.records,
                {
                    ...root,
                    key: "foreign-key",
                    revision: null,
                    bytes: foreignBytes
                }
            ],
            parents: snapshot.parents
        });
        const repository = new RunRepository(foreign);
        expectCode(
            () =>
                repository.transaction((tx) =>
                    repository.loadCommit(tx, new RunCommitId("foreign-key"))
                ),
            "codec.invalid"
        );
    });

    it("enforces exact revision increments", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const run = value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run)!);
        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    value.repository.replaceRun(tx, new Revision(8), run.revise())
                ),
            "protocol.revision-conflict"
        );
    });

    it("rejects admission identity changes before compare-and-swap", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const current = value.repository.transaction((tx) =>
            value.repository.loadAdmission(tx, ids.run)!
        );

        expectCode(
            () =>
                value.repository.transaction((tx) =>
                    value.repository.replaceAdmission(
                        tx,
                        current,
                        RunAdmissionRegistry.initial(new RunId("other-admission"))
                    )
                ),
            "run.invalid-state"
        );
        expect(
            value.repository.transaction((tx) => value.repository.loadAdmission(tx, ids.run))
        ).toEqual(current);
    });

    it("fails closed after restart when ancestry loses an intermediate commit", () => {
        const value = seedRunningTurn();
        const first = message("ancestry-first", ids.root, value.token);
        value.runtime.appendCommit(first, new Revision(0), new Date(1500));
        const second = message("ancestry-second", first.id, value.token);
        value.runtime.appendCommit(second, new Revision(1), new Date(1600));
        const snapshot = value.storage.snapshot();
        const restarted = new RunRepository(
            new MemoryRunStorage({
                ...snapshot,
                records: snapshot.records.filter(
                    (record) => !(record.kind === "commit" && record.key === first.id.value)
                )
            })
        );

        expectCode(
            () => restarted.transaction((tx) => restarted.isAncestor(tx, ids.root, second.id)),
            "codec.invalid"
        );
    });

    it("[C13-RUN-PINS-BLUEPRINT] fails closed after restart when the active pin snapshot is omitted", () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const snapshot = value.storage.snapshot();
        const restarted = harness({
            ...snapshot,
            records: snapshot.records.filter((record) => record.kind !== "configuration")
        });

        expectCode(() => seedRunningTurn(restarted), "run.invalid-state");
        expect(
            restarted.repository.transaction((tx) => restarted.repository.listTurns(tx))
        ).toEqual([]);
    });
});

function message(
    id: string,
    parent: RunCommitId,
    token: {
        readonly turn: typeof ids.turn;
        readonly holder: typeof ids.holder;
        readonly epoch: number;
    }
): RunCommit {
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

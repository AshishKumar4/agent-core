import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { ReceiptId } from "../../../src/invocation-references";
import { AuditRecordId, EventId } from "../../../src/interaction-references";
import { RunCommit } from "../../../src/agents/runs/commit";
import { ForcedTurnCancellation } from "../../../src/agents/runs/forced-cancellation";
import { RunId, TurnInboxEntryId } from "../../../src/agents/runs/id";
import { MemoryRunStorage } from "../../../src/agents/runs/memory";
import { RunRepository } from "../../../src/agents/runs/store";
import { TurnInboxEntry } from "../../../src/agents/runs/turn";
import { content, digest, genesis, harness, ids, pins, refs } from "./fixture";

function expectCode(
    label: string,
    operation: () => unknown,
    code: AgentCoreError["code"],
    message: string
): void {
    try {
        operation();
        throw new Error(`Expected AgentCoreError: ${label}`);
    } catch (error) {
        expect(error, label).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code, label).toBe(code);
        expect((error as AgentCoreError).message, label).toBe(message);
    }
}

function repository() {
    const storage = new MemoryRunStorage();
    return { storage, repository: new RunRepository(storage) };
}

function rootCommit(): RunCommit {
    return new RunCommit({
        id: ids.root,
        run: ids.run,
        branch: ids.branch,
        kind: "root",
        parents: [],
        pins: pins(),
        writer: { kind: "root" }
    });
}

function message(id: string, parents: readonly RunCommitId[]): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "message",
        parents: [...parents],
        pins: pins(),
        writer: { kind: "turn", token: { turn: ids.turn, holder: ids.holder, epoch: 1 } },
        subjectTurn: ids.turn,
        content: content("1")
    });
}

function inboxEntry(id: string, turn: TurnId, sequence: number): TurnInboxEntry {
    return new TurnInboxEntry(
        new TurnInboxEntryId(id),
        turn,
        sequence,
        "message",
        content("a"),
        digest("a"),
        `${id}-key`,
        undefined,
        new Date(1000)
    );
}

function cancellation(run: RunId, suffix: string): ForcedTurnCancellation {
    return new ForcedTurnCancellation({
        run,
        terminalTurn: new TurnId(`store-terminal-${suffix}`),
        turn: new TurnId(`store-sibling-${suffix}`),
        priorLeaseEpoch: 1,
        fencedLeaseEpoch: 2,
        controlReceipt: new ReceiptId(`store-receipt-${suffix}`),
        controlAudit: new AuditRecordId(`store-control-audit-${suffix}`),
        cancellationEvent: new EventId(`store-event-${suffix}`),
        cancellationAudit: new AuditRecordId(`store-cancellation-audit-${suffix}`)
    });
}

describe("RunRepository projections", () => {
    test("orders inbox entries by sequence within the addressed Turn", { tags: "p1" }, () => {
        const value = repository();
        const otherTurn = new TurnId("store-other-turn");
        value.repository.transaction((tx) => {
            value.repository.insertInbox(tx, inboxEntry("inbox-a", ids.turn, 5));
            value.repository.insertInbox(tx, inboxEntry("inbox-b", ids.turn, 1));
            value.repository.insertInbox(tx, inboxEntry("inbox-c", ids.turn, 3));
            value.repository.insertInbox(tx, inboxEntry("inbox-d", otherTurn, 0));
        });

        const listed = value.repository.transaction((tx) =>
            value.repository.listInbox(tx, ids.turn)
        );
        expect(listed.map((entry) => [entry.id.value, entry.sequence])).toEqual([
            ["inbox-b", 1],
            ["inbox-c", 3],
            ["inbox-a", 5]
        ]);
    });

    test("filters forced cancellations to the requested Run", { tags: "p1" }, () => {
        const value = repository();
        const mine = cancellation(ids.run, "mine");
        const foreign = cancellation(new RunId("store-foreign-run"), "foreign");
        value.repository.transaction((tx) => {
            value.repository.insertForcedCancellation(tx, mine);
            value.repository.insertForcedCancellation(tx, foreign);
        });

        expect(
            value.repository.transaction((tx) =>
                value.repository.listForcedCancellations(tx, ids.run)
            )
        ).toEqual([mine]);
        expect(
            value.repository.transaction((tx) =>
                value.repository.listForcedCancellations(tx, new RunId("store-foreign-run"))
            )
        ).toEqual([foreign]);
    });
});

describe("RunRepository ancestry", () => {
    test("returns an exact false verdict after full traversal", { tags: "p1" }, () => {
        const value = repository();
        const child = message("store-chain-child", [ids.root]);
        value.repository.transaction((tx) => {
            value.repository.insertCommit(tx, rootCommit());
            value.repository.insertCommit(tx, child);
        });

        expect(
            value.repository.transaction((tx) =>
                value.repository.isAncestor(tx, ids.root, child.id)
            )
        ).toBe(true);
        expect(
            value.repository.transaction((tx) =>
                value.repository.isAncestor(tx, child.id, ids.root)
            )
        ).toBe(false);
    });

    test("terminates traversal over cyclic parent records", { tags: "p1" }, () => {
        const value = repository();
        const cycleA = message("store-cycle-a", [new RunCommitId("store-cycle-b")]);
        const cycleB = message("store-cycle-b", [new RunCommitId("store-cycle-a")]);
        value.repository.transaction((tx) => {
            value.repository.insertCommit(tx, rootCommit());
            value.repository.insertCommit(tx, cycleA);
            value.repository.insertCommit(tx, cycleB);
        });

        expect(
            value.repository.transaction((tx) =>
                value.repository.isAncestor(tx, ids.root, cycleA.id)
            )
        ).toBe(false);
    });
});

describe("RunRepository corruption detection", () => {
    test("detects revision corruption on the single-record load path", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const snapshot = value.storage.snapshot();
        const corrupted = new RunRepository(
            new MemoryRunStorage({
                ...snapshot,
                records: snapshot.records.map((row) =>
                    row.kind === "run" ? { ...row, revision: 99 } : row
                )
            })
        );

        expectCode(
            "load revision mismatch",
            () => corrupted.transaction((tx) => corrupted.loadRun(tx, ids.run)),
            "codec.invalid",
            "Stored Run projection does not match codec bytes"
        );
    });

    test("detects key corruption on the list path", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const snapshot = value.storage.snapshot();
        const corrupted = new RunRepository(
            new MemoryRunStorage({
                ...snapshot,
                records: snapshot.records.map((row) =>
                    row.kind === "run" ? { ...row, key: "store-wrong-run" } : row
                )
            })
        );

        expectCode(
            "list key mismatch",
            () => corrupted.transaction((tx) => corrupted.listRuns(tx)),
            "codec.invalid",
            "Stored Run list projection does not match codec bytes"
        );
    });

    test("detects a missing parent edge for a merge commit", { tags: "p1" }, () => {
        const value = repository();
        const merge = new RunCommit({
            id: new RunCommitId("store-merge"),
            run: ids.run,
            branch: ids.branch,
            kind: "merge",
            parents: [ids.root, new RunCommitId("store-merge-source")],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            content: content("e"),
            resolution: { kind: "pick", parent: ids.root },
            receipt: refs.receipt
        });
        value.repository.transaction((tx) => {
            value.repository.insertCommit(tx, rootCommit());
            value.repository.insertCommit(tx, merge);
        });
        const snapshot = value.storage.snapshot();
        const pruned = new RunRepository(
            new MemoryRunStorage({
                ...snapshot,
                parents: snapshot.parents.filter(
                    (edge) => !(edge.commit === merge.id.value && edge.ordinal === 1)
                )
            })
        );

        expectCode(
            "load with missing edge",
            () => pruned.transaction((tx) => pruned.loadCommit(tx, merge.id)),
            "codec.invalid",
            "Stored Run parents do not match commit bytes"
        );
        expectCode(
            "list with missing edge",
            () => pruned.transaction((tx) => pruned.listCommits(tx)),
            "codec.invalid",
            "Stored Run parents do not match commit bytes"
        );
    });

    test("detects a tampered parent edge value", { tags: "p1" }, () => {
        const value = repository();
        const child = message("store-tampered-child", [ids.root]);
        value.repository.transaction((tx) => {
            value.repository.insertCommit(tx, rootCommit());
            value.repository.insertCommit(tx, child);
        });
        const snapshot = value.storage.snapshot();
        const tampered = new RunRepository(
            new MemoryRunStorage({
                ...snapshot,
                parents: snapshot.parents.map((edge) =>
                    edge.commit === child.id.value
                        ? { ...edge, parent: "store-tampered-parent" }
                        : edge
                )
            })
        );

        expectCode(
            "load with tampered edge",
            () => tampered.transaction((tx) => tampered.loadCommit(tx, child.id)),
            "codec.invalid",
            "Stored Run parents do not match commit bytes"
        );
    });
});

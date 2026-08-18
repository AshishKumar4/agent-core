import { describe, expect, test } from "vitest";
import { ContentRef, Revision } from "../../../src/core";
import { ContentOwnerEdge } from "../../../src/content";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { ReceiptId } from "../../../src/invocation-references";
import { AuditRecordId, EventId } from "../../../src/interaction-references";
import { RunCommit, type RunCommitInit } from "../../../src/agents/runs/commit";
import { ForcedTurnCancellation } from "../../../src/agents/runs/forced-cancellation";
import {
    RunCheckpointId,
    RunId,
    SpawnReservationId,
    TurnInboxEntryId
} from "../../../src/agents/runs/id";
import type { MemoryRunStorageSnapshot } from "../../../src/agents/runs/memory";
import { RunBranch } from "../../../src/agents/runs/run";
import { SpawnReservation } from "../../../src/agents/runs/spawn";
import type { RunRepository } from "../../../src/agents/runs/store";
import { RunCheckpoint, RunCheckpointCodec, TurnInboxEntry } from "../../../src/agents/runs/turn";
import {
    attenuationDigest,
    content,
    digest,
    genesis,
    harness,
    ids,
    memoryRunStorage,
    pins,
    refs,
    seedRunningTurn,
    testRunRepository,
    thrownBy,
    type Assembled
} from "./fixture";
import { SpawnAttenuation } from "../../../src/agents/runs/ceiling";

function expectCode(
    label: string,
    operation: () => void,
    code: AgentCoreError["code"],
    message: string
): void {
    const failure = thrownBy(AgentCoreError, operation, label);
    expect(failure.code, label).toBe(code);
    expect(failure.message, label).toBe(message);
}

function repository() {
    const storage = memoryRunStorage();
    return { storage, repository: testRunRepository(storage) };
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

const CHECKPOINT = new RunCheckpointId("scope-checkpoint");
const CHECKPOINT_COMMIT = new RunCommitId("scope-checkpoint-commit");
const CHECKPOINT_STATE = content("c");
const SCOPE_NOW = new Date(3_000);

// The state loadExecutionScope exists to join: a Turn that suspended under one lease and
// was reclaimed under the next. It is also the only state in which a turn-authored
// checkpoint commit sits on the branch legitimately — the commit names the epoch that
// wrote it, and the running token is a later one.
function resumedTurn(tree?: ContentRef) {
    const seeded = seedRunningTurn();
    const commitInit: Assembled<RunCommitInit> = {
        id: CHECKPOINT_COMMIT,
        run: ids.run,
        branch: ids.branch,
        kind: "checkpoint",
        parents: [ids.root],
        pins: pins(),
        writer: { kind: "turn", token: seeded.token },
        subjectTurn: ids.turn,
        content: CHECKPOINT_STATE
    };
    if (tree !== undefined) commitInit.treeCheckpoint = tree;
    const commit = new RunCommit(commitInit);
    seeded.runtime.suspendTurn({
        turn: ids.turn,
        expectedTurnRevision: seeded.running.revision,
        expectedBranchRevision: new Revision(0),
        token: seeded.token,
        checkpoint: new RunCheckpoint(CHECKPOINT, ids.turn, commit.id, CHECKPOINT_STATE, 0, tree),
        commit,
        now: new Date(2_000)
    });
    const suspended = seeded.repository.transaction((tx) =>
        seeded.repository.loadTurn(tx, ids.turn)!
    );
    const resumed = seeded.runtime.claimTurn(
        ids.turn,
        suspended.revision,
        ids.holder,
        new Date(2_500),
        new Date(8_000)
    );
    return {
        ...seeded,
        commit,
        token: Object.freeze({ turn: ids.turn, holder: ids.holder, epoch: resumed.lease.epoch })
    };
}

function withCheckpoint(snapshot: MemoryRunStorageSnapshot, checkpoint: RunCheckpoint) {
    const records = snapshot.records.map((row) =>
        row.kind === "checkpoint" ? { ...row, bytes: RunCheckpointCodec.encode(checkpoint) } : row
    );
    const prefix = ownerPrefix("checkpoint", checkpoint.id.value);
    const edges = [
        new ContentOwnerEdge(ids.holder.tenantId, ids.actor, `${prefix}state`, checkpoint.state),
        ...(checkpoint.tree === undefined
            ? []
            : [
                  new ContentOwnerEdge(
                      ids.holder.tenantId,
                      ids.actor,
                      `${prefix}tree`,
                      checkpoint.tree
                  )
              ])
    ];
    return testRunRepository(
        memoryRunStorage({
            ...snapshot,
            records,
            content: replaceOwnerNamespace(snapshot, prefix, edges)
        })
    );
}

function without(snapshot: MemoryRunStorageSnapshot, kind: string, key: string) {
    const prefix = recordOwnerPrefix(kind, key);
    return testRunRepository(
        memoryRunStorage({
            ...snapshot,
            records: snapshot.records.filter((row) => !(row.kind === kind && row.key === key)),
            content:
                prefix === undefined
                    ? snapshot.content
                    : replaceOwnerNamespace(snapshot, prefix, [])
        })
    );
}

function recordOwnerPrefix(kind: string, key: string): string | undefined {
    switch (kind) {
        case "commit":
            return ownerPrefix("commit", key);
        case "turn":
            return ownerPrefix("turn", key);
        case "checkpoint":
            return ownerPrefix("checkpoint", key);
        case "inbox":
            return ownerPrefix("inbox", key);
        case "spawn":
            return ownerPrefix("spawn", key);
        default:
            return undefined;
    }
}

function ownerPrefix(
    kind: "checkpoint" | "commit" | "inbox" | "spawn" | "turn",
    key: string
): string {
    const ownerKind = {
        checkpoint: "run.checkpoint",
        commit: "run.commit",
        inbox: "turn.inbox-entry",
        spawn: "run.spawn-reservation",
        turn: "turn.record"
    }[kind];
    return `record:${ownerKind}:${key.length}:${key}:`;
}

function replaceOwnerNamespace(
    snapshot: MemoryRunStorageSnapshot,
    prefix: string,
    replacements: readonly ContentOwnerEdge[]
): MemoryRunStorageSnapshot["content"] {
    const edges = [
        ...snapshot.content.edges.filter(
            (bytes) => !ContentOwnerEdge.decode(bytes).ownerKey.startsWith(prefix)
        ),
        ...replacements.map(ContentOwnerEdge.encode)
    ];
    const owned = new Set(edges.map((bytes) => ContentOwnerEdge.decode(bytes).ref.value));
    const relations = snapshot.content.relations
        .filter((relation) => relation.unownedSince !== null || owned.has(relation.ref))
        .map((relation) =>
            owned.has(relation.ref) ? { ...relation, unownedSince: null } : relation
        );
    for (const ref of owned) {
        if (!relations.some((relation) => relation.ref === ref)) {
            relations.push({ ref, unownedSince: null });
        }
    }
    return { ...snapshot.content, edges, relations };
}

function expectScopeRefused<Transaction>(
    label: string,
    value: RunRepository<Transaction>,
    token: Parameters<RunRepository<Transaction>["loadExecutionScope"]>[1],
    message = "Turn executor scope does not match canonical Run state"
): void {
    expectCode(
        label,
        () => value.transaction((tx) => value.loadExecutionScope(tx, token, SCOPE_NOW)),
        "turn.invalid-state",
        message
    );
}

describe("Run execution scope join", () => {
    test("loads the scope a resumed suspended Turn presents", { tags: "p0" }, () => {
        const resumed = resumedTurn();
        const scope = resumed.repository.transaction((tx) =>
            resumed.repository.loadExecutionScope(tx, resumed.token, SCOPE_NOW)
        );

        expect(scope.turn.id).toEqual(ids.turn);
        expect(scope.head.id).toEqual(CHECKPOINT_COMMIT);
        expect(scope.checkpoint?.id).toEqual(CHECKPOINT);
        expect(scope.effectiveCommit.id).toEqual(ids.root);
        expect(Object.isFrozen(scope)).toBe(true);
    });

    test(
        "refuses a checkpoint or result commit the running token left on the branch",
        { tags: "p0" },
        () => {
            // A checkpoint or result commit and the Turn transition that pairs with it are
            // written in one transaction. One on the branch under the token that is still
            // running means the pair came apart, and resuming against it would replay a
            // transition the Run has already recorded.
            for (const kind of ["checkpoint", "result"] as const) {
                const seeded = seedRunningTurn();
                const orphan = new RunCommit({
                    id: new RunCommitId(`scope-unpaired-${kind}`),
                    run: ids.run,
                    branch: ids.branch,
                    kind,
                    parents: [ids.root],
                    pins: pins(),
                    writer: { kind: "turn", token: seeded.token },
                    subjectTurn: ids.turn,
                    content: content("b")
                });
                seeded.repository.transaction((tx) => {
                    seeded.repository.insertCommit(tx, orphan);
                    seeded.repository.replaceBranch(
                        tx,
                        new Revision(0),
                        new RunBranch(ids.branch, ids.run, "main", orphan.id, new Revision(1))
                    );
                });

                expectScopeRefused(`unpaired ${kind}`, seeded.repository, seeded.token);
            }
        }
    );

    test("admits a message commit the running token left on the branch", { tags: "p1" }, () => {
        // The pairing rule is about the two commit kinds that carry a Turn transition.
        // Message commits are appended freely inside a Turn and must not trip it.
        const seeded = seedRunningTurn();
        const appended = new RunCommit({
            id: new RunCommitId("scope-paired-message"),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: seeded.token },
            subjectTurn: ids.turn,
            content: content("b")
        });
        seeded.repository.transaction((tx) => {
            seeded.repository.insertCommit(tx, appended);
            seeded.repository.replaceBranch(
                tx,
                new Revision(0),
                new RunBranch(ids.branch, ids.run, "main", appended.id, new Revision(1))
            );
        });

        expect(
            seeded.repository.transaction((tx) =>
                seeded.repository.loadExecutionScope(tx, seeded.token, SCOPE_NOW)
            ).head.id
        ).toEqual(appended.id);
    });

    test("refuses a checkpoint record whose Turn is not the one resuming", { tags: "p0" }, () => {
        // Every other joined field still agrees, including the commit's own subjectTurn.
        // Only the checkpoint's own Turn disagrees, which is the single fact that decides
        // whether this Turn may resume from this state.
        const resumed = resumedTurn();
        const foreign = withCheckpoint(
            resumed.storage.snapshot(),
            new RunCheckpoint(
                CHECKPOINT,
                new TurnId("scope-other-turn"),
                CHECKPOINT_COMMIT,
                CHECKPOINT_STATE,
                0,
                undefined
            )
        );

        expectScopeRefused("foreign checkpoint Turn", foreign, resumed.token);
    });

    test("refuses a checkpoint whose commit is not a checkpoint commit", { tags: "p0" }, () => {
        // The substituted commit agrees on Run, branch, pins, subject Turn, content, tree
        // and ancestry; its kind is the only thing left. A checkpoint that could name any
        // commit would let a Turn resume from a state no suspension ever wrote.
        const resumed = resumedTurn();
        const plain = new RunCommit({
            id: new RunCommitId("scope-plain-message"),
            run: ids.run,
            branch: ids.branch,
            kind: "message",
            parents: [CHECKPOINT_COMMIT],
            pins: pins(),
            writer: { kind: "turn", token: resumed.token },
            subjectTurn: ids.turn,
            content: CHECKPOINT_STATE
        });
        resumed.repository.transaction((tx) => {
            resumed.repository.insertCommit(tx, plain);
            resumed.repository.replaceBranch(
                tx,
                new Revision(1),
                new RunBranch(ids.branch, ids.run, "main", plain.id, new Revision(2))
            );
        });
        const substituted = withCheckpoint(
            resumed.storage.snapshot(),
            new RunCheckpoint(CHECKPOINT, ids.turn, plain.id, CHECKPOINT_STATE, 0, undefined)
        );

        expectScopeRefused("non-checkpoint commit", substituted, resumed.token);
    });

    test("pairs the checkpoint's tree with its commit's, present or absent", { tags: "p0" }, () => {
        // Both sides declare a tree or neither does, and when both do they name the same
        // content. Each of the four combinations is a distinct verdict, and a comparison
        // that collapsed any pair of them would let a Turn resume onto a tree its
        // checkpoint commit never recorded.
        const withTree = resumedTurn(content("e"));
        expect(
            withTree.repository.transaction((tx) =>
                withTree.repository.loadExecutionScope(tx, withTree.token, SCOPE_NOW)
            ).checkpoint?.tree
        ).toEqual(content("e"));

        const treeSnapshot = withTree.storage.snapshot();
        expectScopeRefused(
            "different tree",
            withCheckpoint(
                treeSnapshot,
                new RunCheckpoint(
                    CHECKPOINT,
                    ids.turn,
                    CHECKPOINT_COMMIT,
                    CHECKPOINT_STATE,
                    0,
                    content("f")
                )
            ),
            withTree.token
        );
        expectScopeRefused(
            "checkpoint drops the tree",
            withCheckpoint(
                treeSnapshot,
                new RunCheckpoint(
                    CHECKPOINT,
                    ids.turn,
                    CHECKPOINT_COMMIT,
                    CHECKPOINT_STATE,
                    0,
                    undefined
                )
            ),
            withTree.token
        );

        const withoutTree = resumedTurn();
        expect(
            withoutTree.repository.transaction((tx) =>
                withoutTree.repository.loadExecutionScope(tx, withoutTree.token, SCOPE_NOW)
            ).checkpoint?.tree
        ).toBeUndefined();
        expectScopeRefused(
            "checkpoint adds a tree",
            withCheckpoint(
                withoutTree.storage.snapshot(),
                new RunCheckpoint(
                    CHECKPOINT,
                    ids.turn,
                    CHECKPOINT_COMMIT,
                    CHECKPOINT_STATE,
                    0,
                    content("e")
                )
            ),
            withoutTree.token
        );
    });

    test(
        "names the joined record that is absent rather than dereferencing it",
        { tags: "p0" },
        () => {
            const resumed = resumedTurn();
            const snapshot = resumed.storage.snapshot();
            const cases = [
                {
                    kind: "turn",
                    key: ids.turn.value,
                    message: "Turn executor target does not exist"
                },
                { kind: "run", key: ids.run.value, message: "Turn executor Run does not exist" },
                {
                    kind: "branch",
                    key: ids.branch.value,
                    message: "Turn executor branch does not exist"
                },
                {
                    kind: "commit",
                    key: CHECKPOINT_COMMIT.value,
                    message: "Turn executor branch head does not exist"
                },
                {
                    kind: "commit",
                    key: ids.root.value,
                    message: "Turn executor start head does not exist"
                },
                {
                    kind: "placement",
                    key: ids.turn.value,
                    message: "Turn executor placement does not exist"
                },
                {
                    kind: "checkpoint",
                    key: CHECKPOINT.value,
                    message: "Turn executor checkpoint does not exist"
                }
            ] as const;
            for (const { kind, key, message } of cases) {
                expectScopeRefused(
                    `missing ${kind} ${key}`,
                    without(snapshot, kind, key),
                    resumed.token,
                    message
                );
            }
        }
    );
});

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

describe("RunRepository spawn reservations", () => {
    test("refuses to answer with one of several reservations for a child", { tags: "p0" }, () => {
        // The reservation naming a Run as child is where that Run's declared resource
        // ceiling lives, so two of them are two different ceilings for one Run and there is
        // no defensible way to pick between them.
        const child = new RunId("store-spawn-child");
        const value = repository();
        const reserve = (suffix: string, attenuation: SpawnAttenuation) =>
            new SpawnReservation(
                new SpawnReservationId(`store-spawn-${suffix}`),
                ids.run,
                ids.turn,
                child,
                { turn: ids.turn, holder: ids.holder, epoch: 1 },
                digest("d"),
                content("4"),
                refs.invocation,
                refs.receipt,
                attenuationDigest(attenuation),
                new Date(1_000)
            );
        const first = reserve("first", new SpawnAttenuation());
        value.repository.transaction((tx) => value.repository.insertSpawn(tx, first));

        expect(
            value.repository.transaction((tx) => value.repository.loadSpawnForChild(tx, child))
        ).toEqual(first);
        expect(
            value.repository.transaction((tx) =>
                value.repository.loadSpawnForChild(tx, new RunId("store-spawn-unspawned"))
            )
        ).toBeUndefined();

        value.repository.transaction((tx) =>
            value.repository.insertSpawn(tx, reserve("second", new SpawnAttenuation()))
        );
        expectCode(
            "two reservations for one child",
            () =>
                value.repository.transaction((tx) => value.repository.loadSpawnForChild(tx, child)),
            "run.invalid-state",
            "Run has more than one spawn reservation"
        );
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
        const corrupted = testRunRepository(
            memoryRunStorage({
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
        const corrupted = testRunRepository(
            memoryRunStorage({
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
        const pruned = testRunRepository(
            memoryRunStorage({
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
        const tampered = testRunRepository(
            memoryRunStorage({
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

    test(
        "detects a tampered parent edge ordinal with the exact parent value",
        { tags: "p0" },
        () => {
            const value = repository();
            const child = message("store-shifted-child", [ids.root]);
            value.repository.transaction((tx) => {
                value.repository.insertCommit(tx, rootCommit());
                value.repository.insertCommit(tx, child);
            });
            const snapshot = value.storage.snapshot();
            const shifted = testRunRepository(
                memoryRunStorage({
                    ...snapshot,
                    parents: snapshot.parents.map((edge) =>
                        edge.commit === child.id.value ? { ...edge, ordinal: 1 } : edge
                    )
                })
            );

            expectCode(
                "load with shifted edge ordinal",
                () => shifted.transaction((tx) => shifted.loadCommit(tx, child.id)),
                "codec.invalid",
                "Stored Run parents do not match commit bytes"
            );
        }
    );
});

import { describe, expect, test } from "vitest";
import { Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import { RunCommit, type RunCommitInit } from "../../../src/agents/runs/commit";
import {
    RunBranchId,
    RunCheckpointId,
    RunId,
    SpawnReservationId,
    TurnInboxEntryId
} from "../../../src/agents/runs/id";
import { RunPins } from "../../../src/agents/runs/pins";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { Run, RunBranch, RunLifecycle } from "../../../src/agents/runs/run";
import { RunAdmissionRegistry } from "../../../src/agents/runs/admission";
import { SpawnReservation } from "../../../src/agents/runs/spawn";
import { SettlementObligation, TerminalSnapshot } from "../../../src/agents/runs/settlement";
import { TurnLease } from "../../../src/agents/runs/lease";
import {
    RunCheckpoint,
    Turn,
    TurnInboxEntry,
    TurnStatus,
    type TurnInit
} from "../../../src/agents/runs/turn";
import { PrincipalId, PrincipalRef } from "../../../src/identity";
import {
    configuration,
    content,
    digest,
    genesis,
    harness,
    ids,
    pins,
    refs,
    seedRunningTurn
} from "./fixture";

function expectCode(
    operation: () => unknown,
    code: AgentCoreError["code"],
    message?: string
): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe(code);
        if (message !== undefined) expect((error as AgentCoreError).message).toBe(message);
        return;
    }
    expect.fail("expected operation to throw");
}

function must<Value>(value: Value | undefined): Value {
    if (value === undefined) throw new Error("expected a value");
    return value;
}

function leaseToken(
    over: Partial<{ turn: TurnId; holder: PrincipalRef; epoch: number }> = {}
): { turn: TurnId; holder: PrincipalRef; epoch: number } {
    return { turn: over.turn ?? ids.turn, holder: over.holder ?? ids.holder, epoch: over.epoch ?? 1 };
}

function messageCommit(id: string, over: Partial<RunCommitInit> = {}): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "message",
        parents: [ids.root],
        pins: pins(),
        writer: { kind: "turn", token: leaseToken() },
        subjectTurn: ids.turn,
        content: content("1"),
        ...over
    });
}

function migrationCommit(id: string, over: Partial<RunCommitInit> = {}): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "migration",
        parents: [ids.root],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
        },
        receipt: refs.receipt,
        migration: { from: pins(), to: pins() },
        ...over
    });
}

function withControl(value: ReturnType<typeof harness>, commit: RunCommit): void {
    value.evidence.controls.set(`${refs.receipt.value}:${refs.audit.value}`, {
        kind: "control",
        run: ids.run,
        receipt: refs.receipt,
        audit: refs.audit,
        proposalDigest: commit.proposalDigest.value
    });
}

function withReceipt(value: ReturnType<typeof harness>): void {
    value.evidence.receipts.set(`${refs.receipt.value}:${refs.audit.value}`, {
        kind: "receipt",
        run: ids.run,
        receipt: refs.receipt,
        audit: refs.audit,
        invocation: refs.invocation
    });
}

function differentPins(): RunPins {
    const base = pins();
    return new RunPins({ ...base, agent: { ...base.agent, revision: new Revision(4) } });
}

function terminalRun(): Run {
    const base = genesis().run;
    return new Run({
        id: base.id,
        agent: base.agent,
        configuration: base.configuration,
        root: base.root,
        initialBranch: base.initialBranch,
        lifecycle: RunLifecycle.terminal,
        terminal: new TerminalSnapshot(
            base.id,
            ids.turn,
            ids.root,
            new RunCommitId("terminal-snapshot-commit"),
            "succeeded",
            new SettlementObligation({ registryEpoch: 1, obligations: [] }),
            new Date(2000)
        ),
        revision: new Revision(0)
    });
}

function turnGenesis(
    id: string,
    over: Partial<TurnInit> = {}
): { turn: Turn; placement: TurnPlacementSnapshot } {
    const turnId = new TurnId(id);
    const placement = new TurnPlacementSnapshot(turnId, pins(), []);
    const turn = new Turn({
        id: turnId,
        run: ids.run,
        branch: ids.branch,
        startHead: ids.root,
        effectiveInput: ids.root,
        pins: pins(),
        placement: placement.digest,
        input: content("a"),
        revision: new Revision(0),
        ...over
    });
    return { turn, placement };
}

describe("spawn reservation guards", () => {
    function childGenesis(over: Partial<{ parent: RunId | undefined; rootContent: boolean }> = {}) {
        const snapshot = configuration();
        const childId = new RunId("run-child");
        const childBranchId = new RunBranchId("branch-child");
        const childRootId = new RunCommitId("commit-child-root");
        const root = new RunCommit({
            id: childRootId,
            run: childId,
            branch: childBranchId,
            kind: "root",
            parents: [],
            pins: snapshot.pins,
            writer: { kind: "root" },
            ...(over.rootContent === false ? {} : { content: content("5") })
        });
        const parent = "parent" in over ? over.parent : ids.run;
        const run = new Run({
            id: childId,
            agent: ids.agent,
            configuration: snapshot.id,
            root: childRootId,
            initialBranch: childBranchId,
            ...(parent === undefined ? {} : { parent }),
            revision: new Revision(0)
        });
        return {
            run,
            configuration: snapshot,
            branch: new RunBranch(childBranchId, childId, "main", childRootId, new Revision(0)),
            root
        };
    }

    function reservation(
        over: Partial<{
            parentRun: RunId;
            childRun: RunId;
            configuration: ReturnType<typeof digest>;
            rootContent: ReturnType<typeof content>;
        }> = {}
    ): SpawnReservation {
        return new SpawnReservation(
            new SpawnReservationId("spawn-mutation"),
            over.parentRun ?? ids.run,
            ids.turn,
            over.childRun ?? new RunId("run-child"),
            leaseToken(),
            over.configuration ?? configuration().id,
            over.rootContent ?? content("5"),
            refs.invocation,
            refs.receipt,
            digest("6"),
            new Date(1500)
        );
    }

    test(
        "replays an identical reservation only when the spawned child Run exists",
        { tags: "p0" },
        () => {
            const value = seedRunningTurn();
            value.repository.transaction((tx) =>
                value.repository.insertSpawn(tx, reservation())
            );
            expectCode(
                () => value.runtime.spawnRun(reservation(), childGenesis(), new Date(1500)),
                "run.invalid-state",
                "Spawn reservation identity conflicts"
            );

            const fresh = seedRunningTurn();
            fresh.runtime.spawnRun(reservation(), childGenesis(), new Date(1500));
            expect(() =>
                fresh.runtime.spawnRun(reservation(), childGenesis(), new Date(1500))
            ).not.toThrow();
            expect(
                fresh.repository.transaction((tx) =>
                    fresh.repository.loadRun(tx, new RunId("run-child"))
                )
            ).toBeDefined();
        }
    );

    test("rejects every non-exact attenuated child genesis field", { tags: "p0" }, () => {
        const cases: readonly {
            readonly label: string;
            readonly seed: (value: ReturnType<typeof seedRunningTurn>) => void;
            readonly reservation: () => SpawnReservation;
            readonly genesis: () => ReturnType<typeof childGenesis>;
        }[] = [
            {
                label: "spawning Turn belongs to another Run",
                seed: (value) => {
                    const other = new RunId("run-elsewhere");
                    const otherBranch = new RunBranchId("branch-elsewhere");
                    const otherRootId = new RunCommitId("commit-elsewhere-root");
                    const snapshot = configuration();
                    const root = new RunCommit({
                        id: otherRootId,
                        run: other,
                        branch: otherBranch,
                        kind: "root",
                        parents: [],
                        pins: snapshot.pins,
                        writer: { kind: "root" },
                        content: content("4")
                    });
                    value.runtime.createRun({
                        run: new Run({
                            id: other,
                            agent: ids.agent,
                            configuration: snapshot.id,
                            root: otherRootId,
                            initialBranch: otherBranch,
                            revision: new Revision(0)
                        }),
                        configuration: snapshot,
                        branch: new RunBranch(otherBranch, other, "main", otherRootId, new Revision(0)),
                        root
                    });
                },
                reservation: () => reservation({ parentRun: new RunId("run-elsewhere") }),
                genesis: () => childGenesis({ parent: new RunId("run-elsewhere") })
            },
            {
                label: "child Run identifier differs",
                seed: () => {},
                reservation: () => reservation({ childRun: new RunId("run-child-other") }),
                genesis: () => childGenesis()
            },
            {
                label: "child genesis has no parent",
                seed: () => {},
                reservation: () => reservation(),
                genesis: () => childGenesis({ parent: undefined })
            },
            {
                label: "child genesis names a different parent",
                seed: () => {},
                reservation: () => reservation(),
                genesis: () => childGenesis({ parent: new RunId("run-elsewhere") })
            },
            {
                label: "configuration digest differs",
                seed: () => {},
                reservation: () => reservation({ configuration: digest("9") }),
                genesis: () => childGenesis()
            },
            {
                label: "child root has no content",
                seed: () => {},
                reservation: () => reservation(),
                genesis: () => childGenesis({ rootContent: false })
            },
            {
                label: "child root content differs",
                seed: () => {},
                reservation: () => reservation({ rootContent: content("6") }),
                genesis: () => childGenesis()
            }
        ];
        for (const entry of cases) {
            const value = seedRunningTurn();
            entry.seed(value);
            expectCode(
                () => value.runtime.spawnRun(entry.reservation(), entry.genesis(), new Date(1500)),
                "authority.denied",
                "Spawn reservation is not an exact attenuated child genesis"
            );
        }

        const unverified = seedRunningTurn();
        unverified.spawn.accepts = false;
        expectCode(
            () => unverified.runtime.spawnRun(reservation(), childGenesis(), new Date(1500)),
            "authority.denied",
            "Spawn reservation is not an exact attenuated child genesis"
        );
    });
});

describe("Run genesis guards", () => {
    test("rejects each non-canonical genesis record field", { tags: "p1" }, () => {
        const cases: readonly ((value: ReturnType<typeof genesis>) => ReturnType<typeof genesis>)[] =
            [
                (base) => ({ ...base, run: terminalRun() }),
                (base) => {
                    const { parent, terminal, ...required } = base.run;
                    return {
                        ...base,
                        run: new Run({
                            ...required,
                            ...(parent === undefined ? {} : { parent }),
                            ...(terminal === undefined ? {} : { terminal }),
                            revision: new Revision(1)
                        })
                    };
                },
                (base) => ({
                    ...base,
                    branch: new RunBranch(ids.branch, ids.run, "main", ids.root, new Revision(1))
                }),
                (base) => ({ ...base, root: { ...base.root, kind: "message" } as RunCommit }),
                (base) => ({
                    ...base,
                    root: { ...base.root, writer: { kind: "turn", token: leaseToken() } } as RunCommit
                })
            ];
        for (const mutate of cases) {
            const value = harness();
            expectCode(
                () => value.runtime.createRun(mutate(genesis())),
                "run.invalid-state",
                "Run genesis records do not form one canonical root"
            );
        }
    });

    test("rejects a Run whose Agent is not the pinned Agent", { tags: "p1" }, () => {
        const value = harness();
        const base = genesis();
        const { parent, terminal, ...required } = base.run;
        const forged = new Run({
            ...required,
            agent: ids.policy as never,
            ...(parent === undefined ? {} : { parent }),
            ...(terminal === undefined ? {} : { terminal })
        });
        expectCode(
            () => value.runtime.createRun({ ...base, run: forged }),
            "run.invalid-state",
            "Run Agent does not match its configuration snapshot"
        );
    });

    test("rejects each preexisting genesis identifier individually", { tags: "p1" }, () => {
        const seeds: readonly ((value: ReturnType<typeof harness>) => void)[] = [
            (value) =>
                value.repository.transaction((tx) =>
                    value.repository.insertRun(tx, genesis().run)
                ),
            (value) =>
                value.repository.transaction((tx) =>
                    value.repository.insertCommit(tx, genesis().root)
                ),
            (value) =>
                value.repository.transaction((tx) =>
                    value.repository.insertBranch(tx, genesis().branch)
                ),
            (value) =>
                value.repository.transaction((tx) =>
                    value.repository.insertAdmission(tx, RunAdmissionRegistry.initial(ids.run))
                )
        ];
        for (const seed of seeds) {
            const value = harness();
            seed(value);
            expectCode(
                () => value.runtime.createRun(genesis()),
                "run.invalid-state",
                "Run genesis identifiers already exist"
            );
        }
    });
});

describe("admission registry plumbing", () => {
    test("reserving the same obligation twice keeps the stored registry", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const obligation = { kind: "route", reservation: refs.route } as const;
        const first = value.runtime.reserveRunObligation(ids.run, obligation);
        const second = value.runtime.reserveRunObligation(ids.run, obligation);
        expect(second.registryEpoch).toBe(first.registryEpoch);
        expect(value.runtime.acceptsRunAdmission(second)).toBe(true);
    });

    test("reports a missing admission registry as corruption", { tags: "p2" }, () => {
        const value = harness();
        value.repository.transaction((tx) => value.repository.insertRun(tx, genesis().run));
        expectCode(
            () =>
                value.runtime.reserveRunObligation(ids.run, {
                    kind: "route",
                    reservation: refs.route
                }),
            "codec.invalid",
            "Run admission registry is missing"
        );
    });
});

describe("branch creation guards", () => {
    test("rejects each invalid branch creation field individually", { tags: "p1" }, () => {
        const cases: readonly ((value: ReturnType<typeof harness>) => RunBranch)[] = [
            () =>
                new RunBranch(
                    new RunBranchId("branch-foreign"),
                    new RunId("run-elsewhere"),
                    "feature",
                    ids.root,
                    new Revision(0)
                ),
            () =>
                new RunBranch(
                    new RunBranchId("branch-revised"),
                    ids.run,
                    "feature",
                    ids.root,
                    new Revision(1)
                ),
            () =>
                new RunBranch(
                    new RunBranchId("branch-headless"),
                    ids.run,
                    "feature",
                    new RunCommitId("missing-head"),
                    new Revision(0)
                ),
            () => new RunBranch(ids.branch, ids.run, "feature", ids.root, new Revision(0))
        ];
        for (const build of cases) {
            const value = harness();
            value.runtime.createRun(genesis());
            expectCode(
                () => value.runtime.createBranch(ids.run, build(value), new Revision(0)),
                "run.invalid-state",
                "Run branch creation is invalid"
            );
        }
    });

    test("rejects a duplicate branch name among several branches", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        value.runtime.createBranch(
            ids.run,
            new RunBranch(new RunBranchId("branch-feature"), ids.run, "feature", ids.root, new Revision(0)),
            new Revision(0)
        );
        expectCode(
            () =>
                value.runtime.createBranch(
                    ids.run,
                    new RunBranch(
                        new RunBranchId("branch-feature-2"),
                        ids.run,
                        "feature",
                        ids.root,
                        new Revision(0)
                    ),
                    new Revision(1)
                ),
            "run.invalid-state",
            "Run branch creation is invalid"
        );
    });

    test("requires an existing active Run", { tags: "p2" }, () => {
        const value = harness();
        expectCode(
            () => value.runtime.createBranch(ids.run, genesis().branch, new Revision(0)),
            "run.invalid-state",
            "Run does not exist"
        );
        value.repository.transaction((tx) => value.repository.insertRun(tx, terminalRun()));
        expectCode(
            () => value.runtime.createBranch(ids.run, genesis().branch, new Revision(0)),
            "run.invalid-state",
            "Run is terminal"
        );
    });
});

describe("migration guards", () => {
    test("appendCommit refuses migrations without a verified target", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        expectCode(
            () =>
                value.runtime.appendCommit(
                    migrationCommit("generic-migration"),
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Migration requires an exact verified target configuration snapshot"
        );
    });

    test("migrateRun rejects a commit that is not a migration", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const forgedKind = { ...messageCommit("forged-migration"), kind: "migration" } as RunCommit;
        expectCode(
            () =>
                value.runtime.migrateRun(forgedKind, configuration(), new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Migration target does not resolve an exact authoritative configuration"
        );
        const forgedMessage = {
            ...migrationCommit("forged-message"),
            kind: "message"
        } as RunCommit;
        expectCode(
            () =>
                value.runtime.migrateRun(
                    forgedMessage,
                    configuration(),
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Migration target does not resolve an exact authoritative configuration"
        );
    });

    test("rejects migration evidence whose from pins differ from the parent", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const commit = migrationCommit("migration-wrong-from", {
            migration: { from: differentPins(), to: pins() }
        });
        withControl(value, commit);
        expectCode(
            () => value.runtime.migrateRun(commit, configuration(), new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Migration from pins do not match the parent"
        );
    });

    test("rejects migration ahead of an admitted Turn on the branch", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        value.runtime.createTurn(turnGenesis("turn-admitted"), new Revision(0));
        const commit = migrationCommit("migration-admitted");
        withControl(value, commit);
        expectCode(
            () => value.runtime.migrateRun(commit, configuration(), new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Migration rejects an admitted Turn on its branch"
        );
    });
});

describe("captured evidence guards", () => {
    function invocationCommit(id: string, parent: RunCommitId, over: Partial<RunCommitInit> = {}): RunCommit {
        return new RunCommit({
            id: new RunCommitId(id),
            run: ids.run,
            branch: ids.branch,
            kind: "invocation",
            parents: [parent],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
            },
            invocation: refs.invocation,
            receipt: refs.receipt,
            ...over
        });
    }

    function terminalized(obligations: readonly string[]) {
        const value = seedRunningTurn();
        for (const commit of obligations) {
            value.runtime.reserveRunObligation(ids.run, {
                kind: "systemCommit",
                commit: new RunCommitId(commit)
            });
        }
        const result = new RunCommit({
            id: new RunCommitId("terminal-result"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("b")
        });
        value.runtime.terminalizeRun({
            run: ids.run,
            turn: ids.turn,
            expectedRunRevision: value.repository.transaction((tx) =>
                must(value.repository.loadRun(tx, ids.run)).revision
            ),
            expectedTurnRevision: value.running.revision,
            expectedBranchRevision: new Revision(0),
            token: value.token,
            outcome: "succeeded",
            commit: result,
            siblingCancellations: new Map(),
            now: new Date(2000)
        });
        return { value, head: result.id };
    }

    test("names the missing Run exactly", { tags: "p2" }, () => {
        const value = harness();
        expectCode(
            () =>
                value.runtime.appendCapturedEvidence(
                    invocationCommit("captured-none", ids.root),
                    new Revision(0),
                    new Date(2000)
                ),
            "run.invalid-state",
            "Run does not exist"
        );
    });

    test("rejects captured evidence on an active Run", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        withReceipt(value);
        expectCode(
            () =>
                value.runtime.appendCapturedEvidence(
                    invocationCommit("captured-active", ids.root),
                    new Revision(0),
                    new Date(2000)
                ),
            "run.invalid-state",
            "Post-terminal commit is not a captured obligation"
        );
    });

    test("rejects a commit that is not a settled obligation", { tags: "p0" }, () => {
        const { value, head } = terminalized(["captured-commit"]);
        withReceipt(value);
        expectCode(
            () =>
                value.runtime.appendCapturedEvidence(
                    invocationCommit("captured-unreserved", head),
                    new Revision(1),
                    new Date(2000)
                ),
            "run.invalid-state",
            "Post-terminal commit is not a captured obligation"
        );
    });

    test("non-commit obligations never satisfy a captured commit", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        value.runtime.reserveRunObligation(ids.run, { kind: "route", reservation: refs.route });
        const result = new RunCommit({
            id: new RunCommitId("terminal-route-result"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("b")
        });
        value.runtime.terminalizeRun({
            run: ids.run,
            turn: ids.turn,
            expectedRunRevision: value.repository.transaction((tx) =>
                must(value.repository.loadRun(tx, ids.run)).revision
            ),
            expectedTurnRevision: value.running.revision,
            expectedBranchRevision: new Revision(0),
            token: value.token,
            outcome: "succeeded",
            commit: result,
            siblingCancellations: new Map(),
            now: new Date(2000)
        });
        withReceipt(value);
        expectCode(
            () =>
                value.runtime.appendCapturedEvidence(
                    invocationCommit("captured-route-only", result.id),
                    new Revision(1),
                    new Date(2000)
                ),
            "run.invalid-state",
            "Post-terminal commit is not a captured obligation"
        );
    });

    test("rejects forged writer and commit kinds for captured obligations", { tags: "p0" }, () => {
        const forgedWriter = terminalized(["captured-commit"]);
        withReceipt(forgedWriter.value);
        const turnWritten = {
            ...invocationCommit("captured-commit", forgedWriter.head),
            writer: { kind: "turn", token: forgedWriter.value.token }
        } as RunCommit;
        expectCode(
            () =>
                forgedWriter.value.runtime.appendCapturedEvidence(
                    turnWritten,
                    new Revision(1),
                    new Date(2000)
                ),
            "run.invalid-state",
            "Post-terminal commit is not a captured obligation"
        );

        const forgedKind = terminalized(["captured-commit"]);
        withReceipt(forgedKind.value);
        const messageKind = {
            ...invocationCommit("captured-commit", forgedKind.head),
            kind: "message"
        } as RunCommit;
        expectCode(
            () =>
                forgedKind.value.runtime.appendCapturedEvidence(
                    messageKind,
                    new Revision(1),
                    new Date(2000)
                ),
            "run.invalid-state",
            "Post-terminal commit is not a captured obligation"
        );
    });

    test("appends exact invocation and delivery obligations after terminal", { tags: "p0" }, () => {
        const { value, head } = terminalized(["captured-invocation", "captured-delivery"]);
        withReceipt(value);
        value.evidence.deliveries.set(`${refs.route.value}:${refs.audit.value}`, {
            kind: "delivery",
            run: ids.run,
            reservation: refs.route,
            audit: refs.audit
        });
        const invocation = invocationCommit("captured-invocation", head);
        value.runtime.appendCapturedEvidence(invocation, new Revision(1), new Date(2000));
        const delivery = new RunCommit({
            id: new RunCommitId("captured-delivery"),
            run: ids.run,
            branch: ids.branch,
            kind: "eventDelivery",
            parents: [invocation.id],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "delivery", audit: refs.audit, reservation: refs.route }
            },
            reservation: refs.route
        });
        value.runtime.appendCapturedEvidence(delivery, new Revision(2), new Date(2000));
        const run = value.repository.transaction((tx) =>
            must(value.repository.loadRun(tx, ids.run))
        );
        expect(run.lifecycle.kind).toBe("terminal");
        expect(
            value.repository.transaction((tx) =>
                must(value.repository.loadBranch(tx, ids.branch)).head.equals(delivery.id)
            )
        ).toBe(true);
    });
});

describe("Turn genesis guards", () => {
    test("rejects each non-canonical Turn genesis field individually", { tags: "p1" }, () => {
        const cases: readonly ((value: ReturnType<typeof harness>) => {
            readonly turn: Turn;
            readonly placement: TurnPlacementSnapshot;
        })[] = [
            (value) => {
                value.repository.transaction((tx) =>
                    value.repository.insertBranch(
                        tx,
                        new RunBranch(
                            new RunBranchId("branch-foreign"),
                            new RunId("run-elsewhere"),
                            "foreign",
                            ids.root,
                            new Revision(0)
                        )
                    )
                );
                return turnGenesis("turn-foreign-branch", {
                    branch: new RunBranchId("branch-foreign")
                });
            },
            () => turnGenesis("turn-not-queued", { status: TurnStatus.cancelled }),
            () => turnGenesis("turn-revised", { revision: new Revision(1) }),
            () => {
                const base = turnGenesis("turn-held-lease");
                return {
                    ...base,
                    turn: {
                        ...base.turn,
                        lease: {
                            turn: base.turn.id,
                            holder: ids.holder,
                            epoch: 0,
                            expiresAt: undefined
                        }
                    } as never
                };
            },
            () => {
                const base = turnGenesis("turn-advanced-epoch");
                return {
                    ...base,
                    turn: {
                        ...base.turn,
                        lease: {
                            turn: base.turn.id,
                            holder: undefined,
                            epoch: 1,
                            expiresAt: undefined
                        }
                    } as never
                };
            },
            () => {
                const base = turnGenesis("turn-expiring-lease");
                return {
                    ...base,
                    turn: {
                        ...base.turn,
                        lease: {
                            turn: base.turn.id,
                            holder: undefined,
                            epoch: 0,
                            expiresAt: new Date(2000)
                        }
                    } as never
                };
            },
            () =>
                turnGenesis("turn-checkpointed", {
                    checkpoint: new RunCheckpointId("checkpoint-genesis")
                }),
            () => turnGenesis("turn-resulted", { result: content("9") })
        ];
        for (const build of cases) {
            const value = harness();
            value.runtime.createRun(genesis());
            expectCode(
                () => value.runtime.createTurn(build(value), new Revision(0)),
                "turn.invalid-state",
                "Turn genesis does not match its branch and placement snapshot"
            );
        }
    });

    test("rejects a duplicate Turn identifier", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        value.runtime.createTurn(turnGenesis("turn-duplicate"), new Revision(0));
        expectCode(
            () => value.runtime.createTurn(turnGenesis("turn-duplicate"), new Revision(0)),
            "turn.invalid-state",
            "Turn genesis does not match its branch and placement snapshot"
        );
    });

    test("requires exactly one configuration snapshot for the head pins", { tags: "p1" }, () => {
        const value = harness();
        const base = genesis();
        value.repository.transaction((tx) => {
            value.repository.insertRun(tx, base.run);
            value.repository.insertCommit(tx, base.root);
            value.repository.insertBranch(tx, base.branch);
            value.repository.insertAdmission(tx, RunAdmissionRegistry.initial(ids.run));
        });
        expectCode(
            () => value.runtime.createTurn(turnGenesis("turn-unpinned"), new Revision(0)),
            "run.invalid-state",
            "Run pins do not resolve one exact configuration snapshot"
        );
    });
});

describe("event delivery", () => {
    function inboxEntry(id: string, sequence: number, key: string): TurnInboxEntry {
        return new TurnInboxEntry(
            new TurnInboxEntryId(id),
            ids.turn,
            sequence,
            "message",
            content("6"),
            digest("6"),
            key,
            undefined,
            new Date(1500)
        );
    }

    test("names the missing Turn exactly", { tags: "p2" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        expectCode(
            () =>
                value.runtime.deliverEvent(
                    ids.turn,
                    new Revision(0),
                    leaseToken(),
                    inboxEntry("inbox-no-turn", 0, "no-turn"),
                    new Date(1500)
                ),
            "run.invalid-state",
            "Turn does not exist"
        );
    });

    test("appends the next unique inbox entry", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        value.runtime.deliverEvent(
            ids.turn,
            value.running.revision,
            value.token,
            inboxEntry("inbox-first", 0, "first-key"),
            new Date(1500)
        );
        const inbox = value.repository.transaction((tx) =>
            value.repository.listInbox(tx, ids.turn)
        );
        expect(inbox).toHaveLength(1);
        expect(must(inbox[0]).idempotencyKey).toBe("first-key");
    });

    test("appends successive entries with distinct idempotency keys", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        value.runtime.deliverEvent(
            ids.turn,
            value.running.revision,
            value.token,
            inboxEntry("inbox-first-of-two", 0, "key-one"),
            new Date(1500)
        );
        const advanced = value.repository.transaction((tx) =>
            must(value.repository.loadTurn(tx, ids.turn))
        );
        value.runtime.deliverEvent(
            ids.turn,
            advanced.revision,
            value.token,
            inboxEntry("inbox-second-of-two", 1, "key-two"),
            new Date(1600)
        );
        const inbox = value.repository.transaction((tx) =>
            value.repository.listInbox(tx, ids.turn)
        );
        expect(inbox.map((entry) => entry.idempotencyKey)).toEqual(["key-one", "key-two"]);
    });
});

describe("suspension guards", () => {
    function suspendFixture(tree?: ReturnType<typeof content>) {
        const value = seedRunningTurn();
        const commit = new RunCommit({
            id: new RunCommitId("suspend-commit"),
            run: ids.run,
            branch: ids.branch,
            kind: "checkpoint",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("d"),
            ...(tree === undefined ? {} : { treeCheckpoint: tree })
        });
        const checkpoint = new RunCheckpoint(
            new RunCheckpointId("suspend-checkpoint"),
            ids.turn,
            commit.id,
            content("d"),
            0,
            tree
        );
        return { value, commit, checkpoint };
    }

    function suspend(
        fixture: ReturnType<typeof suspendFixture>,
        over: Partial<{ commit: RunCommit; checkpoint: RunCheckpoint }> = {}
    ): void {
        fixture.value.runtime.suspendTurn({
            turn: ids.turn,
            expectedTurnRevision: fixture.value.running.revision,
            expectedBranchRevision: new Revision(0),
            token: fixture.value.token,
            checkpoint: over.checkpoint ?? fixture.checkpoint,
            commit: over.commit ?? fixture.commit,
            now: new Date(1500)
        });
    }

    test("names the missing Turn exactly", { tags: "p2" }, () => {
        const fixture = suspendFixture();
        const value = harness();
        value.runtime.createRun(genesis());
        expectCode(
            () =>
                value.runtime.suspendTurn({
                    turn: ids.turn,
                    expectedTurnRevision: new Revision(0),
                    expectedBranchRevision: new Revision(0),
                    token: leaseToken(),
                    checkpoint: fixture.checkpoint,
                    commit: fixture.commit,
                    now: new Date(1500)
                }),
            "run.invalid-state",
            "Turn does not exist"
        );
    });

    test("rejects each checkpoint and commit mismatch individually", { tags: "p0" }, () => {
        const cases: readonly ((fixture: ReturnType<typeof suspendFixture>) => Partial<{
            commit: RunCommit;
            checkpoint: RunCheckpoint;
        }>)[] = [
            (fixture) => ({
                checkpoint: new RunCheckpoint(
                    new RunCheckpointId("suspend-checkpoint"),
                    new TurnId("turn-elsewhere"),
                    fixture.commit.id,
                    content("d"),
                    0,
                    undefined
                )
            }),
            () => ({
                checkpoint: new RunCheckpoint(
                    new RunCheckpointId("suspend-checkpoint"),
                    ids.turn,
                    new RunCommitId("commit-elsewhere"),
                    content("d"),
                    0,
                    undefined
                )
            }),
            () => {
                const commit = messageCommit("suspend-not-checkpoint", { content: content("d") });
                return {
                    commit,
                    checkpoint: new RunCheckpoint(
                        new RunCheckpointId("suspend-checkpoint"),
                        ids.turn,
                        commit.id,
                        content("d"),
                        0,
                        undefined
                    )
                };
            },
            (fixture) => ({
                commit: { ...fixture.commit, subjectTurn: undefined } as RunCommit
            }),
            (fixture) => ({
                commit: {
                    ...fixture.commit,
                    subjectTurn: new TurnId("turn-elsewhere")
                } as RunCommit
            }),
            (fixture) => ({
                commit: { ...fixture.commit, writer: { kind: "root" } } as RunCommit
            }),
            (fixture) => ({
                commit: {
                    ...fixture.commit,
                    writer: {
                        kind: "turn",
                        token: leaseToken({ turn: new TurnId("turn-elsewhere") })
                    }
                } as RunCommit
            }),
            (fixture) => ({
                commit: {
                    ...fixture.commit,
                    writer: {
                        kind: "turn",
                        token: leaseToken({
                            holder: new PrincipalRef(
                                ids.holder.tenantId,
                                new PrincipalId("principal-elsewhere")
                            )
                        })
                    }
                } as RunCommit
            }),
            (fixture) => ({
                commit: {
                    ...fixture.commit,
                    writer: { kind: "turn", token: leaseToken({ epoch: 2 }) }
                } as RunCommit
            }),
            (fixture) => ({
                commit: { ...fixture.commit, content: undefined } as RunCommit
            }),
            (fixture) => ({
                commit: { ...fixture.commit, content: content("9") } as RunCommit
            }),
            (fixture) => ({
                commit: { ...fixture.commit, treeCheckpoint: content("7") } as RunCommit
            }),
            (fixture) => ({
                checkpoint: new RunCheckpoint(
                    new RunCheckpointId("suspend-checkpoint"),
                    ids.turn,
                    fixture.commit.id,
                    content("d"),
                    0,
                    content("7")
                )
            }),
            (fixture) => ({
                checkpoint: new RunCheckpoint(
                    new RunCheckpointId("suspend-checkpoint"),
                    ids.turn,
                    fixture.commit.id,
                    content("d"),
                    1,
                    undefined
                )
            })
        ];
        for (const build of cases) {
            const fixture = suspendFixture();
            expectCode(
                () => suspend(fixture, build(fixture)),
                "turn.invalid-state",
                "Suspend checkpoint and commit do not match the Turn"
            );
        }

        const mismatched = suspendFixture(content("7"));
        expectCode(
            () =>
                suspend(mismatched, {
                    checkpoint: new RunCheckpoint(
                        new RunCheckpointId("suspend-checkpoint"),
                        ids.turn,
                        mismatched.commit.id,
                        content("d"),
                        0,
                        content("8")
                    )
                }),
            "turn.invalid-state",
            "Suspend checkpoint and commit do not match the Turn"
        );
    });

    test("suspends with matching absent tree checkpoints", { tags: "p0" }, () => {
        const fixture = suspendFixture();
        suspend(fixture);
        const suspended = fixture.value.repository.transaction((tx) =>
            must(fixture.value.repository.loadTurn(tx, ids.turn))
        );
        expect(suspended.status.kind).toBe("suspended");
        expect(suspended.lease.holder).toBeUndefined();
        expect(suspended.lease.epoch).toBe(2);
        expect(
            fixture.value.repository.transaction((tx) =>
                fixture.value.repository.loadCheckpoint(tx, fixture.checkpoint.id)
            )
        ).toBeDefined();
    });

    test("suspends with matching present tree checkpoints", { tags: "p0" }, () => {
        const fixture = suspendFixture(content("7"));
        suspend(fixture);
        const suspended = fixture.value.repository.transaction((tx) =>
            must(fixture.value.repository.loadTurn(tx, ids.turn))
        );
        expect(suspended.status.kind).toBe("suspended");
        expect(must(suspended.checkpoint).equals(fixture.checkpoint.id)).toBe(true);
    });
});

describe("completion guards", () => {
    function completeFixture() {
        const value = seedRunningTurn();
        const commit = new RunCommit({
            id: new RunCommitId("complete-commit"),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("e")
        });
        return { value, commit };
    }

    function complete(fixture: ReturnType<typeof completeFixture>, commit: RunCommit): void {
        fixture.value.runtime.completeTurn({
            turn: ids.turn,
            expectedTurnRevision: fixture.value.running.revision,
            expectedBranchRevision: new Revision(0),
            token: fixture.value.token,
            outcome: "succeeded",
            commit,
            now: new Date(1500)
        });
    }

    test("rejects each non-result completion commit individually", { tags: "p0" }, () => {
        const cases: readonly ((fixture: ReturnType<typeof completeFixture>) => RunCommit)[] = [
            (fixture) => messageCommit("complete-not-result", { writer: { kind: "turn", token: fixture.value.token } }),
            (fixture) => ({ ...fixture.commit, content: undefined } as RunCommit),
            (fixture) => ({ ...fixture.commit, subjectTurn: undefined } as RunCommit),
            (fixture) =>
                ({ ...fixture.commit, subjectTurn: new TurnId("turn-elsewhere") } as RunCommit),
            (fixture) => ({ ...fixture.commit, writer: { kind: "root" } } as RunCommit),
            (fixture) =>
                ({
                    ...fixture.commit,
                    writer: { kind: "turn", token: leaseToken({ epoch: 2 }) }
                } as RunCommit)
        ];
        for (const build of cases) {
            const fixture = completeFixture();
            expectCode(
                () => complete(fixture, build(fixture)),
                "turn.invalid-state",
                "Turn completion requires a result commit"
            );
        }
    });

    test("completes a running Turn with an exact result commit", { tags: "p0" }, () => {
        const fixture = completeFixture();
        complete(fixture, fixture.commit);
        const completed = fixture.value.repository.transaction((tx) =>
            must(fixture.value.repository.loadTurn(tx, ids.turn))
        );
        expect(completed.status.kind).toBe("succeeded");
        expect(must(completed.result).equals(content("e"))).toBe(true);
        expect(completed.lease.holder).toBeUndefined();
    });
});

describe("append guards", () => {
    test("names the missing Run exactly", { tags: "p2" }, () => {
        const value = harness();
        expectCode(
            () => value.runtime.appendCommit(messageCommit("append-no-run"), new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Run does not exist"
        );
    });

    test("terminal Runs reject ordinary commits with the exact error", { tags: "p0" }, () => {
        const value = harness();
        value.repository.transaction((tx) => value.repository.insertRun(tx, terminalRun()));
        expectCode(
            () => value.runtime.appendCommit(messageCommit("append-terminal"), new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Terminal Runs reject ordinary commits"
        );
    });

    test("rejects duplicate commit identifiers and foreign branches", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        const first = messageCommit("append-first");
        value.runtime.appendCommit(first, new Revision(0), new Date(1500));
        expectCode(
            () => value.runtime.appendCommit(first, new Revision(1), new Date(1500)),
            "run.invalid-state",
            "Run commit target is invalid"
        );

        value.repository.transaction((tx) =>
            value.repository.insertBranch(
                tx,
                new RunBranch(
                    new RunBranchId("branch-foreign"),
                    new RunId("run-elsewhere"),
                    "foreign",
                    ids.root,
                    new Revision(0)
                )
            )
        );
        expectCode(
            () =>
                value.runtime.appendCommit(
                    messageCommit("append-foreign", { branch: new RunBranchId("branch-foreign") }),
                    new Revision(0),
                    new Date(1500)
                ),
            "run.invalid-state",
            "Run commit target is invalid"
        );
    });

    test("rejects stale and absent parents with a revision conflict", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        value.runtime.appendCommit(messageCommit("append-head"), new Revision(0), new Date(1500));
        expectCode(
            () =>
                value.runtime.appendCommit(
                    messageCommit("append-stale"),
                    new Revision(1),
                    new Date(1500)
                ),
            "protocol.revision-conflict",
            "Run commit parent is not the current branch head"
        );
        const parentless = new RunCommit({
            id: new RunCommitId("append-second-root"),
            run: ids.run,
            branch: ids.branch,
            kind: "root",
            parents: [],
            pins: pins(),
            writer: { kind: "root" }
        });
        expectCode(
            () => value.runtime.appendCommit(parentless, new Revision(1), new Date(1500)),
            "protocol.revision-conflict",
            "Run commit parent is not the current branch head"
        );
    });

    test("rejects a parent commit that belongs to another Run", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        const foreignRoot = new RunCommit({
            id: new RunCommitId("commit-elsewhere-root"),
            run: new RunId("run-elsewhere"),
            branch: new RunBranchId("branch-elsewhere"),
            kind: "root",
            parents: [],
            pins: pins(),
            writer: { kind: "root" }
        });
        value.repository.transaction((tx) => {
            value.repository.insertCommit(tx, foreignRoot);
            value.repository.insertBranch(
                tx,
                new RunBranch(
                    new RunBranchId("branch-foreign-head"),
                    ids.run,
                    "foreign-head",
                    foreignRoot.id,
                    new Revision(0)
                )
            );
        });
        expectCode(
            () =>
                value.runtime.appendCommit(
                    messageCommit("append-foreign-parent", {
                        branch: new RunBranchId("branch-foreign-head"),
                        parents: [foreignRoot.id]
                    }),
                    new Revision(0),
                    new Date(1500)
                ),
            "run.invalid-state",
            "Run commit parent belongs to another Run"
        );
    });

    test("non-migration commits must inherit the parent pins", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        expectCode(
            () =>
                value.runtime.appendCommit(
                    messageCommit("append-repinned", { pins: differentPins() }),
                    new Revision(0),
                    new Date(1500)
                ),
            "run.invalid-state",
            "Non-migration Run commit must inherit parent pins"
        );
    });

    test("rejects Turn writers outside the commit lineage", { tags: "p0" }, () => {
        const foreign = harness();
        foreign.runtime.createRun(genesis());
        const foreignTurnId = new TurnId("turn-foreign");
        const placement = new TurnPlacementSnapshot(foreignTurnId, pins(), []);
        foreign.repository.transaction((tx) =>
            foreign.repository.insertTurn(
                tx,
                new Turn({
                    id: foreignTurnId,
                    run: new RunId("run-elsewhere"),
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: placement.digest,
                    input: content("a"),
                    status: TurnStatus.running,
                    lease: TurnLease.restore(foreignTurnId, ids.holder, 1, new Date(5000)),
                    revision: new Revision(0)
                })
            )
        );
        expectCode(
            () =>
                foreign.runtime.appendCommit(
                    messageCommit("append-foreign-writer", {
                        writer: { kind: "turn", token: leaseToken({ turn: foreignTurnId }) },
                        subjectTurn: foreignTurnId
                    }),
                    new Revision(0),
                    new Date(1500)
                ),
            "run.invalid-state",
            "Turn writer does not belong to the commit lineage"
        );

        const branched = seedRunningTurn();
        branched.runtime.createBranch(
            ids.run,
            new RunBranch(new RunBranchId("branch-second"), ids.run, "second", ids.root, new Revision(0)),
            new Revision(2)
        );
        expectCode(
            () =>
                branched.runtime.appendCommit(
                    messageCommit("append-crossed-writer", {
                        branch: new RunBranchId("branch-second")
                    }),
                    new Revision(0),
                    new Date(1500)
                ),
            "run.invalid-state",
            "Turn writer does not belong to the commit lineage"
        );
    });

    function undoCommit(id: string, selects: RunCommitId): RunCommit {
        return new RunCommit({
            id: new RunCommitId(id),
            run: ids.run,
            branch: ids.branch,
            kind: "undo",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            selects,
            receipt: refs.receipt
        });
    }

    test("undo selection must be an ancestor of the head", { tags: "p0" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const undo = undoCommit("undo-unrelated", new RunCommitId("commit-unrelated"));
        withControl(value, undo);
        expectCode(
            () => value.runtime.appendCommit(undo, new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Undo selection must be an ancestor of the current head"
        );
    });

    test("undo requires the in-flight Turn to be fenced first", { tags: "p0" }, () => {
        const value = seedRunningTurn();
        const undo = undoCommit("undo-inflight", ids.root);
        withControl(value, undo);
        expectCode(
            () => value.runtime.appendCommit(undo, new Revision(0), new Date(1500)),
            "run.invalid-state",
            "Undo requires the in-flight Turn to be fenced first"
        );
    });

    test("undo ignores running Turns of other Runs and branches", { tags: "p0" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        const foreignTurnId = new TurnId("turn-foreign-running");
        const placement = new TurnPlacementSnapshot(foreignTurnId, pins(), []);
        value.repository.transaction((tx) =>
            value.repository.insertTurn(
                tx,
                new Turn({
                    id: foreignTurnId,
                    run: new RunId("run-elsewhere"),
                    branch: ids.branch,
                    startHead: ids.root,
                    effectiveInput: ids.root,
                    pins: pins(),
                    placement: placement.digest,
                    input: content("a"),
                    status: TurnStatus.running,
                    lease: TurnLease.restore(foreignTurnId, ids.holder, 1, new Date(5000)),
                    revision: new Revision(0)
                })
            )
        );
        const undo = undoCommit("undo-allowed", ids.root);
        withControl(value, undo);
        value.runtime.appendCommit(undo, new Revision(0), new Date(1000));
        expect(value.runtime.effectiveCommit(ids.run, ids.branch).equals(ids.root)).toBe(true);
    });
});

describe("merge validation", () => {
    function mergeFixture(sourceOver: Partial<RunCommitInit> = {}) {
        const value = harness();
        value.runtime.createRun(genesis());
        value.runtime.createBranch(
            ids.run,
            new RunBranch(new RunBranchId("branch-source"), ids.run, "source", ids.root, new Revision(0)),
            new Revision(0)
        );
        const sourceHead = new RunCommit({
            id: new RunCommitId("source-head"),
            run: ids.run,
            branch: new RunBranchId("branch-source"),
            kind: "invocation",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
            },
            invocation: refs.invocation,
            receipt: refs.receipt,
            ...sourceOver
        });
        withReceipt(value);
        value.runtime.appendCommit(sourceHead, new Revision(0), new Date(1000));
        return { value, sourceHead };
    }

    function mergeCommit(id: string, source: RunCommitId, over: Partial<RunCommitInit> = {}): RunCommit {
        return new RunCommit({
            id: new RunCommitId(id),
            run: ids.run,
            branch: ids.branch,
            kind: "merge",
            parents: [ids.root, source],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
            },
            content: content("4"),
            resolution: { kind: "concat" },
            receipt: refs.receipt,
            ...over
        });
    }

    test("merge parents must be the distinct ordered current heads", { tags: "p0" }, () => {
        const { value, sourceHead } = mergeFixture();
        expectCode(
            () =>
                value.runtime.appendCommit(
                    mergeCommit("merge-stale-first", ids.root, {
                        parents: [sourceHead.id, ids.root]
                    }),
                    new Revision(0),
                    new Date(1000)
                ),
            "protocol.revision-conflict",
            "Merge parents are not distinct ordered current heads"
        );
        expectCode(
            () =>
                value.runtime.appendCommit(
                    {
                        ...mergeCommit("merge-single", sourceHead.id),
                        parents: [ids.root]
                    } as never,
                    new Revision(0),
                    new Date(1000)
                ),
            "protocol.revision-conflict",
            "Merge parents are not distinct ordered current heads"
        );
        expectCode(
            () =>
                value.runtime.appendCommit(
                    {
                        ...mergeCommit("merge-empty", sourceHead.id),
                        parents: []
                    } as never,
                    new Revision(0),
                    new Date(1000)
                ),
            "protocol.revision-conflict",
            "Merge parents are not distinct ordered current heads"
        );
        expectCode(
            () =>
                value.runtime.appendCommit(
                    {
                        ...mergeCommit("merge-equal", sourceHead.id),
                        parents: [ids.root, ids.root]
                    } as never,
                    new Revision(0),
                    new Date(1000)
                ),
            "protocol.revision-conflict",
            "Merge parents are not distinct ordered current heads"
        );
    });

    test("merge requires an exact source branch and stored head commits", { tags: "p0" }, () => {
        const orphan = mergeFixture();
        const orphanCommit = new RunCommit({
            id: new RunCommitId("commit-orphan"),
            run: ids.run,
            branch: ids.branch,
            kind: "invocation",
            parents: [ids.root],
            pins: pins(),
            writer: {
                kind: "system",
                cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
            },
            invocation: refs.invocation,
            receipt: refs.receipt
        });
        orphan.value.repository.transaction((tx) => {
            orphan.value.repository.insertCommit(tx, orphanCommit);
            orphan.value.repository.insertBranch(
                tx,
                new RunBranch(
                    new RunBranchId("branch-elsewhere"),
                    new RunId("run-elsewhere"),
                    "elsewhere",
                    orphanCommit.id,
                    new Revision(0)
                )
            );
        });
        const orphanMerge = mergeCommit("merge-orphan", orphanCommit.id);
        withControl(orphan.value, orphanMerge);
        expectCode(
            () => orphan.value.runtime.appendCommit(orphanMerge, new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Merge requires equal-pinned current heads from distinct branches"
        );

        const ghost = mergeFixture();
        ghost.value.repository.transaction((tx) =>
            ghost.value.repository.insertBranch(
                tx,
                new RunBranch(
                    new RunBranchId("branch-ghost"),
                    ids.run,
                    "ghost",
                    new RunCommitId("commit-ghost"),
                    new Revision(0)
                )
            )
        );
        expectCode(
            () =>
                ghost.value.runtime.appendCommit(
                    mergeCommit("merge-ghost-target", ghost.sourceHead.id, {
                        branch: new RunBranchId("branch-ghost"),
                        parents: [new RunCommitId("commit-ghost"), ghost.sourceHead.id]
                    }),
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Merge requires equal-pinned current heads from distinct branches"
        );

        const phantom = mergeFixture();
        phantom.value.repository.transaction((tx) =>
            phantom.value.repository.insertBranch(
                tx,
                new RunBranch(
                    new RunBranchId("branch-phantom"),
                    ids.run,
                    "phantom",
                    new RunCommitId("commit-phantom"),
                    new Revision(0)
                )
            )
        );
        expectCode(
            () =>
                phantom.value.runtime.appendCommit(
                    mergeCommit("merge-phantom-source", new RunCommitId("commit-phantom")),
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Merge requires equal-pinned current heads from distinct branches"
        );
    });

    test("pick resolution must copy one exact parent content", { tags: "p0" }, () => {
        const noContent = mergeFixture();
        expectCode(
            () =>
                noContent.value.runtime.appendCommit(
                    mergeCommit("merge-pick-empty", noContent.sourceHead.id, {
                        resolution: { kind: "pick", parent: noContent.sourceHead.id }
                    }),
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Pick resolution must copy one exact parent content"
        );

        const neither = mergeFixture();
        const base = mergeCommit("merge-pick-neither", neither.sourceHead.id, {
            resolution: { kind: "pick", parent: ids.root },
            content: content("4")
        });
        expectCode(
            () =>
                neither.value.runtime.appendCommit(
                    {
                        ...base,
                        resolution: { kind: "pick", parent: new RunCommitId("commit-neither") }
                    } as RunCommit,
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Pick resolution must copy one exact parent content"
        );

        const empty = mergeFixture();
        expectCode(
            () =>
                empty.value.runtime.appendCommit(
                    {
                        ...mergeCommit("merge-pick-no-content", empty.sourceHead.id, {
                            resolution: { kind: "pick", parent: ids.root },
                            content: content("4")
                        }),
                        content: undefined
                    } as RunCommit,
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Pick resolution must copy one exact parent content"
        );

        const copied = mergeFixture();
        copied.value.merge.acceptsConcat = false;
        const pick = mergeCommit("merge-pick-exact", copied.sourceHead.id, {
            resolution: { kind: "pick", parent: ids.root },
            content: content("4")
        });
        withControl(copied.value, pick);
        copied.value.runtime.appendCommit(pick, new Revision(0), new Date(1000));
        expect(copied.value.runtime.effectiveCommit(ids.run, ids.branch).equals(pick.id)).toBe(true);
    });

    test("concat resolution requires canonical parent-order verification", { tags: "p0" }, () => {
        const { value, sourceHead } = mergeFixture();
        value.merge.acceptsConcat = false;
        expectCode(
            () =>
                value.runtime.appendCommit(
                    mergeCommit("merge-concat-unverified", sourceHead.id),
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Concat resolution does not match canonical parent-order content"
        );
    });

    test("tree resolution sides must name the ordered merge parents", { tags: "p0" }, () => {
        const ours = mergeFixture();
        const oursBase = mergeCommit("merge-ours-side", ours.sourceHead.id, {
            treeCheckpoint: content("e"),
            treeResolution: {
                policy: "ours",
                side: ids.root,
                base: content("e"),
                environment: ids.environment.value
            }
        });
        expectCode(
            () =>
                ours.value.runtime.appendCommit(
                    {
                        ...oursBase,
                        treeResolution: {
                            policy: "ours",
                            side: ours.sourceHead.id,
                            base: content("e"),
                            environment: ids.environment.value
                        }
                    } as RunCommit,
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Tree resolution sides must name the ordered merge parents"
        );

        const theirs = mergeFixture({ treeCheckpoint: content("f") });
        const theirsBase = mergeCommit("merge-theirs-side", theirs.sourceHead.id, {
            treeCheckpoint: content("f"),
            treeResolution: {
                policy: "theirs",
                side: theirs.sourceHead.id,
                base: content("e"),
                environment: ids.environment.value
            }
        });
        expectCode(
            () =>
                theirs.value.runtime.appendCommit(
                    {
                        ...theirsBase,
                        treeResolution: {
                            policy: "theirs",
                            side: ids.root,
                            base: content("e"),
                            environment: ids.environment.value
                        }
                    } as RunCommit,
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Tree resolution sides must name the ordered merge parents"
        );

        const perPath = mergeFixture();
        const perPathBase = mergeCommit("merge-per-path-side", perPath.sourceHead.id, {
            treeCheckpoint: content("9"),
            treeResolution: {
                policy: "perPath",
                base: content("e"),
                environment: ids.environment.value,
                resolutions: [
                    { path: "left", side: ids.root },
                    { path: "right", side: perPath.sourceHead.id }
                ]
            }
        });
        expectCode(
            () =>
                perPath.value.runtime.appendCommit(
                    {
                        ...perPathBase,
                        treeResolution: {
                            policy: "perPath",
                            base: content("e"),
                            environment: ids.environment.value,
                            resolutions: [
                                { path: "left", side: ids.root },
                                { path: "right", side: new RunCommitId("commit-intruder") }
                            ]
                        }
                    } as never,
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Tree resolution sides must name the ordered merge parents"
        );
    });

    test("tree side resolution must copy the selected parent tree", { tags: "p0" }, () => {
        const ours = mergeFixture();
        const oursMismatch = mergeCommit("merge-ours-checkpoint", ours.sourceHead.id, {
            treeCheckpoint: content("9"),
            treeResolution: {
                policy: "ours",
                side: ids.root,
                base: content("e"),
                environment: ids.environment.value
            }
        });
        withControl(ours.value, oursMismatch);
        expectCode(
            () => ours.value.runtime.appendCommit(oursMismatch, new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Tree side resolution must copy the selected parent tree"
        );

        const theirs = mergeFixture({ treeCheckpoint: content("f") });
        const theirsMismatch = mergeCommit("merge-theirs-checkpoint", theirs.sourceHead.id, {
            treeCheckpoint: content("9"),
            treeResolution: {
                policy: "theirs",
                side: theirs.sourceHead.id,
                base: content("e"),
                environment: ids.environment.value
            }
        });
        withControl(theirs.value, theirsMismatch);
        expectCode(
            () => theirs.value.runtime.appendCommit(theirsMismatch, new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Tree side resolution must copy the selected parent tree"
        );

        const bare = mergeFixture();
        const bareSource = mergeCommit("merge-bare-source", bare.sourceHead.id, {
            treeCheckpoint: content("f"),
            treeResolution: {
                policy: "theirs",
                side: bare.sourceHead.id,
                base: content("e"),
                environment: ids.environment.value
            }
        });
        withControl(bare.value, bareSource);
        expectCode(
            () => bare.value.runtime.appendCommit(bareSource, new Revision(0), new Date(1000)),
            "run.invalid-state",
            "Tree side resolution must copy the selected parent tree"
        );

        const missing = mergeFixture();
        const missingCheckpoint = mergeCommit("merge-missing-checkpoint", missing.sourceHead.id, {
            treeCheckpoint: content("e"),
            treeResolution: {
                policy: "ours",
                side: ids.root,
                base: content("e"),
                environment: ids.environment.value
            }
        });
        withControl(missing.value, missingCheckpoint);
        expectCode(
            () =>
                missing.value.runtime.appendCommit(
                    { ...missingCheckpoint, treeCheckpoint: undefined } as RunCommit,
                    new Revision(0),
                    new Date(1000)
                ),
            "run.invalid-state",
            "Tree side resolution must copy the selected parent tree"
        );
    });

    test("accepts exact ours, theirs, and per-path tree resolutions", { tags: "p0" }, () => {
        const ours = mergeFixture();
        const oursMerge = mergeCommit("merge-ours-exact", ours.sourceHead.id, {
            treeCheckpoint: content("e"),
            treeResolution: {
                policy: "ours",
                side: ids.root,
                base: content("e"),
                environment: ids.environment.value
            }
        });
        withControl(ours.value, oursMerge);
        ours.value.runtime.appendCommit(oursMerge, new Revision(0), new Date(1000));
        expect(ours.value.runtime.effectiveCommit(ids.run, ids.branch).equals(oursMerge.id)).toBe(
            true
        );

        const theirs = mergeFixture({ treeCheckpoint: content("f") });
        const theirsMerge = mergeCommit("merge-theirs-exact", theirs.sourceHead.id, {
            treeCheckpoint: content("f"),
            treeResolution: {
                policy: "theirs",
                side: theirs.sourceHead.id,
                base: content("e"),
                environment: ids.environment.value
            }
        });
        withControl(theirs.value, theirsMerge);
        theirs.value.runtime.appendCommit(theirsMerge, new Revision(0), new Date(1000));
        expect(
            theirs.value.runtime.effectiveCommit(ids.run, ids.branch).equals(theirsMerge.id)
        ).toBe(true);

        const perPath = mergeFixture();
        const perPathMerge = mergeCommit("merge-per-path-exact", perPath.sourceHead.id, {
            treeCheckpoint: content("9"),
            treeResolution: {
                policy: "perPath",
                base: content("e"),
                environment: ids.environment.value,
                resolutions: [
                    { path: "left", side: ids.root },
                    { path: "right", side: perPath.sourceHead.id }
                ]
            }
        });
        withControl(perPath.value, perPathMerge);
        perPath.value.runtime.appendCommit(perPathMerge, new Revision(0), new Date(1000));
        expect(
            perPath.value.runtime.effectiveCommit(ids.run, ids.branch).equals(perPathMerge.id)
        ).toBe(true);
    });
});

describe("runtime lookup errors", () => {
    test("settled names the missing Run exactly", { tags: "p2" }, () => {
        const value = harness();
        expectCode(() => value.runtime.settled(ids.run), "run.invalid-state", "Run does not exist");
    });

    test("effective commits reject a branch of another Run", { tags: "p2" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        expectCode(
            () => value.runtime.effectiveCommit(new RunId("run-elsewhere"), ids.branch),
            "run.invalid-state",
            "Run branch belongs to another Run"
        );
    });

    test("turn updates name the missing Turn exactly", { tags: "p2" }, () => {
        const value = harness();
        value.runtime.createRun(genesis());
        expectCode(
            () =>
                value.runtime.claimTurn(
                    ids.turn,
                    new Revision(0),
                    ids.holder,
                    new Date(1000),
                    new Date(5000)
                ),
            "run.invalid-state",
            "Turn does not exist"
        );
    });
});

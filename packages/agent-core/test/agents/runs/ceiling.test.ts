import { describe, expect, it } from "vitest";
import { Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import {
    ResourceCeiling,
    SpawnAttenuation,
    SpawnAttenuationCodec
} from "../../../src/agents/runs/ceiling";
import { RunCommit } from "../../../src/agents/runs/commit";
import { RunBranchId, RunId, SpawnReservationId } from "../../../src/agents/runs/id";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import { SpawnReservation } from "../../../src/agents/runs/spawn";
import { Turn } from "../../../src/agents/runs/turn";
import {
    attenuationDigest,
    configuration,
    content,
    harness,
    ids,
    pins,
    refs,
    seedRunningTurn
} from "./fixture";

type Harness = ReturnType<typeof harness>;
type Token = { readonly turn: TurnId; readonly holder: typeof ids.holder; readonly epoch: number };

const CLAIMED_AT = new Date(1_000);
const LEASE_EXPIRY = new Date(500_000);

function childRecords(name: string, parent: RunId) {
    const snapshot = configuration();
    const run = new RunId(`run-${name}`);
    const branch = new RunBranchId(`branch-${name}`);
    const root = new RunCommit({
        id: new RunCommitId(`commit-${name}`),
        run,
        branch,
        kind: "root",
        parents: [],
        pins: snapshot.pins,
        writer: { kind: "root" },
        content: content("4"),
        treeCheckpoint: content("e")
    });
    return {
        run,
        branch,
        root,
        genesis: {
            run: new Run({
                id: run,
                agent: ids.agent,
                configuration: snapshot.id,
                root: root.id,
                initialBranch: branch,
                parent,
                revision: new Revision(0)
            }),
            configuration: snapshot,
            branch: new RunBranch(branch, run, "main", root.id, new Revision(0)),
            root
        }
    };
}

function runningTurn(
    value: Harness,
    name: string,
    run: RunId,
    branch: RunBranchId,
    head: RunCommitId
): Token {
    const turn = new TurnId(`turn-${name}`);
    const placement = new TurnPlacementSnapshot(turn, pins(), []);
    value.runtime.createTurn(
        {
            turn: new Turn({
                id: turn,
                run,
                branch,
                startHead: head,
                effectiveInput: head,
                pins: pins(),
                placement: placement.digest,
                input: content("a"),
                revision: new Revision(0)
            }),
            placement
        },
        new Revision(0)
    );
    value.runtime.claimTurn(turn, new Revision(0), ids.holder, CLAIMED_AT, LEASE_EXPIRY);
    return { turn, holder: ids.holder, epoch: 1 };
}

function reservationFor(
    name: string,
    parent: RunId,
    token: Token,
    child: ReturnType<typeof childRecords>,
    attenuation: SpawnAttenuation,
    now: Date
): SpawnReservation {
    return new SpawnReservation(
        new SpawnReservationId(`spawn-${name}`),
        parent,
        token.turn,
        child.run,
        token,
        child.genesis.configuration.id,
        child.root.content!,
        refs.invocation,
        refs.receipt,
        attenuationDigest(attenuation),
        now
    );
}

// Spawns `name` under `parent`, declaring `attenuation`, and leaves the child with a
// running Turn of its own so it can spawn further.
function spawnChild(
    value: Harness,
    name: string,
    parent: RunId,
    token: Token,
    attenuation: SpawnAttenuation,
    now = new Date(1_500)
) {
    const child = childRecords(name, parent);
    const reservation = reservationFor(name, parent, token, child, attenuation, now);
    value.spawn.attenuations.set(reservation.id.value, attenuation);
    value.runtime.spawnRun(reservation, child.genesis, now);
    return {
        ...child,
        reservation,
        token: runningTurn(value, name, child.run, child.branch, child.root.id)
    };
}

function expectDenied(operation: () => unknown, message: RegExp): void {
    try {
        operation();
        throw new Error("Expected the spawn to be denied");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code).toBe("authority.denied");
        expect((error as AgentCoreError).message).toMatch(message);
    }
}

function ceiling(limits: ConstructorParameters<typeof ResourceCeiling>[0]): SpawnAttenuation {
    return new SpawnAttenuation({ ceiling: new ResourceCeiling(limits) });
}

describe("Run resource ceilings", () => {
    it(
        "[C13-RUN-RESOURCE-CEILING] admits a spawned ceiling only at or below the parent's remaining allowance",
        { tags: "p0" },
        () => {
            const root = seedRunningTurn();
            const parent = spawnChild(
                root,
                "parent",
                ids.run,
                root.token,
                ceiling({ tokens: 100 })
            );
            root.runtime.recordModelTokens(parent.run, 40);

            expect(
                root.runtime.remainingResources(parent.run, new Date(1_600))?.limit("tokens")
            ).toBe(60);

            expectDenied(
                () => spawnChild(root, "wider", parent.run, parent.token, ceiling({ tokens: 61 })),
                /exceeds the parent Run's remaining allowance/
            );

            const equal = spawnChild(
                root,
                "equal",
                parent.run,
                parent.token,
                ceiling({ tokens: 60 })
            );
            expect(
                root.runtime.remainingResources(equal.run, new Date(1_600))?.limit("tokens")
            ).toBe(60);

            const narrower = spawnChild(
                root,
                "narrower",
                parent.run,
                parent.token,
                ceiling({ tokens: 10 })
            );
            expect(
                root.runtime.remainingResources(narrower.run, new Date(1_600))?.limit("tokens")
            ).toBe(10);
        }
    );

    it(
        "[C13-RUN-RESOURCE-CEILING] inherits an undeclared dimension from the parent's remainder and bounds nothing without a declaration",
        { tags: "p0" },
        () => {
            const root = seedRunningTurn();
            // A Run under no declaration at all is unbounded.
            expect(root.runtime.remainingResources(ids.run, new Date(1_600))).toBeUndefined();

            const parent = spawnChild(
                root,
                "declaring",
                ids.run,
                root.token,
                ceiling({ tokens: 100, depth: 2 })
            );
            root.runtime.recordModelTokens(parent.run, 25);

            // The child declares neither dimension, so both come from the parent's remainder,
            // with depth spent by the one spawn edge it just crossed.
            const child = spawnChild(
                root,
                "silent",
                parent.run,
                parent.token,
                new SpawnAttenuation()
            );
            const remainder = root.runtime.remainingResources(child.run, new Date(1_600));
            expect(remainder?.limit("tokens")).toBe(75);
            expect(remainder?.limit("depth")).toBe(1);

            // Its own spawn crosses the last admissible edge; a further one has nowhere to go.
            const grandchild = spawnChild(
                root,
                "silent-child",
                child.run,
                child.token,
                new SpawnAttenuation()
            );
            expect(
                root.runtime.remainingResources(grandchild.run, new Date(1_600))?.limit("depth")
            ).toBe(0);
            expectDenied(
                () =>
                    spawnChild(
                        root,
                        "too-deep",
                        grandchild.run,
                        grandchild.token,
                        new SpawnAttenuation()
                    ),
                /Spawn exhausts the parent Run's depth allowance/
            );
        }
    );

    it(
        "[C13-RUN-RESOURCE-CEILING] spends wall clock from the spawn that started the Run",
        { tags: "p1" },
        () => {
            const root = seedRunningTurn();
            const child = spawnChild(
                root,
                "timed",
                ids.run,
                root.token,
                ceiling({ wallClockMs: 1_000 }),
                new Date(2_000)
            );

            expect(
                root.runtime.remainingResources(child.run, new Date(2_400))?.limit("wallClockMs")
            ).toBe(600);
            expect(root.runtime.exhaustedResource(child.run, new Date(2_400))).toBeUndefined();
            expect(root.runtime.exhaustedResource(child.run, new Date(3_000))).toBe("wallClockMs");
        }
    );

    it(
        "[C13-RUN-RESOURCE-CEILING] cancels an exhausted Run through the ordinary terminal rows and refuses to name a dimension with allowance left",
        { tags: "p0" },
        () => {
            const root = seedRunningTurn();
            const child = spawnChild(root, "spent", ids.run, root.token, ceiling({ tokens: 50 }));
            root.runtime.recordModelTokens(child.run, 50);
            expect(root.runtime.exhaustedResource(child.run, new Date(1_600))).toBe("tokens");

            const terminal = new RunCommit({
                id: new RunCommitId("commit-spent-result"),
                run: child.run,
                branch: child.branch,
                kind: "result",
                parents: [child.root.id],
                pins: pins(),
                writer: { kind: "turn", token: child.token },
                subjectTurn: child.token.turn,
                content: content("7")
            });
            const request = {
                run: child.run,
                turn: child.token.turn,
                expectedRunRevision: root.repository.transaction(
                    (tx) => root.repository.loadRun(tx, child.run)!.revision
                ),
                expectedTurnRevision: new Revision(1),
                expectedBranchRevision: new Revision(0),
                token: child.token,
                outcome: "cancelled" as const,
                commit: terminal,
                siblingCancellations: new Map(),
                now: new Date(1_600)
            };

            expect(() =>
                root.runtime.terminalizeRun({ ...request, exhausted: "wallClockMs" })
            ).toThrow(/names a dimension with allowance left/);

            const snapshot = root.runtime.terminalizeRun({ ...request, exhausted: "tokens" });
            expect(snapshot.outcome).toBe("cancelled");
            expect(snapshot.exhausted).toBe("tokens");

            const stored = root.repository.transaction((tx) =>
                root.repository.loadRun(tx, child.run)!
            );
            expect(stored.lifecycle.kind).toBe("terminal");
            expect(stored.lifecycle.exhausted).toBe("tokens");
            expect(stored.terminal?.exhausted).toBe("tokens");
        }
    );

    it(
        "[C13-RUN-RESOURCE-CEILING] binds the ceiling to the attenuation content the reservation digests",
        { tags: "p0" },
        () => {
            const root = seedRunningTurn();
            const declared = ceiling({ tokens: 10 });
            const child = childRecords("substituted", ids.run);
            const reservation = reservationFor(
                "substituted",
                ids.run,
                root.token,
                child,
                declared,
                new Date(1_500)
            );
            // The port answers with a wider ceiling than the digest the reservation commits.
            root.spawn.attenuations.set(reservation.id.value, ceiling({ tokens: 10_000 }));

            expectDenied(
                () => root.runtime.spawnRun(reservation, child.genesis, new Date(1_500)),
                /does not match the digest the reservation commits/
            );
        }
    );

    it("[C13-RUN-RESOURCE-CEILING] [run.spawn-attenuation] round-trips a declared ceiling and rejects an undeclared dimension", () => {
        const attenuation = ceiling({ depth: 3, tokens: 7, wallClockMs: 9 });
        expect(SpawnAttenuationCodec.decode(SpawnAttenuationCodec.encode(attenuation))).toEqual(
            attenuation
        );
        expect(
            SpawnAttenuationCodec.decode(SpawnAttenuationCodec.encode(new SpawnAttenuation()))
        ).toEqual(new SpawnAttenuation());
        expect(() => new ResourceCeiling({})).toThrow(/at least one dimension/);
        expect(() => new ResourceCeiling({ tokens: -1 })).toThrow(/non-negative safe integer/);
        expect(() => SpawnAttenuation.fromData({ ceiling: { cpu: 1 } } as never)).toThrow(
            /missing or unknown fields/
        );
    });
});

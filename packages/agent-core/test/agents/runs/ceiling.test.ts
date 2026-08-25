import { describe, expect, it } from "vitest";
import { Revision, encodeCanonicalJson } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import {
    RESOURCE_DIMENSIONS,
    ResourceCeiling,
    SpawnAttenuation,
    SpawnAttenuationCodec,
    exhaustedResource,
    narrowResources,
    widensResourceCeiling
} from "../../../src/agents/runs/ceiling";
import { Currency, RealizedCost } from "../../../src/agents/runs/cost";
import { SettlementObligation, TerminalSnapshot } from "../../../src/agents/runs/settlement";
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
    genesis,
    harness,
    ids,
    pins,
    refs,
    seedRunningTurn,
    thrownBy
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

function expectDenied(operation: () => void, message: RegExp): void {
    const denial = thrownBy(AgentCoreError, operation, "spawn");
    expect(denial.code).toBe("authority.denied");
    expect(denial.message).toMatch(message);
}

function ceiling(limits: ConstructorParameters<typeof ResourceCeiling>[0]): SpawnAttenuation {
    return new SpawnAttenuation({ ceiling: new ResourceCeiling(limits) });
}

describe("Run resource ceilings", () => {
    it(
        "[C13-RUN-CEILING-REMAINDER] derives depth and wall time from lineage while model accounting alone advances durable token totals",
        { tags: "p0" },
        () => {
            const root = seedRunningTurn();
            const parent = spawnChild(
                root,
                "remainder-parent",
                ids.run,
                root.token,
                ceiling({ depth: 2, tokens: 100, wallClockMs: 1_000 }),
                new Date(2_000)
            );

            expect(root.runtime.remainingResources(parent.run, new Date(2_400))?.toData()).toEqual({
                depth: 2,
                tokens: 100,
                wallClockMs: 600
            });
            root.runtime.recordModelUsage(parent.run, 25);
            expect(root.runtime.remainingResources(parent.run, new Date(2_400))?.toData()).toEqual({
                depth: 2,
                tokens: 75,
                wallClockMs: 600
            });

            const child = spawnChild(
                root,
                "remainder-child",
                parent.run,
                parent.token,
                new SpawnAttenuation(),
                new Date(2_500)
            );
            expect(root.runtime.remainingResources(child.run, new Date(2_600))?.toData()).toEqual({
                depth: 1,
                tokens: 75,
                wallClockMs: 300
            });

            root.runtime.recordModelUsage(child.run, 10);
            expect(root.runtime.remainingResources(child.run, new Date(2_600))?.toData()).toEqual({
                depth: 1,
                tokens: 65,
                wallClockMs: 300
            });
            const consumed = root.repository.transaction((transaction) => ({
                parent: root.repository.loadRun(transaction, parent.run)?.tokensConsumed,
                child: root.repository.loadRun(transaction, child.run)?.tokensConsumed
            }));
            expect(consumed).toEqual({ parent: 25, child: 10 });
        }
    );

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
            root.runtime.recordModelUsage(parent.run, 40);

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
            root.runtime.recordModelUsage(parent.run, 25);

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
        "[C13-RUN-CEILING-EXHAUSTION] cancels an exhausted Run through the ordinary terminal rows and refuses to name a dimension with allowance left",
        { tags: "p0" },
        () => {
            const root = seedRunningTurn();
            const child = spawnChild(root, "spent", ids.run, root.token, ceiling({ tokens: 50 }));
            root.runtime.recordModelUsage(child.run, 50);
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
            // Exhaustion cancels the Run through the ordinary terminal rows, so the request
            // names the cancellation §7.4 builds `aborted` from for anything it published.
            const cancellation = new AbortController();
            cancellation.abort();
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
                cancellation: cancellation.signal,
                siblingCancellations: new Map(),
                now: new Date(1_600)
            };

            expect(() =>
                root.runtime.terminalizeRun({ ...request, exhausted: "wallClockMs" })
            ).toThrow(/names a dimension with allowance left/);

            const { snapshot } = root.runtime.terminalizeRun({ ...request, exhausted: "tokens" });
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
        "[C13-RUN-RESOURCE-CEILING] refuses to name an exhausted dimension for a Run under no ceiling",
        { tags: "p0" },
        () => {
            // A Run nobody spawned has no declared ceiling anywhere, so it has no remainder
            // to read a dimension out of. Claiming exhaustion has to be refused as a denial
            // an operator can act on, rather than faulting on the absent remainder.
            const root = seedRunningTurn();
            expect(root.runtime.remainingResources(ids.run, new Date(1_600))).toBeUndefined();

            const terminal = new RunCommit({
                id: new RunCommitId("commit-unbounded-result"),
                run: ids.run,
                branch: ids.branch,
                kind: "result",
                parents: [ids.root],
                pins: pins(),
                writer: { kind: "turn", token: root.token },
                subjectTurn: root.token.turn,
                content: content("7")
            });

            const cancellation = new AbortController();
            cancellation.abort();
            const refusal = thrownBy(
                AgentCoreError,
                () => {
                    root.runtime.terminalizeRun({
                        run: ids.run,
                        turn: root.token.turn,
                        expectedRunRevision: root.repository.transaction(
                            (tx) => root.repository.loadRun(tx, ids.run)!.revision
                        ),
                        expectedTurnRevision: new Revision(1),
                        expectedBranchRevision: new Revision(0),
                        token: root.token,
                        outcome: "cancelled",
                        commit: terminal,
                        exhausted: "tokens",
                        cancellation: cancellation.signal,
                        siblingCancellations: new Map(),
                        now: new Date(1_600)
                    });
                },
                "terminalization"
            );
            expect(refusal.code).toBe("run.invalid-state");
            expect(refusal.message).toBe(
                "Terminal exhaustion names a dimension with allowance left"
            );
            expect(
                root.repository.transaction((tx) => root.repository.loadRun(tx, ids.run)!).lifecycle
                    .kind
            ).toBe("active");
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
        expect(() => SpawnAttenuation.fromData({ ceiling: { cpu: 1 } })).toThrow(
            /missing or unknown fields/
        );
    });

    it("[C13-RUN-RESOURCE-CEILING] compares ceilings across every declared dimension", () => {
        const base = new ResourceCeiling({ tokens: 5, depth: 2 });
        expect(base.equals(new ResourceCeiling({ tokens: 5, depth: 2 }))).toBe(true);
        // Agreeing on one dimension while disagreeing on another is not equality: a
        // comparison satisfied by any single matching dimension would call these equal.
        expect(base.equals(new ResourceCeiling({ tokens: 5, depth: 3 }))).toBe(false);
        expect(base.equals(new ResourceCeiling({ tokens: 4, depth: 2 }))).toBe(false);
        // A dimension declared on one side only differs from its absence, which is
        // unbounded rather than equal.
        expect(base.equals(new ResourceCeiling({ tokens: 5 }))).toBe(false);
    });

    it("[C13-RUN-RESOURCE-CEILING] refuses a child that widens any one dimension", () => {
        const remainder = new ResourceCeiling({ tokens: 100, depth: 5 });
        // Widening tokens alone, while depth stays well inside the allowance. A rule
        // that demanded every dimension widen would admit this and let the child
        // escape the parent's token bound.
        expect(
            widensResourceCeiling(remainder, new ResourceCeiling({ tokens: 101, depth: 1 }))
        ).toBe(true);
        expect(
            widensResourceCeiling(remainder, new ResourceCeiling({ tokens: 100, depth: 5 }))
        ).toBe(false);
        // A dimension the parent never declared bounds nothing, so declaring it is not
        // widening.
        expect(widensResourceCeiling(remainder, new ResourceCeiling({ wallClockMs: 1_000 }))).toBe(
            false
        );
        expect(widensResourceCeiling(undefined, new ResourceCeiling({ tokens: 1 }))).toBe(false);
    });

    it(
        "[C13-RUN-RESOURCE-CEILING] carries exactly the dimensions it declares through data and back",
        { tags: "p1" },
        () => {
            // A ceiling that declares one dimension leaves the other three undeclared, which
            // is unbounded rather than zero. Everything downstream reads that distinction
            // off `entries`, so a ceiling that reported an entry per dimension — declared or
            // not — would encode limits the declarer never wrote.
            const partial = new ResourceCeiling({ tokens: 5 });
            expect(partial.entries).toEqual([["tokens", 5]]);
            expect(partial.declared).toEqual(["tokens"]);
            expect(partial.toData()).toEqual({ tokens: 5 });
            expect(ResourceCeiling.fromData(partial.toData()).equals(partial)).toBe(true);

            // Declaration order does not follow the object's key order: entries walk the
            // declared dimension list, so a ceiling written in any order reads the same.
            expect(new ResourceCeiling({ wallClockMs: 9, depth: 1 }).declared).toEqual([
                "depth",
                "wallClockMs"
            ]);

            expect(() => ResourceCeiling.fromData({ tokens: "5" })).toThrow(
                "Resource ceiling tokens must be a non-negative safe integer"
            );
            expect(() => ResourceCeiling.fromData({ depth: -1 })).toThrow(
                "Resource ceiling depth must be a non-negative safe integer"
            );
        }
    );

    it(
        "[C13-RUN-RESOURCE-CEILING] digests a ceiling only through the exact ceiling class",
        { tags: "p0" },
        () => {
            // The reservation commits to a digest of this record, so a ceiling that could
            // override how it renders itself would let the attenuation the spawn is checked
            // against differ from the one it encodes.
            class WidenedCeiling extends ResourceCeiling {
                public override limit(): number {
                    return Number.MAX_SAFE_INTEGER;
                }
            }
            expect(
                () => new SpawnAttenuation({ ceiling: new WidenedCeiling({ tokens: 1 }) })
            ).toThrow("Spawn attenuation ceiling must use the exact context class");
            expect(
                new SpawnAttenuation({ ceiling: new ResourceCeiling({ tokens: 1 }) }).ceiling
            ).toBeDefined();

            // The attenuation declares `ceiling` and nothing else, so any other key is
            // refused whatever it is named.
            expect(() =>
                SpawnAttenuation.fromData({ ceiling: null, "Stryker was here": 1 })
            ).toThrow("Spawn attenuation contains missing or unknown fields");
        }
    );

    it(
        "[C13-RUN-RESOURCE-CEILING] narrows a child when the parent spends after the spawn",
        { tags: "p0" },
        () => {
            const root = seedRunningTurn();
            const parent = spawnChild(
                root,
                "spender",
                ids.run,
                root.token,
                ceiling({ tokens: 100 })
            );
            root.runtime.recordModelUsage(parent.run, 40);

            // Declared at exactly the parent's remainder, so the child's own declaration
            // is what bounds it for now.
            const child = spawnChild(
                root,
                "at-remainder",
                parent.run,
                parent.token,
                ceiling({ tokens: 60 })
            );
            expect(
                root.runtime.remainingResources(child.run, new Date(1_600))?.limit("tokens")
            ).toBe(60);

            // The parent keeps spending. Its remainder is now tighter than what the child
            // declared, and the tighter of the two has to win or the child outlives the
            // bound it was spawned under.
            root.runtime.recordModelUsage(parent.run, 30);
            expect(
                root.runtime.remainingResources(child.run, new Date(1_600))?.limit("tokens")
            ).toBe(30);
        }
    );
});

describe("Run realized cost", () => {
    const usd = new Currency("USD");
    const eur = new Currency("EUR");

    function activeRun(): Run {
        const base = genesis().run;
        return new Run({
            id: base.id,
            agent: base.agent,
            configuration: base.configuration,
            root: base.root,
            initialBranch: base.initialBranch,
            revision: new Revision(0)
        });
    }

    function endedRun(run: Run): Run {
        return run.terminalize(
            new TerminalSnapshot(
                run.id,
                ids.turn,
                ids.root,
                new RunCommitId("terminal-cost-commit"),
                "succeeded",
                new SettlementObligation({ registryEpoch: 1, obligations: [] }),
                new Date(2_000)
            )
        );
    }

    it(
        "[C13-RUN-CEILING-COST] declares costMicros as a ceiling dimension like any other",
        { tags: "p0" },
        () => {
            // The dimension has to be in the tuple itself rather than handled beside it:
            // every reader of a ceiling walks RESOURCE_DIMENSIONS, so a cost bound the tuple
            // omits is a bound nothing enforces.
            expect(RESOURCE_DIMENSIONS).toContain("costMicros");

            const bound = new ResourceCeiling({ costMicros: 2_500_000 });
            expect(bound.declared).toEqual(["costMicros"]);
            expect(bound.toData()).toEqual({ costMicros: 2_500_000 });
            expect(ResourceCeiling.fromData(bound.toData()).equals(bound)).toBe(true);
            expect(() => ResourceCeiling.fromData({ costMicros: -1 })).toThrow(
                "Resource ceiling costMicros must be a non-negative safe integer"
            );

            // Exhaustion reads the same check every dimension reads. A cost bound with
            // allowance left is not exhausted, and one with none is named exactly once.
            expect(exhaustedResource(new ResourceCeiling({ costMicros: 1 }))).toBeUndefined();
            expect(exhaustedResource(new ResourceCeiling({ costMicros: 0 }))).toBe("costMicros");
            expect(exhaustedResource(new ResourceCeiling({ costMicros: 5, tokens: 0 }))).toBe(
                "tokens"
            );
        }
    );

    it(
        "[C13-RUN-CEILING-COST] narrows a cost bound from the Run's own realized total",
        { tags: "p0" },
        () => {
            // The remainder is spend against a declared bound, so it has to fall by exactly
            // what the calls incurred. A host that narrowed from anything else would be
            // reporting a claim about a rate table rather than a fact about spend.
            const declared = new ResourceCeiling({ costMicros: 1_000_000 });
            const remainder = narrowResources(undefined, declared, {
                costMicros: 400_000,
                tokens: 0,
                wallClockMs: 0
            });
            expect(remainder?.limit("costMicros")).toBe(600_000);

            const spent = narrowResources(undefined, declared, {
                costMicros: 1_000_000,
                tokens: 0,
                wallClockMs: 0
            });
            expect(exhaustedResource(spent)).toBe("costMicros");
        }
    );

    it(
        "[C13-RUN-CEILING-COST] accumulates a durable per-Run total and carries it through the codec",
        { tags: "p0" },
        () => {
            const run = activeRun();
            expect(run.costConsumed).toBeUndefined();

            const once = run.recordModelUsage(0, new RealizedCost(1_250, usd), []);
            const twice = once.recordModelUsage(0, new RealizedCost(750, usd), []);
            expect(twice.costConsumed?.micros).toBe(2_000);
            expect(twice.costConsumed?.currency.equals(usd)).toBe(true);

            const decoded = Run.codec.decode(Run.codec.encode(twice));
            expect(decoded.costConsumed?.micros).toBe(2_000);
            expect(decoded.costConsumed?.currency.equals(usd)).toBe(true);

            // A Run that recorded no realized cost declares nothing, which is what lets a
            // host with no cost to report leave the dimension unbounded instead of writing
            // a zero that reads as a measured total.
            expect(Run.codec.decode(Run.codec.encode(run)).costConsumed).toBeUndefined();

            // The record moved to a new major with the total on it, and the previous major
            // has no reader: a stored Run written before the cost total existed is refused
            // rather than read as a Run that spent nothing.
            expect(() =>
                Run.codec.decode(
                    encodeCanonicalJson({
                        kind: "run.record",
                        version: { major: 2, minor: 0 },
                        payload: twice.toData()
                    })
                )
            ).toThrow(
                new AgentCoreError("codec.unknown-major", "Unsupported run.record codec major 2")
            );
        }
    );

    it(
        "[C13-RUN-CEILING-COST] records one currency per Run lineage and refuses a second",
        { tags: "p0" },
        () => {
            // A comparison between amounts in two currencies is not a comparison, and a
            // ceiling is nothing but that comparison, so the recording path is where the
            // second currency has to be refused. It cannot be refused later: by then a
            // mixed total already exists and every remainder computed from it is nonsense.
            const started = activeRun().recordModelUsage(0, new RealizedCost(1_000, usd), []);
            const drift = thrownBy(AgentCoreError, () =>
                started.recordModelUsage(0, new RealizedCost(1_000, eur), [])
            );
            expect(drift.code).toBe("run.invalid-state");
            expect(drift.message).toContain("USD");
            expect(drift.message).toContain("EUR");

            // The lineage answer binds a Run that has recorded nothing yet, so a child
            // cannot open a second currency under an ancestor that already committed to one.
            const child = thrownBy(AgentCoreError, () =>
                activeRun().recordModelUsage(0, new RealizedCost(5, eur), [usd])
            );
            expect(child.code).toBe("run.invalid-state");

            // The refusal leaves no total behind, so the mixed lineage narrows nothing: the
            // ceiling still reads the last agreeing total and no other.
            expect(started.costConsumed?.micros).toBe(1_000);
            expect(
                narrowResources(undefined, new ResourceCeiling({ costMicros: 5_000 }), {
                    costMicros: started.costConsumed?.micros ?? 0,
                    tokens: 0,
                    wallClockMs: 0
                })?.limit("costMicros")
            ).toBe(4_000);
        }
    );

    it(
        "[C13-RUN-CEILING-COST] has no estimated form and refuses an unusable amount",
        { tags: "p1" },
        () => {
            // There is no field an estimate could travel in. A host with nothing realized to
            // record cannot build the value at all, which is the rule rather than an omission.
            expect(() => new RealizedCost(-1, usd)).toThrow(
                "Realized cost must be a non-negative safe integer of micros"
            );
            expect(() => new RealizedCost(1.5, usd)).toThrow(
                "Realized cost must be a non-negative safe integer of micros"
            );
            expect(() => RealizedCost.fromData({ micros: 1 })).toThrow(
                "Realized cost contains missing or unknown fields"
            );
            expect(() =>
                RealizedCost.fromData({ currency: "USD", micros: 1, estimate: true })
            ).toThrow("Realized cost contains missing or unknown fields");
            expect(
                RealizedCost.fromData(new RealizedCost(7, usd).toData()).equals(
                    new RealizedCost(7, usd)
                )
            ).toBe(true);

            // A terminal Run incurs nothing further, so a late report cannot move a total
            // the Run's terminal snapshot was derived against.
            const terminal = thrownBy(AgentCoreError, () => {
                endedRun(activeRun()).recordModelUsage(0, new RealizedCost(1, usd), []);
            });
            expect(terminal.code).toBe("run.invalid-state");
        }
    );

    it(
        "[C13-RUN-CEILING-COST] advances the cost total at the same commit point as the token total",
        { tags: "p0" },
        () => {
            // One commit point for both dimensions. A host that advanced them separately
            // could leave a Run whose token total says a call happened and whose cost total
            // says it did not, and a remainder read between the two writes would bound
            // spend against a call already made.
            const root = seedRunningTurn();
            const parent = spawnChild(
                root,
                "cost-parent",
                ids.run,
                root.token,
                ceiling({ costMicros: 1_000_000, tokens: 100 })
            );

            root.runtime.recordModelUsage(parent.run, 25, new RealizedCost(400_000, usd));
            expect(
                root.runtime.remainingResources(parent.run, new Date(1_600))?.toData()
            ).toMatchObject({ costMicros: 600_000, tokens: 75 });

            // A child under no declaration of its own inherits the remainder, so cost the
            // parent already spent bounds the child without the child accounting for it.
            const child = spawnChild(
                root,
                "cost-child",
                parent.run,
                parent.token,
                new SpawnAttenuation()
            );
            root.runtime.recordModelUsage(child.run, 5, new RealizedCost(100_000, usd));
            expect(
                root.runtime.remainingResources(child.run, new Date(1_600))?.limit("costMicros")
            ).toBe(500_000);

            // The lineage answer is read from the ancestor Runs rather than stored again, so
            // a child cannot open a second currency under a parent that already committed.
            const drift = thrownBy(AgentCoreError, () =>
                root.runtime.recordModelUsage(child.run, 1, new RealizedCost(1, eur))
            );
            expect(drift.code).toBe("run.invalid-state");

            // The refused call left neither total moved, which is what makes the two
            // dimensions one commit point rather than two writes that can disagree.
            const totals = root.repository.transaction((transaction) => {
                const loaded = root.repository.loadRun(transaction, child.run);
                return {
                    cost: loaded?.costConsumed?.micros,
                    currency: loaded?.costConsumed?.currency.value,
                    tokens: loaded?.tokensConsumed
                };
            });
            expect(totals).toEqual({ cost: 100_000, currency: "USD", tokens: 5 });

            // A call the host reports no realized cost for advances tokens alone and leaves
            // the recorded currency untouched.
            root.runtime.recordModelUsage(child.run, 3);
            expect(
                root.repository.transaction(
                    (transaction) => root.repository.loadRun(transaction, child.run)?.costConsumed
                )?.micros
            ).toBe(100_000);
        }
    );

    it(
        "[C13-RUN-CEILING-COST] reaches the same verdict whichever Run in the lineage recorded first",
        { tags: "p0" },
        () => {
            // Parent first, then the child: the child's walk finds the currency above it.
            const downward = seedRunningTurn();
            const below = spawnChild(
                downward,
                "order-below",
                ids.run,
                downward.token,
                new SpawnAttenuation()
            );
            downward.runtime.recordModelUsage(ids.run, 1, new RealizedCost(10, usd));
            const afterParent = thrownBy(AgentCoreError, () =>
                downward.runtime.recordModelUsage(below.run, 1, new RealizedCost(10, eur))
            );
            expect(afterParent.code).toBe("run.invalid-state");

            // Child first, then the parent. Reading only ancestors admitted this: the child
            // found nothing above it and the parent found nothing below, so both were taken.
            const upward = seedRunningTurn();
            const above = spawnChild(
                upward,
                "order-above",
                ids.run,
                upward.token,
                new SpawnAttenuation()
            );
            upward.runtime.recordModelUsage(above.run, 1, new RealizedCost(10, usd));
            const afterChild = thrownBy(AgentCoreError, () =>
                upward.runtime.recordModelUsage(ids.run, 1, new RealizedCost(10, eur))
            );
            expect(afterChild.code).toBe("run.invalid-state");
            expect(afterChild.message).toBe("Run lineage records cost in USD, not EUR");

            // The refusal moved neither total on either Run, so the mixed lineage narrowed
            // nothing and no remainder was computed against an amount nobody can compare.
            const totals = upward.repository.transaction((transaction) => ({
                child: upward.repository.loadRun(transaction, above.run),
                root: upward.repository.loadRun(transaction, ids.run)
            }));
            expect([totals.root?.tokensConsumed, totals.root?.costConsumed]).toEqual([
                0,
                undefined
            ]);
            expect([
                totals.child?.tokensConsumed,
                totals.child?.costConsumed?.micros,
                totals.child?.costConsumed?.currency.value
            ]).toEqual([1, 10, "USD"]);

            // Three deep, with the middle Run recording last. Its cost sits in the lineage of
            // the Run below it and in its own, so both bind it and neither order changes that.
            const chained = seedRunningTurn();
            const middle = spawnChild(
                chained,
                "order-middle",
                ids.run,
                chained.token,
                new SpawnAttenuation()
            );
            const deepest = spawnChild(
                chained,
                "order-deepest",
                middle.run,
                middle.token,
                new SpawnAttenuation()
            );
            chained.runtime.recordModelUsage(ids.run, 1, new RealizedCost(10, usd));
            chained.runtime.recordModelUsage(deepest.run, 1, new RealizedCost(10, usd));
            const between = thrownBy(AgentCoreError, () =>
                chained.runtime.recordModelUsage(middle.run, 1, new RealizedCost(10, eur))
            );
            expect(between.code).toBe("run.invalid-state");
            expect(
                chained.runtime.recordModelUsage(middle.run, 1, new RealizedCost(10, usd))
                    .costConsumed?.micros
            ).toBe(10);
        }
    );

    it(
        "[C13-RUN-CEILING-COST] leaves two siblings free to record in different currencies and refuses the parent that would join them",
        { tags: "p0" },
        () => {
            // §5.2 binds one currency per Run lineage, and a lineage runs from the root down
            // one spawn chain. No lineage holds both siblings — neither is the other's
            // ancestor — and no ceiling comparison ever adds their amounts, because each child
            // is bounded by its own attenuation of the parent's remainder. So this is legal,
            // and refusing it would be a rule the SPEC does not state.
            const root = seedRunningTurn();
            const left = spawnChild(root, "twin-left", ids.run, root.token, new SpawnAttenuation());
            const right = spawnChild(
                root,
                "twin-right",
                ids.run,
                root.token,
                new SpawnAttenuation()
            );
            expect(
                root.runtime.recordModelUsage(left.run, 1, new RealizedCost(10, usd)).costConsumed
                    ?.currency.value
            ).toBe("USD");
            expect(
                root.runtime.recordModelUsage(right.run, 1, new RealizedCost(10, eur)).costConsumed
                    ?.currency.value
            ).toBe("EUR");

            // The parent is the Run both lineages pass through, so its own cost would be an
            // amount in each of them. Each sibling's currency binds it on its own, so the
            // parent has no currency left to record in and each refusal names the divergence.
            for (const [candidate, divergent] of [
                [usd, "EUR"],
                [eur, "USD"]
            ] as const) {
                const joined = thrownBy(AgentCoreError, () =>
                    root.runtime.recordModelUsage(ids.run, 1, new RealizedCost(10, candidate))
                );
                expect(joined.code).toBe("run.invalid-state");
                expect(joined.message).toBe(
                    `Run lineage records cost in ${divergent}, not ${candidate.value}`
                );
            }
            expect(
                root.repository.transaction((transaction) =>
                    root.repository.loadRun(transaction, ids.run)
                )?.costConsumed
            ).toBeUndefined();

            // A grandchild under one sibling answers to that sibling and not to the other.
            const under = spawnChild(
                root,
                "twin-under",
                left.run,
                left.token,
                new SpawnAttenuation()
            );
            expect(
                root.runtime.recordModelUsage(under.run, 1, new RealizedCost(10, usd)).costConsumed
                    ?.micros
            ).toBe(10);
        }
    );

    it(
        "[C13-RUN-CEILING-COST] keeps the lineage verdict across a store restart, because it is derived from the Run records",
        { tags: "p0" },
        () => {
            const before = seedRunningTurn();
            const child = spawnChild(
                before,
                "restart-child",
                ids.run,
                before.token,
                new SpawnAttenuation()
            );
            before.runtime.recordModelUsage(child.run, 1, new RealizedCost(10, usd));

            // A new runtime over the same stored records, holding nothing in memory from the
            // first. A lineage currency kept beside the Runs would not survive this.
            const after = harness(before.storage.snapshot());
            const refused = thrownBy(AgentCoreError, () =>
                after.runtime.recordModelUsage(ids.run, 1, new RealizedCost(10, eur))
            );
            expect(refused.code).toBe("run.invalid-state");
            expect(refused.message).toBe("Run lineage records cost in USD, not EUR");
            expect(
                after.runtime.recordModelUsage(ids.run, 1, new RealizedCost(10, usd)).costConsumed
                    ?.micros
            ).toBe(10);
        }
    );
});

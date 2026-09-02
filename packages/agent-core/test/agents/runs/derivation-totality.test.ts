import { describe, expect, test } from "vitest";
import {
    Actor,
    ActorId,
    ActorRecoveryState,
    ActorRef,
    createActorContext,
    MemoryActorStore,
    type ActorContext
} from "../../../src/actors";
import { RUN_RECORD_CODECS } from "../../../src/agents";
import { RunAdmissionRegistry, type RunObligation } from "../../../src/agents/runs/admission";
import { RunId } from "../../../src/agents/runs/id";
import { SettlementObligation, isSettled } from "../../../src/agents/runs/settlement";
import { CodecDeclaration } from "../../../src/core";
import { ApprovalId } from "../../../src/invocation-references";

const RUN = new RunId("run-derivation");
const ACTOR = new ActorRef("run", new ActorId("actor-derivation"));

/**
 * A record set the reader cannot decode: a future kind at a version no codec in this build
 * carries. Storing it beside the stable recovery carrier is exactly the §8.3 case — the
 * Actor still constructs and fences, and every operation over the record set refuses.
 */
const ROLLED_FORWARD = CodecDeclaration.of([
    ActorRecoveryState.codec,
    ...RUN_RECORD_CODECS.declared,
    { kind: "run.future-derivation-input", version: { major: 1, minor: 0 } }
]);

/** The Actor's own durable state: a counter proving whether a derivation body ran at all. */
interface DerivationState {
    reads: number;
}

const RESERVED: readonly RunObligation[] = Object.freeze([
    approval("approval-a"),
    approval("approval-b"),
    approval("approval-c")
]);
const REGISTRY = new RunAdmissionRegistry({
    run: RUN,
    epoch: 0,
    open: true,
    reserved: RESERVED,
    completed: [RESERVED[0]!, RESERVED[1]!]
});
const SETTLEMENT = new SettlementObligation({ registryEpoch: 0, obligations: RESERVED });
const ANCESTRY: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "commit-head": ["commit-middle"],
    "commit-middle": ["commit-root"],
    "commit-root": []
});
const RESOLVED_APPROVALS: readonly string[] = Object.freeze(["approval-a", "approval-b"]);

/**
 * The three §8.3 derivations, hosted by the Actor that owns the Run record set. Each reads
 * the whole set: a frontier is reserved minus completed, an ancestry answer is a walk over
 * every commit in a lineage, and settlement is every captured obligation discharged. None
 * of the three can answer from the part of the set a reader happens to understand, which is
 * why they run inside `execute` and inherit the record-set gate rather than re-deriving it.
 */
class RunDerivationActor extends Actor<DerivationState> {
    public constructor(context: ActorContext<DerivationState>) {
        super(context, RUN_RECORD_CODECS, () => undefined);
    }

    /** C13-RUN-FRONTIER-COMPLETE: reserved minus completed. */
    public frontier(): Promise<readonly RunObligation[]> {
        return this.execute((state) => {
            state.reads += 1;
            return REGISTRY.frontier();
        });
    }

    /** C13-RUN-ANCESTRY: the walk from a descendant to a candidate ancestor. */
    public isAncestor(ancestor: string, descendant: string): Promise<boolean> {
        return this.execute((state) => {
            state.reads += 1;
            const pending = [descendant];
            const visited = new Set<string>();
            while (pending.length > 0) {
                const current = pending.pop()!;
                if (current === ancestor) return true;
                if (visited.has(current)) continue;
                visited.add(current);
                pending.push(...(ANCESTRY[current] ?? []));
            }
            return false;
        });
    }

    /** C13-RUN-SETTLED-DERIVED: every captured obligation discharged. */
    public settled(): Promise<boolean> {
        return this.execute((state) => {
            state.reads += 1;
            return isSettled(state, SETTLEMENT, {
                approvalResolved: (_transaction, resolved) =>
                    RESOLVED_APPROVALS.includes(resolved.value),
                invocationItemTerminal: () => true,
                routeTerminal: () => true,
                reconciliationSuperseded: () => true,
                commitExists: () => true,
                acceptanceSatisfied: () => true,
                auditSatisfied: () => true
            });
        });
    }
}

function approval(id: string): RunObligation {
    return Object.freeze({ kind: "approval", approval: new ApprovalId(id) });
}

interface DerivationHarness {
    readonly actor: RunDerivationActor;
    /** The durable count of derivation bodies that ran, read without the Actor gate. */
    bodiesRun(): number;
    /** Rewrites the stored record set the way a rollback leaves it, and restarts a reader. */
    rollForward(stored: CodecDeclaration): RunDerivationActor;
}

function createHarness(): DerivationHarness {
    const store = new MemoryActorStore<DerivationState>({ reads: 0 }, (state) => ({ ...state }));
    return {
        actor: new RunDerivationActor(createActorContext(ACTOR, store)),
        bodiesRun: () => store.snapshot().state.reads,
        rollForward(stored: CodecDeclaration): RunDerivationActor {
            store.transaction((transaction) => {
                store.saveRecordSetDeclaration(
                    transaction,
                    ACTOR,
                    CodecDeclaration.toBytes(stored)
                );
            });
            return new RunDerivationActor(createActorContext(ACTOR, store));
        }
    };
}

describe("Run derivation totality", () => {
    test(
        "[C13-CODEC-INCOMPATIBILITY-TOTAL] [C13-RUN-FRONTIER-COMPLETE] a reserved-minus-completed frontier rejects an unreadable record set rather than answering short",
        { tags: "p0" },
        async () => {
            // The readable answer is one outstanding obligation; a reader that skipped the
            // completions it could not decode would answer three, which is the short answer
            // §8.3 exists to refuse.
            const harness = createHarness();
            await expect(harness.actor.frontier()).resolves.toEqual([approval("approval-c")]);
            expect(harness.bodiesRun()).toBe(1);

            // The refusal must be a rejection, never a shorter list, and the derivation body
            // must not have run at all: an answered promise here would be exactly the
            // discovery-by-decoding §8.3 replaces.
            await expect(harness.rollForward(ROLLED_FORWARD).frontier()).rejects.toMatchObject({
                code: "schema.unreadable"
            });
            expect(harness.bodiesRun()).toBe(1);
        }
    );

    test(
        "[C13-CODEC-INCOMPATIBILITY-TOTAL] [C13-RUN-ANCESTRY] an ancestry walk rejects an unreadable record set rather than answering not-an-ancestor",
        { tags: "p0" },
        async () => {
            // A walk that stops at the first commit it cannot decode answers `false`, which
            // is indistinguishable from a genuine negative — the exact confusion the gate
            // refuses before the walk starts.
            const harness = createHarness();
            await expect(harness.actor.isAncestor("commit-root", "commit-head")).resolves.toBe(
                true
            );
            await expect(harness.actor.isAncestor("commit-head", "commit-root")).resolves.toBe(
                false
            );
            expect(harness.bodiesRun()).toBe(2);

            await expect(
                harness.rollForward(ROLLED_FORWARD).isAncestor("commit-root", "commit-head")
            ).rejects.toMatchObject({ code: "schema.unreadable" });
            expect(harness.bodiesRun()).toBe(2);
        }
    );

    test(
        "[C13-CODEC-INCOMPATIBILITY-TOTAL] [C13-RUN-SETTLED-DERIVED] a settlement test rejects an unreadable record set rather than reporting settled",
        { tags: "p0" },
        async () => {
            // Two of three obligations are discharged, so the readable answer is `false`. A
            // reader that dropped the obligation it could not decode would report `true` and
            // let a Run terminate with work outstanding.
            const harness = createHarness();
            await expect(harness.actor.settled()).resolves.toBe(false);
            expect(harness.bodiesRun()).toBe(1);

            await expect(harness.rollForward(ROLLED_FORWARD).settled()).rejects.toMatchObject({
                code: "schema.unreadable"
            });
            expect(harness.bodiesRun()).toBe(1);
        }
    );

    test(
        "[C13-CODEC-INCOMPATIBILITY-TOTAL] the Run record set a protocol command declares is the set these derivations read",
        { tags: "p0" },
        () => {
            const declared = RUN_RECORD_CODECS.declared.map((entry) => entry.kind);

            expect(declared).toContain("run.admission-registry");
            expect(declared).toContain("run.commit");
            expect(declared).toContain("run.record");
            expect(new Set(declared).size).toBe(declared.length);
            // The declaration a reader compares against covers the whole set, so no
            // derivation over it can be reached through a partially decodable store.
            expect(() =>
                RUN_RECORD_CODECS.compatibilityWith(RUN_RECORD_CODECS).requireCompatible()
            ).not.toThrow();
            expect(() =>
                ROLLED_FORWARD.compatibilityWith(RUN_RECORD_CODECS).requireCompatible()
            ).toThrow(expect.objectContaining({ code: "schema.unreadable" }));
        }
    );
});

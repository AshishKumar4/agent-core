import { describe, expect, test } from "vitest";
import {
    CancelledTurnStatus,
    FailedTurnStatus,
    QueuedTurnStatus,
    RunningTurnStatus,
    SucceededTurnStatus,
    SuspendedTurnStatus,
    TerminalOutcome,
    TurnStatus,
    ofTerminalOutcome,
    type GeneratedData,
    type Option,
    type TurnStatusData
} from "../../../src/agents/runs/generated/turn-status/AgentCore/Extract/TurnStatus";

/*
 * `src/agents/runs/generated/turn-status/` is what the TSLean compiler lowers from the Lean
 * module the kernel checks, `formal/AgentCore/Extract/TurnStatus.lean`: SPEC §5.3's status
 * vocabulary, the four moves it admits, the terminal-outcome map and the data codec, all
 * lowered together.
 *
 * test/agents/runs/turn-exhaustive.test.ts drives the moves a Turn aggregate reaches for.
 * This suite drives the generated module's own public surface over its whole domain —
 * every status through every constructor, every move, every codec arm — and decides each
 * answer from the SPEC table rather than from either side of the lowering, so a lowering
 * that disagreed with the table would fail here rather than agree with itself.
 */

interface Moves {
    readonly cancelUnheld: TurnStatusData | "refused";
    readonly claim: TurnStatusData | "refused";
    readonly suspend: TurnStatusData | "refused";
    readonly completes: boolean;
    readonly terminal: boolean;
}

/** `satisfies` keys this by status, so a new status fails to compile rather than going untested. */
const SPEC = {
    // A queued Turn has no holder, so an unheld cancellation is admitted and a claim
    // starts it; there is no hold to suspend and no attempt to complete.
    queued: {
        cancelUnheld: "cancelled",
        claim: "running",
        suspend: "refused",
        completes: false,
        terminal: false
    },
    // A running Turn is held: cancelling it needs the holder's token, it cannot be
    // claimed again, and it is the only status that may complete.
    running: {
        cancelUnheld: "refused",
        claim: "refused",
        suspend: "suspended",
        completes: true,
        terminal: false
    },
    // A suspended Turn holds no lease, so it cancels unheld and resumes by claim.
    suspended: {
        cancelUnheld: "cancelled",
        claim: "running",
        suspend: "refused",
        completes: false,
        terminal: false
    },
    succeeded: {
        cancelUnheld: "refused",
        claim: "refused",
        suspend: "refused",
        completes: false,
        terminal: true
    },
    failed: {
        cancelUnheld: "refused",
        claim: "refused",
        suspend: "refused",
        completes: false,
        terminal: true
    },
    cancelled: {
        cancelUnheld: "refused",
        claim: "refused",
        suspend: "refused",
        completes: false,
        terminal: true
    }
} satisfies Record<TurnStatusData, Moves>;

const STATUSES: readonly TurnStatusData[] = [
    "queued",
    "running",
    "suspended",
    "succeeded",
    "failed",
    "cancelled"
];

/** The static accessor per status, so every one of the six is exercised by name. */
const SINGLETON = {
    queued: TurnStatus.queued,
    running: TurnStatus.running,
    suspended: TurnStatus.suspended,
    succeeded: TurnStatus.succeeded,
    failed: TurnStatus.failed,
    cancelled: TurnStatus.cancelled
} satisfies Record<TurnStatusData, TurnStatus>;

/** SPEC §5.3's terminal vocabulary, and the status each outcome ends a Turn in. */
const OUTCOMES = {
    succeeded: "succeeded",
    failed: "failed",
    cancelled: "cancelled"
} satisfies Record<TerminalOutcome, TurnStatusData>;

const NOT_STATUS_DATA: readonly GeneratedData[] = [
    "",
    "Queued",
    "queued ",
    "done",
    "terminal",
    0,
    1,
    true,
    false,
    null,
    undefined,
    [],
    ["queued"],
    {},
    { kind: "queued" }
];

function moved(next: Option<TurnStatus>): TurnStatusData | "refused" {
    return next.kind === "none" ? "refused" : next.value.kind;
}

function answers(status: TurnStatus): Moves {
    return {
        cancelUnheld: moved(status.cancelUnheld()),
        claim: moved(status.claim()),
        suspend: moved(status.suspend()),
        completes: status.completes(),
        terminal: status.terminal()
    };
}

describe("the TSLean-generated Turn status lowering", () => {
    test("names every status the SPEC table declares", { tags: "p1" }, () => {
        // The table is what every other test here reads, so a status missing from this
        // list would silently narrow all of them.
        expect([...STATUSES].sort()).toEqual(Object.keys(SPEC).sort());
    });

    test(
        "[C13-TURN-EXECUTOR-WRITER] answers SPEC §5.3's whole move table for every status, from every constructor",
        { tags: "p0" },
        () => {
            for (const kind of STATUSES) {
                // `from`, `fromData` and the static accessor are three doors to one
                // value: the moves are decided by the status, never by how it was named.
                const named = TurnStatus.from(kind);
                const decoded = TurnStatus.fromData(kind);
                expect(named).toBe(SINGLETON[kind]);
                expect(decoded).toBe(SINGLETON[kind]);
                expect(named.kind).toBe(kind);
                expect(named.toData()).toBe(kind);

                expect(answers(named)).toEqual(SPEC[kind]);
                expect(answers(decoded)).toEqual(SPEC[kind]);
            }
        }
    );

    test(
        "[C13-TURN-EXECUTOR-WRITER] admits a claim from exactly the two unheld statuses and completion from exactly the held one",
        { tags: "p0" },
        () => {
            // The three facts the lease and settlement paths read, stated over the whole
            // vocabulary rather than per call site: a lease may be claimed from `queued`
            // and `suspended` only, only a running Turn may complete, and the three
            // terminal statuses admit no further move.
            const claimable = STATUSES.filter((kind) => SPEC[kind].claim !== "refused");
            const completing = STATUSES.filter((kind) => SPEC[kind].completes);
            const terminal = STATUSES.filter((kind) => SPEC[kind].terminal);
            expect(claimable).toEqual(["queued", "suspended"]);
            expect(completing).toEqual(["running"]);
            expect(terminal).toEqual(["succeeded", "failed", "cancelled"]);

            for (const kind of terminal) {
                const status = TurnStatus.from(kind);
                expect(status.claim().kind).toBe("none");
                expect(status.suspend().kind).toBe("none");
                expect(status.cancelUnheld().kind).toBe("none");
                expect(status.completes()).toBe(false);
            }
        }
    );

    test("decides equality by the status a value names", { tags: "p1" }, () => {
        for (const left of STATUSES) {
            for (const right of STATUSES) {
                // Every constructor hands back the one value per status, which is what
                // makes identity equality sound for anything reached through this API.
                expect(TurnStatus.from(left).equals(TurnStatus.fromData(right))).toBe(
                    left === right
                );
            }
        }
    });

    test("refuses status data outside the vocabulary", { tags: "p1" }, () => {
        for (const value of NOT_STATUS_DATA) {
            // A decode that guessed here would resurrect a Turn into a status the table
            // has no moves for, so every non-member is refused rather than defaulted.
            expect(() => TurnStatus.fromData(value)).toThrow(TypeError);
            expect(() => TurnStatus.fromData(value)).toThrow(
                /TurnStatus data must name a constructor/u
            );
        }
    });

    test(
        "[C13-TURN-EXECUTOR-WRITER] ends a Turn in the status its outcome names, for the whole terminal vocabulary",
        { tags: "p0" },
        () => {
            for (const [outcome, expected] of Object.entries(OUTCOMES)) {
                const decoded = TerminalOutcome.fromData(outcome);
                expect(decoded).toBe(outcome);
                const ended = ofTerminalOutcome(decoded);
                expect(ended.kind).toBe(expected);
                expect(ended).toBe(TurnStatus.from(expected));
                // Ending is terminal by construction: the map has no non-terminal image.
                expect(ended.terminal()).toBe(true);
            }
        }
    );

    test("refuses an outcome the terminal vocabulary does not name", { tags: "p1" }, () => {
        // The outcome vocabulary is narrower than the status one: a Turn can be
        // `queued`, but no Turn ends `queued`, and a codec that accepted it would name a
        // settlement no record can describe.
        for (const value of [...NOT_STATUS_DATA, "queued", "running", "suspended"]) {
            expect(() => TerminalOutcome.fromData(value)).toThrow(TypeError);
            expect(() => TerminalOutcome.fromData(value)).toThrow(
                /TerminalOutcome must name a TerminalOutcome/u
            );
        }
    });

    test("seals every lowered case as a frozen value", { tags: "p2" }, () => {
        const cases = [
            new QueuedTurnStatus(),
            new RunningTurnStatus(),
            new SuspendedTurnStatus(),
            new SucceededTurnStatus(),
            new FailedTurnStatus(),
            new CancelledTurnStatus()
        ];

        expect(cases.map((status) => status.kind)).toEqual(STATUSES);
        for (const status of cases) {
            // A status is a shared immutable value every Turn holds; the lowering owns
            // that freeze, so a case that could be mutated by one holder would move
            // every other holder's answer.
            expect(Object.isFrozen(status)).toBe(true);
            // A case constructed directly still answers the table, so the singletons are
            // a sharing decision rather than where the behavior lives.
            expect(answers(status)).toEqual(SPEC[status.kind]);
        }
    });
});

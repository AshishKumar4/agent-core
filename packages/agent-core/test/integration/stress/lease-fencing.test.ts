import { describe, expect, test } from "vitest";
import {
    RepositoryTurnLeaseVerifier,
    TurnInboxEntry,
    TurnInboxEntryId,
    type LeaseToken
} from "../../../src/agents";
import { PrincipalId, PrincipalRef } from "../../../src/identity";
import { Revision } from "../../../src/core";
import type { Turn } from "../../../src/agents";
import { content, digest, ids, seedRunningTurn } from "../../agents/runs/fixture";
import { expectAgentCoreError } from "../../protocol/error-assertion";
import { SqliteCounterHarness } from "../../protocol/sqlite-counter-fixture";
import { StressRandom } from "./stress-support";

const STRESS_TIMEOUT = 90_000;
const ROTATIONS = 60;
const LEASE_SPAN = 1_000;
/** The seeded Turn is claimed at 1000ms and expires at 5000ms. */
const SEEDED_EXPIRY = 5_000;
const INGRESS_ROTATIONS = 24;
const INGRESS_HOLDERS = 4;

type RunHarness = ReturnType<typeof seedRunningTurn>;

const at = (milliseconds: number): Date => new Date(milliseconds);

function holderFor(index: number): PrincipalRef {
    return new PrincipalRef(ids.holder.tenantId, new PrincipalId(`lease-holder-${index}`));
}

function tokenFor(turn: Turn): LeaseToken {
    if (turn.lease.holder === undefined) {
        throw new TypeError("Expected a held Turn lease");
    }
    return { turn: turn.id, holder: turn.lease.holder, epoch: turn.lease.epoch };
}

function cancellation(
    turn: Turn,
    sequence: number,
    displaced: LeaseToken,
    recordedAt: number
): TurnInboxEntry {
    return new TurnInboxEntry(
        new TurnInboxEntryId(`inbox-fence-${sequence}`),
        turn.id,
        sequence,
        "turn.cancel",
        content("c"),
        digest("c"),
        `fence-${sequence}`,
        displaced,
        at(recordedAt)
    );
}

/**
 * Exactly one of every token ever minted may be admitted by the durable lease at any
 * observation. Zero is legal only while the lease is unheld or already expired.
 */
function admittedTokens(
    seeded: RunHarness,
    tokens: readonly LeaseToken[],
    now: number
): readonly LeaseToken[] {
    const verifier = new RepositoryTurnLeaseVerifier(seeded.repository, () => at(now));
    return tokens.filter((token) => verifier.permits(token));
}

function loadTurn(seeded: RunHarness): Turn {
    const turn = seeded.repository.transaction((transaction) =>
        seeded.repository.loadTurn(transaction, ids.turn)
    );
    if (turn === undefined) throw new TypeError("Expected a durable Turn");
    return turn;
}

function inboxLength(seeded: RunHarness): number {
    return seeded.repository.transaction((transaction) =>
        seeded.repository.listInbox(transaction, ids.turn)
    ).length;
}

describe("turn lease fencing under contention", () => {
    test(
        "admits at most one live holder across interleaved reclaim and renewal races",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        () => {
            const seeded = seedRunningTurn();
            const random = new StressRandom("lease-rotation");
            const minted: LeaseToken[] = [seeded.token];
            let turn = seeded.running;
            let now = SEEDED_EXPIRY - LEASE_SPAN;
            let expiry = SEEDED_EXPIRY;
            let sequence = 0;

            for (let rotation = 0; rotation < ROTATIONS; rotation += 1) {
                const displaced = tokenFor(turn);

                // Every previously minted token except the live one is already fenced.
                expect(admittedTokens(seeded, minted, now)).toEqual([displaced]);

                if (random.boolean()) {
                    expiry += LEASE_SPAN;
                    turn = seeded.runtime.renewTurn(
                        turn.id,
                        turn.revision,
                        displaced,
                        at(now),
                        at(expiry)
                    );
                    now += 1;
                    expect(turn.lease.epoch).toBe(displaced.epoch);
                    expect(admittedTokens(seeded, minted, now)).toEqual([displaced]);
                    continue;
                }

                // Reclaim requires an expired held lease, so the race runs at the expiry.
                expect(admittedTokens(seeded, minted, expiry)).toEqual([]);
                const reclaimedAt = expiry;
                expiry = reclaimedAt + 2 * LEASE_SPAN;
                turn = seeded.runtime.reclaimTurn(
                    turn.id,
                    turn.revision,
                    holderFor(rotation),
                    at(reclaimedAt),
                    at(expiry),
                    cancellation(turn, sequence, displaced, reclaimedAt)
                );
                sequence += 1;
                now = reclaimedAt + 1;
                const replacement = tokenFor(turn);
                minted.push(replacement);
                expect(admittedTokens(seeded, minted, now)).toEqual([replacement]);
            }

            expect(minted.at(-1)).toEqual(tokenFor(loadTurn(seeded)));
            expect(new Set(minted.map((token) => token.epoch)).size).toBe(minted.length);
            expect(inboxLength(seeded)).toBe(sequence);
        }
    );

    test(
        "refuses every durable mutation from a displaced holder",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        () => {
            const seeded = seedRunningTurn();
            const stale = seeded.token;
            const reclaimedAt = SEEDED_EXPIRY;
            const reclaimed = seeded.runtime.reclaimTurn(
                seeded.running.id,
                seeded.running.revision,
                holderFor(0),
                at(reclaimedAt),
                at(reclaimedAt + 4 * LEASE_SPAN),
                cancellation(seeded.running, 0, stale, reclaimedAt)
            );
            const inboxBefore = inboxLength(seeded);

            expectAgentCoreError(
                () =>
                    seeded.runtime.renewTurn(
                        reclaimed.id,
                        reclaimed.revision,
                        stale,
                        at(reclaimedAt + 1),
                        at(reclaimedAt + 10 * LEASE_SPAN)
                    ),
                "lease.invalid"
            );
            expectAgentCoreError(
                () =>
                    seeded.runtime.deliverEvent(
                        reclaimed.id,
                        reclaimed.revision,
                        stale,
                        new TurnInboxEntry(
                            new TurnInboxEntryId("inbox-stale-delivery"),
                            reclaimed.id,
                            inboxBefore,
                            "turn.message",
                            content("d"),
                            digest("d"),
                            "stale-delivery",
                            undefined,
                            at(reclaimedAt + 1)
                        ),
                        at(reclaimedAt + 1)
                    ),
                "lease.invalid"
            );
            expectAgentCoreError(
                () =>
                    seeded.runtime.claimTurn(
                        reclaimed.id,
                        new Revision(reclaimed.revision.value - 1),
                        holderFor(1),
                        at(reclaimedAt + 1),
                        at(reclaimedAt + 10 * LEASE_SPAN)
                    ),
                "protocol.revision-conflict"
            );

            const after = loadTurn(seeded);
            expect(after.revision).toEqual(reclaimed.revision);
            expect(after.lease.epoch).toBe(reclaimed.lease.epoch);
            expect(inboxLength(seeded)).toBe(inboxBefore);
            expect(admittedTokens(seeded, [stale], reclaimedAt + 1)).toEqual([]);
        }
    );

    test(
        "commits no command from a rotated-out lease holder through the real ingress",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        async () => {
            const harness = new SqliteCounterHarness({
                expectedRevision: "optional",
                lease: "required"
            });
            const random = new StressRandom("ingress-lease-rotation");
            const stale: LeaseToken[] = [];

            for (let rotation = 0; rotation < INGRESS_ROTATIONS; rotation += 1) {
                const live = harness.setLease({
                    holder: new PrincipalId(`ingress-holder-${rotation % INGRESS_HOLDERS}`),
                    epoch: rotation + 1
                });
                const submissions = random.shuffle([
                    ...stale.map((token) => ({ token, live: false })),
                    { token: live, live: true }
                ]);

                const results = await Promise.all(
                    submissions.map((submission, index) =>
                        harness.dispatch(
                            harness.envelope({
                                key: `lease-${rotation}-${index}`,
                                lease: submission.token,
                                omitRevision: true
                            })
                        )
                    )
                );

                for (const [index, result] of results.entries()) {
                    expect(result.outcome).toBe(
                        submissions[index]?.live === true ? "committed" : "rejectedLease"
                    );
                }
                stale.push(live);
                expect(harness.snapshot().value).toBe(rotation + 1);
            }

            const snapshot = harness.snapshot();
            expect(snapshot.revision.value).toBe(INGRESS_ROTATIONS);
            expect(snapshot.writes.filter((write) => write.outcome === "committed")).toHaveLength(
                INGRESS_ROTATIONS
            );
            expect(
                snapshot.writes.filter((write) => write.outcome === "rejectedLease")
            ).toHaveLength((INGRESS_ROTATIONS * (INGRESS_ROTATIONS - 1)) / 2);
        }
    );
});

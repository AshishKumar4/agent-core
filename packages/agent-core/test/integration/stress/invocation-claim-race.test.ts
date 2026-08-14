import { describe, expect, test } from "vitest";
import { ContentRef, Digest } from "../../../src/core";
import { InvocationId } from "../../../src/interaction-references";
import type {
    CanonicalBatchInvocationRequest,
    EffectAttempt,
    ItemClaim
} from "../../../src/invocations";
import { ConfirmedOperationFailure, OperationRequestKey } from "../../../src/operations";
import {
    CanonicalBatchHarness,
    canonicalBatchDescriptor,
    canonicalBatchFacet
} from "../canonical-batch-harness";
import { StressGate, StressRandom } from "./stress-support";

const STRESS_TIMEOUT = 90_000;
const CONCURRENT_WORKERS = 12;
const BATCH_ITEMS = 8;
const RECOVERY_RACES = 10;
/** Far past every claim expiry, which the harness sets one second after issue. */
const EXPIRY_HORIZON = 10_000_000;

type Harness = CanonicalBatchHarness<string>;
type Input = { readonly value: number };

function inputsFor(count: number): readonly Input[] {
    return Array.from({ length: count }, (_value, index) => ({ value: index }));
}

function requestFor(
    invocation: InvocationId,
    inputs: readonly Input[],
    execute: (itemIndex: number) => void
): CanonicalBatchInvocationRequest<string> {
    return {
        invocation,
        request: {
            requestKey: new OperationRequestKey(`request:${invocation.value}`),
            facet: canonicalBatchFacet,
            descriptor: canonicalBatchDescriptor,
            cardinality: { kind: "batch", itemCount: inputs.length },
            inputs,
            authorization: "authorization",
            interceptions: inputs.map(() => []),
            execute: async (itemIndex, context) => {
                execute(itemIndex);
                return inputs[context.itemIndex] ?? {};
            }
        }
    };
}

interface ItemLedger {
    readonly claims: readonly ItemClaim<string>[];
    readonly liveClaims: readonly ItemClaim<string>[];
    readonly attempts: readonly EffectAttempt<string, string>[];
    readonly attemptedClaims: readonly string[];
    readonly receipts: number;
}

/** Snapshot of one item's durable claim/attempt/receipt ledger at an observation point. */
function itemLedger(harness: Harness, invocation: InvocationId, itemIndex: number): ItemLedger {
    return harness.transactions.transact((transaction) => {
        const claims = harness.persistence.claimsForItem(transaction, invocation, itemIndex);
        const attemptedClaims = claims
            .filter(
                (claim) => harness.persistence.attemptForClaim(transaction, claim.id) !== undefined
            )
            .map((claim) => claim.id.value);
        return {
            claims,
            liveClaims: claims.filter((claim) => !attemptedClaims.includes(claim.id.value)),
            attempts: harness.persistence.attemptsForItem(transaction, invocation, itemIndex),
            attemptedClaims,
            receipts: harness.persistence.receiptsForItem(transaction, invocation, itemIndex).length
        };
    });
}

/** At-most-one-live-claim is the fencing invariant; assert it at every observation point. */
function expectAtMostOneLiveClaim(ledger: ItemLedger): void {
    expect(ledger.liveClaims.length).toBeLessThanOrEqual(1);
    expect(new Set(ledger.claims.map((claim) => claim.id.value)).size).toBe(ledger.claims.length);
}

describe("invocation at-most-once under racing claims", () => {
    test(
        "collapses a concurrent invoke storm into one claim, attempt, and effect per item",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        async () => {
            const harness: Harness = new CanonicalBatchHarness(false);
            const invocation = new InvocationId("claim-storm-in-flight");
            const inputs = inputsFor(BATCH_ITEMS);
            const executions: number[] = [];
            const order = new StressRandom("claim-storm-in-flight").shuffle(
                Array.from({ length: CONCURRENT_WORKERS }, (_value, index) => index)
            );

            const results = await Promise.all(
                order.map(() =>
                    harness.port.invoke(
                        requestFor(invocation, inputs, (itemIndex) => executions.push(itemIndex))
                    )
                )
            );

            expect(executions.slice().sort((left, right) => left - right)).toEqual(
                inputs.map((_input, index) => index)
            );
            expect(harness.records.createdClaims).toBe(BATCH_ITEMS);
            for (const result of results) {
                expect(result.items).toHaveLength(BATCH_ITEMS);
                expect(result.items.map((item) => item.kind)).toEqual(
                    inputs.map(() => "succeeded")
                );
            }
            for (let itemIndex = 0; itemIndex < BATCH_ITEMS; itemIndex += 1) {
                const ledger = itemLedger(harness, invocation, itemIndex);
                expectAtMostOneLiveClaim(ledger);
                expect(ledger.claims).toHaveLength(1);
                expect(ledger.attempts).toHaveLength(1);
                expect(ledger.attempts[0]?.ordinal).toBe(0);
                expect(ledger.receipts).toBe(1);
            }
        }
    );

    test(
        "recovers an expired claim exactly once while the superseded holder retries into its receipt",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        async () => {
            const harness: Harness = new CanonicalBatchHarness(false);
            const stale = harness.port;
            harness.restartRuntime();
            const recovering = harness.port;
            const inputs = inputsFor(1);
            const executions: string[] = [];
            const random = new StressRandom("claim-recovery-race");

            for (let race = 0; race < RECOVERY_RACES; race += 1) {
                const invocation = new InvocationId(`claim-recovery-${race}`);
                const value = requestFor(invocation, inputs, (itemIndex) =>
                    executions.push(`${invocation.value}:${itemIndex}`)
                );
                const gate = new StressGate();
                let gated = false;
                harness.permits.onIssue = async () => {
                    if (gated) return;
                    gated = true;
                    await gate.wait();
                };

                const superseded = stale.invoke(value);
                await gate.reached;
                const held = itemLedger(harness, invocation, 0);
                expectAtMostOneLiveClaim(held);
                expect(held.liveClaims).toHaveLength(1);
                expect(held.attempts).toEqual([]);

                harness.setTime(EXPIRY_HORIZON * (race + 1) + random.integer(1_000));
                const winner = await recovering.invoke(value);
                expectAtMostOneLiveClaim(itemLedger(harness, invocation, 0));

                gate.release();
                const loser = await superseded;

                expect(winner.items[0]).toMatchObject({ kind: "succeeded", itemIndex: 0 });
                expect(loser.items[0]).toMatchObject({ kind: "succeeded", itemIndex: 0 });
                expect(loser.items[0]?.receipt.id.value).toBe(winner.items[0]?.receipt.id.value);

                const ledger = itemLedger(harness, invocation, 0);
                expectAtMostOneLiveClaim(ledger);
                expect(ledger.claims).toHaveLength(2);
                expect(ledger.claims.map((claim) => claim.attemptOrdinal)).toEqual([0, 0]);
                expect(ledger.attempts).toHaveLength(1);
                expect(ledger.attemptedClaims).toEqual([ledger.claims[1]?.id.value]);
                expect(ledger.receipts).toBe(1);
            }

            expect(executions).toEqual(
                Array.from({ length: RECOVERY_RACES }, (_value, race) => `claim-recovery-${race}:0`)
            );
        }
    );

    test(
        "admits one retry claim and one new effect when workers race a confirmed failure",
        { tags: "p0", timeout: STRESS_TIMEOUT },
        async () => {
            const harness: Harness = new CanonicalBatchHarness(false);
            const invocation = new InvocationId("claim-retry-race");
            const inputs = inputsFor(1);
            let executions = 0;
            const value = requestFor(invocation, inputs, () => {
                executions += 1;
                if (executions === 1) {
                    throw new ConfirmedOperationFailure(
                        "first attempt failed",
                        ContentRef.fromDigest(
                            Digest.sha256(new TextEncoder().encode("first attempt failed"))
                        )
                    );
                }
            });

            const failed = await harness.port.invoke(value);
            expect(failed.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "failed" }
            });
            expectAtMostOneLiveClaim(itemLedger(harness, invocation, 0));

            const retried = await Promise.all(
                Array.from({ length: CONCURRENT_WORKERS }, () => harness.port.invoke(value))
            );

            expect(executions).toBe(2);
            for (const result of retried) {
                expect(result.items[0]).toMatchObject({ kind: "succeeded", itemIndex: 0 });
            }
            const ledger = itemLedger(harness, invocation, 0);
            expectAtMostOneLiveClaim(ledger);
            expect(ledger.claims.map((claim) => claim.attemptOrdinal)).toEqual([0, 1]);
            expect(ledger.attempts.map((attempt) => attempt.ordinal)).toEqual([0, 1]);
            expect(ledger.attemptedClaims).toEqual(ledger.claims.map((claim) => claim.id.value));
            expect(ledger.receipts).toBe(2);
        }
    );
});

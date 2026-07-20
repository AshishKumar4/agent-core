import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TurnId, TurnLease, type LeaseToken } from "../../src/agents";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { LeanOracle } from "./oracle";

/*
 * Differential testing of the Turn-lease algebra (SPEC §5.3) against the verified
 * Lean model. `leaseStepExec` is proven sound and complete for `LeaseStep`, and
 * `admitsBool` is proven equivalent to `Admits`, so any disagreement here is a real
 * semantic divergence between the implementation and the formal model.
 *
 * This slice holds the tenant fixed while comparing the complete tenant-qualified
 * holder with the same PrincipalRef in the Lean model.
 */

const TENANT = 1;
const tenant = new TenantId(`tenant-${TENANT}`);

function principal(id: number): PrincipalRef {
    return new PrincipalRef(tenant, new PrincipalId(`principal-${id}`));
}

interface ModelLease {
    readonly turn: number;
    readonly holder: number | null;
    readonly epoch: number;
    readonly expiresAt: number;
}

function liveLease(model: ModelLease): TurnLease {
    return TurnLease.restore(
        new TurnId(`turn-${model.turn}`),
        model.holder === null ? undefined : principal(model.holder),
        model.epoch,
        new Date(model.expiresAt)
    );
}

function liveToken(model: { turn: number; principal: number; epoch: number }): LeaseToken {
    return {
        turn: new TurnId(`turn-${model.turn}`),
        holder: principal(model.principal),
        epoch: model.epoch
    };
}

function modelLeaseJson(model: ModelLease): Record<string, unknown> {
    return {
        turn: model.turn,
        holder: model.holder === null ? null : { tenant: TENANT, principal: model.holder },
        epoch: model.epoch,
        expiresAt: model.expiresAt
    };
}

function observedLease(lease: TurnLease): ModelLease {
    return {
        turn: Number(lease.turn.value.replace("turn-", "")),
        holder:
            lease.holder === undefined
                ? null
                : Number(lease.holder.principalId.value.replace("principal-", "")),
        epoch: lease.epoch,
        expiresAt: leaseExpiry(lease)
    };
}

function leaseExpiry(lease: TurnLease): number {
    const payload = TurnLease.toData(lease) as { readonly expiresAt: number | null };
    return payload.expiresAt ?? -1;
}

const leaseArbitrary = fc.record({
    turn: fc.integer({ min: 0, max: 2 }),
    holder: fc.oneof(fc.constant<number | null>(null), fc.integer({ min: 0, max: 2 })),
    epoch: fc.integer({ min: 0, max: 3 }),
    // Times stay tiny so boundary collisions (equal expiry, exact-now expiry) are common.
    expiresAt: fc.integer({ min: 1, max: 12 })
});
const tokenArbitrary = fc.record({
    turn: fc.integer({ min: 0, max: 2 }),
    principal: fc.integer({ min: 0, max: 2 }),
    epoch: fc.integer({ min: 0, max: 3 })
});
const timeArbitrary = fc.integer({ min: 0, max: 14 });

let oracle: LeanOracle;
beforeAll(() => {
    oracle = LeanOracle.start();
}, 900_000);
afterAll(() => {
    oracle?.stop();
});

describe("lease algebra agrees with the verified model", () => {
    test("admission agrees on every generated (lease, token, now)", async () => {
        await fc.assert(
            fc.asyncProperty(
                leaseArbitrary,
                tokenArbitrary,
                timeArbitrary,
                async (lease, token, now) => {
                    const implementation = liveLease(lease).admits(liveToken(token), new Date(now));
                    const model = await oracle.ask({
                        op: "lease.admits",
                        lease: modelLeaseJson(lease),
                        token: {
                            turn: token.turn,
                            tenant: TENANT,
                            principal: token.principal,
                            epoch: token.epoch
                        },
                        now
                    });
                    expect(implementation).toBe(model["admits"]);
                }
            ),
            { numRuns: 300 }
        );
    });

    test("claim agrees: admissibility and successor state", async () => {
        await fc.assert(
            fc.asyncProperty(
                leaseArbitrary,
                fc.integer({ min: 0, max: 2 }),
                timeArbitrary,
                fc.integer({ min: 0, max: 14 }),
                async (lease, holder, now, expiresAt) => {
                    await compareStep(
                        lease,
                        { kind: "claim", tenant: TENANT, principal: holder, now, expiresAt },
                        () =>
                            liveLease(lease).claim(
                                principal(holder),
                                new Date(now),
                                new Date(expiresAt)
                            )
                    );
                }
            ),
            { numRuns: 300 }
        );
    });

    test("renew agrees: exact token, unexpired lease, strictly later expiry", async () => {
        await fc.assert(
            fc.asyncProperty(
                leaseArbitrary,
                tokenArbitrary,
                timeArbitrary,
                fc.integer({ min: 0, max: 16 }),
                async (lease, token, now, expiresAt) => {
                    await compareStep(
                        lease,
                        {
                            kind: "renew",
                            token: {
                                turn: token.turn,
                                tenant: TENANT,
                                principal: token.principal,
                                epoch: token.epoch
                            },
                            now,
                            expiresAt
                        },
                        () =>
                            liveLease(lease).renew(
                                principal(token.principal),
                                token.epoch,
                                new Date(now),
                                new Date(expiresAt)
                            ),
                        // The implementation's renew derives the token turn from the
                        // lease itself; restrict to matching turns for comparability.
                        token.turn === lease.turn
                    );
                }
            ),
            { numRuns: 300 }
        );
    });

    test("reclaim agrees: held, expired, future expiry, epoch bump", async () => {
        await fc.assert(
            fc.asyncProperty(
                leaseArbitrary,
                fc.integer({ min: 0, max: 2 }),
                timeArbitrary,
                fc.integer({ min: 0, max: 16 }),
                async (lease, holder, now, expiresAt) => {
                    await compareStep(
                        lease,
                        { kind: "reclaim", tenant: TENANT, principal: holder, now, expiresAt },
                        () =>
                            liveLease(lease).reclaim(
                                principal(holder),
                                new Date(now),
                                new Date(expiresAt)
                            )
                    );
                }
            ),
            { numRuns: 300 }
        );
    });

    test("fence agrees: unconditional clear-and-bump", async () => {
        await fc.assert(
            fc.asyncProperty(leaseArbitrary, async (lease) => {
                await compareStep(lease, { kind: "terminalFence" }, () => liveLease(lease).fence());
            }),
            { numRuns: 120 }
        );
    });
});

async function compareStep(
    lease: ModelLease,
    label: Record<string, unknown>,
    run: () => TurnLease,
    comparable = true
): Promise<void> {
    if (!comparable) return;
    let implementation: ModelLease | undefined;
    try {
        implementation = observedLease(run());
    } catch {
        implementation = undefined;
    }
    const model = await oracle.ask({ op: "lease.step", lease: modelLeaseJson(lease), label });
    if (implementation === undefined) {
        expect(
            model["ok"],
            `model admits a step the implementation rejects: ${JSON.stringify({ lease, label })}`
        ).toBe(false);
        return;
    }
    expect(
        model["ok"],
        `implementation admits a step the model rejects: ${JSON.stringify({ lease, label })}`
    ).toBe(true);
    const after = model["after"] as {
        holder: { principal: number } | null;
        epoch: number;
        expiresAt: number;
    };
    expect(implementation.holder).toBe(after.holder === null ? null : after.holder.principal);
    expect(implementation.epoch).toBe(after.epoch);
    expect(implementation.expiresAt).toBe(after.expiresAt);
}

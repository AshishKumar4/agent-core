import { describe, expect, test } from "vitest";
import { encodeCanonicalJson } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { PrincipalId, PrincipalRef, TenantId } from "../../../src/identity";
import {
    RunBranchId,
    RunCommitId,
    RunId,
    MemoryTurnLeaseVerifier,
    RepositoryTurnLeaseVerifier,
    TurnId,
    TurnInboxEntry,
    TurnInboxEntryId,
    TurnLease,
    type LeaseToken
} from "../../../src/agents/runs";
import { content, digest, seedRunningTurn } from "./fixture";

const turn = new TurnId("turn-lease-test");
const otherTurn = new TurnId("turn-lease-other");
const tenant = new TenantId("tenant-lease-holder");
const otherTenant = new TenantId("tenant-lease-other");
const holderId = new PrincipalId("principal-lease-holder");
const holder = new PrincipalRef(tenant, holderId);
const otherHolder = new PrincipalRef(tenant, new PrincipalId("principal-lease-other"));
const sameIdOtherTenant = new PrincipalRef(otherTenant, holderId);
const at = (milliseconds: number): Date => new Date(milliseconds);

function token(
    tokenTurn: TurnId = turn,
    tokenHolder: PrincipalRef = holder,
    epoch = 1
): LeaseToken {
    return { turn: tokenTurn, holder: tokenHolder, epoch };
}

describe("public Run and Turn values", () => {
    test("keeps the four identifiers nominally distinct", () => {
        const ids = [
            new RunId("run-id"),
            new TurnId("turn-id"),
            new RunBranchId("branch-id"),
            new RunCommitId("commit-id")
        ];

        expect(ids.map((id) => id.value)).toEqual(["run-id", "turn-id", "branch-id", "commit-id"]);
        expect(new RunId("same").equals(new TurnId("same"))).toBe(false);
    });
});

describe("TurnLease", () => {
    test("[turn-lease-verifier] memory and repository implementations enforce the exact durable lease", () => {
        const seeded = seedRunningTurn();
        const verifiers = [
            new MemoryTurnLeaseVerifier([seeded.running.lease], () => at(1_500)),
            new RepositoryTurnLeaseVerifier(seeded.repository, () => at(1_500))
        ];

        for (const verifier of verifiers) {
            expect(verifier.permits(seeded.token)).toBe(true);
            expect(verifier.permits({ ...seeded.token, epoch: seeded.token.epoch + 1 })).toBe(
                false
            );
        }
    });

    test("[C13-ADV-STALE-LEASE] rejects a displaced durable lease after epoch advancement", () => {
        const seeded = seedRunningTurn();
        const replacementHolder = new PrincipalRef(
            tenant,
            new PrincipalId("principal-lease-replacement")
        );
        const cancellationPayload = content("c");
        const reclaimed = seeded.runtime.reclaimTurn(
            seeded.running.id,
            seeded.running.revision,
            replacementHolder,
            at(5_000),
            at(9_000),
            new TurnInboxEntry(
                new TurnInboxEntryId("inbox-stale-lease-cancellation"),
                seeded.running.id,
                0,
                "turn.cancel",
                cancellationPayload,
                digest("c"),
                "stale-lease-cancellation",
                seeded.token,
                at(5_000)
            )
        );
        const verifier = new RepositoryTurnLeaseVerifier(seeded.repository, () => at(6_000));

        expect(verifier.permits(seeded.token)).toBe(false);
        expect(
            verifier.permits({
                turn: reclaimed.id,
                holder: replacementHolder,
                epoch: reclaimed.lease.epoch
            })
        ).toBe(true);
        try {
            seeded.runtime.renewTurn(
                reclaimed.id,
                reclaimed.revision,
                seeded.token,
                at(6_000),
                at(10_000)
            );
            expect.fail("stale lease renewal should fail");
        } catch (error) {
            expect(error).toBeInstanceOf(AgentCoreError);
            expect((error as AgentCoreError).code).toBe("lease.invalid");
        }
    });

    test("admits only the exact live Turn, holder, and epoch", () => {
        const lease = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));

        expect(lease.admits(token(), at(9))).toBe(true);
        expect(lease.admits(token(otherTurn), at(9))).toBe(false);
        expect(lease.admits(token(turn, otherHolder), at(9))).toBe(false);
        expect(lease.admits(token(turn, sameIdOtherTenant), at(9))).toBe(false);
        expect(lease.admits({ turn, holder: holderId, epoch: 1 } as never, at(9))).toBe(false);
        expect(lease.admits(token(turn, holder, 0), at(9))).toBe(false);
        expect(lease.admits(token(), at(10))).toBe(false);
    });

    test("renews only an exact live token with a later expiration", () => {
        const lease = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));
        const renewed = lease.renew(holder, 1, at(2), at(20));

        expect(renewed.epoch).toBe(1);
        expect(renewed.expiresAt).toEqual(at(20));
        expect(() => lease.renew(otherHolder, 1, at(2), at(20))).toThrow(
            new AgentCoreError(
                "lease.invalid",
                "Turn lease renewal requires the exact current token"
            )
        );
        expect(() => lease.renew(holder, 1, at(2), at(10))).toThrow(
            new AgentCoreError("lease.invalid", "Turn lease renewal requires a later expiration")
        );
        expect(() => lease.renew(holder, 0, at(2), at(20))).toThrow(/exact current/);
        expect(() => lease.renew(holder, 1, at(10), at(20))).toThrow(/exact current/);
    });

    test("reclaims only expired held leases and advances the fence", () => {
        const lease = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));
        const reclaimed = lease.reclaim(otherHolder, at(10), at(20));

        expect(reclaimed.epoch).toBe(2);
        expect(reclaimed.admits(token(), at(11))).toBe(false);
        expect(reclaimed.admits(token(turn, otherHolder, 2), at(11))).toBe(true);
        expect(() => lease.reclaim(otherHolder, at(9), at(20))).toThrow(
            new AgentCoreError("lease.invalid", "Turn lease reclaim requires an expired held lease")
        );
        expect(() => TurnLease.unclaimed(turn).reclaim(otherHolder, at(9), at(20))).toThrow(
            /expired held/
        );
    });

    test("fences old tokens and can be claimed again for the same Turn", () => {
        const held = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));
        const fenced = held.fence();
        const resumed = fenced.claim(otherHolder, at(2), at(20));

        expect(fenced.holder).toBeUndefined();
        expect(fenced.epoch).toBe(2);
        expect(fenced.admits(token(), at(2))).toBe(false);
        expect(resumed.turn.equals(turn)).toBe(true);
        expect(resumed.admits(token(turn, otherHolder, 3), at(3))).toBe(true);
    });

    test(
        "[turn-lease] preserves the tenant-qualified holder through the canonical codec",
        { tags: "p0" },
        () => {
            const held = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));
            const decodedHeld = TurnLease.decode(TurnLease.encode(held));
            const decodedFence = TurnLease.decode(TurnLease.encode(held.fence()));

            expect(Object.isFrozen(held)).toBe(true);
            expect(Object.isFrozen(decodedHeld)).toBe(true);
            expect(Object.isFrozen(decodedFence)).toBe(true);
            expect(decodedHeld.turn.equals(turn)).toBe(true);
            expect(decodedHeld.holder?.equals(holder)).toBe(true);
            expect(decodedHeld.admits(token(turn, sameIdOtherTenant), at(9))).toBe(false);
            expect(decodedHeld.expiresAt).toEqual(at(10));
            expect(decodedFence.holder).toBeUndefined();
            expect(decodedFence.epoch).toBe(2);
        }
    );

    test("rejects malformed, future-major, and invalid lease values", { tags: "p2" }, () => {
        const malformed = encodeCanonicalJson({
            kind: "turn-lease",
            version: { major: 2, minor: 0 },
            payload: {
                turn: turn.value,
                holder: { tenant: tenant.value, principal: holderId.value },
                epoch: "1",
                expiresAt: 10
            }
        });
        const unknownMajor = encodeCanonicalJson({
            kind: "turn-lease",
            version: { major: 3, minor: 0 },
            payload: { turn: turn.value, holder: null, epoch: 0, expiresAt: null }
        });
        const unqualifiedLegacyHolder = encodeCanonicalJson({
            kind: "turn-lease",
            version: { major: 1, minor: 0 },
            payload: { turn: turn.value, holder: holderId.value, epoch: 1, expiresAt: 10 }
        });

        expect(() => TurnLease.decode(malformed)).toThrow(
            new AgentCoreError("codec.invalid", "Turn lease payload is malformed")
        );
        expect(() => TurnLease.decode(unknownMajor)).toThrow(
            new AgentCoreError("codec.unknown-major", "Unsupported turn-lease codec major 3")
        );
        expect(() => TurnLease.decode(unqualifiedLegacyHolder)).toThrow(
            new AgentCoreError("codec.unknown-major", "Unsupported turn-lease codec major 1")
        );
        expect(() => TurnLease.restore(turn, holder, 1, undefined)).toThrow(TypeError);
        expect(() => TurnLease.restore(turn, holderId as never, 1, at(10))).toThrow(
            /tenant-qualified PrincipalRef/
        );
        expect(() => TurnLease.unclaimed(turn).claim(holder, at(1), at(1))).toThrow(
            new AgentCoreError(
                "lease.invalid",
                "Turn lease expiration must be after the lease time"
            )
        );
        expect(() => TurnLease.restore(turn, undefined, -1, undefined)).toThrow(TypeError);
        expect(() => TurnLease.restore(turn, undefined, 0, new Date(Number.NaN))).toThrow(
            TypeError
        );
        expect(() => TurnLease.unclaimed(turn).claim(holder, new Date(Number.NaN), at(10))).toThrow(
            /valid Dates/
        );
        const held = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));
        expect(() => held.claim(otherHolder, at(2), at(20))).toThrow(/unheld/);
        expect(() =>
            TurnLease.restore(turn, undefined, Number.MAX_SAFE_INTEGER, undefined).fence()
        ).toThrow(/exhausted/);
    });
});

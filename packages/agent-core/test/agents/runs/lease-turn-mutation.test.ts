import { describe, expect, test } from "vitest";
import { Revision, type JsonValue } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { PrincipalId, PrincipalRef, TenantId } from "../../../src/identity";
import { TurnId } from "../../../src/execution-references";
import { RunCheckpointId, TurnInboxEntryId } from "../../../src/agents/runs/id";
import {
    TurnLease,
    leaseTokenFromData,
    leaseTokenToData,
    type LeaseToken
} from "../../../src/agents/runs/lease";
import {
    MemoryTurnLeaseVerifier,
    RepositoryTurnLeaseVerifier
} from "../../../src/agents/runs/lease-verifier";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import {
    RunCheckpoint,
    Turn,
    TurnInboxEntry,
    TurnStatus,
    type TurnInit
} from "../../../src/agents/runs/turn";
import {
    content,
    digest,
    ids,
    mutableData,
    pins,
    seedRunningTurn,
    thrownBy,
    type MutableRecordData
} from "./fixture";

const turn = new TurnId("turn-mutation");
const tenant = new TenantId("tenant-mutation");
const holder = new PrincipalRef(tenant, new PrincipalId("principal-mutation"));
const otherHolder = new PrincipalRef(tenant, new PrincipalId("principal-mutation-other"));
const at = (milliseconds: number): Date => new Date(milliseconds);

function expectError(
    label: string,
    operation: () => void,
    code: AgentCoreError["code"],
    message: string
): void {
    const failure = thrownBy(AgentCoreError, operation, label);
    expect(failure.code, label).toBe(code);
    expect(failure.message, label).toBe(message);
}

function expectTypeError(label: string, operation: () => void, message: string): void {
    expect(thrownBy(TypeError, operation, label).message, label).toBe(message);
}

function leasePayload(): MutableRecordData {
    return {
        turn: turn.value,
        holder: { principal: "principal-mutation", tenant: "tenant-mutation" },
        epoch: 1,
        expiresAt: 10
    };
}

function queuedTurn(overrides: Partial<TurnInit> = {}): Turn {
    const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
    return new Turn({
        id: ids.turn,
        run: ids.run,
        branch: ids.branch,
        startHead: ids.root,
        effectiveInput: ids.root,
        pins: pins(),
        placement: placement.digest,
        input: content("a"),
        revision: new Revision(0),
        ...overrides
    });
}

describe("TurnLease mutation kills", () => {
    test(
        "admits rejects tokens that differ from the live lease in exactly one field",
        { tags: "p0" },
        () => {
            const lease = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));

            expect(lease.admits({ turn, holder, epoch: 1 }, at(9))).toBe(true);
            expect(lease.admits({ turn, holder, epoch: 2 }, at(9))).toBe(false);
            expect(lease.admits({ turn, holder, epoch: 0 }, at(9))).toBe(false);
            expect(lease.admits({ turn, holder: otherHolder, epoch: 1 }, at(9))).toBe(false);
            expect(
                lease.admits({ turn: new TurnId("turn-mutation-other"), holder, epoch: 1 }, at(9))
            ).toBe(false);
            expect(lease.admits({ turn, holder, epoch: 1 }, at(10))).toBe(false);
        }
    );

    test(
        "renewal requires the exact current token and a strictly later expiration",
        { tags: "p0" },
        () => {
            const lease = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));

            expectError(
                "stale epoch",
                () => lease.renew(holder, 2, at(2), at(20)),
                "lease.invalid",
                "Turn lease renewal requires the exact current token"
            );
            expectError(
                "expired lease",
                () => lease.renew(holder, 1, at(10), at(20)),
                "lease.invalid",
                "Turn lease renewal requires the exact current token"
            );
            expectError(
                "equal expiration",
                () => lease.renew(holder, 1, at(2), at(10)),
                "lease.invalid",
                "Turn lease renewal requires a later expiration"
            );
            const renewed = lease.renew(holder, 1, at(2), at(11));
            expect(renewed.epoch).toBe(1);
            expect(renewed.holder?.equals(holder)).toBe(true);
            expect(renewed.expiresAt?.getTime()).toBe(11);
        }
    );

    test("reclaim requires a held lease that has already expired", { tags: "p0" }, () => {
        const held = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));
        const fencedWithExpiry = held.fence();

        expect(fencedWithExpiry.holder).toBeUndefined();
        expect(fencedWithExpiry.expiresAt?.getTime()).toBe(10);
        expectError(
            "unheld lease with a recorded expiry",
            () => fencedWithExpiry.reclaim(otherHolder, at(10), at(20)),
            "lease.invalid",
            "Turn lease reclaim requires an expired held lease"
        );
        expectError(
            "held lease that is still live",
            () => held.reclaim(otherHolder, at(9), at(20)),
            "lease.invalid",
            "Turn lease reclaim requires an expired held lease"
        );
        const reclaimed = held.reclaim(otherHolder, at(10), at(20));
        expect(reclaimed.epoch).toBe(2);
        expect(reclaimed.holder?.equals(otherHolder)).toBe(true);
        expect(reclaimed.expiresAt?.getTime()).toBe(20);
    });

    test("lease payload decoding rejects every single-field forgery", { tags: "p0" }, () => {
        const rejected: readonly { readonly label: string; readonly payload: unknown }[] = [
            { label: "null payload", payload: null },
            { label: "array payload", payload: [] },
            { label: "string payload", payload: "text" },
            { label: "number payload", payload: 5 },
            { label: "boolean payload", payload: true },
            {
                label: "function payload with the exact keys",
                payload: Object.assign(() => null, leasePayload())
            },
            { label: "extra key", payload: { ...leasePayload(), extra: 1 } },
            {
                label: "missing expiresAt key",
                payload: { turn: turn.value, holder: null, epoch: 1 }
            },
            { label: "non-string turn", payload: { ...leasePayload(), turn: 5 } },
            { label: "numeric holder", payload: { ...leasePayload(), holder: 5 } },
            { label: "array holder", payload: { ...leasePayload(), holder: [] } },
            {
                label: "holder with non-string principal",
                payload: { ...leasePayload(), holder: { principal: 5, tenant: "tenant-mutation" } }
            },
            {
                label: "holder with non-string tenant",
                payload: {
                    ...leasePayload(),
                    holder: { principal: "principal-mutation", tenant: 5 }
                }
            },
            {
                label: "holder with an extra key",
                payload: {
                    ...leasePayload(),
                    holder: { principal: "principal-mutation", tenant: "tenant-mutation", extra: 1 }
                }
            },
            {
                label: "function holder with the exact keys",
                payload: {
                    ...leasePayload(),
                    holder: Object.assign(() => null, {
                        principal: "principal-mutation",
                        tenant: "tenant-mutation"
                    })
                }
            },
            {
                label: "array holder with the exact keys",
                payload: {
                    ...leasePayload(),
                    holder: Object.assign([], {
                        principal: "principal-mutation",
                        tenant: "tenant-mutation"
                    })
                }
            },
            { label: "string epoch", payload: { ...leasePayload(), epoch: "1" } },
            { label: "negative epoch", payload: { ...leasePayload(), epoch: -1 } },
            { label: "fractional epoch", payload: { ...leasePayload(), epoch: 1.5 } },
            { label: "string expiresAt", payload: { ...leasePayload(), expiresAt: "10" } },
            { label: "boolean expiresAt", payload: { ...leasePayload(), expiresAt: true } }
        ];
        for (const { label, payload } of rejected) {
            // SAFETY: fromData declares JsonValue, and this list deliberately steps outside it —
            // a function and an array carrying the exact holder keys are values no JSON parser
            // can produce. fromData reads decoded bytes at a trust boundary, so the list is
            // only exhaustive if it includes them.
            expectError(
                label,
                () => TurnLease.fromData(payload as never),
                "codec.invalid",
                "Turn lease payload is malformed"
            );
        }

        const unheld = TurnLease.fromData({
            turn: turn.value,
            holder: null,
            epoch: 0,
            expiresAt: null
        });
        expect(unheld.holder).toBeUndefined();
        expect(unheld.epoch).toBe(0);
        expect(unheld.expiresAt).toBeUndefined();
        const held = TurnLease.fromData(leasePayload());
        expect(held.turn.equals(turn)).toBe(true);
        expect(held.holder?.equals(holder)).toBe(true);
        expect(held.epoch).toBe(1);
        expect(held.expiresAt?.getTime()).toBe(10);
    });

    test(
        "lease token encoding rejects malformed tokens and preserves epoch zero",
        { tags: "p0" },
        () => {
            // SAFETY: LeaseToken types `turn` as TurnId and `holder` as PrincipalRef, so a bare
            // string is unreachable through the token. Forging one proves the encoder checks each
            // member's class rather than encoding whatever value it is handed.
            expectError(
                "non-TurnId turn",
                () => leaseTokenToData({ turn: "turn-mutation", holder, epoch: 1 } as never),
                "codec.invalid",
                "Lease token is malformed"
            );
            // SAFETY: as above, for the holder member.
            expectError(
                "non-PrincipalRef holder",
                () => leaseTokenToData({ turn, holder: "principal-mutation", epoch: 1 } as never),
                "codec.invalid",
                "Lease token is malformed"
            );
            expectError(
                "negative epoch",
                () => leaseTokenToData({ turn, holder, epoch: -1 }),
                "codec.invalid",
                "Lease token is malformed"
            );
            expectError(
                "fractional epoch",
                () => leaseTokenToData({ turn, holder, epoch: 1.5 }),
                "codec.invalid",
                "Lease token is malformed"
            );
            expect(leaseTokenToData({ turn, holder, epoch: 0 })).toEqual({
                epoch: 0,
                holder: { principal: "principal-mutation", tenant: "tenant-mutation" },
                turn: "turn-mutation"
            });
        }
    );

    test(
        "lease token decoding enforces shape, exact fields, and field types",
        { tags: "p0" },
        () => {
            for (const value of [null, [], "text", 5]) {
                expectError(
                    `non-object ${JSON.stringify(value)}`,
                    () => leaseTokenFromData(value),
                    "codec.invalid",
                    "Lease token must be an object"
                );
            }
            expectError(
                "missing turn field",
                () => leaseTokenFromData({ epoch: 1, holder: null }),
                "codec.invalid",
                "Lease token fields are invalid"
            );
            expectError(
                "extra field",
                () =>
                    leaseTokenFromData({ epoch: 1, holder: null, turn: "turn-mutation", extra: 1 }),
                "codec.invalid",
                "Lease token fields are invalid"
            );
            const validHolder = { principal: "principal-mutation", tenant: "tenant-mutation" };
            expectError(
                "non-string turn",
                () => leaseTokenFromData({ epoch: 1, holder: validHolder, turn: 5 }),
                "codec.invalid",
                "Lease token is malformed"
            );
            expectError(
                "string epoch",
                () =>
                    leaseTokenFromData({ epoch: "1", holder: validHolder, turn: "turn-mutation" }),
                "codec.invalid",
                "Lease token is malformed"
            );
            expectError(
                "negative epoch",
                () => leaseTokenFromData({ epoch: -1, holder: validHolder, turn: "turn-mutation" }),
                "codec.invalid",
                "Lease token is malformed"
            );
            expectError(
                "fractional epoch",
                () =>
                    leaseTokenFromData({ epoch: 1.5, holder: validHolder, turn: "turn-mutation" }),
                "codec.invalid",
                "Lease token is malformed"
            );
            expectError(
                "numeric holder",
                () => leaseTokenFromData({ epoch: 1, holder: 5, turn: "turn-mutation" }),
                "codec.invalid",
                "Lease holder is malformed"
            );
            expectError(
                "holder with non-string principal",
                () =>
                    leaseTokenFromData({
                        epoch: 1,
                        holder: { principal: 5, tenant: "tenant-mutation" },
                        turn: "turn-mutation"
                    }),
                "codec.invalid",
                "Lease holder is malformed"
            );
            const token = leaseTokenFromData({
                epoch: 0,
                holder: validHolder,
                turn: "turn-mutation"
            });
            expect(token.epoch).toBe(0);
            expect(token.turn.equals(turn)).toBe(true);
            expect(token.holder.equals(holder)).toBe(true);
        }
    );

    test("lease time and epoch guards carry exact messages", { tags: "p2" }, () => {
        expectError(
            "NaN lease time",
            () => TurnLease.unclaimed(turn).claim(holder, new Date(Number.NaN), at(10)),
            "lease.invalid",
            "Turn lease times must be valid Dates"
        );
        expectError(
            "exhausted epoch",
            () => TurnLease.restore(turn, undefined, Number.MAX_SAFE_INTEGER, undefined).fence(),
            "lease.invalid",
            "Turn lease epoch is exhausted"
        );
    });
});

describe("Turn lease verifiers mutation kills", () => {
    test(
        "memory verifier defaults are safe and enforce the stored lease clock",
        { tags: "p0" },
        () => {
            const emptyVerifier = new MemoryTurnLeaseVerifier();
            expect(emptyVerifier.permits({ turn, holder, epoch: 1 })).toBe(false);

            const lease = TurnLease.unclaimed(turn).claim(holder, at(1), at(10));
            const wallClockVerifier = new MemoryTurnLeaseVerifier([lease]);
            expect(wallClockVerifier.permits({ turn, holder, epoch: 1 })).toBe(false);

            const pinnedVerifier = new MemoryTurnLeaseVerifier([lease], () => at(5));
            expect(pinnedVerifier.permits({ turn, holder, epoch: 1 })).toBe(true);
            expect(pinnedVerifier.permits({ turn, holder, epoch: 2 })).toBe(false);
        }
    );

    test(
        "repository verifier defaults are safe for missing and expired leases",
        { tags: "p0" },
        () => {
            const seeded = seedRunningTurn();
            const verifier = new RepositoryTurnLeaseVerifier(seeded.repository);

            expect(verifier.permits(seeded.token)).toBe(false);
            expect(
                verifier.permits({ turn: new TurnId("turn-mutation-missing"), holder, epoch: 1 })
            ).toBe(false);

            const pinned = new RepositoryTurnLeaseVerifier(seeded.repository, () => at(1_500));
            expect(pinned.permits(seeded.token)).toBe(true);
        }
    );
});

describe("Turn mutation kills", () => {
    // The lowered table refuses the move; the Turn that raises turn.invalid-state carries the
    // message, and test/agents/runs/turn-exhaustive.test.ts asserts that wording end to end.
    test("turn status transitions refuse every illegal move", { tags: "p2" }, () => {
        expect(TurnStatus.queued.suspend().kind).toBe("none");
        expect(TurnStatus.queued.completes()).toBe(false);
        expect(TurnStatus.running.cancelUnheld().kind).toBe("none");
    });

    test("TurnStatus.from maps every kind onto its singleton", { tags: "p1" }, () => {
        for (const kind of [
            "queued",
            "running",
            "suspended",
            "succeeded",
            "failed",
            "cancelled"
        ] as const) {
            expect(TurnStatus.from(kind).kind, kind).toBe(kind);
        }
    });

    test("queued turns require an unheld epoch-zero lease without expiry", { tags: "p0" }, () => {
        expectTypeError(
            "queued with nonzero epoch",
            () => queuedTurn({ lease: TurnLease.restore(ids.turn, undefined, 1, undefined) }),
            "Queued Turns require an unheld epoch-zero lease"
        );
        expectTypeError(
            "queued with recorded expiry",
            () => queuedTurn({ lease: TurnLease.restore(ids.turn, undefined, 0, at(10)) }),
            "Queued Turns require an unheld epoch-zero lease"
        );
    });

    test("suspended and every terminal status must be unheld", { tags: "p0" }, () => {
        const heldLease = () => TurnLease.restore(ids.turn, ids.holder, 1, at(10));
        expectTypeError(
            "suspended held",
            () =>
                queuedTurn({
                    status: TurnStatus.suspended,
                    lease: heldLease(),
                    checkpoint: new RunCheckpointId("checkpoint-mutation")
                }),
            "Suspended and terminal Turns must be unheld"
        );
        expectTypeError(
            "succeeded held",
            () =>
                queuedTurn({
                    status: TurnStatus.succeeded,
                    lease: heldLease(),
                    result: content("b")
                }),
            "Suspended and terminal Turns must be unheld"
        );
        expectTypeError(
            "failed held",
            () =>
                queuedTurn({ status: TurnStatus.failed, lease: heldLease(), result: content("b") }),
            "Suspended and terminal Turns must be unheld"
        );
        expectTypeError(
            "cancelled held",
            () => queuedTurn({ status: TurnStatus.cancelled, lease: heldLease() }),
            "Suspended and terminal Turns must be unheld"
        );
        expectTypeError(
            "succeeded without result",
            () =>
                queuedTurn({
                    status: TurnStatus.succeeded,
                    lease: TurnLease.restore(ids.turn, undefined, 2, at(10))
                }),
            "Succeeded and failed Turns require a result"
        );
    });

    test(
        "turn lifecycle transitions produce the exact lease and revision post-state",
        { tags: "p0" },
        () => {
            const token: LeaseToken = { turn: ids.turn, holder: ids.holder, epoch: 1 };
            const running = queuedTurn().claim(ids.holder, at(1), at(10));
            expect(running.status.kind).toBe("running");
            expect(running.lease.epoch).toBe(1);
            expect(running.lease.holder?.equals(ids.holder)).toBe(true);
            expect(running.lease.expiresAt?.getTime()).toBe(10);
            expect(running.revision.value).toBe(1);

            const renewed = running.renew(token, at(2), at(20));
            expect(renewed.status.kind).toBe("running");
            expect(renewed.lease.epoch).toBe(1);
            expect(renewed.lease.holder?.equals(ids.holder)).toBe(true);
            expect(renewed.lease.expiresAt?.getTime()).toBe(20);
            expect(renewed.revision.value).toBe(2);

            const suspended = running.suspend(
                token,
                new RunCheckpointId("checkpoint-mutation"),
                at(2)
            );
            expect(suspended.status.kind).toBe("suspended");
            expect(suspended.lease.holder).toBeUndefined();
            expect(suspended.lease.epoch).toBe(2);
            expect(suspended.checkpoint?.value).toBe("checkpoint-mutation");
            expect(suspended.revision.value).toBe(2);

            const completed = running.complete(token, "succeeded", content("b"), at(2));
            expect(completed.status.kind).toBe("succeeded");
            expect(completed.lease.holder).toBeUndefined();
            expect(completed.lease.epoch).toBe(2);
            expect(completed.result?.value).toBe(content("b").value);

            const forced = running.forceCancel();
            expect(forced.status.kind).toBe("cancelled");
            expect(forced.lease.holder).toBeUndefined();
            expect(forced.lease.epoch).toBe(2);
            expect(forced.revision.value).toBe(2);
            expect(completed.forceCancel()).toBe(completed);

            const cancelled = queuedTurn().cancelUnheld();
            expect(cancelled.status.kind).toBe("cancelled");
            expect(cancelled.lease.epoch).toBe(1);
            expect(cancelled.revision.value).toBe(1);
        }
    );

    test("turn mutations demand the exact current lease token", { tags: "p0" }, () => {
        const token: LeaseToken = { turn: ids.turn, holder: ids.holder, epoch: 1 };
        const running = queuedTurn().claim(ids.holder, at(1), at(10));
        expectError(
            "stale epoch",
            () => running.requireToken({ ...token, epoch: 2 }, at(2)),
            "lease.invalid",
            "Turn mutation requires the exact current lease token"
        );
        expectError(
            "expired token",
            () => running.requireToken(token, at(10)),
            "lease.invalid",
            "Turn mutation requires the exact current lease token"
        );
        expectError(
            "suspend with a stale token",
            () =>
                running.suspend(
                    { ...token, epoch: 2 },
                    new RunCheckpointId("checkpoint-stale"),
                    at(2)
                ),
            "lease.invalid",
            "Turn mutation requires the exact current lease token"
        );
        expectError(
            "renew outside running",
            () => queuedTurn().renew(token, at(2), at(20)),
            "turn.invalid-state",
            "Only running Turns can renew"
        );
        expectError(
            "reclaim outside running",
            () => queuedTurn().reclaim(ids.holder, at(2), at(20)),
            "turn.invalid-state",
            "Only running Turns can be reclaimed"
        );
    });

    test("turn revision exhaustion is fatal with the exact message", { tags: "p1" }, () => {
        expectError(
            "revision exhaustion",
            () => queuedTurn({ revision: new Revision(Number.MAX_SAFE_INTEGER) }).revise(),
            "turn.invalid-state",
            "Turn revision is exhausted"
        );
    });

    test(
        "record codecs reject unknown sentinel fields in every strict shape",
        { tags: "p1" },
        () => {
            const turnData = mutableData(queuedTurn().toData());
            turnData["Stryker was here"] = 1;
            expectTypeError(
                "Turn sentinel field",
                () => Turn.fromData(turnData),
                "Turn contains missing or unknown fields"
            );

            const lineageData = mutableData(queuedTurn().toData());
            lineageData["cacheLineage"] = {
                turn: "turn-cache",
                promptPrefix: digest("f").value,
                "Stryker was here": 1
            };
            expectTypeError(
                "cache lineage sentinel field",
                () => Turn.fromData(lineageData),
                "Turn cache lineage contains missing or unknown fields"
            );

            const checkpointData = mutableData(
                new RunCheckpoint(
                    new RunCheckpointId("checkpoint-mutation"),
                    ids.turn,
                    ids.root,
                    content("c"),
                    0,
                    undefined
                ).toData()
            );
            checkpointData["Stryker was here"] = 1;
            expectTypeError(
                "checkpoint sentinel field",
                () => RunCheckpoint.fromData(checkpointData),
                "Run checkpoint contains missing or unknown fields"
            );

            const inboxData = mutableData(
                new TurnInboxEntry(
                    new TurnInboxEntryId("inbox-mutation"),
                    ids.turn,
                    0,
                    "message",
                    content("e"),
                    digest("e"),
                    "key",
                    undefined,
                    at(1)
                ).toData()
            );
            inboxData["Stryker was here"] = 1;
            expectTypeError(
                "inbox sentinel field",
                () => TurnInboxEntry.fromData(inboxData),
                "Turn inbox entry contains missing or unknown fields"
            );
        }
    );

    test("turn record decoding names each malformed field exactly", { tags: "p2" }, () => {
        const cases: readonly {
            readonly label: string;
            readonly field: string;
            readonly value: JsonValue;
            readonly message: string;
        }[] = [
            { label: "id", field: "id", value: 5, message: "Turn ID must be a non-empty string" },
            {
                label: "run",
                field: "run",
                value: 5,
                message: "Turn Run must be a non-empty string"
            },
            {
                label: "branch",
                field: "branch",
                value: 5,
                message: "Turn branch must be a non-empty string"
            },
            {
                label: "startHead",
                field: "startHead",
                value: 5,
                message: "Turn start head must be a non-empty string"
            },
            {
                label: "effectiveInput",
                field: "effectiveInput",
                value: 5,
                message: "Turn effective input must be a non-empty string"
            },
            {
                label: "placement",
                field: "placement",
                value: 5,
                message: "Turn placement must be a non-empty string"
            },
            {
                label: "input",
                field: "input",
                value: 5,
                message: "Turn input must be a non-empty string"
            },
            {
                label: "revision",
                field: "revision",
                value: "x",
                message: "Turn revision must be a non-negative safe integer"
            },
            {
                label: "cache lineage turn",
                field: "cacheLineage",
                value: { turn: 5, promptPrefix: digest("f").value },
                message: "Cache lineage Turn must be a non-empty string"
            },
            {
                label: "cache lineage prompt prefix",
                field: "cacheLineage",
                value: { turn: "turn-cache", promptPrefix: 5 },
                message: "Cache lineage prompt prefix must be a non-empty string"
            }
        ];
        for (const { label, field, value, message } of cases) {
            const data = mutableData(queuedTurn().toData());
            data[field] = value;
            expectTypeError(label, () => Turn.fromData(data), message);
        }
    });

    test("checkpoint record decoding names each malformed field exactly", { tags: "p2" }, () => {
        const base = () =>
            mutableData(
                new RunCheckpoint(
                    new RunCheckpointId("checkpoint-mutation"),
                    ids.turn,
                    ids.root,
                    content("c"),
                    0,
                    undefined
                ).toData()
            );
        const cases: readonly {
            readonly field: string;
            readonly message: string;
        }[] = [
            { field: "id", message: "Checkpoint ID must be a non-empty string" },
            { field: "turn", message: "Checkpoint Turn must be a non-empty string" },
            { field: "commit", message: "Checkpoint commit must be a non-empty string" },
            { field: "state", message: "Checkpoint state must be a non-empty string" }
        ];
        for (const { field, message } of cases) {
            const data = base();
            data[field] = 5;
            expectTypeError(field, () => RunCheckpoint.fromData(data), message);
        }
    });
});

describe("TurnInboxEntry mutation kills", () => {
    function entry(
        event: string,
        idempotencyKey: string,
        cancellationToken: LeaseToken | undefined
    ): TurnInboxEntry {
        return new TurnInboxEntry(
            new TurnInboxEntryId("inbox-mutation"),
            ids.turn,
            0,
            event,
            content("e"),
            digest("e"),
            idempotencyKey,
            cancellationToken,
            at(1)
        );
    }

    test(
        "inbox entries require an event, a key, and an exact cancellation token",
        { tags: "p0" },
        () => {
            expectTypeError(
                "empty event",
                () => entry("", "key", undefined),
                "Inbox event and key are required"
            );
            expectTypeError(
                "empty idempotency key",
                () => entry("message", "", undefined),
                "Inbox event and key are required"
            );
            // SAFETY: the inbox cancellation token types `turn` as TurnId and `holder` as
            // PrincipalRef. Forging each member proves the entry checks the token's classes, not
            // only that the token names the right Turn and a valid epoch.
            expectTypeError(
                "token turn is not a TurnId",
                () =>
                    entry("turn.cancel", "key", {
                        turn: "turn-1",
                        holder: ids.holder,
                        epoch: 1
                    } as never),
                "Inbox cancellation token must name the exact Turn and valid epoch"
            );
            // SAFETY: as above, for the holder member.
            expectTypeError(
                "token holder is not a PrincipalRef",
                () =>
                    entry("turn.cancel", "key", {
                        turn: ids.turn,
                        holder: "who",
                        epoch: 1
                    } as never),
                "Inbox cancellation token must name the exact Turn and valid epoch"
            );
            expectTypeError(
                "token names another Turn",
                () =>
                    entry("turn.cancel", "key", {
                        turn: new TurnId("turn-mutation-other"),
                        holder: ids.holder,
                        epoch: 1
                    }),
                "Inbox cancellation token must name the exact Turn and valid epoch"
            );
            expectTypeError(
                "negative token epoch",
                () =>
                    entry("turn.cancel", "key", { turn: ids.turn, holder: ids.holder, epoch: -1 }),
                "Inbox cancellation token must name the exact Turn and valid epoch"
            );

            const epochZero = entry("turn.cancel", "key", {
                turn: ids.turn,
                holder: ids.holder,
                epoch: 0
            });
            expect(epochZero.cancellationToken?.epoch).toBe(0);
            expect(
                TurnInboxEntry.decode(TurnInboxEntry.encode(epochZero)).cancellationToken?.epoch
            ).toBe(0);
        }
    );

    test("inbox record decoding names each malformed field exactly", { tags: "p2" }, () => {
        const base = () => mutableData(entry("message", "key", undefined).toData());
        const cases: readonly { readonly field: string; readonly message: string }[] = [
            { field: "id", message: "Inbox entry ID must be a non-empty string" },
            { field: "turn", message: "Inbox Turn must be a non-empty string" },
            { field: "event", message: "Inbox event must be a non-empty string" },
            { field: "payload", message: "Inbox payload must be a non-empty string" },
            { field: "payloadDigest", message: "Inbox payload digest must be a non-empty string" },
            { field: "idempotencyKey", message: "Inbox idempotency key must be a non-empty string" }
        ];
        for (const { field, message } of cases) {
            const data = base();
            data[field] = 5;
            expectTypeError(field, () => TurnInboxEntry.fromData(data), message);
        }
        const tokenData = base();
        tokenData["cancellationToken"] = 5;
        expectError(
            "numeric cancellation token",
            () => TurnInboxEntry.fromData(tokenData),
            "codec.invalid",
            "Cancellation token must be an object"
        );
    });
});

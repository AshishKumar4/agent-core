import { describe, expect, it } from "vitest";
import { jsonDataParser, type JsonValue } from "@agent-core/core";
import { PLATFORM_ALARM_RETRY_LIMIT } from "../../src/alarm-invocation.js";
import {
    abortInstance,
    call,
    decodeLiveAlarmState,
    decodeLiveOutboxState,
    events,
    poll,
    resultOf,
    sleep,
    type LiveAlarmState,
    type LiveOutboxState
} from "./harness";

/**
 * The one clause of SPEC §10.4 C13-CLOUDFLARE-ALARM-DURABILITY that the rest of the live
 * lane cannot reach: durability MUST NOT rest on the platform's re-firing, so an object
 * whose retries were exhausted re-arms from its outbox the moment it is next
 * instantiated, with no external timer, cron, or keepalive touching the alarm.
 *
 * Why it is its own file rather than a case in phase-1.test.ts: the archived run in
 * artifacts/conformance/live-evidence fingerprints test/live/phase-1..4.test.ts, the
 * live harness worker, and test/live/harness.ts, and twelve `verified` rows rest on that
 * archive. Editing any of those files stales it, and scripts/quality/live-substrate-evidence.mjs
 * refuses a stale archive while any live row is verified. This file is new, so the
 * archive does not fingerprint it, and the scenario is therefore written and unexecuted
 * rather than either staling the archive or claiming evidence nobody took. It uses only
 * operations the deployed harness already serves, for the same reason.
 * scripts/live-evidence.mjs runs every `test/live/phase-1*` file into phase 1's report,
 * so the next consented run executes and archives this scenario with no further change.
 */
const INSTANCE = "alarm-exhaust";
/** The outbox entry the platform is made to abandon. */
const ENTRY = "abandoned";

/**
 * How long every alarm delivery throws for. Cloudflare re-fires a throwing handler with
 * exponential backoff from a two-second delay, for PLATFORM_ALARM_RETRY_LIMIT retries,
 * and then stops — 2+4+8+16+32+64 ms-scaled to seconds is a 126-second budget from the
 * first delivery. The window has to outlast the whole budget: a retry that lands after
 * the window closes would succeed, and the recovery under test would then be the
 * platform's re-firing rather than the object's own rebuild.
 */
const THROW_WINDOW_MS = 150_000;
/**
 * When the scenario next touches the object. Strictly after the window closes, so the
 * delivery that follows cannot be a throw, and far enough past the last retry that a
 * platform still re-firing would have shown one more delivery by now.
 */
const SILENCE_MS = 165_000;
/** Near enough that the entry is due while every delivery still throws. */
const ARM_DELAY_MS = 2_000;
/** Far enough out that the throwing claim never competes for the physical alarm slot. */
const THROWING_CLAIM_DELAY_MS = 3_600_000;

const probeData = jsonDataParser((message) => new TypeError(message));

interface EnqueueResult extends LiveOutboxState {
    readonly scheduledAt: number;
}

interface ThrowingResult extends LiveAlarmState {
    readonly dueAt: number;
    readonly until: number;
}

function decodeEnqueueResult(value: JsonValue): EnqueueResult {
    const result = probeData.object(value, "Live enqueue result");
    return {
        ...decodeLiveOutboxState(value),
        scheduledAt: probeData.safeInteger(result["scheduledAt"], "Live enqueue schedule")
    };
}

function decodeThrowingResult(value: JsonValue): ThrowingResult {
    const result = probeData.object(value, "Live throwing alarm result");
    return {
        ...decodeLiveAlarmState(value),
        dueAt: probeData.safeInteger(result["dueAt"], "Live claim due time"),
        until: probeData.safeInteger(result["until"], "Live throwing alarm deadline")
    };
}

describe("live Cloudflare alarm-abandonment evidence", () => {
    it(
        "[C13-CLOUDFLARE-ALARM-DURABILITY] rebuilds an alarm the platform stopped re-firing from the outbox at the next start",
        // The scenario waits out the platform's whole re-firing budget before it may
        // observe anything, so it declares a budget of its own rather than borrowing the
        // suite default.
        { timeout: 300_000 },
        async () => {
            // The throw window is armed first, and its claim is parked an hour out: the
            // control row has to be durable before any delivery can read it, and the
            // schedule under test has to be the outbox's rather than this claim's.
            const throwing = resultOf(
                await call(
                    "runtime",
                    INSTANCE,
                    "arm-throwing",
                    { delayMs: THROWING_CLAIM_DELAY_MS, throwForMs: THROW_WINDOW_MS },
                    decodeThrowingResult
                )
            );
            expect(throwing.physicalAlarm).toBe(throwing.dueAt);

            const enqueued = resultOf(
                await call(
                    "runtime",
                    INSTANCE,
                    "enqueue",
                    { id: ENTRY, delayMs: ARM_DELAY_MS },
                    decodeEnqueueResult
                )
            );
            expect(enqueued.entries).toEqual([{ id: ENTRY, scheduledAt: enqueued.scheduledAt }]);
            // The outbox entry owns the slot now: the reconciler's claim is the earliest.
            expect(enqueued.physicalAlarm).toBe(enqueued.scheduledAt);
            expect(enqueued.scheduledAt).toBeLessThan(throwing.until);

            // Nothing addresses the object across this window. Every delivery inside it
            // throws, so the entry is never acknowledged, and any request would risk
            // re-arming the schedule through startup repair and resetting the platform's
            // retry budget — which is precisely the recovery the scenario must exclude.
            await sleep(SILENCE_MS);

            const abandoned = await events(INSTANCE);
            const threw = abandoned.filter((event) => event.kind === "alarm.threw");
            const firstThrow = threw[0];
            const finalThrow = threw.at(-1);
            expect(firstThrow).toBeDefined();
            expect(finalThrow).toBeDefined();
            // The platform delivered the schedule once and re-fired it exactly
            // PLATFORM_ALARM_RETRY_LIMIT times. A different count is a real finding about
            // the deployed platform rather than a flake: src/alarm-invocation.ts derives
            // `retriable` from this constant, so a handler would be told it still had
            // retries when it did not. Record it; do not widen this assertion.
            expect(threw).toHaveLength(PLATFORM_ALARM_RETRY_LIMIT + 1);
            // Every delivery landed while the window was still open, so the re-firing
            // stopped because the platform's budget ran out and not because the handler
            // started succeeding.
            expect(finalThrow?.at ?? 0).toBeLessThan(throwing.until);
            // The backoff is real: the last re-fire is roughly two minutes after the
            // first delivery, which no fixed-interval retry could produce inside six.
            expect((finalThrow?.at ?? 0) - (firstThrow?.at ?? 0)).toBeGreaterThan(100_000);
            // No sweep ever reached the entry while the platform was re-firing: the
            // handler throws before the reconciler runs, which is what leaves the entry
            // unacknowledged for the rebuild to find.
            expect(
                abandoned.filter(
                    (event) => event.subject === ENTRY && event.kind.startsWith("reconcile.")
                )
            ).toEqual([]);

            // The next instantiation is forced rather than waited for: an object the
            // platform has abandoned is only constructed again when something addresses
            // it, and a resident instance would run no startup repair at all.
            await abortInstance("runtime", INSTANCE);

            // From here the only writer of the physical alarm is the object's own startup
            // repair. `outbox` and `events` read; `arm-throwing` and `enqueue` are not
            // called again; nothing outside the object holds a timer. So a delivery after
            // the window can only follow an alarm the rebuild armed.
            const settled = await poll(
                "drained outbox on alarm-exhaust",
                async () => {
                    const state = resultOf(
                        await call("runtime", INSTANCE, "outbox", {}, decodeLiveOutboxState)
                    );
                    return state.entries.length === 0 ? state : undefined;
                },
                90_000
            );
            expect(settled.nextDueAt).toBeNull();
            // The claim table survived the abandonment: releasing the reconciler's claim
            // left the parked one armed, and the slot fell back to it.
            expect(settled.claims).toEqual([{ owner: "probe.throwing", dueAt: throwing.dueAt }]);
            expect(settled.physicalAlarm).toBe(throwing.dueAt);

            const recovered = await events(INSTANCE);
            const rebuilt = recovered.find(
                (event) =>
                    event.kind === "alarm.fired" &&
                    event.ordinal > (finalThrow?.ordinal ?? 0) &&
                    event.at >= throwing.until
            );
            // A delivery after the throw window, on a schedule whose retries were spent
            // before that window closed: the rebuild is the only thing that can have
            // armed it.
            expect(rebuilt).toBeDefined();
            const finished = recovered.find(
                (event) => event.kind === "reconcile.finished" && event.subject === ENTRY
            );
            expect(finished).toBeDefined();
            expect(finished?.ordinal ?? 0).toBeGreaterThan(rebuilt?.ordinal ?? 0);
        }
    );
});

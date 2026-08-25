import {
    AlarmInvocation,
    PLATFORM_ALARM_RETRY_LIMIT,
    type CloudflareAlarmInvocationInfoLike
} from "../src/alarm-invocation.js";
import { malformedInput } from "./assertions.js";

/**
 * The platform hands an alarm handler whatever its runtime produced, so the values under
 * test are the ones the declared shape forbids and a live handler can still receive.
 */
function malformedInfo<Value>(value: Value): CloudflareAlarmInvocationInfoLike {
    return malformedInput<CloudflareAlarmInvocationInfoLike, Value>(value);
}

describe("AlarmInvocation", () => {
    test("reads a first delivery as untried and still retriable", { tags: "p0" }, () => {
        expect(AlarmInvocation.first.retryCount).toBe(0);
        expect(AlarmInvocation.first.isRetry).toBe(false);
        expect(AlarmInvocation.first.retriable).toBe(true);
    });

    /**
     * A handler that read a malformed `alarmInfo` as a late retry would skip work on a
     * first delivery, and one that read it as a spent budget would re-arm needlessly. The
     * first delivery is the reading that asserts neither.
     */
    test("reads an absent or malformed alarmInfo as a first delivery", { tags: "p0" }, () => {
        const malformed = [
            AlarmInvocation.from(undefined),
            AlarmInvocation.from(malformedInfo(null)),
            AlarmInvocation.from(malformedInfo(3)),
            AlarmInvocation.from(malformedInfo("retry")),
            AlarmInvocation.from(malformedInfo(true)),
            AlarmInvocation.from({})
        ];

        for (const invocation of malformed) {
            expect(invocation.equals(AlarmInvocation.first)).toBe(true);
        }
    });

    test("reads a reported first delivery as the first delivery", { tags: "p1" }, () => {
        expect(
            AlarmInvocation.from({ retryCount: 0, isRetry: false }).equals(AlarmInvocation.first)
        ).toBe(true);
    });

    /**
     * The platform can report a retry whose count is still zero. Folding that into the
     * first delivery would erase the only signal that the handler already ran once.
     */
    test(
        "keeps a reported retry at count zero distinct from the first delivery",
        { tags: "p0" },
        () => {
            const reported = AlarmInvocation.from({ retryCount: 0, isRetry: true });

            expect(reported.equals(AlarmInvocation.first)).toBe(false);
            expect(reported.retryCount).toBe(0);
            expect(reported.isRetry).toBe(true);
        }
    );

    test("infers the retry flag from a reported count", { tags: "p1" }, () => {
        const inferred = AlarmInvocation.from({ retryCount: 3 });

        expect(inferred.retryCount).toBe(3);
        expect(inferred.isRetry).toBe(true);
    });

    test("keeps a reported flag over the inferred one", { tags: "p2" }, () => {
        expect(AlarmInvocation.from({ retryCount: 2, isRetry: false }).isRetry).toBe(false);
    });

    /**
     * A count the platform could not have produced is not a retry budget, so it reads as
     * a first delivery rather than as a number the handler goes on to compare.
     */
    test("refuses a count no delivery could carry", { tags: "p1" }, () => {
        const refused = [
            AlarmInvocation.from({ retryCount: -1 }),
            AlarmInvocation.from({ retryCount: 1.5 }),
            AlarmInvocation.from({ retryCount: Number.NaN }),
            AlarmInvocation.from({ retryCount: Number.POSITIVE_INFINITY }),
            AlarmInvocation.from({ retryCount: malformedInput<number, string>("3") }),
            AlarmInvocation.from({ retryCount: malformedInput<number, null>(null) })
        ];

        for (const invocation of refused) {
            expect(invocation.equals(AlarmInvocation.first)).toBe(true);
        }
    });

    /**
     * The platform stops re-firing after its retry limit, and that is the moment the
     * handler's own re-arm becomes the only remaining recovery. An off-by-one here loses
     * the schedule outright, so the boundary is asserted at the limit itself.
     */
    test("reports retries left only below the platform limit", { tags: "p0" }, () => {
        expect(AlarmInvocation.from({ retryCount: 5 }).retriable).toBe(true);
        expect(AlarmInvocation.from({ retryCount: 6 }).retriable).toBe(false);
        expect(AlarmInvocation.from({ retryCount: 7 }).retriable).toBe(false);
        expect(AlarmInvocation.from({ retryCount: PLATFORM_ALARM_RETRY_LIMIT - 1 }).retriable).toBe(
            true
        );
        expect(AlarmInvocation.from({ retryCount: PLATFORM_ALARM_RETRY_LIMIT }).retriable).toBe(
            false
        );
    });

    test("compares the count and the retry flag together", { tags: "p2" }, () => {
        const second = AlarmInvocation.from({ retryCount: 2 });

        expect(second.equals(AlarmInvocation.from({ retryCount: 2, isRetry: true }))).toBe(true);
        expect(second.equals(AlarmInvocation.from({ retryCount: 3 }))).toBe(false);
        expect(second.equals(AlarmInvocation.from({ retryCount: 2, isRetry: false }))).toBe(false);
    });
});

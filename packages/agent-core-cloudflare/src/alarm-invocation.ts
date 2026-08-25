import { isBoolean, isFiniteNumber, isPlatformObject } from "./platform-value.js";

/**
 * Cloudflare re-fires a throwing alarm handler with exponential backoff from a two-second
 * delay, for up to six retries, and then stops
 * (https://developers.cloudflare.com/durable-objects/api/alarms/#alarm). The count is
 * what tells an object how close the platform is to abandoning a schedule, which is the
 * moment its own start-time rebuild becomes the only remaining recovery.
 */
export const PLATFORM_ALARM_RETRY_LIMIT = 6;

/** The `alarmInfo` argument the platform passes an alarm handler. */
export interface CloudflareAlarmInvocationInfoLike {
    readonly isRetry?: boolean;
    readonly retryCount?: number;
}

/**
 * What the platform said about this delivery of the object's single alarm. It exists so a
 * sweep can tell a first delivery from the platform's last one: durability rests on the
 * outbox and the start-time rebuild rather than on re-firing, and an object that cannot
 * see the retries running out cannot tell that its own re-arm is now the only thing left.
 */
export class AlarmInvocation {
    static readonly #first = new AlarmInvocation(0, false);

    /** The delivery an object assumes when the platform passed no information at all. */
    public static get first(): AlarmInvocation {
        return AlarmInvocation.#first;
    }

    /**
     * Reads the platform's own `alarmInfo`. A missing or malformed value reads as a first
     * delivery, which is the reading that claims least: it neither suppresses work nor
     * asserts a retry budget the platform never reported.
     */
    public static from(info: CloudflareAlarmInvocationInfoLike | undefined): AlarmInvocation {
        if (!isPlatformObject(info)) return AlarmInvocation.#first;
        const retryCount = info.retryCount;
        const isRetry = info.isRetry;
        if (!isFiniteNumber(retryCount) || !Number.isSafeInteger(retryCount) || retryCount < 0) {
            return AlarmInvocation.#first;
        }
        if (retryCount === 0 && (!isBoolean(isRetry) || !isRetry)) return AlarmInvocation.#first;
        return new AlarmInvocation(retryCount, isBoolean(isRetry) ? isRetry : retryCount > 0);
    }

    private constructor(
        public readonly retryCount: number,
        public readonly isRetry: boolean
    ) {
        Object.freeze(this);
    }

    /**
     * Whether the platform has retries left for this schedule. False means a throw from
     * here stops the re-firing, so the handler owes its own re-arm before it returns.
     */
    public get retriable(): boolean {
        return this.retryCount < PLATFORM_ALARM_RETRY_LIMIT;
    }

    public equals(other: AlarmInvocation): boolean {
        return this.retryCount === other.retryCount && this.isRetry === other.isRetry;
    }
}

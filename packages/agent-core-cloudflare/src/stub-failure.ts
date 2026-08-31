import {
    operationalFailure,
    type CloudflareCapturedCause,
    type CloudflareErrorPort
} from "./error.js";
import { isPlatformObject } from "./platform-value.js";

const RETRYABLE_PROPERTY = "retryable";
const OVERLOADED_PROPERTY = "overloaded";

/**
 * Cloudflare marks an exception raised by Durable Objects' own infrastructure with
 * `.retryable` when a retry may succeed, and with `.overloaded` when the object already
 * has more work than it can keep up with
 * (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/,
 * https://developers.cloudflare.com/durable-objects/observability/troubleshooting/#durable-object-is-overloaded).
 * The two readings differ in what they permit: a retryable failure is retried with
 * backoff, and retrying an overloaded one worsens the overload it reports.
 */

/** Why one call into another object failed, in the terms the platform documents. */
export abstract class CloudflareStubFailure {
    /** Transient infrastructure failure: a later attempt may succeed. */
    public static get retryable(): CloudflareStubFailure {
        return retryableFailure;
    }

    /** The object is past what one thread can serve; retrying adds to the overload. */
    public static get overloaded(): CloudflareStubFailure {
        return overloadedFailure;
    }

    /** The callee refused, or the failure carries no platform disposition. */
    public static get permanent(): CloudflareStubFailure {
        return permanentFailure;
    }

    /**
     * Reads a thrown value's platform disposition. Overload is decided before
     * retryability, because an overloaded failure that also carries `.retryable` must
     * still not be retried.
     */
    public static classify(cause: CloudflareCapturedCause): CloudflareStubFailure {
        const thrown = cause.value;
        if (!isPlatformObject(thrown)) return permanentFailure;
        // `in` proves the property exists before it is read, so the disposition is narrowed
        // at the boundary rather than declared as an unverified field.
        if (OVERLOADED_PROPERTY in thrown && thrown.overloaded === true) return overloadedFailure;
        if (RETRYABLE_PROPERTY in thrown && thrown.retryable === true) return retryableFailure;
        return permanentFailure;
    }

    /** Whether the same call may be attempted again. */
    public abstract get retry(): boolean;

    /** The clause a raised failure names, so the three stay distinguishable in a log. */
    public abstract get summary(): string;

    public equals(other: CloudflareStubFailure): boolean {
        return this === other;
    }
}

class RetryableFailure extends CloudflareStubFailure {
    public get retry(): boolean {
        return true;
    }

    public get summary(): string {
        return "transient Durable Objects infrastructure failure";
    }
}

class OverloadedFailure extends CloudflareStubFailure {
    public get retry(): boolean {
        return false;
    }

    public get summary(): string {
        return "target Durable Object is overloaded, so retrying worsens the overload";
    }
}

class PermanentFailure extends CloudflareStubFailure {
    public get retry(): boolean {
        return false;
    }

    public get summary(): string {
        return "target Durable Object refused the call";
    }
}

const retryableFailure = new RetryableFailure();
const overloadedFailure = new OverloadedFailure();
const permanentFailure = new PermanentFailure();

/**
 * How many times an idempotency-keyed cross-object call may be attempted, and how long
 * it waits between attempts. The backoff is exponential and has no jitter: this policy
 * governs one caller retrying one keyed call, not a fleet converging on one object, so
 * a deterministic schedule buys reproducible evidence and gives up nothing.
 */
export interface CloudflareStubRetryPolicy {
    readonly attempts: number;
    readonly baseDelayMilliseconds: number;
    readonly maximumDelayMilliseconds: number;
}

/**
 * Hands out a stub for one attempt. Cloudflare documents that many exceptions leave a
 * stub permanently broken, so a retry is only a retry if it runs against a stub this
 * factory made after the failure, never against the one that threw.
 */
export type CloudflareStubFactory<Stub> = () => Stub;

export interface CloudflareStubCallOptions<Stub> {
    readonly stubs: CloudflareStubFactory<Stub>;
    readonly policy: CloudflareStubRetryPolicy;
    readonly errors: CloudflareErrorPort;
    readonly sleep: (milliseconds: number) => Promise<void>;
}

/**
 * Proves a retry policy bounds something before any attempt runs. A policy is construction
 * shape rather than an operational condition, so it refuses with TypeError, and it refuses
 * here in one named place so no caller re-states the rule.
 */
export function requireStubRetryPolicy(
    policy: CloudflareStubRetryPolicy
): CloudflareStubRetryPolicy {
    if (!Number.isSafeInteger(policy.attempts) || policy.attempts < 1) {
        throw new TypeError("Durable Object stub retry policy must permit at least one attempt");
    }
    if (
        !Number.isSafeInteger(policy.baseDelayMilliseconds) ||
        policy.baseDelayMilliseconds < 0 ||
        !Number.isSafeInteger(policy.maximumDelayMilliseconds) ||
        policy.maximumDelayMilliseconds < policy.baseDelayMilliseconds
    ) {
        throw new TypeError("Durable Object stub retry delays must be an ordered safe range");
    }
    return policy;
}

/**
 * Runs one call that may be delivered more than once, against a fresh stub per attempt.
 * The call itself carries the idempotency key that makes redelivery safe; this seam owns
 * only the platform's own disposition rules, so a caller never encodes them twice.
 */
export async function throughFreshStub<Stub, Result>(
    options: CloudflareStubCallOptions<Stub>,
    call: (stub: Stub) => Promise<Result>
): Promise<Result> {
    const { attempts, baseDelayMilliseconds, maximumDelayMilliseconds } = requireStubRetryPolicy(
        options.policy
    );
    let attempted = 0;
    let lastCause: CloudflareCapturedCause | undefined;
    let lastFailure: CloudflareStubFailure = CloudflareStubFailure.permanent;
    while (attempted < attempts) {
        // Minting is outside the try on purpose: a namespace lookup that fails is not a
        // call the callee refused, and classifying it as one would both misname it and
        // re-enter the same failing factory for the whole attempt budget.
        const stub = options.stubs();
        try {
            return await call(stub);
        } catch (cause) {
            lastCause = { value: cause };
            lastFailure = CloudflareStubFailure.classify(lastCause);
            attempted += 1;
            if (!lastFailure.retry || attempted >= attempts) break;
            await options.sleep(
                Math.min(
                    maximumDelayMilliseconds,
                    baseDelayMilliseconds * Math.pow(2, attempted - 1)
                )
            );
        }
    }
    operationalFailure(
        options.errors,
        "protocol.invalid-state",
        `Durable Object call failed after ${attempted} attempt(s): ${lastFailure.summary}`,
        lastCause
    );
}

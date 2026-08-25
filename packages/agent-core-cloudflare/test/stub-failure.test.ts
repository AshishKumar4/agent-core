import { AgentCoreError } from "@agent-core/core";
import type { CloudflareErrorPort, CloudflareOperationalErrorCode } from "../src/error.js";
import {
    CloudflareStubFailure,
    throughFreshStub,
    type CloudflareStubRetryPolicy
} from "../src/stub-failure.js";

const errors: CloudflareErrorPort = {
    raise(code, message, cause): never {
        const failure = new AgentCoreError(code, message);
        if (cause !== undefined) Object.defineProperty(failure, "cause", { value: cause.value });
        throw failure;
    }
};

async function expectAsyncFailure<Result>(
    operation: () => Promise<Result>,
    code: CloudflareOperationalErrorCode
): Promise<AgentCoreError> {
    try {
        await operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
        if (error instanceof AgentCoreError) return error;
    }
    throw new TypeError(`Expected operational failure ${code}`);
}

/** A stub is identified only by the object the factory minted, never by its contents. */
interface CountedStub {
    readonly serial: number;
}

interface StubTrace {
    /** Every stub the factory minted, in mint order. */
    readonly minted: readonly CountedStub[];
    /** Every stub a call attempt actually ran against, in attempt order. */
    readonly attempted: readonly CountedStub[];
    /** Every delay the seam asked for, in order. */
    readonly delays: readonly number[];
    readonly run: (attempt: (stub: CountedStub) => Promise<string>) => Promise<string>;
}

function trace(policy: CloudflareStubRetryPolicy): StubTrace {
    const minted: CountedStub[] = [];
    const attempted: CountedStub[] = [];
    const delays: number[] = [];
    return {
        minted,
        attempted,
        delays,
        run: (attempt) =>
            throughFreshStub<CountedStub, string>(
                {
                    stubs: () => {
                        const stub: CountedStub = { serial: minted.length };
                        minted.push(stub);
                        return stub;
                    },
                    policy,
                    errors,
                    sleep: async (milliseconds: number) => {
                        delays.push(milliseconds);
                    }
                },
                (stub) => {
                    attempted.push(stub);
                    return attempt(stub);
                }
            )
    };
}

/** The two markers Durable Objects sets on its own infrastructure exceptions. */
interface PlatformDisposition {
    readonly retryable?: unknown;
    readonly overloaded?: unknown;
}

function platformFailure(disposition: PlatformDisposition): Error {
    return Object.assign(new Error("infrastructure"), disposition);
}

const IMMEDIATE_POLICY: CloudflareStubRetryPolicy = {
    attempts: 3,
    baseDelayMilliseconds: 0,
    maximumDelayMilliseconds: 0
};

describe("CloudflareStubFailure", () => {
    test("permits a retry for exactly the transient disposition", { tags: "p0" }, () => {
        expect(CloudflareStubFailure.retryable.retry).toBe(true);
        expect(CloudflareStubFailure.overloaded.retry).toBe(false);
        expect(CloudflareStubFailure.permanent.retry).toBe(false);
    });

    test("keeps the three dispositions distinguishable in a log", { tags: "p2" }, () => {
        const summaries = [
            CloudflareStubFailure.retryable.summary,
            CloudflareStubFailure.overloaded.summary,
            CloudflareStubFailure.permanent.summary
        ];

        expect(new Set(summaries).size).toBe(3);
        expect(summaries.filter((summary) => summary.length === 0)).toEqual([]);
    });

    /**
     * The platform marks an overloaded object retryable as well. Reading retryability
     * first would answer "retry" for the one condition a retry makes worse, so the order
     * of the two readings is the behavior, not an implementation detail.
     */
    test("reads overload before retryability when a throw carries both", { tags: "p0" }, () => {
        const both = platformFailure({ overloaded: true, retryable: true });

        expect(
            CloudflareStubFailure.classify({ value: both }).equals(CloudflareStubFailure.overloaded)
        ).toBe(true);
        expect(
            CloudflareStubFailure.classify({ value: both }).equals(CloudflareStubFailure.retryable)
        ).toBe(false);
        expect(CloudflareStubFailure.classify({ value: both }).retry).toBe(false);
    });

    test("reads each disposition the platform sets on its own", { tags: "p1" }, () => {
        expect(
            CloudflareStubFailure.classify({ value: platformFailure({ retryable: true }) }).equals(
                CloudflareStubFailure.retryable
            )
        ).toBe(true);
        expect(
            CloudflareStubFailure.classify({ value: platformFailure({ overloaded: true }) }).equals(
                CloudflareStubFailure.overloaded
            )
        ).toBe(true);
    });

    /**
     * A truthy marker is not a set marker. Accepting one would read a Cloudflare error
     * that happens to carry an unrelated field as a licence to retry.
     */
    test("treats only the boolean true as a set disposition", { tags: "p0" }, () => {
        const truthy = [
            platformFailure({ retryable: 1 }),
            platformFailure({ retryable: "yes" }),
            platformFailure({ overloaded: 1 }),
            platformFailure({ overloaded: "yes" }),
            platformFailure({ retryable: {} })
        ];

        for (const cause of truthy) {
            expect(
                CloudflareStubFailure.classify({ value: cause }).equals(
                    CloudflareStubFailure.permanent
                )
            ).toBe(true);
        }
    });

    test("reads a throw that carries no disposition as permanent", { tags: "p1" }, () => {
        const bare: readonly unknown[] = ["overloaded", 7, undefined, null, true, new Error("no")];

        for (const cause of bare) {
            expect(
                CloudflareStubFailure.classify({ value: cause }).equals(
                    CloudflareStubFailure.permanent
                )
            ).toBe(true);
        }
    });

    test("compares equal only to the same disposition", { tags: "p2" }, () => {
        const dispositions = [
            CloudflareStubFailure.retryable,
            CloudflareStubFailure.overloaded,
            CloudflareStubFailure.permanent
        ];

        for (const [index, left] of dispositions.entries()) {
            for (const [other, right] of dispositions.entries()) {
                expect(left.equals(right)).toBe(index === other);
            }
        }
    });
});

describe("throughFreshStub", () => {
    test("mints one stub for a call that succeeds first time", { tags: "p0" }, async () => {
        const run = trace(IMMEDIATE_POLICY);

        await expect(run.run(async () => "settled")).resolves.toBe("settled");
        expect(run.minted).toHaveLength(1);
        expect(run.delays).toEqual([]);
    });

    /**
     * Cloudflare documents that many exceptions leave a stub permanently broken, so a
     * second attempt on the stub that threw is not a retry at all. Counting the factory
     * calls would pass even if the seam reused the broken stub, so the identity of the
     * stub each attempt ran against is the property under test.
     */
    test(
        "runs the second attempt against a stub the first never touched",
        { tags: "p0" },
        async () => {
            const run = trace(IMMEDIATE_POLICY);
            let attempts = 0;

            const result = await run.run(async () => {
                attempts += 1;
                if (attempts === 1) throw platformFailure({ retryable: true });
                return "settled";
            });

            expect(result).toBe("settled");
            expect(run.minted).toHaveLength(2);
            expect(run.attempted).toHaveLength(2);
            expect(run.attempted[0]).toBe(run.minted[0]);
            expect(run.attempted[1]).toBe(run.minted[1]);
            expect(run.attempted[0]).not.toBe(run.attempted[1]);
        }
    );

    test("refuses to retry an overloaded object", { tags: "p0" }, async () => {
        const run = trace(IMMEDIATE_POLICY);
        const thrown = platformFailure({ overloaded: true });

        const failure = await expectAsyncFailure(
            () =>
                run.run(async () => {
                    throw thrown;
                }),
            "protocol.invalid-state"
        );

        expect(failure.message).toContain(CloudflareStubFailure.overloaded.summary);
        expect(run.minted).toHaveLength(1);
        expect(run.delays).toEqual([]);
    });

    test("stops at the attempt budget on repeated transient failures", { tags: "p0" }, async () => {
        const run = trace(IMMEDIATE_POLICY);

        const failure = await expectAsyncFailure(
            () =>
                run.run(async () => {
                    throw platformFailure({ retryable: true });
                }),
            "protocol.invalid-state"
        );

        expect(failure.message).toContain(CloudflareStubFailure.retryable.summary);
        expect(run.minted).toHaveLength(IMMEDIATE_POLICY.attempts);
        expect(run.delays).toHaveLength(IMMEDIATE_POLICY.attempts - 1);
    });

    /**
     * The schedule doubles from the base and stops at the ceiling, and it waits between
     * attempts only, never after the last one. A wait after the final attempt would delay
     * the failure a caller is already waiting on.
     */
    test("doubles each wait up to the ceiling and never waits last", { tags: "p1" }, async () => {
        const run = trace({
            attempts: 4,
            baseDelayMilliseconds: 100,
            maximumDelayMilliseconds: 250
        });

        await expectAsyncFailure(
            () =>
                run.run(async () => {
                    throw platformFailure({ retryable: true });
                }),
            "protocol.invalid-state"
        );

        expect(run.delays).toEqual([100, 200, 250]);
        expect(run.minted).toHaveLength(4);
    });

    test("carries the thrown platform value out as the cause", { tags: "p1" }, async () => {
        const run = trace(IMMEDIATE_POLICY);
        const thrown = platformFailure({ overloaded: true });

        const failure = await expectAsyncFailure(
            () =>
                run.run(async () => {
                    throw thrown;
                }),
            "protocol.invalid-state"
        );

        expect(failure.cause).toBe(thrown);
    });

    test("refuses a policy that cannot describe a schedule", { tags: "p1" }, async () => {
        const invalid: readonly CloudflareStubRetryPolicy[] = [
            { attempts: 0, baseDelayMilliseconds: 0, maximumDelayMilliseconds: 0 },
            { attempts: 1.5, baseDelayMilliseconds: 0, maximumDelayMilliseconds: 0 },
            { attempts: 2, baseDelayMilliseconds: -1, maximumDelayMilliseconds: 10 },
            { attempts: 2, baseDelayMilliseconds: 100, maximumDelayMilliseconds: 99 }
        ];

        for (const policy of invalid) {
            await expect(trace(policy).run(async () => "unreachable")).rejects.toBeInstanceOf(
                TypeError
            );
        }
    });

    test("refuses a policy before minting any stub", { tags: "p2" }, async () => {
        const run = trace({
            attempts: 0,
            baseDelayMilliseconds: 0,
            maximumDelayMilliseconds: 0
        });

        await expect(run.run(async () => "unreachable")).rejects.toBeInstanceOf(TypeError);
        expect(run.minted).toEqual([]);
    });
});

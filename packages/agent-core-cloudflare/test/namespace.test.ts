import { ActorId } from "@agent-core/core";
import {
    actorObjectName,
    throughActorObject,
    type ActorObjectIdentity,
    type CloudflareStubRetryPolicy,
    type DurableObjectNamespaceLike
} from "../src/index.js";
import { fakeErrors } from "./fakes.js";

/*
 * Calling one named Actor object. Cloudflare documents that many exceptions leave a stub
 * permanently broken, so recovery is a new stub rather than another call on the one that
 * failed; these tests are the evidence that a retry really re-resolves, that the platform's
 * own dispositions decide whether there is a retry at all, and that a namespace lookup
 * failure is not mistaken for a callee's refusal.
 *
 * Structural composition only; no Workers runtime takes part.
 */

const IDENTITY: ActorObjectIdentity = Object.freeze({
    kind: "workspace" as const,
    id: new ActorId("42")
});

const POLICY: CloudflareStubRetryPolicy = Object.freeze({
    attempts: 3,
    baseDelayMilliseconds: 10,
    maximumDelayMilliseconds: 100
});

interface ObjectId {
    readonly name: string;
    readonly jurisdiction: string | undefined;
}

interface MintedStub {
    readonly name: string;
    readonly jurisdiction: string | undefined;
    readonly serial: number;
}

interface NamespaceLog {
    readonly minted: MintedStub[];
    readonly jurisdictions: string[];
}

/**
 * A namespace that mints a new stub per lookup, so "the retry ran against a stub made
 * after the failure" is observable rather than assumed. The real namespace hands back a
 * new stub object per `get` too; a fixture that cached one would hide exactly the bug
 * this seam exists to prevent.
 */
class MintingNamespace implements DurableObjectNamespaceLike<ObjectId, MintedStub> {
    public constructor(
        public readonly log: NamespaceLog = { minted: [], jurisdictions: [] },
        private readonly selected: string | undefined = undefined,
        private readonly onGet: (() => void) | undefined = undefined
    ) {}

    public idFromName(name: string): ObjectId {
        return { name, jurisdiction: this.selected };
    }

    public get(id: ObjectId): MintedStub {
        this.onGet?.();
        const stub = {
            name: id.name,
            jurisdiction: id.jurisdiction,
            serial: this.log.minted.length + 1
        };
        this.log.minted.push(stub);
        return stub;
    }

    public jurisdiction(jurisdiction: string): MintingNamespace {
        this.log.jurisdictions.push(jurisdiction);
        return new MintingNamespace(this.log, jurisdiction, this.onGet);
    }
}

interface Attempted {
    readonly delays: number[];
    readonly served: MintedStub[];
}

function attempts(): Attempted {
    return { delays: [], served: [] };
}

/** What Durable Objects' own infrastructure marks a transient failure with. */
function transient(): Error {
    return Object.assign(new Error("transient infrastructure failure"), { retryable: true });
}

describe("calls through a named Actor object", () => {
    test(
        "resolves a stub per attempt and retries a transient refusal against the newer one",
        { tags: "p1" },
        async () => {
            const namespace = new MintingNamespace();
            const record = attempts();
            let refusals = 2;

            const answer = await throughActorObject(
                {
                    namespace,
                    identity: IDENTITY,
                    errors: fakeErrors,
                    policy: POLICY,
                    sleep: async (milliseconds) => {
                        record.delays.push(milliseconds);
                    }
                },
                async (stub) => {
                    record.served.push(stub);
                    if (refusals > 0) {
                        refusals -= 1;
                        throw transient();
                    }
                    return `served by ${stub.serial}`;
                }
            );

            expect(answer).toBe("served by 3");
            // Three attempts, three stubs, and each attempt ran against the one minted
            // for it: a retry on the stub that threw is the failure mode this prevents.
            expect(record.served.map((stub) => stub.serial)).toEqual([1, 2, 3]);
            expect(namespace.log.minted).toHaveLength(3);
            // Exponential, deterministic, no jitter: one caller retrying one keyed call.
            expect(record.delays).toEqual([10, 20]);
            // The object is named by identity alone, the same name every attempt.
            expect(new Set(record.served.map((stub) => stub.name))).toEqual(
                new Set([actorObjectName(IDENTITY)])
            );
        }
    );

    test("does not retry an overloaded object", { tags: "p1" }, async () => {
        const namespace = new MintingNamespace();
        const record = attempts();

        await expect(
            throughActorObject(
                {
                    namespace,
                    identity: IDENTITY,
                    errors: fakeErrors,
                    policy: POLICY,
                    sleep: async (milliseconds) => {
                        record.delays.push(milliseconds);
                    }
                },
                async (stub) => {
                    record.served.push(stub);
                    // A failure that carries both dispositions is still an overload:
                    // retrying it adds to the overload it reports.
                    throw Object.assign(new Error("overloaded"), {
                        overloaded: true,
                        retryable: true
                    });
                }
            )
        ).rejects.toMatchObject({
            code: "protocol.invalid-state",
            // One attempt, and the clause names which disposition ended it, so the
            // three stay distinguishable in a log.
            message: expect.stringMatching(/1 attempt\(s\).*worsens the overload/u)
        });

        expect(record.served).toHaveLength(1);
        expect(record.delays).toEqual([]);
    });

    test("gives up after the attempt budget and names the count", { tags: "p1" }, async () => {
        const namespace = new MintingNamespace();
        const record = attempts();

        await expect(
            throughActorObject(
                {
                    namespace,
                    identity: IDENTITY,
                    errors: fakeErrors,
                    policy: {
                        attempts: 2,
                        baseDelayMilliseconds: 10,
                        maximumDelayMilliseconds: 15
                    },
                    sleep: async (milliseconds) => {
                        record.delays.push(milliseconds);
                    }
                },
                async (stub) => {
                    record.served.push(stub);
                    throw transient();
                }
            )
        ).rejects.toMatchObject({
            code: "protocol.invalid-state",
            message: expect.stringMatching(/2 attempt\(s\).*transient/u)
        });

        // The budget bounds the attempts and the waits between them; the last failure
        // does not buy another sleep.
        expect(record.served).toHaveLength(2);
        expect(record.delays).toEqual([10]);
    });

    test(
        "routes every attempt through the jurisdiction the caller pinned",
        { tags: "p0" },
        async () => {
            const namespace = new MintingNamespace();
            const record = attempts();
            let refusals = 1;

            await throughActorObject(
                {
                    namespace,
                    identity: IDENTITY,
                    errors: fakeErrors,
                    policy: POLICY,
                    sleep: async () => undefined,
                    location: { namespaceJurisdiction: "eu" }
                },
                async (stub) => {
                    record.served.push(stub);
                    if (refusals > 0) {
                        refusals -= 1;
                        throw transient();
                    }
                    return stub.jurisdiction;
                }
            );

            // Re-resolution re-selects the jurisdiction, so a retry cannot silently fall
            // back to the default namespace and place the object elsewhere.
            expect(record.served.map((stub) => stub.jurisdiction)).toEqual(["eu", "eu"]);
            expect(namespace.log.jurisdictions).toEqual(["eu", "eu"]);
        }
    );

    test("selects no jurisdiction when the caller pins none", { tags: "p1" }, async () => {
        const namespace = new MintingNamespace();

        const placed = await throughActorObject(
            {
                namespace,
                identity: IDENTITY,
                errors: fakeErrors,
                policy: POLICY,
                sleep: async () => undefined
            },
            async (stub) => stub.jurisdiction
        );

        expect(placed).toBeUndefined();
        expect(namespace.log.jurisdictions).toEqual([]);
    });

    test(
        "refuses an empty jurisdiction before it touches the namespace",
        { tags: "p0" },
        async () => {
            const namespace = new MintingNamespace();
            const record = attempts();

            await expect(
                throughActorObject(
                    {
                        namespace,
                        identity: IDENTITY,
                        errors: fakeErrors,
                        policy: POLICY,
                        sleep: async () => undefined,
                        location: { namespaceJurisdiction: "" }
                    },
                    async (stub) => {
                        record.served.push(stub);
                        return "unreachable";
                    }
                )
            ).rejects.toThrow(TypeError);

            // A jurisdiction is construction shape, so nothing was placed, nothing was
            // called, and no attempt was spent.
            expect(namespace.log.minted).toEqual([]);
            expect(namespace.log.jurisdictions).toEqual([]);
            expect(record.served).toEqual([]);
        }
    );

    test(
        "reports a namespace lookup failure as itself, without spending the attempt budget",
        { tags: "p0" },
        async () => {
            const record = attempts();
            let lookups = 0;
            const namespace = new MintingNamespace(
                { minted: [], jurisdictions: [] },
                undefined,
                () => {
                    lookups += 1;
                    throw transient();
                }
            );

            // A namespace lookup that fails is not a call the callee refused. Naming it
            // as one would both mislabel it and re-enter the same failing factory for
            // the whole attempt budget, so it surfaces on the first failure with the
            // lookup's own message and the platform's disposition.
            await expect(
                throughActorObject(
                    {
                        namespace,
                        identity: IDENTITY,
                        errors: fakeErrors,
                        policy: POLICY,
                        sleep: async (milliseconds) => {
                            record.delays.push(milliseconds);
                        }
                    },
                    async (stub) => {
                        record.served.push(stub);
                        return "unreachable";
                    }
                )
            ).rejects.toMatchObject({
                code: "protocol.invalid-state",
                message: expect.stringMatching(/namespace lookup failed.*transient/u)
            });

            expect(lookups).toBe(1);
            expect(record.served).toEqual([]);
            expect(record.delays).toEqual([]);
        }
    );
});

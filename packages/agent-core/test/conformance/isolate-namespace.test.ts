import { describe, expect, test } from "vitest";
import { sourceProject } from "../../scripts/quality/evidence.mjs";
import {
    NAMESPACE_STRUCTURES,
    discoverNamespaceStructures,
    validateClosedNamespaceStructure
} from "../../scripts/quality/record-ownership.mjs";
import { ContentRef, Digest } from "../../src/core";
import { MemoryContentStore } from "../../src/content";
import {
    AUTHORED_CODE_CONSUMERS,
    AuthoredCodeBackingId,
    AuthoredCodeSource,
    BindingName,
    FacetRef,
    OperationName,
    type AuthoredCodeConsumer,
    type FacetData
} from "../../src/facets";
import {
    AuthoredCodeBacking,
    AuthoredCodeBackingSet,
    AuthoredCodeCapability,
    AuthoredCodeCapabilitySet,
    AuthoredCodeDelegation,
    AuthoredCodeDelegationPort,
    AuthoredCodeHost,
    OperationGateway,
    type AuthoredCodeDelegationRequest,
    type AuthoredCodeRunRequest,
    type ResolvedFacet
} from "../../src/operations";

const mailFacet = new FacetRef("mail:instance");
const mailBinding = new BindingName("mail");
const secretsBinding = new BindingName("secrets");
const readName = new OperationName("read");
const isolateBacking = new AuthoredCodeBackingId("isolate");

/**
 * Admissible BindingNames (§3.4 spells them as one lowercase canonical segment) that are
 * also properties a structure in the hosting language answers on its own. `constructor`
 * and `name` come from the object and function prototypes; the rest are `Map.prototype`
 * members, which matter precisely because the namespace IS a Map — a host that exposed
 * the container instead of looking through it would answer every one of them without
 * anything being passed. That is the ambient reach §4.7 exists to remove.
 */
const inheritedNames = Object.freeze([
    "constructor",
    "name",
    "get",
    "has",
    "set",
    "keys",
    "values",
    "entries",
    "size",
    "clear",
    "delete"
]);

describe("the capability namespace a §4.7 isolate is given", () => {
    test(
        "[C13-AUTH-ISOLATE-NAMESPACE-CLOSED] every namespace keys by a Map, and a prototype-bearing structure is refused",
        { tags: "p0", timeout: 60_000 },
        () => {
            const structures = discoverNamespaceStructures(sourceProject());
            expect(structures.map((entry) => entry.source).sort()).toEqual(
                NAMESPACE_STRUCTURES.map((entry) => entry.source).sort()
            );
            expect(() => validateClosedNamespaceStructure(structures)).not.toThrow();

            // This is what turns the Map keying from a convention into an enforced one. A
            // host that assembled the same namespace as an object — the one structure that
            // answers a name nobody passed — is refused here, rather than discovered later
            // by an isolate that reached something.
            for (const structure of structures) {
                const rebuilt = structures.map((entry) =>
                    entry === structure
                        ? { ...entry, keying: "Record<string, AuthoredCodeCapability>" }
                        : entry
                );
                expect(() => validateClosedNamespaceStructure(rebuilt)).toThrow(
                    `§4.7 namespace is not keyed by a Map: ${structure.source}`
                );
            }
        }
    );

    test(
        "[C13-AUTH-ISOLATE-NAMESPACE-CLOSED] no namespace answers a name the hosting language supplies",
        { tags: "p0" },
        () => {
            const passed = new AuthoredCodeCapabilitySet([
                new AuthoredCodeCapability(mailBinding, mailFacet)
            ]);
            for (const inherited of inheritedNames) {
                expect(passed.capability(new BindingName(inherited))).toBeUndefined();
                expect(
                    AuthoredCodeCapabilitySet.none.capability(new BindingName(inherited))
                ).toBeUndefined();
            }
            expect(passed.names.map((name) => name.value)).toEqual(["mail"]);

            // The backing namespace is the same structure making the same claim, and an
            // inherited name there is a typed refusal rather than a stray object.
            const backings = new AuthoredCodeBackingSet(
                [new PassthroughBacking(isolateBacking)],
                isolateBacking
            );
            for (const inherited of inheritedNames) {
                expect(() => backings.backing(new AuthoredCodeBackingId(inherited))).toThrow(
                    expect.objectContaining({ code: "operation.invalid-input" })
                );
            }
        }
    );

    test.each(AUTHORED_CODE_CONSUMERS)(
        "[C13-AUTH-ISOLATE-NAMESPACE-CLOSED] the %s consumer reaches exactly the passed set and nothing beside it",
        { tags: "p0" },
        async (consumer) => {
            const run = await consumerRun(consumer);

            // Whichever backing a consumer selects, the namespace handed to it is the one
            // the delegation minted: a consumer chooses where the code runs, never what it
            // can reach. Only the programmatic-tool-call channel had this covered.
            expect(run.consumer).toBe(consumer);
            expect(run.names).toEqual(["mail"]);
            expect(run.delegated).toEqual([consumer]);
            expect(run.disposals).toBe(1);

            // An unpassed name and a language-supplied one are both refused, and neither
            // reaches resolution: closure is a property of the namespace rather than of
            // whatever authority would have answered.
            for (const name of [secretsBinding, ...inheritedNames.map((n) => new BindingName(n))]) {
                await expect(run.invoke(name)).rejects.toThrow(
                    expect.objectContaining({
                        code: "authority.denied",
                        message: "Agent-authored code invoked a capability it was not passed"
                    })
                );
            }
            expect(run.resolutions()).toBe(0);

            // The passed name does reach resolution, so the refusals above are the
            // namespace closing rather than the channel being inert.
            await expect(run.invoke(mailBinding)).rejects.toThrow(
                "A name outside the passed set reached resolution"
            );
            expect(run.resolutions()).toBe(1);
        }
    );
});

interface ConsumerRun {
    readonly consumer: AuthoredCodeConsumer;
    readonly names: readonly string[];
    readonly delegated: readonly AuthoredCodeConsumer[];
    readonly disposals: number;
    invoke(binding: BindingName): Promise<FacetData>;
    resolutions(): number;
}

/**
 * One submission run for one consumer. Everything but the namespace is a double: a real
 * backing is a substrate's job (§10.2), and a real gateway would only ever be reached by
 * a name that already passed the membership check this test is about.
 */
async function consumerRun(consumer: AuthoredCodeConsumer): Promise<ConsumerRun> {
    let resolutions = 0;
    let disposals = 0;
    const delegated: AuthoredCodeConsumer[] = [];
    const gateway = new RefusingGateway(() => {
        resolutions += 1;
    });
    let observed: AuthoredCodeRunRequest | undefined;
    const bytes = new TextEncoder().encode("run()");
    const content = new MemoryContentStore();
    await content.put(bytes);

    const host = new AuthoredCodeHost({
        delegations: new PassthroughDelegations(gateway, delegated, () => {
            disposals += 1;
        }),
        backings: new AuthoredCodeBackingSet(
            [
                new PassthroughBacking(isolateBacking, (request) => {
                    observed = request;
                })
            ],
            isolateBacking
        ),
        backingFor: (_consumer, profileDefault) => profileDefault
    });

    await host.run(
        consumer,
        {
            source: new AuthoredCodeSource(
                "index.js",
                new Map([["index.js", ContentRef.fromDigest(Digest.sha256(bytes))]])
            ),
            capabilities: new AuthoredCodeCapabilitySet([
                new AuthoredCodeCapability(mailBinding, mailFacet)
            ]),
            input: {}
        },
        { isolate: "invocation:isolate-namespace", content, signal: new AbortController().signal }
    );

    const request = observed;
    if (request === undefined) throw new TypeError("Backing was never run");
    return {
        consumer: request.consumer,
        names: request.capabilities.names.map((name) => name.value),
        delegated,
        disposals,
        invoke: (binding) =>
            request.invocations.invoke({ binding, operation: readName, input: {} }),
        resolutions: () => resolutions
    };
}

class PassthroughBacking extends AuthoredCodeBacking {
    public constructor(
        public readonly id: AuthoredCodeBackingId,
        private readonly onRun: (request: AuthoredCodeRunRequest) => void = () => undefined
    ) {
        super();
    }

    public async run(request: AuthoredCodeRunRequest): Promise<FacetData> {
        this.onRun(request);
        return {};
    }
}

class PassthroughDelegations extends AuthoredCodeDelegationPort {
    public constructor(
        private readonly gateway: OperationGateway,
        private readonly seen: AuthoredCodeConsumer[],
        private readonly onDispose: () => void
    ) {
        super();
    }

    public async delegate(request: AuthoredCodeDelegationRequest): Promise<AuthoredCodeDelegation> {
        this.seen.push(request.consumer);
        return new PassthroughDelegation(request.requested, this.gateway, this.onDispose);
    }
}

class PassthroughDelegation extends AuthoredCodeDelegation {
    public constructor(
        public readonly capabilities: AuthoredCodeCapabilitySet,
        public readonly gateway: OperationGateway,
        private readonly onDispose: () => void
    ) {
        super();
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        this.onDispose();
    }
}

/** A gateway that records being asked. A closed namespace never asks it for an unpassed name. */
class RefusingGateway extends OperationGateway {
    public constructor(private readonly onResolve: () => void) {
        super();
    }

    public async resolve(): Promise<ResolvedFacet> {
        this.onResolve();
        throw new TypeError("A name outside the passed set reached resolution");
    }
}

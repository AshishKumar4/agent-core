import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    Binding,
    GrantId,
    InvalidationWatermark,
    PathEpochEvidence,
    ScopeEpoch
} from "../../src/authority";
import {
    TenantOperationAuthority,
    type MediatedAuthorityIntent,
    type OperationAuthorityStatePort,
    type OperationResolutionCandidate,
    type OperationResolutionState,
    type ResolutionStamp
} from "../../src/composition";
import { MemoryContentStore } from "../../src/content";
import { CompatRange, ContentRef, Digest, JsonSchema, SemVer } from "../../src/core";
import { PackageId, PackagePin, PlacementPolicy, PolicySet } from "../../src/definition";
import {
    AUTHORED_CODE_CONSUMERS,
    AuthoredCodeBackingId,
    AuthoredCodeBackingPolicy,
    AuthoredCodeSource,
    BindingName,
    Contribution,
    Contributions,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    isFacetDataMap,
    OperationDescriptor,
    OperationName,
    ProtectionDomain,
    SlotName,
    type FacetData,
    type FacetDataMap
} from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { InvocationId, RouteReservationId } from "../../src/interaction-references";
import { InvocationPlacementPin } from "../../src/invocations";
import {
    AuthoredCodeBacking,
    AuthoredCodeBackingSet,
    AuthoredCodeCapability,
    AuthoredCodeCapabilitySet,
    AuthoredCodeDelegation,
    AuthoredCodeDelegationPort,
    AuthoredCodeHost,
    AuthoredCodeOperation,
    GatewayAuthoredCodeInvocationPort,
    OperationGateway,
    OperationRequestKey,
    decodeSubmission,
    type AuthoredCodeDelegationRequest,
    type AuthoredCodeRunRequest,
    type MediatedInvocationPreparation,
    type MediatedInvocationRequest,
    type MediatedPreflightResult,
    type OperationInvocationPort
} from "../../src/operations";
import { OperationGatewayHost } from "../../src/operations/gateway";
import { FacetRuntimeHost } from "../../src/operations/lifecycle";
import { Facet, Operation, type OperationContext } from "../../src/operations/runtime";

const tenant = new TenantId("authored-code-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("authored-code-principal"));
const owner = new ActorRef("workspace", new ActorId("authored-code-owner"));
const tenantScope = ScopeRef.tenant(tenant);
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("authored-code-workspace"));
const subject = SubjectRef.principal(principal);
const isolateDomain = new ProtectionDomain("backend", "isolate", "no-secrets");
const loaderDomain = new ProtectionDomain("backend", "loader", "may-hold-secrets");

const mailFacet = new FacetRef("mail:instance");
const secretsFacet = new FacetRef("secrets:instance");
// A Facet reference in the pinned Package that is not the Facet the Binding resolves to.
const siblingFacet = new FacetRef("mail:sibling");
// A Facet reference whose Package segment is not the Package that answers for it: the
// reference claims `mail`, the manifest that answers is `vault`.
const impostorFacet = new FacetRef("mail:impostor");
const mailBinding = new BindingName("mail");
const secretsBinding = new BindingName("secrets");
const loaderOnlyBinding = new BindingName("credentials");
const impostorBinding = new BindingName("impostor");
const objectSchema = new JsonSchema({ type: "object" });
const readName = new OperationName("read");

const isolateRoute = new RouteReservationId("authored-code-route");
const workerLoader = new AuthoredCodeBackingId("workerLoader");
const dispatchNamespace = new AuthoredCodeBackingId("dispatchNamespace");

describe("the one channel out of a §4.7 isolate", () => {
    test(
        "[C13-AUTH-ISOLATE-DELEGATION] carries a call the passed set names",
        { tags: "p0" },
        async () => {
            const harness = await MembraneHarness.create();
            await expect(harness.invoke(mailBinding, "read")).resolves.toEqual({
                folder: "inbox",
                facet: mailFacet.value
            });
            await harness.dispose();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] refuses a capability the isolate was not passed, even one its own domain binds",
        { tags: "p0" },
        async () => {
            const harness = await MembraneHarness.create();

            // `secrets` is bound in the isolate's own protection domain and would resolve
            // if anything asked. It was not passed, so nothing may ask.
            expect(harness.state.resolvable(secretsBinding, isolateDomain)).toBe(true);
            await expect(harness.invoke(secretsBinding, "read")).rejects.toMatchObject({
                code: "authority.denied"
            });
            expect(harness.executions).toEqual([]);
            await harness.dispose();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] cannot reach a Binding that exists only in the loader's domain",
        { tags: "p0" },
        async () => {
            const harness = await MembraneHarness.create({
                passed: [
                    new AuthoredCodeCapability(mailBinding, mailFacet),
                    new AuthoredCodeCapability(loaderOnlyBinding, secretsFacet)
                ]
            });

            // Naming it in the passed set is not enough: the isolate's gateway resolves in
            // the isolate's domain, and that Binding is the loader's.
            expect(harness.state.resolvable(loaderOnlyBinding, loaderDomain)).toBe(true);
            expect(harness.state.resolvable(loaderOnlyBinding, isolateDomain)).toBe(false);
            await expect(harness.invoke(loaderOnlyBinding, "read")).rejects.toMatchObject({
                code: "authority.denied"
            });
            expect(harness.executions).toEqual([]);
            await harness.dispose();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] refuses a resolution that is not the exact Facet the passed capability pinned",
        { tags: "p0" },
        async () => {
            const harness = await MembraneHarness.create({
                passed: [new AuthoredCodeCapability(mailBinding, secretsFacet)]
            });
            await expect(harness.invoke(mailBinding, "read")).rejects.toMatchObject({
                code: "binding.invalid"
            });
            expect(harness.executions).toEqual([]);
            await harness.dispose();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] refuses a Facet the Binding does not resolve to inside the pinned Package",
        { tags: "p0" },
        async () => {
            // Package equal, Facet different: only pinning the Facet reference catches it.
            const harness = await MembraneHarness.create({
                passed: [new AuthoredCodeCapability(mailBinding, siblingFacet)]
            });
            await expect(harness.invoke(mailBinding, "read")).rejects.toMatchObject({
                code: "binding.invalid"
            });
            expect(harness.executions).toEqual([]);
            await harness.dispose();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] refuses a Package answering under another Package's Facet reference",
        { tags: "p0" },
        async () => {
            // Facet equal, Package different: only pinning the Package catches it.
            const harness = await MembraneHarness.create({
                passed: [new AuthoredCodeCapability(impostorBinding, impostorFacet)]
            });
            await expect(harness.invoke(impostorBinding, "read")).rejects.toMatchObject({
                code: "binding.invalid"
            });
            expect(harness.executions).toEqual([]);
            await harness.dispose();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] refuses an Operation the resolved Facet does not declare",
        { tags: "p1" },
        async () => {
            const harness = await MembraneHarness.create();
            await expect(harness.invoke(mailBinding, "purge")).rejects.toMatchObject({
                code: "binding.invalid"
            });
            await harness.dispose();
        }
    );

    test("assigns every call its own host-chosen request key", { tags: "p1" }, async () => {
        const harness = await MembraneHarness.create();
        await harness.invoke(mailBinding, "read");
        await harness.invoke(mailBinding, "read");

        expect(harness.requestKeys).toEqual([
            "invocation:authored-code-1:1",
            "invocation:authored-code-1:2"
        ]);
        await harness.dispose();
    });

    test("stops carrying calls once the submission is cancelled", { tags: "p1" }, async () => {
        const harness = await MembraneHarness.create();
        harness.cancel();
        await expect(harness.invoke(mailBinding, "read")).rejects.toMatchObject({
            code: "lease.invalid"
        });
        expect(harness.executions).toEqual([]);
        await harness.dispose();
    });
});

describe("selecting the backing that serves a §4.7 consumer", () => {
    test(
        "[C13-PLACEMENT-AUTHORED-BACKING] serves a declared consumer from its declared backing",
        { tags: "p0" },
        async () => {
            const harness = await HostHarness.create({
                backings: new AuthoredCodeBackingPolicy(
                    new Map([["programmaticToolCall", dispatchNamespace]])
                )
            });
            await harness.run();
            expect(harness.served).toEqual([dispatchNamespace.value]);
            await harness.dispose();
        }
    );

    test(
        "[C13-PLACEMENT-AUTHORED-BACKING] sends an unmapped consumer to the profile's declared default",
        { tags: "p0" },
        async () => {
            const harness = await HostHarness.create({
                backings: new AuthoredCodeBackingPolicy(
                    new Map([["slateBackend", dispatchNamespace]])
                )
            });
            await harness.run();
            // Not the other offered backing, and not an arbitrary one: the declared default.
            expect(harness.served).toEqual([workerLoader.value]);
            await harness.dispose();
        }
    );

    test(
        "[C13-PLACEMENT-AUTHORED-BACKING] refuses a declaration naming a backing the profile does not offer",
        { tags: "p0" },
        async () => {
            const harness = await HostHarness.create({
                backings: new AuthoredCodeBackingPolicy(
                    new Map([["programmaticToolCall", new AuthoredCodeBackingId("firecracker")]])
                )
            });
            await expect(harness.run()).rejects.toMatchObject({
                code: "operation.invalid-input"
            });
            expect(harness.served).toEqual([]);
            await harness.dispose();
        }
    );

    test(
        "[C13-PLACEMENT-AUTHORED-BACKING] carries the declaration on the §9.2 placement policy",
        { tags: "p0" },
        () => {
            const declared = new PlacementPolicy(
                ["dynamic"],
                ["*"],
                new AuthoredCodeBackingPolicy(new Map([["slateBackend", dispatchNamespace]]))
            );
            expect(declared.backingFor("slateBackend", workerLoader).value).toBe(
                dispatchNamespace.value
            );
            expect(declared.backingFor("programmaticToolCall", workerLoader).value).toBe(
                workerLoader.value
            );

            const restored = PlacementPolicy.decode(PlacementPolicy.encode(declared));
            expect(restored.backingFor("slateBackend", workerLoader).value).toBe(
                dispatchNamespace.value
            );
            // A policy that declares no mapping round-trips without carrying the field,
            // because the empty mapping and an absent one mean the same thing.
            expect(PlacementPolicy.all().toData()).toEqual({
                allowed: ["dynamic", "provider", "bundled"],
                trusted: ["*"]
            });
        }
    );

    test("closes the §4.7 consumer set", { tags: "p1" }, () => {
        expect([...AUTHORED_CODE_CONSUMERS]).toEqual([
            "programmaticToolCall",
            "slateBackend",
            "agentAuthoredFacet"
        ]);
        expect(() =>
            AuthoredCodeBackingPolicy.fromData({ agentAuthoredExecutor: "workerLoader" })
        ).toThrow(TypeError);
    });
});

describe("running one submission of agent-authored code", () => {
    test(
        "[C13-AUTH-ISOLATE-DELEGATION] hands the isolate the delegated set and returns its value",
        { tags: "p0" },
        async () => {
            const harness = await HostHarness.create();
            await expect(harness.run()).resolves.toEqual({
                entry: "index.js",
                names: ["mail"],
                called: { folder: "inbox", facet: mailFacet.value }
            });
            expect(harness.delegations.opened).toBe(1);
            expect(harness.delegations.disposed).toBe(1);
            await harness.dispose();
        }
    );

    test(
        "[C13-AUTH-ISOLATE-DELEGATION] revokes the delegation even when the code fails",
        { tags: "p0" },
        async () => {
            const harness = await HostHarness.create({ fail: true });
            await expect(harness.run()).rejects.toThrow();
            expect(harness.delegations.disposed).toBe(1);
            await harness.dispose();
        }
    );

    test("refuses code whose modules are not in the content store", { tags: "p1" }, async () => {
        const harness = await HostHarness.create({ store: false });
        await expect(harness.run()).rejects.toMatchObject({ code: "content.not-found" });
        expect(harness.delegations.opened).toBe(0);
        await harness.dispose();
    });

    test("declares programmatic tool calling as a delegate Operation", { tags: "p0" }, async () => {
        const harness = await HostHarness.create();
        const operation = new AuthoredCodeOperation(new OperationName("run"), harness.host);

        // Handing the capability set to the isolate is delegation, and §7.2 floors
        // `delegate` at mediated — so one submission is admitted, receipted, and audited
        // however many Operations the code inside goes on to call.
        expect(operation.descriptor.impact).toBe("delegate");
        expect(operation.descriptor.input.accepts(harness.submissionData())).toBe(true);
        expect(
            operation.descriptor.input.accepts({
                ...requireDataMap(harness.submissionData()),
                extra: 1
            })
        ).toBe(false);
        await expect(
            operation.execute(harness.operationContext(), harness.submissionData())
        ).resolves.toMatchObject({ names: ["mail"] });
        await harness.dispose();
    });

    test("rejects a submission that is not a §4.7 consumer's", { tags: "p1" }, () => {
        expect(() =>
            decodeSubmission({
                capabilities: [],
                consumer: "slateBackend",
                input: null,
                source: { entry: "index.js", modules: { "index.js": contentRef("code").value } }
            })
        ).not.toThrow();
        expect(() =>
            decodeSubmission({
                capabilities: [],
                consumer: "somethingElse",
                input: null,
                source: { entry: "index.js", modules: { "index.js": contentRef("code").value } }
            })
        ).toThrow(TypeError);
    });

    test("requires submitted code to enter through one of its own modules", { tags: "p1" }, () => {
        expect(
            () => new AuthoredCodeSource("missing.js", new Map([["index.js", contentRef("code")]]))
        ).toThrow(TypeError);
        expect(() => new AuthoredCodeSource("index.js", new Map())).toThrow(TypeError);
    });
});

function requireDataMap(value: FacetData): FacetDataMap {
    if (!isFacetDataMap(value)) throw new TypeError("Stub Facet input must be an object");
    return value;
}

function contentRef(text: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(text)));
}

interface MembraneOptions {
    readonly passed?: readonly AuthoredCodeCapability[];
}

/**
 * A real Operation gateway whose caller is the isolate: authority resolves in the
 * isolate's own protection domain, so what the loader holds is not addressable here at
 * all. Everything the isolate calls goes through the production port.
 */
class MembraneHarness {
    public readonly executions: string[] = [];
    public readonly requestKeys: string[] = [];
    public readonly state = new IsolateAuthorityState();
    public readonly gateway: OperationGateway;
    public readonly port: GatewayAuthoredCodeInvocationPort;

    readonly #host: FacetRuntimeHost;
    readonly #cancellation = new AbortController();

    private constructor(options: MembraneOptions) {
        // The Package `vault` answers for a Facet whose reference claims `mail`, so a
        // resolution's Facet and its Package are independently substitutable here.
        const manifests = [facetManifest("mail"), facetManifest("secrets"), facetManifest("vault")];
        const refs = [mailFacet, secretsFacet, impostorFacet];
        const facets = refs.map(
            (ref, index) =>
                new StubFacet(ref, manifests[index]!, (name, input) => {
                    this.executions.push(`${ref.value}:${name.value}`);
                    return { ...requireDataMap(input), facet: ref.value };
                })
        );
        this.#host = new FacetRuntimeHost(manifests, facets);
        this.gateway = new OperationGatewayHost<
            PrincipalRef,
            OperationResolutionState,
            ResolutionStamp,
            MediatedAuthorityIntent
        >(
            principal,
            this.#host,
            new TenantOperationAuthority(this.state, () => new Date(1_000)),
            new RecordingInvocations((key) => this.requestKeys.push(key.value))
        );
        this.port = new GatewayAuthoredCodeInvocationPort(
            this.gateway,
            new AuthoredCodeCapabilitySet([
                ...(options.passed ?? [new AuthoredCodeCapability(mailBinding, mailFacet)])
            ]),
            "invocation:authored-code-1",
            this.#cancellation.signal
        );
    }

    public static async create(options: MembraneOptions = {}): Promise<MembraneHarness> {
        const harness = new MembraneHarness(options);
        await harness.#host.activate();
        return harness;
    }

    public invoke(binding: BindingName, operation: string): Promise<FacetData> {
        return this.port.invoke({
            binding,
            operation: new OperationName(operation),
            input: { folder: "inbox" }
        });
    }

    public cancel(): void {
        this.#cancellation.abort();
    }

    public dispose(): Promise<void> {
        return this.#host.dispose();
    }
}

/**
 * Authority scoped to one protection domain. `resolve` answers only for Bindings in the
 * domain it was built for, which is how an isolate's gateway is unable to name its
 * loader's Bindings at all.
 */
class IsolateAuthorityState implements OperationAuthorityStatePort<PrincipalRef> {
    readonly #bindings = new Map<string, Binding>();
    readonly #path = new PathEpochEvidence([
        ScopeEpoch.initial(tenantScope),
        ScopeEpoch.initial(workspaceScope)
    ]);

    public constructor() {
        this.bind(mailBinding, isolateDomain, mailFacet);
        this.bind(secretsBinding, isolateDomain, secretsFacet);
        this.bind(impostorBinding, isolateDomain, impostorFacet);
        this.bind(loaderOnlyBinding, loaderDomain, secretsFacet);
    }

    public resolvable(name: BindingName, domain: ProtectionDomain): boolean {
        return this.#bindings.has(`${domain.label}:${name.value}`);
    }

    public resolve(
        caller: PrincipalRef,
        binding: BindingName
    ): OperationResolutionCandidate | undefined {
        if (!caller.equals(principal)) return undefined;
        const resolved = this.#bindings.get(`${isolateDomain.label}:${binding.value}`);
        if (resolved === undefined) return undefined;
        return {
            principal,
            binding: resolved,
            pathEpochs: this.#path,
            watermark: InvalidationWatermark.empty(tenant, owner, principal),
            // An isolate's Invocations present delegated-Binding authority, not the
            // Turn lease of whatever loaded it (SPEC §7.2, §4.7).
            lease: undefined,
            originalLease: undefined,
            route: isolateRoute,
            package: packagePin(),
            placement: bundledPlacement(),
            owner,
            policies: [new PolicySet()],
            turnOwnedSession: false,
            sessionFilesystemTarget: false,
            turnActorAuthorityLocal: false,
            directAuthority: undefined
        };
    }

    public currentBinding(key: string): Binding | undefined {
        return [...this.#bindings.values()].find((binding) => binding.key === key);
    }
    public currentPath(): PathEpochEvidence {
        return this.#path;
    }
    public currentWatermark(): InvalidationWatermark {
        return InvalidationWatermark.empty(tenant, owner, principal);
    }
    public currentLease(): undefined {
        return undefined;
    }
    public admits(): boolean {
        return true;
    }
    public contributorDomain(): ProtectionDomain {
        return isolateDomain;
    }
    public admitsInterception(): boolean {
        return true;
    }
    public release(): void {}
    public observeStale(): void {}

    private bind(name: BindingName, domain: ProtectionDomain, facet: FacetRef): void {
        this.#bindings.set(
            `${domain.label}:${name.value}`,
            Binding.active(
                workspaceScope,
                subject,
                domain,
                name,
                new GrantId(`grant-${domain.label}-${name.value}`),
                facet
            )
        );
    }
}

interface HostOptions {
    readonly backings?: AuthoredCodeBackingPolicy;
    readonly fail?: boolean;
    readonly store?: boolean;
}

/**
 * The whole submission path: content-addressed code resolved from the store, a
 * delegation opened and revoked around the run, and a backing chosen by the §9.2
 * declaration. The isolate is a recording double, because a real one is a substrate's
 * job (§10.2) and the properties under test are the host's.
 */
class HostHarness {
    public readonly served: string[] = [];
    public readonly delegations = new RecordingDelegations();
    public readonly host: AuthoredCodeHost;
    public readonly content = new MemoryContentStore();

    readonly #membrane: MembraneHarness;
    readonly #source: AuthoredCodeSource;

    private constructor(
        membrane: MembraneHarness,
        source: AuthoredCodeSource,
        options: HostOptions
    ) {
        this.#membrane = membrane;
        this.#source = source;
        const policy = options.backings ?? AuthoredCodeBackingPolicy.unmapped;
        this.host = new AuthoredCodeHost({
            delegations: this.delegations,
            backings: new AuthoredCodeBackingSet(
                [
                    new RecordingBacking(workerLoader, this.served, options.fail === true),
                    new RecordingBacking(dispatchNamespace, this.served, options.fail === true)
                ],
                workerLoader
            ),
            backingFor: (consumer, profileDefault) => policy.backingFor(consumer, profileDefault)
        });
        this.delegations.gateway = membrane.gateway;
    }

    public static async create(options: HostOptions = {}): Promise<HostHarness> {
        const membrane = await MembraneHarness.create();
        const harness = new HostHarness(
            membrane,
            new AuthoredCodeSource("index.js", new Map([["index.js", contentRef("run()")]])),
            options
        );
        if (options.store !== false) await harness.content.put(new TextEncoder().encode("run()"));
        return harness;
    }

    public run(): Promise<FacetData> {
        return this.host.run(
            "programmaticToolCall",
            {
                source: this.#source,
                capabilities: new AuthoredCodeCapabilitySet([
                    new AuthoredCodeCapability(mailBinding, mailFacet)
                ]),
                input: { folder: "inbox" }
            },
            {
                isolate: "invocation:authored-code-1",
                content: this.content,
                signal: new AbortController().signal
            }
        );
    }

    public submissionData(): FacetDataMap {
        return {
            capabilities: [{ binding: mailBinding.value, facet: mailFacet.value }],
            consumer: "programmaticToolCall",
            input: { folder: "inbox" },
            source: this.#source.toData()
        };
    }

    public operationContext(): OperationContext {
        return Object.freeze({
            invocation: new InvocationId("invocation:authored-code-1"),
            itemIndex: 0,
            idempotencyKey: "authored-code-1",
            signal: new AbortController().signal,
            content: this.content
        });
    }

    public dispose(): Promise<void> {
        return this.#membrane.dispose();
    }
}

class RecordingDelegations extends AuthoredCodeDelegationPort {
    public opened = 0;
    public disposed = 0;
    public gateway: OperationGateway | undefined;

    public async delegate(request: AuthoredCodeDelegationRequest): Promise<AuthoredCodeDelegation> {
        this.opened += 1;
        const gateway = this.gateway;
        if (gateway === undefined) throw new TypeError("Delegation fixture has no isolate gateway");
        return new RecordingDelegation(request.requested, gateway, () => {
            this.disposed += 1;
        });
    }
}

class RecordingDelegation extends AuthoredCodeDelegation {
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

class RecordingBacking extends AuthoredCodeBacking {
    public constructor(
        public readonly id: AuthoredCodeBackingId,
        private readonly served: string[],
        private readonly fail: boolean
    ) {
        super();
    }

    public async run(request: AuthoredCodeRunRequest): Promise<FacetData> {
        this.served.push(this.id.value);
        if (this.fail) throw new TypeError("Agent-authored code failed");
        const called = await request.invocations.invoke({
            binding: mailBinding,
            operation: readName,
            input: request.input
        });
        return {
            entry: request.entry,
            names: request.capabilities.names.map((name) => name.value),
            called
        };
    }
}

class StubFacet extends Facet {
    public constructor(
        public readonly ref: FacetRef,
        public readonly manifest: FacetManifest,
        private readonly handler: (name: OperationName, input: FacetData) => FacetData
    ) {
        super();
    }

    public operation(name: OperationName): Operation | undefined {
        if (!name.equals(readName)) return undefined;
        return new StubOperation(
            new OperationDescriptor(readName, "observe", objectSchema, objectSchema),
            (input) => this.handler(name, input)
        );
    }

    public surface(): undefined {
        return undefined;
    }
    public interceptor(): undefined {
        return undefined;
    }
    public children(): readonly Facet[] {
        return [];
    }
    public async start(): Promise<void> {}
    public async stop(): Promise<void> {}
}

class StubOperation extends Operation {
    public constructor(
        public readonly descriptor: OperationDescriptor,
        private readonly handler: (input: FacetData) => FacetData
    ) {
        super();
    }

    public async execute(_context: OperationContext, input: FacetData): Promise<FacetData> {
        return this.handler(input);
    }
}

class RecordingInvocations implements OperationInvocationPort<
    ResolutionStamp,
    MediatedAuthorityIntent
> {
    public constructor(private readonly onRequest: (key: OperationRequestKey) => void) {}

    public directContext(requestKey: OperationRequestKey, itemIndex: number): OperationContext {
        this.onRequest(requestKey);
        return operationContext(requestKey, itemIndex);
    }

    public async prepareMediated(
        _request: unknown,
        prepare: () => MediatedInvocationPreparation
    ): Promise<MediatedPreflightResult> {
        return { kind: "new", preparation: prepare() };
    }

    public async invoke(request: MediatedInvocationRequest<MediatedAuthorityIntent>) {
        this.onRequest(request.requestKey);
        const outputs = await Promise.all(
            request.inputs.map((_input, itemIndex) =>
                request.execute(itemIndex, operationContext(request.requestKey, itemIndex))
            )
        );
        return { outputs, evidence: { mediated: true } };
    }

    public recordDirectInterceptions(): void {}

    public async presentMediated(
        _evidence: FacetData,
        outputs: readonly FacetData[],
        present: (itemIndex: number, output: FacetData) => { readonly value: FacetData }
    ): Promise<readonly FacetData[]> {
        return outputs.map((output, itemIndex) => present(itemIndex, output).value);
    }
}

function operationContext(requestKey: OperationRequestKey, itemIndex: number): OperationContext {
    return Object.freeze({
        invocation: new InvocationId(`authored-code:${requestKey.value}:${itemIndex}`),
        itemIndex,
        idempotencyKey: `${requestKey.value}:${itemIndex}`,
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}

function facetManifest(id: string): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId(id),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["bundled"],
        bindings: [],
        contributions: new Contributions([
            new Contribution(new SlotName("operations"), [
                new OperationDescriptor(readName, "observe", objectSchema, objectSchema).toData()
            ])
        ])
    });
}

function bundledPlacement(): InvocationPlacementPin {
    return new InvocationPlacementPin({
        manifest: ["bundled"],
        policy: ["bundled"],
        substrate: ["bundled"],
        trust: ["bundled"],
        selected: "bundled"
    });
}

function packagePin(): PackagePin {
    const digest = new Digest("c".repeat(64));
    return new PackagePin(
        new PackageId("authored-code-package"),
        new SemVer("1.0.0"),
        digest,
        digest
    );
}

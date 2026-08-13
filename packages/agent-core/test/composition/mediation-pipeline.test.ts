import { describe, expect, it } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { requireInteger, requireObject, requireString } from "../../src/agents/record-data";
import {
    Binding,
    GrantId,
    InvalidationWatermark,
    PathEpochEvidence,
    ScopeEpoch
} from "../../src/authority";
import { MemoryContentStore, type ContentStore } from "../../src/content";
import {
    CompatRange,
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { PackageId, PackagePin, PolicySet } from "../../src/definition";
import {
    BindingName,
    CapabilitySpec,
    Contribution,
    Contributions,
    Facet,
    FacetManifest,
    FacetPackageId,
    FacetRef,
    Operation,
    OperationDescriptor,
    OperationName,
    OperationRef,
    ProtectionDomain,
    SlotName,
    type FacetData,
    type OperationContext
} from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import {
    AttemptReceipt,
    AuditRecord,
    AuthorityAdmissionReference,
    ClaimWorkerId,
    InvocationPlacementPin,
    MemoryInvocationMediationPersistence,
    MemoryInvocationPersistence,
    PreparedInvocation,
    Receipt,
    cloneInvocationMediationMemoryState,
    cloneInvocationMemoryState,
    createInvocationMediationMemoryState,
    createInvocationMemoryState,
    type AuthorityAdmissionContext,
    type AuthorityAdmissionPort,
    type CanonicalBatchAuthorityAuthenticationPort,
    type CanonicalBatchAuthorityPermitPort,
    type CanonicalBatchFinalAdmissionPort,
    type CanonicalBatchFinalAdmissionResult,
    type InvocationMediationMemoryState,
    type InvocationMemoryState,
    type InvocationTransactionPort,
    type ItemClaim,
    type ReceiptObservation,
    type StructuralCodec
} from "../../src/invocations";
import { OperationRequestKey } from "../../src/operations";
import {
    MediatedOperationPipeline,
    ResolvedOperationAuthority,
    mediationInvocationCodecs,
    mediationPreparedCodecs,
    type FacetActivationPinPort,
    type MediatedTurnCaller,
    type MediationAuthorityReference,
    type MediationDomainReference,
    type MediationLeaseReference,
    type MediationPathEpochReference,
    type MediationPreparedInvocation,
    type OperationAuthorityStatePort,
    type OperationResolutionCandidate
} from "../../src/composition";
import {
    AgentId,
    AgentPolicyId,
    BlueprintPin,
    ModelPolicyId,
    RunBranchId,
    RunCommitId,
    RunPins,
    Turn,
    TurnBoundOperation,
    TurnLease,
    type LeaseToken
} from "../../src/agents";
import { RunId, TurnId } from "../../src/execution-references";
import { EnvironmentId } from "../../src/environments";

const tenant = new TenantId("pipeline-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("pipeline-principal"));
const owner = new ActorRef("run", new ActorId("pipeline-run"));
const facet = new FacetRef("memory:primary");
const bindingName = new BindingName("recall");
const domain = new ProtectionDomain("backend", "memory", "may-hold-secrets");
const schema = new JsonSchema({ type: "object" });
const workspace = new WorkspaceId("pipeline-workspace");
const runId = new RunId("pipeline-run");
const branchId = new RunBranchId("pipeline-branch");
const turnId = new TurnId("pipeline-turn");
const token: LeaseToken = Object.freeze({ turn: turnId, holder: principal, epoch: 1 });

type PipelineState = InvocationMemoryState & InvocationMediationMemoryState;

interface DemoAdmission {
    readonly invocation: string;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
}

function contentRef(character: string): ContentRef {
    return new ContentRef(`sha256:${character.repeat(64)}`);
}

function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

function descriptor(): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName("recall"),
        "observe",
        schema,
        schema,
        "Perform recall."
    );
}

function manifest(): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId("memory"),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["provider"],
        bindings: [],
        contributions: new Contributions([
            new Contribution(new SlotName("operations"), [descriptor().toData()])
        ])
    });
}

class RecallOperation extends Operation {
    public readonly descriptor = descriptor();

    public constructor(private readonly observed: Observed) {
        super();
    }

    public async execute(context: OperationContext, _input: FacetData): Promise<FacetData> {
        this.observed.calls += 1;
        this.observed.signal = context.signal;
        this.observed.content = context.content;
        return { attempt: context.attempt?.id.value ?? null };
    }
}

interface Observed {
    signal: AbortSignal | undefined;
    content: ContentStore | undefined;
    calls: number;
    stops: number;
}

class MemoryFacet extends Facet {
    public readonly ref = facet;
    public readonly manifest = manifest();

    public constructor(private readonly observed: Observed) {
        super();
    }

    public operation(name: OperationName): Operation | undefined {
        return name.value === "recall" ? new RecallOperation(this.observed) : undefined;
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

    public async stop(): Promise<void> {
        this.observed.stops += 1;
    }
}

class MemoryTransactions implements InvocationTransactionPort<PipelineState> {
    #state: PipelineState = {
        ...createInvocationMemoryState(),
        ...createInvocationMediationMemoryState()
    };

    public transact<Result>(operation: (transaction: PipelineState) => Result): Result {
        const draft = this.clone();
        const result = operation(draft);
        this.#state = {
            ...cloneInvocationMemoryState(draft),
            ...cloneInvocationMediationMemoryState(draft)
        };
        return result;
    }

    public read(): PipelineState {
        return this.clone();
    }

    private clone(): PipelineState {
        return {
            ...cloneInvocationMemoryState(this.#state),
            ...cloneInvocationMediationMemoryState(this.#state)
        };
    }
}

class DemoAuthorityState implements OperationAuthorityStatePort<MediatedTurnCaller> {
    public readonly binding = Binding.active(
        ScopeRef.workspace(tenant, workspace),
        SubjectRef.principal(principal),
        domain,
        bindingName,
        new GrantId("pipeline-grant"),
        facet
    );
    public readonly path = new PathEpochEvidence([
        ScopeEpoch.initial(ScopeRef.tenant(tenant)),
        ScopeEpoch.initial(ScopeRef.workspace(tenant, workspace))
    ]);
    public readonly watermark = InvalidationWatermark.empty(tenant, owner, principal);
    public readonly lease = TurnLease.restore(turnId, principal, 1, new Date(500_000));
    public resolutions = 0;
    /**
     * Whether the resolver reports this Binding as direct-tier eligible (§7.2): a
     * bundled Facet, a local authority projection on the Turn Actor, the Grant-plane
     * authority captured at resolution, and a configured revocation window. Off by
     * default because the pipeline's subject is the mediated chain.
     */
    public directEligible = false;

    public resolve(
        caller: MediatedTurnCaller,
        binding: BindingName
    ): OperationResolutionCandidate | undefined {
        this.resolutions += 1;
        if (!binding.equals(bindingName) || caller.token.epoch !== token.epoch) return undefined;
        return {
            principal,
            binding: this.binding,
            pathEpochs: this.path,
            watermark: this.watermark,
            lease: token,
            originalLease: this.lease,
            route: undefined,
            package: new PackagePin(
                new PackageId("memory"),
                new SemVer("1.0.0"),
                digest("f"),
                digest("1")
            ),
            placement: new InvocationPlacementPin(
                this.directEligible ? bundledModes : providerModes
            ),
            owner,
            policies: [
                new PolicySet(this.directEligible ? { maxDirectRevocationWindowMs: 60_000 } : {})
            ],
            turnOwnedSession: false,
            sessionFilesystemTarget: false,
            turnActorAuthorityLocal: this.directEligible,
            directAuthority: this.directEligible
                ? new ResolvedOperationAuthority(facet, [
                      new CapabilitySpec({ facetPattern: facet.value, impacts: ["observe"] })
                  ])
                : undefined
        };
    }

    public currentBinding(): Binding {
        return this.binding;
    }
    public currentPath(): PathEpochEvidence {
        return this.path;
    }
    public currentWatermark(): InvalidationWatermark {
        return this.watermark;
    }
    public currentLease(): TurnLease {
        return this.lease;
    }
    public admits(): boolean {
        return true;
    }
    public contributorDomain(): ProtectionDomain {
        return domain;
    }
    public admitsInterception(): boolean {
        return false;
    }
    public release(): void {}
    public observeStale(): void {
        throw new TypeError("Authority went stale");
    }
}

const providerModes = {
    manifest: ["provider"],
    policy: ["provider"],
    substrate: ["provider"],
    trust: ["provider"],
    selected: "provider"
} as const;

const bundledModes = {
    manifest: ["bundled"],
    policy: ["bundled"],
    substrate: ["bundled"],
    trust: ["bundled"],
    selected: "bundled"
} as const;

const admissionCodec: StructuralCodec<DemoAdmission> = Object.freeze({
    encode: (value: DemoAdmission): JsonValue => ({
        attemptOrdinal: value.attemptOrdinal,
        invocation: value.invocation,
        itemIndex: value.itemIndex
    }),
    decode: (value: JsonValue): DemoAdmission => {
        const object = requireObject(value, "Demo admission");
        return Object.freeze({
            invocation: requireString(object["invocation"], "Demo admission Invocation"),
            itemIndex: requireInteger(object["itemIndex"], "Demo admission item index"),
            attemptOrdinal: requireInteger(
                object["attemptOrdinal"],
                "Demo admission attempt ordinal"
            )
        });
    }
});

function admissionDigest(reference: DemoAdmission): Digest {
    return Digest.sha256(encodeCanonicalJson(admissionCodec.encode(reference)));
}

class DemoPermits implements CanonicalBatchAuthorityPermitPort<
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmission
> {
    public async issue(
        invocation: MediationPreparedInvocation,
        claim: ItemClaim<MediationLeaseReference>
    ): Promise<AuthorityAdmissionReference<DemoAdmission>> {
        const reference = Object.freeze({
            invocation: invocation.header.id.value,
            itemIndex: claim.itemIndex,
            attemptOrdinal: claim.attemptOrdinal
        });
        return new AuthorityAdmissionReference(reference, admissionDigest(reference));
    }
}

class DemoAuthentication implements CanonicalBatchAuthorityAuthenticationPort<
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmission,
    undefined
> {
    public async authenticate(): Promise<undefined> {
        return undefined;
    }
}

class DemoTargetAdmission implements AuthorityAdmissionPort<
    PipelineState,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmission,
    undefined
> {
    public admits(
        _transaction: PipelineState,
        admission: AuthorityAdmissionReference<DemoAdmission>,
        context: AuthorityAdmissionContext<
            MediationLeaseReference,
            MediationAuthorityReference,
            MediationDomainReference,
            MediationPathEpochReference
        >
    ): boolean {
        return (
            admissionDigest(admission.reference).equals(admission.digest) &&
            admission.reference.invocation === context.invocation.value &&
            admission.reference.itemIndex === context.itemIndex &&
            admission.reference.attemptOrdinal === context.ordinal
        );
    }
}

class DemoFinalAdmission implements CanonicalBatchFinalAdmissionPort<
    PipelineState,
    never,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmission
> {
    public admit(): CanonicalBatchFinalAdmissionResult {
        return { kind: "admitted" };
    }
}

const activations: FacetActivationPinPort = {
    pin: (target) =>
        target.equals(facet)
            ? {
                  configurationDigest: digest("2"),
                  runtimeDigest: digest("3"),
                  activationGeneration: "generation-1",
                  registration: "registration-1"
              }
            : undefined
};

function pins(): RunPins {
    const revision = new Revision(1);
    return new RunPins({
        blueprint: new BlueprintPin("blueprint", new SemVer("1.0.0"), digest("e")),
        packages: [
            new PackagePin(new PackageId("memory"), new SemVer("1.0.0"), digest("f"), digest("1"))
        ],
        agent: { id: new AgentId("agent-1"), revision, digest: digest("a") },
        effectivePolicy: { id: new AgentPolicyId("policy-1"), revision, digest: digest("b") },
        modelPolicy: { id: new ModelPolicyId("model-1"), revision, digest: digest("c") },
        environment: { id: new EnvironmentId("environment-1"), revision, digest: digest("d") }
    });
}

function turn(): Turn {
    return new Turn({
        id: turnId,
        run: runId,
        branch: branchId,
        startHead: new RunCommitId("pipeline-root"),
        effectiveInput: new RunCommitId("pipeline-root"),
        pins: pins(),
        placement: digest("9"),
        input: contentRef("9"),
        revision: new Revision(0)
    });
}

function boundOperation(): TurnBoundOperation {
    return new TurnBoundOperation(
        bindingName,
        facet,
        new OperationRef("memory:recall"),
        descriptor()
    );
}

interface Harness {
    readonly pipeline: MediatedOperationPipeline<PipelineState, DemoAdmission, undefined>;
    readonly transactions: MemoryTransactions;
    readonly authority: DemoAuthorityState;
    readonly observed: Observed;
    readonly observations: ReceiptObservation[];
    readonly content: ContentStore;
}

async function harness(): Promise<Harness> {
    const transactions = new MemoryTransactions();
    const authority = new DemoAuthorityState();
    const observed: Observed = {
        signal: undefined,
        content: undefined,
        calls: 0,
        stops: 0
    };
    const content = new MemoryContentStore();
    const observations: ReceiptObservation[] = [];
    const pipeline = await MediatedOperationPipeline.activate<
        PipelineState,
        DemoAdmission,
        undefined
    >({
        scope: "pipeline-scope",
        actor: owner,
        tenant,
        worker: new ClaimWorkerId("worker-1"),
        transactions,
        persistence: new MemoryInvocationPersistence(mediationInvocationCodecs(admissionCodec)),
        evidence: new MemoryInvocationMediationPersistence(),
        authority,
        manifests: [manifest()],
        roots: [new MemoryFacet(observed)],
        activations,
        permits: new DemoPermits(),
        authentication: new DemoAuthentication(),
        admission: new DemoTargetAdmission(),
        finalAdmission: new DemoFinalAdmission(),
        content,
        events: {
            publish: async (_id, observation) => {
                observations.push(observation);
            }
        },
        commits: {
            append: async (_id, observation) => {
                observations.push(observation);
            }
        },
        claimLifetimeMilliseconds: 60_000,
        now: () => new Date(2_000)
    });
    return { pipeline, transactions, authority, observed, observations, content };
}

function invocationRequest(signal = new AbortController().signal, key = "pipeline-request") {
    return {
        turn: turn(),
        token,
        operation: boundOperation(),
        requestKey: new OperationRequestKey(key),
        input: { query: "parking" },
        signal
    };
}

describe("the published mediation composition root", () => {
    it("produces the whole §7 evidence chain for one mediated call", { tags: "p0" }, async () => {
        const value = await harness();
        const result = await value.pipeline.invocations.invoke(invocationRequest());

        const state = value.transactions.read();
        const prepared = [...state.prepared.values()].map((bytes) =>
            PreparedInvocation.decode(bytes, mediationPreparedCodecs)
        );
        expect(prepared).toHaveLength(1);
        const invocation = prepared[0]!;
        const codecs = mediationInvocationCodecs(admissionCodec);
        const attempts = [...state.attempts.values()].map((bytes) => codecs.attempt.decode(bytes));
        const receipts = [...state.receipts.values()].map((bytes) => Receipt.decode(bytes));
        const audits = [...state.audits.values()].map((bytes) => AuditRecord.decode(bytes));
        expect(attempts).toHaveLength(1);
        expect(receipts).toHaveLength(1);
        expect(audits).toHaveLength(3);

        const attempt = attempts[0]!;
        const receipt = receipts[0]!;
        if (!(receipt instanceof AttemptReceipt))
            throw new TypeError("expected an attempt Receipt");
        expect(result.output).toEqual({ attempt: attempt.id.value });
        expect(receipt.attempt.equals(attempt.id)).toBe(true);
        expect(receipt.outcome).toBe("succeeded");

        const invocationAudit = audits.find((record) => record.kind.kind === "invocation")!;
        const attemptAudit = audits.find((record) => record.kind.kind === "attempt")!;
        const receiptAudit = audits.find((record) => record.kind.kind === "receipt")!;
        expect(invocationAudit.id.equals(invocation.header.auditCause)).toBe(true);
        expect(attemptAudit.cause?.equals(invocationAudit.id)).toBe(true);
        expect(receiptAudit.cause?.equals(attemptAudit.id)).toBe(true);

        if (result.tier !== "mediated") throw new TypeError("expected the mediated tier");
        expect(result.evidence).toEqual({
            invocation: invocation.header.id.value,
            receipts: [receipt.id.value]
        });

        await value.pipeline.outbox.flush();
        expect(value.observations).toHaveLength(2);
        await value.pipeline.dispose();
    });

    it("runs each Operation under its own Turn's cancellation signal", { tags: "p0" }, async () => {
        const value = await harness();
        const controller = new AbortController();
        controller.abort();
        await expect(
            value.pipeline.invocations.invoke(invocationRequest(controller.signal))
        ).rejects.toMatchObject({ code: "lease.invalid" });
        expect(value.observed.calls).toBe(0);

        // The Operation runs under this Turn's own signal, not a substitute.
        const live = new AbortController();
        await value.pipeline.invocations.invoke(invocationRequest(live.signal, "live-request"));
        expect(value.observed.calls).toBe(1);
        expect(value.observed.signal).toBe(live.signal);
        await value.pipeline.dispose();
    });

    it("replays one Invocation for a repeated request key", { tags: "p0" }, async () => {
        const value = await harness();
        const first = await value.pipeline.invocations.invoke(invocationRequest());
        const second = await value.pipeline.invocations.invoke(invocationRequest());
        expect(second.output).toEqual(first.output);
        const state = value.transactions.read();
        expect(state.prepared.size).toBe(1);
        expect(state.attempts.size).toBe(1);
        expect(value.observed.calls).toBe(1);
        await value.pipeline.dispose();
    });

    it(
        "serves a direct-tier Turn call from memory and writes no durable evidence",
        { tags: "p0" },
        async () => {
            // §1.1's motivating case: an ordinary observe call the §7.2 floor tiers
            // direct. It reaches the model as output and leaves no Invocation, claim,
            // EffectAttempt, Receipt, or AuditRecord behind, so it never enters the §5.2
            // Settled frontier. The Operation still runs under the Turn's own
            // cancellation signal and the pipeline's content store.
            const value = await harness();
            value.authority.directEligible = true;
            const live = new AbortController();

            const result = await value.pipeline.invocations.invoke(invocationRequest(live.signal));

            // A null attempt is the direct tier's signature: no EffectAttempt exists to
            // name, which no mediated dispatch of this Operation can produce.
            expect(result).toEqual({ tier: "direct", output: { attempt: null } });
            expect(Object.hasOwn(result, "evidence")).toBe(false);
            expect(value.observed.calls).toBe(1);
            expect(value.observed.signal).toBe(live.signal);
            expect(value.observed.content).toBe(value.content);

            const state = value.transactions.read();
            expect(state.prepared.size).toBe(0);
            expect(state.claims.size).toBe(0);
            expect(state.attempts.size).toBe(0);
            expect(state.receipts.size).toBe(0);
            expect(state.audits.size).toBe(0);

            await value.pipeline.outbox.flush();
            expect(value.observations).toEqual([]);
            await value.pipeline.dispose();
        }
    );

    it("refuses a Binding the authority plane does not resolve", { tags: "p0" }, async () => {
        const value = await harness();
        const request = {
            ...invocationRequest(),
            operation: new TurnBoundOperation(
                new BindingName("forbidden"),
                facet,
                new OperationRef("memory:recall"),
                descriptor()
            )
        };
        await expect(value.pipeline.invocations.invoke(request)).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(value.transactions.read().prepared.size).toBe(0);
        await value.pipeline.dispose();
    });

    it("stops its Facets when the composition root is disposed", { tags: "p0" }, async () => {
        // The pipeline owns the Facet runtime it activated, so disposing it has to stop
        // that runtime — a root that returned without stopping leaves activated Facets
        // holding whatever the substrate gave them, with no owner left to release them.
        const value = await harness();
        expect(value.observed.stops).toBe(0);
        await value.pipeline.dispose();
        expect(value.observed.stops).toBe(1);
    });

    it("stops its Facets when used as an async disposable", { tags: "p0" }, async () => {
        // `await using` is the ordinary way a caller scopes the root, so the disposal
        // protocol has to reach the same teardown the explicit call does.
        const value = await harness();
        {
            await using pipeline = value.pipeline;
            expect(pipeline.invocations).toBeDefined();
            expect(value.observed.stops).toBe(0);
        }
        expect(value.observed.stops).toBe(1);
    });

    it("does not become a mediation surface when activation fails", { tags: "p1" }, async () => {
        class FailingFacet extends MemoryFacet {
            public override async start(): Promise<void> {
                throw new TypeError("activation failed");
            }
        }
        await expect(
            MediatedOperationPipeline.activate<PipelineState, DemoAdmission, undefined>({
                scope: "pipeline-scope",
                actor: owner,
                tenant,
                worker: new ClaimWorkerId("worker-1"),
                transactions: new MemoryTransactions(),
                persistence: new MemoryInvocationPersistence(
                    mediationInvocationCodecs(admissionCodec)
                ),
                evidence: new MemoryInvocationMediationPersistence(),
                authority: new DemoAuthorityState(),
                manifests: [manifest()],
                roots: [
                    new FailingFacet({
                        signal: undefined,
                        content: undefined,
                        calls: 0,
                        stops: 0
                    })
                ],
                activations,
                permits: new DemoPermits(),
                authentication: new DemoAuthentication(),
                admission: new DemoTargetAdmission(),
                finalAdmission: new DemoFinalAdmission(),
                content: new MemoryContentStore(),
                events: { publish: async () => {} },
                commits: { append: async () => {} },
                claimLifetimeMilliseconds: 60_000,
                now: () => new Date(2_000)
            })
        ).rejects.toMatchObject({ code: "facet.inactive" });
    });
});

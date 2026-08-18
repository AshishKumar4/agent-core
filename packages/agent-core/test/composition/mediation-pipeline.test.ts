import { describe, expect, it } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermitAuthenticator,
    AuthorityPermitExpectation,
    AuthorityPermitIssuedRecordSource,
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
    isObjectRecord,
    jsonDataParser,
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
    AttemptCompletion,
    AttemptReceipt,
    AuditRecord,
    AuthorityAdmissionReference,
    ClaimWorkerId,
    InvocationPlacementPin,
    MemoryInvocationMediationPersistence,
    MemoryInvocationPersistence,
    PreEffectReceipt,
    PreparedInvocation,
    Receipt,
    cloneInvocationMediationMemoryState,
    cloneInvocationMemoryState,
    createInvocationMediationMemoryState,
    createInvocationMemoryState,
    structuralCodec,
    type AuthorityAdmissionContext,
    type AuthorityAdmissionPort,
    type CanonicalBatchAuthorityAuthenticationPort,
    type CanonicalBatchAuthorityPermitPort,
    type CanonicalBatchFinalAdmissionPort,
    type CanonicalBatchFinalAdmissionResult,
    type EffectAttemptId,
    type InvocationMediationMemoryState,
    type InvocationMemoryState,
    type InvocationTransactionPort,
    type ItemClaim,
    type ReceiptId,
    type ReceiptObservation,
    type StructuralCodec
} from "../../src/invocations";
import { OperationRequestKey } from "../../src/operations";
import {
    AuthorityPermitIssuanceTransport,
    MediatedOperationPipeline,
    ResolvedOperationAuthority,
    activateTargetPermitMediation,
    leaseToken,
    mediationInvocationCodecs,
    mediationPreparedCodecs,
    type FacetActivationPinPort,
    type AuthorityCheckRequestFactory,
    type AuthorityPermitExpectationFactory,
    type AuthorityPermitReference,
    type MediatedTurnCaller,
    type MediationAuthorityReference,
    type MediationDomainReference,
    type MediationLeaseReference,
    type MediationPathEpochReference,
    type MediationPersistence,
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
    TurnAdmissionHandleCodec,
    TurnBoundOperation,
    TurnLease,
    type LeaseToken
} from "../../src/agents";
import { RunId, TurnId } from "../../src/execution-references";
import { InvocationId } from "../../src/interaction-references";
import { EnvironmentId } from "../../src/environments";
import { AuthorityPermitIssuanceReply, AuthorityPermitIssuanceRequest } from "../../src/protocol";
import {
    SqliteTargetPermitMediationAggregate,
    SqliteTargetResolutionInvalidationPort,
    type TransactionalSqlite
} from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";

const recordData = jsonDataParser((message) => new TypeError(message));

const tenant = new TenantId("pipeline-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("pipeline-principal"));
const owner = new ActorRef("run", new ActorId("pipeline-run"));
const facet = new FacetRef("memory:primary");
const bindingName = new BindingName("recall");
const domain = new ProtectionDomain("backend", "memory", "may-hold-secrets");
const schema = new JsonSchema({ type: "object" });
const workspace = new WorkspaceId("pipeline-workspace");
const runId = new RunId("pipeline-run");
const childRunId = new RunId("pipeline-child-run");
const branchId = new RunBranchId("pipeline-branch");
const turnId = new TurnId("pipeline-turn");
const token: LeaseToken = Object.freeze({ turn: turnId, holder: principal, epoch: 1 });
const issuer = new ActorRef("tenant", new ActorId("pipeline-issuer"));

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

/**
 * A `delegate`-impact Operation whose canonical result is exactly a child RunRef, which is
 * the shape §5.6 requires of a spawn's Receipt. It shares the recall Binding: a Binding is
 * the authority handle and the operation name selects within the resolved Facet, so this
 * needs no second Grant to reach the mediated tier that §7.2 floors delegation at.
 */
function spawnDescriptor(): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName("spawn"),
        "delegate",
        schema,
        schema,
        "Spawn a child Run."
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
            new Contribution(new SlotName("operations"), [
                descriptor().toData(),
                spawnDescriptor().toData()
            ])
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
        this.observed.fail?.();
        return { attempt: context.attempt?.id.value ?? null };
    }
}

class SpawnOperation extends Operation {
    public readonly descriptor = spawnDescriptor();

    public constructor(private readonly observed: Observed) {
        super();
    }

    public async execute(_context: OperationContext, _input: FacetData): Promise<FacetData> {
        this.observed.calls += 1;
        return { run: childRunId.value };
    }
}

interface Observed {
    signal: AbortSignal | undefined;
    content: ContentStore | undefined;
    calls: number;
    stops: number;
    /** Raises from the Operation body, so the host classifies an unconfirmed failure. */
    fail?: (() => void) | undefined;
}

class MemoryFacet extends Facet {
    public readonly ref = facet;
    public readonly manifest = manifest();

    public constructor(private readonly observed: Observed) {
        super();
    }

    public operation(name: OperationName): Operation | undefined {
        if (name.value === "recall") return new RecallOperation(this.observed);
        return name.value === "spawn" ? new SpawnOperation(this.observed) : undefined;
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
    public releases = 0;
    /**
     * Whether the resolver reports this Binding as direct-tier eligible (§7.2): a
     * bundled Facet, a local authority projection on the Turn Actor, the Grant-plane
     * authority captured at resolution, and a configured revocation window. Off by
     * default because the pipeline's subject is the mediated chain.
     */
    public directEligible = false;
    public remotePlacement: "provider" | "dynamic" = "provider";

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
                this.directEligible
                    ? bundledModes
                    : this.remotePlacement === "provider"
                      ? providerModes
                      : dynamicModes
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
    public release(): void {
        this.releases += 1;
    }
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

const dynamicModes = {
    manifest: ["dynamic"],
    policy: ["dynamic"],
    substrate: ["dynamic"],
    trust: ["dynamic"],
    selected: "dynamic"
} as const;

const bundledModes = {
    manifest: ["bundled"],
    policy: ["bundled"],
    substrate: ["bundled"],
    trust: ["bundled"],
    selected: "bundled"
} as const;

const admissionCodec: StructuralCodec<DemoAdmission> = structuralCodec(
    (value: DemoAdmission): JsonValue => ({
        attemptOrdinal: value.attemptOrdinal,
        invocation: value.invocation,
        itemIndex: value.itemIndex
    }),
    (value: JsonValue): DemoAdmission => {
        const object = recordData.object(value, "Demo admission");
        return Object.freeze({
            invocation: recordData.string(object["invocation"], "Demo admission Invocation"),
            itemIndex: recordData.safeInteger(object["itemIndex"], "Demo admission item index"),
            attemptOrdinal: recordData.safeInteger(
                object["attemptOrdinal"],
                "Demo admission attempt ordinal"
            )
        });
    }
);

function admissionDigest(reference: DemoAdmission): Digest {
    return Digest.sha256(encodeCanonicalJson(admissionCodec.encode(reference)));
}

class DemoPermits implements CanonicalBatchAuthorityPermitPort<
    PipelineState,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmission
> {
    public async issue(
        invocation: MediationPreparedInvocation,
        claim: ItemClaim<MediationLeaseReference>
    ): Promise<{
        readonly kind: "issued";
        readonly admission: AuthorityAdmissionReference<DemoAdmission>;
    }> {
        const reference = Object.freeze({
            invocation: invocation.header.id.value,
            itemIndex: claim.itemIndex,
            attemptOrdinal: claim.attemptOrdinal
        });
        return {
            kind: "issued",
            admission: new AuthorityAdmissionReference(reference, admissionDigest(reference))
        };
    }

    public deny(
        _transaction: PipelineState,
        _invocation: MediationPreparedInvocation,
        _claim: ItemClaim<MediationLeaseReference>,
        _denial: never
    ): void {}
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

function spawnOperation(): TurnBoundOperation {
    return new TurnBoundOperation(
        bindingName,
        facet,
        new OperationRef("memory:spawn"),
        spawnDescriptor()
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

async function harness(
    persistence: MediationPersistence<PipelineState, DemoAdmission> = new MemoryInvocationPersistence(
        mediationInvocationCodecs(admissionCodec)
    )
): Promise<Harness> {
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
        persistence,
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

/**
 * The mediation persistence, with the stored Receipt and EffectAttempt a reader sees under the
 * test's control once the attempt has committed. The admission record projection is the only
 * reader that reads a committed Receipt back by id, so what it reports is exactly what these
 * substitutions decide; the audit chain reads the Receipt it is writing and is left alone.
 */
class ProjectedRecords extends MemoryInvocationPersistence<
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmission
> {
    #committed = false;
    #projecting = false;
    public substitute: ((stored: AttemptReceipt) => Receipt | undefined) | undefined;
    public hideAttempt = false;

    public override appendReceipt(transaction: InvocationMemoryState, record: Receipt): void {
        super.appendReceipt(transaction, record);
        this.#committed = true;
    }

    public override receipt(
        transaction: InvocationMemoryState,
        id: ReceiptId
    ): Receipt | undefined {
        const stored = super.receipt(transaction, id);
        if (!this.#committed) return stored;
        this.#projecting = true;
        if (this.substitute === undefined || !(stored instanceof AttemptReceipt)) return stored;
        return this.substitute(stored);
    }

    public override attempt(transaction: InvocationMemoryState, id: EffectAttemptId) {
        if (this.#projecting && this.hideAttempt) return undefined;
        return super.attempt(transaction, id);
    }
}

function storedAttemptReceipt(value: Harness): AttemptReceipt {
    const receipts = [...value.transactions.read().receipts.values()].map((bytes) =>
        Receipt.decode(bytes)
    );
    const receipt = receipts[0];
    if (receipts.length !== 1 || !(receipt instanceof AttemptReceipt)) {
        throw new TypeError("expected exactly one attempt Receipt");
    }
    return receipt;
}

class DeniedPermitExpectations implements AuthorityPermitExpectationFactory<
    TransactionalSqlite,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference
> {
    public forClaim(
        invocation: MediationPreparedInvocation,
        claim: ItemClaim<MediationLeaseReference>
    ): AuthorityPermitExpectation {
        return permitExpectationFor(invocation, claim);
    }

    public forAdmission(): undefined {
        return undefined;
    }
}

class DeniedPermitRequests implements AuthorityCheckRequestFactory<
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference
> {
    public forClaim(
        invocation: MediationPreparedInvocation,
        claim: ItemClaim<MediationLeaseReference>,
        nonce: string
    ): AuthorityCheckRequest {
        const expected = permitExpectationFor(invocation, claim);
        const binding = new Binding(
            expected.pathEpochs.target.scope,
            SubjectRef.principal(expected.principal),
            expected.target.domain,
            expected.binding.name,
            new GrantId("pipeline-permit-grant"),
            expected.facet,
            expected.binding.generation.value,
            "active",
            expected.binding.generation
        );
        return new AuthorityCheckRequest({
            ownerTenant: expected.tenant,
            owner: expected.target.actor,
            ownerFence: expected.target.fence,
            principal: expected.principal,
            binding,
            intent: {
                facet: expected.facet,
                operation: expected.operation.operation.value,
                impact: expected.impact,
                arguments: permitArguments(invocation.item(claim.itemIndex).arguments),
                argumentsDigest: expected.argumentsDigest
            },
            expectedPath: expected.pathEpochs,
            invocationDigest: expected.intentDigest,
            itemIndex: claim.itemIndex,
            attemptOrdinal: claim.attemptOrdinal,
            nonce
        });
    }
}

class DeniedPermitTransport extends AuthorityPermitIssuanceTransport {
    public async issue(bytes: Uint8Array): Promise<Uint8Array> {
        const request = AuthorityPermitIssuanceRequest.decode(bytes).targetRequest;
        const evidence = new AuthorityCheckEvidence(
            request.expectation.tenant,
            request.expectation.issuer,
            request.authority.digest(),
            request.authority.binding.key,
            request.authority.binding.generation,
            "deny",
            "stalePath",
            [],
            [],
            request.authority.expectedPath,
            new Date(2_000)
        );
        return AuthorityPermitIssuanceReply.encode(AuthorityPermitIssuanceReply.denied(evidence));
    }
}

class MissingIssuedPermits extends AuthorityPermitIssuedRecordSource {
    public async issued(): Promise<undefined> {
        return undefined;
    }
}

class RecordingSqliteInvalidations extends SqliteTargetResolutionInvalidationPort {
    public calls = 0;

    public invalidate(
        transaction: TransactionalSqlite,
        _expectation: AuthorityPermitExpectation
    ): void {
        transaction.all("SELECT 1", []);
        this.calls += 1;
    }
}

class SqlitePermitFinalAdmission implements CanonicalBatchFinalAdmissionPort<
    TransactionalSqlite,
    never,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    AuthorityPermitReference
> {
    public admit(): CanonicalBatchFinalAdmissionResult {
        return { kind: "admitted" };
    }
}

function permitExpectationFor(
    invocation: MediationPreparedInvocation,
    claim: ItemClaim<MediationLeaseReference>
): AuthorityPermitExpectation {
    const authority = invocation.header.authority;
    const path = PathEpochEvidence.fromData({ path: [...invocation.header.pathEpochs.path] });
    const permitPrincipal = new PrincipalRef(
        new TenantId(authority.tenant),
        new PrincipalId(authority.principal)
    );
    const packagePin = invocation.header.operation;
    const claimOwner =
        claim.owner.kind === "executor"
            ? {
                  kind: "executor" as const,
                  token: leaseToken(claim.owner.token),
                  worker: claim.owner.worker
              }
            : {
                  kind: "system" as const,
                  actor: claim.owner.actor,
                  worker: claim.owner.worker
              };
    return new AuthorityPermitExpectation({
        tenant,
        issuer,
        source: owner,
        target: {
            actor: owner,
            fence: 0,
            domain: new ProtectionDomain(
                invocation.header.domain.kind,
                invocation.header.domain.label,
                invocation.header.domain.secretPolicy
            )
        },
        principal: permitPrincipal,
        binding: { name: new BindingName(authority.binding), generation: Revision.initial() },
        facet: new FacetRef(invocation.header.operation.target),
        operation: packagePin.operation,
        package: new PackagePin(
            packagePin.packageId,
            packagePin.version,
            packagePin.manifestDigest,
            packagePin.runtimeDigest
        ),
        impact: packagePin.impact,
        invocation: invocation.header.id,
        reservation: {
            run: runId,
            registryEpoch: 0,
            obligation: {
                kind: "invocationItem",
                invocation: invocation.header.id,
                itemIndex: claim.itemIndex,
                itemKey: invocation.item(claim.itemIndex).idempotencyKey
            }
        },
        itemIndex: claim.itemIndex,
        attemptOrdinal: claim.attemptOrdinal,
        claim: claim.id,
        claimOwner,
        itemKey: invocation.item(claim.itemIndex).idempotencyKey,
        argumentsDigest: Digest.sha256(
            encodeCanonicalJson(invocation.item(claim.itemIndex).arguments)
        ),
        intentDigest: invocation.intentDigest,
        pathEpochs: path,
        authority: {
            kind: authority.kind,
            principal: permitPrincipal,
            binding: new BindingName(authority.binding)
        },
        lease: claimOwner.kind === "executor" ? claimOwner.token : undefined
    });
}

function permitArguments(value: JsonValue): Readonly<Record<string, JsonValue>> {
    if (!isObjectRecord(value)) throw new TypeError("Expected permit argument object");
    return value;
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

function spawnRequest(key = "pipeline-spawn") {
    return {
        ...invocationRequest(undefined, key),
        operation: spawnOperation()
    };
}

describe("the published mediation composition root", () => {
    it(
        "assembles authenticated permit denial over one SQLite target aggregate",
        { tags: "p0" },
        async () => {
            const database = new TestSqlite();
            const invalidations = new RecordingSqliteInvalidations();
            const aggregate = new SqliteTargetPermitMediationAggregate(
                database,
                tenant,
                owner,
                invalidations
            );
            const observed: Observed = {
                signal: undefined,
                content: undefined,
                calls: 0,
                stops: 0
            };
            let nonce: string | undefined;
            const pipeline = await activateTargetPermitMediation({
                aggregate,
                scope: "sqlite-target-permit",
                worker: new ClaimWorkerId("sqlite-target-worker"),
                authority: new DemoAuthorityState(),
                manifests: [manifest()],
                roots: [new MemoryFacet(observed)],
                activations,
                expectations: new DeniedPermitExpectations(),
                authorityRequests: new DeniedPermitRequests(),
                issuanceTransport: new DeniedPermitTransport(),
                authenticator: new AuthorityPermitAuthenticator(new MissingIssuedPermits()),
                permitNonce: (_invocation, claim) => {
                    nonce = claim.id.value;
                    return claim.id.value;
                },
                permitLifetimeMilliseconds: 60_000,
                finalAdmission: new SqlitePermitFinalAdmission(),
                content: new MemoryContentStore(),
                events: { publish: async () => undefined },
                commits: { append: async () => undefined },
                claimLifetimeMilliseconds: 60_000,
                now: () => new Date(2_000)
            });

            await expect(pipeline.invocations.invoke(invocationRequest())).rejects.toMatchObject({
                code: "authority.denied"
            });
            if (nonce === undefined) throw new TypeError("Expected target permit nonce");
            const permitNonce = nonce;
            const stored = aggregate.transact((transaction) => ({
                attempts: transaction.all("SELECT id FROM invocation_effect_attempts", []),
                audits: transaction.all("SELECT id FROM protocol_audit_records", []),
                denial: aggregate.permitDenials.denied(transaction, permitNonce),
                receipts: transaction.all("SELECT variant, outcome FROM invocation_receipts", []),
                watermarks: transaction.all(
                    "SELECT watermark_key FROM actor_invalidation_watermarks",
                    []
                )
            }));

            expect(stored.attempts).toEqual([]);
            expect(stored.receipts).toEqual([{ variant: "preEffect", outcome: "deniedPreEffect" }]);
            expect(stored.audits).toHaveLength(2);
            expect(stored.denial?.request.nonce).toBe(permitNonce);
            expect(stored.denial?.evidence.allowed).toBe(false);
            expect(stored.watermarks).toHaveLength(1);
            expect(invalidations.calls).toBe(1);
            expect(observed.calls).toBe(0);
            await pipeline.dispose();
        }
    );

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

    it(
        "[C13-TURN-ADMISSION-HANDLE] offers the verified admission identity at the executor boundary without changing admission",
        { tags: "p0" },
        async () => {
            const value = await harness();
            const result = await value.pipeline.invocations.invoke(invocationRequest());
            if (result.tier !== "mediated") throw new TypeError("expected the mediated tier");

            const state = value.transactions.read();
            const codecs = mediationInvocationCodecs(admissionCodec);
            const prepared = [...state.prepared.values()].map((bytes) =>
                PreparedInvocation.decode(bytes, mediationPreparedCodecs)
            );
            const attempts = [...state.attempts.values()].map((bytes) =>
                codecs.attempt.decode(bytes)
            );
            const receipts = [...state.receipts.values()].map((bytes) => Receipt.decode(bytes));
            const audits = [...state.audits.values()].map((bytes) => AuditRecord.decode(bytes));

            // §5.6: nothing about admission changes when a handle is offered. The record
            // counts and the linked Receipt and audit chain are exactly the unhandled call's.
            expect([prepared.length, attempts.length, receipts.length, audits.length]).toEqual([
                1, 1, 1, 3
            ]);
            const invocation = prepared[0]!;
            const attempt = attempts[0]!;
            const receipt = receipts[0]!;
            if (!(receipt instanceof AttemptReceipt)) {
                throw new TypeError("expected an attempt Receipt");
            }
            expect(receipt.attempt.equals(attempt.id)).toBe(true);
            expect(receipt.outcome).toBe("succeeded");
            const receiptAudit = audits.find((record) => record.kind.kind === "receipt")!;
            expect(
                receiptAudit.cause?.equals(
                    audits.find((record) => record.kind.kind === "attempt")!.id
                )
            ).toBe(true);

            // Every field of the handle is a record this pipeline wrote, and the identity the
            // model would read in the tool position is the Invocation's — not the output.
            const handle = result.admission;
            expect(handle.invocation.equals(invocation.header.id)).toBe(true);
            expect(handle.attempt.equals(attempt.id)).toBe(true);
            expect(handle.receipt.equals(receipt.id)).toBe(true);
            expect(handle.itemIndex).toBe(attempt.itemIndex);
            expect(handle.itemKey).toBe(attempt.idempotencyKey);
            expect(handle.turn.equals(turnId)).toBe(true);
            expect(handle.run.equals(runId)).toBe(true);
            expect(handle.issuedEpoch).toBe(token.epoch);
            expect(handle.result.equals(receipt.result!.digest)).toBe(true);
            expect(handle.toolPosition()).toEqual({ invocation: invocation.header.id.value });
            expect(handle.identity.childRun).toBeUndefined();

            // The handle survives its process as bytes and decodes to the same identity.
            expect(
                TurnAdmissionHandleCodec.decode(TurnAdmissionHandleCodec.encode(handle))
            ).toEqual(handle);
            await value.pipeline.dispose();
        }
    );

    it(
        "[C13-TURN-ADMISSION-HANDLE] carries the child RunRef for a delegate spawn and never the child's result",
        { tags: "p0" },
        async () => {
            const value = await harness();
            const result = await value.pipeline.invocations.invoke(spawnRequest());
            if (result.tier !== "mediated") throw new TypeError("expected the mediated tier");

            const receipts = [...value.transactions.read().receipts.values()].map((bytes) =>
                Receipt.decode(bytes)
            );
            const receipt = receipts[0]!;
            if (!(receipt instanceof AttemptReceipt)) {
                throw new TypeError("expected an attempt Receipt");
            }

            // The Receipt's canonical result content is the child RunRef alone, and that is
            // what the handle names. Nothing of the child's own outcome is in it.
            const stored = await value.content.get(receipt.result!);
            expect(JSON.parse(new TextDecoder().decode(stored))).toEqual({
                run: childRunId.value
            });
            expect(result.admission.identity.childRun?.equals(childRunId)).toBe(true);
            expect(result.admission.toolPosition()).toEqual({ run: childRunId.value });
            expect(result.admission.address).toBe(`run:${childRunId.value}`);
            await value.pipeline.dispose();
        }
    );

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

    it.each(["provider", "dynamic"] as const)(
        "[C13-AUTH-RESOLUTION-LIFETIME] [C13-FACET-DISPOSAL] releases a %s resolution before resolving the next invocation",
        { tags: "p0" },
        async (placement) => {
            const value = await harness();
            value.authority.remotePlacement = placement;

            await value.pipeline.invocations.invoke(invocationRequest(undefined, `${placement}-1`));
            expect([value.authority.resolutions, value.authority.releases]).toEqual([1, 1]);

            await value.pipeline.invocations.invoke(invocationRequest(undefined, `${placement}-2`));
            expect([value.authority.resolutions, value.authority.releases]).toEqual([2, 2]);
            await value.pipeline.dispose();
        }
    );

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

    it(
        "classifies an unconfirmed attempt failure against the domain hosting the target",
        { tags: "p1" },
        async () => {
            // §7.4: the host owns the boundary questions. A raised failure the callee did
            // not confirm leaves nothing to name while the domain still answers for the
            // target, and the Receipt says exactly that rather than manufacturing a kind.
            const value = await harness();
            value.observed.fail = () => {
                throw new TypeError("recall raised");
            };

            await expect(value.pipeline.invocations.invoke(invocationRequest())).rejects.toThrow();

            const receipt = storedAttemptReceipt(value);
            expect(receipt.outcome).toBe("indeterminate");
            expect(receipt.failure).toBeUndefined();
            await value.pipeline.dispose();
        }
    );

    it(
        "names domainLost once the runtime stops answering for the target Facet",
        { tags: "p1" },
        async () => {
            // The witness is the pipeline's own Facet runtime hosting that exact Facet, so a
            // disposal racing an in-flight attempt is the boundary §7.4's domainLost names.
            const value = await harness();
            const disposal: Promise<void>[] = [];
            value.observed.fail = () => {
                disposal.push(value.pipeline.dispose());
                throw new TypeError("recall raised while the host was stopping");
            };

            await expect(value.pipeline.invocations.invoke(invocationRequest())).rejects.toThrow();

            const receipt = storedAttemptReceipt(value);
            expect(receipt.outcome).toBe("failed");
            expect(receipt.failure?.kind).toBe("domainLost");
            await Promise.all(disposal);
        }
    );

    it(
        "[C13-RECEIPT-FAILURE-ORTHOGONAL] projects each stored Receipt shape the admission verifier refuses",
        { tags: "p1" },
        async () => {
            // One transaction's records answer three different questions, and each answer
            // refuses on its own behalf: a Receipt that is not stored at all, one that
            // reached no EffectAttempt, one whose EffectAttempt is missing, and one that
            // did not succeed. None of them can be read as an admitted item.
            const refusals: readonly (readonly [string, (records: ProjectedRecords) => void])[] = [
                [
                    "Admission evidence names no stored Receipt",
                    (records) => (records.substitute = () => undefined)
                ],
                [
                    "Admission Receipt reached no EffectAttempt: deniedPreEffect",
                    (records) =>
                        (records.substitute = (stored) =>
                            new PreEffectReceipt(
                                stored.id,
                                new InvocationId("pipeline-denied"),
                                0,
                                "deniedPreEffect",
                                stored.recordedAt,
                                "denied before any effect"
                            ))
                ],
                [
                    "which is not stored",
                    (records) => (records.hideAttempt = true)
                ],
                [
                    "did not succeed: indeterminate",
                    (records) =>
                        (records.substitute = (stored) =>
                            new AttemptReceipt(
                                stored.id,
                                stored.attempt,
                                AttemptCompletion.indeterminate,
                                undefined,
                                stored.recordedAt,
                                undefined
                            ))
                ],
                [
                    "did not succeed: succeeded",
                    (records) =>
                        (records.substitute = (stored) =>
                            new AttemptReceipt(
                                stored.id,
                                stored.attempt,
                                AttemptCompletion.succeeded,
                                undefined,
                                stored.recordedAt,
                                undefined
                            ))
                ]
            ];

            let ordinal = 0;
            for (const [refusal, tamper] of refusals) {
                ordinal += 1;
                const records = new ProjectedRecords(mediationInvocationCodecs(admissionCodec));
                const value = await harness(records);
                tamper(records);
                await expect(
                    value.pipeline.invocations.invoke(
                        invocationRequest(undefined, `projection-${ordinal}`)
                    )
                ).rejects.toThrow(refusal);
                await value.pipeline.dispose();
            }
        }
    );
});

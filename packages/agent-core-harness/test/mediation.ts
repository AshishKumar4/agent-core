import { ActorId, ActorRef } from "@agent-core/core/actors";
import {
    Binding,
    GrantId,
    InvalidationWatermark,
    PathEpochEvidence,
    ScopeEpoch
} from "@agent-core/core/authority";
import { MemoryContentStore } from "@agent-core/core/content";
import {
    CompatRange,
    Digest,
    JsonSchema,
    SemVer,
    encodeCanonicalJson,
    isJsonObject,
    type JsonValue
} from "@agent-core/core/core";
import { PackageId, PackagePin, PolicySet } from "@agent-core/core/definition";
import {
    BindingName,
    Contribution,
    Contributions,
    Facet,
    FacetManifest,
    FacetPackageId,
    Operation,
    OperationDescriptor,
    OperationName,
    ProtectionDomain,
    SlotName,
    type FacetData,
    type FacetRef,
    type OperationContext
} from "@agent-core/core/facets";
import { ScopeRef, SubjectRef, TenantId, WorkspaceId } from "@agent-core/core/identity";
import {
    AuthorityAdmissionReference,
    ClaimWorkerId,
    InvocationPlacementPin,
    MemoryInvocationMediationPersistence,
    MemoryInvocationPersistence,
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
} from "@agent-core/core/invocations";
import {
    MediatedOperationPipeline,
    mediationInvocationCodecs,
    type FacetActivationPin,
    type FacetActivationPinPort,
    type MediatedTurnCaller,
    type MediationAuthorityReference,
    type MediationDomainReference,
    type MediationLeaseReference,
    type MediationPathEpochReference,
    type MediationPreparedInvocation,
    type OperationAuthorityStatePort,
    type OperationResolutionCandidate
} from "@agent-core/core/mediation";
import { TurnLease, type LeaseToken } from "@agent-core/core/agents/runs";
import { ids } from "./fixture.js";

export type MediationState = InvocationMemoryState & InvocationMediationMemoryState;

/**
 * The one permit shape this demonstration issues. The Tenant authority permit plane is
 * not publicly constructible, so the demonstration supplies the permit, authentication,
 * and target-admission ports itself; every record the audit chain is made of still comes
 * from the production pipeline.
 */
export interface DemoAdmissionReference {
    readonly invocation: string;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
}

export const tenant = new TenantId("tenant-1");
export const workspace = new WorkspaceId("workspace-1");
export const owner = new ActorRef("run", new ActorId("run-1"));
export const domain = new ProtectionDomain("backend", "memory", "may-hold-secrets");
export const objectSchema = new JsonSchema({ type: "object" });
export const recallBinding = new BindingName("recall");

/** Byte-identical to the descriptor `boundOperation` binds, as the gateway requires. */
export function recallDescriptor(): OperationDescriptor {
    return new OperationDescriptor(
        new OperationName("recall"),
        "observe",
        objectSchema,
        objectSchema,
        "Perform recall."
    );
}

export function memoryManifest(): FacetManifest {
    return new FacetManifest({
        id: new FacetPackageId("memory"),
        version: new SemVer("1.0.0"),
        compat: CompatRange.any(),
        isolation: ["provider"],
        bindings: [],
        contributions: new Contributions([
            new Contribution(new SlotName("operations"), [recallDescriptor().toData()])
        ])
    });
}

class RecallOperation extends Operation {
    public readonly descriptor = recallDescriptor();

    public constructor(private readonly answers: ReadonlyMap<string, string>) {
        super();
    }

    public async execute(context: OperationContext, input: FacetData): Promise<FacetData> {
        const query = isFacetRecord(input) ? input["query"] : undefined;
        return {
            answer: this.answers.get(isFacetString(query) ? query : "") ?? "unknown",
            attempt: context.attempt?.id.value ?? null
        };
    }
}

export class MemoryFacet extends Facet {
    public readonly ref: FacetRef = ids.facet;
    public readonly manifest = memoryManifest();

    public constructor(private readonly answers: ReadonlyMap<string, string>) {
        super();
    }

    public operation(name: OperationName): Operation | undefined {
        return name.value === "recall" ? new RecallOperation(this.answers) : undefined;
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

export class MemoryMediationTransactions implements InvocationTransactionPort<MediationState> {
    #state: MediationState = {
        ...createInvocationMemoryState(),
        ...createInvocationMediationMemoryState()
    };

    public transact<Result>(operation: (transaction: MediationState) => Result): Result {
        const draft = this.clone();
        const result = operation(draft);
        this.#state = {
            ...cloneInvocationMemoryState(draft),
            ...cloneInvocationMediationMemoryState(draft)
        };
        return result;
    }

    /** Read-only view for assertions; never handed to the pipeline. */
    public read(): MediationState {
        return this.clone();
    }

    private clone(): MediationState {
        return {
            ...cloneInvocationMemoryState(this.#state),
            ...cloneInvocationMediationMemoryState(this.#state)
        };
    }
}

const placement = new InvocationPlacementPin({
    manifest: ["provider"],
    policy: ["provider"],
    substrate: ["provider"],
    trust: ["provider"],
    selected: "provider"
});

function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

export class DemoAuthorityState implements OperationAuthorityStatePort<MediatedTurnCaller> {
    public readonly binding = Binding.active(
        ScopeRef.workspace(tenant, workspace),
        SubjectRef.principal(ids.holder),
        domain,
        recallBinding,
        new GrantId("memory-recall-grant"),
        ids.facet
    );
    public readonly path = new PathEpochEvidence([
        ScopeEpoch.initial(ScopeRef.tenant(tenant)),
        ScopeEpoch.initial(ScopeRef.workspace(tenant, workspace))
    ]);
    public readonly watermark = InvalidationWatermark.empty(tenant, owner, ids.holder);
    public readonly lease: TurnLease;
    public staleObservations = 0;

    public constructor(private readonly token: LeaseToken) {
        this.lease = TurnLease.restore(token.turn, token.holder, token.epoch, new Date(500_000));
    }

    public resolve(caller: MediatedTurnCaller): OperationResolutionCandidate | undefined {
        if (
            !caller.token.turn.equals(this.token.turn) ||
            !caller.token.holder.equals(this.token.holder) ||
            caller.token.epoch !== this.token.epoch
        ) {
            return undefined;
        }
        return {
            principal: ids.holder,
            binding: this.binding,
            pathEpochs: this.path,
            watermark: this.watermark,
            lease: this.token,
            originalLease: this.lease,
            route: undefined,
            package: new PackagePin(
                new PackageId("memory"),
                new SemVer("1.0.0"),
                digest("f"),
                digest("1")
            ),
            placement,
            owner,
            policies: [new PolicySet({})],
            turnOwnedSession: false,
            sessionFilesystemTarget: false,
            // A dedicated Run Actor holds no local Binding projection, so §7.2 keeps
            // every Operation on the mediated tier.
            turnActorAuthorityLocal: false,
            directAuthority: undefined
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
        this.staleObservations += 1;
        throw new TypeError("Authority went stale during the demonstration");
    }
}

export const demoAdmissionCodec: StructuralCodec<DemoAdmissionReference> = Object.freeze({
    encode: (value: DemoAdmissionReference): JsonValue => ({
        attemptOrdinal: value.attemptOrdinal,
        invocation: value.invocation,
        itemIndex: value.itemIndex
    }),
    decode: (value: JsonValue): DemoAdmissionReference => {
        if (!isJsonObject(value)) {
            throw new TypeError("Admission reference must be an object");
        }
        const invocation = value["invocation"];
        const itemIndex = value["itemIndex"];
        const attemptOrdinal = value["attemptOrdinal"];
        if (
            !isJsonString(invocation) ||
            !isJsonNumber(itemIndex) ||
            !isJsonNumber(attemptOrdinal)
        ) {
            throw new TypeError("Admission reference fields are malformed");
        }
        return Object.freeze({ invocation, itemIndex, attemptOrdinal });
    }
});

function admissionDigest(reference: DemoAdmissionReference): Digest {
    return Digest.sha256(encodeCanonicalJson(demoAdmissionCodec.encode(reference)));
}

export class DemoPermits implements CanonicalBatchAuthorityPermitPort<
    MediationState,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmissionReference
> {
    public issued = 0;

    public async issue(
        invocation: MediationPreparedInvocation,
        claim: ItemClaim<MediationLeaseReference>
    ): Promise<{
        readonly kind: "issued";
        readonly admission: AuthorityAdmissionReference<DemoAdmissionReference>;
    }> {
        this.issued += 1;
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
        _transaction: MediationState,
        _invocation: MediationPreparedInvocation,
        _claim: ItemClaim<MediationLeaseReference>,
        _denial: never
    ): void {
        throw new TypeError("Demo authority permits do not produce authenticated denials");
    }
}

export class DemoPermitAuthentication implements CanonicalBatchAuthorityAuthenticationPort<
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmissionReference,
    undefined
> {
    public async authenticate(
        _invocation: MediationPreparedInvocation,
        _claim: ItemClaim<MediationLeaseReference>,
        admission: AuthorityAdmissionReference<DemoAdmissionReference>
    ): Promise<undefined> {
        if (!admissionDigest(admission.reference).equals(admission.digest)) {
            throw new TypeError("Admission reference digest does not bind its permit");
        }
        return undefined;
    }
}

export class DemoTargetAdmission implements AuthorityAdmissionPort<
    MediationState,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmissionReference,
    undefined
> {
    public admits(
        _transaction: MediationState,
        admission: AuthorityAdmissionReference<DemoAdmissionReference>,
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

export class DemoFinalAdmission implements CanonicalBatchFinalAdmissionPort<
    MediationState,
    never,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    DemoAdmissionReference
> {
    public admit(): CanonicalBatchFinalAdmissionResult {
        return { kind: "admitted" };
    }
}

export class DemoActivationPins implements FacetActivationPinPort {
    public pin(facet: FacetRef): FacetActivationPin | undefined {
        return facet.equals(ids.facet)
            ? {
                  configurationDigest: digest("2"),
                  runtimeDigest: digest("3"),
                  activationGeneration: "generation-1",
                  registration: "registration-1"
              }
            : undefined;
    }
}

export interface MediationHarness {
    readonly pipeline: MediatedOperationPipeline<MediationState, DemoAdmissionReference, undefined>;
    readonly transactions: MemoryMediationTransactions;
    readonly persistence: MemoryInvocationPersistence<
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        DemoAdmissionReference
    >;
    readonly evidence: MemoryInvocationMediationPersistence;
    readonly authority: DemoAuthorityState;
    readonly permits: DemoPermits;
    readonly observations: ReceiptObservation[];
}

export async function mediationHarness(
    token: LeaseToken,
    content: MemoryContentStore,
    answers: ReadonlyMap<string, string>
): Promise<MediationHarness> {
    const transactions = new MemoryMediationTransactions();
    const persistence = new MemoryInvocationPersistence(
        mediationInvocationCodecs(demoAdmissionCodec)
    );
    const evidence = new MemoryInvocationMediationPersistence();
    const authority = new DemoAuthorityState(token);
    const permits = new DemoPermits();
    const observations: ReceiptObservation[] = [];
    const pipeline = await MediatedOperationPipeline.activate<
        MediationState,
        DemoAdmissionReference,
        undefined
    >({
        scope: "run-1",
        actor: owner,
        tenant,
        worker: new ClaimWorkerId("worker-1"),
        transactions,
        persistence,
        evidence,
        authority,
        manifests: [memoryManifest()],
        roots: [new MemoryFacet(answers)],
        activations: new DemoActivationPins(),
        permits,
        authentication: new DemoPermitAuthentication(),
        admission: new DemoTargetAdmission(),
        finalAdmission: new DemoFinalAdmission(),
        content,
        events: {
            publish: async (_outboxId, observation) => {
                observations.push(observation);
            }
        },
        commits: {
            append: async (_outboxId, observation) => {
                observations.push(observation);
            }
        },
        claimLifetimeMilliseconds: 60_000,
        now: () => new Date(2_000)
    });
    return { pipeline, transactions, persistence, evidence, authority, permits, observations };
}

/** A JSON string is exactly the value that is its own string rendering. */
function isJsonString(value: JsonValue | undefined): value is string {
    return value === String(value);
}

/** JSON carries no NaN or infinity, so a finite value is exactly a JSON number. */
function isJsonNumber(value: JsonValue | undefined): value is number {
    return Number.isFinite(value);
}

function isFacetString(value: FacetData | undefined): value is string {
    return value === String(value);
}

/** A facet record is a non-primitive that is neither null nor a list of values. */
function isFacetRecord(value: FacetData): value is { readonly [key: string]: FacetData } {
    return value !== null && !Array.isArray(value) && value === Object(value);
}

import type { ActorRef } from "../actors";
import {
    GatewayTurnInvocationPort,
    TurnGatewaySource,
    type LeaseToken,
    type TurnGatewayScope,
    type TurnMediatedInvocationPort
} from "../agents";
import type { ContentStore } from "../content";
import type { Facet, FacetManifest } from "../facets";
import type { TenantId } from "../identity";
import {
    CanonicalBatchInvocationPort,
    InvocationLedger,
    InvocationPublicationDrainer,
    ReplayOperationInvocationPort,
    type AuthorityAdmissionPort,
    type CanonicalBatchAuthorityAuthenticationPort,
    type CanonicalBatchAuthorityPermitPort,
    type CanonicalBatchFinalAdmissionPort,
    type ClaimWorkerId,
    type InvocationCommitPort,
    type InvocationEventPort,
    type InvocationEvidencePersistence,
    type InvocationReplayPersistence,
    type InvocationTimePort,
    type InvocationTransactionPort
} from "../invocations";
import { FacetRuntimeHost, OperationGatewayHost } from "../operations/internal";
import type { OperationGateway } from "../operations";
import {
    MediatedAuthorityIntent,
    ResolutionStamp,
    TenantOperationAuthority,
    type OperationAuthorityStatePort
} from "./authority";
import { DerivedMediationIdentities } from "./mediation-identity";
import { DerivedDirectOperationContext } from "./mediation-execution";
import {
    CanonicalMediationPreparation,
    DerivedPreparationAdmission,
    leaseReferenceCodec,
    type FacetActivationPinPort,
    type MediationAuthorityReference,
    type MediationDomainReference,
    type MediationLeaseReference,
    type MediationPathEpochReference,
    type MediationPersistence
} from "./mediation-preparation";
import { CanonicalMediationRecords, MediationClaimOwnerAdmission } from "./mediation-records";

/**
 * The caller identity the authority plane resolves Bindings for. A Turn presents its
 * exact live lease and nothing else, so a resolver can require the exact current token
 * (§7.2) without the gateway handing it any other capability.
 */
export interface MediatedTurnCaller {
    readonly token: LeaseToken;
}

export interface MediatedOperationPipelineInit<Transaction, Admission, Authentication> {
    /** The replay scope: one Actor's mediated request-key namespace (§7.3). */
    readonly scope: string;
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    /**
     * The claim owner this worker incarnation is. Claim recovery requires a different
     * worker from the one whose claim expired, so a restarted worker presents a new one.
     */
    readonly worker: ClaimWorkerId;
    readonly transactions: InvocationTransactionPort<Transaction>;
    readonly persistence: MediationPersistence<Transaction, Admission>;
    readonly evidence: InvocationEvidencePersistence<Transaction> &
        InvocationReplayPersistence<Transaction>;
    readonly authority: OperationAuthorityStatePort<MediatedTurnCaller>;
    /** The pinned manifests and Facet roots to activate; correspondence is validated. */
    readonly manifests: readonly FacetManifest[];
    readonly roots: readonly Facet[];
    readonly activations: FacetActivationPinPort;
    readonly permits: CanonicalBatchAuthorityPermitPort<
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        Admission
    >;
    readonly authentication: CanonicalBatchAuthorityAuthenticationPort<
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        Admission,
        Authentication
    >;
    readonly admission: AuthorityAdmissionPort<
        Transaction,
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        Admission,
        Authentication
    >;
    readonly finalAdmission: CanonicalBatchFinalAdmissionPort<
        Transaction,
        MediatedAuthorityIntent,
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        Admission
    >;
    readonly content: ContentStore;
    readonly events: InvocationEventPort;
    readonly commits: InvocationCommitPort;
    readonly claimLifetimeMilliseconds: number;
    readonly now: () => Date;
}

/**
 * The composition root for SPEC §7 mediation.
 *
 * A consumer supplies the substrate — transactions, invocation and evidence persistence,
 * the authority state it resolves Bindings against, the activated Facet runtime, the
 * authority permit plane, and its target admission policy — and receives a
 * `TurnMediatedInvocationPort` it can hand straight to `TurnExecutorHost`, plus the
 * publication outbox that carries Receipt observations onward.
 *
 * It deliberately exposes none of its parts. `OperationGatewayHost` and
 * `FacetRuntimeHost` stay unexported because a consumer able to build a gateway by hand
 * is equally able to assemble one whose tiering, interception, replay, or evidence
 * wiring differs from the pipeline §7 describes, and nothing downstream would notice.
 * One narrow constructor keeps that assembly in a single place and still leaves every
 * genuine substrate decision with the consumer.
 *
 * The gateway and the invocation stack above it are built per Turn, because the Turn is
 * what owns the cancellation signal an Operation runs under. Nothing durable is
 * per-Turn: persistence, the ledger's ports, replay, and evidence are all shared, and
 * the only per-instance state is in-flight item deduplication, which is per Invocation
 * and therefore already per Turn — a mediated InvocationId commits the lease execution
 * identity, so two Turns never name the same one.
 */
export class MediatedOperationPipeline<
    Transaction,
    Admission,
    Authentication
> implements AsyncDisposable {
    public readonly invocations: TurnMediatedInvocationPort;
    public readonly outbox: InvocationPublicationDrainer<Transaction>;
    readonly #facets: FacetRuntimeHost;

    /**
     * Activates the pinned Facet runtime and assembles the pipeline around it. Activation
     * is the pipeline's because the gateway resolves Bindings against exactly the Facets
     * that correspondence validation admitted, and a half-activated runtime must never
     * become a mediation surface.
     */
    public static async activate<Transaction, Admission, Authentication>(
        init: MediatedOperationPipelineInit<Transaction, Admission, Authentication>
    ): Promise<MediatedOperationPipeline<Transaction, Admission, Authentication>> {
        const facets = new FacetRuntimeHost(init.manifests, init.roots);
        try {
            await facets.activate();
        } catch (error) {
            await facets.dispose();
            throw error;
        }
        return new MediatedOperationPipeline(init, facets);
    }

    private constructor(
        init: MediatedOperationPipelineInit<Transaction, Admission, Authentication>,
        facets: FacetRuntimeHost
    ) {
        this.#facets = facets;
        const identities = new DerivedMediationIdentities(init.scope);
        const ledger = new InvocationLedger<
            Transaction,
            MediationLeaseReference,
            MediationAuthorityReference,
            MediationDomainReference,
            MediationPathEpochReference,
            Admission,
            Authentication
        >(
            init.persistence,
            leaseReferenceCodec,
            new DerivedPreparationAdmission(identities),
            new FiniteInvocationTime(),
            new MediationClaimOwnerAdmission(),
            init.admission
        );
        this.outbox = new InvocationPublicationDrainer(
            init.transactions,
            init.evidence,
            init.events,
            init.commits,
            init.now
        );
        this.invocations = new GatewayTurnInvocationPort(
            new ComposedTurnGatewaySource(
                facets,
                new TenantOperationAuthority(init.authority, init.now),
                (signal) => operations(init, identities, ledger, signal)
            )
        );
    }

    public dispose(): Promise<void> {
        return this.#facets.dispose();
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }
}

type MediatedOperations<Transaction> = ReplayOperationInvocationPort<
    Transaction,
    ResolutionStamp,
    MediatedAuthorityIntent
>;

function operations<Transaction, Admission, Authentication>(
    init: MediatedOperationPipelineInit<Transaction, Admission, Authentication>,
    identities: DerivedMediationIdentities,
    ledger: InvocationLedger<
        Transaction,
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        Admission,
        Authentication
    >,
    signal: AbortSignal
): MediatedOperations<Transaction> {
    const resources = { signal, content: init.content };
    return new ReplayOperationInvocationPort(
        init.scope,
        init.transactions,
        init.evidence,
        identities,
        new DerivedDirectOperationContext<ResolutionStamp>(identities, () => resources),
        new CanonicalBatchInvocationPort<
            MediatedAuthorityIntent,
            Transaction,
            MediationLeaseReference,
            MediationAuthorityReference,
            MediationDomainReference,
            MediationPathEpochReference,
            Admission,
            Authentication
        >(
            init.transactions,
            init.persistence,
            ledger,
            new CanonicalMediationPreparation(
                identities,
                init.activations,
                init.transactions,
                init.persistence
            ),
            init.permits,
            init.authentication,
            new CanonicalMediationRecords(
                { actor: init.actor, tenant: init.tenant, worker: init.worker },
                identities,
                init.claimLifetimeMilliseconds
            ),
            init.finalAdmission,
            init.evidence,
            { resources: () => resources },
            init.now
        )
    );
}

class ComposedTurnGatewaySource<Transaction> extends TurnGatewaySource {
    public constructor(
        private readonly facets: FacetRuntimeHost,
        private readonly authority: TenantOperationAuthority<MediatedTurnCaller>,
        private readonly operations: (signal: AbortSignal) => MediatedOperations<Transaction>
    ) {
        super();
    }

    public async open(scope: TurnGatewayScope): Promise<OperationGateway> {
        return new OperationGatewayHost(
            Object.freeze({ token: scope.token }),
            this.facets,
            this.authority,
            this.operations(scope.signal)
        );
    }
}

/**
 * The ledger admits only valid instants. Nothing in §7 constrains mediation time beyond
 * that; a substrate with a narrower admissible window supplies its own port.
 */
class FiniteInvocationTime<Transaction> implements InvocationTimePort<Transaction> {
    public admits(_transaction: Transaction, time: Date): boolean {
        return Number.isFinite(time.getTime());
    }
}

import type { ActorRef } from "../actors";
import {
    GatewayTurnInvocationPort,
    TurnAdmissionRecordPort,
    TurnAdmissionVerifier,
    TurnGatewaySource,
    type LeaseToken,
    TurnAdmissionReceiptFacts,
    type RunInvocationDelivery,
    type TurnAdmissionHandle,
    type TurnGatewayScope,
    type TurnInvocationPort,
    type TurnBoundOperation,
    type TurnInvocationRequest
} from "../agents";
import { Digest, encodeCanonicalJson, type ContentRef } from "../core";
import type { ContentStore } from "../content";
import { AgentCoreError } from "../errors";
import { canonicalFacetData, type Facet, type FacetManifest } from "../facets";
import type { TenantId } from "../identity";
import {
    AdmittedInvocationItem,
    AlarmDetachedEffectDriver,
    AttemptReceipt,
    CanonicalBatchInvocationPort,
    DetachedEffectDeliveryPort,
    type CanonicalBatchAttemptResources,
    type CanonicalBatchInvocationRequest,
    InvocationLedger,
    InvocationPublicationDrainer,
    ReplayOperationInvocationPort,
    type AuthorityAdmissionPort,
    type CanonicalBatchAuthorityAuthenticationPort,
    type CanonicalBatchAuthorityPermitPort,
    type CanonicalBatchFinalAdmissionContext,
    type CanonicalBatchFinalAdmissionPort,
    type CanonicalBatchFinalAdmissionResult,
    type CanonicalBatchItemAdmission,
    type DetachedEffectExecutionPersistence,
    type EffectAttemptId,
    type DetachedEffectExecutionSource,
    type DetachedEffectSweepReport,
    type ClaimWorkerId,
    type InvocationId,
    type InvocationCommitPort,
    type InvocationEventPort,
    type InvocationEvidencePersistence,
    type InvocationReplayPersistence,
    type InvocationTimePort,
    type InvocationTransactionPort,
    type Receipt,
    type ReconciliationSchedulePort
} from "../invocations";
import type { ReceiptId } from "../invocation-references";
import { FacetRuntimeHost, OperationGatewayHost } from "../operations/internal";
import type {
    DetachedInvocationAdmissionPort,
    MediatedInvocationRequest,
    OperationGateway,
    OperationRequest,
    OperationRequestKey
} from "../operations";
import {
    MediatedAuthorityIntent,
    ResolutionStamp,
    TenantOperationAuthority,
    type OperationAuthorityStatePort,
    type OperationResolutionState
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
import { DetachedMediationTarget } from "./detached-target";

/**
 * The caller identity the authority plane resolves Bindings for. A Turn presents its
 * exact live lease and nothing else, so a resolver can require the exact current token
 * (§7.2) without the gateway handing it any other capability.
 */
export interface MediatedTurnCaller {
    readonly token: LeaseToken;
}

export interface MediatedOperationPipelineInit<
    Transaction,
    Admission,
    Authentication,
    Denial = never
> {
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
    /**
     * Where an item whose execution left its Turn is recorded (SPEC §5.6). It is its own store
     * because a host that detaches nothing needs no table for one, and because the record
     * carries neither a Lease nor an Admission to parameterize.
     */
    readonly detachedExecutions: DetachedEffectExecutionPersistence<Transaction>;
    /**
     * The detached driver's own durable schedule row. It is a second instance of the same
     * substrate contract the reconciliation driver uses and never the same row: two drivers
     * sharing one schedule would each clear the other's outstanding firing.
     */
    readonly detachedSchedule: ReconciliationSchedulePort;
    /** How long after a release the detached driver's next sweep is due. */
    readonly detachedIntervalMilliseconds: number;
    readonly evidence: InvocationEvidencePersistence<Transaction> &
        InvocationReplayPersistence<Transaction>;
    readonly authority: OperationAuthorityStatePort<MediatedTurnCaller>;
    /** The pinned manifests and Facet roots to activate; correspondence is validated. */
    readonly manifests: readonly FacetManifest[];
    readonly roots: readonly Facet[];
    readonly activations: FacetActivationPinPort;
    readonly permits: CanonicalBatchAuthorityPermitPort<
        Transaction,
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        Admission,
        Denial
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
 * `TurnInvocationPort` it can hand straight to `TurnExecutorHost`, plus the publication
 * outbox that carries Receipt observations onward.
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
 *
 * Detached execution is the one part that is deliberately not per Turn (SPEC §5.6). An item
 * whose admission identity a Turn published outlives that Turn, so the target, the delivery
 * seam, and the driver are built once for the process and carry no Turn's signal: cancelling
 * such an item is the owning Run's message, never the issuing Turn's fence. Admission stays
 * per Turn, because the Turn's own cancellation is exactly what decides which side of the
 * §5.6 commit point an item falls on.
 */
export class MediatedOperationPipeline<
    Transaction,
    Admission,
    Authentication,
    Denial = never
> implements AsyncDisposable {
    public readonly invocations: TurnInvocationPort;
    public readonly outbox: InvocationPublicationDrainer<Transaction>;
    readonly #facets: FacetRuntimeHost;
    readonly #gateways: ComposedTurnGatewaySource<Transaction, Admission, Authentication, Denial>;
    readonly #reserved: ReservedInvocations<Transaction>;
    readonly #admissions: TurnAdmissionVerifier;
    readonly #deliveries: DetachedEffectDeliveryPort<
        Transaction,
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        Admission,
        Authentication
    >;
    readonly #detached: AlarmDetachedEffectDriver;

    /**
     * Activates the pinned Facet runtime and assembles the pipeline around it. Activation
     * is the pipeline's because the gateway resolves Bindings against exactly the Facets
     * that correspondence validation admitted, and a half-activated runtime must never
     * become a mediation surface.
     */
    public static async activate<Transaction, Admission, Authentication, Denial = never>(
        init: MediatedOperationPipelineInit<Transaction, Admission, Authentication, Denial>
    ): Promise<MediatedOperationPipeline<Transaction, Admission, Authentication, Denial>> {
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
        init: MediatedOperationPipelineInit<Transaction, Admission, Authentication, Denial>,
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
        const records = new CanonicalMediationRecords<Admission>(
            { actor: init.actor, tenant: init.tenant, worker: init.worker },
            identities,
            init.claimLifetimeMilliseconds
        );
        this.outbox = new InvocationPublicationDrainer(
            init.transactions,
            init.evidence,
            init.events,
            init.commits,
            init.now
        );
        this.#admissions = new TurnAdmissionVerifier(
            new StoredAdmissionRecords(init.transactions, init.persistence, init.content)
        );
        this.#reserved = new ReservedInvocations(init.scope, init.transactions, init.evidence);
        this.#gateways = new ComposedTurnGatewaySource(
            facets,
            new TenantOperationAuthority(init.authority, init.now),
            (signal) => scopedMediation(init, identities, ledger, records, facets, signal)
        );
        this.invocations = new GatewayTurnInvocationPort(this.#gateways, this.#admissions);
        // The detached executor's signal never fires: a detached item runs under the
        // per-attempt controller its own target owns, and the batch port reads the resources
        // off the execution rather than off this instance.
        const executor = canonicalBatch(
            init,
            identities,
            ledger,
            records,
            facets,
            new AbortController().signal
        );
        this.#deliveries = new DetachedEffectDeliveryPort(
            init.transactions,
            init.persistence,
            init.detachedExecutions,
            ledger,
            records,
            init.evidence,
            new DetachedMediationTarget(facets, init.transactions, init.persistence, init.content),
            executor,
            init.now
        );
        this.#detached = new AlarmDetachedEffectDriver(
            this.#deliveries,
            new StoredDetachedEffectExecutions(
                init.transactions,
                init.persistence,
                init.detachedExecutions,
                ledger
            ),
            init.detachedSchedule,
            init.detachedIntervalMilliseconds,
            init.now
        );
    }

    /**
     * Admits one item of a Turn's mediated call and detaches its execution (SPEC §5.6).
     *
     * It is the same call `invoke` makes — the same gateway under the same Turn scope, the
     * same bound Operation check, the same authority, tiering and interception — stopped one
     * step earlier: the Invocation plane records the item's admission and runs nothing. That
     * is the fact §5.6's handle names and the fact a Receipt cannot state, which is why the
     * handle comes back from the admitted item rather than from Receipt evidence.
     *
     * An item refused before its effect answers with the pre-effect Receipt instead. Nothing
     * was detached in that case, so there is no handle to publish and no obligation for the
     * Run to take on.
     */
    public async admitDetached(request: TurnInvocationRequest): Promise<TurnDetachedAdmission> {
        const scoped = this.#gateways.host(
            Object.freeze({
                turn: request.turn,
                token: request.token,
                signal: request.signal
            })
        );
        const dispatch: OperationRequest = {
            requestKey: request.requestKey,
            operation: request.operation.descriptor.name,
            payload: { kind: "single", input: canonicalFacetData(request.input) }
        };
        const admission = await scoped.gateway.admitDetached(
            request.operation.binding,
            dispatch,
            SOLE_ITEM_INDEX,
            new BoundOperationAdmission(
                this.#facets,
                request.operation,
                scoped.batch,
                this.#reserved
            )
        );
        if (admission.kind === "terminal") {
            return Object.freeze({ kind: "terminal", receipt: admission.receipt });
        }
        return Object.freeze({
            kind: "admitted",
            handle: this.#admissions.admit(
                { run: request.turn.run, turn: request.turn.id, token: request.token },
                admission.item
            )
        });
    }

    /**
     * Accepts one durable message the Run owes this Invocation owner about a published item
     * (SPEC §5.6, §6.1).
     *
     * The Run's record carries the Run and the cause; neither crosses this seam. The Run is
     * the sender and says nothing about local state, and the cause is a request rather than a
     * verdict — so what travels is the exact item the message names, and this host re-reads
     * its own PreparedInvocation, item key, EffectAttempt and Receipt before it does anything.
     * A message naming state this host does not have raises `invocation.invalid`, which is the
     * signal to leave the Run's copy unacknowledged and redeliver.
     */
    public async accept(delivery: RunInvocationDelivery): Promise<void> {
        if (delivery.cause.kind === "admission") {
            const outcome = this.#deliveries.release(
                delivery.invocation,
                delivery.itemIndex,
                delivery.itemKey,
                delivery.attempt
            );
            // A release is the only message that creates work, so it is the only one that arms
            // the schedule. Arming after the durable transition, never before it.
            if (outcome.executable) this.#detached.arm();
            return;
        }
        await this.#deliveries.cancel(
            delivery.invocation,
            delivery.itemIndex,
            delivery.itemKey,
            delivery.attempt
        );
    }

    /**
     * Resumes detached execution from durable state, and reports when the next sweep is due.
     *
     * The HOST process owns restart. This pipeline holds no schedule of its own and revives
     * nothing on its own behalf: a host that has just started calls this once, and released
     * items whose sweep was lost to the restart are armed again from the records alone.
     *
     * The per-attempt AbortControllers are deliberately lost with the process. They are live
     * resources, and §8.3 keeps live resources off durable records, so there is nothing to
     * restore and nothing that pretends to be restored. That is exactly why a cancellation
     * arriving after a restart reports `absent`: no live effect was reached, so §7.4 leaves
     * the attempt `indeterminate` for reconciliation instead of recording an `aborted` failure
     * nobody observed.
     */
    public resumeDetachedEffects(): Date | undefined {
        return this.#detached.repair();
    }

    /**
     * One detached-effect alarm firing. The host owns the alarm — this pipeline holds no timer
     * — so a firing arrives here, executes the items the records say are released and
     * unfinished, and leaves the schedule armed exactly while any remain.
     */
    public sweepDetachedEffects(): Promise<DetachedEffectSweepReport> {
        return this.#detached.sweep();
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

type MediationCanonicalBatch<Transaction, Admission, Authentication, Denial> =
    CanonicalBatchInvocationPort<
        MediatedAuthorityIntent,
        Transaction,
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        Admission,
        Authentication,
        Denial
    >;

type MediationLedger<Transaction, Admission, Authentication> = InvocationLedger<
    Transaction,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    Admission,
    Authentication
>;

/** One Turn's mediated stack: what the gateway dispatches through, and what admits its items. */
interface ScopedMediation<Transaction, Admission, Authentication, Denial> {
    readonly operations: MediatedOperations<Transaction>;
    readonly batch: MediationCanonicalBatch<Transaction, Admission, Authentication, Denial>;
}

/** What one Turn-issued detached admission became (SPEC §5.6). */
export type TurnDetachedAdmission =
    | { readonly kind: "admitted"; readonly handle: TurnAdmissionHandle }
    | { readonly kind: "terminal"; readonly receipt: Receipt };

/** A Turn dispatches one item, so the detached branch always names the first and only one. */
const SOLE_ITEM_INDEX = 0;

function scopedMediation<Transaction, Admission, Authentication, Denial>(
    init: MediatedOperationPipelineInit<Transaction, Admission, Authentication, Denial>,
    identities: DerivedMediationIdentities,
    ledger: MediationLedger<Transaction, Admission, Authentication>,
    records: CanonicalMediationRecords<Admission>,
    facets: FacetRuntimeHost,
    signal: AbortSignal
): ScopedMediation<Transaction, Admission, Authentication, Denial> {
    const direct = { signal, content: init.content };
    const batch = canonicalBatch(init, identities, ledger, records, facets, signal);
    return Object.freeze({
        batch,
        operations: new ReplayOperationInvocationPort(
            init.scope,
            init.transactions,
            init.evidence,
            identities,
            new DerivedDirectOperationContext<ResolutionStamp>(identities, () => direct),
            batch
        )
    });
}

function canonicalBatch<Transaction, Admission, Authentication, Denial>(
    init: MediatedOperationPipelineInit<Transaction, Admission, Authentication, Denial>,
    identities: DerivedMediationIdentities,
    ledger: MediationLedger<Transaction, Admission, Authentication>,
    records: CanonicalMediationRecords<Admission>,
    facets: FacetRuntimeHost,
    signal: AbortSignal
): MediationCanonicalBatch<Transaction, Admission, Authentication, Denial> {
    /**
     * §7.4's `domainLost` is read off the domain hosting the target, so the witness is the
     * Facet runtime host's own hosting of that exact Facet — a disposed or replaced runtime
     * stops answering for it. The pipeline's scope signal is deliberately not used here: it
     * is the same signal `aborted` reads, and one signal cannot say which boundary closed.
     */
    const attemptResources = (
        request: CanonicalBatchInvocationRequest<MediatedAuthorityIntent>
    ): CanonicalBatchAttemptResources =>
        Object.freeze({
            signal,
            content: init.content,
            deadline: undefined,
            target: Object.freeze({
                answering: (): boolean => facets.facet(request.request.facet) !== undefined
            })
        });
    return new CanonicalBatchInvocationPort<
        MediatedAuthorityIntent,
        Transaction,
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference,
        Admission,
        Authentication,
        Denial
    >(
        init.transactions,
        init.persistence,
        init.detachedExecutions,
        ledger,
        new CanonicalMediationPreparation(
            identities,
            init.activations,
            init.transactions,
            init.persistence
        ),
        init.permits,
        init.authentication,
        records,
        new CancellationAwareFinalAdmission(init.finalAdmission, signal),
        init.evidence,
        { resources: attemptResources },
        init.now
    );
}

class ComposedTurnGatewaySource<
    Transaction,
    Admission,
    Authentication,
    Denial
> extends TurnGatewaySource {
    public constructor(
        private readonly facets: FacetRuntimeHost,
        private readonly authority: TenantOperationAuthority<MediatedTurnCaller>,
        private readonly mediation: (
            signal: AbortSignal
        ) => ScopedMediation<Transaction, Admission, Authentication, Denial>
    ) {
        super();
    }

    public async open(scope: TurnGatewayScope): Promise<OperationGateway> {
        return this.host(scope).gateway;
    }

    /**
     * The same gateway `open` widens to the Turn contract, plus the batch port that Turn's
     * items commit through. The detached entry needs both: the concrete host, because
     * `OperationGateway` cannot name this pipeline's authorization type, and the exact batch
     * port whose final admission is gated on this Turn's own cancellation signal.
     */
    public host(
        scope: TurnGatewayScope
    ): ScopedTurnGateway<Transaction, Admission, Authentication, Denial> {
        const mediation = this.mediation(scope.signal);
        return Object.freeze({
            gateway: new OperationGatewayHost<
                MediatedTurnCaller,
                OperationResolutionState,
                ResolutionStamp,
                MediatedAuthorityIntent
            >(
                Object.freeze({ token: scope.token }),
                this.facets,
                this.authority,
                mediation.operations
            ),
            batch: mediation.batch
        });
    }
}

interface ScopedTurnGateway<Transaction, Admission, Authentication, Denial> {
    readonly gateway: OperationGatewayHost<
        MediatedTurnCaller,
        OperationResolutionState,
        ResolutionStamp,
        MediatedAuthorityIntent
    >;
    readonly batch: MediationCanonicalBatch<Transaction, Admission, Authentication, Denial>;
}

/**
 * The Turn seam's detached admission (SPEC §5.6).
 *
 * The gateway has already resolved the Binding, chosen the tier, run the interceptors, and
 * reserved the replay identity by the time this is called, so the request it presents carries
 * the resolved Facet and the descriptor that Facet actually declares. Checking those against
 * the Turn's bound Operation here is the same check `GatewayTurnInvocationPort` makes before a
 * dispatch, made from the one resolution rather than from a second one: a Binding that now
 * resolves elsewhere, or an Operation whose declared shape has moved, refuses before the item
 * is admitted rather than detaching work under an intent the Turn never bound.
 */
class BoundOperationAdmission<
    Transaction,
    Admission,
    Authentication,
    Denial
> implements DetachedInvocationAdmissionPort<MediatedAuthorityIntent, CanonicalBatchItemAdmission> {
    public constructor(
        private readonly facets: FacetRuntimeHost,
        private readonly bound: TurnBoundOperation,
        private readonly batch: MediationCanonicalBatch<
            Transaction,
            Admission,
            Authentication,
            Denial
        >,
        private readonly reserved: ReservedInvocations<Transaction>
    ) {}

    public admitDetached(
        request: MediatedInvocationRequest<MediatedAuthorityIntent>,
        itemIndex: number
    ): Promise<CanonicalBatchItemAdmission> {
        const runtime = this.facets.facet(request.facet);
        if (
            runtime === undefined ||
            !request.facet.equals(this.bound.facet) ||
            !runtime.manifest.id.equals(this.bound.operation.facet) ||
            !Digest.sha256(encodeCanonicalJson(request.descriptor.toData())).equals(
                Digest.sha256(encodeCanonicalJson(this.bound.descriptor.toData()))
            )
        ) {
            throw new AgentCoreError(
                "binding.invalid",
                "Resolved operation does not match the exact bound Turn Operation"
            );
        }
        return this.batch.admitDetachedItem(
            Object.freeze({
                invocation: this.reserved.invocation(request.requestKey),
                request
            }),
            itemIndex
        );
    }
}

/**
 * The InvocationId the mediated preflight already reserved for one request key (§7.3). A
 * detached admission mints nothing of its own: the reservation is what the replay plane
 * committed one step earlier, and an admission that cannot find it names a request key this
 * pipeline never prepared.
 */
class ReservedInvocations<Transaction> {
    public constructor(
        private readonly scope: string,
        private readonly transactions: InvocationTransactionPort<Transaction>,
        private readonly replays: InvocationReplayPersistence<Transaction>
    ) {}

    public invocation(requestKey: OperationRequestKey): InvocationId {
        const replay = this.transactions.transact((transaction) =>
            this.replays.replay(transaction, this.scope, requestKey.value)
        );
        if (replay?.invocation === undefined) {
            throw new AgentCoreError(
                "invocation.invalid",
                "A detached admission has no reserved prepared replay identity"
            );
        }
        return replay.invocation;
    }
}

/**
 * The released detached items this host still owes a Receipt (SPEC §5.6).
 *
 * "Released and unfinished" is one predicate over two owners: the released half is the
 * detachment record's state, and the unfinished half is the item's current Receipt, which §7.4
 * owns and §8.4 keeps in exactly one place. A released record therefore outlives its item's
 * Receipt, so a fixed window of records can be entirely finished work with unfinished work
 * behind it. The window widens until it either fills the caller's limit or has seen every
 * released record, which is what keeps a sweep from clearing its own schedule while work
 * remains.
 */
class StoredDetachedEffectExecutions<
    Transaction,
    Admission,
    Authentication
> implements DetachedEffectExecutionSource {
    public constructor(
        private readonly transactions: InvocationTransactionPort<Transaction>,
        private readonly persistence: MediationPersistence<Transaction, Admission>,
        private readonly detachedExecutions: DetachedEffectExecutionPersistence<Transaction>,
        private readonly ledger: MediationLedger<Transaction, Admission, Authentication>
    ) {}

    public released(limit: number): readonly AdmittedInvocationItem[] {
        return this.transactions.transact((transaction) => {
            let window = limit;
            for (;;) {
                const records = this.detachedExecutions.releasedDetachedExecutions(
                    transaction,
                    window
                );
                const items = records.flatMap((record) =>
                    this.unfinished(
                        transaction,
                        record.invocation,
                        record.itemIndex,
                        record.attempt
                    )
                );
                if (items.length >= limit || records.length < window) {
                    return Object.freeze(items.slice(0, limit));
                }
                window *= 2;
            }
        });
    }

    /**
     * The admitted item one released record names, and nothing where the item has finished or
     * where the records it is derived from are gone. A missing PreparedInvocation or
     * EffectAttempt is not this query's error to raise: the sweep would then stall on one
     * unreadable row instead of executing the work behind it, and reconciliation is what
     * answers for an attempt whose records cannot be read.
     */
    private unfinished(
        transaction: Transaction,
        invocation: InvocationId,
        itemIndex: number,
        attempt: EffectAttemptId
    ): readonly AdmittedInvocationItem[] {
        if (this.ledger.currentReceipt(transaction, invocation, itemIndex) !== undefined) return [];
        const prepared = this.persistence.prepared(transaction, invocation);
        const stage = this.persistence.attempt(transaction, attempt);
        if (prepared === undefined || stage === undefined) return [];
        return [AdmittedInvocationItem.derive(prepared, stage)];
    }
}

/**
 * Puts cancellation at the one synchronous boundary that either records an EffectAttempt or
 * refuses it (SPEC §5.6, §7.4).
 *
 * Admission is the commit point a §5.6 handle names, so the two sides of it answer different
 * questions: a Turn or Run lost before it leaves a `cancelledPreEffect` Receipt over an item
 * with no attempt, and nothing is detached; the same fact after it reaches the attempt instead,
 * where §7.4 names it `aborted`. Checking the signal here rather than earlier is what makes the
 * boundary exact — no permit, consent decision, or handler between this check and the attempt
 * append can turn a cancelled item into an admitted one.
 */
class CancellationAwareFinalAdmission<
    Transaction,
    Admission
> implements CanonicalBatchFinalAdmissionPort<
    Transaction,
    MediatedAuthorityIntent,
    MediationLeaseReference,
    MediationAuthorityReference,
    MediationDomainReference,
    MediationPathEpochReference,
    Admission
> {
    public constructor(
        private readonly delegate: CanonicalBatchFinalAdmissionPort<
            Transaction,
            MediatedAuthorityIntent,
            MediationLeaseReference,
            MediationAuthorityReference,
            MediationDomainReference,
            MediationPathEpochReference,
            Admission
        >,
        private readonly signal: AbortSignal
    ) {}

    public admit(
        transaction: Transaction,
        request: CanonicalBatchInvocationRequest<MediatedAuthorityIntent>,
        context: CanonicalBatchFinalAdmissionContext<
            MediationLeaseReference,
            MediationAuthorityReference,
            MediationDomainReference,
            MediationPathEpochReference,
            Admission
        >
    ): CanonicalBatchFinalAdmissionResult {
        if (this.signal.aborted) {
            return {
                kind: "cancelled",
                reason: "The owning Turn or Run was cancelled before effect admission"
            };
        }
        return this.delegate.admit(transaction, request, context);
    }
}

/**
 * Projects the §7.4 records a §5.6 admission handle is built from. It decides nothing: it
 * reports what the stored Receipt and its EffectAttempt say and resolves the result content,
 * and `TurnAdmissionVerifier` owns every rule about whether that evidence admits a handle.
 *
 * The three shapes it returns are the three questions the records answer, all read from data
 * this one transaction already holds: a pre-effect Receipt carries its own outcome and reason
 * and reached no attempt at all; an attempt Receipt that did not succeed carries its outcome
 * and, since `invocation.receipt` major 2, its failure kind; only a succeeded one carries
 * result content. Failure detail rides the non-admitting shapes as a refusal message and is
 * unreachable from what the verifier admits, so no admission decision can come to read
 * Receipt failure state (C13-RECEIPT-FAILURE-ORTHOGONAL).
 */
class StoredAdmissionRecords<Transaction, Admission> extends TurnAdmissionRecordPort {
    public constructor(
        private readonly transactions: InvocationTransactionPort<Transaction>,
        private readonly persistence: MediationPersistence<Transaction, Admission>,
        private readonly content: ContentStore
    ) {
        super();
    }

    public async receipt(receipt: ReceiptId): Promise<TurnAdmissionReceiptFacts | undefined> {
        return this.transactions.transact((transaction) => {
            const stored = this.persistence.receipt(transaction, receipt);
            if (stored === undefined) return undefined;
            if (!(stored instanceof AttemptReceipt)) {
                return TurnAdmissionReceiptFacts.preEffect(stored.outcome);
            }
            const stage = this.persistence.attempt(transaction, stored.attempt);
            if (stage === undefined) {
                return TurnAdmissionReceiptFacts.preEffect(
                    `Receipt names EffectAttempt ${stored.attempt.value}, which is not stored`
                );
            }
            const attempt = Object.freeze({
                id: stage.id,
                invocation: stage.invocation,
                itemIndex: stage.itemIndex,
                idempotencyKey: stage.idempotencyKey
            });
            if (stored.outcome !== "succeeded" || stored.result === undefined) {
                return TurnAdmissionReceiptFacts.unsucceeded(attempt, stored.outcome);
            }
            return TurnAdmissionReceiptFacts.succeeded(attempt, stored.result);
        });
    }

    public result(ref: ContentRef): Promise<Uint8Array> {
        return this.content.get(ref);
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

import type { ActorRef } from "../actors";
import type {
    AuthenticatedAuthorityPermit,
    AuthorityPermitAuthenticator,
    AuthorityPermitTargetAdmissionStore,
    AuthorityPermitTargetDenialStore,
    AuthorityPermitTargetRequestStore,
    ScopeEpoch
} from "../authority";
import { StoredAuthorityPermitAdmissionPort } from "../authority";
import type { TenantId, PrincipalRef } from "../identity";
import type {
    InvocationEvidencePersistence,
    InvocationReplayPersistence,
    InvocationTransactionPort
} from "../invocations";
import type { AuthorityPermitExpectation } from "../authority";
import {
    ConsumedAuthorityAdmissionPort,
    IssuedAuthorityPermitPort,
    TargetAuthorityPermitAuthenticationPort,
    TargetAuthorityPermitDenialPort,
    type AuthenticatedAuthorityPermitDenial,
    type AuthorityCheckRequestFactory,
    type AuthorityPermitExpectationFactory,
    type AuthorityPermitIssuanceTransport,
    type AuthorityPermitReference
} from "./permit";
import { MediatedOperationPipeline, type MediatedOperationPipelineInit } from "./mediation";
import type {
    MediationAuthorityReference,
    MediationDomainReference,
    MediationLeaseReference,
    MediationPathEpochReference,
    MediationPersistence
} from "./mediation-preparation";

/** One target Actor's transaction-bound mediation and distributed-permit state. */
export abstract class TargetPermitMediationAggregate<
    Transaction
> implements InvocationTransactionPort<Transaction> {
    public abstract readonly actor: ActorRef;
    public abstract readonly tenant: TenantId;
    public abstract readonly persistence: MediationPersistence<
        Transaction,
        AuthorityPermitReference
    >;
    public abstract readonly evidence: InvocationEvidencePersistence<Transaction> &
        InvocationReplayPersistence<Transaction>;
    public abstract readonly permitRequests: AuthorityPermitTargetRequestStore<Transaction>;
    public abstract readonly permitDenials: AuthorityPermitTargetDenialStore<Transaction>;
    public abstract readonly permitAdmission: AuthorityPermitTargetAdmissionStore<Transaction>;

    public abstract transact<Result>(operation: (transaction: Transaction) => Result): Result;
    public abstract joinDeniedEpochs(
        transaction: Transaction,
        principal: PrincipalRef,
        entries: readonly ScopeEpoch[]
    ): void;
    public abstract invalidateResolution(
        transaction: Transaction,
        expectation: AuthorityPermitExpectation
    ): void;
}

type TargetPermitPipelineBaseInit<Transaction> = Omit<
    MediatedOperationPipelineInit<
        Transaction,
        AuthorityPermitReference,
        AuthenticatedAuthorityPermit,
        AuthenticatedAuthorityPermitDenial
    >,
    | "actor"
    | "tenant"
    | "transactions"
    | "persistence"
    | "evidence"
    | "permits"
    | "authentication"
    | "admission"
>;

export interface TargetPermitMediationPipelineInit<
    Transaction
> extends TargetPermitPipelineBaseInit<Transaction> {
    readonly aggregate: TargetPermitMediationAggregate<Transaction>;
    readonly expectations: AuthorityPermitExpectationFactory<
        Transaction,
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference
    >;
    readonly authorityRequests: AuthorityCheckRequestFactory<
        MediationLeaseReference,
        MediationAuthorityReference,
        MediationDomainReference,
        MediationPathEpochReference
    >;
    readonly issuanceTransport: AuthorityPermitIssuanceTransport;
    readonly authenticator: AuthorityPermitAuthenticator;
    readonly permitNonce: (
        invocation: Parameters<
            AuthorityCheckRequestFactory<
                MediationLeaseReference,
                MediationAuthorityReference,
                MediationDomainReference,
                MediationPathEpochReference
            >["forClaim"]
        >[0],
        claim: Parameters<
            AuthorityCheckRequestFactory<
                MediationLeaseReference,
                MediationAuthorityReference,
                MediationDomainReference,
                MediationPathEpochReference
            >["forClaim"]
        >[1]
    ) => string;
    readonly permitLifetimeMilliseconds: number;
}

/** The production assembly that prevents independently wired target permit stores. */
export async function activateTargetPermitMediation<Transaction>(
    init: TargetPermitMediationPipelineInit<Transaction>
): Promise<
    MediatedOperationPipeline<
        Transaction,
        AuthorityPermitReference,
        AuthenticatedAuthorityPermit,
        AuthenticatedAuthorityPermitDenial
    >
> {
    const target = init.aggregate;
    const denial = new TargetAuthorityPermitDenialPort(
        target.tenant,
        target.actor,
        target.permitDenials,
        target
    );
    const permits = new IssuedAuthorityPermitPort(
        target.permitRequests,
        init.expectations,
        denial,
        init.authorityRequests,
        init.issuanceTransport,
        init.permitNonce,
        init.now,
        init.permitLifetimeMilliseconds
    );
    const authentication = new TargetAuthorityPermitAuthenticationPort(
        init.authenticator,
        init.expectations
    );
    const admission = new ConsumedAuthorityAdmissionPort(
        new StoredAuthorityPermitAdmissionPort(target.permitAdmission),
        init.expectations,
        init.now
    );
    return MediatedOperationPipeline.activate({
        ...init,
        actor: target.actor,
        tenant: target.tenant,
        transactions: target,
        persistence: target.persistence,
        evidence: target.evidence,
        permits,
        authentication,
        admission
    });
}

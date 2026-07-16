// @ts-nocheck
import {
    AuthorityPermit,
    AuthorityPermitAdmissionPort,
    AuthorityPermitExpectation,
    AuthorityPermitIssuer,
    type AuthorityPermitOwnerStore
} from "../authority";
import { AgentCoreError } from "../errors";
import type { ItemClaim, PreparedInvocation } from "../invocations";
import {
    AuthorityAdmissionReference,
    type AuthorityAdmissionContext,
    type AuthorityAdmissionPort,
    type CanonicalBatchAuthorityPermitPort
} from "../invocations";

export type AuthorityPermitReference = ReturnType<AuthorityPermit["toData"]>;

export interface AuthorityPermitExpectationFactory<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs
> {
    forClaim(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>
    ): AuthorityPermitExpectation;
    forAdmission(
        transaction: Transaction,
        context: AuthorityAdmissionContext<Lease, Authority, Domain, PathEpochs>
    ): AuthorityPermitExpectation | undefined;
}

export interface AuthorityPermitDenialPort<Transaction> {
    deny(transaction: Transaction, expectation: AuthorityPermitExpectation | undefined): void;
}

export class IssuedAuthorityPermitPort<
    PermitTransaction,
    TargetTransaction,
    Lease,
    Authority,
    Domain,
    PathEpochs
> implements CanonicalBatchAuthorityPermitPort<
    Lease,
    Authority,
    Domain,
    PathEpochs,
    AuthorityPermitReference
> {
    public constructor(
        private readonly store: AuthorityPermitOwnerStore<PermitTransaction>,
        private readonly issuer: AuthorityPermitIssuer<PermitTransaction>,
        private readonly expectations: AuthorityPermitExpectationFactory<
            TargetTransaction,
            Lease,
            Authority,
            Domain,
            PathEpochs
        >,
        private readonly nonce: (
            invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
            claim: ItemClaim<Lease>
        ) => string,
        private readonly now: () => Date,
        private readonly lifetimeMilliseconds: number
    ) {
        if (!Number.isSafeInteger(lifetimeMilliseconds) || lifetimeMilliseconds <= 0) {
            throw new TypeError("Authority permit lifetime must be a positive safe integer");
        }
    }

    public async issue(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>
    ): Promise<AuthorityAdmissionReference<AuthorityPermitReference>> {
        const expectation = this.expectations.forClaim(invocation, claim);
        const issuedAt = this.now();
        const expiresAt = new Date(issuedAt.getTime() + this.lifetimeMilliseconds);
        const permit = this.store.transaction((transaction) =>
            this.issuer.issue(
                transaction,
                expectation,
                this.nonce(invocation, claim),
                issuedAt,
                expiresAt
            )
        );
        return new AuthorityAdmissionReference(permit.toData(), permit.digest());
    }
}

export class ConsumedAuthorityAdmissionPort<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs
> implements AuthorityAdmissionPort<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    AuthorityPermitReference
> {
    public constructor(
        private readonly admission: AuthorityPermitAdmissionPort<Transaction>,
        private readonly expectations: AuthorityPermitExpectationFactory<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs
        >,
        private readonly denial: AuthorityPermitDenialPort<Transaction>,
        private readonly now: () => Date
    ) {}

    public admits(
        transaction: Transaction,
        admission: AuthorityAdmissionReference<AuthorityPermitReference>,
        context: AuthorityAdmissionContext<Lease, Authority, Domain, PathEpochs>
    ): boolean {
        const expected = this.expectations.forAdmission(transaction, context);
        let permit: AuthorityPermit;
        try {
            permit = AuthorityPermit.fromData(admission.reference);
        } catch {
            this.denial.deny(transaction, expected);
            return false;
        }
        if (expected === undefined || !permit.digest().equals(admission.digest)) {
            this.denial.deny(transaction, expected);
            return false;
        }
        try {
            this.admission.consume(transaction, permit, expected, this.now());
        } catch (error) {
            if (!(error instanceof AgentCoreError) || error.code !== "authority.denied") {
                throw error;
            }
            this.denial.deny(transaction, expected);
            return false;
        }
        return true;
    }
}

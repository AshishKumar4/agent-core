import {
    AuthorityPermit,
    AuthorityPermitAdmissionPort,
    AuthorityPermitAuthenticator,
    AuthorityPermitExpectation,
    AuthorityPermitIssuer,
    type AuthenticatedAuthorityPermit,
    type AuthorityPermitOwnerStore
} from "../authority";
import { AgentCoreError } from "../errors";
import type { ItemClaim, PreparedInvocation } from "../invocations";
import {
    AuthorityAdmissionReference,
    type AuthorityAdmissionContext,
    type AuthorityAdmissionPort,
    type CanonicalBatchAuthorityAuthenticationPort,
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

    public issue(
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
        return Promise.resolve(new AuthorityAdmissionReference(permit.toData(), permit.digest()));
    }
}

export class TargetAuthorityPermitAuthenticationPort<
    TargetTransaction,
    Lease,
    Authority,
    Domain,
    PathEpochs
> implements CanonicalBatchAuthorityAuthenticationPort<
    Lease,
    Authority,
    Domain,
    PathEpochs,
    AuthorityPermitReference,
    AuthenticatedAuthorityPermit
> {
    public constructor(
        private readonly authenticator: AuthorityPermitAuthenticator,
        private readonly expectations: AuthorityPermitExpectationFactory<
            TargetTransaction,
            Lease,
            Authority,
            Domain,
            PathEpochs
        >
    ) {}

    public async authenticate(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        admission: AuthorityAdmissionReference<AuthorityPermitReference>
    ): Promise<AuthenticatedAuthorityPermit> {
        let permit: AuthorityPermit;
        try {
            permit = AuthorityPermit.fromData(admission.reference);
        } catch {
            throw denied("Authority permit reply is malformed");
        }
        if (!permit.digest().equals(admission.digest)) {
            throw denied("Authority permit reply digest does not match its canonical record");
        }
        return this.authenticator.authenticate(
            permit,
            this.expectations.forClaim(invocation, claim)
        );
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
    AuthorityPermitReference,
    AuthenticatedAuthorityPermit
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
        context: AuthorityAdmissionContext<Lease, Authority, Domain, PathEpochs>,
        authentication?: AuthenticatedAuthorityPermit
    ): boolean {
        const expected = this.expectations.forAdmission(transaction, context);
        let permit: AuthorityPermit;
        try {
            permit = AuthorityPermit.fromData(admission.reference);
        } catch {
            this.denial.deny(transaction, expected);
            return false;
        }
        if (
            expected === undefined ||
            authentication === undefined ||
            !permit.digest().equals(admission.digest)
        ) {
            this.denial.deny(transaction, expected);
            return false;
        }
        try {
            this.admission.consume(transaction, authentication, permit, expected, this.now());
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

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

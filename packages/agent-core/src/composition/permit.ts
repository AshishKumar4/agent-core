import {
    AuthorityPermit,
    AuthorityPermitAdmissionPort,
    AuthorityPermitAuthenticator,
    AuthorityPermitExpectation,
    AuthorityCheckEvidence,
    InvalidationWatermark,
    TargetAuthorityPermitRequest,
    watermarkKey,
    type AuthorityCheckRequest,
    type AuthenticatedAuthorityPermit,
    type AuthorityPermitTargetStore,
    type InvalidationWatermarkStore
} from "../authority";
import { AgentCoreError } from "../errors";
import type { ActorRef } from "../actors";
import type { ItemClaim, PreparedInvocation } from "../invocations";
import type { PrincipalRef, TenantId } from "../identity";
import {
    AuthorityAdmissionReference,
    type AuthorityAdmissionContext,
    type AuthorityAdmissionPort,
    type CanonicalBatchAuthorityAuthenticationPort,
    type CanonicalBatchAuthorityPermitPort
} from "../invocations";
import { AuthorityPermitIssuanceReply, AuthorityPermitIssuanceRequest } from "../protocol";

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
    deny(
        transaction: Transaction,
        expectation: AuthorityPermitExpectation | undefined,
        evidence: AuthorityCheckEvidence | undefined
    ): void;
}

export interface TargetAuthorityPermitDenialState<Transaction> {
    watermarks(transaction: Transaction): InvalidationWatermarkStore;
    invalidateResolution(transaction: Transaction, expectation: AuthorityPermitExpectation): void;
}

export class TargetAuthorityPermitDenialPort<
    Transaction
> implements AuthorityPermitDenialPort<Transaction> {
    public constructor(
        private readonly tenant: TenantId,
        private readonly owner: ActorRef,
        private readonly state: TargetAuthorityPermitDenialState<Transaction>
    ) {
        if (owner.kind === "tenant") {
            throw new TypeError("Target authority denial owner must be a non-Tenant Actor");
        }
    }

    public deny(
        transaction: Transaction,
        expectation: AuthorityPermitExpectation | undefined,
        evidence: AuthorityCheckEvidence | undefined
    ): void {
        if (expectation === undefined || evidence === undefined || evidence.allowed) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Target authority denial requires exact denied Tenant evidence"
            );
        }
        if (
            !expectation.tenant.equals(this.tenant) ||
            !expectation.target.actor.equals(this.owner) ||
            !expectation.principal.tenantId.equals(this.tenant) ||
            !evidence.issuerTenant.equals(this.tenant) ||
            !evidence.issuer.equals(expectation.issuer)
        ) {
            throw denied("Target authority denial evidence has the wrong owner");
        }
        this.join(transaction, expectation.principal, evidence);
        this.state.invalidateResolution(transaction, expectation);
    }

    private join(
        transaction: Transaction,
        principal: PrincipalRef,
        evidence: AuthorityCheckEvidence
    ): void {
        const watermarks = this.state.watermarks(transaction);
        const empty = InvalidationWatermark.empty(this.tenant, this.owner, principal);
        const stored = watermarks.load(watermarkKey(empty));
        const current = stored ?? empty;
        if (
            !current.ownerTenant.equals(this.tenant) ||
            !current.owner.equals(this.owner) ||
            !current.holder.equals(principal)
        ) {
            throw new AgentCoreError(
                "codec.invalid",
                "Target authority denial watermark has the wrong owner"
            );
        }
        const joined = current.join(evidence.pathEpochs.path);
        if (stored === undefined) watermarks.save(current);
        if (joined !== current) watermarks.save(joined);
    }
}

export interface AuthorityCheckRequestFactory<Lease, Authority, Domain, PathEpochs> {
    forClaim(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        nonce: string
    ): AuthorityCheckRequest;
}

export abstract class AuthorityPermitIssuanceTransport {
    public abstract issue(request: Uint8Array): Promise<Uint8Array>;
}

export class AuthenticatedAuthorityPermitDenial {
    readonly #request: TargetAuthorityPermitRequest;
    readonly #evidence: AuthorityCheckEvidence;

    public constructor(
        authority: symbol,
        request: TargetAuthorityPermitRequest,
        evidence: AuthorityCheckEvidence
    ) {
        if (authority !== denialAuthenticationAuthority || evidence.allowed) {
            throw new TypeError("Authority permit denial requires authenticated Tenant evidence");
        }
        this.#request = TargetAuthorityPermitRequest.decode(
            TargetAuthorityPermitRequest.encode(request)
        );
        this.#evidence = AuthorityCheckEvidence.decode(AuthorityCheckEvidence.encode(evidence));
        Object.freeze(this);
    }

    public request(): TargetAuthorityPermitRequest {
        return TargetAuthorityPermitRequest.decode(
            TargetAuthorityPermitRequest.encode(this.#request)
        );
    }

    public evidence(): AuthorityCheckEvidence {
        return AuthorityCheckEvidence.decode(AuthorityCheckEvidence.encode(this.#evidence));
    }
}

const denialAuthenticationAuthority = Symbol("authority-permit-denial-authentication");

export class IssuedAuthorityPermitPort<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs
> implements CanonicalBatchAuthorityPermitPort<
    Transaction,
    Lease,
    Authority,
    Domain,
    PathEpochs,
    AuthorityPermitReference,
    AuthenticatedAuthorityPermitDenial
> {
    public constructor(
        private readonly store: AuthorityPermitTargetStore<Transaction>,
        private readonly expectations: AuthorityPermitExpectationFactory<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs
        >,
        private readonly denial: AuthorityPermitDenialPort<Transaction>,
        private readonly authority: AuthorityCheckRequestFactory<
            Lease,
            Authority,
            Domain,
            PathEpochs
        >,
        private readonly transport: AuthorityPermitIssuanceTransport,
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
    ): Promise<
        | {
              readonly kind: "issued";
              readonly admission: AuthorityAdmissionReference<AuthorityPermitReference>;
          }
        | {
              readonly kind: "denied";
              readonly denial: AuthenticatedAuthorityPermitDenial;
              readonly reason: string;
          }
        | { readonly kind: "expired" }
    > {
        const nonce = this.nonce(invocation, claim);
        const persisted = this.store.transaction((transaction) => {
            const retained = this.store.requested(transaction, nonce);
            if (retained !== undefined) return retained;
            const createdAt = validTime(this.now(), "Authority permit request time");
            const claimExpiresAt = claim.expiresAt.getTime();
            if (claimExpiresAt <= createdAt) return undefined;
            if (claimExpiresAt - createdAt > this.lifetimeMilliseconds) {
                throw new TypeError("Item claim exceeds the authority permit lifetime");
            }
            return this.store.request(
                transaction,
                new TargetAuthorityPermitRequest(
                    this.expectations.forClaim(invocation, claim),
                    this.authority.forClaim(invocation, claim, nonce),
                    nonce,
                    claim.expiresAt
                )
            );
        });
        if (persisted === undefined) return Promise.resolve({ kind: "expired" });
        requireRetainedRequest(
            persisted,
            invocation,
            claim,
            nonce,
            this.expectations,
            this.authority
        );
        const observedAt = validTime(this.now(), "Authority permit request observation time");
        if (observedAt >= persisted.expiresAt.getTime()) {
            return Promise.resolve({ kind: "expired" });
        }
        const payload = AuthorityPermitIssuanceRequest.encode(
            new AuthorityPermitIssuanceRequest(persisted)
        );
        return this.transport.issue(payload).then((replyBytes) => {
            const reply = AuthorityPermitIssuanceReply.decode(replyBytes);
            const receivedAt = this.now();
            requireIssuanceEvidence(reply.evidence, persisted, receivedAt);
            if (reply.kind === "denied") {
                return {
                    kind: "denied",
                    denial: new AuthenticatedAuthorityPermitDenial(
                        denialAuthenticationAuthority,
                        persisted,
                        reply.evidence
                    ),
                    reason: `Tenant authority denied permit issuance: ${reply.evidence.reason}`
                };
            }
            const permit = reply.requirePermit();
            requireIssuedPermit(permit, persisted, receivedAt);
            return {
                kind: "issued",
                admission: new AuthorityAdmissionReference(permit.toData(), permit.digest())
            };
        });
    }

    public deny(
        transaction: Transaction,
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        denial: AuthenticatedAuthorityPermitDenial
    ): void {
        const request = denial.request();
        const evidence = denial.evidence();
        const retained = this.store.requested(transaction, request.nonce);
        if (
            retained === undefined ||
            !retained.digest().equals(request.digest()) ||
            !request.expectation.equals(this.expectations.forClaim(invocation, claim)) ||
            !evidence.binds(request.authority) ||
            evidence.allowed
        ) {
            throw denied(
                "Authenticated authority denial does not bind the retained target request"
            );
        }
        this.denial.deny(transaction, request.expectation, evidence);
    }
}

function requireRetainedRequest<Transaction, Lease, Authority, Domain, PathEpochs>(
    request: TargetAuthorityPermitRequest,
    invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
    claim: ItemClaim<Lease>,
    nonce: string,
    expectations: AuthorityPermitExpectationFactory<
        Transaction,
        Lease,
        Authority,
        Domain,
        PathEpochs
    >,
    authority: AuthorityCheckRequestFactory<Lease, Authority, Domain, PathEpochs>
): void {
    if (
        request.nonce !== nonce ||
        !request.expectation.equals(expectations.forClaim(invocation, claim)) ||
        !request.authority.digest().equals(authority.forClaim(invocation, claim, nonce).digest()) ||
        request.expiresAt.getTime() !== claim.expiresAt.getTime()
    ) {
        throw denied("Retained authority permit request does not bind the current claim");
    }
}

function requireIssuanceEvidence(
    evidence: AuthorityCheckEvidence,
    request: TargetAuthorityPermitRequest,
    receivedAt: Date
): void {
    const receivedAtTime = validTime(receivedAt, "Authority permit response time");
    if (
        !evidence.binds(request.authority) ||
        !evidence.issuer.equals(request.expectation.issuer) ||
        !evidence.issuerTenant.equals(request.expectation.tenant) ||
        evidence.checkedAt.getTime() > receivedAtTime ||
        receivedAtTime >= request.expiresAt.getTime()
    ) {
        throw denied("Authority permit transport substituted the Tenant decision");
    }
}

function requireIssuedPermit(
    permit: AuthorityPermit,
    request: TargetAuthorityPermitRequest,
    receivedAt: Date
): void {
    const receivedAtTime = validTime(receivedAt, "Authority permit response time");
    // An exact earlier issuance may be replayed after response loss; a future or expired
    // response cannot belong to this completed transport call.
    if (
        !permit.expectation.equals(request.expectation) ||
        !permit.requestDigest.equals(request.digest()) ||
        permit.nonce !== request.nonce ||
        permit.expiresAt.getTime() !== request.expiresAt.getTime() ||
        permit.issuedAt.getTime() > receivedAtTime ||
        receivedAtTime >= permit.expiresAt.getTime()
    ) {
        throw denied("Authority permit transport substituted the target request");
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
            this.denial.deny(transaction, expected, undefined);
            return false;
        }
        if (
            expected === undefined ||
            authentication === undefined ||
            !permit.digest().equals(admission.digest)
        ) {
            this.denial.deny(transaction, expected, undefined);
            return false;
        }
        try {
            this.admission.consume(transaction, authentication, permit, expected, this.now());
        } catch (error) {
            if (!(error instanceof AgentCoreError) || error.code !== "authority.denied") {
                throw error;
            }
            this.denial.deny(transaction, expected, undefined);
            return false;
        }
        return true;
    }
}

function validTime(value: Date, subject: string): number {
    const time = value.getTime();
    if (!Number.isSafeInteger(time) || time < 0) {
        throw new TypeError(`${subject} is invalid`);
    }
    return time;
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

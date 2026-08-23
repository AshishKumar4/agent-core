import {
    AuthorityPermit,
    AuthorityPermitAdmissionPort,
    AuthorityPermitAuthenticator,
    AuthorityPermitExpectation,
    AuthorityCheckEvidence,
    TargetAuthorityPermitDenial,
    TargetAuthorityPermitRequest,
    TargetLeaseEvidence,
    TargetLeaseEvidenceIssuer,
    type AuthorityCheckRequest,
    type AuthenticatedAuthorityPermit,
    type AuthorityPermitTargetDenialStore,
    type AuthorityPermitTargetRequestStore,
    type ScopeEpoch,
    type TargetLeaseEvidenceStore
} from "../authority";
import { AgentCoreError } from "../errors";
import type { ActorRef } from "../actors";
import {
    structuralCodec,
    type ItemClaim,
    type PreparedInvocation,
    type StructuralCodec
} from "../invocations";
import type { JsonValue } from "../core";
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

export const authorityPermitReferenceCodec: StructuralCodec<AuthorityPermitReference> =
    structuralCodec(
        (reference: AuthorityPermitReference): JsonValue =>
            AuthorityPermit.fromData(reference).toData(),
        (value: JsonValue): AuthorityPermitReference => AuthorityPermit.fromData(value).toData()
    );

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

export interface TargetAuthorityPermitDenialState<Transaction> {
    joinDeniedEpochs(
        transaction: Transaction,
        principal: PrincipalRef,
        entries: readonly ScopeEpoch[]
    ): void;
    invalidateResolution(transaction: Transaction, expectation: AuthorityPermitExpectation): void;
}

export class TargetAuthorityPermitDenialPort<Transaction> {
    public constructor(
        private readonly tenant: TenantId,
        private readonly owner: ActorRef,
        private readonly store: AuthorityPermitTargetDenialStore<Transaction>,
        private readonly state: TargetAuthorityPermitDenialState<Transaction>
    ) {
        if (owner.kind === "tenant") {
            throw new TypeError("Target authority denial owner must be a non-Tenant Actor");
        }
    }

    public deny(
        transaction: Transaction,
        authentication: AuthenticatedAuthorityPermitDenial
    ): void {
        const denialRecord = authentication.record();
        const { request, evidence } = denialRecord;
        const { expectation } = request;
        if (
            !expectation.tenant.equals(this.tenant) ||
            !expectation.target.actor.equals(this.owner) ||
            !expectation.principal.tenantId.equals(this.tenant) ||
            !this.store.owner.equals(this.owner)
        ) {
            throw denied("Target authority denial evidence has the wrong owner");
        }
        const retained = this.store.requested(transaction, request.nonce);
        if (retained === undefined || !retained.digest().equals(request.digest())) {
            throw denied("Target authority denial does not bind its exact retained request");
        }
        this.store.deny(transaction, denialRecord);
        this.state.joinDeniedEpochs(transaction, expectation.principal, evidence.pathEpochs.path);
        this.state.invalidateResolution(transaction, expectation);
    }
}

export interface AuthorityCheckRequestFactory<Lease, Authority, Domain, PathEpochs> {
    forClaim(
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        nonce: string
    ): AuthorityCheckRequest;
}

export abstract class TargetLeaseEvidenceTransport {
    /**
     * The source Actor records and returns one canonical immutable attestation for the
     * provisional target request. `undefined` means its current lease cannot attest it.
     */
    public abstract attest(request: Uint8Array): Promise<Uint8Array | undefined>;
}

/** Source-side adapter that records an attestation in its owning Actor transaction. */
export class StoredTargetLeaseEvidenceTransport<Transaction> extends TargetLeaseEvidenceTransport {
    public constructor(
        private readonly store: TargetLeaseEvidenceStore<Transaction>,
        private readonly issuer: TargetLeaseEvidenceIssuer<Transaction>,
        private readonly now: () => Date
    ) {
        super();
    }

    public async attest(request: Uint8Array): Promise<Uint8Array | undefined> {
        let decoded: TargetAuthorityPermitRequest;
        try {
            decoded = TargetAuthorityPermitRequest.decode(request);
        } catch {
            throw new AgentCoreError("codec.invalid", "Target lease evidence request is malformed");
        }
        const evidence = this.store.transaction((transaction) =>
            this.issuer.attest(transaction, decoded, this.now())
        );
        return evidence === undefined ? undefined : TargetLeaseEvidence.encode(evidence);
    }
}

export abstract class AuthorityPermitIssuanceTransport {
    public project(_evidence: Uint8Array, _idempotencyKey: string): Promise<Uint8Array> {
        return Promise.reject(
            new AgentCoreError(
                "authority.denied",
                "Authority permit transport does not support source lease evidence projection"
            )
        );
    }

    public abstract issue(request: Uint8Array, idempotencyKey: string): Promise<Uint8Array>;
}

export class AuthenticatedAuthorityPermitDenial {
    readonly #record: TargetAuthorityPermitDenial;

    public constructor(
        authority: symbol,
        request: TargetAuthorityPermitRequest,
        evidence: AuthorityCheckEvidence
    ) {
        if (authority !== denialAuthenticationAuthority) {
            throw new TypeError("Authority permit denial requires authenticated Tenant evidence");
        }
        this.#record = TargetAuthorityPermitDenial.decode(
            TargetAuthorityPermitDenial.encode(new TargetAuthorityPermitDenial(request, evidence))
        );
        Object.freeze(this);
    }

    public record(): TargetAuthorityPermitDenial {
        return TargetAuthorityPermitDenial.decode(TargetAuthorityPermitDenial.encode(this.#record));
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
        private readonly store: AuthorityPermitTargetRequestStore<Transaction>,
        private readonly expectations: AuthorityPermitExpectationFactory<
            Transaction,
            Lease,
            Authority,
            Domain,
            PathEpochs
        >,
        private readonly denial: TargetAuthorityPermitDenialPort<Transaction>,
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
        private readonly lifetimeMilliseconds: number,
        private readonly sourceEvidence: TargetLeaseEvidenceTransport | undefined = undefined
    ) {
        if (!Number.isSafeInteger(lifetimeMilliseconds) || lifetimeMilliseconds <= 0) {
            throw new TypeError("Authority permit lifetime must be a positive safe integer");
        }
    }

    public async issue(
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
        | { readonly kind: "invalid"; readonly reason: string }
        | { readonly kind: "expired" }
    > {
        const nonce = this.nonce(invocation, claim);
        const candidate = this.store.transaction((transaction) => {
            const retained = this.store.requested(transaction, nonce);
            if (retained !== undefined) return { kind: "ready" as const, request: retained };
            const createdAt = validTime(this.now(), "Authority permit request time");
            const claimExpiresAt = claim.expiresAt.getTime();
            if (claimExpiresAt <= createdAt) return { kind: "expired" as const };
            if (claimExpiresAt - createdAt > this.lifetimeMilliseconds) {
                throw new TypeError("Item claim exceeds the authority permit lifetime");
            }
            const expectation = this.expectations.forClaim(invocation, claim);
            return {
                kind: "ready" as const,
                request: new TargetAuthorityPermitRequest(
                    expectation,
                    this.authority.forClaim(invocation, claim, nonce),
                    nonce,
                    claim.expiresAt,
                    undefined
                )
            };
        });
        if (candidate.kind !== "ready") return candidate;

        const provisional = candidate.request;
        const sourceEvidence =
            provisional.expectation.lease === undefined || this.sourceEvidence === undefined
                ? undefined
                : await this.readSourceEvidence(provisional);
        if (
            sourceEvidence === undefined &&
            provisional.expectation.lease !== undefined &&
            this.sourceEvidence !== undefined
        ) {
            return {
                kind: "invalid",
                reason: "Source Actor did not attest the exact current lease"
            };
        }
        const expiresAt =
            sourceEvidence === undefined
                ? provisional.expiresAt
                : new Date(
                      Math.min(provisional.expiresAt.getTime(), sourceEvidence.deadline.getTime())
                  );
        const request = new TargetAuthorityPermitRequest(
            provisional.expectation,
            provisional.authority,
            provisional.nonce,
            expiresAt,
            sourceEvidence?.reference()
        );
        if (sourceEvidence !== undefined) {
            try {
                requireSourceEvidence(sourceEvidence, request, this.now());
            } catch (error) {
                if (error instanceof AgentCoreError && error.code === "authority.denied") {
                    return { kind: "invalid", reason: error.message };
                }
                throw error;
            }
        }
        let persisted: TargetAuthorityPermitRequest;
        try {
            persisted = this.store.transaction((transaction) => {
                const retained = this.store.requested(transaction, nonce);
                if (retained !== undefined) {
                    if (!retained.digest().equals(request.digest())) {
                        throw denied("Target permit request replay changed its source evidence");
                    }
                    return retained;
                }
                return this.store.request(transaction, request);
            });
            requireRetainedRequest(
                persisted,
                invocation,
                claim,
                nonce,
                this.expectations,
                this.authority,
                sourceEvidence
            );
        } catch (error) {
            if (isInvalidIssuanceReply(error)) {
                return {
                    kind: "invalid",
                    reason: error.message || "Authority permit response is invalid"
                };
            }
            throw error;
        }
        const observedAt = validTime(this.now(), "Authority permit request observation time");
        if (observedAt >= persisted.expiresAt.getTime()) {
            return { kind: "expired" };
        }
        const payload = AuthorityPermitIssuanceRequest.encode(
            new AuthorityPermitIssuanceRequest(persisted)
        );
        if (sourceEvidence !== undefined) {
            const projected = TargetLeaseEvidence.decode(
                await this.transport.project(
                    TargetLeaseEvidence.encode(sourceEvidence),
                    sourceEvidence.key.idempotencyKey
                )
            );
            if (!projected.digest().equals(sourceEvidence.digest())) {
                return {
                    kind: "invalid",
                    reason: "Tenant projection substituted source lease evidence"
                };
            }
        }
        try {
            const replyBytes = await this.transport.issue(payload, nonce);
            const receivedAt = this.now();
            validTime(receivedAt, "Authority permit response time");
            const reply = AuthorityPermitIssuanceReply.decode(replyBytes);
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
        } catch (error) {
            if (isInvalidIssuanceReply(error)) {
                return {
                    kind: "invalid",
                    reason: error.message || "Authority permit response is invalid"
                };
            }
            throw error;
        }
    }

    private async readSourceEvidence(
        request: TargetAuthorityPermitRequest
    ): Promise<TargetLeaseEvidence | undefined> {
        if (this.sourceEvidence === undefined) return undefined;
        const bytes = await this.sourceEvidence.attest(TargetAuthorityPermitRequest.encode(request));
        if (bytes === undefined) return undefined;
        return TargetLeaseEvidence.decode(bytes);
    }

    public deny(
        transaction: Transaction,
        invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        claim: ItemClaim<Lease>,
        denial: AuthenticatedAuthorityPermitDenial
    ): void {
        const denialRecord = denial.record();
        const { request } = denialRecord;
        if (!request.expectation.equals(this.expectations.forClaim(invocation, claim))) {
            throw denied(
                "Authenticated authority denial does not bind the retained target request"
            );
        }
        this.denial.deny(transaction, denial);
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
    authority: AuthorityCheckRequestFactory<Lease, Authority, Domain, PathEpochs>,
    sourceEvidence: TargetLeaseEvidence | undefined
): void {
    const expectedExpiry =
        sourceEvidence === undefined
            ? claim.expiresAt.getTime()
            : Math.min(claim.expiresAt.getTime(), sourceEvidence.deadline.getTime());
    if (
        request.nonce !== nonce ||
        !request.expectation.equals(expectations.forClaim(invocation, claim)) ||
        !request.authority.digest().equals(authority.forClaim(invocation, claim, nonce).digest()) ||
        request.expiresAt.getTime() !== expectedExpiry ||
        ((request.leaseEvidence === undefined) !== (sourceEvidence === undefined))
    ) {
        throw denied("Retained authority permit request does not bind the current claim");
    }
    if (sourceEvidence !== undefined) {
        requireSourceEvidence(sourceEvidence, request);
    }
}

function requireSourceEvidence(
    evidence: TargetLeaseEvidence,
    request: TargetAuthorityPermitRequest,
    observedAt?: Date
): void {
    const reference = request.leaseEvidence;
    const lease = request.expectation.lease;
    if (
        reference === undefined ||
        lease === undefined ||
        !evidence.digest().equals(reference.digest) ||
        !evidence.matches({
            key: reference.key,
            tenant: request.expectation.tenant,
            run: request.expectation.reservation.run,
            lease,
            target: request.expectation.target,
            requestIdentity: request.identity()
        }) ||
        request.expiresAt.getTime() > evidence.deadline.getTime() ||
        request.expectation.pathEpochs.path.some(
            (entry) => evidence.watermark.epoch(entry.scope) > entry.epoch
        ) ||
        (observedAt !== undefined && !evidence.isCurrentAt(observedAt))
    ) {
        throw denied("Target lease evidence is stale or does not bind its exact permit request");
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
            return false;
        }
        if (
            expected === undefined ||
            authentication === undefined ||
            !permit.digest().equals(admission.digest)
        ) {
            return false;
        }
        try {
            this.admission.consume(transaction, authentication, permit, expected, this.now());
        } catch (error) {
            if (!(error instanceof AgentCoreError) || error.code !== "authority.denied") {
                throw error;
            }
            return false;
        }
        return true;
    }
}

function isInvalidIssuanceReply(error: unknown): error is AgentCoreError {
    return (
        error instanceof AgentCoreError &&
        (error.code === "authority.denied" ||
            error.code === "codec.invalid" ||
            error.code === "protocol.invalid-state")
    );
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

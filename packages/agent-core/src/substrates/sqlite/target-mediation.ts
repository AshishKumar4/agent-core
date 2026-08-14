import type { ActorRef, SynchronousResultGuard } from "../../actors";
import {
    InvalidationWatermark,
    type AuthenticatedAuthorityPermit,
    type AuthorityPermitExpectation,
    type AuthorityPermitTargetAdmissionStore,
    type AuthorityPermitTargetDenialStore,
    type AuthorityPermitTargetRequestStore,
    type ScopeEpoch,
    type TargetAuthorityPermitDenial,
    type TargetAuthorityPermitRequest,
    watermarkKey
} from "../../authority";
import {
    TargetPermitMediationAggregate,
    authorityPermitReferenceCodec,
    mediationInvocationCodecs,
    type AuthorityPermitReference,
    type MediationPersistence
} from "../../composition";
import { AgentCoreError } from "../../errors";
import type { PrincipalRef, TenantId } from "../../identity";
import {
    AttemptReceipt,
    PreEffectReceipt,
    type InvocationEvidencePersistence,
    type InvocationReplayPersistence,
    type Receipt
} from "../../invocations";
import { SqliteActorStore } from "./actor";
import { SqliteInvocationMediationPersistence, SqliteInvocationPersistence } from "./invocations";
import { SqliteAuthorityPermitStore } from "./permit";
import { SqliteProtocolPersistence } from "./protocol";
import type { TransactionalSqlite } from "./sqlite";
import { SqliteInvalidationWatermarkStore } from "./watermark";

export abstract class SqliteTargetResolutionInvalidationPort {
    public abstract invalidate(
        transaction: TransactionalSqlite,
        expectation: AuthorityPermitExpectation
    ): void;
}

/** One physical SQLite Actor store behind the complete target mediation surface. */
export class SqliteTargetPermitMediationAggregate extends TargetPermitMediationAggregate<TransactionalSqlite> {
    public readonly persistence: MediationPersistence<
        TransactionalSqlite,
        AuthorityPermitReference
    >;
    public readonly evidence: InvocationEvidencePersistence<TransactionalSqlite> &
        InvocationReplayPersistence<TransactionalSqlite>;
    public readonly permitRequests: AuthorityPermitTargetRequestStore<TransactionalSqlite>;
    public readonly permitDenials: AuthorityPermitTargetDenialStore<TransactionalSqlite>;
    public readonly permitAdmission: AuthorityPermitTargetAdmissionStore<TransactionalSqlite>;

    readonly #actors: SqliteActorStore;
    readonly #watermarks: SqliteInvalidationWatermarkStore;
    #active: TransactionalSqlite | undefined;

    public constructor(
        database: TransactionalSqlite,
        public readonly tenant: TenantId,
        public readonly actor: ActorRef,
        private readonly invalidations: SqliteTargetResolutionInvalidationPort
    ) {
        super();
        if (actor.kind === "tenant") {
            throw new TypeError("Target permit mediation requires a non-Tenant Actor");
        }
        this.#actors = new SqliteActorStore(database);
        this.#actors.bindActor(actor);
        const permits = new SqliteAuthorityPermitStore(database, actor);
        const protocol = new SqliteProtocolPersistence(database);
        this.persistence = createTargetInvocationPersistence(database);
        this.evidence = new SqliteInvocationMediationPersistence(database, protocol);
        this.#watermarks = new SqliteInvalidationWatermarkStore(database, tenant, actor);
        const requireActive = (transaction: TransactionalSqlite): void =>
            this.requireActive(transaction);
        this.permitRequests = new TargetRequestView(this, permits, requireActive);
        this.permitDenials = new TargetDenialView(actor, permits, requireActive);
        this.permitAdmission = new TargetAdmissionView(actor, permits, requireActive);
    }

    public transact<Result>(operation: (transaction: TransactionalSqlite) => Result): Result {
        return this.#actors.transact((transaction) => {
            this.#active = transaction;
            try {
                return operation(transaction);
            } finally {
                this.#active = undefined;
            }
        });
    }

    public joinDeniedEpochs(
        transaction: TransactionalSqlite,
        principal: PrincipalRef,
        entries: readonly ScopeEpoch[]
    ): void {
        this.requireActive(transaction);
        if (!principal.tenantId.equals(this.tenant) || entries.length === 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Target denial epochs require an exact nonempty Tenant path"
            );
        }
        const empty = InvalidationWatermark.empty(this.tenant, this.actor, principal);
        const key = watermarkKey(empty);
        if (this.#watermarks.loadInTransaction(transaction, key) === undefined) {
            this.#watermarks.saveInTransaction(transaction, empty);
        }
        this.#watermarks.joinInTransaction(transaction, key, entries);
    }

    public invalidateResolution(
        transaction: TransactionalSqlite,
        expectation: AuthorityPermitExpectation
    ): void {
        this.requireActive(transaction);
        if (
            !expectation.tenant.equals(this.tenant) ||
            !expectation.target.actor.equals(this.actor)
        ) {
            throw new AgentCoreError(
                "authority.denied",
                "Target resolution invalidation has the wrong owner"
            );
        }
        this.invalidations.invalidate(transaction, expectation);
    }

    private requireActive(transaction: TransactionalSqlite): void {
        if (transaction !== this.#active) {
            throw new AgentCoreError(
                "actor.stale-callback",
                "Target mediation requires its exact active Actor transaction"
            );
        }
    }
}

class TargetRequestView implements AuthorityPermitTargetRequestStore<TransactionalSqlite> {
    public readonly owner: ActorRef;

    public constructor(
        private readonly aggregate: SqliteTargetPermitMediationAggregate,
        private readonly permits: SqliteAuthorityPermitStore,
        private readonly requireActive: (transaction: TransactionalSqlite) => void
    ) {
        this.owner = aggregate.actor;
    }

    public transaction<Result>(
        operation: (transaction: TransactionalSqlite) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.aggregate.transact(operation);
    }

    public requested(
        transaction: TransactionalSqlite,
        nonce: string
    ): TargetAuthorityPermitRequest | undefined {
        this.requireActive(transaction);
        return this.permits.requested(transaction, nonce);
    }

    public request(
        transaction: TransactionalSqlite,
        request: TargetAuthorityPermitRequest
    ): TargetAuthorityPermitRequest {
        this.requireActive(transaction);
        return this.permits.request(transaction, request);
    }
}

class TargetDenialView implements AuthorityPermitTargetDenialStore<TransactionalSqlite> {
    public constructor(
        public readonly owner: ActorRef,
        private readonly permits: SqliteAuthorityPermitStore,
        private readonly requireActive: (transaction: TransactionalSqlite) => void
    ) {}

    public requested(
        transaction: TransactionalSqlite,
        nonce: string
    ): TargetAuthorityPermitRequest | undefined {
        this.requireActive(transaction);
        return this.permits.requested(transaction, nonce);
    }

    public denied(
        transaction: TransactionalSqlite,
        nonce: string
    ): TargetAuthorityPermitDenial | undefined {
        this.requireActive(transaction);
        return this.permits.denied(transaction, nonce);
    }

    public deny(
        transaction: TransactionalSqlite,
        denial: TargetAuthorityPermitDenial
    ): TargetAuthorityPermitDenial {
        this.requireActive(transaction);
        return this.permits.deny(transaction, denial);
    }
}

class TargetAdmissionView implements AuthorityPermitTargetAdmissionStore<TransactionalSqlite> {
    public constructor(
        public readonly owner: ActorRef,
        private readonly permits: SqliteAuthorityPermitStore,
        private readonly requireActive: (transaction: TransactionalSqlite) => void
    ) {}

    public consumed(transaction: TransactionalSqlite, nonce: string) {
        this.requireActive(transaction);
        return this.permits.consumed(transaction, nonce);
    }

    public consume(
        transaction: TransactionalSqlite,
        authentication: AuthenticatedAuthorityPermit,
        permit: Parameters<SqliteAuthorityPermitStore["consume"]>[2],
        expected: AuthorityPermitExpectation,
        now: Date
    ): void {
        this.requireActive(transaction);
        this.permits.consume(transaction, authentication, permit, expected, now);
    }
}

function createTargetInvocationPersistence(
    database: TransactionalSqlite
): MediationPersistence<TransactionalSqlite, AuthorityPermitReference> {
    const codecs = mediationInvocationCodecs(authorityPermitReferenceCodec);
    return new SqliteInvocationPersistence(database, {
        ...codecs,
        projectPrepared: (record) => ({ id: record.header.id.value }),
        projectApproval: (record) => ({
            id: record.id.value,
            invocation: record.invocation.value,
            revision: record.revision.value,
            phase: record.state.kind
        }),
        projectClaim: (record) => ({
            id: record.id.value,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            ordinal: record.attemptOrdinal
        }),
        projectAttempt: (record) => ({
            id: record.id.value,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            ordinal: record.ordinal,
            claim: record.claim.value
        }),
        projectReceipt: projectReceipt,
        projectContinuation: (record) => ({ invocation: record.invocation.value })
    });
}

function projectReceipt(record: Receipt) {
    if (record instanceof PreEffectReceipt) {
        return {
            id: record.id.value,
            variant: record.variant,
            invocation: record.invocation.value,
            itemIndex: record.itemIndex,
            outcome: record.outcome
        } as const;
    }
    if (record instanceof AttemptReceipt) {
        const projected = {
            id: record.id.value,
            variant: record.variant,
            attempt: record.attempt.value,
            outcome: record.outcome
        } as const;
        return record.previous === undefined
            ? projected
            : { ...projected, previous: record.previous.value };
    }
    throw new TypeError("Unknown Receipt record");
}

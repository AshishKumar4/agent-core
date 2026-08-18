import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import { RunId, TurnId } from "../../../src/agents";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermit,
    AuthorityPermitAuthenticator,
    AuthorityPermitExpectation,
    AuthorityPermitIssuedRecordSource,
    Binding,
    GrantId,
    InvalidationWatermark,
    PathEpochEvidence,
    ScopeEpoch,
    TargetAuthorityPermitDenial,
    TargetAuthorityPermitRequest,
    watermarkKey,
    type AuthorityPermitExpectationInit
} from "../../../src/authority";
import {
    domainReference,
    leaseReference,
    mediationPreparedCodecs,
    pathEpochReference,
    type AuthorityPermitReference,
    type MediationAuthorityReference,
    type MediationLeaseReference
} from "../../../src/composition";
import { Digest, Revision, SemVer, encodeCanonicalJson } from "../../../src/core";
import { PackageId, PackagePin } from "../../../src/definition";
import { AgentCoreError } from "../../../src/errors";
import { BindingName, FacetRef, OperationRef, ProtectionDomain } from "../../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../../src/identity";
import {
    Approval,
    ApprovalId,
    AttemptCompletion,
    AttemptFailureKind,
    AttemptReceipt,
    AuditRecordId,
    AuthorityAdmissionReference,
    ClaimWorkerId,
    EffectAttempt,
    EffectAttemptId,
    InvocationContinuation,
    InvocationId,
    ItemClaim,
    ItemClaimId,
    PreEffectReceipt,
    PreparedInvocation,
    Receipt,
    ReceiptId
} from "../../../src/invocations";
import {
    SqliteAuthorityPermitStore,
    SqliteInvalidationWatermarkStore,
    SqliteTargetPermitMediationAggregate,
    SqliteTargetResolutionInvalidationPort,
    type TransactionalSqlite
} from "../../../src/substrates";
import { TestSqlite } from "../../helpers/sqlite";
import { operationPin } from "../../invocations/fixture";

const tenant = new TenantId("mediation-tenant");
const foreignTenant = new TenantId("mediation-foreign-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("mediation-principal"));
const issuerActor = new ActorRef("tenant", new ActorId("mediation-issuer"));
const sourceActor = new ActorRef("workspace", new ActorId("mediation-source"));
const targetActor = new ActorRef("run", new ActorId("mediation-target"));
const foreignTargetActor = new ActorRef("run", new ActorId("mediation-foreign-target"));
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("mediation-workspace"));
const pathEpochs = new PathEpochEvidence([
    new ScopeEpoch(ScopeRef.tenant(tenant), 1),
    new ScopeEpoch(workspaceScope, 2)
]);
const invocation = new InvocationId("mediation-invocation");
const itemKey = "mediation-item";
const lease = Object.freeze({
    turn: new TurnId("mediation-turn"),
    holder: principal,
    epoch: 4
});
const issuedAt = new Date(1_000);
const expiresAt = new Date(6_000);
const consumeAt = new Date(issuedAt.getTime() + 1);
const authorityArguments = Object.freeze({ channel: "internal" });
const staleTransactionMessage = "Target mediation requires its exact active Actor transaction";

describe("SQLite target permit mediation aggregate", () => {
    test("refuses a Tenant Actor owner before it touches any storage", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const create = (): SqliteTargetPermitMediationAggregate =>
            new SqliteTargetPermitMediationAggregate(
                database,
                tenant,
                issuerActor,
                new RecordingInvalidations()
            );

        expect(create).toThrow(TypeError);
        expect(create).toThrow("Target permit mediation requires a non-Tenant Actor");
        expect(database.all("SELECT name FROM sqlite_master WHERE type = 'table'", [])).toEqual([]);
    });

    test(
        "every permit view answers exactly inside the aggregate's own Actor transaction",
        { tags: "p0" },
        () => {
            const aggregate = createAggregate(new TestSqlite());
            const request = targetRequest("view-scope");
            const denial = deniedTargetRequest(request);
            let captured: TransactionalSqlite | undefined;

            expect(aggregate.permitRequests.owner).toBe(targetActor);
            expect(aggregate.permitDenials.owner).toBe(targetActor);
            expect(aggregate.permitAdmission.owner).toBe(targetActor);

            aggregate.permitRequests.transaction((transaction) => {
                captured = transaction;
                expect(aggregate.permitRequests.requested(transaction, request.nonce)).toBeUndefined();
                expect(
                    aggregate.permitRequests.request(transaction, request).digest().value
                ).toBe(request.digest().value);
                expect(aggregate.permitDenials.requested(transaction, request.nonce)?.digest().value).toBe(
                    request.digest().value
                );
                expect(aggregate.permitDenials.denied(transaction, request.nonce)).toBeUndefined();
                expect(aggregate.permitDenials.deny(transaction, denial).digest().value).toBe(
                    denial.digest().value
                );
                expect(aggregate.permitAdmission.consumed(transaction, request.nonce)).toBeUndefined();
            });

            const closed = captured;
            if (closed === undefined) throw new TypeError("Expected a captured target transaction");
            for (const outsideItsScope of [
                () => aggregate.permitRequests.requested(closed, request.nonce),
                () => aggregate.permitRequests.request(closed, request),
                () => aggregate.permitDenials.requested(closed, request.nonce),
                () => aggregate.permitDenials.denied(closed, request.nonce),
                () => aggregate.permitDenials.deny(closed, denial),
                () => aggregate.permitAdmission.consumed(closed, request.nonce),
                () =>
                    aggregate.joinDeniedEpochs(closed, principal, [new ScopeEpoch(workspaceScope, 3)]),
                () => aggregate.invalidateResolution(closed, expectation())
            ]) {
                expectFailure(outsideItsScope, "actor.stale-callback", staleTransactionMessage);
            }
        }
    );

    test(
        "denial epochs join one monotone watermark for the aggregate's own Tenant path",
        { tags: "p1" },
        () => {
            const database = new TestSqlite();
            const aggregate = createAggregate(database);
            const watermarks = new SqliteInvalidationWatermarkStore(database, tenant, targetActor);
            const key = watermarkKey(InvalidationWatermark.empty(tenant, targetActor, principal));

            expect(watermarks.load(key)).toBeUndefined();
            aggregate.transact((transaction) =>
                aggregate.joinDeniedEpochs(transaction, principal, [new ScopeEpoch(workspaceScope, 2)])
            );
            expect(watermarks.load(key)?.epoch(workspaceScope)).toBe(2);

            aggregate.transact((transaction) =>
                aggregate.joinDeniedEpochs(transaction, principal, [new ScopeEpoch(workspaceScope, 7)])
            );
            expect(watermarks.load(key)?.epoch(workspaceScope)).toBe(7);
        }
    );

    test("denial epochs require an exact nonempty Tenant path", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const aggregate = createAggregate(database);
        const foreignPrincipal = new PrincipalRef(
            foreignTenant,
            new PrincipalId("mediation-foreign-principal")
        );
        const message = "Target denial epochs require an exact nonempty Tenant path";

        aggregate.transact((transaction) => {
            expectFailure(
                () =>
                    aggregate.joinDeniedEpochs(transaction, foreignPrincipal, [
                        new ScopeEpoch(workspaceScope, 2)
                    ]),
                "protocol.invalid-state",
                message
            );
            expectFailure(
                () => aggregate.joinDeniedEpochs(transaction, principal, []),
                "protocol.invalid-state",
                message
            );
        });

        const watermarks = new SqliteInvalidationWatermarkStore(database, tenant, targetActor);
        expect(
            watermarks.load(watermarkKey(InvalidationWatermark.empty(tenant, targetActor, principal)))
        ).toBeUndefined();
    });

    test("resolution invalidation is refused for any other owner", { tags: "p0" }, () => {
        const message = "Target resolution invalidation has the wrong owner";
        const wrongOwners = [
            { port: new RecordingInvalidations(), tenant: foreignTenant, actor: targetActor },
            { port: new RecordingInvalidations(), tenant, actor: foreignTargetActor }
        ];

        for (const owner of wrongOwners) {
            const aggregate = new SqliteTargetPermitMediationAggregate(
                new TestSqlite(),
                owner.tenant,
                owner.actor,
                owner.port
            );
            aggregate.transact((transaction) =>
                expectFailure(
                    () => aggregate.invalidateResolution(transaction, expectation()),
                    "authority.denied",
                    message
                )
            );
            expect(owner.port.expectations).toEqual([]);
        }

        const port = new RecordingInvalidations();
        const aggregate = new SqliteTargetPermitMediationAggregate(
            new TestSqlite(),
            tenant,
            targetActor,
            port
        );
        const expected = expectation();
        aggregate.transact((transaction) => aggregate.invalidateResolution(transaction, expected));
        expect(port.expectations).toEqual([expected]);
    });

    test("admission consumes a permit exactly once inside its own scope", { tags: "p0" }, async () => {
        const database = new TestSqlite();
        const aggregate = createAggregate(database);
        const nonce = "admission-consume";
        const request = targetRequest(nonce);
        aggregate.transact((transaction) => aggregate.permitRequests.request(transaction, request));

        const issuance = new SqliteAuthorityPermitStore(new TestSqlite(), issuerActor);
        const permit = issuance.transaction((transaction) =>
            issuance.issue(transaction, issuedPermit(nonce))
        );
        const authentication = await new AuthorityPermitAuthenticator(
            new StoreIssuedRecordSource(issuance)
        ).authenticate(permit, permit.expectation);

        expect(
            aggregate.transact((transaction) =>
                aggregate.permitAdmission.consumed(transaction, nonce)
            )
        ).toBeUndefined();

        aggregate.transact((transaction) =>
            aggregate.permitAdmission.consume(
                transaction,
                authentication,
                permit,
                permit.expectation,
                consumeAt
            )
        );
        expect(
            aggregate.transact((transaction) =>
                aggregate.permitAdmission.consumed(transaction, nonce)?.value
            )
        ).toBe(permit.digest().value);

        aggregate.transact((transaction) =>
            expectFailure(
                () =>
                    aggregate.permitAdmission.consume(
                        transaction,
                        authentication,
                        permit,
                        permit.expectation,
                        consumeAt
                    ),
                "authority.denied",
                "Authority permit nonce was already used by this Actor owner"
            )
        );

        let captured: TransactionalSqlite | undefined;
        aggregate.transact((transaction) => {
            captured = transaction;
        });
        const closed = captured;
        if (closed === undefined) throw new TypeError("Expected a captured target transaction");
        expectFailure(
            () =>
                aggregate.permitAdmission.consume(
                    closed,
                    authentication,
                    permit,
                    permit.expectation,
                    consumeAt
                ),
            "actor.stale-callback",
            staleTransactionMessage
        );
    });
});

describe("SQLite target mediation invocation projections", () => {
    test("a prepared invocation is stored under exactly its own identity", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const aggregate = createAggregate(database);
        const authority: MediationAuthorityReference = {
            kind: "initiator",
            tenant: tenant.value,
            principal: principal.principalId.value,
            binding: "mail"
        };
        const record = PreparedInvocation.create(
            {
                id: invocation,
                operation: operationPin("mediation-prepared"),
                domain: domainReference(
                    new ProtectionDomain("backend", "mediation-domain", "no-secrets")
                ),
                actor: targetActor,
                authority,
                pathEpochs: pathEpochReference(pathEpochs),
                lease: leaseReference(lease),
                auditCause: new AuditRecordId("mediation-prepared-audit"),
                idempotencySeed: "mediation-prepared-seed"
            },
            { kind: "single", item: { value: itemKey } },
            mediationPreparedCodecs
        );

        database.transaction(() => aggregate.persistence.insertPrepared(database, record));

        expect(database.all("SELECT id FROM invocation_prepared_records", [])).toEqual([
            { id: invocation.value }
        ]);
        expect(
            aggregate.persistence.prepared(database, invocation)?.intentDigest.equals(
                record.intentDigest
            )
        ).toBe(true);
    });

    test("an Approval stores its identity, revision, and phase columns", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const aggregate = createAggregate(database);
        const id = new ApprovalId("projected-approval");
        const target = new InvocationId("projected-approval-invocation");
        const pending = Approval.pending(id, target, digest("approval-intent"), issuedAt, expiresAt);
        const approved = pending.approve(new PrincipalId("mediation-approver"), new Date(2_000));

        database.transaction(() => {
            aggregate.persistence.appendApproval(database, pending);
            aggregate.persistence.appendApproval(database, approved);
        });

        expect(
            database.all(
                `SELECT approval_id, invocation_id, revision, phase
                 FROM invocation_approval_revisions ORDER BY revision`,
                []
            )
        ).toEqual([
            {
                approval_id: id.value,
                invocation_id: target.value,
                revision: 0,
                phase: "pending"
            },
            {
                approval_id: id.value,
                invocation_id: target.value,
                revision: 1,
                phase: "approved"
            }
        ]);
        expect(aggregate.persistence.approval(database, id)?.state.kind).toBe("approved");
        expect(aggregate.persistence.approvalForInvocation(database, target)?.revision.value).toBe(1);
        expect(aggregate.persistence.approvalRevision(database, id, 0)?.state.kind).toBe("pending");
    });

    test("a claim and its EffectAttempt store their ordinal columns", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const aggregate = createAggregate(database);
        const claim = systemClaim("projected-claim", 3);
        const attempt = systemAttempt("projected-claim", claim);

        database.transaction(() => {
            aggregate.persistence.appendClaim(database, claim);
            aggregate.persistence.appendAttempt(database, attempt);
        });

        expect(
            database.all(
                "SELECT id, invocation_id, item_index, ordinal FROM invocation_item_claims",
                []
            )
        ).toEqual([
            {
                id: claim.id.value,
                invocation_id: invocation.value,
                item_index: 0,
                ordinal: 3
            }
        ]);
        expect(
            database.all(
                `SELECT id, invocation_id, item_index, ordinal, claim_id
                 FROM invocation_effect_attempts`,
                []
            )
        ).toEqual([
            {
                id: attempt.id.value,
                invocation_id: invocation.value,
                item_index: 0,
                ordinal: 3,
                claim_id: claim.id.value
            }
        ]);
        expect(aggregate.persistence.claim(database, claim.id)?.attemptOrdinal).toBe(3);
        expect(aggregate.persistence.attemptForClaim(database, claim.id)?.id.value).toBe(
            attempt.id.value
        );
        expect(aggregate.persistence.attemptsForItem(database, invocation, 0)).toHaveLength(1);
    });

    test("a continuation is keyed by exactly its invocation column", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const aggregate = createAggregate(database);
        const continuation = new InvocationContinuation<MediationLeaseReference>(
            invocation,
            digest("continuation-intent"),
            new ApprovalId("projected-continuation-approval"),
            new EffectAttemptId("projected-continuation-attempt"),
            0,
            0,
            new ItemClaimId("projected-continuation-claim"),
            { kind: "system", actor: targetActor, worker: new ClaimWorkerId("projected-worker") },
            itemKey,
            new Date(2_000)
        );

        database.transaction(() =>
            aggregate.persistence.insertContinuation(database, continuation)
        );

        expect(database.all("SELECT invocation_id FROM invocation_continuations", [])).toEqual([
            { invocation_id: invocation.value }
        ]);
        expect(aggregate.persistence.continuation(database, invocation)?.firstItemKey).toBe(itemKey);
        expect(
            aggregate.persistence.continuation(database, new InvocationId("absent"))
        ).toBeUndefined();
    });

    test("each stored Receipt variant projects its own discriminated columns", { tags: "p1" }, () => {
        const database = new TestSqlite();
        const aggregate = createAggregate(database);
        const claim = systemClaim("projected-receipt", 0);
        const attempt = systemAttempt("projected-receipt", claim);
        const preEffect = new PreEffectReceipt(
            new ReceiptId("projected-pre-effect"),
            invocation,
            0,
            "deniedPreEffect",
            new Date(2_000),
            "denied by policy"
        );
        const indeterminate = new AttemptReceipt(
            new ReceiptId("projected-indeterminate"),
            attempt.id,
            AttemptCompletion.indeterminate,
            undefined,
            new Date(3_000),
            undefined
        );
        const resolved = new AttemptReceipt(
            new ReceiptId("projected-resolved"),
            attempt.id,
            AttemptCompletion.succeeded,
            indeterminate.id,
            new Date(4_000),
            undefined
        );

        database.transaction(() => {
            aggregate.persistence.appendAttempt(database, attempt);
            aggregate.persistence.appendReceipt(database, preEffect);
            aggregate.persistence.appendReceipt(database, indeterminate);
            aggregate.persistence.appendReceipt(database, resolved);
        });

        expect(
            database.all(
                `SELECT id, variant, invocation_id, item_index, attempt_id, previous_id, outcome
                 FROM invocation_receipts ORDER BY sequence`,
                []
            )
        ).toEqual([
            {
                id: preEffect.id.value,
                variant: "preEffect",
                invocation_id: invocation.value,
                item_index: 0,
                attempt_id: null,
                previous_id: null,
                outcome: "deniedPreEffect"
            },
            {
                id: indeterminate.id.value,
                variant: "attempt",
                invocation_id: invocation.value,
                item_index: 0,
                attempt_id: attempt.id.value,
                previous_id: null,
                outcome: "indeterminate"
            },
            {
                id: resolved.id.value,
                variant: "attempt",
                invocation_id: invocation.value,
                item_index: 0,
                attempt_id: attempt.id.value,
                previous_id: indeterminate.id.value,
                outcome: "succeeded"
            }
        ]);
        expect(aggregate.persistence.receipt(database, resolved.id)).toBeInstanceOf(AttemptReceipt);
        expect(aggregate.persistence.receiptsForAttempt(database, attempt.id)).toHaveLength(2);
        expect(aggregate.persistence.receiptsForItem(database, invocation, 0)).toHaveLength(3);
    });

    test("a Receipt of no known variant is refused as an invalid record", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const aggregate = createAggregate(database);

        database.transaction(() =>
            expectFailure(
                () => aggregate.persistence.appendReceipt(database, new UnknownVariantReceipt()),
                "codec.invalid",
                "Stored Receipt record has an unknown variant"
            )
        );
        expect(database.all("SELECT id FROM invocation_receipts", [])).toEqual([]);
    });
});

class RecordingInvalidations extends SqliteTargetResolutionInvalidationPort {
    public readonly expectations: AuthorityPermitExpectation[] = [];

    public invalidate(
        _transaction: TransactionalSqlite,
        expected: AuthorityPermitExpectation
    ): void {
        this.expectations.push(expected);
    }
}

class StoreIssuedRecordSource extends AuthorityPermitIssuedRecordSource {
    public constructor(private readonly store: SqliteAuthorityPermitStore) {
        super();
    }

    public issued(issuer: ActorRef, nonce: string, expected: Digest): Promise<Uint8Array | undefined> {
        const stored = this.store.transaction((transaction) =>
            this.store.issued(transaction, nonce)
        );
        return Promise.resolve(
            stored?.issuer.equals(issuer) === true && stored.digest().equals(expected)
                ? AuthorityPermit.encode(stored)
                : undefined
        );
    }
}

/** A Receipt whose variant no projection knows, which only its own writer could have made. */
class UnknownVariantReceipt extends Receipt {
    declare public readonly variant: "attempt";
    declare public readonly id: ReceiptId;
    declare public readonly outcome: "failed";

    public constructor() {
        super(new Date(2_000), {
            variant: "attempt",
            id: new ReceiptId("unknown-variant-receipt"),
            attempt: new EffectAttemptId("unknown-variant-attempt"),
            outcome: "failed",
            failure: AttemptFailureKind.raised,
            previous: undefined,
            result: undefined
        });
    }
}

function createAggregate(database: TransactionalSqlite): SqliteTargetPermitMediationAggregate {
    return new SqliteTargetPermitMediationAggregate(
        database,
        tenant,
        targetActor,
        new RecordingInvalidations()
    );
}

function systemClaim(id: string, ordinal: number): ItemClaim<MediationLeaseReference> {
    return new ItemClaim<MediationLeaseReference>(
        new ItemClaimId(`${id}-claim`),
        invocation,
        0,
        ordinal,
        { kind: "system", actor: targetActor, worker: new ClaimWorkerId(`${id}-worker`) },
        new Date(5_000)
    );
}

function systemAttempt(
    id: string,
    claim: ItemClaim<MediationLeaseReference>
): EffectAttempt<MediationLeaseReference, AuthorityPermitReference> {
    const permit = issuedPermit(`${id}-admission`);
    return new EffectAttempt<MediationLeaseReference, AuthorityPermitReference>(
        new EffectAttemptId(`${id}-attempt`),
        invocation,
        0,
        claim.attemptOrdinal,
        claim.id,
        undefined,
        new AuthorityAdmissionReference(permit.toData(), permit.digest()),
        new Date(2_000),
        itemKey,
        new AuditRecordId(`${id}-audit`)
    );
}

function issuedPermit(nonce: string): AuthorityPermit {
    const expected = expectation();
    return new AuthorityPermit({
        ...expected,
        nonce,
        requestDigest: targetRequestFor(expected, nonce).digest(),
        issuedAt,
        expiresAt
    });
}

function expectation(
    overrides: Partial<AuthorityPermitExpectationInit> = {}
): AuthorityPermitExpectation {
    return new AuthorityPermitExpectation({
        tenant,
        issuer: issuerActor,
        source: sourceActor,
        target: {
            actor: targetActor,
            fence: 3,
            domain: new ProtectionDomain("backend", "mediation-domain", "no-secrets")
        },
        principal,
        binding: { name: new BindingName("mail"), generation: new Revision(2) },
        facet: new FacetRef("workspace:mail"),
        operation: new OperationRef("workspace:send"),
        package: new PackagePin(
            new PackageId("mediation-package"),
            new SemVer("1.0.0"),
            digest("manifest"),
            digest("code")
        ),
        impact: "externalSend",
        invocation,
        reservation: {
            run: new RunId("mediation-run"),
            registryEpoch: 1,
            obligation: { kind: "invocationItem", invocation, itemIndex: 0, itemKey }
        },
        itemIndex: 0,
        attemptOrdinal: 0,
        claim: new ItemClaimId("mediation-claim"),
        claimOwner: {
            kind: "executor",
            token: lease,
            worker: new ClaimWorkerId("mediation-worker")
        },
        itemKey,
        argumentsDigest: Digest.sha256(encodeCanonicalJson(authorityArguments)),
        intentDigest: digest("intent"),
        pathEpochs,
        authority: { kind: "initiator", principal, binding: new BindingName("mail") },
        lease,
        ...overrides
    });
}

function targetRequest(nonce: string): TargetAuthorityPermitRequest {
    return targetRequestFor(expectation(), nonce);
}

function targetRequestFor(
    expected: AuthorityPermitExpectation,
    nonce: string
): TargetAuthorityPermitRequest {
    const binding = new Binding(
        expected.pathEpochs.target.scope,
        SubjectRef.principal(expected.principal),
        expected.target.domain,
        expected.binding.name,
        new GrantId("mediation-grant"),
        expected.facet,
        expected.binding.generation.value,
        "active",
        new Revision(expected.binding.generation.value)
    );
    return new TargetAuthorityPermitRequest(
        expected,
        new AuthorityCheckRequest({
            ownerTenant: expected.tenant,
            owner: expected.target.actor,
            ownerFence: expected.target.fence,
            principal: expected.principal,
            binding,
            intent: {
                facet: expected.facet,
                operation: expected.operation.operation.value,
                impact: expected.impact,
                arguments: authorityArguments,
                argumentsDigest: expected.argumentsDigest
            },
            expectedPath: expected.pathEpochs,
            invocationDigest: expected.intentDigest,
            itemIndex: expected.itemIndex,
            attemptOrdinal: expected.attemptOrdinal,
            nonce
        }),
        nonce,
        expiresAt
    );
}

function deniedTargetRequest(request: TargetAuthorityPermitRequest): TargetAuthorityPermitDenial {
    return new TargetAuthorityPermitDenial(
        request,
        new AuthorityCheckEvidence(
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
            issuedAt
        )
    );
}

function expectFailure(
    operation: () => unknown,
    code: AgentCoreError["code"],
    message: string
): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        if (error instanceof AgentCoreError) {
            expect(error.code).toBe(code);
            expect(error.message).toBe(message);
        }
        return;
    }
    throw new TypeError(`Expected AgentCoreError ${code}`);
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../../src/actors";
import { RunId, TurnId } from "../../../src/agents";
import {
    AuthorityPermit,
    AuthorityPermitAuthenticator,
    AuthorityPermitExpectation,
    AuthorityPermitIssuedRecordSource,
    AuthorityCheckRequest,
    AuthorityCheckEvidence,
    Binding,
    GrantId,
    InvalidationWatermark,
    PathEpochEvidence,
    ScopeEpoch,
    TargetAuthorityPermitDenial,
    TargetAuthorityPermitRequest,
    watermarkKey as authorityWatermarkKey,
    type AuthenticatedAuthorityPermit,
    type AuthorityPermitExpectationInit
} from "../../../src/authority";
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
import { ClaimWorkerId, ItemClaimId } from "../../../src/invocation-references";
import { InvocationId } from "../../../src/interaction-references";
import {
    SqliteAuthorityPermitStore,
    SqliteInvalidationWatermarkStore,
    SqliteTargetPermitMediationAggregate,
    SqliteTargetResolutionInvalidationPort,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../../src/substrates";
import { TestSqlite } from "../../helpers/sqlite";

const tenant = new TenantId("sqlite-permit-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("sqlite-permit-principal"));
const issuerActor = new ActorRef("tenant", new ActorId("sqlite-permit-issuer"));
const sourceActor = new ActorRef("workspace", new ActorId("sqlite-permit-source"));
const targetActor = new ActorRef("run", new ActorId("sqlite-permit-target"));
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("sqlite-permit-workspace"));
const path = new PathEpochEvidence([
    new ScopeEpoch(ScopeRef.tenant(tenant), 1),
    new ScopeEpoch(workspaceScope, 2)
]);
const invocation = new InvocationId("sqlite-permit-invocation");
const itemKey = "sqlite-permit-item";
const lease = Object.freeze({
    turn: new TurnId("sqlite-permit-turn"),
    holder: principal,
    epoch: 4
});
const issuedAt = new Date(1_000);
const expiresAt = new Date(6_000);
const consumeAt = new Date(issuedAt.getTime() + 1);
const corruptMessage = "Stored authority permit ownership is malformed";
const authorityArguments = Object.freeze({ channel: "internal" });

describe("SQLite authority permit store exact behavior", () => {
    test(
        "target aggregate closes every permit view and rolls denial state back as one Actor span",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const invalidations = new RecordingTargetInvalidations();
            const aggregate = new SqliteTargetPermitMediationAggregate(
                database,
                tenant,
                targetActor,
                invalidations
            );
            const request = targetRequest("aggregate-denial");
            const denial = deniedTargetRequest(request);
            let captured: TransactionalSqlite | undefined;

            aggregate.permitRequests.transaction((transaction) => {
                captured = transaction;
                aggregate.permitRequests.request(transaction, request);
            });
            if (captured === undefined) throw new TypeError("Expected captured target transaction");
            const closed = captured;
            expect(() => aggregate.permitRequests.request(closed, request)).toThrow();
            expect(() =>
                database.transaction(() => aggregate.permitRequests.request(database, request))
            ).toThrow();

            expect(() =>
                aggregate.transact((transaction) => {
                    aggregate.permitDenials.deny(transaction, denial);
                    aggregate.joinDeniedEpochs(
                        transaction,
                        request.expectation.principal,
                        denial.evidence.pathEpochs.path
                    );
                    aggregate.invalidateResolution(transaction, request.expectation);
                    throw new AgentCoreError("protocol.invalid-state", "abort aggregate denial");
                })
            ).toThrow(/abort aggregate denial/);
            expect(
                aggregate.transact((transaction) =>
                    aggregate.permitDenials.denied(transaction, request.nonce)
                )
            ).toBeUndefined();
            const watermarkStore = new SqliteInvalidationWatermarkStore(
                database,
                tenant,
                targetActor
            );
            const watermarkKey = InvalidationWatermark.empty(tenant, targetActor, principal);
            expect(watermarkStore.load(authorityWatermarkKey(watermarkKey))).toBeUndefined();

            aggregate.transact((transaction) => {
                aggregate.permitDenials.deny(transaction, denial);
                aggregate.joinDeniedEpochs(
                    transaction,
                    request.expectation.principal,
                    denial.evidence.pathEpochs.path
                );
                aggregate.invalidateResolution(transaction, request.expectation);
            });
            expect(
                aggregate.transact(
                    (transaction) =>
                        aggregate.permitDenials.denied(transaction, request.nonce)?.digest().value
                )
            ).toBe(denial.digest().value);
            expect(
                watermarkStore.load(authorityWatermarkKey(watermarkKey))?.epoch(workspaceScope)
            ).toBe(2);
            expect(invalidations.expectations).toEqual([request.expectation, request.expectation]);
        }
    );

    test(
        "target aggregate rejects nested and foreign scopes without leaking writes",
        { tags: "p0" },
        () => {
            const aggregate = new SqliteTargetPermitMediationAggregate(
                new TestSqlite(),
                tenant,
                targetActor,
                new RecordingTargetInvalidations()
            );
            const foreign = new SqliteTargetPermitMediationAggregate(
                new TestSqlite(),
                tenant,
                targetActor,
                new RecordingTargetInvalidations()
            );

            expect(() =>
                aggregate.transact((transaction) => {
                    aggregate.permitRequests.request(transaction, targetRequest("aggregate-outer"));
                    aggregate.transact((inner) =>
                        aggregate.permitRequests.request(inner, targetRequest("aggregate-inner"))
                    );
                })
            ).toThrow(/Nested actor transactions/);
            expect(
                aggregate.transact((transaction) =>
                    aggregate.permitRequests.requested(transaction, "aggregate-outer")
                )
            ).toBeUndefined();
            foreign.transact((transaction) => {
                expect(() =>
                    aggregate.permitRequests.request(
                        transaction,
                        targetRequest("aggregate-foreign")
                    )
                ).toThrow();
            });
        }
    );

    test(
        "requires the active Actor transaction scope even for the same database",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const store = new SqliteAuthorityPermitStore(database, targetActor);
            const request = targetRequest("active-scope");
            let useCaptured: (() => void) | undefined;

            expect(() => store.request(database, request)).toThrow();
            expect(() => database.transaction(() => store.request(database, request))).toThrow();

            store.transaction((transaction) => {
                useCaptured = () => {
                    store.request(transaction, targetRequest("captured-scope"));
                };
                expect(store.request(transaction, request).digest().equals(request.digest())).toBe(
                    true
                );
            });
            if (useCaptured === undefined)
                throw new TypeError("Expected a captured SQLite transaction");
            expect(useCaptured).toThrow();
            expect(
                store.transaction((transaction) => store.requested(transaction, "captured-scope"))
            ).toBeUndefined();
        }
    );

    test(
        "rejects nested permit transactions and rolls the outer scope back",
        { tags: "p0" },
        () => {
            const store = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);

            expect(() =>
                store.transaction((transaction) => {
                    store.request(transaction, targetRequest("outer-rollback"));
                    store.transaction((inner) =>
                        store.request(inner, targetRequest("nested-rollback"))
                    );
                })
            ).toThrow();

            expect(
                store.transaction((transaction) => store.requested(transaction, "outer-rollback"))
            ).toBeUndefined();
            expect(
                store.transaction((transaction) => store.requested(transaction, "nested-rollback"))
            ).toBeUndefined();
        }
    );

    test("issue binds each nonce to one exact expectation", { tags: "p0" }, () => {
        const store = new SqliteAuthorityPermitStore(new TestSqlite(), issuerActor);
        const first = issuedPermit("bound-nonce");
        const stored = store.transaction((transaction) => store.issue(transaction, first));
        expect(stored.digest().value).toBe(first.digest().value);
        const replay = store.transaction((transaction) => store.issue(transaction, first));
        expect(replay.digest().value).toBe(first.digest().value);
        expectExactFailure(
            () =>
                store.transaction((transaction) =>
                    store.issue(transaction, issuedPermit("bound-nonce", { attemptOrdinal: 1 }))
                ),
            "authority.denied",
            "Authority permit nonce is bound to another issuance expectation"
        );
        expect(
            store.transaction((transaction) => store.issued(transaction, "bound-nonce"))?.digest()
                .value
        ).toBe(first.digest().value);
    });

    test("issued and consumed project only their exact states", { tags: "p0" }, async () => {
        const target = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const { issuance, permit, authentication } = await admit("state-nonce", target);
        target.transaction((transaction) =>
            target.consume(transaction, authentication, permit, permit.expectation, consumeAt)
        );
        expect(
            target.transaction((transaction) => target.issued(transaction, "state-nonce"))
        ).toBeUndefined();
        expect(
            target.transaction((transaction) => target.consumed(transaction, "state-nonce"))?.value
        ).toBe(permit.digest().value);
        expect(
            target.transaction((transaction) => target.consumed(transaction, "missing-nonce"))
        ).toBeUndefined();
        expect(
            issuance.transaction((transaction) => issuance.consumed(transaction, "state-nonce"))
        ).toBeUndefined();
        expect(
            issuance
                .transaction((transaction) => issuance.issued(transaction, "state-nonce"))
                ?.digest().value
        ).toBe(permit.digest().value);
    });

    test("consume replay at a valid time reports exact nonce reuse", { tags: "p0" }, async () => {
        const target = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const { permit, authentication } = await admit("replay-nonce", target);
        target.transaction((transaction) =>
            target.consume(transaction, authentication, permit, permit.expectation, consumeAt)
        );
        expectExactFailure(
            () =>
                target.transaction((transaction) =>
                    target.consume(
                        transaction,
                        authentication,
                        permit,
                        permit.expectation,
                        new Date(issuedAt.getTime() + 2)
                    )
                ),
            "authority.denied",
            "Authority permit nonce was already used by this Actor owner"
        );
        expect(
            target.transaction((transaction) => target.consumed(transaction, "replay-nonce"))?.value
        ).toBe(permit.digest().value);
    });

    test("recovery validates consumed rows against the exact owner", { tags: "p0" }, async () => {
        const database = new TestSqlite();
        const target = new SqliteAuthorityPermitStore(database, targetActor);
        const { permit, authentication } = await admit("owner-nonce", target);
        target.transaction((transaction) =>
            target.consume(transaction, authentication, permit, permit.expectation, consumeAt)
        );
        expectExactFailure(
            () =>
                new SqliteAuthorityPermitStore(
                    database,
                    new ActorRef("run", new ActorId("other-target"))
                ),
            "codec.invalid",
            corruptMessage
        );
        expectExactFailure(
            () =>
                new SqliteAuthorityPermitStore(
                    database,
                    new ActorRef("workspace", new ActorId(targetActor.id.value))
                ),
            "codec.invalid",
            corruptMessage
        );
        expect(() => new SqliteAuthorityPermitStore(database, targetActor)).not.toThrow();
    });

    test(
        "recovery rejects limbo states and resurrected consumed records",
        { tags: "p0" },
        async () => {
            const database = new ProjectedSqlite();
            const target = new SqliteAuthorityPermitStore(database, targetActor);
            const { permit, authentication } = await admit("recovery-nonce", target);
            target.transaction((transaction) =>
                target.consume(transaction, authentication, permit, permit.expectation, consumeAt)
            );
            database.mapRows = (rows) => rows.map((value) => ({ ...value, state: "limbo" }));
            expectExactFailure(
                () => new SqliteAuthorityPermitStore(database, targetActor),
                "codec.invalid",
                corruptMessage
            );
            database.mapRows = (rows) =>
                rows.map((value) => ({ ...value, record: AuthorityPermit.encode(permit) }));
            expectExactFailure(
                () => new SqliteAuthorityPermitStore(database, targetActor),
                "codec.invalid",
                corruptMessage
            );
            database.mapRows = (rows) => rows;
            expect(() => new SqliteAuthorityPermitStore(database, targetActor)).not.toThrow();
        }
    );

    test("issued rows must decode to the exact stored nonce", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteAuthorityPermitStore(database, issuerActor);
        store.transaction((transaction) => store.issue(transaction, issuedPermit("swap-first")));
        const second = store.transaction((transaction) =>
            store.issue(transaction, issuedPermit("swap-second", { attemptOrdinal: 1 }))
        );
        database.run("UPDATE authority_permit_nonces SET record = ?, digest = ? WHERE nonce = ?", [
            AuthorityPermit.encode(second),
            second.digest().value,
            "swap-first"
        ]);
        expectExactFailure(
            () => store.transaction((transaction) => store.issued(transaction, "swap-first")),
            "codec.invalid",
            corruptMessage
        );
        expect(
            store.transaction((transaction) => store.issued(transaction, "swap-second"))?.digest()
                .value
        ).toBe(second.digest().value);
    });

    test("issued rejects driver rows for another nonce", { tags: "p0" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, issuerActor);
        store.transaction((transaction) => store.issue(transaction, issuedPermit("row-nonce")));
        database.mapRows = (rows) => rows.map((value) => ({ ...value, nonce: "other-nonce" }));
        expectExactFailure(
            () => store.transaction((transaction) => store.issued(transaction, "row-nonce")),
            "codec.invalid",
            corruptMessage
        );
    });

    test("consumed digest columns fail closed as typed corruption", { tags: "p1" }, async () => {
        const database = new ProjectedSqlite();
        const target = new SqliteAuthorityPermitStore(database, targetActor);
        const { permit, authentication } = await admit("digest-nonce", target);
        target.transaction((transaction) =>
            target.consume(transaction, authentication, permit, permit.expectation, consumeAt)
        );
        database.mapRows = (rows) => rows.map((value) => ({ ...value, digest: "" }));
        expectExactFailure(
            () => target.transaction((transaction) => target.consumed(transaction, "digest-nonce")),
            "codec.invalid",
            corruptMessage
        );
        database.mapRows = (rows) => rows.map((value) => ({ ...value, digest: 77 }));
        expectExactFailure(
            () => target.transaction((transaction) => target.consumed(transaction, "digest-nonce")),
            "codec.invalid",
            corruptMessage
        );
    });

    test("consume that does not persist reports the exact conflict", { tags: "p0" }, async () => {
        const database = new ProjectedSqlite();
        const target = new SqliteAuthorityPermitStore(database, targetActor);
        const { permit, authentication } = await admit("lost-nonce", target);
        database.dropRuns = true;
        expectExactFailure(
            () =>
                target.transaction((transaction) =>
                    target.consume(
                        transaction,
                        authentication,
                        permit,
                        permit.expectation,
                        consumeAt
                    )
                ),
            "protocol.revision-conflict",
            "Authority permit consumption did not persist exactly"
        );
    });
});

class ProjectedSqlite extends TestSqlite {
    readonly #database = new TestSqlite();
    public dropRuns = false;
    public mapRows: (rows: readonly SqliteRow[]) => readonly SqliteRow[] = (rows) => rows;

    protected override query(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.mapRows(this.#database.all(statement, bindings));
    }

    protected override execute(statement: string, bindings: readonly SqliteValue[]): void {
        if (!this.dropRuns) this.#database.run(statement, bindings);
    }

    public override transaction<Result>(
        operation: () => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#database.transaction(operation, ...guard);
    }
}

class StoreIssuedRecordSource extends AuthorityPermitIssuedRecordSource {
    public constructor(private readonly store: SqliteAuthorityPermitStore) {
        super();
    }

    public issued(
        issuer: ActorRef,
        nonce: string,
        digest: Digest
    ): Promise<Uint8Array | undefined> {
        const stored = this.store.transaction((transaction) =>
            this.store.issued(transaction, nonce)
        );
        return Promise.resolve(
            stored?.issuer.equals(issuer) === true && stored.digest().equals(digest)
                ? AuthorityPermit.encode(stored)
                : undefined
        );
    }
}

async function admit(
    nonce: string,
    target: SqliteAuthorityPermitStore
): Promise<{
    issuance: SqliteAuthorityPermitStore;
    permit: AuthorityPermit;
    authentication: AuthenticatedAuthorityPermit;
}> {
    const issuance = new SqliteAuthorityPermitStore(new TestSqlite(), issuerActor);
    const permit = issuance.transaction((transaction) =>
        issuance.issue(transaction, issuedPermit(nonce))
    );
    target.transaction((transaction) => target.request(transaction, targetRequest(nonce)));
    const authentication = await new AuthorityPermitAuthenticator(
        new StoreIssuedRecordSource(issuance)
    ).authenticate(permit, permit.expectation);
    return { issuance, permit, authentication };
}

function issuedPermit(
    nonce: string,
    overrides: Partial<AuthorityPermitExpectationInit> = {}
): AuthorityPermit {
    const expected = expectation(overrides);
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
            domain: new ProtectionDomain("backend", "sqlite-permit-domain", "no-secrets")
        },
        principal,
        binding: { name: new BindingName("mail"), generation: new Revision(2) },
        facet: new FacetRef("workspace:mail"),
        operation: new OperationRef("workspace:send"),
        package: new PackagePin(
            new PackageId("sqlite-permit-package"),
            new SemVer("1.0.0"),
            digest("manifest"),
            digest("code")
        ),
        impact: "externalSend",
        invocation,
        reservation: {
            run: new RunId("sqlite-permit-run"),
            registryEpoch: 1,
            obligation: { kind: "invocationItem", invocation, itemIndex: 0, itemKey }
        },
        itemIndex: 0,
        attemptOrdinal: 0,
        claim: new ItemClaimId("sqlite-permit-claim"),
        claimOwner: {
            kind: "executor",
            token: lease,
            worker: new ClaimWorkerId("sqlite-permit-worker")
        },
        itemKey,
        argumentsDigest: Digest.sha256(encodeCanonicalJson(authorityArguments)),
        intentDigest: digest("intent"),
        pathEpochs: path,
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
        new GrantId("sqlite-permit-grant"),
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

class RecordingTargetInvalidations extends SqliteTargetResolutionInvalidationPort {
    public readonly expectations: AuthorityPermitExpectation[] = [];

    public invalidate(
        _transaction: TransactionalSqlite,
        expected: AuthorityPermitExpectation
    ): void {
        this.expectations.push(expected);
    }
}

function expectExactFailure(
    operation: () => void,
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

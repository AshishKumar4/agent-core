import { describe, expect, test } from "vitest";
import {
    ActorId,
    ActorRecoveryState,
    ActorRef,
    type SynchronousResultGuard
} from "../../../src/actors";
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
    SqliteTenantAuthorityPermitStore,
    TransactionalSqlite,
    createSqliteTenantControlStore,
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
const tenantAnchor = Object.freeze({
    actorId: issuerActor.id,
    tenantId: tenant,
    principalId: principal.principalId,
    tenantKind: "personal" as const,
    trustAnchor: Uint8Array.of(7, 7, 7)
});

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

    test("request and deny refuse target records owned by another Actor", { tags: "p0" }, () => {
        const store = new SqliteAuthorityPermitStore(
            new TestSqlite(),
            new ActorRef("run", new ActorId("sqlite-permit-other-target"))
        );
        const request = targetRequest("foreign-owner");

        expectExactFailure(
            () => store.transaction((transaction) => store.request(transaction, request)),
            "authority.denied",
            "Authority permit request targets another Actor owner"
        );
        expectExactFailure(
            () =>
                store.transaction((transaction) =>
                    store.deny(transaction, deniedTargetRequest(request))
                ),
            "authority.denied",
            "Authority permit denial targets another Actor owner"
        );
        expect(
            store.transaction((transaction) => store.requested(transaction, "foreign-owner"))
        ).toBeUndefined();
    });

    test("issue and consume refuse permits owned by another Actor", { tags: "p0" }, async () => {
        const foreignIssuer = new SqliteAuthorityPermitStore(
            new TestSqlite(),
            new ActorRef("tenant", new ActorId("sqlite-permit-other-issuer"))
        );
        expectExactFailure(
            () =>
                foreignIssuer.transaction((transaction) =>
                    foreignIssuer.issue(transaction, issuedPermit("foreign-issuer"))
                ),
            "authority.denied",
            "Authority permit was issued by another Actor owner"
        );

        const target = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const { permit, authentication } = await admit("foreign-consumer", target);
        const foreignTarget = new SqliteAuthorityPermitStore(
            new TestSqlite(),
            new ActorRef("run", new ActorId("sqlite-permit-other-consumer"))
        );
        expectExactFailure(
            () =>
                foreignTarget.transaction((transaction) =>
                    foreignTarget.consume(
                        transaction,
                        authentication,
                        permit,
                        permit.expectation,
                        consumeAt
                    )
                ),
            "authority.denied",
            "Authority permit targets another Actor owner"
        );
    });

    test("permit writes refuse a transaction from another SQLite owner", { tags: "p0" }, () => {
        const store = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const foreign = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const request = targetRequest("foreign-transaction");

        foreign.transaction((transaction) => {
            expectExactTypeError(
                () => store.request(transaction, request),
                "Authority permit transaction belongs to another SQLite owner"
            );
        });
        expect(
            store.transaction((transaction) => store.requested(transaction, "foreign-transaction"))
        ).toBeUndefined();
    });

    test("request binds each nonce to one exact target request", { tags: "p0" }, () => {
        const store = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const request = targetRequest("bound-request");

        expect(
            store.transaction((transaction) => store.request(transaction, request)).digest().value
        ).toBe(request.digest().value);
        expect(
            store.transaction((transaction) => store.request(transaction, request)).digest().value
        ).toBe(request.digest().value);
        expectExactFailure(
            () =>
                store.transaction((transaction) =>
                    store.request(
                        transaction,
                        targetRequestFor(expectation({ attemptOrdinal: 1 }), "bound-request")
                    )
                ),
            "authority.denied",
            "Authority permit nonce is bound to another target request"
        );
        expect(
            store.transaction((transaction) => store.requested(transaction, "bound-request"))
                ?.digest().value
        ).toBe(request.digest().value);
    });

    test("request refuses a nonce whose durable row never appears", { tags: "p1" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, targetActor);
        database.dropRuns = true;

        expectExactFailure(
            () =>
                store.transaction((transaction) =>
                    store.request(transaction, targetRequest("dropped-request"))
                ),
            "authority.denied",
            "Authority permit nonce was already used by this Actor owner"
        );
    });

    test("request write failures keep their typed cause", { tags: "p2" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, targetActor);
        const record = (): TargetAuthorityPermitRequest =>
            store.transaction((transaction) =>
                store.request(transaction, targetRequest("failed-request"))
            );

        database.failRun = new AgentCoreError("actor.closed", "request storage is closed");
        expectExactFailure(record, "actor.closed", "request storage is closed");
        database.failRun = new TypeError("request write failure");
        expectExactFailure(
            record,
            "authority.denied",
            "Authority permit target request could not be recorded atomically"
        );
    });

    test("deny requires the exact durable target request", { tags: "p0" }, () => {
        const store = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const request = targetRequest("undenied-request");

        expectExactFailure(
            () =>
                store.transaction((transaction) =>
                    store.deny(transaction, deniedTargetRequest(request))
                ),
            "authority.denied",
            "Authority denial does not match its exact durable target request"
        );
        store.transaction((transaction) => store.request(transaction, request));
        expectExactFailure(
            () =>
                store.transaction((transaction) =>
                    store.deny(
                        transaction,
                        deniedTargetRequest(
                            targetRequestFor(
                                expectation({ attemptOrdinal: 1 }),
                                "undenied-request"
                            )
                        )
                    )
                ),
            "authority.denied",
            "Authority denial does not match its exact durable target request"
        );
        expect(
            store.transaction((transaction) => store.denied(transaction, "undenied-request"))
        ).toBeUndefined();
    });

    test("deny replays one denial and refuses a second for that nonce", { tags: "p0" }, () => {
        const store = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const request = targetRequest("bound-denial");
        const denial = deniedTargetRequest(request);
        store.transaction((transaction) => store.request(transaction, request));

        expect(
            store.transaction((transaction) => store.deny(transaction, denial)).digest().value
        ).toBe(denial.digest().value);
        expect(
            store.transaction((transaction) => store.deny(transaction, denial)).digest().value
        ).toBe(denial.digest().value);
        expectExactFailure(
            () =>
                store.transaction((transaction) =>
                    store.deny(transaction, deniedTargetRequest(request, new Date(2_000)))
                ),
            "authority.denied",
            "Authority permit nonce is bound to another Tenant denial"
        );
        expect(
            store.transaction((transaction) => store.denied(transaction, "bound-denial"))?.digest()
                .value
        ).toBe(denial.digest().value);
    });

    test("deny refuses a nonce this Actor already consumed", { tags: "p0" }, async () => {
        const target = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const { permit, authentication } = await admit("consumed-denial", target);
        target.transaction((transaction) =>
            target.consume(transaction, authentication, permit, permit.expectation, consumeAt)
        );

        expectExactFailure(
            () =>
                target.transaction((transaction) =>
                    target.deny(
                        transaction,
                        deniedTargetRequest(targetRequest("consumed-denial"))
                    )
                ),
            "authority.denied",
            "Authority permit nonce was already consumed by this Actor owner"
        );
        expect(
            target.transaction((transaction) => target.denied(transaction, "consumed-denial"))
        ).toBeUndefined();
    });

    test("denial write failures keep their typed cause", { tags: "p2" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, targetActor);
        const request = targetRequest("failed-denial");
        const denial = deniedTargetRequest(request);
        store.transaction((transaction) => store.request(transaction, request));
        const record = (): TargetAuthorityPermitDenial =>
            store.transaction((transaction) => store.deny(transaction, denial));

        database.failRun = new AgentCoreError("actor.closed", "denial storage is closed");
        expectExactFailure(record, "actor.closed", "denial storage is closed");
        database.failRun = new TypeError("denial write failure");
        expectExactFailure(
            record,
            "authority.denied",
            "Authority permit denial could not be recorded atomically"
        );
    });

    test("deny reports a denial that did not persist exactly", { tags: "p0" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, targetActor);
        const request = targetRequest("lost-denial");
        const denial = deniedTargetRequest(request);
        const other = deniedTargetRequest(request, new Date(2_000));
        store.transaction((transaction) => store.request(transaction, request));
        const record = (): TargetAuthorityPermitDenial =>
            store.transaction((transaction) => store.deny(transaction, denial));

        database.dropRuns = true;
        expectExactFailure(
            record,
            "protocol.revision-conflict",
            "Authority permit denial did not persist exactly"
        );

        database.dropRuns = false;
        database.mapRows = (rows) =>
            rows.map((row) =>
                "denial" in row
                    ? {
                          ...row,
                          digest: other.digest().value,
                          denial: TargetAuthorityPermitDenial.encode(other)
                      }
                    : row
            );
        expectExactFailure(
            record,
            "protocol.revision-conflict",
            "Authority permit denial did not persist exactly"
        );
        database.mapRows = (rows) => rows;
        expect(
            store.transaction((transaction) => store.denied(transaction, "lost-denial"))
        ).toBeUndefined();
    });

    test("issue write failures keep their typed cause", { tags: "p2" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, issuerActor);
        const permit = issuedPermit("failed-issue");
        const record = (): AuthorityPermit =>
            store.transaction((transaction) => store.issue(transaction, permit));

        database.failRun = new AgentCoreError("actor.closed", "issuance storage is closed");
        expectExactFailure(record, "actor.closed", "issuance storage is closed");
        database.failRun = new TypeError("issue write failure");
        expectExactFailure(
            record,
            "authority.denied",
            "Authority permit nonce could not be issued atomically"
        );
        database.failRun = undefined;
        database.dropRuns = true;
        expectExactFailure(
            record,
            "authority.denied",
            "Authority permit nonce was already used by this Actor owner"
        );
    });

    test("consume refuses a permit with no durable target request", { tags: "p0" }, async () => {
        const target = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const { permit, authentication } = await admit("unrequested-nonce", target);
        const empty = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);

        expectExactFailure(
            () =>
                empty.transaction((transaction) =>
                    empty.consume(
                        transaction,
                        authentication,
                        permit,
                        permit.expectation,
                        consumeAt
                    )
                ),
            "authority.denied",
            "Authority permit has no durable target request"
        );
    });

    test("consume refuses a nonce another owner already occupies", { tags: "p0" }, async () => {
        const database = new TestSqlite();
        const issuance = new SqliteAuthorityPermitStore(database, issuerActor);
        const target = new SqliteAuthorityPermitStore(database, targetActor);
        const permit = issuance.transaction((transaction) =>
            issuance.issue(transaction, issuedPermit("occupied-nonce"))
        );
        const authentication = await new AuthorityPermitAuthenticator(
            new StoreIssuedRecordSource(issuance)
        ).authenticate(permit, permit.expectation);

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
            "authority.denied",
            "Authority permit nonce was already used by this Actor owner"
        );
        expect(
            target.transaction((transaction) => target.consumed(transaction, "occupied-nonce"))
        ).toBeUndefined();
    });

    test("consume refuses requests that are not its exact admission", { tags: "p0" }, async () => {
        const target = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const issuance = new SqliteAuthorityPermitStore(new TestSqlite(), issuerActor);
        const admission = async (
            stored: TargetAuthorityPermitRequest,
            permit: AuthorityPermit
        ): Promise<() => void> => {
            target.transaction((transaction) => target.request(transaction, stored));
            const issued = issuance.transaction((transaction) =>
                issuance.issue(transaction, permit)
            );
            const authentication = await new AuthorityPermitAuthenticator(
                new StoreIssuedRecordSource(issuance)
            ).authenticate(issued, issued.expectation);
            return () =>
                target.transaction((transaction) =>
                    target.consume(
                        transaction,
                        authentication,
                        issued,
                        issued.expectation,
                        consumeAt
                    )
                );
        };

        expectExactFailure(
            await admission(
                targetRequest("mismatched-expectation"),
                issuedPermit("mismatched-expectation", { attemptOrdinal: 1 })
            ),
            "authority.denied",
            "Authority permit does not match its exact target request"
        );
        expectExactFailure(
            await admission(
                targetRequestFor(
                    expectation(),
                    "mismatched-request",
                    new GrantId("sqlite-permit-other-grant")
                ),
                issuedPermit("mismatched-request")
            ),
            "authority.denied",
            "Authority permit was issued for another target request"
        );
    });

    test("consume refuses a request its Tenant denied", { tags: "p0" }, async () => {
        const target = new SqliteAuthorityPermitStore(new TestSqlite(), targetActor);
        const { permit, authentication } = await admit("denied-nonce", target);
        target.transaction((transaction) =>
            target.deny(transaction, deniedTargetRequest(targetRequest("denied-nonce")))
        );

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
            "authority.denied",
            "Authority permit request was denied by its Tenant"
        );
        expect(
            target.transaction((transaction) => target.consumed(transaction, "denied-nonce"))
        ).toBeUndefined();
    });

    test("consumption write failures keep their typed cause", { tags: "p2" }, async () => {
        const database = new ProjectedSqlite();
        const target = new SqliteAuthorityPermitStore(database, targetActor);
        const { permit, authentication } = await admit("failed-consume", target);
        const record = (): void =>
            target.transaction((transaction) =>
                target.consume(transaction, authentication, permit, permit.expectation, consumeAt)
            );

        database.failRun = new AgentCoreError("actor.closed", "consumption storage is closed");
        expectExactFailure(record, "actor.closed", "consumption storage is closed");
        database.failRun = new TypeError("consumption write failure");
        expectExactFailure(
            record,
            "authority.denied",
            "Authority permit nonce could not be consumed exactly once"
        );
    });

    test("permit, consumption and denial reads fail closed", { tags: "p2" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, targetActor);
        const readRequest = (): TargetAuthorityPermitRequest | undefined =>
            store.transaction((transaction) => store.requested(transaction, "closed-read"));
        const readConsumption = (): Digest | undefined =>
            store.transaction((transaction) => store.consumed(transaction, "closed-read"));
        const readDenial = (): TargetAuthorityPermitDenial | undefined =>
            store.transaction((transaction) => store.denied(transaction, "closed-read"));

        database.failAll = new AgentCoreError("actor.closed", "permit read is closed");
        expectExactFailure(readRequest, "actor.closed", "permit read is closed");
        expectExactFailure(readConsumption, "actor.closed", "permit read is closed");
        expectExactFailure(readDenial, "actor.closed", "permit read is closed");

        database.failAll = new TypeError("permit read failure");
        expectExactFailure(readRequest, "codec.invalid", "Authority permit read failed");
        expectExactFailure(
            readConsumption,
            "codec.invalid",
            "Authority permit consumption read failed"
        );
        expectExactFailure(readDenial, "codec.invalid", "Authority permit denial read failed");
    });

    test("schema initialization failures fail closed", { tags: "p2" }, () => {
        const database = new ProjectedSqlite();
        database.failRun = new TypeError("schema write failure");

        expectExactFailure(
            () => new SqliteAuthorityPermitStore(database, targetActor),
            "codec.invalid",
            "Authority permit schema initialization failed"
        );
    });

    test("recovery read failures keep their typed cause", { tags: "p2" }, () => {
        const database = new ProjectedSqlite();

        database.failAll = new AgentCoreError("actor.closed", "recovery read is closed");
        expectExactFailure(
            () => new SqliteAuthorityPermitStore(database, targetActor),
            "actor.closed",
            "recovery read is closed"
        );
        database.failAll = new TypeError("recovery read failure");
        expectExactFailure(
            () => new SqliteAuthorityPermitStore(database, targetActor),
            "codec.invalid",
            "Authority permit recovery read failed"
        );
    });

    test("restart revalidates and republishes issued and denied rows", { tags: "p1" }, () => {
        const targetDatabase = new TestSqlite();
        const target = new SqliteAuthorityPermitStore(targetDatabase, targetActor);
        const request = targetRequest("recovered-denial");
        const denial = deniedTargetRequest(request);
        target.transaction((transaction) => {
            target.request(transaction, request);
            target.deny(transaction, denial);
        });
        const issuanceDatabase = new TestSqlite();
        const issuance = new SqliteAuthorityPermitStore(issuanceDatabase, issuerActor);
        const permit = issuance.transaction((transaction) =>
            issuance.issue(transaction, issuedPermit("recovered-issue"))
        );

        const restartedTarget = new SqliteAuthorityPermitStore(targetDatabase, targetActor);
        const restartedIssuance = new SqliteAuthorityPermitStore(issuanceDatabase, issuerActor);
        expect(
            restartedTarget
                .transaction((transaction) =>
                    restartedTarget.denied(transaction, "recovered-denial")
                )
                ?.digest().value
        ).toBe(denial.digest().value);
        expect(
            restartedIssuance
                .transaction((transaction) =>
                    restartedIssuance.issued(transaction, "recovered-issue")
                )
                ?.digest().value
        ).toBe(permit.digest().value);
    });

    test("recovery refuses a nonce that is both denied and consumed", { tags: "p0" }, async () => {
        const database = new TestSqlite();
        const target = new SqliteAuthorityPermitStore(database, targetActor);
        const { permit, authentication } = await admit("limbo-nonce", target);
        target.transaction((transaction) =>
            target.consume(transaction, authentication, permit, permit.expectation, consumeAt)
        );
        const denial = deniedTargetRequest(targetRequest("limbo-nonce"));
        database.run(
            `INSERT INTO authority_permit_denials (nonce, owner_kind, owner_id, digest, denial)
             VALUES (?, ?, ?, ?, ?)`,
            [
                "limbo-nonce",
                targetActor.kind,
                targetActor.id.value,
                denial.digest().value,
                TargetAuthorityPermitDenial.encode(denial)
            ]
        );

        expectExactFailure(
            () => new SqliteAuthorityPermitStore(database, targetActor),
            "codec.invalid",
            corruptMessage
        );
    });

    test("stored target requests must match their row exactly", { tags: "p2" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, targetActor);
        const request = targetRequest("request-row");
        store.transaction((transaction) => store.request(transaction, request));
        const read = (): TargetAuthorityPermitRequest | undefined =>
            store.transaction((transaction) => store.requested(transaction, "request-row"));

        database.mapRows = (rows) =>
            rows.map((row) => ("record" in row ? { ...row, record: null } : row));
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) =>
            rows.map((row) => ("record" in row ? { ...row, nonce: "other-nonce" } : row));
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) => rows;
        expect(read()?.digest().value).toBe(request.digest().value);
    });

    test("stored issued permits must match their row exactly", { tags: "p2" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, issuerActor);
        const permit = store.transaction((transaction) =>
            store.issue(transaction, issuedPermit("issued-row"))
        );
        const read = (): AuthorityPermit | undefined =>
            store.transaction((transaction) => store.issued(transaction, "issued-row"));

        database.mapRows = (rows) =>
            rows.map((row) => ("record" in row ? { ...row, record: null } : row));
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) =>
            rows.map((row) =>
                "record" in row ? { ...row, record: Uint8Array.of(9, 9, 9) } : row
            );
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) => rows;
        expect(read()?.digest().value).toBe(permit.digest().value);
    });

    test("stored consumptions must match their row exactly", { tags: "p2" }, async () => {
        const database = new ProjectedSqlite();
        const target = new SqliteAuthorityPermitStore(database, targetActor);
        const { permit, authentication } = await admit("consumption-row", target);
        target.transaction((transaction) =>
            target.consume(transaction, authentication, permit, permit.expectation, consumeAt)
        );
        const read = (): Digest | undefined =>
            target.transaction((transaction) => target.consumed(transaction, "consumption-row"));

        database.mapRows = (rows) =>
            rows.map((row) => ("permit" in row ? { ...row, permit: null } : row));
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) =>
            rows.map((row) =>
                "permit" in row ? { ...row, permit: Uint8Array.of(9, 9, 9) } : row
            );
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) =>
            rows.map((row) => ("permit" in row ? { ...row, digest: "0".repeat(64) } : row));
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) => rows;
        expect(read()?.value).toBe(permit.digest().value);
    });

    test("stored denials must match their row exactly", { tags: "p2" }, () => {
        const database = new ProjectedSqlite();
        const store = new SqliteAuthorityPermitStore(database, targetActor);
        const request = targetRequest("denial-row");
        const denial = deniedTargetRequest(request);
        store.transaction((transaction) => {
            store.request(transaction, request);
            store.deny(transaction, denial);
        });
        const read = (): TargetAuthorityPermitDenial | undefined =>
            store.transaction((transaction) => store.denied(transaction, "denial-row"));

        database.mapRows = (rows) =>
            rows.map((row) => ("denial" in row ? { ...row, denial: null } : row));
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) =>
            rows.map((row) =>
                "denial" in row ? { ...row, denial: Uint8Array.of(9, 9, 9) } : row
            );
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) =>
            rows.map((row) => ("denial" in row ? { ...row, digest: "0".repeat(64) } : row));
        expectExactFailure(read, "codec.invalid", corruptMessage);
        database.mapRows = (rows) => rows;
        expect(read()?.digest().value).toBe(denial.digest().value);
    });

    test("Tenant permit store requires a Tenant Actor", { tags: "p0" }, () => {
        expectExactTypeError(
            () => new SqliteTenantAuthorityPermitStore(new TestSqlite(), targetActor),
            "SQLite Tenant authority permit store requires a Tenant Actor"
        );
    });

    test("Tenant permit store binds one Actor and recovers its state", { tags: "p0" }, () => {
        const store = tenantPermitStore(new TestSqlite());
        store.bindActor(issuerActor);
        store.transaction((transaction) =>
            store.saveRecoveryState(transaction, ActorRecoveryState.initial(issuerActor))
        );
        const saved = store.transaction((transaction) =>
            store.loadRecoveryState(transaction, issuerActor)
        );
        expect(saved?.epoch).toBe(0);
        expect(saved?.recoveries).toBe(1);

        const activations: string[] = [];
        const recovered = store.activateActor(issuerActor, (_transaction, activation) => {
            activations.push(activation.kind);
        });
        expect(activations).toEqual(["recovered"]);
        expect(recovered.epoch).toBe(1);
        expect(recovered.recoveries).toBe(2);
        expect(
            store.transaction((transaction) => store.loadRecoveryState(transaction, issuerActor))
                ?.epoch
        ).toBe(1);
        expectExactFailure(
            () => store.bindActor(new ActorRef("tenant", new ActorId("sqlite-permit-other-tenant"))),
            "protocol.invalid-state",
            "SQLite ActorStore is bound to a different Actor"
        );
    });

    test("Tenant authority view requires this store's active transaction", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = tenantPermitStore(database);

        const view = store.transaction((transaction) => store.authority(transaction));
        expect(view.tenantId.value).toBe(tenant.value);
        expect(view.principal(principal.principalId)?.id.value).toBe(
            principal.principalId.value
        );
        expectExactTypeError(
            () => store.authority(new TestSqlite()),
            "Tenant authority transaction belongs to another SQLite owner"
        );
        expectExactFailure(
            () => store.authority(database),
            "actor.stale-callback",
            "Tenant authority writes require the active SQLite Actor transaction"
        );
    });

    test("Tenant permit store issues permits in its own transaction", { tags: "p1" }, () => {
        const store = tenantPermitStore(new TestSqlite());
        const permit = issuedPermit("tenant-issued");

        const states = store.transaction((transaction) => {
            expect(store.issue(transaction, permit).digest().value).toBe(permit.digest().value);
            expect(store.issued(transaction, "tenant-issued")?.digest().value).toBe(
                permit.digest().value
            );
            return store.read(transaction, (reader) =>
                reader
                    .all("SELECT state FROM authority_permit_nonces WHERE nonce = ?", [
                        "tenant-issued"
                    ])
                    .map((row) => row["state"])
            );
        });
        expect(states).toEqual(["issued"]);
    });
});

class ProjectedSqlite extends TestSqlite {
    readonly #database = new TestSqlite();
    public dropRuns = false;
    public failAll: unknown;
    public failRun: unknown;
    public mapRows: (rows: readonly SqliteRow[]) => readonly SqliteRow[] = (rows) => rows;

    protected override query(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (this.failAll !== undefined) throw this.failAll;
        return this.mapRows(this.#database.all(statement, bindings));
    }

    protected override execute(statement: string, bindings: readonly SqliteValue[]): void {
        if (this.failRun !== undefined) throw this.failRun;
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
    nonce: string,
    grant = new GrantId("sqlite-permit-grant")
): TargetAuthorityPermitRequest {
    const binding = new Binding(
        expected.pathEpochs.target.scope,
        SubjectRef.principal(expected.principal),
        expected.target.domain,
        expected.binding.name,
        grant,
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

function deniedTargetRequest(
    request: TargetAuthorityPermitRequest,
    decidedAt = issuedAt
): TargetAuthorityPermitDenial {
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
            decidedAt
        )
    );
}

function tenantPermitStore(database: TransactionalSqlite): SqliteTenantAuthorityPermitStore {
    const control = createSqliteTenantControlStore(database, tenantAnchor);
    database.transaction(() =>
        control.bootstrapTenant(database, tenantAnchor, Revision.initial())
    );
    return new SqliteTenantAuthorityPermitStore(database, issuerActor);
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

function expectExactTypeError(operation: () => void, message: string): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        if (error instanceof TypeError) expect(error.message).toBe(message);
        return;
    }
    throw new TypeError(`Expected TypeError ${message}`);
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

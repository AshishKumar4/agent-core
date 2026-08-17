import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../src/actors";
import { RunId, TurnId } from "../../src/agents";
import {
    AuthenticatedAuthorityPermit,
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermit,
    AuthorityPermitAuthenticator,
    AuthorityPermitExpectation,
    AuthorityPermitIssuedRecordSource,
    AuthorityPermitIssuer as TenantAuthorityPermitIssuer,
    Binding,
    GrantId,
    MemoryAuthorityPermitStore,
    PathEpochEvidence,
    ScopeEpoch,
    StoredAuthorityPermitAdmissionPort,
    TargetAuthorityPermitDenial,
    TargetAuthorityPermitRequest,
    requireAuthenticatedAuthorityPermit,
    type AuthorityPermitExpectationInit,
    type AuthorityPermitIssueStore,
    type AuthorityPermitTargetStore
} from "../../src/authority";
import {
    Digest,
    Revision,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonValue
} from "../../src/core";
import { corrupt } from "../helpers/corrupt";
import { violating } from "../helpers/malformed";
import { PackageId, PackagePin } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import { BindingName, FacetRef, OperationRef, ProtectionDomain } from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import { ClaimWorkerId, ItemClaimId } from "../../src/invocation-references";
import { InvocationId } from "../../src/interaction-references";
import {
    SqliteAuthorityPermitStore,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";

const tenant = new TenantId("permit-tenant");
const principalId = new PrincipalId("permit-principal");
const principal = new PrincipalRef(tenant, principalId);
const issuerActor = new ActorRef("tenant", new ActorId("permit-tenant-actor"));
const sourceActor = new ActorRef("workspace", new ActorId("permit-source-actor"));
const targetActor = new ActorRef("run", new ActorId("permit-target-actor"));
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("permit-workspace"));
const path = new PathEpochEvidence([
    new ScopeEpoch(ScopeRef.tenant(tenant), 4),
    new ScopeEpoch(workspaceScope, 9)
]);
const invocation = new InvocationId("permit-invocation");
const itemKey = "permit-item-key";
const lease = Object.freeze({
    turn: new TurnId("permit-turn"),
    holder: principal,
    epoch: 7
});
const issuedAt = new Date("2026-07-12T12:00:00.000Z");
const expiresAt = new Date("2026-07-12T12:00:05.000Z");

class CurrentAuthority<Transaction> {
    public live = true;
    public generation = 0;
    public path = path;
    public lastClaim: ItemClaimId | undefined;

    public evidence(
        _transaction: Transaction | undefined,
        request: TargetAuthorityPermitRequest,
        checkedAt: Date
    ): AuthorityCheckEvidence {
        const { expectation } = request;
        this.lastClaim = expectation.claim;
        const allowed =
            this.live &&
            expectation.binding.generation.value === this.generation &&
            expectation.pathEpochs.equals(this.path);
        return new AuthorityCheckEvidence(
            tenant,
            issuerActor,
            request.authority.digest(),
            request.authority.binding.key,
            request.authority.binding.generation,
            allowed ? "allow" : "deny",
            allowed ? "allowed" : "missingGrant",
            allowed ? [new GrantId("permit-current-authority-grant")] : [],
            [],
            this.path,
            checkedAt
        );
    }
}

type TestPermitOwnerStore<Transaction> = AuthorityPermitIssueStore<Transaction> &
    AuthorityPermitTargetStore<Transaction>;

class AuthorityPermitIssuer<Transaction> {
    readonly #issuer: TenantAuthorityPermitIssuer<Transaction>;

    public constructor(
        store: AuthorityPermitIssueStore<Transaction>,
        private readonly authority: CurrentAuthority<Transaction>
    ) {
        this.#issuer = new TenantAuthorityPermitIssuer(store);
    }

    public issue(
        transaction: Transaction,
        request: TargetAuthorityPermitRequest,
        at: Date
    ): AuthorityPermit {
        if (request.expiresAt.getTime() <= at.getTime()) {
            throw new AgentCoreError(
                "authority.denied",
                "Authority permit request expiry must be after issuance"
            );
        }
        const evidence = this.authority.evidence(transaction, request, at);
        if (!evidence.allowed) {
            throw new AgentCoreError("authority.denied", "Current authority does not admit permit");
        }
        return this.#issuer.issue(transaction, request, evidence, at);
    }
}

class AuthorityPermitRequester<Transaction> {
    public constructor(private readonly store: AuthorityPermitTargetStore<Transaction>) {}

    public request(
        transaction: Transaction,
        request: TargetAuthorityPermitRequest
    ): TargetAuthorityPermitRequest {
        return this.store.request(transaction, request);
    }
}

interface StoreHarness<Transaction> {
    readonly tenantStore: TestPermitOwnerStore<Transaction>;
    readonly targetStore: TestPermitOwnerStore<Transaction>;
    restartTenant(): TestPermitOwnerStore<Transaction>;
    restartTarget(): TestPermitOwnerStore<Transaction>;
}

function permitStoreContract<Transaction>(
    name: string,
    create: () => StoreHarness<Transaction>
): void {
    describe(`[authority-permit-owner-store] ${name}`, () => {
        test(
            "[authority-permit-target-store] [authority.target-permit-request] durably records one exact target request across restart",
            { tags: "p0" },
            () => {
                const harness = create();
                const requester = new AuthorityPermitRequester(harness.targetStore);
                const request = targetRequest(`${name}-request`);

                harness.targetStore.transaction((transaction) =>
                    requester.request(transaction, request)
                );
                const restarted = harness.restartTarget();
                const restored = restarted.transaction((transaction) =>
                    restarted.requested(transaction, request.nonce)
                );
                const restartedRequester = new AuthorityPermitRequester(restarted);

                expect(restored?.digest().equals(request.digest())).toBe(true);
                const conflict = caughtAgentCoreError(() =>
                    restarted.transaction((transaction) =>
                        restartedRequester.request(
                            transaction,
                            targetRequest(request.nonce, {
                                claim: new ItemClaimId("permit-substituted-claim")
                            })
                        )
                    )
                );
                expect(conflict.code).toBe("authority.denied");
            }
        );

        test(
            "issues and consumes exactly once across owner-store restart",
            { tags: "p0" },
            async () => {
                const harness = create();
                const authority = new CurrentAuthority<Transaction>();
                const expected = expectation();
                const issuer = new AuthorityPermitIssuer(harness.tenantStore, authority);
                const permit = harness.tenantStore.transaction((transaction) =>
                    issuer.issue(transaction, targetRequestFor(expected, `${name}-once`), issuedAt)
                );

                expect(authority.lastClaim?.equals(expected.claim)).toBe(true);
                const restartedTenant = harness.restartTenant();
                expect(
                    restartedTenant.transaction(
                        (transaction) =>
                            restartedTenant.issued(transaction, permit.nonce)?.digest().value
                    )
                ).toBe(permit.digest().value);
                const authentication = await authenticate(restartedTenant, permit, expected);

                recordTargetRequest(harness.targetStore, expected, permit.nonce);
                const restartedTarget = harness.restartTarget();
                const admission = new StoredAuthorityPermitAdmissionPort(restartedTarget);
                restartedTarget.transaction((transaction) =>
                    admission.consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() + 1)
                    )
                );
                const consumedTarget = harness.restartTarget();
                expect(
                    consumedTarget.transaction(
                        (transaction) => consumedTarget.consumed(transaction, permit.nonce)?.value
                    )
                ).toBe(permit.digest().value);
                expect(
                    consumedTarget
                        .transaction((transaction) =>
                            consumedTarget.requested(transaction, permit.nonce)
                        )
                        ?.digest()
                        .equals(targetRequestFor(expected, permit.nonce).digest())
                ).toBe(true);
                const replayTarget = harness.restartTarget();
                const replay = caughtAgentCoreError(() =>
                    replayTarget.transaction((transaction) =>
                        new StoredAuthorityPermitAdmissionPort(replayTarget).consume(
                            transaction,
                            authentication,
                            permit,
                            expected,
                            new Date(expiresAt.getTime() + 1)
                        )
                    )
                );
                expect(replay.code).toBe("authority.denied");
                expect(
                    replayTarget
                        .transaction((transaction) =>
                            replayTarget.requested(transaction, permit.nonce)
                        )
                        ?.digest()
                        .equals(targetRequestFor(expected, permit.nonce).digest())
                ).toBe(true);
            }
        );

        test(
            "rolls issue and consume back with their owner transactions",
            { tags: "p0" },
            async () => {
                const harness = create();
                const authority = new CurrentAuthority<Transaction>();
                const expected = expectation();
                const issuer = new AuthorityPermitIssuer(harness.tenantStore, authority);
                expect(() =>
                    harness.tenantStore.transaction((transaction) => {
                        issuer.issue(
                            transaction,
                            targetRequestFor(expected, `${name}-rollback`),
                            issuedAt
                        );
                        throw new AgentCoreError("protocol.invalid-state", "abort issuance");
                    })
                ).toThrow(/abort issuance/);
                expect(
                    harness.tenantStore.transaction((transaction) =>
                        harness.tenantStore.issued(transaction, `${name}-rollback`)
                    )
                ).toBeUndefined();

                const permit = harness.tenantStore.transaction((transaction) =>
                    issuer.issue(
                        transaction,
                        targetRequestFor(expected, `${name}-admission`),
                        issuedAt
                    )
                );
                const authentication = await authenticate(harness.tenantStore, permit, expected);
                recordTargetRequest(harness.targetStore, expected, permit.nonce);
                const admission = new StoredAuthorityPermitAdmissionPort(harness.targetStore);
                expect(() =>
                    harness.targetStore.transaction((transaction) => {
                        admission.consume(
                            transaction,
                            authentication,
                            permit,
                            expected,
                            new Date(issuedAt.getTime() + 1)
                        );
                        throw new AgentCoreError("invocation.invalid", "attempt admission failed");
                    })
                ).toThrow(/attempt admission failed/);
                expect(
                    harness.targetStore.transaction((transaction) =>
                        harness.targetStore.consumed(transaction, permit.nonce)
                    )
                ).toBeUndefined();
                harness.targetStore.transaction((transaction) =>
                    admission.consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() + 2)
                    )
                );
            }
        );

        test("replays an exact issuance after response loss and restart", { tags: "p0" }, () => {
            const harness = create();
            const authority = new CurrentAuthority<Transaction>();
            const expected = expectation();
            const nonce = `${name}-response-loss`;
            const first = harness.tenantStore.transaction((transaction) =>
                new AuthorityPermitIssuer(harness.tenantStore, authority).issue(
                    transaction,
                    targetRequestFor(expected, nonce),
                    issuedAt
                )
            );

            const restarted = harness.restartTenant();
            const replay = restarted.transaction((transaction) =>
                new AuthorityPermitIssuer(restarted, authority).issue(
                    transaction,
                    targetRequestFor(expected, nonce),
                    new Date(issuedAt.getTime() + 1_000)
                )
            );

            expect(AuthorityPermit.encode(replay)).toEqual(AuthorityPermit.encode(first));
        });

        test(
            "concurrent deterministic issuance converges on one exact permit",
            { tags: "p0" },
            async () => {
                const harness = create();
                const authority = new CurrentAuthority<Transaction>();
                const expected = expectation();
                const nonce = `${name}-concurrent`;
                const issue = (offset: number) =>
                    Promise.resolve().then(() =>
                        harness.tenantStore.transaction((transaction) =>
                            new AuthorityPermitIssuer(harness.tenantStore, authority).issue(
                                transaction,
                                targetRequestFor(expected, nonce),
                                new Date(issuedAt.getTime() + offset)
                            )
                        )
                    );

                const [left, right] = await Promise.all([issue(0), issue(1)]);
                expect(AuthorityPermit.encode(right)).toEqual(AuthorityPermit.encode(left));
                expect(
                    harness.tenantStore.transaction(
                        (transaction) =>
                            harness.tenantStore.issued(transaction, nonce)?.digest().value
                    )
                ).toBe(left.digest().value);
            }
        );

        test(
            "denies conflicting nonce reuse and foreign owner transactions",
            { tags: "p0" },
            () => {
                const harness = create();
                const authority = new CurrentAuthority<Transaction>();
                const expected = expectation();
                const issuer = new AuthorityPermitIssuer(harness.tenantStore, authority);
                const original = harness.tenantStore.transaction((transaction) =>
                    issuer.issue(transaction, targetRequestFor(expected, `${name}-cas`), issuedAt)
                );
                for (const [field, substituted] of substitutions(expected)) {
                    expect(
                        () =>
                            harness.tenantStore.transaction((transaction) =>
                                issuer.issue(
                                    transaction,
                                    targetRequestFor(substituted, `${name}-cas`),
                                    issuedAt
                                )
                            ),
                        field
                    ).toThrow();
                }
                expect(
                    harness.tenantStore.transaction(
                        (transaction) =>
                            harness.tenantStore.issued(transaction, original.nonce)?.digest().value
                    )
                ).toBe(original.digest().value);

                expect(() =>
                    harness.targetStore.transaction((transaction) =>
                        harness.tenantStore.issue(
                            transaction,
                            new AuthorityPermit({
                                ...expected,
                                nonce: `${name}-foreign`,
                                requestDigest: targetRequestFor(
                                    expected,
                                    `${name}-foreign`
                                ).digest(),
                                issuedAt,
                                expiresAt
                            })
                        )
                    )
                ).toThrow(TypeError);
            }
        );

        test(
            "refuses consumption without the exact durable target request across restart",
            { tags: "p0" },
            async () => {
                const harness = create();
                const expected = expectation();
                const permit = harness.tenantStore.transaction((transaction) =>
                    new AuthorityPermitIssuer(
                        harness.tenantStore,
                        new CurrentAuthority<Transaction>()
                    ).issue(
                        transaction,
                        targetRequestFor(expected, `${name}-missing-target-request`),
                        issuedAt
                    )
                );
                const authentication = await authenticate(
                    harness.restartTenant(),
                    permit,
                    expected
                );
                const restartedTarget = harness.restartTarget();

                const error = caughtAgentCoreError(() =>
                    restartedTarget.transaction((transaction) =>
                        new StoredAuthorityPermitAdmissionPort(restartedTarget).consume(
                            transaction,
                            authentication,
                            permit,
                            expected,
                            new Date(issuedAt.getTime() + 1)
                        )
                    )
                );
                expect(error.code).toBe("authority.denied");
                expect(
                    restartedTarget.transaction((transaction) =>
                        restartedTarget.consumed(transaction, permit.nonce)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "refuses a permit issued for a substituted full authority request",
            { tags: "p0" },
            async () => {
                const harness = create();
                const expected = expectation();
                const nonce = `${name}-substituted-authority-request`;
                const issuedRequest = targetRequestFor(expected, nonce);
                const substitutedRequest = targetRequestFor(
                    expected,
                    nonce,
                    expiresAt,
                    new GrantId("permit-substituted-request-grant")
                );
                expect(substitutedRequest.expectation.equals(issuedRequest.expectation)).toBe(true);
                expect(substitutedRequest.digest().equals(issuedRequest.digest())).toBe(false);

                const permit = harness.tenantStore.transaction((transaction) =>
                    new AuthorityPermitIssuer(
                        harness.tenantStore,
                        new CurrentAuthority<Transaction>()
                    ).issue(transaction, issuedRequest, issuedAt)
                );
                const authentication = await authenticate(
                    harness.restartTenant(),
                    permit,
                    expected
                );
                harness.targetStore.transaction((transaction) =>
                    new AuthorityPermitRequester(harness.targetStore).request(
                        transaction,
                        substitutedRequest
                    )
                );
                const restartedTarget = harness.restartTarget();

                const error = caughtAgentCoreError(() =>
                    restartedTarget.transaction((transaction) =>
                        new StoredAuthorityPermitAdmissionPort(restartedTarget).consume(
                            transaction,
                            authentication,
                            permit,
                            expected,
                            new Date(issuedAt.getTime() + 1)
                        )
                    )
                );
                expect(error.code).toBe("authority.denied");
                expect(
                    restartedTarget.transaction((transaction) =>
                        restartedTarget.consumed(transaction, nonce)
                    )
                ).toBeUndefined();
            }
        );

        test(
            "refuses a non-future request expiry before authority evaluation",
            { tags: "p0" },
            () => {
                const harness = create();
                const authority = new CurrentAuthority<Transaction>();

                const error = caughtAgentCoreError(() =>
                    harness.tenantStore.transaction((transaction) =>
                        new AuthorityPermitIssuer(harness.tenantStore, authority).issue(
                            transaction,
                            targetRequestFor(
                                expectation(),
                                `${name}-expired-at-issuance`,
                                issuedAt
                            ),
                            issuedAt
                        )
                    )
                );
                expect(error.code).toBe("authority.denied");
                expect(authority.lastClaim).toBeUndefined();
            }
        );

        test("[authority.target-permit-denial] stores exact denial", { tags: "p0" }, () => {
            const harness = create();
            const request = targetRequest(`${name}-denied`);
            const authority = new CurrentAuthority<Transaction>();
            authority.live = false;
            const evidence = authority.evidence(undefined, request, issuedAt);
            const denial = new TargetAuthorityPermitDenial(request, evidence);

            harness.targetStore.transaction((transaction) => {
                harness.targetStore.request(transaction, request);
                expect(
                    TargetAuthorityPermitDenial.encode(
                        harness.targetStore.deny(transaction, denial)
                    )
                ).toEqual(TargetAuthorityPermitDenial.encode(denial));
            });

            const restarted = harness.restartTarget();
            expect(
                TargetAuthorityPermitDenial.encode(
                    restarted.transaction((transaction) => {
                        const stored = restarted.denied(transaction, request.nonce);
                        if (stored === undefined) throw new TypeError("Expected retained denial");
                        return stored;
                    })
                )
            ).toEqual(TargetAuthorityPermitDenial.encode(denial));
            const substitutedRequest = targetRequest(request.nonce, {
                claim: new ItemClaimId("permit-substituted-denial-claim")
            });
            expect(() =>
                restarted.transaction((transaction) =>
                    restarted.deny(
                        transaction,
                        new TargetAuthorityPermitDenial(
                            substitutedRequest,
                            authority.evidence(undefined, substitutedRequest, issuedAt)
                        )
                    )
                )
            ).toThrow();
        });

        test("rolls target denial evidence back with its owner transaction", { tags: "p0" }, () => {
            const harness = create();
            const request = targetRequest(`${name}-denial-rollback`);
            const authority = new CurrentAuthority<Transaction>();
            authority.live = false;
            const denial = new TargetAuthorityPermitDenial(
                request,
                authority.evidence(undefined, request, issuedAt)
            );

            expect(() =>
                harness.targetStore.transaction((transaction) => {
                    harness.targetStore.request(transaction, request);
                    harness.targetStore.deny(transaction, denial);
                    throw new AgentCoreError("protocol.invalid-state", "abort target denial");
                })
            ).toThrow(/abort target denial/);
            expect(
                harness.targetStore.transaction((transaction) =>
                    harness.targetStore.denied(transaction, request.nonce)
                )
            ).toBeUndefined();
        });

        test(
            "closes captured transactions and rolls nested transactions back",
            { tags: "p0" },
            () => {
                const harness = create();
                const outer = targetRequest(`${name}-outer-scope`);
                const nested = targetRequest(`${name}-nested-scope`);
                let useCaptured: (() => void) | undefined;

                expect(() =>
                    harness.targetStore.transaction((transaction) => {
                        useCaptured = () => {
                            harness.targetStore.request(transaction, outer);
                        };
                        harness.targetStore.request(transaction, outer);
                        harness.targetStore.transaction((inner) =>
                            harness.targetStore.request(inner, nested)
                        );
                    })
                ).toThrow();

                if (useCaptured === undefined)
                    throw new TypeError("Expected a captured transaction");
                expect(useCaptured).toThrow();
                expect(
                    harness.targetStore.transaction((transaction) =>
                        harness.targetStore.requested(transaction, outer.nonce)
                    )
                ).toBeUndefined();
                expect(
                    harness.targetStore.transaction((transaction) =>
                        harness.targetStore.requested(transaction, nested.nonce)
                    )
                ).toBeUndefined();
            }
        );
    });
}

permitStoreContract("memory", () => {
    let tenantStore = new MemoryAuthorityPermitStore(issuerActor);
    let targetStore = new MemoryAuthorityPermitStore(targetActor);
    return {
        get tenantStore() {
            return tenantStore;
        },
        get targetStore() {
            return targetStore;
        },
        restartTenant() {
            tenantStore = new MemoryAuthorityPermitStore(issuerActor, tenantStore.snapshot());
            return tenantStore;
        },
        restartTarget() {
            targetStore = new MemoryAuthorityPermitStore(targetActor, targetStore.snapshot());
            return targetStore;
        }
    };
});

permitStoreContract<TransactionalSqlite>("sqlite", () => {
    const tenantDatabase = new TestSqlite();
    const targetDatabase = new TestSqlite();
    let tenantStore = new SqliteAuthorityPermitStore(tenantDatabase, issuerActor);
    let targetStore = new SqliteAuthorityPermitStore(targetDatabase, targetActor);
    return {
        get tenantStore() {
            return tenantStore;
        },
        get targetStore() {
            return targetStore;
        },
        restartTenant() {
            tenantStore = new SqliteAuthorityPermitStore(tenantDatabase, issuerActor);
            return tenantStore;
        },
        restartTarget() {
            targetStore = new SqliteAuthorityPermitStore(targetDatabase, targetActor);
            return targetStore;
        }
    };
});

test("memory permit transactions do not expose mutable scope state", { tags: "p0" }, () => {
    const store = new MemoryAuthorityPermitStore(targetActor);
    store.transaction((transaction) => {
        expect(Reflect.ownKeys(transaction)).toEqual([]);
    });
});

describe("AuthorityPermit", () => {
    test(
        "rejects a lease holder with the same PrincipalId from another Tenant",
        { tags: "p0" },
        () => {
            expect(() =>
                expectation({
                    lease: {
                        ...lease,
                        holder: new PrincipalRef(new TenantId("permit-other-tenant"), principalId)
                    }
                })
            ).toThrow(/lease holder/);
        }
    );

    test(
        "[authority.permit] codec preserves every normative field and immutable dates",
        { tags: "p0" },
        () => {
            const permit = new AuthorityPermit({
                ...expectation(),
                nonce: "codec-nonce",
                requestDigest: requestDigestFor(expectation(), "codec-nonce"),
                issuedAt,
                expiresAt
            });
            const decoded = AuthorityPermit.decode(AuthorityPermit.encode(permit));

            expect(decoded.expectation.equals(permit.expectation)).toBe(true);
            expect(decoded.nonce).toBe("codec-nonce");
            expect(decoded.issuedAt).toEqual(issuedAt);
            expect(decoded.expiresAt).toEqual(expiresAt);
            decoded.expiresAt.setTime(0);
            expect(decoded.expiresAt).toEqual(expiresAt);
            expect({
                argumentsDigest: decoded.argumentsDigest,
                attemptOrdinal: decoded.attemptOrdinal,
                authority: decoded.authority,
                binding: decoded.binding,
                claim: decoded.claim,
                claimOwner: decoded.claimOwner,
                facet: decoded.facet,
                impact: decoded.impact,
                intentDigest: decoded.intentDigest,
                invocation: decoded.invocation,
                itemIndex: decoded.itemIndex,
                itemKey: decoded.itemKey,
                issuer: decoded.issuer,
                lease: decoded.lease,
                operation: decoded.operation,
                package: decoded.package,
                pathEpochs: decoded.pathEpochs,
                principal: decoded.principal,
                reservation: decoded.reservation,
                source: decoded.source,
                target: decoded.target,
                tenant: decoded.tenant
            }).toMatchObject({
                attemptOrdinal: 1,
                impact: "externalSend",
                itemIndex: 2,
                itemKey,
                tenant
            });
            expect(Object.isFrozen(decoded)).toBe(true);
            expect(Object.isFrozen(decoded.target)).toBe(true);
            expect(Object.isFrozen(decoded.reservation.obligation)).toBe(true);

            const envelope = decodeCanonicalJson(AuthorityPermit.encode(permit));
            if (!isJsonObject(envelope) || !isJsonObject(envelope["payload"])) {
                throw new TypeError("Permit envelope must carry an object payload");
            }
            const payload = envelope["payload"];
            expect(Object.keys(payload).sort()).toEqual([
                "argumentsDigest",
                "attemptOrdinal",
                "authority",
                "binding",
                "claim",
                "claimOwner",
                "expiresAt",
                "facet",
                "impact",
                "intentDigest",
                "invocation",
                "issuedAt",
                "issuer",
                "itemIndex",
                "itemKey",
                "lease",
                "nonce",
                "operation",
                "package",
                "pathEpochs",
                "principal",
                "requestDigest",
                "reservation",
                "source",
                "target",
                "tenant"
            ]);
            const ambient = encodeCanonicalJson({
                ...envelope,
                payload: { ...payload, ambientAuthority: true }
            });
            expect(() => AuthorityPermit.decode(ambient)).toThrow(/missing or unknown fields/);
        }
    );

    test(
        "round-trips delegated system authority and an absent optional lease",
        { tags: "p0" },
        () => {
            const data = {
                ...expectation().toData(),
                authority: {
                    binding: "mail",
                    kind: "delegated",
                    principal: { principal: principalId.value, tenant: tenant.value }
                },
                claimOwner: {
                    actor: { id: targetActor.id.value, kind: targetActor.kind },
                    kind: "system",
                    worker: "system-worker"
                },
                lease: null
            };
            const expected = AuthorityPermitExpectation.fromData(data);
            const permit = AuthorityPermit.decode(
                AuthorityPermit.encode(
                    new AuthorityPermit({
                        ...expected,
                        nonce: "system-no-lease",
                        requestDigest: requestDigestFor(expected, "system-no-lease"),
                        issuedAt,
                        expiresAt
                    })
                )
            );

            expect(permit.lease).toBeUndefined();
            expect(permit.claimOwner.kind).toBe("system");
            expect(permit.authority.kind).toBe("delegated");
        }
    );

    test("rejects malformed permit identities and times before issuance", { tags: "p0" }, () => {
        expect(() =>
            expectation({ issuer: new ActorRef("workspace", new ActorId("not-a-tenant")) })
        ).toThrow(/Tenant Actor/);
        expect(() => expectation({ tenant: new TenantId("other-tenant") })).toThrow(
            /qualify its principal/
        );
        expect(() =>
            expectation({
                authority: {
                    kind: "initiator",
                    principal,
                    binding: new BindingName("other-binding")
                }
            })
        ).toThrow(/source must match/);
        expect(() =>
            expectation({
                reservation: {
                    run: new RunId("permit-run"),
                    registryEpoch: 5,
                    obligation: {
                        kind: "invocationItem",
                        invocation,
                        itemIndex: 2,
                        itemKey: "wrong-item"
                    }
                }
            })
        ).toThrow(/reservation must match/);
        expect(() =>
            expectation({
                lease: Object.freeze({
                    turn: lease.turn,
                    holder: new PrincipalRef(tenant, new PrincipalId("wrong-holder")),
                    epoch: lease.epoch
                })
            })
        ).toThrow(/lease holder/);
        expect(() => expectation({ target: { ...expectation().target, fence: -1 } })).toThrow(
            /non-negative/
        );
        expect(() => expectation(violating(expectation(), { impact: "invalid" }))).toThrow(
            /impact is invalid/
        );
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: " ",
                    requestDigest: requestDigestFor(expectation(), "invalid-nonce"),
                    issuedAt,
                    expiresAt
                })
        ).toThrow(/nonblank/);
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: "bad-expiry",
                    requestDigest: requestDigestFor(expectation(), "bad-expiry"),
                    issuedAt,
                    expiresAt: issuedAt
                })
        ).toThrow(/after issuance/);
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: "bad-time",
                    requestDigest: requestDigestFor(expectation(), "bad-time"),
                    issuedAt: new Date(Number.NaN),
                    expiresAt
                })
        ).toThrow(/valid non-negative Date/);
    });

    test("rejects reservation obligations that are not invocation items", { tags: "p0" }, () => {
        expect(() =>
            expectation({
                reservation: {
                    run: new RunId("permit-run"),
                    registryEpoch: 5,
                    obligation: violating(
                        { kind: "invocationItem", invocation, itemIndex: 2, itemKey } as const,
                        { kind: "route" }
                    )
                }
            })
        ).toThrow(TypeError);
    });

    test("rejects malformed codec variants fail closed", { tags: "p0" }, () => {
        const permit = new AuthorityPermit({
            ...expectation(),
            nonce: "malformed-codec",
            requestDigest: requestDigestFor(expectation(), "malformed-codec"),
            issuedAt,
            expiresAt
        });
        const variants: readonly [readonly string[], string, JsonValue][] = [
            [["payload", "claimOwner"], "kind", "attacker"],
            [["payload", "authority"], "kind", "attacker"],
            [["payload", "reservation", "obligation"], "kind", "route"],
            [["payload", "issuer"], "kind", "attacker"],
            [["payload"], "impact", "attacker"]
        ];
        for (const [parentPath, field, value] of variants) {
            const encoded = decodeCanonicalJson(AuthorityPermit.encode(permit));
            const envelope = corrupt(encoded, parentPath, field, value);
            expect(() => AuthorityPermit.decode(encodeCanonicalJson(envelope))).toThrow(
                /Invalid authority.permit record/
            );
        }
    });

    test(
        "fails closed for substituted bindings and expiry without consuming",
        { tags: "p0" },
        async () => {
            const tenantStore = new MemoryAuthorityPermitStore(issuerActor);
            const targetStore = new MemoryAuthorityPermitStore(targetActor);
            const authority = new CurrentAuthority<unknown>();
            const expected = expectation();
            const issuer = new AuthorityPermitIssuer(tenantStore, authority);
            const permit = tenantStore.transaction((transaction) =>
                issuer.issue(transaction, targetRequestFor(expected, "adversarial"), issuedAt)
            );
            const authentication = await authenticate(tenantStore, permit, expected);
            const admission = new StoredAuthorityPermitAdmissionPort(targetStore);

            for (const [name, substituted] of substitutions(expected)) {
                expect(
                    () =>
                        targetStore.transaction((transaction) =>
                            admission.consume(
                                transaction,
                                authentication,
                                permit,
                                substituted,
                                new Date(issuedAt.getTime() + 1)
                            )
                        ),
                    name
                ).toThrow(/does not match/);
                expect(
                    targetStore.transaction((transaction) =>
                        targetStore.consumed(transaction, permit.nonce)
                    )
                ).toBeUndefined();
            }

            expect(() =>
                targetStore.transaction((transaction) =>
                    admission.consume(transaction, authentication, permit, expected, expiresAt)
                )
            ).toThrow(/not valid/);
            expect(() =>
                targetStore.transaction((transaction) =>
                    admission.consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() - 1)
                    )
                )
            ).toThrow(/not valid/);
            expect(
                targetStore.transaction((transaction) =>
                    targetStore.consumed(transaction, permit.nonce)
                )
            ).toBeUndefined();
        }
    );

    test(
        "post-issuance Grant or epoch revocation cannot cancel the admitted permit",
        { tags: "p0" },
        async () => {
            const tenantStore = new MemoryAuthorityPermitStore(issuerActor);
            const targetStore = new MemoryAuthorityPermitStore(targetActor);
            const authority = new CurrentAuthority<unknown>();
            const issuer = new AuthorityPermitIssuer(tenantStore, authority);
            const expected = expectation();
            const admitted = tenantStore.transaction((transaction) =>
                issuer.issue(transaction, targetRequestFor(expected, "before-revocation"), issuedAt)
            );
            const authentication = await authenticate(tenantStore, admitted, expected);

            authority.live = false;
            authority.generation += 1;
            authority.path = new PathEpochEvidence([
                new ScopeEpoch(ScopeRef.tenant(tenant), 5),
                new ScopeEpoch(workspaceScope, 10)
            ]);
            expect(() =>
                tenantStore.transaction((transaction) =>
                    issuer.issue(
                        transaction,
                        targetRequestFor(expected, "after-revocation"),
                        issuedAt
                    )
                )
            ).toThrow(/does not admit/);

            recordTargetRequest(targetStore, expected, admitted.nonce);
            targetStore.transaction((transaction) =>
                new StoredAuthorityPermitAdmissionPort(targetStore).consume(
                    transaction,
                    authentication,
                    admitted,
                    expected,
                    new Date(issuedAt.getTime() + 1)
                )
            );
            expect(
                targetStore.transaction(
                    (transaction) => targetStore.consumed(transaction, admitted.nonce)?.value
                )
            ).toBe(admitted.digest().value);
        }
    );

    test(
        "rejects malformed memory recovery and wrong Actor ownership",
        { tags: "p0" },
        async () => {
            const issuerStore = new MemoryAuthorityPermitStore(issuerActor);
            const expected = expectation();
            const permit = issuerStore.transaction((transaction) =>
                new AuthorityPermitIssuer(issuerStore, new CurrentAuthority()).issue(
                    transaction,
                    targetRequestFor(expected, "memory-corruption"),
                    issuedAt
                )
            );
            const snapshot = issuerStore.snapshot();
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, violating(snapshot, { version: 2 }))
            ).toThrow(/malformed/);
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 3,
                        denied: [],
                        requested: [],
                        issued: [snapshot.issued[0]!, snapshot.issued[0]!],
                        consumed: []
                    })
            ).toThrow(/malformed/);
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 3,
                        denied: [],
                        requested: [],
                        issued: [{ nonce: "wrong-nonce", bytes: snapshot.issued[0]!.bytes }],
                        consumed: []
                    })
            ).toThrow(/malformed/);
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 3,
                        denied: [],
                        requested: [],
                        issued: [],
                        consumed: [{ nonce: "consumed", bytes: Uint8Array.of(0) }]
                    })
            ).toThrow();
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 3,
                        denied: [],
                        requested: [],
                        issued: snapshot.issued,
                        consumed: [{ nonce: permit.nonce, bytes: AuthorityPermit.encode(permit) }]
                    })
            ).toThrow(/malformed/);
            expect(() => new MemoryAuthorityPermitStore(targetActor, snapshot)).toThrow(
                /another Actor owner/
            );
            // Same bytes, same wrong owner, but the record's key is not a string. The shape
            // screen has to refuse it as a malformed snapshot before anything decodes the
            // record: without it the store decodes first and reports an issuer mismatch —
            // an authority.denied about a record that was never well formed, which sends an
            // operator looking for the wrong fault. Only the issued loop re-derives a nonce
            // it can disagree with; the consumed loop has no second reading of its key.
            let malformedKey: unknown;
            try {
                new MemoryAuthorityPermitStore(targetActor, {
                    version: 3,
                    denied: [],
                    requested: [],
                    issued: [violating(snapshot.issued[0]!, { nonce: 5 })],
                    consumed: []
                });
            } catch (error) {
                malformedKey = error;
            }
            expect(malformedKey).toMatchObject({
                code: "codec.invalid",
                message: "Stored authority permit ownership is malformed"
            });

            const wrongTarget = new MemoryAuthorityPermitStore(
                new ActorRef("run", new ActorId("wrong-target"))
            );
            const authentication = await authenticate(issuerStore, permit, expected);
            expect(() =>
                wrongTarget.transaction((transaction) =>
                    wrongTarget.consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() + 1)
                    )
                )
            ).toThrow(/another Actor owner/);
        }
    );

    test(
        "fails closed with the codec error on malformed stored ownership records",
        { tags: "p1" },
        () => {
            const digestValue = Digest.sha256(Uint8Array.of(1)).value;
            const malformedStores = [
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 3,
                        denied: [],
                        requested: [],
                        // @ts-expect-error Issued ownership records cannot be null.
                        issued: [null],
                        consumed: []
                    }),
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 3,
                        denied: [],
                        requested: [],
                        issued: [],
                        // @ts-expect-error Consumed ownership records cannot be null.
                        consumed: [null]
                    }),
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 3,
                        denied: [],
                        requested: [],
                        issued: [],
                        consumed: [
                            {
                                // @ts-expect-error Permit nonces are canonical strings.
                                nonce: 5,
                                digest: digestValue
                            }
                        ]
                    }),
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 3,
                        denied: [],
                        requested: [],
                        issued: [],
                        consumed: [
                            {
                                nonce: "corrupt-nonce",
                                // @ts-expect-error Permit digests are canonical strings.
                                digest: 5
                            }
                        ]
                    })
            ];
            for (const create of malformedStores) {
                let thrown: unknown;
                try {
                    create();
                } catch (error) {
                    thrown = error;
                }
                expect(thrown).toBeInstanceOf(AgentCoreError);
                expect(thrown).toMatchObject({ code: "codec.invalid" });
            }
        }
    );

    test(
        "SQLite recovery rejects a substituted owner and malformed permit bytes",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const store = new SqliteAuthorityPermitStore(database, issuerActor);
            const expected = expectation();
            const permit = store.transaction((transaction) =>
                new AuthorityPermitIssuer(store, new CurrentAuthority()).issue(
                    transaction,
                    targetRequestFor(expected, "sqlite-corruption"),
                    issuedAt
                )
            );
            expect(
                () =>
                    new SqliteAuthorityPermitStore(
                        database,
                        new ActorRef("tenant", new ActorId("wrong-owner"))
                    )
            ).toThrow(/malformed/);
            database.run("UPDATE authority_permit_nonces SET record = ? WHERE nonce = ?", [
                Uint8Array.of(0),
                permit.nonce
            ]);
            expect(() => new SqliteAuthorityPermitStore(database, issuerActor)).toThrow();
        }
    );

    test(
        "SQLite permit storage fails closed on read, write, and projection faults",
        { tags: "p0" },
        async () => {
            const expected = expectation();
            const authenticationStore = new MemoryAuthorityPermitStore(issuerActor);
            const permit = authenticationStore.transaction((transaction) =>
                new AuthorityPermitIssuer(authenticationStore, new CurrentAuthority()).issue(
                    transaction,
                    targetRequestFor(expected, "sqlite-fault"),
                    issuedAt
                )
            );
            const authentication = await authenticate(authenticationStore, permit, expected);

            const schemaFailure = new ControlledSqlite();
            schemaFailure.failRun = new TypeError("schema failure");
            expect(() => new SqliteAuthorityPermitStore(schemaFailure, issuerActor)).toThrow(
                /schema initialization failed/
            );

            const issueFailure = new ControlledSqlite();
            const issueStore = new SqliteAuthorityPermitStore(issueFailure, issuerActor);
            const foreignIssuer = new AuthorityPermit({
                ...expectation({
                    issuer: new ActorRef("tenant", new ActorId("foreign-issuer"))
                }),
                nonce: "foreign-issuer",
                requestDigest: requestDigestFor(
                    expectation({
                        issuer: new ActorRef("tenant", new ActorId("foreign-issuer"))
                    }),
                    "foreign-issuer"
                ),
                issuedAt,
                expiresAt
            });
            expect(() =>
                issueStore.transaction((transaction) =>
                    issueStore.issue(transaction, foreignIssuer)
                )
            ).toThrow(/another Actor owner/);
            issueFailure.failRun = new TypeError("insert failure");
            expect(() =>
                issueStore.transaction((transaction) => issueStore.issue(transaction, permit))
            ).toThrow(/issued atomically/);
            issueFailure.failRun = new AgentCoreError("authority.denied", "closed write");
            expect(() =>
                issueStore.transaction((transaction) => issueStore.issue(transaction, permit))
            ).toThrow(/closed write/);

            const droppedIssue = new ControlledSqlite();
            const droppedIssueStore = new SqliteAuthorityPermitStore(droppedIssue, issuerActor);
            droppedIssue.dropRun = true;
            expect(() =>
                droppedIssueStore.transaction((transaction) =>
                    droppedIssueStore.issue(transaction, permit)
                )
            ).toThrow(/already used/);

            const consumeFailure = new ControlledSqlite();
            const consumeStore = new SqliteAuthorityPermitStore(consumeFailure, targetActor);
            recordTargetRequest(consumeStore, expected, permit.nonce);
            const wrongTargetStore = new SqliteAuthorityPermitStore(
                new ControlledSqlite(),
                new ActorRef("run", new ActorId("wrong-target"))
            );
            expect(() =>
                wrongTargetStore.transaction((transaction) =>
                    wrongTargetStore.consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() + 1)
                    )
                )
            ).toThrow(/another Actor owner/);
            consumeFailure.failRun = new TypeError("insert failure");
            expect(() =>
                consumeStore.transaction((transaction) =>
                    consumeStore.consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() + 1)
                    )
                )
            ).toThrow(/consumed exactly once/);
            consumeFailure.failRun = new AgentCoreError("authority.denied", "closed consumption");
            expect(() =>
                consumeStore.transaction((transaction) =>
                    consumeStore.consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() + 1)
                    )
                )
            ).toThrow(/closed consumption/);

            const droppedConsume = new ControlledSqlite();
            const droppedConsumeStore = new SqliteAuthorityPermitStore(droppedConsume, targetActor);
            recordTargetRequest(droppedConsumeStore, expected, permit.nonce);
            droppedConsume.dropRun = true;
            expect(() =>
                droppedConsumeStore.transaction((transaction) =>
                    droppedConsumeStore.consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() + 1)
                    )
                )
            ).toThrow(/did not persist exactly/);

            const readFailure = new ControlledSqlite();
            const readStore = new SqliteAuthorityPermitStore(readFailure, issuerActor);
            readFailure.failAll = new TypeError("read failure");
            expect(() =>
                readStore.transaction((transaction) => readStore.issued(transaction, permit.nonce))
            ).toThrow(/read failed/);
            readFailure.failAll = new AgentCoreError("codec.invalid", "closed read");
            expect(() =>
                readStore.transaction((transaction) => readStore.issued(transaction, permit.nonce))
            ).toThrow(/closed read/);

            const recoveryFailure = new ControlledSqlite();
            new SqliteAuthorityPermitStore(recoveryFailure, issuerActor);
            recoveryFailure.failAll = new TypeError("recovery failure");
            expect(() => new SqliteAuthorityPermitStore(recoveryFailure, issuerActor)).toThrow(
                /recovery read failed/
            );
            recoveryFailure.failAll = new AgentCoreError("codec.invalid", "closed recovery");
            expect(() => new SqliteAuthorityPermitStore(recoveryFailure, issuerActor)).toThrow(
                /closed recovery/
            );

            const corruptProjection = new ControlledSqlite();
            const corruptStore = new SqliteAuthorityPermitStore(corruptProjection, issuerActor);
            corruptStore.transaction((transaction) => corruptStore.issue(transaction, permit));
            corruptProjection.mapRows = (rows) =>
                rows.map((row) => ({ ...row, digest: "0".repeat(64) }));
            expect(() =>
                corruptStore.transaction((transaction) =>
                    corruptStore.issued(transaction, permit.nonce)
                )
            ).toThrow(/malformed/);

            corruptProjection.mapRows = (rows) => rows.map((row) => ({ ...row, state: "invalid" }));
            expect(() => new SqliteAuthorityPermitStore(corruptProjection, issuerActor)).toThrow(
                /malformed/
            );
            corruptProjection.mapRows = (rows) => rows.map((row) => ({ ...row, record: null }));
            expect(() =>
                corruptStore.transaction((transaction) =>
                    corruptStore.issued(transaction, permit.nonce)
                )
            ).toThrow(/malformed/);
            corruptProjection.mapRows = (rows) => rows.map((row) => ({ ...row, owner_id: "" }));
            expect(() =>
                corruptStore.transaction((transaction) =>
                    corruptStore.issued(transaction, permit.nonce)
                )
            ).toThrow(/malformed/);

            const consumedProjection = new ControlledSqlite();
            const consumedStore = new SqliteAuthorityPermitStore(consumedProjection, targetActor);
            recordTargetRequest(consumedStore, expected, permit.nonce);
            consumedStore.transaction((transaction) =>
                consumedStore.consume(
                    transaction,
                    authentication,
                    permit,
                    expected,
                    new Date(issuedAt.getTime() + 1)
                )
            );
            consumedProjection.mapRows = (rows) =>
                rows.map((row) => ({ ...row, record: Uint8Array.of(1) }));
            expect(() =>
                consumedStore.transaction((transaction) =>
                    consumedStore.consumed(transaction, permit.nonce)
                )
            ).toThrow(/malformed/);
        }
    );
});

class StoreIssuedRecordSource<Transaction> extends AuthorityPermitIssuedRecordSource {
    public constructor(private readonly store: AuthorityPermitIssueStore<Transaction>) {
        super();
    }

    public async issued(
        issuer: ActorRef,
        nonce: string,
        digest: Digest
    ): Promise<Uint8Array | undefined> {
        const permit = this.store.transaction((transaction) =>
            this.store.issued(transaction, nonce)
        );
        return permit?.issuer.equals(issuer) === true && permit.digest().equals(digest)
            ? AuthorityPermit.encode(permit)
            : undefined;
    }
}

function authenticate<Transaction>(
    store: AuthorityPermitIssueStore<Transaction>,
    permit: AuthorityPermit,
    expected: AuthorityPermitExpectation
) {
    return new AuthorityPermitAuthenticator(new StoreIssuedRecordSource(store)).authenticate(
        permit,
        expected
    );
}

class ControlledSqlite extends TransactionalSqlite {
    readonly #database = new TestSqlite();
    public failAll: unknown;
    public failRun: unknown;
    public dropRun = false;
    public mapRows: (rows: readonly SqliteRow[]) => readonly SqliteRow[] = (rows) => rows;

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (this.failAll !== undefined) throw this.failAll;
        return this.mapRows(this.#database.all(statement, bindings));
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        if (this.failRun !== undefined) throw this.failRun;
        if (!this.dropRun) this.#database.run(statement, bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#database.transaction(operation, ...guard);
    }
}

function expectation(
    overrides: Partial<AuthorityPermitExpectationInit> = {}
): AuthorityPermitExpectation {
    const binding = overrides.binding ?? {
        name: new BindingName("mail"),
        generation: Revision.initial()
    };
    const selectedPrincipal = overrides.principal ?? principal;
    const selectedInvocation = overrides.invocation ?? invocation;
    const selectedItemIndex = overrides.itemIndex ?? 2;
    const selectedItemKey = overrides.itemKey ?? itemKey;
    return new AuthorityPermitExpectation({
        tenant: overrides.tenant ?? tenant,
        issuer: overrides.issuer ?? issuerActor,
        source: overrides.source ?? sourceActor,
        target: overrides.target ?? {
            actor: targetActor,
            fence: 11,
            domain: new ProtectionDomain("backend", "permit-domain", "may-hold-secrets")
        },
        principal: selectedPrincipal,
        binding,
        facet: overrides.facet ?? new FacetRef("workspace:mail"),
        operation: overrides.operation ?? new OperationRef("workspace:send"),
        package:
            overrides.package ??
            new PackagePin(
                new PackageId("mail-package"),
                new SemVer("1.2.3"),
                digest("manifest"),
                digest("code")
            ),
        impact: overrides.impact ?? "externalSend",
        invocation: selectedInvocation,
        reservation: overrides.reservation ?? {
            run: new RunId("permit-run"),
            registryEpoch: 5,
            obligation: {
                kind: "invocationItem",
                invocation: selectedInvocation,
                itemIndex: selectedItemIndex,
                itemKey: selectedItemKey
            }
        },
        itemIndex: selectedItemIndex,
        attemptOrdinal: overrides.attemptOrdinal ?? 1,
        claim: overrides.claim ?? new ItemClaimId("permit-claim"),
        claimOwner: overrides.claimOwner ?? {
            kind: "executor",
            token: lease,
            worker: new ClaimWorkerId("permit-worker")
        },
        itemKey: selectedItemKey,
        argumentsDigest: overrides.argumentsDigest ?? authorityArgumentsDigest(internalArguments),
        intentDigest: overrides.intentDigest ?? digest("intent"),
        pathEpochs: overrides.pathEpochs ?? path,
        authority: overrides.authority ?? {
            kind: "initiator",
            principal: selectedPrincipal,
            binding: binding.name
        },
        lease: overrides.lease === undefined ? lease : overrides.lease
    });
}

function targetRequest(
    nonce: string,
    overrides: Partial<AuthorityPermitExpectationInit> = {}
): TargetAuthorityPermitRequest {
    return targetRequestFor(expectation(overrides), nonce);
}

const internalArguments = Object.freeze({ channel: "internal" as const });
const externalArguments = Object.freeze({ channel: "external" as const });

function targetRequestFor(
    expected: AuthorityPermitExpectation,
    nonce: string,
    expiry: Date = expiresAt,
    grantId: GrantId = new GrantId("permit-target-request-grant")
): TargetAuthorityPermitRequest {
    const argumentsValue = expected.argumentsDigest.equals(
        authorityArgumentsDigest(internalArguments)
    )
        ? internalArguments
        : externalArguments;
    const binding = new Binding(
        expected.pathEpochs.target.scope,
        SubjectRef.principal(expected.principal),
        expected.target.domain,
        expected.binding.name,
        grantId,
        expected.facet,
        expected.binding.generation.value,
        "active",
        new Revision(expected.binding.generation.value)
    );
    const authority = new AuthorityCheckRequest({
        ownerTenant: expected.tenant,
        owner: expected.target.actor,
        ownerFence: expected.target.fence,
        principal: expected.principal,
        binding,
        intent: {
            facet: expected.facet,
            operation: expected.operation.operation.value,
            impact: expected.impact,
            arguments: argumentsValue,
            argumentsDigest: authorityArgumentsDigest(argumentsValue)
        },
        expectedPath: expected.pathEpochs,
        invocationDigest: expected.intentDigest,
        itemIndex: expected.itemIndex,
        attemptOrdinal: expected.attemptOrdinal,
        nonce
    });
    return new TargetAuthorityPermitRequest(expected, authority, nonce, expiry);
}

function recordTargetRequest<Transaction>(
    store: AuthorityPermitTargetStore<Transaction>,
    expected: AuthorityPermitExpectation,
    nonce: string
): void {
    const requester = new AuthorityPermitRequester(store);
    store.transaction((transaction) =>
        requester.request(transaction, targetRequestFor(expected, nonce))
    );
}

function authorityArgumentsDigest(
    argumentsValue: typeof internalArguments | typeof externalArguments
): Digest {
    return Digest.sha256(encodeCanonicalJson(argumentsValue));
}

function substitutions(
    base: AuthorityPermitExpectation
): readonly (readonly [string, AuthorityPermitExpectation])[] {
    const alternatePrincipal = new PrincipalRef(tenant, new PrincipalId("permit-other-principal"));
    const alternateBinding = { name: new BindingName("calendar"), generation: new Revision(4) };
    const alternateInvocation = new InvocationId("permit-other-invocation");
    const alternateItemKey = "permit-other-item";
    return [
        ["issuer", expectation({ issuer: new ActorRef("tenant", new ActorId("other-issuer")) })],
        ["source", expectation({ source: new ActorRef("workspace", new ActorId("other-source")) })],
        [
            "target actor/fence/domain",
            expectation({
                target: {
                    actor: new ActorRef("run", new ActorId("other-target")),
                    fence: 12,
                    domain: new ProtectionDomain("backend", "other-domain", "no-secrets")
                }
            })
        ],
        [
            "principal",
            expectation({
                principal: alternatePrincipal,
                authority: {
                    kind: "initiator",
                    principal: alternatePrincipal,
                    binding: base.binding.name
                },
                lease: Object.freeze({ ...lease, holder: alternatePrincipal })
            })
        ],
        [
            "Binding generation and name",
            expectation({
                binding: alternateBinding,
                authority: { kind: "initiator", principal, binding: alternateBinding.name }
            })
        ],
        ["Facet", expectation({ facet: new FacetRef("workspace:calendar") })],
        ["operation", expectation({ operation: new OperationRef("workspace:draft") })],
        [
            "package pin",
            expectation({
                package: new PackagePin(
                    new PackageId("mail-package"),
                    new SemVer("1.2.4"),
                    digest("manifest-next"),
                    digest("code-next")
                )
            })
        ],
        ["impact", expectation({ impact: "mutate" })],
        ["invocation and reservation identity", expectation({ invocation: alternateInvocation })],
        [
            "reservation Run and epoch",
            expectation({
                reservation: {
                    run: new RunId("permit-other-run"),
                    registryEpoch: 6,
                    obligation: base.reservation.obligation
                }
            })
        ],
        ["item and item key", expectation({ itemIndex: 3, itemKey: alternateItemKey })],
        ["attempt ordinal", expectation({ attemptOrdinal: 2 })],
        ["claim", expectation({ claim: new ItemClaimId("permit-other-claim") })],
        [
            "claim owner",
            expectation({
                claimOwner: {
                    kind: "system",
                    actor: targetActor,
                    worker: new ClaimWorkerId("permit-system-worker")
                }
            })
        ],
        [
            "arguments digest",
            expectation({ argumentsDigest: authorityArgumentsDigest(externalArguments) })
        ],
        ["intent digest", expectation({ intentDigest: digest("other-intent") })],
        [
            "complete path epochs",
            expectation({
                pathEpochs: new PathEpochEvidence([
                    new ScopeEpoch(ScopeRef.tenant(tenant), 4),
                    new ScopeEpoch(workspaceScope, 10)
                ])
            })
        ],
        [
            "authority source",
            expectation({
                authority: { kind: "delegated", principal, binding: base.binding.name }
            })
        ],
        [
            "exact lease",
            expectation({
                lease: Object.freeze({
                    turn: lease.turn,
                    holder: lease.holder,
                    epoch: lease.epoch + 1
                })
            })
        ]
    ];
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

function requestDigestFor(
    expected: AuthorityPermitExpectation,
    nonce: string,
    expiry: Date = expiresAt
): Digest {
    return targetRequestFor(expected, nonce, expiry).digest();
}

describe("AuthorityPermit mutation gates", () => {
    test("exposes every expectation field through the permit getters", { tags: "p0" }, () => {
        const expected = expectation();
        const permit = new AuthorityPermit({
            ...expected,
            nonce: "getter-nonce",
            requestDigest: requestDigestFor(expected, "getter-nonce"),
            issuedAt,
            expiresAt
        });

        expect(permit.tenant.equals(tenant)).toBe(true);
        expect(permit.issuer.equals(issuerActor)).toBe(true);
        expect(permit.source.equals(sourceActor)).toBe(true);
        expect(permit.principal.equals(principal)).toBe(true);
        expect(permit.binding.name.value).toBe("mail");
        expect(permit.binding.generation.value).toBe(0);
        expect(permit.facet.value).toBe("workspace:mail");
        expect(permit.operation.value).toBe("workspace:send");
        expect(permit.package.toData()).toEqual(expected.package.toData());
        expect(permit.invocation.equals(invocation)).toBe(true);
        expect(permit.claim.value).toBe("permit-claim");
        expect(permit.argumentsDigest.equals(expected.argumentsDigest)).toBe(true);
        expect(permit.intentDigest.equals(expected.intentDigest)).toBe(true);
        expect(permit.pathEpochs.equals(path)).toBe(true);
        expect(permit.lease?.turn.equals(lease.turn)).toBe(true);
        expect(permit.lease?.holder.equals(principal)).toBe(true);
        expect(permit.lease?.epoch).toBe(7);
    });

    test(
        "is consumable at the exact issuance instant with exact time denials",
        { tags: "p0" },
        () => {
            const expected = expectation();
            const permit = new AuthorityPermit({
                ...expected,
                nonce: "boundary-nonce",
                requestDigest: requestDigestFor(expected, "boundary-nonce"),
                issuedAt,
                expiresAt
            });

            expect(() => permit.assertConsumable(expected, issuedAt)).not.toThrow();
            expect(() =>
                permit.assertConsumable(expected, new Date(expiresAt.getTime() - 1))
            ).not.toThrow();
            const early = caughtAgentCoreError(() =>
                permit.assertConsumable(expected, new Date(issuedAt.getTime() - 1))
            );
            expect(early.code).toBe("authority.denied");
            expect(early.message).toBe(
                "Authority permit is not valid at the target admission time"
            );
            expect(() => permit.assertConsumable(expected, new Date(Number.NaN))).toThrow(
                new TypeError("Authority permit consumption time must be a valid non-negative Date")
            );
        }
    );

    test("validates issuance and expiry times with exact subjects", { tags: "p0" }, () => {
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: "invalid-issue",
                    requestDigest: requestDigestFor(expectation(), "invalid-issue"),
                    issuedAt: new Date(Number.NaN),
                    expiresAt
                })
        ).toThrow(
            new TypeError("Authority permit issuance time must be a valid non-negative Date")
        );
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: "invalid-expiry",
                    requestDigest: requestDigestFor(expectation(), "invalid-expiry"),
                    issuedAt,
                    expiresAt: new Date(Number.NaN)
                })
        ).toThrow(new TypeError("Authority permit expiry must be a valid non-negative Date"));
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: "negative-issue",
                    requestDigest: requestDigestFor(expectation(), "negative-issue"),
                    issuedAt: new Date(-1),
                    expiresAt
                })
        ).toThrow(
            new TypeError("Authority permit issuance time must be a valid non-negative Date")
        );

        const epochPermit = new AuthorityPermit({
            ...expectation(),
            nonce: "epoch-issue",
            requestDigest: requestDigestFor(expectation(), "epoch-issue", new Date(1)),
            issuedAt: new Date(0),
            expiresAt: new Date(1)
        });
        expect(epochPermit.issuedAt.getTime()).toBe(0);
    });

    test("rejects blank and non-canonical nonces exactly", { tags: "p0" }, () => {
        for (const nonce of ["", " padded"]) {
            expect(
                () =>
                    new AuthorityPermit({
                        ...expectation(),
                        nonce,
                        requestDigest: digest("invalid-request"),
                        issuedAt,
                        expiresAt
                    })
            ).toThrow(new TypeError("Authority permit nonce must be a nonblank canonical string"));
        }
    });

    test(
        "requires the Tenant to qualify the path even when the principal matches",
        { tags: "p0" },
        () => {
            expect(() =>
                expectation({
                    pathEpochs: new PathEpochEvidence([
                        new ScopeEpoch(ScopeRef.tenant(new TenantId("permit-foreign-tenant")), 1)
                    ])
                })
            ).toThrow(new TypeError("Authority permit Tenant must qualify its principal and path"));
        }
    );

    test("pins the reservation obligation to the exact invocation item", { tags: "p0" }, () => {
        expect(() =>
            expectation({
                reservation: {
                    run: new RunId("permit-run"),
                    registryEpoch: 5,
                    obligation: {
                        kind: "invocationItem",
                        invocation: new InvocationId("permit-drift-invocation"),
                        itemIndex: 2,
                        itemKey
                    }
                }
            })
        ).toThrow(
            new TypeError("Authority permit reservation must match its exact invocation item")
        );
        expect(() =>
            expectation({
                reservation: {
                    run: new RunId("permit-run"),
                    registryEpoch: 5,
                    obligation: { kind: "invocationItem", invocation, itemIndex: 3, itemKey }
                }
            })
        ).toThrow(
            new TypeError("Authority permit reservation must match its exact invocation item")
        );
    });

    test("decodes only canonical Actor and claim owner kinds", { tags: "p0" }, () => {
        const data = expectation().toData();
        const withSource = (kind: string) =>
            AuthorityPermitExpectation.fromData({
                ...data,
                source: { id: "permit-source-actor", kind }
            });

        expect(withSource("environment").source.kind).toBe("environment");
        expect(withSource("slate").source.kind).toBe("slate");
        expect(() => withSource("attacker")).toThrow(
            new TypeError("Authority permit Actor kind is invalid")
        );
        expect(() =>
            AuthorityPermitExpectation.fromData({
                ...data,
                claimOwner: {
                    actor: { id: "permit-target-actor", kind: "run" },
                    kind: "attacker",
                    worker: "permit-worker"
                }
            })
        ).toThrow(new TypeError("Authority permit claim owner kind is invalid"));

        // The expectation constructor refuses an impact outside POLICY_IMPACTS under this
        // same message, so asserting it alone would prove nothing about where the refusal
        // came from. Pairing it with a field the decoder reads immediately afterwards says
        // which one it reports: the impact is screened as the payload is read, not left
        // for the record to reject once the rest of it has been interpreted.
        expect(() =>
            AuthorityPermitExpectation.fromData({ ...data, impact: "sideways", invocation: 7 })
        ).toThrow(new TypeError("Authority permit impact is invalid"));
    });

    test("requires lease tokens to carry exact qualified identities", { tags: "p0" }, () => {
        expect(() =>
            expectation({
                lease: Object.freeze({
                    turn: new RunId("permit-forged-turn"),
                    holder: principal,
                    epoch: 7
                })
            })
        ).toThrow(new TypeError("Authority permit lease must carry an exact qualified holder"));
    });
});

describe("AuthorityPermit authentication mutation gates", () => {
    test("rejects authentications minted without the module issuer", { tags: "p0" }, () => {
        const permit = new AuthorityPermit({
            ...expectation(),
            nonce: "auth-forged",
            requestDigest: requestDigestFor(expectation(), "auth-forged"),
            issuedAt,
            expiresAt
        });
        const error = caughtAgentCoreError(
            () => new AuthenticatedAuthorityPermit(Symbol("forged-issuer"), permit)
        );
        expect(error.code).toBe("authority.denied");
        expect(error.message).toBe("Authority permit authentication has an invalid issuer");
    });

    test(
        "authenticates only the canonical issuer record with exact denials",
        { tags: "p0" },
        async () => {
            const expected = expectation();
            const permit = new AuthorityPermit({
                ...expected,
                nonce: "auth-nonce-a",
                requestDigest: requestDigestFor(expected, "auth-nonce-a"),
                issuedAt,
                expiresAt
            });
            const bytes = AuthorityPermit.encode(permit);
            const drifted = new AuthorityPermit({
                ...expected,
                nonce: "auth-nonce-b",
                requestDigest: requestDigestFor(expected, "auth-nonce-b"),
                issuedAt,
                expiresAt
            });

            const authenticated = await new AuthorityPermitAuthenticator(
                new FixedIssuedRecordSource(bytes)
            ).authenticate(permit, expected);
            expect(authenticated.matches(permit)).toBe(true);

            const denials: readonly (readonly [
                string,
                AuthorityPermitIssuedRecordSource,
                AuthorityPermitExpectation,
                string
            ])[] = [
                [
                    "target mismatch",
                    new FixedIssuedRecordSource(bytes),
                    expectation({ claim: new ItemClaimId("auth-other-claim") }),
                    "Authority permit does not match the target expectation"
                ],
                [
                    "missing record",
                    new FixedIssuedRecordSource(undefined),
                    expected,
                    "Authority permit has no authenticated issuer record"
                ],
                [
                    "malformed record",
                    new FixedIssuedRecordSource(Uint8Array.of(0)),
                    expected,
                    "Authority permit issuer record is malformed"
                ],
                [
                    "drifted record",
                    new FixedIssuedRecordSource(AuthorityPermit.encode(drifted)),
                    expected,
                    "Authority permit differs from its authenticated issuer record"
                ]
            ];
            for (const [name, source, target, message] of denials) {
                let caught: unknown;
                try {
                    await new AuthorityPermitAuthenticator(source).authenticate(permit, target);
                } catch (error) {
                    caught = error;
                }
                expect(caught, name).toBeInstanceOf(AgentCoreError);
                if (caught instanceof AgentCoreError) {
                    expect(caught.code, name).toBe("authority.denied");
                    expect(caught.message, name).toBe(message);
                }
            }
        }
    );

    test(
        "admission evidence binds to the exact authenticated permit bytes",
        { tags: "p0" },
        async () => {
            const expected = expectation();
            const store = new MemoryAuthorityPermitStore(issuerActor);
            const permit = store.transaction((transaction) =>
                new AuthorityPermitIssuer(store, new CurrentAuthority()).issue(
                    transaction,
                    targetRequestFor(expected, "auth-evidence-a"),
                    issuedAt
                )
            );
            const authentication = await authenticate(store, permit, expected);

            expect(() => requireAuthenticatedAuthorityPermit(authentication, permit)).not.toThrow();
            const other = new AuthorityPermit({
                ...expected,
                nonce: "auth-evidence-b",
                requestDigest: requestDigestFor(expected, "auth-evidence-b"),
                issuedAt,
                expiresAt
            });
            expect(authentication.matches(other)).toBe(false);
            const error = caughtAgentCoreError(() =>
                requireAuthenticatedAuthorityPermit(authentication, other)
            );
            expect(error.code).toBe("authority.denied");
            expect(error.message).toBe("Authority permit lacks authenticated issuer evidence");
        }
    );
});

describe("MemoryAuthorityPermitStore mutation gates", () => {
    test(
        "issue is idempotent for the exact expectation and denies conflicts",
        { tags: "p0" },
        () => {
            const store = new MemoryAuthorityPermitStore(issuerActor);
            const expected = expectation();
            const permit = new AuthorityPermit({
                ...expected,
                nonce: "store-issue-nonce",
                requestDigest: requestDigestFor(expected, "store-issue-nonce"),
                issuedAt,
                expiresAt
            });

            store.transaction((transaction) => {
                expect(store.issue(transaction, permit)).toBe(permit);
                const replay = new AuthorityPermit({
                    ...expected,
                    nonce: "store-issue-nonce",
                    requestDigest: requestDigestFor(expected, "store-issue-nonce"),
                    issuedAt: new Date(issuedAt.getTime() + 500),
                    expiresAt: new Date(expiresAt.getTime() + 500)
                });
                const settled = store.issue(transaction, replay);
                expect(AuthorityPermit.encode(settled)).toEqual(AuthorityPermit.encode(permit));

                const conflicting = new AuthorityPermit({
                    ...expectation({ claim: new ItemClaimId("store-other-claim") }),
                    nonce: "store-issue-nonce",
                    requestDigest: requestDigestFor(
                        expectation({ claim: new ItemClaimId("store-other-claim") }),
                        "store-issue-nonce"
                    ),
                    issuedAt,
                    expiresAt
                });
                const error = caughtAgentCoreError(() => store.issue(transaction, conflicting));
                expect(error.code).toBe("authority.denied");
                expect(error.message).toBe(
                    "Authority permit nonce is bound to another issuance expectation"
                );
                return undefined;
            });
        }
    );

    test(
        "a consumed nonce retains its exact request and cannot be consumed twice",
        { tags: "p0" },
        async () => {
            const reuseOwner = new ActorRef("run", new ActorId("permit-consumed-reuse-owner"));
            const expected = expectation({
                target: {
                    actor: reuseOwner,
                    fence: 11,
                    domain: new ProtectionDomain("backend", "permit-domain", "may-hold-secrets")
                }
            });
            const issuerStore = new MemoryAuthorityPermitStore(issuerActor);
            const permit = new AuthorityPermit({
                ...expected,
                nonce: "store-consumed-reuse",
                requestDigest: requestDigestFor(expected, "store-consumed-reuse"),
                issuedAt,
                expiresAt
            });
            issuerStore.transaction((transaction) => issuerStore.issue(transaction, permit));
            const authentication = await authenticate(issuerStore, permit, expected);

            const ownerStore = new MemoryAuthorityPermitStore(reuseOwner);
            recordTargetRequest(ownerStore, expected, permit.nonce);
            ownerStore.transaction((transaction) =>
                ownerStore.consume(
                    transaction,
                    authentication,
                    permit,
                    expected,
                    new Date(issuedAt.getTime() + 1)
                )
            );
            const replayedRequest = ownerStore.transaction((transaction) =>
                new AuthorityPermitRequester(ownerStore).request(
                    transaction,
                    targetRequestFor(expected, permit.nonce)
                )
            );
            expect(
                replayedRequest.digest().equals(targetRequestFor(expected, permit.nonce).digest())
            ).toBe(true);
            const replay = caughtAgentCoreError(() =>
                ownerStore.transaction((transaction) =>
                    ownerStore.consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() + 2)
                    )
                )
            );
            expect(replay.code).toBe("authority.denied");
        }
    );

    test("snapshots order issued and consumed records canonically", { tags: "p1" }, async () => {
        const store = new MemoryAuthorityPermitStore(issuerActor);
        const expected = expectation();
        const second = new AuthorityPermit({
            ...expected,
            nonce: "store-order-b",
            requestDigest: requestDigestFor(expected, "store-order-b"),
            issuedAt,
            expiresAt
        });
        const first = new AuthorityPermit({
            ...expected,
            nonce: "store-order-a",
            requestDigest: requestDigestFor(expected, "store-order-a"),
            issuedAt,
            expiresAt
        });
        store.transaction((transaction) => {
            store.issue(transaction, second);
            store.issue(transaction, first);
            return undefined;
        });
        expect(store.snapshot().issued.map((record) => record.nonce)).toEqual([
            "store-order-a",
            "store-order-b"
        ]);

        const authenticationB = await authenticate(store, second, expected);
        const authenticationA = await authenticate(store, first, expected);
        const targetStore = new MemoryAuthorityPermitStore(targetActor);
        recordTargetRequest(targetStore, expected, second.nonce);
        recordTargetRequest(targetStore, expected, first.nonce);
        targetStore.transaction((transaction) => {
            targetStore.consume(
                transaction,
                authenticationB,
                second,
                expected,
                new Date(issuedAt.getTime() + 1)
            );
            targetStore.consume(
                transaction,
                authenticationA,
                first,
                expected,
                new Date(issuedAt.getTime() + 1)
            );
            return undefined;
        });
        expect(targetStore.snapshot().consumed.map((record) => record.nonce)).toEqual([
            "store-order-a",
            "store-order-b"
        ]);
    });

    test("snapshot bytes stay detached from committed state", { tags: "p0" }, () => {
        const store = new MemoryAuthorityPermitStore(issuerActor);
        const permit = new AuthorityPermit({
            ...expectation(),
            nonce: "store-detached",
            requestDigest: requestDigestFor(expectation(), "store-detached"),
            issuedAt,
            expiresAt
        });
        store.transaction((transaction) => store.issue(transaction, permit));

        const snapshot = store.snapshot();
        for (const record of snapshot.issued) {
            record.bytes.fill(0);
        }
        expect(
            store.transaction(
                (transaction) => store.issued(transaction, "store-detached")?.digest().value
            )
        ).toBe(permit.digest().value);
    });

    test("detects issued records filed under a foreign nonce", { tags: "p0" }, () => {
        const permit = new AuthorityPermit({
            ...expectation(),
            nonce: "store-real-nonce",
            requestDigest: requestDigestFor(expectation(), "store-real-nonce"),
            issuedAt,
            expiresAt
        });
        const error = caughtAgentCoreError(
            () =>
                new MemoryAuthorityPermitStore(issuerActor, {
                    version: 3,
                    denied: [],
                    requested: [],
                    issued: [
                        {
                            nonce: "store-alias-nonce",
                            bytes: AuthorityPermit.encode(permit)
                        }
                    ],
                    consumed: []
                })
        );
        expect(error.code).toBe("codec.invalid");
        expect(error.message).toBe("Stored authority permit ownership is malformed");
    });

    test("restore rejects holed snapshot records as malformed", { tags: "p0" }, () => {
        // Length-only arrays model malformed persisted records without forging types.
        const issuedHole = caughtAgentCoreError(
            () =>
                new MemoryAuthorityPermitStore(issuerActor, {
                    version: 3,
                    denied: [],
                    requested: [],
                    issued: Array.from<{ nonce: string; bytes: Uint8Array }>({ length: 1 }),
                    consumed: []
                })
        );
        expect(issuedHole.code).toBe("codec.invalid");
        expect(issuedHole.message).toBe("Stored authority permit ownership is malformed");

        const consumedHole = caughtAgentCoreError(
            () =>
                new MemoryAuthorityPermitStore(issuerActor, {
                    version: 3,
                    denied: [],
                    requested: [],
                    issued: [],
                    consumed: Array.from<{ nonce: string; bytes: Uint8Array }>({ length: 1 })
                })
        );
        expect(consumedHole.code).toBe("codec.invalid");
        expect(consumedHole.message).toBe("Stored authority permit ownership is malformed");
    });
});

class FixedIssuedRecordSource extends AuthorityPermitIssuedRecordSource {
    public constructor(private readonly bytes: Uint8Array | undefined) {
        super();
    }

    public issued(): Promise<Uint8Array | undefined> {
        return Promise.resolve(this.bytes);
    }
}

function caughtAgentCoreError(run: () => void): AgentCoreError {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(AgentCoreError);
    if (!(caught instanceof AgentCoreError)) {
        throw new TypeError("Expected an AgentCoreError");
    }
    return caught;
}

// §3.4 rule 7 makes permit issuance the final authority-admission linearization point.
// `AuthorityPermitIssuer.issue` holds one clause per mutation class the rule names, so each
// class is measured with the other two exact: a single combined revocation cannot tell them
// apart and passes a mechanism that enforces only one of the three.
type LinearizedMutation = "none" | "revokedGrant" | "bindingGeneration" | "pathEpoch";

const LINEARIZED_MUTATIONS: readonly Exclude<LinearizedMutation, "none">[] = [
    "revokedGrant",
    "bindingGeneration",
    "pathEpoch"
];

const advancedPath = new PathEpochEvidence([
    new ScopeEpoch(ScopeRef.tenant(tenant), 5),
    new ScopeEpoch(workspaceScope, 9)
]);

function tenantDecision(
    request: TargetAuthorityPermitRequest,
    checkedAt: Date,
    mutated: LinearizedMutation
): AuthorityCheckEvidence {
    const revoked = mutated === "revokedGrant";
    return new AuthorityCheckEvidence(
        tenant,
        issuerActor,
        request.authority.digest(),
        request.authority.binding.key,
        mutated === "bindingGeneration"
            ? request.authority.binding.generation + 1
            : request.authority.binding.generation,
        revoked ? "deny" : "allow",
        revoked ? "revokedGrant" : "allowed",
        revoked ? [] : [new GrantId("permit-linearized-grant")],
        [],
        mutated === "pathEpoch" ? advancedPath : request.expectation.pathEpochs,
        checkedAt
    );
}

/** Refinement inputs rule 7 names and the Tenant's own decision record binds. */
const DECISION_BOUND_REFINEMENTS: readonly (readonly [
    string,
    Partial<AuthorityPermitExpectationInit>
])[] = [
    [
        "target fence",
        {
            target: {
                actor: targetActor,
                fence: 12,
                domain: new ProtectionDomain("backend", "permit-domain", "may-hold-secrets")
            }
        }
    ],
    ["attempt ordinal", { attemptOrdinal: 2 }],
    ["arguments digest", { argumentsDigest: Digest.sha256(encodeCanonicalJson(externalArguments)) }],
    ["whole intent", { intentDigest: digest("permit-other-whole-intent") }]
];

/**
 * Refinement inputs rule 7 names that `AuthorityCheckRequest` does not carry, so the
 * Tenant's decision record cannot witness them. The target's own durable request is what
 * binds them to the admission, and that half is measured separately below.
 */
const REQUEST_BOUND_REFINEMENTS: readonly (readonly [
    string,
    Partial<AuthorityPermitExpectationInit>
])[] = [
    ["target claim", { claim: new ItemClaimId("permit-refinement-claim") }],
    [
        "reservation epoch",
        {
            reservation: {
                run: new RunId("permit-run"),
                registryEpoch: 6,
                obligation: {
                    kind: "invocationItem",
                    invocation,
                    itemIndex: 2,
                    itemKey
                }
            }
        }
    ],
    ["item key", { itemKey: "permit-refinement-item-key" }]
];

describe("cross-Actor authority admission linearizes on permit issuance", () => {
    test(
        "[C13-AUTH-MEDIATED-ADMISSION] a revocation committed before issuance blocks the permit for each linearized mutation class independently",
        { tags: "p0" },
        () => {
            for (const mutated of LINEARIZED_MUTATIONS) {
                const store = new MemoryAuthorityPermitStore(issuerActor);
                const issuer = new TenantAuthorityPermitIssuer(store);
                const request = targetRequestFor(expectation(), `blocked-${mutated}`);
                const error = caughtAgentCoreError(() =>
                    store.transaction((transaction) =>
                        issuer.issue(
                            transaction,
                            request,
                            tenantDecision(request, issuedAt, mutated),
                            issuedAt
                        )
                    )
                );
                expect(error.code, mutated).toBe("protocol.invalid-state");
                expect(
                    store.transaction((transaction) => store.issued(transaction, request.nonce)),
                    mutated
                ).toBeUndefined();
            }

            // Control: the same rig issues when no class has moved, so the three refusals
            // cannot be read off a rig that refuses everything.
            const store = new MemoryAuthorityPermitStore(issuerActor);
            const request = targetRequestFor(expectation(), "blocked-none");
            const permit = store.transaction((transaction) =>
                new TenantAuthorityPermitIssuer(store).issue(
                    transaction,
                    request,
                    tenantDecision(request, issuedAt, "none"),
                    issuedAt
                )
            );
            expect(permit.requestDigest.equals(request.digest())).toBe(true);
        }
    );

    test(
        "[C13-AUTH-MEDIATED-ADMISSION] a revocation committed after issuance blocks every not-yet-issued permit and cannot cancel the admitted one",
        { tags: "p0" },
        async () => {
            for (const mutated of LINEARIZED_MUTATIONS) {
                const tenantStore = new MemoryAuthorityPermitStore(issuerActor);
                const targetStore = new MemoryAuthorityPermitStore(targetActor);
                const issuer = new TenantAuthorityPermitIssuer(tenantStore);
                const expected = expectation();
                const admitted = targetRequestFor(expected, `admitted-${mutated}`);
                const permit = tenantStore.transaction((transaction) =>
                    issuer.issue(
                        transaction,
                        admitted,
                        tenantDecision(admitted, issuedAt, "none"),
                        issuedAt
                    )
                );

                const later = targetRequestFor(expected, `later-${mutated}`);
                const blocked = caughtAgentCoreError(() =>
                    tenantStore.transaction((transaction) =>
                        issuer.issue(
                            transaction,
                            later,
                            tenantDecision(later, issuedAt, mutated),
                            issuedAt
                        )
                    )
                );
                expect(blocked.code, mutated).toBe("protocol.invalid-state");
                expect(
                    tenantStore.transaction((transaction) =>
                        tenantStore.issued(transaction, later.nonce)
                    ),
                    mutated
                ).toBeUndefined();

                const authentication = await authenticate(tenantStore, permit, expected);
                recordTargetRequest(targetStore, expected, permit.nonce);
                targetStore.transaction((transaction) =>
                    new StoredAuthorityPermitAdmissionPort(targetStore).consume(
                        transaction,
                        authentication,
                        permit,
                        expected,
                        new Date(issuedAt.getTime() + 1)
                    )
                );
                expect(
                    targetStore.transaction(
                        (transaction) => targetStore.consumed(transaction, permit.nonce)?.value
                    ),
                    mutated
                ).toBe(permit.digest().value);
            }
        }
    );

    test(
        "[C13-AUTH-MEDIATED-ADMISSION] the Tenant decision the permit is issued from binds the exact target fence, ordinal, arguments digest, and whole intent",
        { tags: "p0" },
        () => {
            for (const [name, override] of DECISION_BOUND_REFINEMENTS) {
                const store = new MemoryAuthorityPermitStore(issuerActor);
                const issuer = new TenantAuthorityPermitIssuer(store);
                const nonce = "refinement-decision";
                const requested = targetRequestFor(expectation(), nonce);
                const decided = targetRequestFor(expectation(override), nonce);
                expect(decided.digest().equals(requested.digest()), name).toBe(false);

                const error = caughtAgentCoreError(() =>
                    store.transaction((transaction) =>
                        issuer.issue(
                            transaction,
                            requested,
                            tenantDecision(decided, issuedAt, "none"),
                            issuedAt
                        )
                    )
                );
                expect(error.code, name).toBe("protocol.invalid-state");
                expect(
                    store.transaction((transaction) => store.issued(transaction, nonce)),
                    name
                ).toBeUndefined();
            }
        }
    );

    test(
        "[C13-AUTH-MEDIATED-ADMISSION] the target's durable request binds the exact claim, reservation epoch, and item key the Tenant decision record cannot witness",
        { tags: "p0" },
        async () => {
            for (const [name, override] of REQUEST_BOUND_REFINEMENTS) {
                const nonce = `refinement-request-${name.replace(/ /gu, "-")}`;
                const requested = expectation();
                const substituted = expectation(override);
                expect(substituted.equals(requested), name).toBe(false);

                // Measured asymmetry: these three are absent from AuthorityCheckRequest, so a
                // decision taken against one of them admits issuance under the other. The
                // linearization is still exact because the permit carries the whole
                // expectation and the target holds its own request.
                const tenantStore = new MemoryAuthorityPermitStore(issuerActor);
                const substitutedRequest = targetRequestFor(substituted, nonce);
                const permit = tenantStore.transaction((transaction) =>
                    new TenantAuthorityPermitIssuer(tenantStore).issue(
                        transaction,
                        substitutedRequest,
                        tenantDecision(targetRequestFor(requested, nonce), issuedAt, "none"),
                        issuedAt
                    )
                );
                expect(permit.expectation.equals(substituted), name).toBe(true);

                const targetStore = new MemoryAuthorityPermitStore(targetActor);
                recordTargetRequest(targetStore, requested, nonce);
                const authentication = await authenticate(tenantStore, permit, substituted);
                const error = caughtAgentCoreError(() =>
                    targetStore.transaction((transaction) =>
                        new StoredAuthorityPermitAdmissionPort(targetStore).consume(
                            transaction,
                            authentication,
                            permit,
                            substituted,
                            new Date(issuedAt.getTime() + 1)
                        )
                    )
                );
                expect(error.code, name).toBe("authority.denied");
                expect(
                    targetStore.transaction((transaction) =>
                        targetStore.consumed(transaction, nonce)
                    ),
                    name
                ).toBeUndefined();
            }
        }
    );

    test(
        "[C13-AUTH-MEDIATED-ADMISSION] the admission expectation is closed over exactly the rule 7 comparison inputs",
        { tags: "p0" },
        () => {
            // The expectation is the record of the final comparison, so its field set is that
            // comparison's input set. Enumerating it makes the absence of any other input
            // checkable rather than structural: a host that widened admission to read §7.4
            // Receipt state, or dropped one of rule 7's inputs, moves this list.
            const data = expectation().toData();
            expect(Object.keys(data).sort()).toEqual([
                "argumentsDigest",
                "attemptOrdinal",
                "authority",
                "binding",
                "claim",
                "claimOwner",
                "facet",
                "impact",
                "intentDigest",
                "invocation",
                "issuer",
                "itemIndex",
                "itemKey",
                "lease",
                "operation",
                "package",
                "pathEpochs",
                "principal",
                "reservation",
                "source",
                "target",
                "tenant"
            ]);

            for (const receiptField of ["outcome", "receipt", "failure"]) {
                expect(
                    () =>
                        AuthorityPermitExpectation.fromData({
                            ...data,
                            [receiptField]: "succeeded"
                        }),
                    receiptField
                ).toThrow(/Authority permit expectation/u);
            }
            for (const field of Object.keys(data)) {
                expect(
                    () =>
                        AuthorityPermitExpectation.fromData(
                            Object.fromEntries(
                                Object.entries(data).filter(([key]) => key !== field)
                            )
                        ),
                    field
                ).toThrow(/Authority permit expectation/u);
            }
        }
    );
});

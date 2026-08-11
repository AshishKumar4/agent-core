import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, type SynchronousResultGuard } from "../../src/actors";
import { RunId, TurnId } from "../../src/agents";
import {
    AuthenticatedAuthorityPermit,
    AuthorityPermit,
    AuthorityPermitAuthenticator,
    AuthorityPermitAuthorityPort,
    AuthorityPermitExpectation,
    AuthorityPermitIssuedRecordSource,
    AuthorityPermitIssuer,
    MemoryAuthorityPermitStore,
    PathEpochEvidence,
    ScopeEpoch,
    StoredAuthorityPermitAdmissionPort,
    requireAuthenticatedAuthorityPermit,
    type AuthorityPermitExpectationInit,
    type AuthorityPermitOwnerStore
} from "../../src/authority";
import {
    Digest,
    Revision,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { corrupt } from "../helpers/corrupt";
import { PackageId, PackagePin } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import { BindingName, FacetRef, OperationRef, ProtectionDomain } from "../../src/facets";
import { PrincipalId, PrincipalRef, ScopeRef, TenantId, WorkspaceId } from "../../src/identity";
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

class CurrentAuthority<Transaction> extends AuthorityPermitAuthorityPort<Transaction> {
    public live = true;
    public generation = 3;
    public path = path;
    public lastClaim: ItemClaimId | undefined;

    public admits(
        _transaction: Transaction,
        expectation: AuthorityPermitExpectation,
        _issuedAt: Date
    ): boolean {
        this.lastClaim = expectation.claim;
        return (
            this.live &&
            expectation.binding.generation.value === this.generation &&
            expectation.pathEpochs.equals(this.path)
        );
    }
}

interface StoreHarness<Transaction> {
    readonly tenantStore: AuthorityPermitOwnerStore<Transaction>;
    readonly targetStore: AuthorityPermitOwnerStore<Transaction>;
    restartTenant(): AuthorityPermitOwnerStore<Transaction>;
    restartTarget(): AuthorityPermitOwnerStore<Transaction>;
}

function permitStoreContract<Transaction>(
    name: string,
    create: () => StoreHarness<Transaction>
): void {
    describe(`[authority-permit-owner-store] ${name}`, () => {
        test(
            "issues and consumes exactly once across owner-store restart",
            { tags: "p0" },
            async () => {
                const harness = create();
                const authority = new CurrentAuthority<Transaction>();
                const expected = expectation();
                const issuer = new AuthorityPermitIssuer(harness.tenantStore, authority);
                const permit = harness.tenantStore.transaction((transaction) =>
                    issuer.issue(transaction, expected, `${name}-once`, issuedAt, expiresAt)
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
                const replayTarget = harness.restartTarget();
                expect(() =>
                    replayTarget.transaction((transaction) =>
                        new StoredAuthorityPermitAdmissionPort(replayTarget).consume(
                            transaction,
                            authentication,
                            permit,
                            expected,
                            new Date(expiresAt.getTime() + 1)
                        )
                    )
                ).toThrow(/already used|not valid/);
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
                            expected,
                            `${name}-rollback`,
                            issuedAt,
                            expiresAt
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
                    issuer.issue(transaction, expected, `${name}-admission`, issuedAt, expiresAt)
                );
                const authentication = await authenticate(harness.tenantStore, permit, expected);
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
                    expected,
                    nonce,
                    issuedAt,
                    expiresAt
                )
            );

            authority.live = false;
            authority.lastClaim = undefined;
            const restarted = harness.restartTenant();
            const replay = restarted.transaction((transaction) =>
                new AuthorityPermitIssuer(restarted, authority).issue(
                    transaction,
                    expected,
                    nonce,
                    new Date(issuedAt.getTime() + 1_000),
                    new Date(expiresAt.getTime() + 1_000)
                )
            );

            expect(AuthorityPermit.encode(replay)).toEqual(AuthorityPermit.encode(first));
            expect(authority.lastClaim).toBeUndefined();
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
                                expected,
                                nonce,
                                new Date(issuedAt.getTime() + offset),
                                new Date(expiresAt.getTime() + offset)
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
                    issuer.issue(transaction, expected, `${name}-cas`, issuedAt, expiresAt)
                );
                for (const [field, substituted] of substitutions(expected)) {
                    expect(
                        () =>
                            harness.tenantStore.transaction((transaction) =>
                                issuer.issue(
                                    transaction,
                                    substituted,
                                    `${name}-cas`,
                                    issuedAt,
                                    expiresAt
                                )
                            ),
                        field
                    ).toThrow(/another issuance expectation/);
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
                                issuedAt,
                                expiresAt
                            })
                        )
                    )
                ).toThrow(/another|foreign/);
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

            const envelope = decodeCanonicalJson(AuthorityPermit.encode(permit)) as {
                kind: string;
                version: { major: number; minor: number };
                payload: Record<string, unknown>;
            };
            expect(Object.keys(envelope.payload).sort()).toEqual([
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
                "reservation",
                "source",
                "target",
                "tenant"
            ]);
            envelope.payload["ambientAuthority"] = true;
            expect(() => AuthorityPermit.decode(encodeCanonicalJson(envelope as never))).toThrow(
                /missing or unknown fields/
            );
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
        expect(() => expectation({ impact: "invalid" as never })).toThrow(/impact is invalid/);
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: " ",
                    issuedAt,
                    expiresAt
                })
        ).toThrow(/nonblank/);
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: "bad-expiry",
                    issuedAt,
                    expiresAt: issuedAt
                })
        ).toThrow(/after issuance/);
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: "bad-time",
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
                    obligation: {
                        kind: "route" as never,
                        invocation,
                        itemIndex: 2,
                        itemKey
                    }
                }
            })
        ).toThrow(TypeError);
    });

    test("rejects malformed codec variants fail closed", { tags: "p0" }, () => {
        const permit = new AuthorityPermit({
            ...expectation(),
            nonce: "malformed-codec",
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
                issuer.issue(transaction, expected, "adversarial", issuedAt, expiresAt)
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
                issuer.issue(transaction, expected, "before-revocation", issuedAt, expiresAt)
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
                    issuer.issue(transaction, expected, "after-revocation", issuedAt, expiresAt)
                )
            ).toThrow(/does not admit/);

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
                    expected,
                    "memory-corruption",
                    issuedAt,
                    expiresAt
                )
            );
            const snapshot = issuerStore.snapshot();
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        ...snapshot,
                        version: 2
                    } as never)
            ).toThrow(/malformed/);
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 1,
                        issued: [snapshot.issued[0]!, snapshot.issued[0]!],
                        consumed: []
                    })
            ).toThrow(/malformed/);
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 1,
                        issued: [{ nonce: "wrong-nonce", bytes: snapshot.issued[0]!.bytes }],
                        consumed: []
                    })
            ).toThrow(/malformed/);
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 1,
                        issued: [],
                        consumed: [{ nonce: "consumed", digest: "bad-digest" }]
                    })
            ).toThrow();
            expect(
                () =>
                    new MemoryAuthorityPermitStore(issuerActor, {
                        version: 1,
                        issued: snapshot.issued,
                        consumed: [{ nonce: permit.nonce, digest: permit.digest().value }]
                    })
            ).toThrow(/malformed/);
            expect(() => new MemoryAuthorityPermitStore(targetActor, snapshot)).toThrow(
                /another Actor owner/
            );

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
            const snapshots = [
                { version: 1, issued: [null as never], consumed: [] },
                { version: 1, issued: [], consumed: [null as never] },
                { version: 1, issued: [], consumed: [{ nonce: 5 as never, digest: digestValue }] },
                {
                    version: 1,
                    issued: [],
                    consumed: [{ nonce: "corrupt-nonce", digest: 5 as never }]
                }
            ] as const;
            for (const snapshot of snapshots) {
                let thrown: unknown;
                try {
                    new MemoryAuthorityPermitStore(issuerActor, snapshot);
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
                    expected,
                    "sqlite-corruption",
                    issuedAt,
                    expiresAt
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
                    expected,
                    "sqlite-fault",
                    issuedAt,
                    expiresAt
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
            expect(() => readStore.issued(readFailure, permit.nonce)).toThrow(/read failed/);
            readFailure.failAll = new AgentCoreError("codec.invalid", "closed read");
            expect(() => readStore.issued(readFailure, permit.nonce)).toThrow(/closed read/);

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
            expect(() => corruptStore.issued(corruptProjection, permit.nonce)).toThrow(/malformed/);

            corruptProjection.mapRows = (rows) => rows.map((row) => ({ ...row, state: "invalid" }));
            expect(() => new SqliteAuthorityPermitStore(corruptProjection, issuerActor)).toThrow(
                /malformed/
            );
            corruptProjection.mapRows = (rows) => rows.map((row) => ({ ...row, record: null }));
            expect(() => corruptStore.issued(corruptProjection, permit.nonce)).toThrow(/malformed/);
            corruptProjection.mapRows = (rows) => rows.map((row) => ({ ...row, owner_id: "" }));
            expect(() => corruptStore.issued(corruptProjection, permit.nonce)).toThrow(/malformed/);

            const consumedProjection = new ControlledSqlite();
            const consumedStore = new SqliteAuthorityPermitStore(consumedProjection, targetActor);
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
            expect(() => consumedStore.consumed(consumedProjection, permit.nonce)).toThrow(
                /malformed/
            );
        }
    );
});

class StoreIssuedRecordSource<Transaction> extends AuthorityPermitIssuedRecordSource {
    public constructor(private readonly store: AuthorityPermitOwnerStore<Transaction>) {
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
    store: AuthorityPermitOwnerStore<Transaction>,
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
        generation: new Revision(3)
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
        operation: overrides.operation ?? new OperationRef("mail:send"),
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
        argumentsDigest: overrides.argumentsDigest ?? digest("arguments"),
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
        ["operation", expectation({ operation: new OperationRef("mail:draft") })],
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
        ["arguments digest", expectation({ argumentsDigest: digest("other-arguments") })],
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

describe("AuthorityPermit mutation gates", () => {
    test("exposes every expectation field through the permit getters", { tags: "p0" }, () => {
        const expected = expectation();
        const permit = new AuthorityPermit({
            ...expected,
            nonce: "getter-nonce",
            issuedAt,
            expiresAt
        });

        expect(permit.tenant.equals(tenant)).toBe(true);
        expect(permit.issuer.equals(issuerActor)).toBe(true);
        expect(permit.source.equals(sourceActor)).toBe(true);
        expect(permit.principal.equals(principal)).toBe(true);
        expect(permit.binding.name.value).toBe("mail");
        expect(permit.binding.generation.value).toBe(3);
        expect(permit.facet.value).toBe("workspace:mail");
        expect(permit.operation.value).toBe("mail:send");
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
                    issuedAt,
                    expiresAt: new Date(Number.NaN)
                })
        ).toThrow(new TypeError("Authority permit expiry must be a valid non-negative Date"));
        expect(
            () =>
                new AuthorityPermit({
                    ...expectation(),
                    nonce: "negative-issue",
                    issuedAt: new Date(-1),
                    expiresAt
                })
        ).toThrow(
            new TypeError("Authority permit issuance time must be a valid non-negative Date")
        );

        const epochPermit = new AuthorityPermit({
            ...expectation(),
            nonce: "epoch-issue",
            issuedAt: new Date(0),
            expiresAt: new Date(1)
        });
        expect(epochPermit.issuedAt.getTime()).toBe(0);
    });

    test("rejects blank and non-canonical nonces exactly", { tags: "p0" }, () => {
        for (const nonce of ["", " padded"]) {
            expect(
                () => new AuthorityPermit({ ...expectation(), nonce, issuedAt, expiresAt })
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
                issuedAt,
                expiresAt
            });
            const bytes = AuthorityPermit.encode(permit);
            const drifted = new AuthorityPermit({
                ...expected,
                nonce: "auth-nonce-b",
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
                    expected,
                    "auth-evidence-a",
                    issuedAt,
                    expiresAt
                )
            );
            const authentication = await authenticate(store, permit, expected);

            expect(() => requireAuthenticatedAuthorityPermit(authentication, permit)).not.toThrow();
            const other = new AuthorityPermit({
                ...expected,
                nonce: "auth-evidence-b",
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
                issuedAt,
                expiresAt
            });

            store.transaction((transaction) => {
                expect(store.issue(transaction, permit)).toBe(permit);
                const replay = new AuthorityPermit({
                    ...expected,
                    nonce: "store-issue-nonce",
                    issuedAt: new Date(issuedAt.getTime() + 500),
                    expiresAt: new Date(expiresAt.getTime() + 500)
                });
                const settled = store.issue(transaction, replay);
                expect(AuthorityPermit.encode(settled)).toEqual(AuthorityPermit.encode(permit));

                const conflicting = new AuthorityPermit({
                    ...expectation({ claim: new ItemClaimId("store-other-claim") }),
                    nonce: "store-issue-nonce",
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

    test("a consumed nonce can never be reused by the same owner", { tags: "p0" }, async () => {
        const expected = expectation({
            target: {
                actor: issuerActor,
                fence: 11,
                domain: new ProtectionDomain("backend", "permit-domain", "may-hold-secrets")
            }
        });
        const issuerStore = new MemoryAuthorityPermitStore(issuerActor);
        const permit = issuerStore.transaction((transaction) =>
            new AuthorityPermitIssuer(issuerStore, new CurrentAuthority()).issue(
                transaction,
                expected,
                "store-consumed-reuse",
                issuedAt,
                expiresAt
            )
        );
        const authentication = await authenticate(issuerStore, permit, expected);

        const ownerStore = new MemoryAuthorityPermitStore(issuerActor);
        ownerStore.transaction((transaction) =>
            ownerStore.consume(
                transaction,
                authentication,
                permit,
                expected,
                new Date(issuedAt.getTime() + 1)
            )
        );
        const reissue = caughtAgentCoreError(() =>
            ownerStore.transaction((transaction) => ownerStore.issue(transaction, permit))
        );
        expect(reissue.code).toBe("authority.denied");
        expect(reissue.message).toBe("Authority permit nonce was already used by this Actor owner");
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
        expect(replay.message).toBe("Authority permit nonce was already used by this Actor owner");
    });

    test("snapshots order issued and consumed records canonically", { tags: "p1" }, async () => {
        const store = new MemoryAuthorityPermitStore(issuerActor);
        const expected = expectation();
        const second = new AuthorityPermit({
            ...expected,
            nonce: "store-order-b",
            issuedAt,
            expiresAt
        });
        const first = new AuthorityPermit({
            ...expected,
            nonce: "store-order-a",
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

    test("snapshot and staged bytes stay detached from committed state", { tags: "p0" }, () => {
        const store = new MemoryAuthorityPermitStore(issuerActor);
        const permit = new AuthorityPermit({
            ...expectation(),
            nonce: "store-detached",
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

        expect(() =>
            store.transaction((transaction) => {
                transaction.issuedRecords.get("store-detached")?.fill(0);
                throw new AgentCoreError("protocol.invalid-state", "abort staged mutation");
            })
        ).toThrow(/abort staged mutation/);
        expect(
            store.transaction(
                (transaction) => store.issued(transaction, "store-detached")?.digest().value
            )
        ).toBe(permit.digest().value);
    });

    test("detects issued records filed under a foreign nonce", { tags: "p0" }, () => {
        const store = new MemoryAuthorityPermitStore(issuerActor);
        const permit = new AuthorityPermit({
            ...expectation(),
            nonce: "store-real-nonce",
            issuedAt,
            expiresAt
        });
        expect(() =>
            store.transaction((transaction) => {
                transaction.issuedRecords.set("store-alias-nonce", AuthorityPermit.encode(permit));
                const error = caughtAgentCoreError(() =>
                    store.issued(transaction, "store-alias-nonce")
                );
                expect(error.code).toBe("codec.invalid");
                expect(error.message).toBe("Stored authority permit ownership is malformed");
                throw new AgentCoreError("protocol.invalid-state", "discard corrupted staging");
            })
        ).toThrow(/discard corrupted staging/);
    });

    test("restore rejects holed snapshot records as malformed", { tags: "p0" }, () => {
        // Length-only arrays model malformed persisted records without forging types.
        const issuedHole = caughtAgentCoreError(
            () =>
                new MemoryAuthorityPermitStore(issuerActor, {
                    version: 1,
                    issued: Array.from<{ nonce: string; bytes: Uint8Array }>({ length: 1 }),
                    consumed: []
                })
        );
        expect(issuedHole.code).toBe("codec.invalid");
        expect(issuedHole.message).toBe("Stored authority permit ownership is malformed");

        const consumedHole = caughtAgentCoreError(
            () =>
                new MemoryAuthorityPermitStore(issuerActor, {
                    version: 1,
                    issued: [],
                    consumed: Array.from<{ nonce: string; digest: string }>({ length: 1 })
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

function caughtAgentCoreError(run: () => unknown): AgentCoreError {
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

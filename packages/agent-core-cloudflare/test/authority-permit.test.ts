import {
    ActorId,
    ActorRef,
    AuthorityPermit,
    AuthorityPermitExpectation,
    type AuthorityPermitOwnerStore,
    BindingName,
    ClaimWorkerId,
    Digest,
    FacetRef,
    InvocationId,
    ItemClaimId,
    OperationRef,
    PackageId,
    PackagePin,
    PathEpochEvidence,
    PrincipalId,
    PrincipalRef,
    ProtectionDomain,
    Revision,
    ScopeEpoch,
    ScopeRef,
    SemVer,
    TenantId,
    WorkspaceId
} from "@agent-core/core";
import { RunId, TurnId } from "@agent-core/core/agents/runs";
import type { SynchronousResultGuard } from "@agent-core/core/actors";
import {
    CloudflareAuthorityPermitAdmission,
    CloudflareSqlite,
    createCloudflareAuthorityPermitStore
} from "../src/index.js";
import { FakeDurableObjectStorage, FakeSqlStorage, fakeErrors } from "./fakes.js";

const tenant = new TenantId("permit-tenant");
const principalId = new PrincipalId("permit-principal");
const principal = new PrincipalRef(tenant, principalId);
const issuerActor = new ActorRef("tenant", new ActorId("permit-issuer"));
const sourceActor = new ActorRef("workspace", new ActorId("permit-source"));
const targetActor = new ActorRef("run", new ActorId("permit-target"));
const invocation = new InvocationId("permit-invocation");
const itemKey = "permit-item";
const issuedAt = new Date("2026-07-12T12:00:00.000Z");
const expiresAt = new Date("2026-07-12T12:00:05.000Z");

interface PermitTransaction {
    issued: Map<string, AuthorityPermit>;
    consumed: Map<string, Digest>;
}

class CurrentAuthority {
    public admits(
        _transaction: PermitTransaction,
        expectation: AuthorityPermitExpectation
    ): boolean {
        return expectation.pathEpochs.equals(pathEpochs());
    }
}

class PermitStore implements AuthorityPermitOwnerStore<PermitTransaction> {
    #state: PermitTransaction = { issued: new Map(), consumed: new Map() };

    public constructor(public readonly owner: ActorRef) {}

    public transaction<Result>(
        operation: (transaction: PermitTransaction) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        const draft = cloneState(this.#state);
        const result = operation(draft);
        this.#state = draft;
        return result;
    }

    public issued(transaction: PermitTransaction, nonce: string): AuthorityPermit | undefined {
        return transaction.issued.get(nonce);
    }

    public consumed(transaction: PermitTransaction, nonce: string): Digest | undefined {
        return transaction.consumed.get(nonce);
    }

    public issue(transaction: PermitTransaction, permit: AuthorityPermit): AuthorityPermit {
        if (transaction.issued.has(permit.nonce) || transaction.consumed.has(permit.nonce)) {
            throw new TypeError("permit nonce already used");
        }
        transaction.issued.set(permit.nonce, permit);
        return permit;
    }

    public consume(
        transaction: PermitTransaction,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void {
        permit.assertConsumable(expected, now);
        if (transaction.consumed.has(permit.nonce)) throw new TypeError("permit already used");
        transaction.consumed.set(permit.nonce, permit.digest());
    }
}

test("creates the canonical core permit store over Cloudflare SQLite", () => {
    const sql = new FakeSqlStorage(() => ({ rows: [] }));
    const database = new CloudflareSqlite(new FakeDurableObjectStorage(sql), fakeErrors);
    const store = createCloudflareAuthorityPermitStore(database, targetActor);

    expect(store.owner.equals(targetActor)).toBe(true);
    expect(sql.calls.some(({ statement }) => statement.includes("authority_permit_nonces"))).toBe(
        true
    );
});

test("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] binds the complete canonical intent before EffectAttempt admission", () => {
    const tenantStore = new PermitStore(issuerActor);
    const targetStore = new PermitStore(targetActor);
    const expected = expectation();
    const permit = tenantStore.transaction((transaction) =>
        issue(tenantStore, transaction, expected, "permit-once")
    );
    const admission = new CloudflareAuthorityPermitAdmission(targetStore);
    let attempts = 0;
    const substituted = expectation({ intentDigest: digest("substituted-intent") });

    expect(() =>
        targetStore.transaction((transaction) =>
            admission.admit(
                transaction,
                permit,
                substituted,
                new Date(issuedAt.getTime() + 1),
                () => {
                    attempts += 1;
                }
            )
        )
    ).toThrow(/exact target admission/);
    expect(attempts).toBe(0);
});

test("[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] atomically consumes with EffectAttempt and rolls both back together", () => {
    const tenantStore = new PermitStore(issuerActor);
    const targetStore = new PermitStore(targetActor);
    const expected = expectation();
    const permit = tenantStore.transaction((transaction) =>
        issue(tenantStore, transaction, expected, "permit-atomic")
    );
    const admission = new CloudflareAuthorityPermitAdmission(targetStore);

    expect(() =>
        targetStore.transaction((transaction) =>
            admission.admit(transaction, permit, expected, new Date(issuedAt.getTime() + 1), () => {
                throw new TypeError("attempt append failed");
            })
        )
    ).toThrow(/append failed/);
    expect(
        targetStore.transaction((transaction) => targetStore.consumed(transaction, permit.nonce))
    ).toBeUndefined();

    targetStore.transaction((transaction) =>
        admission.admit(
            transaction,
            permit,
            expected,
            new Date(issuedAt.getTime() + 1),
            () => "attempt"
        )
    );
    expect(() =>
        targetStore.transaction((transaction) =>
            admission.admit(
                transaction,
                permit,
                expected,
                new Date(issuedAt.getTime() + 2),
                () => "replay"
            )
        )
    ).toThrow(/already used/);
});

function expectation(
    overrides: Partial<ConstructorParameters<typeof AuthorityPermitExpectation>[0]> = {}
): AuthorityPermitExpectation {
    const binding = overrides.binding ?? {
        name: new BindingName("mail"),
        generation: new Revision(3)
    };
    const selectedInvocation = overrides.invocation ?? invocation;
    const selectedItemIndex = overrides.itemIndex ?? 2;
    const selectedItemKey = overrides.itemKey ?? itemKey;
    const lease = Object.freeze({
        turn: new TurnId("permit-turn"),
        holder: principalId,
        epoch: 7
    });
    return new AuthorityPermitExpectation({
        tenant,
        issuer: issuerActor,
        source: sourceActor,
        target: {
            actor: targetActor,
            fence: 11,
            domain: new ProtectionDomain("backend", "permit-domain", "may-hold-secrets")
        },
        principal,
        binding,
        facet: new FacetRef("workspace:mail"),
        operation: new OperationRef("mail:send"),
        package: new PackagePin(
            new PackageId("mail-package"),
            new SemVer("1.2.3"),
            digest("manifest"),
            digest("code")
        ),
        impact: "externalSend",
        invocation: selectedInvocation,
        reservation: {
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
        attemptOrdinal: 1,
        claim: new ItemClaimId("permit-claim"),
        claimOwner: {
            kind: "executor",
            token: lease,
            worker: new ClaimWorkerId("permit-worker")
        },
        itemKey: selectedItemKey,
        argumentsDigest: digest("arguments"),
        intentDigest: digest("intent"),
        pathEpochs: pathEpochs(),
        authority: { kind: "initiator", principal, binding: binding.name },
        lease,
        ...overrides
    });
}

function pathEpochs(): PathEpochEvidence {
    return new PathEpochEvidence([
        new ScopeEpoch(ScopeRef.tenant(tenant), 4),
        new ScopeEpoch(ScopeRef.workspace(tenant, new WorkspaceId("permit-workspace")), 9)
    ]);
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

function issue(
    store: PermitStore,
    transaction: PermitTransaction,
    expected: AuthorityPermitExpectation,
    nonce: string
): AuthorityPermit {
    if (!new CurrentAuthority().admits(transaction, expected)) {
        throw new TypeError("authority denied");
    }
    return store.issue(
        transaction,
        new AuthorityPermit({ ...expected, nonce, issuedAt, expiresAt })
    );
}

function cloneState(state: PermitTransaction): PermitTransaction {
    return { issued: new Map(state.issued), consumed: new Map(state.consumed) };
}

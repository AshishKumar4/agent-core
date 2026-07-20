import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, MemoryActorStore, type ActorLocalStore } from "../../src/actors";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermit,
    AuthorityPermitExpectation,
    Binding,
    BindingValidationEvidence,
    BindingValidationRequest,
    GrantId,
    PathEpochEvidence,
    ScopeEpoch
} from "../../src/authority";
import {
    TENANT_AUTHORITY_COMMANDS,
    createClosedTenantAuthorityComposition,
    type ClosedTenantAuthorityComposition,
    type TenantAuthorityCommandBackend
} from "../../src/composition";
import { ContentRef, Digest, Revision, SemVer, encodeCanonicalJson } from "../../src/core";
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
import { AuditRecordId, CorrelationId, InvocationId, WriteRecordId } from "../../src/invocations";
import { InvocationId as AuthorityInvocationId } from "../../src/interaction-references";
import {
    AuthorityCheckReply,
    AuthorityPermitIssuanceReply,
    AuthorityPermitIssuanceRequest,
    BindingValidationReply,
    CommandEnvelope,
    CommandEnvelopeCodec,
    MemoryProtocolPersistence,
    MemoryProtocolRecords,
    type CommandCaller,
    type CommandDispatchResult,
    type CommandIdentity,
    type ProtocolPersistence
} from "../../src/protocol";
import {
    ReadableSqlite,
    SqliteActorStore,
    SqliteAuthorityPermitStore,
    SqliteProtocolPersistence,
    TransactionalSqlite
} from "../../src/substrates";
import { RunId, TurnId } from "../../src/agents";
import { TestSqlite } from "../helpers/sqlite";
import { CounterAuthenticator, CounterContentStore } from "../protocol/counter-fixture";

const now = new Date("2026-07-12T14:00:00.000Z");
const tenant = new TenantId("authority-command-tenant");
const tenantActor = new ActorRef("tenant", new ActorId("authority-command-tenant"));
const sourceActor = new ActorRef("workspace", new ActorId("authority-command-source"));
const targetActor = new ActorRef("run", new ActorId("authority-command-target"));
const principal = new PrincipalRef(tenant, new PrincipalId("authority-command-principal"));
const authorityTurn = new TurnId("authority-command-turn");
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("authority-command-workspace"));
const facet = new FacetRef("workspace:mail");
const bindingName = new BindingName("mail");
const grant = new GrantId("authority-command-grant");
const domain = new ProtectionDomain("backend", "authority-command", "may-hold-secrets");
const binding = Binding.active(
    workspaceScope,
    SubjectRef.principal(principal.principalId),
    domain,
    bindingName,
    grant,
    facet
);

interface AuthorityCommandRead {
    readonly fence: number;
    readonly principal: PrincipalRef;
    readonly path: PathEpochEvidence;
}

interface AuthorityCommandSnapshot {
    readonly writes: number;
    readonly audits: number;
    readonly permits: number;
    readonly checks: number;
}

interface AuthorityCommandHarness {
    readonly caller: CommandCaller;
    bindingRequest(): BindingValidationRequest;
    checkRequest(path?: PathEpochEvidence, selectedPrincipal?: PrincipalRef): AuthorityCheckRequest;
    permitRequest(path?: PathEpochEvidence): AuthorityPermitIssuanceRequest;
    envelope(
        command: string,
        key: string,
        payload: Uint8Array,
        caller?: CommandCaller,
        lease?: NonNullable<CommandEnvelope["lease"]>
    ): Uint8Array;
    dispatch(
        raw: Uint8Array,
        payload: Uint8Array,
        transport?: CommandCaller
    ): Promise<ReturnTypeResult>;
    setEpoch(epoch: number): void;
    failEvidenceAppend(fail: boolean): void;
    snapshot(): AuthorityCommandSnapshot;
}

type ReturnTypeResult = CommandDispatchResult;

type HarnessFactory = () => AuthorityCommandHarness;

function authorityCommandContract(name: string, create: HarnessFactory): void {
    describe(`closed Tenant authority commands (${name})`, () => {
        test("binds validation and check evidence to the authenticated source and decision time", async () => {
            const harness = create();
            const validation = harness.bindingRequest();
            const validationPayload = BindingValidationRequest.encode(validation);
            const validated = await harness.dispatch(
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.validateBinding,
                    `${name}-binding`,
                    validationPayload
                ),
                validationPayload
            );
            const validationReply = BindingValidationReply.decode(validated.reply);

            expect(validated.outcome).toBe("committed");
            expect(validationReply.evidence.binds(validation)).toBe(true);
            expect(validationReply.evidence.checkedAt).toEqual(now);
            expect(BindingValidationEvidence.decode(validated.observation!).binds(validation)).toBe(
                true
            );

            const request = harness.checkRequest();
            const payload = AuthorityCheckRequest.encode(request);
            const checked = await harness.dispatch(
                harness.envelope(TENANT_AUTHORITY_COMMANDS.check, `${name}-check`, payload),
                payload
            );
            const reply = AuthorityCheckReply.decode(checked.reply);

            expect(checked.outcome).toBe("committed");
            expect(reply.evidence.binds(request)).toBe(true);
            expect(reply.evidence.checkedAt).toEqual(now);
            expect(AuthorityCheckEvidence.decode(checked.observation!).allowed).toBe(true);
            expect(checked.write.caller).toEqual(harness.caller);
        });

        test("rejects source Actor and qualified Principal spoofing before authority evaluation", async () => {
            const harness = create();
            const request = harness.checkRequest();
            const payload = AuthorityCheckRequest.encode(request);
            const spoofedActor = new ActorRef("workspace", new ActorId(`${name}-spoofed-source`));
            const spoofedCaller: CommandCaller = { kind: "actor", actor: spoofedActor };
            const actorResult = await harness.dispatch(
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    `${name}-actor-spoof`,
                    payload,
                    spoofedCaller
                ),
                payload,
                spoofedCaller
            );

            const principalRequest = harness.checkRequest(
                undefined,
                new PrincipalRef(tenant, new PrincipalId(`${name}-spoofed-principal`))
            );
            const principalPayload = AuthorityCheckRequest.encode(principalRequest);
            const principalResult = await harness.dispatch(
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    `${name}-principal-spoof`,
                    principalPayload
                ),
                principalPayload
            );

            expect([actorResult.outcome, principalResult.outcome]).toEqual([
                "rejectedAuthority",
                "rejectedAuthority"
            ]);
            expect(harness.snapshot()).toMatchObject({ checks: 0, writes: 2, audits: 2 });
        });

        test("replays duplicate check evidence without re-evaluating authority", async () => {
            const harness = create();
            const request = harness.checkRequest();
            const payload = AuthorityCheckRequest.encode(request);
            const raw = harness.envelope(
                TENANT_AUTHORITY_COMMANDS.check,
                `${name}-duplicate`,
                payload
            );

            const first = await harness.dispatch(raw, payload);
            harness.setEpoch(9);
            const duplicate = await harness.dispatch(raw, payload);

            expect(first.outcome).toBe("committed");
            expect(duplicate.outcome).toBe("duplicate");
            expect(duplicate.reply).toEqual(first.reply);
            expect(duplicate.write.duplicateOf?.equals(first.write.id)).toBe(true);
            expect(harness.snapshot().checks).toBe(1);
        });

        test("admits exact current check and permit leases while rejecting stale epochs", async () => {
            const harness = create();
            const commandLease = { turn: authorityTurn, holder: principal, epoch: 2 };
            const authorityLease = {
                turn: authorityTurn,
                holder: principal,
                epoch: 2
            };
            const check = harness.checkRequest();
            const checkPayload = AuthorityCheckRequest.encode(check);

            const checked = await harness.dispatch(
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    `${name}-leased-check`,
                    checkPayload,
                    undefined,
                    commandLease
                ),
                checkPayload
            );
            const stale = await harness.dispatch(
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    `${name}-stale-check-lease`,
                    checkPayload,
                    undefined,
                    { ...commandLease, epoch: 3 }
                ),
                checkPayload
            );

            const permit = permitRequest(currentPath(1), authorityLease);
            const permitPayload = AuthorityPermitIssuanceRequest.encode(permit);
            const issued = await harness.dispatch(
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.issuePermit,
                    `${name}-leased-permit`,
                    permitPayload,
                    undefined,
                    commandLease
                ),
                permitPayload
            );

            expect(checked.outcome).toBe("committed");
            expect(stale.outcome).toBe("rejectedLease");
            expect(issued.outcome).toBe("committed");
            expect(harness.snapshot()).toMatchObject({ checks: 1, permits: 1, writes: 3 });
        });

        test("commits a typed stale-path denial instead of issuing stale authority", async () => {
            const harness = create();
            const request = harness.checkRequest();
            harness.setEpoch(2);
            const payload = AuthorityCheckRequest.encode(request);
            const result = await harness.dispatch(
                harness.envelope(TENANT_AUTHORITY_COMMANDS.check, `${name}-stale`, payload),
                payload
            );
            const evidence = AuthorityCheckReply.decode(result.reply).evidence;

            expect(result.outcome).toBe("committed");
            expect(evidence).toMatchObject({ decision: "deny", reason: "stalePath" });
            expect(evidence.pathEpochs.target.epoch).toBe(2);
            expect(harness.snapshot()).toMatchObject({ checks: 1, writes: 1, audits: 2 });
        });

        test("[protocol.authority-permit-issuance-request] [protocol.authority-permit-issuance-reply] issues a source-bound permit only for the current path", async () => {
            const harness = create();
            const request = harness.permitRequest();
            const payload = AuthorityPermitIssuanceRequest.encode(request);
            const result = await harness.dispatch(
                harness.envelope(TENANT_AUTHORITY_COMMANDS.issuePermit, `${name}-permit`, payload),
                payload
            );
            const permit = AuthorityPermitIssuanceReply.decode(result.reply).permit;

            expect(result.outcome).toBe("committed");
            expect(permit.expectation.equals(request.expectation)).toBe(true);
            expect(permit.issuedAt).toEqual(now);
            expect(
                AuthorityPermit.decode(result.observation!).digest().equals(permit.digest())
            ).toBe(true);
            expect(harness.snapshot()).toMatchObject({ permits: 1, writes: 1, audits: 2 });

            const staleHarness = create();
            const staleRequest = staleHarness.permitRequest();
            staleHarness.setEpoch(3);
            const stalePayload = AuthorityPermitIssuanceRequest.encode(staleRequest);
            const stale = await staleHarness.dispatch(
                staleHarness.envelope(
                    TENANT_AUTHORITY_COMMANDS.issuePermit,
                    `${name}-stale-permit`,
                    stalePayload
                ),
                stalePayload
            );
            expect(stale.outcome).toBe("rejectedAuthority");
            expect(staleHarness.snapshot()).toMatchObject({ permits: 0, writes: 1, audits: 1 });
        });

        test("rolls permit issuance back when linked WriteRecord evidence rejects", async () => {
            const harness = create();
            const request = harness.permitRequest();
            const payload = AuthorityPermitIssuanceRequest.encode(request);
            const raw = harness.envelope(
                TENANT_AUTHORITY_COMMANDS.issuePermit,
                `${name}-atomic`,
                payload
            );
            harness.failEvidenceAppend(true);

            await expect(harness.dispatch(raw, payload)).rejects.toThrow(/evidence append/);
            expect(harness.snapshot()).toEqual({ writes: 0, audits: 0, permits: 0, checks: 0 });

            harness.failEvidenceAppend(false);
            expect((await harness.dispatch(raw, payload)).outcome).toBe("committed");
            expect(harness.snapshot()).toMatchObject({ writes: 1, permits: 1 });
        });

        test("records malformed ingress without evaluating authority", async () => {
            const harness = create();
            await expect(
                harness.dispatch(new Uint8Array([0xff]), new Uint8Array())
            ).resolves.toMatchObject({
                outcome: "rejectedMalformed"
            });
            expect(harness.snapshot()).toEqual({ writes: 1, audits: 1, permits: 0, checks: 0 });
        });
    });
}

authorityCommandContract("memory", createMemoryHarness);
authorityCommandContract("SQLite", createSqliteHarness);

test("closed Tenant authority composition rejects a non-Tenant owning Actor", () => {
    expect(() =>
        createClosedTenantAuthorityComposition({
            actor: sourceActor
        } as never)
    ).toThrow(/requires a Tenant Actor/);
});

interface MemoryAuthorityState {
    records: MemoryProtocolRecords;
    nextId: number;
    fence: number;
    principal: PrincipalId;
    epoch: number;
    permits: Record<string, Uint8Array>;
    checks: number;
}

function createMemoryHarness(): AuthorityCommandHarness {
    const store = new MemoryActorStore<MemoryAuthorityState>(
        {
            records: new MemoryProtocolRecords(),
            nextId: 0,
            fence: 7,
            principal: principal.principalId,
            epoch: 1,
            permits: {},
            checks: 0
        },
        cloneMemoryState
    );
    let failWrite = false;
    const persistence = new FailingProtocolPersistence(
        new MemoryProtocolPersistence<MemoryAuthorityState>((state) => state.records),
        () => failWrite
    );
    const backend = memoryBackend();
    const composition = createComposition(store, persistence, backend, (transaction) =>
        nextMemoryId(transaction)
    );

    return createHarness(
        composition,
        () => readMemory(store),
        (epoch) => store.transaction((state) => (state.epoch = epoch)),
        (fail) => (failWrite = fail),
        () => {
            const state = store.snapshot().state;
            const protocol = state.records.snapshot();
            return {
                writes: protocol.writes.length,
                audits: protocol.audits.length,
                permits: Object.keys(state.permits).length,
                checks: state.checks
            };
        }
    );
}

function memoryBackend(): TenantAuthorityCommandBackend<
    MemoryAuthorityState,
    AuthorityCommandRead
> {
    return {
        ...readBackend,
        validateBinding: (_state, request, at) => validationEvidence(request, at),
        check: (state, request, at) => {
            state.checks += 1;
            return checkEvidence(request, currentPath(state.epoch), at);
        },
        issuePermit: (state, request, at) => {
            if (state.permits[request.nonce] !== undefined) throw duplicatePermit();
            const permit = permitFor(request, at);
            state.permits[request.nonce] = AuthorityPermit.encode(permit);
            return permit;
        }
    };
}

const CREATE_SQLITE_STATE = `CREATE TABLE authority_command_test_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    fence INTEGER NOT NULL,
    principal TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    checks INTEGER NOT NULL
) STRICT`;

function createSqliteHarness(): AuthorityCommandHarness {
    const database = new TestSqlite();
    database.transaction(() => {
        database.run(CREATE_SQLITE_STATE, []);
        database.run("INSERT INTO authority_command_test_state VALUES (1, 7, ?, 1, 0)", [
            principal.principalId.value
        ]);
        database.run(
            "CREATE TABLE authority_command_test_ids (singleton INTEGER PRIMARY KEY, next_id INTEGER NOT NULL) STRICT",
            []
        );
        database.run("INSERT INTO authority_command_test_ids VALUES (1, 0)", []);
    });
    const permitStore = new SqliteAuthorityPermitStore(database, tenantActor);
    let failWrite = false;
    const persistence = new FailingProtocolPersistence(
        new SqliteProtocolPersistence(database),
        () => failWrite
    );
    const backend = sqliteBackend(permitStore);
    const composition = createComposition(
        new SqliteActorStore(database),
        persistence,
        backend,
        nextSqliteId
    );

    return createHarness(
        composition,
        () => readSqlite(database),
        (epoch) =>
            database.transaction(() =>
                database.run(
                    "UPDATE authority_command_test_state SET epoch = ? WHERE singleton = 1",
                    [epoch]
                )
            ),
        (fail) => (failWrite = fail),
        () => ({
            writes: count(database, "protocol_write_records"),
            audits: count(database, "protocol_audit_records"),
            permits: count(database, "authority_permit_nonces"),
            checks: integer(database, "SELECT checks AS value FROM authority_command_test_state")
        })
    );
}

function sqliteBackend(
    permitStore: SqliteAuthorityPermitStore
): TenantAuthorityCommandBackend<TransactionalSqlite, AuthorityCommandRead> {
    return {
        ...readBackend,
        validateBinding: (_database, request, at) => validationEvidence(request, at),
        check: (database, request, at) => {
            database.run(
                "UPDATE authority_command_test_state SET checks = checks + 1 WHERE singleton = 1",
                []
            );
            return checkEvidence(request, readSqlite(database).path, at);
        },
        issuePermit: (database, request, at) => {
            const permit = permitFor(request, at);
            permitStore.issue(database, permit);
            return permit;
        }
    };
}

const readBackend = {
    sourceFence: (read: AuthorityCommandRead, source: ActorRef) =>
        source.equals(sourceActor) ? read.fence : undefined,
    checkPrincipal: (read: AuthorityCommandRead) => read.principal,
    permitPrincipal: (read: AuthorityCommandRead) => read.principal,
    permitsPermit: (read: AuthorityCommandRead, request: AuthorityPermitIssuanceRequest) =>
        request.expectation.pathEpochs.equals(read.path),
    currentCheckLease: (
        _read: AuthorityCommandRead,
        _request: AuthorityCheckRequest,
        at: Date
    ) => ({
        turn: authorityTurn,
        holder: principal,
        epoch: 2,
        expiresAt: new Date(at.getTime() + 5_000)
    }),
    currentPermitLease: (
        _read: AuthorityCommandRead,
        request: AuthorityPermitIssuanceRequest,
        at: Date
    ) => ({
        turn: request.expectation.lease!.turn,
        holder: principal,
        epoch: request.expectation.lease!.epoch,
        expiresAt: new Date(at.getTime() + 5_000)
    })
};

function createComposition<Transaction, ReadTransaction>(
    store: ActorLocalStore<Transaction, ReadTransaction>,
    persistence: ProtocolPersistence<Transaction>,
    backend: TenantAuthorityCommandBackend<Transaction, AuthorityCommandRead>,
    nextId: (transaction: Transaction) => number
): ClosedTenantAuthorityComposition<
    Transaction,
    AuthorityCommandRead,
    ReadTransaction,
    CommandCaller
> {
    return createClosedTenantAuthorityComposition({
        store,
        persistence,
        backend,
        ids: {
            writeRecordId: (transaction) =>
                new WriteRecordId(`authority-write-${nextId(transaction)}`),
            auditRecordId: (transaction) =>
                new AuditRecordId(`authority-audit-${nextId(transaction)}`),
            invocationId: (transaction) =>
                new InvocationId(`authority-invocation-${nextId(transaction)}`),
            correlationId: (transaction) =>
                new CorrelationId(`authority-correlation-${nextId(transaction)}`)
        },
        actor: tenantActor,
        tenant,
        readOnly: (transaction) => readTransaction(transaction),
        limits: { envelopeBytes: 32_768, payloadBytes: 32_768 },
        content: new CounterContentStore(() => undefined),
        authenticator: new CounterAuthenticator(tenant),
        leaseForMilliseconds: 60_000,
        now: () => now
    });
}

function readTransaction(transaction: unknown): AuthorityCommandRead {
    return transaction instanceof ReadableSqlite
        ? readSqlite(transaction)
        : readMemoryState(transaction as MemoryAuthorityState);
}

function createHarness<Transaction, ReadTransaction>(
    composition: ClosedTenantAuthorityComposition<
        Transaction,
        AuthorityCommandRead,
        ReadTransaction,
        CommandCaller
    >,
    read: () => AuthorityCommandRead,
    setEpoch: (epoch: number) => void,
    failEvidenceAppend: (fail: boolean) => void,
    snapshot: () => AuthorityCommandSnapshot
): AuthorityCommandHarness {
    const caller: CommandCaller = { kind: "actor", actor: sourceActor };
    return {
        caller,
        bindingRequest: () => bindingRequest(),
        checkRequest: (path = read().path, selectedPrincipal = principal) =>
            checkRequest(path, selectedPrincipal),
        permitRequest: (path = read().path) => permitRequest(path),
        envelope: (command, key, payload, selectedCaller = caller, lease) =>
            envelope(command, key, payload, selectedCaller, lease),
        dispatch: (raw, payload, transport = caller) =>
            composition.dispatch(raw, transport, payload),
        setEpoch,
        failEvidenceAppend,
        snapshot
    };
}

class FailingProtocolPersistence<Transaction> implements ProtocolPersistence<Transaction> {
    public constructor(
        private readonly delegate: ProtocolPersistence<Transaction>,
        private readonly failWrite: () => boolean
    ) {}

    public repair(transaction: Transaction): void {
        this.delegate.repair?.(transaction);
    }

    public findWrite(transaction: Transaction, identity: CommandIdentity) {
        return this.delegate.findWrite(transaction, identity);
    }

    public findAudit(transaction: Transaction, id: AuditRecordId) {
        return this.delegate.findAudit(transaction, id);
    }

    public appendAudit(...args: Parameters<ProtocolPersistence<Transaction>["appendAudit"]>): void {
        this.delegate.appendAudit(...args);
    }

    public appendWrite(...args: Parameters<ProtocolPersistence<Transaction>["appendWrite"]>): void {
        if (this.failWrite()) throw new TypeError("Injected authority evidence append failure");
        this.delegate.appendWrite(...args);
    }
}

function bindingRequest(): BindingValidationRequest {
    return new BindingValidationRequest({
        ownerTenant: tenant,
        workspaceActor: sourceActor,
        workspaceFence: 7,
        scope: workspaceScope,
        domain,
        name: bindingName,
        grantId: grant,
        facet,
        nonce: "binding-validation"
    });
}

function checkRequest(
    path: PathEpochEvidence,
    selectedPrincipal: PrincipalRef
): AuthorityCheckRequest {
    const argumentsValue = { channel: "internal" } as const;
    return new AuthorityCheckRequest({
        ownerTenant: tenant,
        owner: sourceActor,
        ownerFence: 7,
        principal: selectedPrincipal,
        binding,
        intent: {
            facet,
            operation: "send",
            impact: "externalSend",
            arguments: argumentsValue,
            argumentsDigest: Digest.sha256(encodeCanonicalJson(argumentsValue))
        },
        expectedPath: path,
        invocationDigest: digest("authority-command-invocation"),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: "authority-check"
    });
}

function permitRequest(
    path: PathEpochEvidence,
    lease?: AuthorityPermitExpectation["lease"]
): AuthorityPermitIssuanceRequest {
    const invocation = new AuthorityInvocationId("authority-command-permit-invocation");
    const itemKey = "authority-command-item";
    const expectation = new AuthorityPermitExpectation({
        tenant,
        issuer: tenantActor,
        source: sourceActor,
        target: { actor: targetActor, fence: 3, domain },
        principal,
        binding: { name: bindingName, generation: new Revision(binding.generation) },
        facet,
        operation: new OperationRef("mail:send"),
        package: new PackagePin(
            new PackageId("authority-command-package"),
            new SemVer("1.0.0"),
            digest("authority-command-manifest"),
            digest("authority-command-code")
        ),
        impact: "externalSend",
        invocation,
        reservation: {
            run: new RunId("authority-command-run"),
            registryEpoch: 2,
            obligation: { kind: "invocationItem", invocation, itemIndex: 0, itemKey }
        },
        itemIndex: 0,
        attemptOrdinal: 0,
        claim: new ItemClaimId("authority-command-claim"),
        claimOwner: {
            kind: "system",
            actor: targetActor,
            worker: new ClaimWorkerId("authority-command-worker")
        },
        itemKey,
        argumentsDigest: digest("authority-command-arguments"),
        intentDigest: digest("authority-command-intent"),
        pathEpochs: path,
        authority: { kind: "initiator", principal, binding: bindingName },
        ...(lease === undefined ? {} : { lease })
    });
    return new AuthorityPermitIssuanceRequest(
        expectation,
        "authority-command-permit",
        new Date(now.getTime() + 5_000)
    );
}

function validationEvidence(
    request: BindingValidationRequest,
    at: Date
): BindingValidationEvidence {
    return new BindingValidationEvidence(
        tenant,
        tenantActor,
        request.digest(),
        workspaceScope,
        binding.subject,
        grant,
        currentPath(1),
        at
    );
}

function checkEvidence(
    request: AuthorityCheckRequest,
    path: PathEpochEvidence,
    at: Date
): AuthorityCheckEvidence {
    const stale = !request.expectedPath.equals(path);
    return new AuthorityCheckEvidence(
        tenant,
        tenantActor,
        request.digest(),
        binding.key,
        binding.generation,
        stale ? "deny" : "allow",
        stale ? "stalePath" : "allowed",
        stale ? [] : [grant],
        [],
        path,
        at
    );
}

function permitFor(request: AuthorityPermitIssuanceRequest, at: Date): AuthorityPermit {
    return new AuthorityPermit({
        ...request.expectation,
        nonce: request.nonce,
        issuedAt: at,
        expiresAt: request.expiresAt
    });
}

function envelope(
    command: string,
    key: string,
    payload: Uint8Array,
    caller: CommandCaller,
    lease?: NonNullable<CommandEnvelope["lease"]>
): Uint8Array {
    const payloadDigest = Digest.sha256(payload);
    return CommandEnvelopeCodec.encode(
        new CommandEnvelope({
            command,
            caller,
            idempotencyKey: key,
            payload: ContentRef.fromDigest(payloadDigest),
            payloadDigest,
            ...(lease === undefined ? {} : { lease })
        })
    );
}

function currentPath(epoch: number): PathEpochEvidence {
    return new PathEpochEvidence([
        ScopeEpoch.initial(ScopeRef.tenant(tenant)),
        new ScopeEpoch(workspaceScope, epoch)
    ]);
}

function readMemory(store: MemoryActorStore<MemoryAuthorityState>): AuthorityCommandRead {
    return readMemoryState(store.snapshot().state);
}

function readMemoryState(state: MemoryAuthorityState): AuthorityCommandRead {
    return Object.freeze({
        fence: state.fence,
        principal: new PrincipalRef(tenant, state.principal),
        path: currentPath(state.epoch)
    });
}

function cloneMemoryState(state: MemoryAuthorityState): MemoryAuthorityState {
    return {
        ...state,
        records: state.records.clone(),
        principal: new PrincipalId(state.principal.value),
        permits: Object.fromEntries(
            Object.entries(state.permits).map(([nonce, bytes]) => [nonce, bytes.slice()])
        )
    };
}

function readSqlite(database: ReadableSqlite): AuthorityCommandRead {
    const row = database.all(
        "SELECT * FROM authority_command_test_state WHERE singleton = 1",
        []
    )[0]!;
    return Object.freeze({
        fence: number(row["fence"]),
        principal: new PrincipalRef(tenant, new PrincipalId(text(row["principal"]))),
        path: currentPath(number(row["epoch"]))
    });
}

function nextMemoryId(state: MemoryAuthorityState): number {
    state.nextId += 1;
    return state.nextId;
}

function nextSqliteId(database: TransactionalSqlite): number {
    database.run(
        "UPDATE authority_command_test_ids SET next_id = next_id + 1 WHERE singleton = 1",
        []
    );
    return integer(database, "SELECT next_id AS value FROM authority_command_test_ids");
}

function count(database: ReadableSqlite, table: string): number {
    return integer(database, `SELECT COUNT(*) AS value FROM ${table}`);
}

function integer(database: ReadableSqlite, statement: string): number {
    return number(database.all(statement, [])[0]?.["value"]);
}

function number(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value))
        throw new TypeError("Expected integer");
    return value;
}

function text(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("Expected text");
    return value;
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

function duplicatePermit(): AgentCoreError {
    return new AgentCoreError("authority.denied", "Authority permit nonce was already issued");
}

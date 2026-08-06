import { ActorId, ActorRef, MemoryActorStore } from "../../../src/actors";
import { RunId, TurnId } from "../../../src/agents";
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
} from "../../../src/authority";
import {
    createClosedTenantAuthorityComposition,
    type ClosedTenantAuthorityComposition
} from "../../../src/composition";
import { ContentRef, Digest, Revision, SemVer, encodeCanonicalJson } from "../../../src/core";
import { PackageId, PackagePin } from "../../../src/definition";
import { BindingName, FacetRef, OperationRef, ProtectionDomain } from "../../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../../src/identity";
import { InvocationId as InteractionInvocationId } from "../../../src/interaction-references";
import { ClaimWorkerId, ItemClaimId } from "../../../src/invocation-references";
import { AuditRecordId, CorrelationId, InvocationId, WriteRecordId } from "../../../src/invocations";
import {
    AuthorityPermitIssuanceRequest,
    CommandEnvelope,
    CommandEnvelopeCodec,
    MemoryProtocolPersistence,
    MemoryProtocolRecords,
    type CommandCaller,
    type CommandDispatchResult,
    type CommandIngressResult,
    type CurrentLease
} from "../../../src/protocol";
import {
    ReadableSqlite,
    SqliteActorStore,
    SqliteAuthorityPermitStore,
    SqliteProtocolPersistence,
    TransactionalSqlite
} from "../../../src/substrates";
import { TestSqlite } from "../../helpers/sqlite";
import { CounterAuthenticator, CounterContentStore } from "../../protocol/counter-fixture";

export const JOURNEY_NOW = new Date("2026-08-04T09:00:00.000Z");

export function commandOutcome(result: CommandIngressResult): CommandDispatchResult {
    if (result.kind === "preDispatchFailure") {
        throw new TypeError("Expected a command outcome rather than a pre-dispatch failure");
    }
    return result;
}

export interface AuthorityJourneySnapshot {
    readonly writes: number;
    readonly audits: number;
    readonly permits: number;
    readonly checks: number;
}

export interface CheckRequestOverrides {
    readonly ownerTenant?: TenantId;
}

/**
 * One Tenant's closed authority composition over one substrate: the real dispatcher,
 * ingress, authenticator, transient content access, and permit storage.
 */
export interface AuthorityJourney {
    readonly tenantActor: ActorRef;
    readonly principal: PrincipalRef;
    readonly caller: CommandCaller;
    bindingRequest(): BindingValidationRequest;
    checkRequest(overrides?: CheckRequestOverrides): AuthorityCheckRequest;
    permitRequest(): AuthorityPermitIssuanceRequest;
    envelope(command: string, key: string, payload: Uint8Array, caller?: CommandCaller): Uint8Array;
    dispatch(
        raw: Uint8Array,
        payload: Uint8Array,
        caller?: CommandCaller
    ): Promise<CommandDispatchResult>;
    snapshot(): AuthorityJourneySnapshot;
}

export type AuthorityJourneyFactory = (name: string) => AuthorityJourney;

export const authorityJourneySubstrates: readonly (readonly [string, AuthorityJourneyFactory])[] =
    Object.freeze([
        ["memory", createMemoryAuthorityJourney],
        ["SQLite", createSqliteAuthorityJourney]
    ] as const);

interface AuthorityJourneyRead {
    readonly fence: number;
    readonly principal: PrincipalRef;
    readonly path: PathEpochEvidence;
}

interface MemoryAuthorityJourneyState {
    records: MemoryProtocolRecords;
    nextId: number;
    checks: number;
    permits: Record<string, Uint8Array>;
}

const SOURCE_FENCE = 7;

/** Every value one Tenant's journey is expressed in, and the evidence it expects back. */
class AuthorityJourneyIdentity {
    public readonly tenant: TenantId;
    public readonly tenantActor: ActorRef;
    public readonly sourceActor: ActorRef;
    public readonly targetActor: ActorRef;
    public readonly principal: PrincipalRef;
    public readonly caller: CommandCaller;
    public readonly scope: ScopeRef;
    public readonly binding: Binding;
    public readonly grant: GrantId;
    public readonly turn: TurnId;
    public readonly bindingName = new BindingName("mail");
    public readonly facet = new FacetRef("workspace:mail");
    public readonly domain = new ProtectionDomain("backend", "journey", "may-hold-secrets");

    public constructor(public readonly name: string) {
        this.tenant = new TenantId(`${name}-tenant`);
        this.tenantActor = new ActorRef("tenant", new ActorId(`${name}-tenant`));
        this.sourceActor = new ActorRef("workspace", new ActorId(`${name}-source`));
        this.targetActor = new ActorRef("run", new ActorId(`${name}-target`));
        this.principal = new PrincipalRef(this.tenant, new PrincipalId(`${name}-principal`));
        this.caller = { kind: "actor", actor: this.sourceActor };
        this.scope = ScopeRef.workspace(this.tenant, new WorkspaceId(`${name}-workspace`));
        this.grant = new GrantId(`${name}-grant`);
        this.turn = new TurnId(`${name}-turn`);
        this.binding = Binding.active(
            this.scope,
            SubjectRef.principal(this.principal.principalId),
            this.domain,
            this.bindingName,
            this.grant,
            this.facet
        );
    }

    public path(): PathEpochEvidence {
        return new PathEpochEvidence([
            ScopeEpoch.initial(ScopeRef.tenant(this.tenant)),
            ScopeEpoch.initial(this.scope)
        ]);
    }

    public read(): AuthorityJourneyRead {
        return Object.freeze({
            fence: SOURCE_FENCE,
            principal: this.principal,
            path: this.path()
        });
    }

    /** The substrate-independent half of the command backend: pure decisions over a read. */
    public readBackend() {
        const lease = (at: Date): CurrentLease => ({
            turn: this.turn,
            holder: this.principal,
            epoch: 2,
            expiresAt: new Date(at.getTime() + 5_000)
        });
        return {
            sourceFence: (read: AuthorityJourneyRead, source: ActorRef) =>
                source.equals(this.sourceActor) ? read.fence : undefined,
            checkPrincipal: (read: AuthorityJourneyRead) => read.principal,
            permitPrincipal: (read: AuthorityJourneyRead) => read.principal,
            permitsPermit: (read: AuthorityJourneyRead, request: AuthorityPermitIssuanceRequest) =>
                request.expectation.pathEpochs.equals(read.path),
            currentCheckLease: (
                _read: AuthorityJourneyRead,
                _request: AuthorityCheckRequest,
                at: Date
            ) => lease(at),
            currentPermitLease: (
                _read: AuthorityJourneyRead,
                _request: AuthorityPermitIssuanceRequest,
                at: Date
            ) => lease(at)
        };
    }

    public bindingRequest(): BindingValidationRequest {
        return new BindingValidationRequest({
            ownerTenant: this.tenant,
            workspaceActor: this.sourceActor,
            workspaceFence: SOURCE_FENCE,
            scope: this.scope,
            domain: this.domain,
            name: this.bindingName,
            grantId: this.grant,
            facet: this.facet,
            nonce: `${this.name}-binding`
        });
    }

    public checkRequest(overrides: CheckRequestOverrides = {}): AuthorityCheckRequest {
        const argumentsValue = { channel: "internal" } as const;
        return new AuthorityCheckRequest({
            ownerTenant: overrides.ownerTenant ?? this.tenant,
            owner: this.sourceActor,
            ownerFence: SOURCE_FENCE,
            principal: this.principal,
            binding: this.binding,
            intent: {
                facet: this.facet,
                operation: "send",
                impact: "externalSend",
                arguments: argumentsValue,
                argumentsDigest: Digest.sha256(encodeCanonicalJson(argumentsValue))
            },
            expectedPath: this.path(),
            invocationDigest: journeyDigest(`${this.name}-invocation`),
            itemIndex: 0,
            attemptOrdinal: 0,
            nonce: `${this.name}-check`
        });
    }

    public permitRequest(): AuthorityPermitIssuanceRequest {
        const invocation = new InteractionInvocationId(`${this.name}-permit-invocation`);
        const itemKey = `${this.name}-item`;
        return new AuthorityPermitIssuanceRequest(
            new AuthorityPermitExpectation({
                tenant: this.tenant,
                issuer: this.tenantActor,
                source: this.sourceActor,
                target: { actor: this.targetActor, fence: 3, domain: this.domain },
                principal: this.principal,
                binding: {
                    name: this.bindingName,
                    generation: new Revision(this.binding.generation)
                },
                facet: this.facet,
                operation: new OperationRef("mail:send"),
                package: new PackagePin(
                    new PackageId(`${this.name}-package`),
                    new SemVer("1.0.0"),
                    journeyDigest(`${this.name}-manifest`),
                    journeyDigest(`${this.name}-code`)
                ),
                impact: "externalSend",
                invocation,
                reservation: {
                    run: new RunId(`${this.name}-run`),
                    registryEpoch: 2,
                    obligation: { kind: "invocationItem", invocation, itemIndex: 0, itemKey }
                },
                itemIndex: 0,
                attemptOrdinal: 0,
                claim: new ItemClaimId(`${this.name}-claim`),
                claimOwner: {
                    kind: "system",
                    actor: this.targetActor,
                    worker: new ClaimWorkerId(`${this.name}-worker`)
                },
                itemKey,
                argumentsDigest: journeyDigest(`${this.name}-arguments`),
                intentDigest: journeyDigest(`${this.name}-intent`),
                pathEpochs: this.path(),
                authority: {
                    kind: "initiator",
                    principal: this.principal,
                    binding: this.bindingName
                }
            }),
            `${this.name}-permit`,
            new Date(JOURNEY_NOW.getTime() + 5_000)
        );
    }

    public validationEvidence(
        request: BindingValidationRequest,
        at: Date
    ): BindingValidationEvidence {
        return new BindingValidationEvidence(
            this.tenant,
            this.tenantActor,
            request.digest(),
            this.scope,
            this.binding.subject,
            this.grant,
            this.path(),
            at
        );
    }

    public checkEvidence(request: AuthorityCheckRequest, at: Date): AuthorityCheckEvidence {
        const stale = !request.expectedPath.equals(this.path());
        return new AuthorityCheckEvidence(
            this.tenant,
            this.tenantActor,
            request.digest(),
            this.binding.key,
            this.binding.generation,
            stale ? "deny" : "allow",
            stale ? "stalePath" : "allowed",
            stale ? [] : [this.grant],
            [],
            this.path(),
            at
        );
    }

    public permit(request: AuthorityPermitIssuanceRequest, at: Date): AuthorityPermit {
        return new AuthorityPermit({
            ...request.expectation,
            nonce: request.nonce,
            issuedAt: at,
            expiresAt: request.expiresAt
        });
    }

    public envelope(
        command: string,
        key: string,
        payload: Uint8Array,
        caller: CommandCaller = this.caller
    ): Uint8Array {
        const payloadDigest = Digest.sha256(payload);
        return CommandEnvelopeCodec.encode(
            new CommandEnvelope({
                command,
                caller,
                idempotencyKey: key,
                payload: ContentRef.fromDigest(payloadDigest),
                payloadDigest
            })
        );
    }
}

function createMemoryAuthorityJourney(name: string): AuthorityJourney {
    const identity = new AuthorityJourneyIdentity(name);
    const store = new MemoryActorStore<MemoryAuthorityJourneyState>(
        { records: new MemoryProtocolRecords(), nextId: 0, checks: 0, permits: {} },
        cloneMemoryState
    );
    const composition = createClosedTenantAuthorityComposition<
        MemoryAuthorityJourneyState,
        AuthorityJourneyRead,
        MemoryAuthorityJourneyState,
        CommandCaller | undefined
    >({
        store,
        persistence: new MemoryProtocolPersistence((state) => state.records),
        backend: {
            ...identity.readBackend(),
            validateBinding: (_state, request, at) => identity.validationEvidence(request, at),
            check: (state, request, at) => {
                state.checks += 1;
                return identity.checkEvidence(request, at);
            },
            issuePermit: (state, request, at) => {
                const permit = identity.permit(request, at);
                state.permits[request.nonce] = AuthorityPermit.encode(permit);
                return permit;
            }
        },
        ids: {
            writeRecordId: (state) => new WriteRecordId(`journey-write-${nextMemoryId(state)}`),
            auditRecordId: (state) => new AuditRecordId(`journey-audit-${nextMemoryId(state)}`),
            invocationId: (state) => new InvocationId(`journey-invocation-${nextMemoryId(state)}`),
            correlationId: (state) =>
                new CorrelationId(`journey-correlation-${nextMemoryId(state)}`)
        },
        actor: identity.tenantActor,
        tenant: identity.tenant,
        readOnly: () => identity.read(),
        limits: { envelopeBytes: 32_768, payloadBytes: 32_768 },
        content: new CounterContentStore(() => undefined),
        authenticator: new CounterAuthenticator(identity.tenant),
        leaseForMilliseconds: 60_000,
        now: () => JOURNEY_NOW
    });

    return createJourney(identity, composition, () => {
        const state = store.snapshot().state;
        const records = state.records.snapshot();
        return {
            writes: records.writes.length,
            audits: records.audits.length,
            permits: Object.keys(state.permits).length,
            checks: state.checks
        };
    });
}

const CREATE_JOURNEY_STATE = `CREATE TABLE authority_journey_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_id INTEGER NOT NULL,
    checks INTEGER NOT NULL
) STRICT`;

function createSqliteAuthorityJourney(name: string): AuthorityJourney {
    const identity = new AuthorityJourneyIdentity(name);
    const database = new TestSqlite();
    database.transaction(() => {
        database.run(CREATE_JOURNEY_STATE, []);
        database.run("INSERT INTO authority_journey_state VALUES (1, 0, 0)", []);
    });
    const permits = new SqliteAuthorityPermitStore(database, identity.tenantActor);
    const composition = createClosedTenantAuthorityComposition<
        TransactionalSqlite,
        AuthorityJourneyRead,
        ReadableSqlite,
        CommandCaller | undefined
    >({
        store: new SqliteActorStore(database),
        persistence: new SqliteProtocolPersistence(database),
        backend: {
            ...identity.readBackend(),
            validateBinding: (_transaction, request, at) => identity.validationEvidence(request, at),
            check: (transaction, request, at) => {
                transaction.run(
                    "UPDATE authority_journey_state SET checks = checks + 1 WHERE singleton = 1",
                    []
                );
                return identity.checkEvidence(request, at);
            },
            issuePermit: (transaction, request, at) => {
                const permit = identity.permit(request, at);
                permits.issue(transaction, permit);
                return permit;
            }
        },
        ids: {
            writeRecordId: (transaction) =>
                new WriteRecordId(`journey-write-${nextSqliteId(transaction)}`),
            auditRecordId: (transaction) =>
                new AuditRecordId(`journey-audit-${nextSqliteId(transaction)}`),
            invocationId: (transaction) =>
                new InvocationId(`journey-invocation-${nextSqliteId(transaction)}`),
            correlationId: (transaction) =>
                new CorrelationId(`journey-correlation-${nextSqliteId(transaction)}`)
        },
        actor: identity.tenantActor,
        tenant: identity.tenant,
        readOnly: () => identity.read(),
        limits: { envelopeBytes: 32_768, payloadBytes: 32_768 },
        content: new CounterContentStore(() => undefined),
        authenticator: new CounterAuthenticator(identity.tenant),
        leaseForMilliseconds: 60_000,
        now: () => JOURNEY_NOW
    });

    return createJourney(identity, composition, () => ({
        writes: sqliteInteger(database, "SELECT COUNT(*) AS value FROM protocol_write_records"),
        audits: sqliteInteger(database, "SELECT COUNT(*) AS value FROM protocol_audit_records"),
        permits: sqliteInteger(database, "SELECT COUNT(*) AS value FROM authority_permit_nonces"),
        checks: sqliteInteger(database, "SELECT checks AS value FROM authority_journey_state")
    }));
}

function createJourney<Transaction, ReadTransaction>(
    identity: AuthorityJourneyIdentity,
    composition: ClosedTenantAuthorityComposition<
        Transaction,
        AuthorityJourneyRead,
        ReadTransaction,
        CommandCaller | undefined
    >,
    snapshot: () => AuthorityJourneySnapshot
): AuthorityJourney {
    return {
        tenantActor: identity.tenantActor,
        principal: identity.principal,
        caller: identity.caller,
        bindingRequest: () => identity.bindingRequest(),
        checkRequest: (overrides) => identity.checkRequest(overrides),
        permitRequest: () => identity.permitRequest(),
        envelope: (command, key, payload, caller) =>
            identity.envelope(command, key, payload, caller),
        dispatch: (raw, payload, caller = identity.caller) =>
            composition.dispatch(raw, caller, payload),
        snapshot
    };
}

function nextMemoryId(state: MemoryAuthorityJourneyState): number {
    state.nextId += 1;
    return state.nextId;
}

function nextSqliteId(transaction: TransactionalSqlite): number {
    transaction.run(
        "UPDATE authority_journey_state SET next_id = next_id + 1 WHERE singleton = 1",
        []
    );
    return sqliteInteger(transaction, "SELECT next_id AS value FROM authority_journey_state");
}

function cloneMemoryState(state: MemoryAuthorityJourneyState): MemoryAuthorityJourneyState {
    return {
        records: state.records.clone(),
        nextId: state.nextId,
        checks: state.checks,
        permits: Object.fromEntries(
            Object.entries(state.permits).map(([nonce, bytes]) => [nonce, bytes.slice()])
        )
    };
}

function sqliteInteger(database: ReadableSqlite, statement: string): number {
    const value = database.all(statement, [])[0]?.["value"];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TypeError("Expected an integer column");
    }
    return value;
}

function journeyDigest(label: string): Digest {
    return Digest.sha256(new TextEncoder().encode(label));
}

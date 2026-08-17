import { ActorId, ActorRef, MemoryActorStore, type ActorLocalStore } from "../../src/actors";
import { TurnId } from "../../src/agents";
import {
    ContentRef,
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isMember,
    jsonDataParser,
    type JsonValue
} from "../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    AuditRecord,
    AuditRecordCodec,
    AuditRecordId,
    CorrelationId,
    InvocationId
} from "../../src/invocations";
import {
    CommandDispatcher,
    type CommandDispatcherInit,
    type CurrentLease,
    type ProtocolPersistence,
    type RegisteredProtocolCommand
} from "../../src/protocol/dispatcher";
import {
    CommandEnvelope,
    CommandEnvelopeCodec,
    type CommandCaller,
    type CommandEnvelopeInit,
    type LeaseToken
} from "../../src/protocol/envelope";
import {
    CommandIngress,
    type CommandIngressInit,
    type CommandIngressResult
} from "../../src/protocol/ingress";
import { MemoryProtocolPersistence, MemoryProtocolRecords } from "../../src/protocol/memory";
import { CommandPayloadMalformedError } from "../../src/protocol/payload";
import { CommandCallerPolicy } from "../../src/protocol/policy";
import type {
    ExpectedRevisionPolicy,
    LeaseTokenPolicy,
    ProtocolCommand,
    ProtocolCommandExecution,
    ProtocolValueCodec
} from "../../src/protocol/registration";
import { WriteRecordCodec, type CommandOutcome, type WriteRecord } from "../../src/protocol/write";
import {
    SqliteActorStore,
    SqliteProtocolPersistence,
    type ReadableSqlite,
    type SqliteRow,
    type SqliteValue,
    type TransactionalSqlite
} from "../../src/substrates";
import { TestSqlite } from "../helpers/sqlite";
import {
    CounterAuthenticator,
    CounterContentStore,
    CounterIds,
    FaultingCounterPersistence,
    faultBoundaries,
    type FaultBoundary
} from "./counter-fixture";

/**
 * The two hosts a Tenant-decision traversal must decide identically on: the memory
 * `ActorLocalStore`/`ProtocolPersistence` composition and the SQLite one. Kept as a value so a
 * case matrix can name both without restating the seam pair at every call.
 */
export const decisionHostLabels = ["memory", "sqlite"] as const;

export type DecisionHostLabel = (typeof decisionHostLabels)[number];

export const decisionPathTenant = new TenantId("decision-tenant");
export const decisionPathNow = new Date("2026-08-17T09:00:00.000Z");
const decisionLeaseExpiry = new Date("2026-08-17T09:05:00.000Z");

/** The Tenant Actor that owns every permit decision. No other Actor stores one. */
export const authorityActor = new ActorRef("tenant", new ActorId("tenant-authority"));
/** The Run Actor that owns every applied effect. No other Actor stores one. */
export const targetActor = new ActorRef("run", new ActorId("decision-target"));

export const permitDecisionCommand = "tenant.decidePermit";
export const applyEffectCommand = "target.applyEffect";

/** The record the Tenant Actor owns. Nothing else can hold a permit decision. */
export interface PermitDecisionRecord {
    readonly kind: "permitDecision";
    readonly id: string;
    readonly permit: string;
    readonly granted: boolean;
}

/**
 * The record the Run Actor owns. It names the decision that authorized it and CANNOT
 * represent that decision's answer: there is no `granted` on this shape, so §8.4's "no second
 * durable copy" is unrepresentable here rather than asserted by a test. That also removes a
 * constant from the evidence — a `granted: true` written by the fixture could not have failed
 * under any mutation of the dispatcher, so asserting it witnessed nothing.
 */
export interface AppliedEffectRecord {
    readonly kind: "appliedEffect";
    readonly id: string;
    readonly permit: string;
    readonly origin: string;
}

/** One record as its owning Actor holds it, discriminated by which Actor owns it. */
export type OwnedRecord = PermitDecisionRecord | AppliedEffectRecord;

/**
 * A record before its owning Actor mints the id. Written as an explicit union of omissions
 * rather than `Omit<OwnedRecord, "id">`, because Omit over a union keeps only the keys both
 * members share — which would erase the very distinction these two shapes exist to make.
 */
export type NewOwnedRecord = Omit<PermitDecisionRecord, "id"> | Omit<AppliedEffectRecord, "id">;

export interface EvidenceView {
    readonly writes: readonly WriteRecord[];
    readonly audits: readonly AuditRecord[];
}

export interface DomainRead {
    readonly open: boolean;
    readonly lifecycle: boolean;
    readonly revision: Revision;
    readonly lease: CurrentLease | undefined;
}

interface DomainOperations<Transaction> {
    append(
        transaction: Transaction,
        prefix: string,
        row: NewOwnedRecord
    ): { readonly id: string; readonly revision: Revision };
}

export interface LeaseInit {
    readonly turn?: string;
    readonly holder?: PrincipalId;
    readonly epoch?: number;
    readonly expiresAt?: Date;
}

/**
 * One Actor of the traversal, holding its own transaction domain. The pair is deliberately
 * given no shared transaction value, so no caller can express a cross-Actor transaction even
 * by accident: the driver can only sequence one committed decision before the next command.
 */
export interface DecisionPathActor {
    readonly actor: ActorRef;
    readonly tenant: TenantId;

    accept(raw: Uint8Array, caller: CommandCaller | undefined): Promise<CommandIngressResult>;
    revision(): Revision;
    ownedRecords(): readonly OwnedRecord[];
    evidence(): EvidenceView;
    /** Replays the whole stored record graph, the way Actor recovery does. */
    verifyRecordGraph(): void;
    seedInvocationCause(id: string, actor?: ActorRef): AuditRecord;
    installPayload(bytes: Uint8Array): ContentRef;
    setOpen(open: boolean): void;
    setLifecycle(lifecycle: boolean): void;
    setFault(fault: FaultBoundary | undefined): void;
    setLease(init?: LeaseInit): LeaseToken;
}

// ---------------------------------------------------------------------------
// Command families
// ---------------------------------------------------------------------------

interface PermitDecisionPayload {
    readonly grant: boolean;
    readonly permit: string;
}

export interface PermitDecisionReply {
    readonly decision: string;
    readonly granted: boolean;
}

export interface BridgedDecision {
    readonly decision: string;
    readonly granted: boolean;
    readonly permit: string;
}

interface AppliedEffectPayload {
    readonly decision: string;
    readonly grant: boolean;
    readonly permit: string;
}

export interface AppliedEffectReply {
    readonly effect: string;
    readonly permit: string;
}

/**
 * The Tenant Actor's family. `expectedRevision` is required and a LeaseToken is forbidden: a
 * Tenant policy decision is not Turn-owned, so a supplied token is a token-policy violation
 * rather than an unexpected field.
 */
class PermitDecisionCommand<Transaction> implements ProtocolCommand<
    Transaction,
    DomainRead,
    PermitDecisionPayload,
    PermitDecisionReply,
    BridgedDecision
> {
    public readonly command = permitDecisionCommand;
    public readonly caller = CommandCallerPolicy.principal();
    public readonly expectedRevision: ExpectedRevisionPolicy = "required";
    public readonly lease: LeaseTokenPolicy = "forbidden";
    public readonly payload = new PermitDecisionPayloadCodec();
    public readonly replyCodec = permitDecisionReplyCodec;
    public readonly observationCodec = bridgedDecisionCodec;

    public constructor(private readonly operations: DomainOperations<Transaction>) {}

    public authorize(read: DomainRead): boolean {
        return read.open;
    }

    public permitsLifecycle(read: DomainRead): boolean {
        return read.lifecycle;
    }

    public currentRevision(read: DomainRead): Revision {
        return read.revision;
    }

    public currentLease(read: DomainRead): CurrentLease | undefined {
        return read.lease;
    }

    public execute(
        transaction: Transaction,
        _envelope: CommandEnvelope,
        payload: PermitDecisionPayload
    ): ProtocolCommandExecution<PermitDecisionReply, BridgedDecision> {
        const appended = this.operations.append(transaction, "decision", {
            kind: "permitDecision",
            permit: payload.permit,
            granted: payload.grant
        });
        return {
            outcome: "committed",
            reply: { decision: appended.id, granted: payload.grant },
            observation: {
                decision: appended.id,
                granted: payload.grant,
                permit: payload.permit
            }
        };
    }
}

/**
 * The Run Actor's family. `expectedRevision` is required and a LeaseToken is required: the
 * effect is Turn-owned, so a command that acts without the exact current lease is
 * `rejectedLease`. Only a Tenant Actor may call it, which is what makes the bridged delivery a
 * cross-Actor command rather than a second principal request.
 */
class AppliedEffectCommand<Transaction> implements ProtocolCommand<
    Transaction,
    DomainRead,
    AppliedEffectPayload,
    AppliedEffectReply,
    never
> {
    public readonly command = applyEffectCommand;
    public readonly caller = CommandCallerPolicy.actor("tenant");
    public readonly expectedRevision: ExpectedRevisionPolicy = "required";
    public readonly lease: LeaseTokenPolicy = "required";
    public readonly payload = new AppliedEffectPayloadCodec();
    public readonly replyCodec = appliedEffectReplyCodec;

    public constructor(private readonly operations: DomainOperations<Transaction>) {}

    /** A denied Tenant decision is refused here, before any effect exists. */
    public authorize(
        read: DomainRead,
        _envelope: CommandEnvelope,
        payload: AppliedEffectPayload
    ): boolean {
        return read.open && payload.grant;
    }

    public permitsLifecycle(read: DomainRead): boolean {
        return read.lifecycle;
    }

    public currentRevision(read: DomainRead): Revision {
        return read.revision;
    }

    public currentLease(read: DomainRead): CurrentLease | undefined {
        return read.lease;
    }

    public execute(
        transaction: Transaction,
        _envelope: CommandEnvelope,
        payload: AppliedEffectPayload
    ): ProtocolCommandExecution<AppliedEffectReply, never> {
        const appended = this.operations.append(transaction, "effect", {
            kind: "appliedEffect",
            permit: payload.permit,
            origin: payload.decision
        });
        return { outcome: "committed", reply: { effect: appended.id, permit: payload.permit } };
    }
}

const parsePayload = jsonDataParser((message) => new CommandPayloadMalformedError(message));
const parseValue = jsonDataParser((message) => new TypeError(message));

class PermitDecisionPayloadCodec {
    public decode(bytes: Uint8Array): PermitDecisionPayload {
        const object = parsePayload.exact(
            parsePayload.object(decodePayloadJson(bytes), "Permit decision payload"),
            ["grant", "permit"],
            "Permit decision payload"
        );
        return {
            grant: parsePayload.boolean(object["grant"], "Permit decision grant"),
            permit: parsePayload.nonemptyString(object["permit"], "Permit decision permit")
        };
    }
}

class AppliedEffectPayloadCodec {
    public decode(bytes: Uint8Array): AppliedEffectPayload {
        const object = parsePayload.exact(
            parsePayload.object(decodePayloadJson(bytes), "Applied effect payload"),
            ["decision", "grant", "permit"],
            "Applied effect payload"
        );
        return {
            decision: parsePayload.nonemptyString(object["decision"], "Applied effect decision"),
            grant: parsePayload.boolean(object["grant"], "Applied effect grant"),
            permit: parsePayload.nonemptyString(object["permit"], "Applied effect permit")
        };
    }
}

function decodePayloadJson(bytes: Uint8Array): JsonValue {
    try {
        return decodeCanonicalJson(bytes);
    } catch {
        throw new CommandPayloadMalformedError("Command payload is not canonical JSON");
    }
}

const permitDecisionReplyCodec: ProtocolValueCodec<PermitDecisionReply> = {
    encode: (value) => encodeCanonicalJson({ decision: value.decision, granted: value.granted }),
    decode: (bytes) => {
        const object = parseValue.exact(
            parseValue.object(decodeCanonicalJson(bytes), "Permit decision reply"),
            ["decision", "granted"],
            "Permit decision reply"
        );
        return {
            decision: parseValue.nonemptyString(object["decision"], "Permit decision id"),
            granted: parseValue.boolean(object["granted"], "Permit decision grant")
        };
    }
};

const bridgedDecisionCodec: ProtocolValueCodec<BridgedDecision> = {
    encode: (value) =>
        encodeCanonicalJson({
            decision: value.decision,
            granted: value.granted,
            permit: value.permit
        }),
    decode: (bytes) => {
        const object = parseValue.exact(
            parseValue.object(decodeCanonicalJson(bytes), "Bridged decision observation"),
            ["decision", "granted", "permit"],
            "Bridged decision observation"
        );
        return {
            decision: parseValue.nonemptyString(object["decision"], "Bridged decision id"),
            granted: parseValue.boolean(object["granted"], "Bridged decision grant"),
            permit: parseValue.nonemptyString(object["permit"], "Bridged decision permit")
        };
    }
};

const appliedEffectReplyCodec: ProtocolValueCodec<AppliedEffectReply> = {
    encode: (value) => encodeCanonicalJson({ effect: value.effect, permit: value.permit }),
    decode: (bytes) => {
        const object = parseValue.exact(
            parseValue.object(decodeCanonicalJson(bytes), "Applied effect reply"),
            ["effect", "permit"],
            "Applied effect reply"
        );
        return {
            effect: parseValue.nonemptyString(object["effect"], "Applied effect id"),
            permit: parseValue.nonemptyString(object["permit"], "Applied effect permit")
        };
    }
};

export function decodeBridgedDecision(bytes: Uint8Array): BridgedDecision {
    return bridgedDecisionCodec.decode(bytes);
}

export function decodeAppliedEffectReply(bytes: Uint8Array): AppliedEffectReply {
    return appliedEffectReplyCodec.decode(bytes);
}

export function decodePermitDecisionReply(bytes: Uint8Array): PermitDecisionReply {
    return permitDecisionReplyCodec.decode(bytes);
}

type DecisionCommandFactory<Transaction> = (
    operations: DomainOperations<Transaction>
) => RegisteredProtocolCommand<Transaction, DomainRead>;

// ---------------------------------------------------------------------------
// Memory host
// ---------------------------------------------------------------------------

/**
 * The memory Actor state graph admits only TextId-shaped value objects, so the holder is held
 * as its two ids rather than as a PrincipalRef and recomposed on read.
 */
interface StoredLease {
    readonly turn: TurnId;
    readonly holderTenant: TenantId | undefined;
    readonly holder: PrincipalId | undefined;
    readonly epoch: number;
    readonly expiresAt: Date | undefined;
}

interface MemoryDomainState {
    revision: Revision;
    open: boolean;
    lifecycle: boolean;
    lease: StoredLease | undefined;
    rows: OwnedRecord[];
    records: MemoryProtocolRecords;
    nextId: number;
    fault: FaultBoundary | undefined;
}

function initialMemoryState(): MemoryDomainState {
    return {
        revision: Revision.initial(),
        open: true,
        lifecycle: true,
        lease: undefined,
        rows: [],
        records: new MemoryProtocolRecords(),
        nextId: 0,
        fault: undefined
    };
}

function cloneMemoryState(state: MemoryDomainState): MemoryDomainState {
    return {
        ...state,
        rows: state.rows.map((row) => ({ ...row })),
        records: state.records.clone(),
        lease:
            state.lease === undefined
                ? undefined
                : {
                      turn: new TurnId(state.lease.turn.value),
                      holderTenant:
                          state.lease.holderTenant === undefined
                              ? undefined
                              : new TenantId(state.lease.holderTenant.value),
                      holder:
                          state.lease.holder === undefined
                              ? undefined
                              : new PrincipalId(state.lease.holder.value),
                      epoch: state.lease.epoch,
                      expiresAt:
                          state.lease.expiresAt === undefined
                              ? undefined
                              : new Date(state.lease.expiresAt)
                  }
    };
}

function memoryDomainRead(transaction: MemoryDomainState): DomainRead {
    return Object.freeze({
        open: transaction.open,
        lifecycle: transaction.lifecycle,
        revision: transaction.revision,
        lease:
            transaction.lease === undefined
                ? undefined
                : Object.freeze({
                      turn: transaction.lease.turn,
                      holder:
                          transaction.lease.holderTenant === undefined ||
                          transaction.lease.holder === undefined
                              ? undefined
                              : new PrincipalRef(
                                    transaction.lease.holderTenant,
                                    transaction.lease.holder
                                ),
                      epoch: transaction.lease.epoch,
                      expiresAt:
                          transaction.lease.expiresAt === undefined
                              ? undefined
                              : new Date(transaction.lease.expiresAt)
                  })
    });
}

const memoryOperations: DomainOperations<MemoryDomainState> = {
    append(transaction, prefix, row) {
        const id = memoryNextId(transaction, prefix);
        transaction.rows.push(row.kind === "permitDecision" ? { ...row, id } : { ...row, id });
        transaction.revision = transaction.revision.next();
        failAt(transaction.fault, "mutation");
        return { id, revision: transaction.revision };
    }
};

function memoryNextId(transaction: MemoryDomainState, prefix: string): string {
    transaction.nextId += 1;
    return `${prefix}-${transaction.nextId}`;
}

class MemoryDecisionActor implements DecisionPathActor {
    public readonly tenant = decisionPathTenant;
    readonly #store: MemoryActorStore<MemoryDomainState>;
    readonly #persistence: ProtocolPersistence<MemoryDomainState>;
    readonly #content: CounterContentStore;
    readonly #ingress: CommandIngress<
        MemoryDomainState,
        DomainRead,
        MemoryDomainState,
        CommandCaller | undefined
    >;

    public constructor(
        public readonly actor: ActorRef,
        command: DecisionCommandFactory<MemoryDomainState>
    ) {
        this.#store = new MemoryActorStore(initialMemoryState(), cloneMemoryState);
        this.#persistence = new FaultingCounterPersistence(
            new MemoryProtocolPersistence((transaction: MemoryDomainState) => transaction.records),
            (transaction) => transaction.fault
        );
        this.#content = new CounterContentStore(() => this.state().fault);
        const dispatch: CommandDispatcherInit<MemoryDomainState, DomainRead> = {
            store: this.#store,
            persistence: this.#persistence,
            ids: new CounterIds(memoryNextId),
            actor,
            tenant: this.tenant,
            readOnly: memoryDomainRead,
            commands: [command(memoryOperations)],
            limits: { envelopeBytes: 4096, payloadBytes: 1024 },
            now: () => decisionPathNow
        };
        const accept: CommandIngressInit<
            MemoryDomainState,
            DomainRead,
            MemoryDomainState,
            CommandCaller | undefined
        > = {
            dispatcher: new CommandDispatcher(dispatch),
            content: this.#content,
            authenticator: new CounterAuthenticator(this.tenant),
            leaseForMilliseconds: 60_000,
            now: () => decisionPathNow
        };
        this.#ingress = new CommandIngress(accept);
    }

    public accept(
        raw: Uint8Array,
        caller: CommandCaller | undefined
    ): Promise<CommandIngressResult> {
        return this.#ingress.accept(raw, caller);
    }

    public revision(): Revision {
        return this.state().revision;
    }

    public ownedRecords(): readonly OwnedRecord[] {
        return this.state().rows.map((row) => ({ ...row }));
    }

    public evidence(): EvidenceView {
        const snapshot = this.state().records.snapshot();
        return {
            writes: snapshot.writes.map((stored) => WriteRecordCodec.decode(stored.bytes)),
            audits: snapshot.audits.map((stored) => AuditRecordCodec.decode(stored.bytes))
        };
    }

    public verifyRecordGraph(): void {
        this.#store.transaction((transaction) => {
            this.#persistence.repair?.(transaction);
        });
    }

    public seedInvocationCause(id: string, actor?: ActorRef): AuditRecord {
        const record = invocationCause(id, actor ?? this.actor, this.tenant);
        this.#store.transaction((transaction) => {
            this.#persistence.appendAudit(transaction, record);
        });
        return record;
    }

    public installPayload(bytes: Uint8Array): ContentRef {
        const ref = ContentRef.fromDigest(Digest.sha256(bytes));
        this.#content.install(ref.value, bytes);
        return ref;
    }

    public setOpen(open: boolean): void {
        this.#store.transaction((transaction) => {
            transaction.open = open;
        });
    }

    public setLifecycle(lifecycle: boolean): void {
        this.#store.transaction((transaction) => {
            transaction.lifecycle = lifecycle;
        });
    }

    public setFault(fault: FaultBoundary | undefined): void {
        this.#store.transaction((transaction) => {
            transaction.fault = fault;
        });
    }

    public setLease(init: LeaseInit = {}): LeaseToken {
        const token = leaseTokenFor(this.tenant, init);
        this.#store.transaction((transaction) => {
            transaction.lease = {
                turn: token.turn,
                holderTenant: token.holder.tenantId,
                holder: token.holder.principalId,
                epoch: token.epoch,
                expiresAt: init.expiresAt ?? decisionLeaseExpiry
            };
        });
        return token;
    }

    private state(): MemoryDomainState {
        return this.#store.snapshot().state;
    }
}

// ---------------------------------------------------------------------------
// SQLite host
// ---------------------------------------------------------------------------

const CREATE_DOMAIN = `CREATE TABLE IF NOT EXISTS decision_domain (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL,
    open INTEGER NOT NULL,
    lifecycle INTEGER NOT NULL,
    lease_turn TEXT,
    lease_holder_tenant TEXT,
    lease_holder TEXT,
    lease_epoch INTEGER,
    lease_expires_at INTEGER,
    next_id INTEGER NOT NULL,
    fault TEXT
)`;

const CREATE_OWNED_RECORDS = `CREATE TABLE IF NOT EXISTS decision_owned_records (
    id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL,
    permit TEXT NOT NULL,
    origin TEXT,
    granted INTEGER NOT NULL
)`;

const sqliteOperations: DomainOperations<TransactionalSqlite> = {
    append(transaction, prefix, row) {
        const id = sqliteNextId(transaction, prefix);
        const ordinal = integerColumn(
            singletonRow(transaction, `SELECT COUNT(*) AS total FROM decision_owned_records`),
            "total"
        );
        transaction.run(
            `INSERT INTO decision_owned_records (id, ordinal, permit, origin, granted)
             VALUES (?, ?, ?, ?, ?)`,
            [
                id,
                ordinal,
                row.permit,
                row.kind === "appliedEffect" ? row.origin : null,
                row.kind === "permitDecision" && row.granted ? 1 : 0
            ]
        );
        const revision = sqliteRevision(transaction).next();
        transaction.run(`UPDATE decision_domain SET revision = ? WHERE singleton = 1`, [
            revision.value
        ]);
        failAt(sqliteFault(transaction), "mutation");
        return { id, revision };
    }
};

function sqliteDomainRead(transaction: ReadableSqlite): DomainRead {
    const row = singletonRow(transaction, `SELECT * FROM decision_domain WHERE singleton = 1`);
    const turn = textColumnOrUndefined(row, "lease_turn");
    const holderTenant = textColumnOrUndefined(row, "lease_holder_tenant");
    const holder = textColumnOrUndefined(row, "lease_holder");
    return Object.freeze({
        open: integerColumn(row, "open") === 1,
        lifecycle: integerColumn(row, "lifecycle") === 1,
        revision: new Revision(integerColumn(row, "revision")),
        lease:
            turn === undefined
                ? undefined
                : Object.freeze({
                      turn: new TurnId(turn),
                      holder:
                          holderTenant === undefined || holder === undefined
                              ? undefined
                              : new PrincipalRef(
                                    new TenantId(holderTenant),
                                    new PrincipalId(holder)
                                ),
                      epoch: integerColumn(row, "lease_epoch"),
                      expiresAt: new Date(integerColumn(row, "lease_expires_at"))
                  })
    });
}

function sqliteRevision(transaction: ReadableSqlite): Revision {
    return new Revision(
        integerColumn(
            singletonRow(transaction, `SELECT revision FROM decision_domain WHERE singleton = 1`),
            "revision"
        )
    );
}

function sqliteNextId(transaction: TransactionalSqlite, prefix: string): string {
    const next =
        integerColumn(
            singletonRow(transaction, `SELECT next_id FROM decision_domain WHERE singleton = 1`),
            "next_id"
        ) + 1;
    transaction.run(`UPDATE decision_domain SET next_id = ? WHERE singleton = 1`, [next]);
    return `${prefix}-${next}`;
}

function sqliteFault(transaction: ReadableSqlite): FaultBoundary | undefined {
    const value = textColumnOrUndefined(
        singletonRow(transaction, `SELECT fault FROM decision_domain WHERE singleton = 1`),
        "fault"
    );
    return value !== undefined && isMember(faultBoundaries, value) ? value : undefined;
}

class SqliteDecisionActor implements DecisionPathActor {
    public readonly tenant = decisionPathTenant;
    readonly #database: TransactionalSqlite;
    readonly #store: ActorLocalStore<TransactionalSqlite, ReadableSqlite>;
    readonly #persistence: ProtocolPersistence<TransactionalSqlite>;
    readonly #content: CounterContentStore;
    readonly #ingress: CommandIngress<
        TransactionalSqlite,
        DomainRead,
        ReadableSqlite,
        CommandCaller | undefined
    >;

    public constructor(
        public readonly actor: ActorRef,
        command: DecisionCommandFactory<TransactionalSqlite>
    ) {
        this.#database = new TestSqlite();
        this.#database.transaction(() => {
            this.#database.run(CREATE_DOMAIN, []);
            this.#database.run(CREATE_OWNED_RECORDS, []);
            this.#database.run(
                `INSERT OR IGNORE INTO decision_domain (
                    singleton, revision, open, lifecycle, next_id
                ) VALUES (1, 0, 1, 1, 0)`,
                []
            );
        });
        this.#store = new SqliteActorStore(this.#database);
        this.#persistence = new FaultingCounterPersistence(
            new SqliteProtocolPersistence(this.#database),
            (transaction) => sqliteFault(transaction)
        );
        this.#content = new CounterContentStore(() => sqliteFault(this.#database));
        const dispatch: CommandDispatcherInit<TransactionalSqlite, DomainRead, ReadableSqlite> = {
            store: this.#store,
            persistence: this.#persistence,
            ids: new CounterIds(sqliteNextId),
            actor,
            tenant: this.tenant,
            readOnly: sqliteDomainRead,
            commands: [command(sqliteOperations)],
            limits: { envelopeBytes: 4096, payloadBytes: 1024 },
            now: () => decisionPathNow
        };
        const accept: CommandIngressInit<
            TransactionalSqlite,
            DomainRead,
            ReadableSqlite,
            CommandCaller | undefined
        > = {
            dispatcher: new CommandDispatcher(dispatch),
            content: this.#content,
            authenticator: new CounterAuthenticator(this.tenant),
            leaseForMilliseconds: 60_000,
            now: () => decisionPathNow
        };
        this.#ingress = new CommandIngress(accept);
    }

    public accept(
        raw: Uint8Array,
        caller: CommandCaller | undefined
    ): Promise<CommandIngressResult> {
        return this.#ingress.accept(raw, caller);
    }

    public revision(): Revision {
        return sqliteRevision(this.#database);
    }

    public ownedRecords(): readonly OwnedRecord[] {
        return this.#database
            .all(
                `SELECT id, permit, origin, granted FROM decision_owned_records ORDER BY ordinal`,
                []
            )
            .map((row) => {
                const id = textColumn(row, "id");
                const permit = textColumn(row, "permit");
                const origin = textColumnOrUndefined(row, "origin");
                // An applied effect is the row that names its authorizing decision; a permit
                // decision names none. Presence decides the shape, so neither Actor's rows can
                // decode into the other's.
                return origin === undefined
                    ? {
                          kind: "permitDecision" as const,
                          id,
                          permit,
                          granted: integerColumn(row, "granted") === 1
                      }
                    : { kind: "appliedEffect" as const, id, permit, origin };
            });
    }

    public evidence(): EvidenceView {
        return {
            writes: this.#database
                .all(`SELECT record FROM protocol_write_records ORDER BY sequence`, [])
                .map((row) => WriteRecordCodec.decode(blobColumn(row, "record"))),
            audits: this.#database
                .all(`SELECT record FROM protocol_audit_records ORDER BY sequence`, [])
                .map((row) => AuditRecordCodec.decode(blobColumn(row, "record")))
        };
    }

    public verifyRecordGraph(): void {
        this.#store.transaction((transaction) => {
            this.#persistence.repair?.(transaction);
        });
    }

    public seedInvocationCause(id: string, actor?: ActorRef): AuditRecord {
        const record = invocationCause(id, actor ?? this.actor, this.tenant);
        this.#store.transaction((transaction) => {
            this.#persistence.appendAudit(transaction, record);
        });
        return record;
    }

    public installPayload(bytes: Uint8Array): ContentRef {
        const ref = ContentRef.fromDigest(Digest.sha256(bytes));
        this.#content.install(ref.value, bytes);
        return ref;
    }

    public setOpen(open: boolean): void {
        this.#database.transaction(() => {
            this.#database.run(`UPDATE decision_domain SET open = ? WHERE singleton = 1`, [
                open ? 1 : 0
            ]);
        });
    }

    public setLifecycle(lifecycle: boolean): void {
        this.#database.transaction(() => {
            this.#database.run(`UPDATE decision_domain SET lifecycle = ? WHERE singleton = 1`, [
                lifecycle ? 1 : 0
            ]);
        });
    }

    public setFault(fault: FaultBoundary | undefined): void {
        this.#database.transaction(() => {
            this.#database.run(`UPDATE decision_domain SET fault = ? WHERE singleton = 1`, [
                fault ?? null
            ]);
        });
    }

    public setLease(init: LeaseInit = {}): LeaseToken {
        const token = leaseTokenFor(this.tenant, init);
        this.#database.transaction(() => {
            this.#database.run(
                `UPDATE decision_domain SET lease_turn = ?, lease_holder_tenant = ?,
                     lease_holder = ?, lease_epoch = ?, lease_expires_at = ?
                 WHERE singleton = 1`,
                [
                    token.turn.value,
                    token.holder.tenantId.value,
                    token.holder.principalId.value,
                    token.epoch,
                    (init.expiresAt ?? decisionLeaseExpiry).getTime()
                ]
            );
        });
        return token;
    }
}

// ---------------------------------------------------------------------------
// The traversal
// ---------------------------------------------------------------------------

export interface DecisionStep {
    readonly envelope: Uint8Array;
    readonly result: CommandIngressResult;
}

export interface BridgeOverrides {
    readonly key?: string;
    readonly caller?: CommandCaller;
    readonly grant?: boolean;
    readonly expectedRevision?: Revision;
    readonly omitRevision?: boolean;
    readonly lease?: LeaseToken;
    readonly omitLease?: boolean;
    readonly callerCause?: AuditRecordId;
    readonly unexpectedPayloadField?: boolean;
}

export interface Traversal {
    readonly decision: DecisionStep;
    readonly bridged: BridgedDecision;
    readonly envelope: Uint8Array;
    readonly delivery: CommandIngressResult;
}

/**
 * A complete Tenant-decision path: one Actor decides a permit and owns that decision, and a
 * second Actor applies the effect and owns that. The two are only ever joined by a post-commit
 * observation carried into the next command's payload, never by a transaction.
 */
export class TenantDecisionPath {
    public static create(label: DecisionHostLabel): TenantDecisionPath {
        return label === "memory"
            ? new TenantDecisionPath(
                  label,
                  new MemoryDecisionActor(
                      authorityActor,
                      (operations) => new PermitDecisionCommand(operations)
                  ),
                  new MemoryDecisionActor(
                      targetActor,
                      (operations) => new AppliedEffectCommand(operations)
                  )
              )
            : new TenantDecisionPath(
                  label,
                  new SqliteDecisionActor(
                      authorityActor,
                      (operations) => new PermitDecisionCommand(operations)
                  ),
                  new SqliteDecisionActor(
                      targetActor,
                      (operations) => new AppliedEffectCommand(operations)
                  )
              );
    }

    public readonly principal = new PrincipalId("decision-principal");
    public readonly caller: CommandCaller;
    /** The caller a bridged command carries: the deciding Tenant Actor itself. */
    public readonly bridgeCaller: CommandCaller;
    /** The target Actor's current lease, installed once so `bridge` never mutates state. */
    public readonly currentLease: LeaseToken;

    private constructor(
        public readonly label: DecisionHostLabel,
        public readonly authority: DecisionPathActor,
        public readonly target: DecisionPathActor
    ) {
        this.caller = {
            kind: "principal",
            principal: new PrincipalRef(decisionPathTenant, this.principal)
        };
        this.bridgeCaller = { kind: "actor", actor: authority.actor };
        this.currentLease = target.setLease();
    }

    /** Step one: the Tenant Actor decides, and the decision becomes its own record. */
    public async decide(init: {
        readonly permit: string;
        readonly grant: boolean;
        readonly key?: string;
        readonly lease?: LeaseToken;
    }): Promise<DecisionStep> {
        const payload = encodeCanonicalJson({ grant: init.grant, permit: init.permit });
        const ref = this.authority.installPayload(payload);
        const required: CommandEnvelopeInit = {
            command: permitDecisionCommand,
            caller: this.caller,
            idempotencyKey: init.key ?? `permit:${init.permit}`,
            expectedRevision: this.authority.revision(),
            payload: ref,
            payloadDigest: Digest.sha256(payload)
        };
        const envelope = CommandEnvelopeCodec.encode(
            new CommandEnvelope(
                init.lease === undefined ? required : { ...required, lease: init.lease }
            )
        );
        return { envelope, result: await this.authority.accept(envelope, this.caller) };
    }

    /**
     * Step two, built only from what the decision published post-commit. The idempotency key
     * is derived from the decision id, so an at-least-once redelivery of the same decision
     * carries the same command identity rather than a new one.
     */
    public bridge(decision: BridgedDecision, overrides: BridgeOverrides = {}): Uint8Array {
        const body = {
            decision: decision.decision,
            grant: overrides.grant ?? decision.granted,
            permit: decision.permit
        };
        const payload = encodeCanonicalJson(
            overrides.unexpectedPayloadField === true ? { ...body, unexpected: true } : body
        );
        const ref = this.target.installPayload(payload);
        const required: CommandEnvelopeInit = {
            command: applyEffectCommand,
            caller: overrides.caller ?? this.bridgeCaller,
            idempotencyKey: overrides.key ?? `decision:${decision.decision}`,
            payload: ref,
            payloadDigest: Digest.sha256(payload)
        };
        const revised: CommandEnvelopeInit =
            overrides.omitRevision === true
                ? required
                : {
                      ...required,
                      expectedRevision: overrides.expectedRevision ?? this.target.revision()
                  };
        const leased: CommandEnvelopeInit =
            overrides.omitLease === true
                ? revised
                : { ...revised, lease: overrides.lease ?? this.currentLease };
        const caused: CommandEnvelopeInit =
            overrides.callerCause === undefined
                ? leased
                : { ...leased, callerCause: overrides.callerCause };
        return CommandEnvelopeCodec.encode(new CommandEnvelope(caused));
    }

    /** Step three: at-least-once delivery of the bridged command to the owning Actor. */
    public deliver(envelope: Uint8Array, caller?: CommandCaller): Promise<CommandIngressResult> {
        return this.target.accept(envelope, caller ?? this.bridgeCaller);
    }

    /** The whole path, as one traversal. */
    public async traverse(init: {
        readonly permit: string;
        readonly grant: boolean;
        readonly overrides?: BridgeOverrides;
    }): Promise<Traversal> {
        const decision = await this.decide({ permit: init.permit, grant: init.grant });
        const bridged = decodeBridgedDecision(requireObservation(decision.result));
        const envelope = this.bridge(bridged, init.overrides);
        return { decision, bridged, envelope, delivery: await this.deliver(envelope) };
    }
}

export function requireObservation(result: CommandIngressResult): Uint8Array {
    if (result.kind !== "commandOutcome" || result.observation === undefined) {
        throw new TypeError("Expected a committed decision carrying a post-commit observation");
    }
    return result.observation;
}

export function requireOutcome(result: CommandIngressResult): CommandOutcome {
    if (result.kind !== "commandOutcome") {
        throw new TypeError("Expected a command outcome rather than a pre-dispatch failure");
    }
    return result.outcome;
}

export function requireWrite(result: CommandIngressResult): WriteRecord {
    if (result.kind !== "commandOutcome") {
        throw new TypeError("Expected a command outcome rather than a pre-dispatch failure");
    }
    return result.write;
}

function leaseTokenFor(tenant: TenantId, init: LeaseInit): LeaseToken {
    return {
        turn: new TurnId(init.turn ?? "decision-turn"),
        holder: new PrincipalRef(tenant, init.holder ?? new PrincipalId("decision-principal")),
        epoch: init.epoch ?? 4
    };
}

function invocationCause(id: string, actor: ActorRef, tenant: TenantId): AuditRecord {
    return new AuditRecord({
        id: new AuditRecordId(id),
        actor,
        tenant,
        correlation: new CorrelationId(`correlation-${id}`),
        kind: { kind: "invocation", id: new InvocationId(`invocation-${id}`) }
    });
}

function failAt(actual: FaultBoundary | undefined, expected: FaultBoundary): void {
    if (actual === expected) throw new Error(`Injected ${expected} failure`);
}

function singletonRow(database: ReadableSqlite, statement: string): SqliteRow {
    const rows = database.all(statement, []);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) {
        throw new TypeError("Expected exactly one decision domain row");
    }
    return row;
}

function integerColumn(row: SqliteRow, column: string): number {
    return parseValue.safeInteger(jsonColumn(row[column]), `integer column: ${column}`);
}

function textColumn(row: SqliteRow, column: string): string {
    return parseValue.nonemptyString(jsonColumn(row[column]), `text column: ${column}`);
}

/** SQLite NULL arrives as JSON null, which the parser reads as an absent string. */
function textColumnOrUndefined(row: SqliteRow, column: string): string | undefined {
    return parseValue.nullableString(jsonColumn(row[column]), `text column: ${column}`);
}

/** SQLite's blob columns fall outside the JSON vocabulary the column parser reads. */
function jsonColumn(value: SqliteValue | undefined): JsonValue | undefined {
    return value instanceof Uint8Array ? undefined : value;
}

function blobColumn(row: SqliteRow, column: string): Uint8Array {
    const value: SqliteValue | undefined = row[column];
    if (!(value instanceof Uint8Array)) {
        throw new TypeError(`Expected a record blob column: ${column}`);
    }
    return value.slice();
}

// @ts-nocheck
import {
    ActorCommitUnknownError,
    ActorId,
    ActorRef,
    type ActorLocalStore,
    type ActorRecoveryState,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../src/actors";
import { ContentRef, Digest, Revision, encodeCanonicalJson } from "../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import { AuditRecord, AuditRecordId, CorrelationId, InvocationId } from "../../src/invocations";
import {
    CommandDispatcher,
    CommandCommitUnknownError,
    type CommandDispatchResult,
    type CurrentLease,
    type ProtocolPersistence
} from "../../src/protocol/dispatcher";
import { CommandIngress, type CommandIngressResult } from "../../src/protocol/ingress";
import { CommandCallerPolicy } from "../../src/protocol/policy";
import {
    CommandEnvelope,
    CommandEnvelopeCodec,
    type CommandCaller,
    type LeaseToken
} from "../../src/protocol/envelope";
import { WriteRecordCodec } from "../../src/protocol/write";
import type { ReadableSqlite, SqliteRow, TransactionalSqlite } from "../../src/substrates";
import { SqliteActorStore, SqliteProtocolPersistence } from "../../src/substrates";
import { TurnId } from "../../src/agents";
import { TestSqlite } from "../helpers/sqlite";
import {
    CounterCommand,
    CounterAuthenticator,
    CounterContentStore,
    CounterHarness,
    CounterIds,
    FaultingCounterPersistence,
    type CounterEnvelopeInit,
    type CounterFixture,
    type CounterHarnessOptions,
    type CounterOperations,
    type CounterReadCapability,
    type CounterSnapshot,
    type FaultBoundary
} from "./counter-fixture";

const CREATE_COUNTER = `CREATE TABLE IF NOT EXISTS protocol_counter (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    value INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    authorized INTEGER NOT NULL,
    lifecycle INTEGER NOT NULL,
    lease_turn TEXT,
    lease_holder TEXT,
    lease_epoch INTEGER,
    lease_expires_at INTEGER,
    next_id INTEGER NOT NULL,
    fault TEXT
)`;

class FaultingSqliteActorStore implements ActorLocalStore<TransactionalSqlite, ReadableSqlite> {
    public constructor(
        private readonly store: SqliteActorStore,
        private readonly database: TransactionalSqlite
    ) {}

    public transaction<TResult>(
        operation: TransactionOperation<TransactionalSqlite, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        const before = writeCount(this.database);
        const result = this.store.transaction(
            operation,
            ...([] as SynchronousResultGuard<TResult>)
        );
        const fault = faultValue(this.database);
        if (
            (fault === "unknownAck" || fault === "unknownUnindexed") &&
            writeCount(this.database) !== before
        ) {
            throw new CommandCommitUnknownError(undefined, fault === "unknownAck");
        }
        return result;
    }

    public bindActor(actor: ActorRef): void {
        this.store.bindActor(actor);
    }

    public activateActor(
        actor: ActorRef,
        start: TransactionOperation<TransactionalSqlite, void>
    ): ActorRecoveryState {
        return this.store.activateActor(actor, start);
    }

    public read<TResult>(
        transaction: TransactionalSqlite,
        operation: TransactionOperation<ReadableSqlite, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult {
        return this.store.read(transaction, operation, ...guard);
    }

    public loadRecoveryState(
        transaction: TransactionalSqlite,
        actor: ActorRef
    ): ActorRecoveryState | undefined {
        return this.store.loadRecoveryState(transaction, actor);
    }

    public saveRecoveryState(transaction: TransactionalSqlite, state: ActorRecoveryState): void {
        this.store.saveRecoveryState(transaction, state);
    }
}

export class SqliteCounterHarness implements CounterFixture {
    public readonly actor = new ActorRef("run", new ActorId("counter-actor"));
    public readonly tenant = new TenantId("counter-tenant");
    public readonly principal = new PrincipalId("counter-principal");
    public readonly caller: CommandCaller = {
        kind: "principal",
        principal: new PrincipalRef(this.tenant, this.principal)
    };

    readonly #database: TransactionalSqlite;
    readonly #content: CounterContentStore;
    readonly #store: ActorLocalStore<TransactionalSqlite, ReadableSqlite>;
    readonly #persistence: ProtocolPersistence<TransactionalSqlite>;
    readonly #options: CounterHarnessOptions;
    readonly #dispatcher: CommandDispatcher<
        TransactionalSqlite,
        CounterReadCapability,
        ReadableSqlite
    >;
    readonly #ingress: CommandIngress<TransactionalSqlite, CounterReadCapability, ReadableSqlite>;

    public constructor(
        options: CounterHarnessOptions = {},
        database: TransactionalSqlite = new TestSqlite()
    ) {
        this.#options = options;
        this.#database = database;
        this.#content = new CounterContentStore(() => faultValue(this.#database));
        this.#database.transaction(() => {
            this.#database.run(CREATE_COUNTER, []);
            this.#database.run(
                `INSERT OR IGNORE INTO protocol_counter (
                    singleton, value, revision, authorized, lifecycle, next_id
                ) VALUES (1, 0, 0, 1, 1, 0)`,
                []
            );
        });
        this.#store = new FaultingSqliteActorStore(
            new SqliteActorStore(this.#database),
            this.#database
        );
        this.#persistence = new FaultingCounterPersistence(
            new SqliteProtocolPersistence(this.#database),
            (transaction) => faultValue(transaction)
        );
        const command = new CounterCommand(
            options.expectedRevision ?? "required",
            options.lease ?? "optional",
            sqliteCounterOperations,
            options.asynchronousGate ?? false,
            options.caller ?? CommandCallerPolicy.principal(),
            options.typedExecution ?? false,
            options.typedObservation ?? true,
            options.includeReplyCodec ?? true,
            options.includeObservationCodec ?? true,
            options.asynchronousPayload ?? false,
            options.payloadFailure,
            options.mutateEnvelope ?? false,
            options.commandName ?? "counter.increment"
        );
        this.#dispatcher = new CommandDispatcher({
            store: this.#store,
            persistence: this.#persistence,
            ids: new CounterIds(nextId),
            actor: this.actor,
            tenant: this.tenant,
            readOnly: sqliteReadCapability,
            commands: options.duplicateCommand === true ? [command, command] : [command],
            limits: options.limits ?? { envelopeBytes: 4096, payloadBytes: 1024 },
            ...(options.useDefaultNow === true
                ? {}
                : { now: options.now ?? (() => CounterHarness.now) })
        });
        this.#ingress = new CommandIngress({
            dispatcher: this.#dispatcher,
            content: this.#content,
            authenticator: new CounterAuthenticator(this.tenant, () => faultValue(this.#database)),
            leaseForMilliseconds: 60_000,
            ...(options.useDefaultNow === true ? {} : { now: () => CounterHarness.now })
        });
    }

    public envelope(init: CounterEnvelopeInit = {}): Uint8Array {
        const amount = init.amount ?? 1;
        const key = init.key ?? "counter-key";
        const payload = encodeCanonicalJson({ amount });
        const ref = ContentRef.fromDigest(Digest.sha256(payload));
        this.installPayload(ref.value, payload);
        return CommandEnvelopeCodec.encode(
            new CommandEnvelope({
                command: "counter.increment",
                caller: this.caller,
                idempotencyKey: key,
                ...(init.omitRevision === true
                    ? {}
                    : { expectedRevision: init.expectedRevision ?? this.currentRevision() }),
                ...(init.lease === undefined ? {} : { lease: init.lease }),
                ...(init.callerCause === undefined ? {} : { callerCause: init.callerCause }),
                payload: ref,
                payloadDigest: Digest.sha256(payload)
            })
        );
    }

    public async dispatch(
        raw: Uint8Array,
        caller: CommandCaller | undefined = this.caller,
        submittedBytes?: Uint8Array
    ): Promise<CommandDispatchResult> {
        const result = await this.accept(raw, caller, submittedBytes);
        if (result.kind === "preDispatchFailure") {
            throw result.cause;
        }
        return result;
    }

    public accept(
        raw: Uint8Array,
        caller: CommandCaller | undefined = this.caller,
        submittedBytes?: Uint8Array
    ): Promise<CommandIngressResult> {
        return this.#ingress.accept(raw, caller, submittedBytes);
    }

    public seedInvocationCause(
        id = "caller-cause",
        location: {
            readonly actor?: ActorRef;
            readonly tenant?: TenantId;
        } = {}
    ): AuditRecord {
        const record = new AuditRecord({
            id: new AuditRecordId(id),
            actor: location.actor ?? this.actor,
            tenant: location.tenant ?? this.tenant,
            correlation: new CorrelationId(`correlation-${id}`),
            kind: { kind: "invocation", id: new InvocationId(`invocation-${id}`) }
        });
        this.#store.transaction((transaction) => {
            this.#persistence.appendAudit(transaction, record);
        });
        return record;
    }

    public corruptRemoveAudit(id: AuditRecordId): void {
        this.#database.run("DELETE FROM protocol_audit_records WHERE id = ?", [id.value]);
    }

    public setLease(
        init: {
            readonly turn?: string;
            readonly holder?: PrincipalId;
            readonly epoch?: number;
            readonly expiresAt?: Date;
        } = {}
    ): LeaseToken {
        const token: LeaseToken = {
            turn: new TurnId(init.turn ?? "counter-turn"),
            holder: new PrincipalRef(this.tenant, init.holder ?? this.principal),
            epoch: init.epoch ?? 3
        };
        const expiresAt = init.expiresAt ?? new Date("2026-07-07T12:05:00.000Z");
        this.#database.run(
            `UPDATE protocol_counter SET
                lease_turn = ?, lease_holder = ?, lease_epoch = ?, lease_expires_at = ?
             WHERE singleton = 1`,
            [token.turn.value, token.holder.principalId.value, token.epoch, expiresAt.getTime()]
        );
        return token;
    }

    public setAuthorized(authorized: boolean): void {
        this.#database.run("UPDATE protocol_counter SET authorized = ? WHERE singleton = 1", [
            authorized ? 1 : 0
        ]);
    }

    public setLifecycle(lifecycle: boolean): void {
        this.#database.run("UPDATE protocol_counter SET lifecycle = ? WHERE singleton = 1", [
            lifecycle ? 1 : 0
        ]);
    }

    public setFault(fault: FaultBoundary | undefined): void {
        this.#database.run("UPDATE protocol_counter SET fault = ? WHERE singleton = 1", [
            fault ?? null
        ]);
    }

    public installPayload(ref: string, payload: Uint8Array): void {
        this.#content.install(ref, payload);
    }

    public removePayload(ref: string): void {
        this.#content.remove(ref);
    }

    public payloadBytes(amount = 1): Uint8Array {
        return encodeCanonicalJson({ amount });
    }

    public pauseNextPayloadGet(): { readonly started: Promise<void>; release(): void } {
        return this.#content.pauseNextGet();
    }

    public snapshot(): CounterSnapshot {
        const state = singleton(this.#database);
        const writes = this.#database
            .all("SELECT record FROM protocol_write_records ORDER BY sequence", [])
            .map((row) => WriteRecordCodec.decode(bytes(row["record"], "record")));
        const audits = new Map(
            this.#database
                .all("SELECT id, record FROM protocol_audit_records ORDER BY sequence", [])
                .map((row) => [
                    text(row, "id"),
                    AuditRecord.codec.decode(bytes(row["record"], "record"))
                ])
        );
        return {
            value: integer(state, "value"),
            revision: new Revision(integer(state, "revision")),
            writes,
            audits,
            identityCount: integerValue(
                this.#database.all(
                    "SELECT COUNT(*) AS count FROM protocol_command_identities",
                    []
                )[0]?.["count"],
                "count"
            ),
            contentGets: this.#content.gets,
            contentPuts: this.#content.puts
        };
    }

    public restart(): CounterFixture {
        return new SqliteCounterHarness(this.#options, this.#database);
    }

    public recovery(): ActorRecoveryState | undefined {
        return this.#store.transaction((transaction) =>
            this.#store.loadRecoveryState(transaction, this.actor)
        );
    }

    private currentRevision(): Revision {
        return new Revision(integer(singleton(this.#database), "revision"));
    }
}

const sqliteCounterOperations: CounterOperations<TransactionalSqlite> = {
    increment(transaction, amount) {
        transaction.run(
            `UPDATE protocol_counter
             SET value = value + ?, revision = revision + 1
             WHERE singleton = 1`,
            [amount]
        );
        if (singleton(transaction)["fault"] === "forgedUnknown") {
            throw new CommandCommitUnknownError();
        }
        if (singleton(transaction)["fault"] === "forgedActorUnknown") {
            throw new ActorCommitUnknownError();
        }
        fail(transaction, "mutation");
        const state = singleton(transaction);
        return {
            value: integer(state, "value"),
            revision: new Revision(integer(state, "revision")),
            ...(state["fault"] === null ? {} : { fault: state["fault"] as FaultBoundary })
        };
    }
};

function sqliteReadCapability(transaction: ReadableSqlite): CounterReadCapability {
    const state = singleton(transaction);
    if (state["fault"] === "readSnapshot") {
        throw new TypeError("Injected readSnapshot failure");
    }
    if (state["fault"] === "gateMutation") {
        transaction.all(
            "UPDATE protocol_counter SET value = value + 100 WHERE singleton = 1 RETURNING value",
            []
        );
    }
    return Object.freeze({
        authorized: state["fault"] === "gateMutation" ? false : integer(state, "authorized") === 1,
        lifecycle: integer(state, "lifecycle") === 1,
        revision: new Revision(integer(state, "revision")),
        lease: sqliteLease(state)
    });
}

function sqliteLease(state: SqliteRow): CurrentLease | undefined {
    const turn = state["lease_turn"];
    const holder = state["lease_holder"];
    const epoch = state["lease_epoch"];
    const expiresAt = state["lease_expires_at"];
    if (turn === null && holder === null && epoch === null && expiresAt === null) {
        return undefined;
    }
    if (
        typeof turn !== "string" ||
        typeof holder !== "string" ||
        typeof epoch !== "number" ||
        typeof expiresAt !== "number"
    ) {
        throw new TypeError("SQLite counter lease is malformed");
    }
    return Object.freeze({
        turn: new TurnId(turn),
        holder: new PrincipalRef(new TenantId("counter-tenant"), new PrincipalId(holder)),
        epoch,
        expiresAt: new Date(expiresAt)
    });
}

function nextId(transaction: TransactionalSqlite, prefix: string): string {
    transaction.run("UPDATE protocol_counter SET next_id = next_id + 1 WHERE singleton = 1", []);
    return `${prefix}-${integer(singleton(transaction), "next_id")}`;
}

function fail(transaction: TransactionalSqlite, boundary: FaultBoundary): void {
    if (singleton(transaction)["fault"] === boundary) {
        throw new Error(`Injected ${boundary} failure`);
    }
}

function singleton(database: ReadableSqlite): SqliteRow {
    const row = database.all("SELECT * FROM protocol_counter WHERE singleton = 1", [])[0];
    if (row === undefined) {
        throw new TypeError("SQLite counter state is missing");
    }
    return row;
}

function faultValue(database: ReadableSqlite): FaultBoundary | undefined {
    const value = singleton(database)["fault"];
    return value === null ? undefined : (value as FaultBoundary);
}

function writeCount(database: ReadableSqlite): number {
    return integerValue(
        database.all("SELECT COUNT(*) AS count FROM protocol_write_records", [])[0]?.["count"],
        "count"
    );
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string") {
        throw new TypeError(`Expected text column: ${column}`);
    }
    return value;
}

function integer(row: SqliteRow, column: string): number {
    return integerValue(row[column], column);
}

function integerValue(value: unknown, column: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TypeError(`Expected integer column: ${column}`);
    }
    return value;
}

function bytes(value: unknown, column: string): Uint8Array {
    if (!(value instanceof Uint8Array)) {
        throw new TypeError(`Expected bytes column: ${column}`);
    }
    return value;
}

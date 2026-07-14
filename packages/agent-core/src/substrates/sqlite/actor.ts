import {
    ActorRef,
    ActorActivation,
    ActorRecoveryState,
    requireSynchronousResult,
    type ActorLocalStore,
    type ActorStartOperation,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../actors";
import { AgentCoreError } from "../../errors";
import {
    inheritSqliteProvenance,
    ReadableSqlite,
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "./sqlite";

const CREATE_ACTOR_STATE = `CREATE TABLE IF NOT EXISTS actor_recovery_state (
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    state BLOB NOT NULL,
    PRIMARY KEY (actor_kind, actor_id)
)`;

const CREATE_ACTOR_IDENTITY = `CREATE TABLE IF NOT EXISTS actor_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    UNIQUE (actor_kind, actor_id)
)`;

const activeActorTransactions = new WeakSet<TransactionalSqlite>();

export class SqliteActorStore implements ActorLocalStore<TransactionalSqlite, ReadableSqlite> {
    #actor: ActorRef | undefined;
    #activeActor: ActorRef | undefined;
    #activeTransaction: SqliteTransactionScope | undefined;

    public constructor(private readonly database: TransactionalSqlite) {
        this.database.transaction(() => {
            this.database.run(CREATE_ACTOR_IDENTITY, []);
            this.database.run(CREATE_ACTOR_STATE, []);
        });
    }

    public bindActor(actor: ActorRef): void {
        const bound = this.#activeTransaction === undefined ? this.#actor : this.#activeActor;
        if (bound !== undefined && !bound.equals(actor)) {
            throw actorIsolationError();
        }
        if (this.#activeTransaction !== undefined) {
            this.bindIdentity(this.#activeTransaction, actor);
            this.#activeActor = actor;
            return;
        }
        if (activeActorTransactions.has(this.database)) {
            throw invalidState("Nested actor transactions are not supported");
        }
        this.database.transaction(() => {
            this.bindIdentity(this.database, actor);
        });
        this.#actor = actor;
    }

    public activateActor(
        actor: ActorRef,
        start: ActorStartOperation<TransactionalSqlite>
    ): ActorRecoveryState {
        return this.transaction((transaction) => {
            const existing = this.storedIdentity(transaction) !== undefined;
            this.bindActor(actor);
            const previous = this.loadRecoveryState(transaction, actor);
            if (existing && previous === undefined) {
                throw missingRecoveryState();
            }
            if (!existing && previous !== undefined) {
                throw new AgentCoreError(
                    "codec.invalid",
                    "Unbound Actor storage cannot contain recovery state"
                );
            }
            const next =
                previous === undefined ? ActorRecoveryState.initial(actor) : previous.recover();
            this.saveRecoveryState(transaction, next);
            const activated =
                previous === undefined
                    ? ActorActivation.created(next)
                    : ActorActivation.recovered(next);
            requireSynchronousResult(start(transaction, activated));
            return next;
        });
    }

    public transaction<TResult>(
        operation: TransactionOperation<TransactionalSqlite, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        if (this.#activeTransaction !== undefined || activeActorTransactions.has(this.database)) {
            throw invalidState("Nested actor transactions are not supported");
        }
        activeActorTransactions.add(this.database);
        let committedActor = this.#actor;
        try {
            const result = this.database.transaction(
                () => {
                    const transaction = new SqliteTransactionScope(this.database);
                    this.#activeTransaction = transaction;
                    this.#activeActor = this.#actor;
                    try {
                        return requireSynchronousResult(operation(transaction));
                    } finally {
                        committedActor = this.#activeActor;
                        this.#activeTransaction = undefined;
                        this.#activeActor = undefined;
                        transaction.close();
                    }
                },
                ...([] as SynchronousResultGuard<TResult>)
            );
            this.#actor = committedActor;
            return result;
        } finally {
            activeActorTransactions.delete(this.database);
        }
    }

    public read<TResult>(
        transaction: TransactionalSqlite,
        operation: TransactionOperation<ReadableSqlite, TResult>,
        ..._guard: SynchronousResultGuard<TResult>
    ): TResult {
        if (transaction !== this.#activeTransaction) {
            throw staleTransaction("Protocol reads require the active SQLite actor transaction");
        }
        return this.#activeTransaction.read(operation);
    }

    public loadRecoveryState(
        transaction: TransactionalSqlite,
        actor: ActorRef
    ): ActorRecoveryState | undefined {
        this.requireActiveTransaction(transaction);
        this.requireBoundActor(actor);
        const row = transaction.all(
            `SELECT state
             FROM actor_recovery_state
             WHERE actor_kind = ? AND actor_id = ?`,
            [actor.kind, actor.id.value]
        )[0];
        if (row === undefined) {
            return undefined;
        }
        const state = ActorRecoveryState.codec.decode(bytes(row, "state"));
        if (!state.actor.equals(actor)) {
            throw new AgentCoreError(
                "codec.invalid",
                "Actor recovery state does not match its storage key"
            );
        }
        return state;
    }

    public saveRecoveryState(transaction: TransactionalSqlite, state: ActorRecoveryState): void {
        this.requireActiveTransaction(transaction);
        this.requireBoundActor(state.actor);
        transaction.run(
            `INSERT INTO actor_recovery_state (actor_kind, actor_id, state)
             VALUES (?, ?, ?)
             ON CONFLICT(actor_kind, actor_id) DO UPDATE SET
                state = excluded.state`,
            [state.actor.kind, state.actor.id.value, ActorRecoveryState.codec.encode(state)]
        );
    }

    private requireBoundActor(actor: ActorRef): void {
        const bound = this.#activeTransaction === undefined ? this.#actor : this.#activeActor;
        if (bound === undefined || !bound.equals(actor)) {
            throw actorIsolationError();
        }
    }

    private bindIdentity(transaction: TransactionalSqlite, actor: ActorRef): void {
        transaction.run(
            `INSERT OR IGNORE INTO actor_identity (singleton, actor_kind, actor_id)
             VALUES (1, ?, ?)`,
            [actor.kind, actor.id.value]
        );
        const stored = this.storedIdentity(transaction);
        if (stored?.["actor_kind"] !== actor.kind || stored["actor_id"] !== actor.id.value) {
            throw actorIsolationError();
        }
    }

    private storedIdentity(transaction: TransactionalSqlite): SqliteRow | undefined {
        return transaction.all(
            "SELECT actor_kind, actor_id FROM actor_identity WHERE singleton = 1",
            []
        )[0];
    }

    private requireActiveTransaction(transaction: TransactionalSqlite): void {
        if (transaction !== this.#activeTransaction) {
            throw staleTransaction("Actor recovery state requires the active SQLite transaction");
        }
    }
}

class SqliteTransactionScope extends TransactionalSqlite {
    #open = true;

    public constructor(private readonly database: TransactionalSqlite) {
        super();
        inheritSqliteProvenance(this, database);
    }

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        this.requireOpen();
        return this.database.all(statement, bindings);
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.requireOpen();
        this.database.run(statement, bindings);
    }

    public transaction<Result>(
        _operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        this.requireOpen();
        throw invalidState("Nested actor transactions are not supported");
    }

    public close(): void {
        this.#open = false;
    }

    public read<Result>(operation: TransactionOperation<ReadableSqlite, Result>): Result {
        this.requireOpen();
        const scope = new SqliteReadScope(this.database);
        try {
            return requireSynchronousResult(operation(scope));
        } finally {
            scope.close();
        }
    }

    private requireOpen(): void {
        if (!this.#open) {
            throw new AgentCoreError("actor.closed", "Actor transaction is no longer active");
        }
    }
}

class SqliteReadScope extends ReadableSqlite {
    #open = true;

    public constructor(private readonly database: TransactionalSqlite) {
        super();
        inheritSqliteProvenance(this, database);
    }

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (!this.#open) {
            throw new AgentCoreError(
                "actor.closed",
                "Protocol read transaction is no longer active"
            );
        }
        requireReadOnlyStatement(statement);
        return this.database.all(statement, bindings);
    }

    public close(): void {
        this.#open = false;
    }
}

function requireReadOnlyStatement(statement: string): void {
    const normalized = statement.trim();
    if (!/^SELECT\b/i.test(normalized) || normalized.slice(0, -1).includes(";")) {
        throw invalidState("Actor read scopes accept one SELECT statement only");
    }
}

function actorIsolationError(): AgentCoreError {
    return invalidState("SQLite ActorStore is bound to a different Actor");
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

function staleTransaction(message: string): AgentCoreError {
    return new AgentCoreError("actor.stale-callback", message);
}

function missingRecoveryState(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Existing Actor storage is missing recovery state");
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) {
        throw new AgentCoreError("codec.invalid", "Actor recovery state storage is malformed");
    }
    return value;
}

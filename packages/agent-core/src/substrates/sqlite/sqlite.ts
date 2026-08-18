import type { SynchronousResultGuard } from "../../actors";
import { AgentCoreError } from "../../errors";

export type SqliteValue = string | number | Uint8Array | null;

export interface SqliteRow {
    readonly [column: string]: SqliteValue;
}

type SqliteRead = (statement: string, bindings: readonly SqliteValue[]) => readonly SqliteRow[];
type SqliteWrite = (statement: string, bindings: readonly SqliteValue[]) => void;

interface SqliteView {
    beforeRead?(statement: string, bindings: readonly SqliteValue[]): void;
    projectRows?(statement: string, rows: readonly SqliteRow[]): readonly SqliteRow[];
    beforeRun?(statement: string, bindings: readonly SqliteValue[]): void;
    capability?: SqliteMutationCapability;
}

const sqliteMutationCapabilityBrand: unique symbol = Symbol("agent-core.sqlite-mutation");
const sqliteMutationCapabilityMarker: true = true;

interface SqliteMutationCapability {
    readonly [sqliteMutationCapabilityBrand]: true;
}

interface SqliteReadExecutor {
    readonly read: SqliteRead;
    readonly identity?: object;
}

interface DerivedSqliteRead {
    readonly source: ReadableSqlite;
    readonly view?: SqliteView;
}

type ReadableSqliteConstruction = SqliteReadExecutor | DerivedSqliteRead;

interface SqliteExecutors extends SqliteReadExecutor {
    readonly write: SqliteWrite;
}

interface DerivedTransactionalSqlite {
    readonly source: TransactionalSqlite;
    readonly view?: SqliteView;
}

type TransactionalSqliteConstruction = SqliteExecutors | DerivedTransactionalSqlite;

interface SqliteProvenance {
    arbiter: SqliteMutationArbiter | undefined;
}

interface SqliteMutationArbiter {
    readonly capability: SqliteMutationCapability;
    active: SqliteMutationAuthority | undefined;
}

interface SqliteMutationAuthority {
    failure: Error | undefined;
}

const sqliteProvenance = new WeakMap<ReadableSqlite, SqliteProvenance>();
const sqliteDatabaseProvenance = new WeakMap<object, SqliteProvenance>();
const sqliteCapabilities = new WeakMap<ReadableSqlite, SqliteMutationCapability>();

export function isSqliteText(value: SqliteValue | undefined): value is string {
    return typeof value === "string";
}

export function isSqliteNumber(value: SqliteValue | undefined): value is number {
    return typeof value === "number";
}

export abstract class ReadableSqlite {
    readonly #reader: SqliteRead;
    public readonly all: SqliteRead;

    protected constructor(construction: ReadableSqliteConstruction) {
        let source: ReadableSqlite | undefined;
        let view: SqliteView | undefined;
        let sourceReader: SqliteRead;
        if ("source" in construction) {
            source = construction.source;
            view = construction.view;
            sourceReader = source.#reader;
        } else {
            sourceReader = construction.read;
        }
        const reader: SqliteRead =
            source === undefined
                ? sourceReader
                : (statement, bindings) => {
                      view?.beforeRead?.(statement, bindings);
                      const rows = sourceReader(statement, bindings);
                      return view?.projectRows?.(statement, rows) ?? rows;
                  };
        this.#reader = reader;
        sqliteProvenance.set(this, provenance(construction, source));
        if (view?.capability !== undefined) sqliteCapabilities.set(this, view.capability);
        this.all = (statement, bindings) => {
            requireReadAccess(this);
            return this.#reader(statement, bindings);
        };
        Object.defineProperty(this, "all", {
            configurable: false,
            enumerable: false,
            writable: false
        });
    }
}

export abstract class TransactionalSqlite extends ReadableSqlite {
    readonly #writer: SqliteWrite;
    public readonly run: SqliteWrite;

    protected constructor(construction: TransactionalSqliteConstruction) {
        super(readConstruction(construction));
        let writer: SqliteWrite;
        if ("source" in construction) {
            writer =
                construction.view === undefined
                    ? construction.source.#writer
                    : derivedWriter(construction.source.#writer, construction.view);
        } else {
            writer = construction.write;
        }
        this.#writer = writer;
        this.run = (statement, bindings) => {
            requireMutationAccess(this);
            this.#writer(statement, bindings);
        };
        Object.defineProperty(this, "run", {
            configurable: false,
            enumerable: false,
            writable: false
        });
    }

    public abstract transaction<Result>(
        operation: () => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
}

export function hasSameSqliteProvenance(left: ReadableSqlite, right: ReadableSqlite): boolean {
    const owner = sqliteProvenance.get(left);
    return owner !== undefined && owner === sqliteProvenance.get(right);
}

export function ownSqliteMutations(database: TransactionalSqlite): TransactionalSqlite {
    const owner = requireProvenance(database);
    const arbiter =
        owner.arbiter ??
        (owner.arbiter = {
            capability: Object.freeze({
                [sqliteMutationCapabilityBrand]: sqliteMutationCapabilityMarker
            }),
            active: undefined
        });
    if (sqliteCapabilities.get(database) === arbiter.capability) return database;
    return new MutationOwnedSqlite(database, arbiter.capability);
}

export function withExclusiveSqliteMutation<Result>(
    database: TransactionalSqlite,
    operation: (database: TransactionalSqlite) => Result,
    ...guard: SynchronousResultGuard<Result>
): Result {
    const owner = requireProvenance(database);
    const arbiter = owner.arbiter;
    if (arbiter === undefined || sqliteCapabilities.get(database) !== arbiter.capability) {
        throw invalidMutation("SQLite mutation authority is not owned by this database view");
    }
    if (arbiter.active !== undefined) {
        throw poison(arbiter.active, "Nested exclusive SQLite mutations are not supported");
    }
    const authority: SqliteMutationAuthority = { failure: undefined };
    const scope = new MutationScopedSqlite(database, arbiter.capability);
    arbiter.active = authority;
    try {
        return database.transaction(
            () => {
                const result = operation(scope);
                if (authority.failure !== undefined) throw authority.failure;
                return result;
            },
            ...guard
        );
    } finally {
        arbiter.active = undefined;
    }
}

class MutationOwnedSqlite extends TransactionalSqlite {
    readonly #source: TransactionalSqlite;

    public constructor(source: TransactionalSqlite, capability: SqliteMutationCapability) {
        super({ source, view: { capability } });
        this.#source = source;
    }

    public transaction<Result>(
        operation: () => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#source.transaction(operation, ...guard);
    }
}

class MutationScopedSqlite extends TransactionalSqlite {
    public constructor(source: TransactionalSqlite, capability: SqliteMutationCapability) {
        super({ source, view: { capability } });
    }

    public transaction<Result>(
        _operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        throw invalidMutation("Nested exclusive SQLite mutations are not supported");
    }
}

function readConstruction(
    construction: TransactionalSqliteConstruction
): ReadableSqliteConstruction {
    if ("source" in construction) {
        return construction.view === undefined
            ? { source: construction.source }
            : { source: construction.source, view: construction.view };
    }
    return construction.identity === undefined
        ? { read: construction.read }
        : { read: construction.read, identity: construction.identity };
}

function derivedWriter(source: SqliteWrite, view: SqliteView): SqliteWrite {
    return (statement, bindings) => {
        view.beforeRun?.(statement, bindings);
        source(statement, bindings);
    };
}

function requireReadAccess(database: ReadableSqlite): void {
    const owner = requireProvenance(database);
    const active = owner.arbiter?.active;
    if (active === undefined) return;
    requireCapability(database, owner, active);
}

function requireMutationAccess(database: ReadableSqlite): void {
    const owner = requireProvenance(database);
    const arbiter = owner.arbiter;
    if (arbiter === undefined) return;
    const active = arbiter.active;
    if (sqliteCapabilities.get(database) !== arbiter.capability) {
        if (active !== undefined) {
            throw poison(
                active,
                "SQLite access outside the active storage mutation authority is forbidden"
            );
        }
        throw invalidMutation("SQLite mutation requires its database-owned authority");
    }
    if (active?.failure !== undefined) throw active.failure;
}

function requireCapability(
    database: ReadableSqlite,
    owner: SqliteProvenance,
    active: SqliteMutationAuthority
): void {
    if (sqliteCapabilities.get(database) !== owner.arbiter?.capability) {
        throw poison(
            active,
            "SQLite access outside the active storage mutation authority is forbidden"
        );
    }
    if (active.failure !== undefined) throw active.failure;
}

function poison(authority: SqliteMutationAuthority, message: string): Error {
    authority.failure ??= invalidMutation(message);
    return authority.failure;
}

function invalidMutation(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

function requireProvenance(database: ReadableSqlite): SqliteProvenance {
    const value = sqliteProvenance.get(database);
    if (value === undefined) throw invalidMutation("SQLite capability is not initialized");
    return value;
}

function provenance(
    construction: ReadableSqliteConstruction,
    source: ReadableSqlite | undefined
): SqliteProvenance {
    if (source !== undefined) return requireProvenance(source);
    if (!("identity" in construction) || construction.identity === undefined) {
        return { arbiter: undefined };
    }
    const existing = sqliteDatabaseProvenance.get(construction.identity);
    if (existing !== undefined) return existing;
    const created: SqliteProvenance = { arbiter: undefined };
    sqliteDatabaseProvenance.set(construction.identity, created);
    return created;
}

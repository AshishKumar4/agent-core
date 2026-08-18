import {
    TransactionalSqlite,
    type SqliteRow as CoreSqliteRow,
    type SqliteValue as CoreSqliteValue
} from "@agent-core/core/substrates/sqlite";
import type { SynchronousResultGuard as CoreSynchronousResultGuard } from "@agent-core/core/actors";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import { isFiniteNumber, isPlatformMethod, isPlatformObject, isText } from "./platform-value.js";

export type SqliteValue = CoreSqliteValue;
export type SqliteRow = CoreSqliteRow;

export type CloudflareSqlValue = string | number | ArrayBuffer | ArrayBufferView | null;
export type CloudflareSqlBinding = string | number | ArrayBuffer | null;

export interface CloudflareSqlCursor<
    Row extends Record<string, CloudflareSqlValue>
> extends Iterable<Row> {}

export interface CloudflareSqlStorage {
    exec(
        statement: string,
        ...bindings: readonly CloudflareSqlBinding[]
    ): CloudflareSqlCursor<Record<string, CloudflareSqlValue>>;
}

export interface CloudflareDurableObjectStorage {
    readonly sql: CloudflareSqlStorage;
    transactionSync<Result>(operation: () => Result): Result;
}

export type SynchronousResultGuard<Result> = CoreSynchronousResultGuard<Result>;

/**
 * Cloudflare documents 2 MB as the maximum size of a string, BLOB, or row in a Durable
 * Object's SQLite storage, and workerd sets `SQLITE_LIMIT_LENGTH` to 2,200,000 so the
 * documented value keeps headroom.
 */
export const SQL_BLOB_LIMIT_BYTES = 2_000_000;

/**
 * A payload past the documented limit is invalid input, not an invalid protocol state.
 * Write seams reject it before they open a transaction, because the runtime would
 * otherwise surface it as an opaque statement failure partway through one.
 */
export function requireStorableBlob(
    subject: string,
    bytes: Uint8Array,
    errors: CloudflareErrorPort
): void {
    if (bytes.byteLength > SQL_BLOB_LIMIT_BYTES) {
        operationalFailure(
            errors,
            "operation.invalid-input",
            `${subject} of ${bytes.byteLength} bytes exceeds the ` +
                `${SQL_BLOB_LIMIT_BYTES}-byte Durable Object SQLite limit`
        );
    }
}

/**
 * Reads the value a stored column is for. SQLite is dynamically typed, so a column's
 * declared type is a promise the schema makes and not one the runtime keeps, and a row
 * read back is evidence rather than a record: every store in this package had derived
 * that for itself, in copies that disagreed about what an integer column admits.
 *
 * Representation is all this reader decides. Domain range — a revision that must be
 * positive, an epoch that must not be negative — belongs to the store that knows it.
 */
export interface StoredRowReader {
    /** TEXT that must be present and carry at least one character. */
    text(row: SqliteRow, column: string): string;
    /** TEXT whose SQL NULL stands for an absent value. */
    nullableText(row: SqliteRow, column: string): string | null;
    /** INTEGER inside JavaScript's exactly representable range. */
    integer(row: SqliteRow, column: string): number;
    /** INTEGER whose SQL NULL stands for an absent value. */
    nullableInteger(row: SqliteRow, column: string): number | null;
    /** BLOB, as the runtime handed it over. */
    bytes(row: SqliteRow, column: string): Uint8Array;
}

/**
 * Binds the reader to how one store reports its own corrupt storage, so each keeps its
 * error vocabulary and its wording while sharing what a stored column is.
 */
export function storedRowReader(corrupt: (column: string) => never): StoredRowReader {
    function text(row: SqliteRow, column: string): string {
        const value = row[column];
        if (!isText(value) || value.length === 0) corrupt(column);
        return value;
    }
    function integer(row: SqliteRow, column: string): number {
        const value = row[column];
        if (!isFiniteNumber(value) || !Number.isSafeInteger(value)) corrupt(column);
        return value;
    }
    return Object.freeze({
        text,
        nullableText: (row: SqliteRow, column: string): string | null =>
            row[column] === null ? null : text(row, column),
        integer,
        nullableInteger: (row: SqliteRow, column: string): number | null =>
            row[column] === null ? null : integer(row, column),
        bytes(row: SqliteRow, column: string): Uint8Array {
            const value = row[column];
            if (!(value instanceof Uint8Array)) corrupt(column);
            return value;
        }
    });
}

export class CloudflareSqlite extends TransactionalSqlite {
    readonly #state: CloudflareSqliteState;
    readonly #storage: CloudflareDurableObjectStorage;
    readonly #errors: CloudflareErrorPort;

    public constructor(storage: CloudflareDurableObjectStorage, errors: CloudflareErrorPort) {
        const state: CloudflareSqliteState = { transactionActive: false, poisoned: false };
        super({
            read: (statement, bindings) => readRows(storage, errors, state, statement, bindings),
            write: (statement, bindings) =>
                runStatement(storage, errors, state, statement, bindings),
            identity: storage
        });
        this.#state = state;
        this.#storage = storage;
        this.#errors = errors;
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        requireAvailable(this.#state, this.#errors);
        if (this.#state.transactionActive) {
            operationalFailure(
                this.#errors,
                "protocol.invalid-state",
                "Nested Cloudflare SQLite transactions are not supported"
            );
        }
        this.#state.transactionActive = true;
        let callbackFailed = false;
        try {
            try {
                return this.#storage.transactionSync(() => {
                    try {
                        return requireSynchronous(operation(), this.#state, this.#errors);
                    } catch (cause) {
                        callbackFailed = true;
                        throw cause;
                    }
                });
            } catch (cause) {
                if (callbackFailed) throw cause;
                operationalFailure(
                    this.#errors,
                    "protocol.invalid-state",
                    "Cloudflare SQLite transaction failed",
                    { value: cause }
                );
            }
        } finally {
            this.#state.transactionActive = false;
        }
    }
}

interface CloudflareSqliteState {
    transactionActive: boolean;
    poisoned: boolean;
}

function readRows(
    storage: CloudflareDurableObjectStorage,
    errors: CloudflareErrorPort,
    state: CloudflareSqliteState,
    statement: string,
    bindings: readonly SqliteValue[]
): readonly SqliteRow[] {
    requireAvailable(state, errors);
    const cursor = execute(storage, errors, statement, bindings);
    const rows: Array<Record<string, CloudflareSqlValue>> = [];
    try {
        for (const row of cursor) rows.push(row);
    } catch (cause) {
        operationalFailure(
            errors,
            "protocol.invalid-state",
            "Cloudflare SQLite query iteration failed",
            { value: cause }
        );
    }
    return rows.map((row) => normalizeRow(row, errors));
}

function runStatement(
    storage: CloudflareDurableObjectStorage,
    errors: CloudflareErrorPort,
    state: CloudflareSqliteState,
    statement: string,
    bindings: readonly SqliteValue[]
): void {
    requireAvailable(state, errors);
    const cursor = execute(storage, errors, statement, bindings);
    try {
        for (const _row of cursor) {
            // SQL cursors can be lazy; exhaustion is part of executing the statement.
        }
    } catch (cause) {
        operationalFailure(
            errors,
            "protocol.invalid-state",
            "Cloudflare SQLite statement execution failed",
            { value: cause }
        );
    }
}

function execute(
    storage: CloudflareDurableObjectStorage,
    errors: CloudflareErrorPort,
    statement: string,
    bindings: readonly SqliteValue[]
): CloudflareSqlCursor<Record<string, CloudflareSqlValue>> {
    try {
        return storage.sql.exec(statement, ...bindings.map(binding));
    } catch (cause) {
        operationalFailure(
            errors,
            "protocol.invalid-state",
            "Cloudflare SQLite statement preparation failed",
            { value: cause }
        );
    }
}

function requireAvailable(state: CloudflareSqliteState, errors: CloudflareErrorPort): void {
    if (state.poisoned) {
        operationalFailure(
            errors,
            "protocol.invalid-state",
            "Cloudflare SQLite adapter is poisoned by an asynchronous transaction callback"
        );
    }
}

function requireSynchronous<Result>(
    result: Result,
    state: CloudflareSqliteState,
    errors: CloudflareErrorPort
): Result {
    if (!isThenable(result)) return result;
    state.poisoned = true;
    if (result instanceof Promise) void result.catch(noop);
    operationalFailure(
        errors,
        "protocol.invalid-state",
        "Cloudflare SQLite transaction callbacks must be synchronous"
    );
}

function binding(value: SqliteValue): CloudflareSqlBinding {
    if (!(value instanceof Uint8Array)) return value;
    return value.slice().buffer;
}

function normalizeRow(
    row: Record<string, CloudflareSqlValue>,
    errors: CloudflareErrorPort
): SqliteRow {
    const normalized: Record<string, SqliteValue> = {};
    for (const [column, value] of Object.entries(row)) {
        normalized[column] = normalizeValue(value, errors);
    }
    return normalized;
}

function normalizeValue(value: CloudflareSqlValue, errors: CloudflareErrorPort): SqliteValue {
    if (value === null || isFiniteNumber(value)) return value;
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value.slice(0));
    }
    if (ArrayBuffer.isView(value)) {
        const start = value.byteOffset;
        const end = start + value.byteLength;
        return new Uint8Array(value.buffer.slice(start, end));
    }
    if (isText(value)) return value;
    operationalFailure(
        errors,
        "operation.invalid-output",
        "Cloudflare SQLite returned an unsupported row value"
    );
}

function isThenable(value: unknown): value is PromiseLike<void> {
    if (!isPlatformObject(value)) return false;
    // SAFETY: this optional view reads only then. Callability below establishes the
    // PromiseLike behavior relevant to the synchronous-transaction guard.
    const candidate = value as Partial<PromiseLike<void>>;
    return isPlatformMethod(candidate.then);
}

function noop(): void {}

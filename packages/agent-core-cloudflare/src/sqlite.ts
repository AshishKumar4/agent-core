import {
    TransactionalSqlite,
    type SqliteRow as CoreSqliteRow,
    type SqliteValue as CoreSqliteValue
} from "@agent-core/core/substrates/sqlite";
import type { SynchronousResultGuard as CoreSynchronousResultGuard } from "@agent-core/core/actors";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";

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

export class CloudflareSqlite extends TransactionalSqlite {
    #transactionActive = false;
    #poisoned = false;

    public constructor(
        private readonly storage: CloudflareDurableObjectStorage,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
    }

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        this.requireAvailable();
        const cursor = this.execute(statement, bindings);
        const rows: Array<Record<string, CloudflareSqlValue>> = [];
        try {
            for (const row of cursor) rows.push(row);
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Cloudflare SQLite query iteration failed",
                cause
            );
        }
        return rows.map((row) => normalizeRow(row, this.errors));
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.requireAvailable();
        const cursor = this.execute(statement, bindings);
        try {
            for (const _row of cursor) {
                // SQL cursors can be lazy; exhaustion is part of executing the statement.
            }
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Cloudflare SQLite statement execution failed",
                cause
            );
        }
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        this.requireAvailable();
        if (this.#transactionActive) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Nested Cloudflare SQLite transactions are not supported"
            );
        }
        this.#transactionActive = true;
        let callbackFailed = false;
        try {
            try {
                return this.storage.transactionSync(() => {
                    try {
                        return this.requireSynchronous(operation());
                    } catch (cause) {
                        callbackFailed = true;
                        throw cause;
                    }
                });
            } catch (cause) {
                if (callbackFailed) throw cause;
                operationalFailure(
                    this.errors,
                    "protocol.invalid-state",
                    "Cloudflare SQLite transaction failed",
                    cause
                );
            }
        } finally {
            this.#transactionActive = false;
        }
    }

    private requireAvailable(): void {
        if (this.#poisoned) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Cloudflare SQLite adapter is poisoned by an asynchronous transaction callback"
            );
        }
    }

    private requireSynchronous<Result>(result: Result): Result {
        if (!isThenable(result)) return result;
        this.#poisoned = true;
        if (result instanceof Promise) void result.catch(noop);
        operationalFailure(
            this.errors,
            "protocol.invalid-state",
            "Cloudflare SQLite transaction callbacks must be synchronous"
        );
    }

    private execute(
        statement: string,
        bindings: readonly SqliteValue[]
    ): CloudflareSqlCursor<Record<string, CloudflareSqlValue>> {
        try {
            return this.storage.sql.exec(statement, ...bindings.map(binding));
        } catch (cause) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Cloudflare SQLite statement preparation failed",
                cause
            );
        }
    }
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
    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value.slice(0));
    }
    if (ArrayBuffer.isView(value)) {
        const start = value.byteOffset;
        const end = start + value.byteLength;
        return new Uint8Array(value.buffer.slice(start, end));
    }
    operationalFailure(
        errors,
        "operation.invalid-output",
        "Cloudflare SQLite returned an unsupported row value"
    );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? typeof (value as { readonly then?: unknown }).then === "function"
        : false;
}

function noop(): void {}

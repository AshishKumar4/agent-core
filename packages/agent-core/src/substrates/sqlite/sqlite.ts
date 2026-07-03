export type SqliteValue = string | number | Uint8Array | null;

export interface SqliteRow {
    readonly [column: string]: SqliteValue;
}

export abstract class TransactionalSqlite {
    public abstract all(
        statement: string,
        bindings: readonly SqliteValue[]
    ): readonly SqliteRow[];

    public abstract run(
        statement: string,
        bindings: readonly SqliteValue[]
    ): void;

    public abstract transaction<Result>(operation: () => Result): Result;
}

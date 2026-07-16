// @ts-nocheck
import type { SynchronousResultGuard } from "../../actors";

export type SqliteValue = string | number | Uint8Array | null;

const sqliteProvenance = new WeakMap<ReadableSqlite, object>();

export interface SqliteRow {
    readonly [column: string]: SqliteValue;
}

export abstract class ReadableSqlite {
    public constructor() {
        sqliteProvenance.set(this, Object.freeze({}));
    }

    public abstract all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[];
}

export abstract class TransactionalSqlite extends ReadableSqlite {
    public constructor() {
        super();
    }

    public abstract run(statement: string, bindings: readonly SqliteValue[]): void;

    public abstract transaction<Result>(
        operation: () => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
}

export function inheritSqliteProvenance(scope: ReadableSqlite, source: ReadableSqlite): void {
    sqliteProvenance.set(scope, requireSqliteProvenance(scope, source));
}

function requireSqliteProvenance(scope: ReadableSqlite, source: ReadableSqlite): object {
    const provenance = sqliteProvenance.get(source);
    if (provenance === undefined || !sqliteProvenance.has(scope)) {
        throw new TypeError("SQLite provenance requires initialized capabilities");
    }
    return provenance;
}

export function hasSameSqliteProvenance(left: ReadableSqlite, right: ReadableSqlite): boolean {
    const provenance = sqliteProvenance.get(left);
    return provenance !== undefined && provenance === sqliteProvenance.get(right);
}

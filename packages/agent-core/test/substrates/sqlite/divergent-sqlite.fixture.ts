import type { SqliteRow, SqliteValue } from "../../../src/substrates/sqlite";
import { TestSqlite } from "../../helpers/sqlite";

export type Divergence = (
    statement: string,
    bindings: readonly SqliteValue[],
    rows: readonly SqliteRow[]
) => readonly SqliteRow[];

/**
 * A substrate that accepts every write and then answers a chosen read differently — a
 * replica that lost a row, an index that outlived its record.
 *
 * Store guards that re-read what they just wrote cannot be reached by varying the inputs to
 * the writers, because the writers already refuse the states those guards reject. They are
 * reachable only when the storage layer itself disagrees with the record, which is exactly
 * the fault they exist to catch.
 *
 * Arm the divergence only after a healthy state is committed: a divergence present during
 * the write is caught by the writer's own read-back instead, which proves a different guard.
 */
export class DivergentSqlite extends TestSqlite {
    #divergence: Divergence | undefined;

    protected override query(
        statement: string,
        bindings: readonly SqliteValue[]
    ): readonly SqliteRow[] {
        const rows = super.query(statement, bindings);
        if (!(#divergence in this) || this.#divergence === undefined) return rows;
        return this.#divergence(statement, bindings, rows);
    }

    public arm(divergence: Divergence): void {
        this.#divergence = divergence;
    }
}

/**
 * Rewrites the rows of exactly one enumeration, leaving point reads answering from the real
 * table. That disagreement between an enumeration and the records it names is what the
 * closure's referential guards are for.
 */
export function onStatement(statement: string, rows: readonly SqliteRow[]): Divergence {
    return (candidate, _bindings, actual) => (candidate === statement ? rows : actual);
}

/** Drops the rows an enumeration would have reported, selected by one column's value. */
export function withoutRow(statement: string, column: string, value: SqliteValue): Divergence {
    return (candidate, _bindings, rows) =>
        candidate === statement ? rows.filter((row) => row[column] !== value) : rows;
}

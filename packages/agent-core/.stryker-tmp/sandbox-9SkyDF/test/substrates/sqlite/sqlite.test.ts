// @ts-nocheck
import { expect, test } from "vitest";
import {
    inheritSqliteProvenance,
    type ReadableSqlite
} from "../../../src/substrates/sqlite/sqlite";
import { TestSqlite } from "../../helpers/sqlite";

test("rejects SQLite provenance transfer involving uninitialized capabilities", () => {
    const database = new TestSqlite();
    const forged = Object.create(null) as ReadableSqlite;

    expect(() => inheritSqliteProvenance(forged, database)).toThrowError(
        new TypeError("SQLite provenance requires initialized capabilities")
    );
    expect(() => inheritSqliteProvenance(database, forged)).toThrowError(
        new TypeError("SQLite provenance requires initialized capabilities")
    );
});

import { expect, test } from "vitest";
import {
    hasSameSqliteProvenance,
    inheritSqliteProvenance,
    type ReadableSqlite
} from "../../../src/substrates/sqlite/sqlite";
import { malformed } from "../../helpers/malformed";
import { TestSqlite } from "../../helpers/sqlite";

test("rejects SQLite provenance transfer involving uninitialized capabilities", { tags: "p0" }, () => {
    const database = new TestSqlite();
    const forged = malformed<ReadableSqlite>({});

    expect(() => inheritSqliteProvenance(forged, database)).toThrowError(
        new TypeError("SQLite provenance requires initialized capabilities")
    );
    expect(() => inheritSqliteProvenance(database, forged)).toThrowError(
        new TypeError("SQLite provenance requires initialized capabilities")
    );
});

test("shares SQLite provenance only across inherited capabilities", { tags: "p0" }, () => {
    const database = new TestSqlite();
    const unrelated = new TestSqlite();
    const forged = malformed<ReadableSqlite>({});

    expect(hasSameSqliteProvenance(database, database)).toBe(true);
    expect(hasSameSqliteProvenance(database, unrelated)).toBe(false);
    expect(hasSameSqliteProvenance(forged, forged)).toBe(false);
    expect(hasSameSqliteProvenance(forged, database)).toBe(false);

    inheritSqliteProvenance(unrelated, database);
    expect(hasSameSqliteProvenance(database, unrelated)).toBe(true);
});

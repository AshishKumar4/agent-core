import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorkspaceId } from "../../src/identity";
import { CatalogEntry } from "../../src/facets/catalog-entry";
import { SqliteWorkspaceCatalogStore } from "../../src/substrates/sqlite/catalog-entry";
import { FacetRef } from "../../src/facets/id";
import { FileSqlite, TestSqlite } from "../helpers/sqlite";
import {
    attributed,
    directDeclaration,
    workspaceCatalogStoreContract
} from "../w3/catalog-store-contract";

workspaceCatalogStoreContract(
    "SQLite",
    (owner) => new SqliteWorkspaceCatalogStore(owner, new TestSqlite())
);

describe("SqliteWorkspaceCatalogStore persistence", () => {
    const directories: string[] = [];

    function temporaryDirectory(): string {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-catalog-"));
        directories.push(directory);
        return directory;
    }

    afterEach(() => {
        for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    });

    test("survives adapter recreation and rejects a different Workspace owner", () => {
        const owner = new WorkspaceId("workspace");
        const database = new TestSqlite();
        const store = new SqliteWorkspaceCatalogStore(owner, database);
        store.declare(directDeclaration("run"));
        store.contribute(attributed("workspace:facet", "1.0.0", "resize"));

        const restarted = new SqliteWorkspaceCatalogStore(owner, database);
        expect(restarted.revision().value).toBe(2);
        expect(restarted.entries().map((entry) => entry.name).sort()).toEqual(["resize", "run"]);
        expect(() => new SqliteWorkspaceCatalogStore(new WorkspaceId("foreign"), database)).toThrow(
            /different Workspace/
        );
    });

    test("[C13-FACET-CONTRIBUTION-ATTRIBUTION] reopens a closed file with byte-identical records (restart parity)", () => {
        const path = join(temporaryDirectory(), "catalog.sqlite");
        const owner = new WorkspaceId("workspace");
        const firstDatabase = new FileSqlite(path);
        const first = new SqliteWorkspaceCatalogStore(owner, firstDatabase);
        first.declare(directDeclaration("run"));
        first.contribute(attributed("workspace:facet", "1.0.0", "resize"));
        const before = [...first.entries()].map(CatalogEntry.encode);
        const revision = first.revision().value;
        firstDatabase.close();

        const reopenedDatabase = new FileSqlite(path);
        try {
            const reopened = new SqliteWorkspaceCatalogStore(owner, reopenedDatabase);
            expect(reopened.revision().value).toBe(revision);
            expect([...reopened.entries()].map(CatalogEntry.encode)).toEqual(before);
            // The reopened store keeps the exact attribution, so its withdrawal query is
            // still the one §4.1 computes.
            expect(reopened.withdraw(new FacetRef("workspace:facet")).value).toBe(revision + 1);
            expect(
                reopened.entries().every((entry) => entry.attribution === undefined)
            ).toBe(true);
        } finally {
            reopenedDatabase.close();
        }
    });

    test("refuses nested transactions and access outside them", () => {
        const database = new TestSqlite();
        const store = new SqliteWorkspaceCatalogStore(new WorkspaceId("workspace"), database);

        expect(() => store.transaction(() => store.transaction(() => 0))).toThrow(
            /Nested SQLite Catalog transactions/
        );
        expect(() => store.loadRevision(new TestSqlite())).toThrow(/owning transaction/);
    });

    test("refuses tampered projections and schema state", () => {
        const owner = new WorkspaceId("workspace");
        const database = new TestSqlite();
        const store = new SqliteWorkspaceCatalogStore(owner, database);
        store.contribute(attributed("workspace:facet", "1.0.0", "resize"));

        database.run("UPDATE facet_catalog_entries SET name = 'forged'", []);
        expect(() => new SqliteWorkspaceCatalogStore(owner, database)).toThrow(
            /projection does not match codec bytes/
        );

        const missingRevision = new TestSqlite();
        new SqliteWorkspaceCatalogStore(owner, missingRevision);
        missingRevision.run("DELETE FROM facet_catalog_revision", []);
        expect(() => new SqliteWorkspaceCatalogStore(owner, missingRevision)).toThrow(/singleton/);

        const unexpectedIndex = new TestSqlite();
        new SqliteWorkspaceCatalogStore(owner, unexpectedIndex);
        unexpectedIndex.run("CREATE INDEX hostile_catalog_index ON facet_catalog_entries (name)", []);
        expect(() => new SqliteWorkspaceCatalogStore(owner, unexpectedIndex)).toThrow(
            /Unexpected SQLite index/
        );
    });
});


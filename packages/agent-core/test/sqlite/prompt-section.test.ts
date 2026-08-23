import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WorkspaceId } from "../../src/identity";
import { Prompt } from "../../src/facets";
import { SqliteWorkspacePromptSectionStore } from "../../src/substrates/sqlite/prompt-section";
import { FileSqlite, TestSqlite } from "../helpers/sqlite";
import { section, workspacePromptStoreContract } from "../w3/prompt-store-contract";
import { attribution } from "../w3/slot-store-contract";

workspacePromptStoreContract(
    "SQLite",
    (owner) => new SqliteWorkspacePromptSectionStore(owner, new TestSqlite())
);

describe("SqliteWorkspacePromptSectionStore persistence", () => {
    test(
        "survives adapter recreation and rejects a different Workspace owner",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const owner = new WorkspaceId("workspace");
            const store = new SqliteWorkspacePromptSectionStore(owner, database);
            store.contribute(attribution("workspace:facet"), [new Prompt("One", "body", 1)]);

            const restarted = new SqliteWorkspacePromptSectionStore(owner, database);
            expect(restarted.assembledSections()).toHaveLength(1);
            expect(restarted.revision().value).toBe(1);
            expect(
                () =>
                    new SqliteWorkspacePromptSectionStore(new WorkspaceId("foreign"), database)
            ).toThrow(/different Workspace/);
        }
    );

    test("survives file close and reopen", { tags: "p1" }, () => {
        const directory = mkdtempSync(join(tmpdir(), "agent-core-prompt-"));
        const path = join(directory, "prompt-section.sqlite");
        try {
            const owner = new WorkspaceId("workspace");
            const firstDatabase = new FileSqlite(path);
            const first = new SqliteWorkspacePromptSectionStore(owner, firstDatabase);
            const held = section("workspace:facet", 0, "Overview");
            first.contribute(attribution("workspace:facet"), [new Prompt("Overview", held.body, held.priority)]);
            firstDatabase.close();

            const reopenedDatabase = new FileSqlite(path);
            try {
                const reopened = new SqliteWorkspacePromptSectionStore(owner, reopenedDatabase);
                expect(reopened.assembledSections()[0]?.id.equals(held.id)).toBe(true);
                expect(reopened.revision().value).toBe(1);
            } finally {
                reopenedDatabase.close();
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("rejects a transaction from another database", { tags: "p0" }, () => {
        const database = new TestSqlite();
        const store = new SqliteWorkspacePromptSectionStore(new WorkspaceId("workspace"), database);
        expect(() => store.loadRevision(new TestSqlite())).toThrow(/owning transaction/);
        expect(() => store.loadRevision(database)).toThrow(/owning transaction/);
    });

    test(
        "rejects precreated weak schemas and projection drift between columns and codec bytes",
        { tags: "p1" },
        () => {
            const weak = new TestSqlite();
            weak.run("CREATE TABLE facet_prompt_sections (id TEXT PRIMARY KEY, record BLOB) STRICT", []);
            expect(() => new SqliteWorkspacePromptSectionStore(new WorkspaceId("workspace"), weak)).toThrow(
                /malformed/
            );

            const database = new TestSqlite();
            const store = new SqliteWorkspacePromptSectionStore(new WorkspaceId("workspace"), database);
            store.contribute(attribution("workspace:facet"), [new Prompt("Overview", "body", 3)]);
            database.run("UPDATE facet_prompt_sections SET contributor = 'workspace:other'", []);
            expect(() => store.assembledSections()).toThrow(/projection does not match/);
        }
    );

    test(
        "rejects partial singleton state and unexpected protected objects on restart",
        { tags: "p0" },
        () => {
            const owner = new WorkspaceId("workspace");

            const missingRevision = new TestSqlite();
            new SqliteWorkspacePromptSectionStore(owner, missingRevision);
            missingRevision.run("DELETE FROM facet_prompt_section_revision", []);
            expect(() => new SqliteWorkspacePromptSectionStore(owner, missingRevision)).toThrow(
                /singleton/
            );

            const unexpectedIndex = new TestSqlite();
            new SqliteWorkspacePromptSectionStore(owner, unexpectedIndex);
            unexpectedIndex.run("CREATE INDEX hostile_prompt_index ON facet_prompt_sections (id)", []);
            expect(() => new SqliteWorkspacePromptSectionStore(owner, unexpectedIndex)).toThrow(
                /Unexpected SQLite index/
            );

            const unexpectedTrigger = new TestSqlite();
            new SqliteWorkspacePromptSectionStore(owner, unexpectedTrigger);
            unexpectedTrigger.run(
                "CREATE TRIGGER hostile_prompt_trigger AFTER INSERT ON facet_prompt_sections BEGIN SELECT 1; END",
                []
            );
            expect(() => new SqliteWorkspacePromptSectionStore(owner, unexpectedTrigger)).toThrow(
                /Unexpected SQLite trigger/
            );
        }
    );

    test(
        "bounds the reopened revision below its own record count as the fabrication it is",
        { tags: "p0" },
        () => {
            const database = new TestSqlite();
            const owner = new WorkspaceId("workspace");
            const store = new SqliteWorkspacePromptSectionStore(owner, database);
            store.contribute(attribution("workspace:facet"), [
                new Prompt("One", "body", 1),
                new Prompt("Two", "body", 2)
            ]);

            // Retirement advances the revision while removing records, so a reopened
            // store can only bound the revision from below.
            database.run("UPDATE facet_prompt_section_revision SET revision = 0", []);
            expect(() => new SqliteWorkspacePromptSectionStore(owner, database)).toThrow(
                /revision does not match its records/
            );
            expect(store.assembledSections().map((held) => held.title)).toEqual(["One", "Two"]);
        }
    );
});

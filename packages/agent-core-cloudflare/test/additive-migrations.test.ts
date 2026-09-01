import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as cloudflare from "../src/index.js";
import {
    cloudflareRuntimeMigrations,
    environmentProviderMigration,
    placementRegistryMigration,
    runHostingMigration,
    slateProviderMigration,
    type SqliteApplicationMigration
} from "../src/index.js";

const gate = resolve(import.meta.dirname, "../scripts/check-additive-migrations.mjs");

/** The schema an earlier release owns; every case below is the release that follows it. */
const base: SqliteApplicationMigration = Object.freeze({
    version: 1,
    name: "base",
    statements: Object.freeze([
        `CREATE TABLE base_rows (
            id TEXT PRIMARY KEY,
            note TEXT NOT NULL,
            spare TEXT
        ) STRICT`,
        "CREATE INDEX base_rows_note ON base_rows (note)"
    ])
});

function next(name: string, ...statements: readonly string[]): SqliteApplicationMigration {
    return Object.freeze({ version: 2, name, statements: Object.freeze([...statements]) });
}

async function runGate(
    migrations: readonly SqliteApplicationMigration[]
): Promise<{ readonly status: number | null; readonly output: string }> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-additive-"));
    try {
        const modulePath = resolve(root, "migrations.mjs");
        await writeFile(
            modulePath,
            `export const cloudflareRuntimeMigrations = ${JSON.stringify(migrations, null, 4)};\n`,
            "utf8"
        );
        const result = spawnSync(process.execPath, [gate, modulePath], { encoding: "utf8" });
        if (result.error !== undefined) throw result.error;
        return { status: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

describe("additive-only migration gate", () => {
    test("[C13-CLOUDFLARE-ADDITIVE-MIGRATION] accepts the migrations this package declares", async () => {
        const declared = [
            ...cloudflareRuntimeMigrations,
            environmentProviderMigration(cloudflareRuntimeMigrations.length + 1),
            placementRegistryMigration(cloudflareRuntimeMigrations.length + 2),
            runHostingMigration(cloudflareRuntimeMigrations.length + 3),
            slateProviderMigration(cloudflareRuntimeMigrations.length + 4)
        ];
        // The gate enumerates factories out of the built package by export name, so the
        // list above must stay the whole set rather than the four that existed once.
        expect(
            Object.keys(cloudflare)
                .filter((name) => name.endsWith("Migration"))
                .sort()
        ).toEqual([
            "environmentProviderMigration",
            "placementRegistryMigration",
            "runHostingMigration",
            "slateProviderMigration"
        ]);

        const { status, output } = await runGate(declared);
        expect(output).toContain("additive-only verified");
        expect(status).toBe(0);
    });

    test("[C13-CLOUDFLARE-ADDITIVE-MIGRATION] accepts additions that leave the previous release readable", async () => {
        const { status, output } = await runGate([
            base,
            next(
                "additive",
                "CREATE TABLE base_extra (id TEXT PRIMARY KEY, weight INTEGER NOT NULL) STRICT",
                "CREATE UNIQUE INDEX base_extra_weight ON base_extra (weight)",
                "ALTER TABLE base_rows ADD COLUMN added TEXT",
                "CREATE INDEX base_rows_spare ON base_rows (spare)",
                "INSERT INTO base_extra (id, weight) VALUES ('seed', 1)"
            )
        ]);
        expect(output).toContain("additive-only verified: 2 declared migration(s)");
        expect(status).toBe(0);
    });

    test(
        "[C13-CLOUDFLARE-ADDITIVE-MIGRATION] rejects every way a release can stop being readable by its predecessor",
        { tags: "p0" },
        async () => {
            const cases: readonly (readonly [SqliteApplicationMigration, string])[] = [
                [
                    next("drops-table", "DROP TABLE base_rows"),
                    "migration 2 (drops-table) removes table base_rows"
                ],
                [
                    next("drops-index", "DROP INDEX base_rows_note"),
                    "migration 2 (drops-index) removes index base_rows_note"
                ],
                [
                    next("drops-column", "ALTER TABLE base_rows DROP COLUMN spare"),
                    "migration 2 (drops-column) removes column base_rows.spare"
                ],
                [
                    next("renames-table", "ALTER TABLE base_rows RENAME TO base_records"),
                    "migration 2 (renames-table) removes table base_rows"
                ],
                [
                    next("renames-column", "ALTER TABLE base_rows RENAME COLUMN spare TO extra"),
                    "migration 2 (renames-column) removes column base_rows.spare"
                ],
                [
                    next("deletes-rows", "DELETE FROM base_rows"),
                    "migration 2 (deletes-rows) writes table base_rows, which an earlier release owns"
                ],
                [
                    next("rewrites-rows", "UPDATE base_rows SET note = 'rewritten'"),
                    "migration 2 (rewrites-rows) writes table base_rows, which an earlier release owns"
                ],
                [
                    next("inserts-rows", "INSERT INTO base_rows (id, note) VALUES ('x', 'y')"),
                    "migration 2 (inserts-rows) writes table base_rows, which an earlier release owns"
                ],
                [
                    next(
                        "narrows-uniqueness",
                        "CREATE UNIQUE INDEX base_rows_spare ON base_rows (spare)"
                    ),
                    "migration 2 (narrows-uniqueness) adds unique index base_rows_spare to existing table base_rows"
                ],
                [
                    next(
                        "adds-required-column",
                        "ALTER TABLE base_rows ADD COLUMN required TEXT NOT NULL"
                    ),
                    "migration 2 (adds-required-column) adds column base_rows.required, which release N-1 cannot omit"
                ],
                [
                    next(
                        "declares-trigger",
                        "CREATE TRIGGER base_rows_guard BEFORE INSERT ON base_rows BEGIN SELECT RAISE(ABORT, 'closed'); END"
                    ),
                    "migration 2 (declares-trigger) declares trigger base_rows_guard"
                ],
                [
                    next(
                        "hides-a-second-statement",
                        "CREATE TABLE base_more (id TEXT PRIMARY KEY) STRICT; DELETE FROM base_rows"
                    ),
                    "migration 2 (hides-a-second-statement) carries more than one statement in one entry"
                ],
                [
                    next("rebuilds-table", "CREATE TABLE base_rows (id TEXT PRIMARY KEY) STRICT"),
                    "migration 2 (rebuilds-table) has a statement that failed to apply"
                ]
            ];

            for (const [migration, expected] of cases) {
                const { status, output } = await runGate([base, migration]);
                expect(output, `${migration.name} must be reported`).toContain(expected);
                expect(status, `${migration.name} must fail the gate`).toBe(1);
            }
        }
    );
});

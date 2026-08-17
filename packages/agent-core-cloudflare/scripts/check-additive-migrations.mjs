import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    isJsonObject,
    isNonEmptyString
} from "../../agent-core/scripts/quality/project.mjs";

/**
 * Additive-only migration gate for the Cloudflare profile (SPEC §10.4).
 *
 * A release may only add to the schema its predecessor reads, so that rolling back one
 * release is always recoverable. The gate proves that property against real SQLite
 * rather than by reading statements for forbidden words: each declared migration is
 * applied to the schema its predecessors produced, and the schema before and after is
 * compared object by object and column by column. Statements are additionally analyzed
 * through SQLite's own query planner, which is what catches a statement that rewrites
 * rows an earlier release wrote without changing any schema at all.
 *
 * Usage: node ./scripts/check-additive-migrations.mjs [module]
 * The module defaults to the built package and must export `cloudflareRuntimeMigrations`
 * plus, optionally, per-facet `*Migration(version)` factories.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ?? "./dist/index.js";
const module = await import(pathToFileURL(resolve(packageRoot, target)).href);
const migrations = declaredMigrations(module);
const violations = additiveViolations(migrations);

if (violations.length > 0) {
    console.error(
        `${violations.length} non-additive migration statement(s) in ${target}:\n${violations
            .map((violation) => `  - ${violation}`)
            .join("\n")}`
    );
    process.exit(1);
}
console.log(
    `additive-only verified: ${migrations.length} declared migration(s), ` +
        `${migrations.reduce((total, migration) => total + migration.statements.length, 0)} statement(s)`
);

/**
 * Every migration the package declares, in the order a deployment applies them: the
 * runtime set first, then each facet factory at the next version. Factories are found by
 * their exported name so a new one is covered without being registered here.
 */
function declaredMigrations(source) {
    const runtime = source.cloudflareRuntimeMigrations;
    if (!Array.isArray(runtime) || runtime.length === 0) {
        throw new TypeError(`${target} exports no cloudflareRuntimeMigrations`);
    }
    const declared = runtime.map((migration) => requireMigration(migration, target));
    const factories = Object.entries(source)
        .filter(([name, value]) => name.endsWith("Migration") && value instanceof Function)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (const [name, factory] of factories) {
        const version = declared.length + 1;
        const migration = requireMigration(factory(version), name);
        if (migration.version !== version) {
            throw new TypeError(`${name} returned version ${migration.version}, not ${version}`);
        }
        declared.push(migration);
    }
    return declared;
}

function requireMigration(migration, origin) {
    if (
        !isJsonObject(migration) ||
        !Number.isSafeInteger(migration.version) ||
        !isNonEmptyString(migration.name) ||
        !Array.isArray(migration.statements) ||
        !migration.statements.every((statement) => isNonEmptyString(statement))
    ) {
        throw new TypeError(`${origin} declares a migration this gate cannot read`);
    }
    return migration;
}

function additiveViolations(declared) {
    const database = new DatabaseSync(":memory:");
    const violations = [];
    try {
        let before = snapshot(database);
        for (const migration of declared) {
            const label = `migration ${migration.version} (${migration.name})`;
            for (const statement of migration.statements) {
                violations.push(...writesOwnedByEarlierRelease(database, statement, before, label));
                try {
                    database.exec(statement);
                } catch (error) {
                    // The schema is unknowable past a statement that did not apply, so the
                    // report stops here rather than blaming later migrations for it.
                    violations.push(
                        `${label} has a statement that failed to apply: ${error.message}`
                    );
                    return violations;
                }
            }
            const after = snapshot(database);
            violations.push(...removed(before, after, label), ...narrowed(before, after, label));
            before = after;
        }
    } finally {
        database.close();
    }
    return violations;
}

/** The schema as SQLite itself reports it, which is the only shape a release can read. */
function snapshot(database) {
    const objects = new Map();
    const names = new Map();
    const rows = database
        .prepare(
            `SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master
                WHERE name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all();
    for (const row of rows) {
        objects.set(`${row.type}:${row.name}`, {
            type: row.type,
            name: row.name,
            table: row.tbl_name,
            sql: String(row.sql ?? "")
                .replaceAll(/\s+/gu, " ")
                .trim()
        });
        if (Number.isSafeInteger(row.rootpage) && row.rootpage > 1) {
            names.set(row.rootpage, `${row.type} ${row.name}`);
        }
    }
    const columns = new Map();
    const uniqueIndexes = new Set();
    for (const { name } of rows.filter((row) => row.type === "table")) {
        const table = new Map();
        for (const column of database.prepare("SELECT * FROM pragma_table_info(?)").all(name)) {
            table.set(String(column.name), {
                type: String(column.type),
                notnull: column.notnull === 1,
                dflt: column.dflt_value === null ? null : String(column.dflt_value),
                pk: Number(column.pk)
            });
        }
        columns.set(name, table);
        for (const index of database.prepare("SELECT * FROM pragma_index_list(?)").all(name)) {
            if (index.unique === 1) uniqueIndexes.add(String(index.name));
        }
    }
    return { objects, columns, uniqueIndexes, names };
}

/** Anything release N-1 reads that this migration took away or redefined. */
function removed(before, after, label) {
    const violations = [];
    for (const [key, object] of before.objects) {
        const current = after.objects.get(key);
        if (current === undefined) {
            violations.push(`${label} removes ${object.type} ${object.name}`);
            continue;
        }
        // A table's own text changes when a column is added, which is additive; its shape
        // is compared column by column below. Everything else is compared as declared,
        // since an index or view can only change by being replaced.
        if (
            current.table !== object.table ||
            (object.type !== "table" && current.sql !== object.sql)
        ) {
            violations.push(`${label} redefines ${object.type} ${object.name}`);
        }
    }
    for (const [table, columns] of before.columns) {
        const current = after.columns.get(table);
        if (current === undefined) continue;
        for (const [name, column] of columns) {
            const now = current.get(name);
            if (now === undefined) {
                violations.push(`${label} removes column ${table}.${name}`);
                continue;
            }
            if (
                now.type !== column.type ||
                now.notnull !== column.notnull ||
                now.dflt !== column.dflt ||
                now.pk !== column.pk
            ) {
                violations.push(`${label} changes column ${table}.${name}`);
            }
        }
    }
    return violations;
}

/**
 * Additions that narrow what release N-1 may still write: a column it cannot omit, a
 * uniqueness constraint it does not know about, or a trigger it never fired. A trigger is
 * refused wherever it lands, because a statement carrying one cannot be told apart from
 * two statements sharing an entry, and this profile's schema is tables and indexes.
 */
function narrowed(before, after, label) {
    const violations = [];
    for (const [table, columns] of after.columns) {
        const previous = before.columns.get(table);
        if (previous === undefined) continue;
        for (const [name, column] of columns) {
            if (previous.has(name)) continue;
            if (column.notnull && column.dflt === null) {
                violations.push(
                    `${label} adds column ${table}.${name}, which release N-1 cannot omit`
                );
            }
        }
    }
    for (const [key, object] of after.objects) {
        if (before.objects.has(key)) continue;
        if (object.type === "trigger") {
            violations.push(`${label} declares trigger ${object.name}`);
            continue;
        }
        if (
            object.type === "index" &&
            after.uniqueIndexes.has(object.name) &&
            before.columns.has(object.table)
        ) {
            violations.push(
                `${label} adds unique index ${object.name} to existing table ${object.table}`
            );
        }
    }
    return violations;
}

/**
 * What the statement would write, read out of SQLite's compiled program: `OpenWrite`
 * names the object a statement writes rows to, and `Clear` and `Destroy` name the one it
 * empties or deletes. A statement may write only what its own release created, so the
 * root pages that existed before this migration are the ones it must not touch.
 */
function writesOwnedByEarlierRelease(database, statement, before, label) {
    if (/;\s*\S/u.test(statement)) {
        return [`${label} carries more than one statement in one entry, which is not analyzable`];
    }
    let program;
    try {
        program = database.prepare(`EXPLAIN ${statement}`).all();
    } catch (error) {
        return [`${label} has a statement SQLite cannot compile: ${error.message}`];
    }
    const touched = new Set();
    for (const step of program) {
        const opcode = String(step.opcode);
        const rootpage =
            opcode === "OpenWrite"
                ? step.p2
                : opcode === "Clear" || opcode === "Destroy"
                  ? step.p1
                  : undefined;
        if (Number.isSafeInteger(rootpage) && before.names.has(rootpage)) touched.add(rootpage);
    }
    return [...touched].map(
        (rootpage) => `${label} writes ${before.names.get(rootpage)}, which an earlier release owns`
    );
}

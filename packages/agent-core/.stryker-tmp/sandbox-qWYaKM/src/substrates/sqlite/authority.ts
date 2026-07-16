// @ts-nocheck
import { Grant, GrantId, ScopeEpoch, scopeKey, subjectKey } from "../../authority";
import { AgentCoreError } from "../../errors";
import type { ScopeRef } from "../../identity";
import type { SqliteRow, SqliteValue } from "./sqlite";
import { ReadableSqlite, TransactionalSqlite } from "./sqlite";

const CREATE_GRANTS = `CREATE TABLE IF NOT EXISTS tenant_grants (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    subject_key TEXT NOT NULL CHECK (length(subject_key) > 0),
    effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    parent_grant_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    record BLOB NOT NULL,
    CHECK (effect = 'allow' OR parent_grant_id IS NULL)
) STRICT`;

const CREATE_GRANT_SCOPE_INDEX = `CREATE INDEX IF NOT EXISTS tenant_grants_scope_subject
    ON tenant_grants (scope_key, subject_key, state)`;

const CREATE_SCOPE_EPOCHS = `CREATE TABLE IF NOT EXISTS tenant_scope_epochs (
    scope_key TEXT PRIMARY KEY CHECK (length(scope_key) > 0),
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    record BLOB NOT NULL
) STRICT`;

export function initializeSqliteAuthoritySchema(database: TransactionalSqlite): void {
    runAuthorityWrite(database, CREATE_GRANTS, []);
    runAuthorityWrite(database, CREATE_GRANT_SCOPE_INDEX, []);
    runAuthorityWrite(database, CREATE_SCOPE_EPOCHS, []);
}

export function loadSqliteGrant(database: ReadableSqlite, id: GrantId): Grant | undefined {
    const row = readAuthority(database, "SELECT * FROM tenant_grants WHERE id = ?", [id.value])[0];
    return row === undefined ? undefined : decodeGrant(row, id);
}

export function listSqliteGrants(database: ReadableSqlite): readonly Grant[] {
    return Object.freeze(
        readAuthority(database, "SELECT * FROM tenant_grants ORDER BY id", []).map((row) =>
            decodeGrant(row, new GrantId(text(row, "id")))
        )
    );
}

export function saveSqliteGrant(database: TransactionalSqlite, grant: Grant): void {
    const previous = loadSqliteGrant(database, grant.id);
    if (previous !== undefined) {
        if (equalBytes(Grant.encode(previous), Grant.encode(grant))) return;
        previous.assertCanReplace(grant);
    }
    runAuthorityWrite(
        database,
        `INSERT INTO tenant_grants (
            id, scope_key, subject_key, effect, parent_grant_id, state, record
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET scope_key = excluded.scope_key,
            subject_key = excluded.subject_key, effect = excluded.effect,
            parent_grant_id = excluded.parent_grant_id, state = excluded.state,
            record = excluded.record`,
        [
            grant.id.value,
            scopeKey(grant.scope),
            subjectKey(grant.subject),
            grant.effect,
            grant.attenuationOf?.value ?? null,
            grant.state.name,
            Grant.encode(grant)
        ]
    );
    const stored = loadSqliteGrant(database, grant.id);
    if (stored === undefined || !equalBytes(Grant.encode(stored), Grant.encode(grant))) {
        throw new AgentCoreError("protocol.revision-conflict", "Grant changed concurrently");
    }
}

export function loadSqliteEpoch(database: ReadableSqlite, scope: ScopeRef): ScopeEpoch {
    const key = scopeKey(scope);
    const row = readAuthority(database, "SELECT * FROM tenant_scope_epochs WHERE scope_key = ?", [
        key
    ])[0];
    if (row === undefined) return ScopeEpoch.initial(scope);
    const epoch = ScopeEpoch.decode(bytes(row, "record").slice());
    if (
        scopeKey(epoch.scope) !== key ||
        scopeKey(epoch.scope) !== text(row, "scope_key") ||
        epoch.epoch !== integer(row, "epoch")
    ) {
        throw corruptAuthority();
    }
    return epoch;
}

export function listSqliteEpochs(database: ReadableSqlite): readonly ScopeEpoch[] {
    return Object.freeze(
        readAuthority(database, "SELECT * FROM tenant_scope_epochs ORDER BY scope_key", []).map(
            (row) => {
                const epoch = ScopeEpoch.decode(bytes(row, "record").slice());
                if (
                    scopeKey(epoch.scope) !== text(row, "scope_key") ||
                    epoch.epoch !== integer(row, "epoch")
                ) {
                    throw corruptAuthority();
                }
                return epoch;
            }
        )
    );
}

export function saveSqliteEpoch(database: TransactionalSqlite, epoch: ScopeEpoch): void {
    const previous = loadSqliteEpoch(database, epoch.scope);
    if (epoch.epoch === previous.epoch) return;
    if (epoch.epoch !== previous.epoch + 1) {
        throw new AgentCoreError(
            "protocol.revision-conflict",
            "Scope epoch writes must advance exactly once"
        );
    }
    runAuthorityWrite(
        database,
        `INSERT INTO tenant_scope_epochs (scope_key, epoch, record) VALUES (?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET epoch = excluded.epoch, record = excluded.record
         WHERE tenant_scope_epochs.epoch = excluded.epoch - 1`,
        [scopeKey(epoch.scope), epoch.epoch, ScopeEpoch.encode(epoch)]
    );
    if (!loadSqliteEpoch(database, epoch.scope).equals(epoch)) {
        throw new AgentCoreError("protocol.revision-conflict", "Scope epoch changed concurrently");
    }
}

function decodeGrant(row: SqliteRow, expectedId: GrantId): Grant {
    const grant = Grant.decode(bytes(row, "record").slice());
    if (
        !grant.id.equals(expectedId) ||
        expectedId.value !== text(row, "id") ||
        scopeKey(grant.scope) !== text(row, "scope_key") ||
        subjectKey(grant.subject) !== text(row, "subject_key") ||
        grant.effect !== text(row, "effect") ||
        (grant.attenuationOf?.value ?? null) !== nullableText(row, "parent_grant_id") ||
        grant.state.name !== text(row, "state")
    ) {
        throw corruptAuthority();
    }
    return grant;
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0) throw corruptAuthority();
    return value;
}

function nullableText(row: SqliteRow, column: string): string | null {
    const value = row[column];
    if (value === null) return null;
    if (typeof value !== "string" || value.length === 0) throw corruptAuthority();
    return value;
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw corruptAuthority();
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) throw corruptAuthority();
    return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function runAuthorityWrite(
    database: TransactionalSqlite,
    statement: string,
    bindings: Parameters<TransactionalSqlite["run"]>[1]
): void {
    try {
        database.run(statement, bindings);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError("protocol.revision-conflict", "Authority write failed");
    }
}

function readAuthority(
    database: ReadableSqlite,
    statement: string,
    bindings: readonly SqliteValue[]
): readonly SqliteRow[] {
    try {
        return database.all(statement, bindings);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError("codec.invalid", "Authority read failed");
    }
}

function corruptAuthority(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored Tenant authority state is malformed");
}

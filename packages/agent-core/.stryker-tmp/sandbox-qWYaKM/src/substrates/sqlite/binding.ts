// @ts-nocheck
import {
    Binding,
    domainKey,
    scopeKey as authorityScopeKey,
    subjectKey as authoritySubjectKey,
    type BindingStore
} from "../../authority";
import { AgentCoreError } from "../../errors";
import type { ScopeRef } from "../../identity";
import type { SqliteRow, SqliteValue } from "./sqlite";
import { TransactionalSqlite } from "./sqlite";

const CREATE_BINDINGS = `CREATE TABLE IF NOT EXISTS workspace_bindings (
    binding_key TEXT PRIMARY KEY CHECK (length(binding_key) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    subject_key TEXT NOT NULL CHECK (length(subject_key) > 0),
    domain_key TEXT NOT NULL CHECK (length(domain_key) > 0),
    name TEXT NOT NULL CHECK (length(name) > 0),
    grant_id TEXT NOT NULL CHECK (length(grant_id) > 0),
    facet_ref TEXT NOT NULL CHECK (length(facet_ref) > 0),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'inactive')),
    record BLOB NOT NULL
) STRICT`;

const CREATE_BINDING_LOOKUP = `CREATE UNIQUE INDEX IF NOT EXISTS workspace_binding_lookup
    ON workspace_bindings (subject_key, domain_key, name)`;

export class SqliteBindingStore implements BindingStore {
    public constructor(
        private readonly database: TransactionalSqlite,
        private readonly workspaceScope: ScopeRef
    ) {
        if (workspaceScope.kind !== "workspace") {
            throw new TypeError("SQLite Binding stores require a Workspace Scope");
        }
        try {
            database.transaction(() => {
                database.run(CREATE_BINDINGS, []);
                database.run(CREATE_BINDING_LOOKUP, []);
            });
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Binding schema initialization failed"
            );
        }
        this.list();
    }

    public load(key: string): Binding | undefined {
        const row = readBindings(
            this.database,
            "SELECT * FROM workspace_bindings WHERE binding_key = ?",
            [key]
        )[0];
        if (row === undefined) return undefined;
        const binding = decodeBinding(row, key);
        if (!binding.scope.equals(this.workspaceScope)) throw corruptBinding();
        return binding;
    }

    public list(): readonly Binding[] {
        const bindings = readBindings(
            this.database,
            "SELECT * FROM workspace_bindings ORDER BY binding_key",
            []
        ).map((row) => decodeBinding(row, text(row, "binding_key")));
        if (bindings.some((binding) => !binding.scope.equals(this.workspaceScope))) {
            throw corruptBinding();
        }
        return Object.freeze(bindings);
    }

    public save(binding: Binding): void {
        try {
            this.database.transaction(() => this.saveInTransaction(binding));
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError("protocol.revision-conflict", "Binding write failed");
        }
    }

    private saveInTransaction(binding: Binding): void {
        if (!binding.scope.equals(this.workspaceScope)) {
            throw new AgentCoreError(
                "binding.invalid",
                "Binding belongs to another Workspace store"
            );
        }
        const previous = this.load(binding.key);
        if (previous === undefined) {
            if (binding.generation !== 0 || binding.revision.value !== 0) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "New Bindings require generation and revision zero"
                );
            }
            this.database.run(
                `INSERT INTO workspace_bindings (
                    binding_key, scope_key, subject_key, domain_key, name, grant_id, facet_ref,
                    generation, revision, state, record
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                projections(binding)
            );
        } else {
            const previousBytes = Binding.encode(previous);
            const nextBytes = Binding.encode(binding);
            if (bytesEqual(previousBytes, nextBytes)) return;
            previous.assertCanReplace(binding);
            this.database.run(
                `UPDATE workspace_bindings SET grant_id = ?, facet_ref = ?, generation = ?,
                    revision = ?, state = ?, record = ?
                 WHERE binding_key = ? AND generation = ? AND revision = ?`,
                [
                    binding.grantId.value,
                    binding.facet.value,
                    binding.generation,
                    binding.revision.value,
                    binding.state,
                    nextBytes,
                    binding.key,
                    previous.generation,
                    previous.revision.value
                ]
            );
        }
        const stored = this.load(binding.key);
        if (stored === undefined || !bytesEqual(Binding.encode(stored), Binding.encode(binding))) {
            throw new AgentCoreError("protocol.revision-conflict", "Binding changed concurrently");
        }
    }
}

function projections(binding: Binding): readonly (string | number | Uint8Array)[] {
    return [
        binding.key,
        authorityScopeKey(binding.scope),
        authoritySubjectKey(binding.subject),
        domainKey(binding.domain),
        binding.name.value,
        binding.grantId.value,
        binding.facet.value,
        binding.generation,
        binding.revision.value,
        binding.state,
        Binding.encode(binding)
    ];
}

function decodeBinding(row: SqliteRow, expectedKey: string): Binding {
    const binding = Binding.decode(bytes(row, "record").slice());
    if (
        binding.key !== expectedKey ||
        binding.key !== text(row, "binding_key") ||
        authorityScopeKey(binding.scope) !== text(row, "scope_key") ||
        authoritySubjectKey(binding.subject) !== text(row, "subject_key") ||
        domainKey(binding.domain) !== text(row, "domain_key") ||
        binding.name.value !== text(row, "name") ||
        binding.grantId.value !== text(row, "grant_id") ||
        binding.facet.value !== text(row, "facet_ref") ||
        binding.generation !== integer(row, "generation") ||
        binding.revision.value !== integer(row, "revision") ||
        binding.state !== text(row, "state")
    ) {
        throw corruptBinding();
    }
    return binding;
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0) throw corruptBinding();
    return value;
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw corruptBinding();
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) throw corruptBinding();
    return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function readBindings(
    database: TransactionalSqlite,
    statement: string,
    bindings: readonly SqliteValue[]
): readonly SqliteRow[] {
    try {
        return database.all(statement, bindings);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError("codec.invalid", "Binding read failed");
    }
}

function corruptBinding(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored Workspace Binding is malformed");
}

// The row sweep screens the storage layer, not the store's own writers: every writer
// already refuses the states its guards reject, so no sequence of API calls can reach them.
// What reaches them is a substrate that accepts a write and then answers a later read
// differently — a replica that lost a row, an index that outlived its record.
// DivergentSqlite is that substrate, armed one statement at a time so each test leaves
// exactly one guard clause as the only thing standing between the store and corrupt rows.
//
// Every clause here throws the same error, so asserting the error alone would pass while
// the clause is disabled and a neighbour catches the same state. Each test therefore arms a
// divergence that no other clause inspects. The record-level authority closure is exercised
// in test/authority; these tests cover only the SQLite row sweep a reopen runs.
import { describe, expect, test } from "vitest";
import { ActorId } from "../../../src/actors";
import { Revision } from "../../../src/core";
import { PrincipalId, Tenant, TenantId } from "../../../src/identity";
import { createSqliteTenantControlStore } from "../../../src/substrates/sqlite/tenant";
import { DivergentSqlite, onStatement } from "./divergent-sqlite.fixture";

const tenantId = new TenantId("row-sweep-tenant");
const principalId = new PrincipalId("row-sweep-owner");
const foreignTenantId = new TenantId("row-sweep-alien");
const anchor = {
    actorId: new ActorId("row-sweep-actor"),
    tenantId,
    principalId,
    tenantKind: "organization" as const,
    trustAnchor: Uint8Array.of(7, 7, 7)
};

// Only the control closure's own diagnosis. The identity reader raises "Tenant identity
// state is malformed" under the same code, so matching the code alone would let a decode
// failure stand in for the guard under test.
const corrupt = {
    code: "codec.invalid",
    message: "Stored Tenant control state is malformed"
};

function bootstrapped(): DivergentSqlite {
    const database = new DivergentSqlite();
    const store = createSqliteTenantControlStore(database, anchor);
    database.transaction(() => store.bootstrapTenant(database, anchor, Revision.initial()));
    return database;
}

// Reopening runs the row sweep over stored state without any writer in the way.
function expectCorrupt(database: DivergentSqlite): void {
    expect(() => createSqliteTenantControlStore(database)).toThrow(
        expect.objectContaining(corrupt)
    );
}

describe("SQLite Tenant control row sweep guards", () => {
    test(
        "rejects a Tenant enumeration naming a row the record read cannot produce",
        { tags: "p0" },
        () => {
            const database = bootstrapped();
            database.arm(
                onStatement("SELECT id FROM tenant_identities ORDER BY id", [
                    { id: "row-sweep-ghost-tenant" }
                ])
            );

            expectCorrupt(database);
        }
    );

    test("rejects a stored Tenant row owned by another Tenant identity", { tags: "p0" }, () => {
        const database = bootstrapped();
        const alien = new Tenant(foreignTenantId, "organization", "active", Revision.initial());
        database.run(
            `INSERT INTO tenant_identities (id, kind, status, revision, record)
             VALUES (?, ?, ?, ?, ?)`,
            [foreignTenantId.value, alien.kind, alien.status, 0, Tenant.encode(alien)]
        );
        // The enumeration reports one row, so the arity guard passes and the identity
        // comparison is the only guard left holding.
        database.arm(
            onStatement("SELECT id FROM tenant_identities ORDER BY id", [
                { id: foreignTenantId.value }
            ])
        );

        expectCorrupt(database);
    });

    test(
        "rejects a Principal enumeration naming a row the record read cannot produce",
        { tags: "p0" },
        () => {
            const database = bootstrapped();
            database.arm((statement, _bindings, rows) =>
                statement === "SELECT id FROM tenant_principals ORDER BY id"
                    ? [...rows, { id: "row-sweep-ghost-principal" }]
                    : rows
            );

            expectCorrupt(database);
        }
    );

    test(
        "rejects a Role enumeration naming a row the record read cannot produce",
        { tags: "p0" },
        () => {
            const database = bootstrapped();
            database.arm((statement, _bindings, rows) =>
                statement === "SELECT name FROM tenant_roles ORDER BY name"
                    ? [...rows, { name: "row-sweep-ghost-role" }]
                    : rows
            );

            expectCorrupt(database);
        }
    );
});

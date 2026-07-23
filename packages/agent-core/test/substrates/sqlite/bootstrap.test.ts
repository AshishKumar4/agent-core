import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import { ContentRef, Digest, Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { PrincipalId, PrincipalRef, TenantId } from "../../../src/identity";
import { AuditRecordCodec } from "../../../src/invocations";
import {
    CommandAuthenticator,
    CommandEnvelope,
    CommandEnvelopeCodec,
    tenantBootstrapPayload,
    type CommandCaller,
    type TenantBootstrapAnchor
} from "../../../src/protocol";
import { createSqliteTenantBootstrap, type SqliteValue } from "../../../src/substrates";
import { TestSqlite } from "../../helpers/sqlite";
import { CounterContentStore } from "../../protocol/counter-fixture";

const actor = new ActorRef("tenant", new ActorId("sqlite-bootstrap-actor"));
const tenantId = new TenantId("sqlite-bootstrap-tenant");
const principalId = new PrincipalId("sqlite-bootstrap-owner");
const anchor: TenantBootstrapAnchor = Object.freeze({
    actorId: actor.id,
    tenantId,
    principalId,
    tenantKind: "organization" as const,
    trustAnchor: Uint8Array.of(7, 8, 9)
});
const caller: CommandCaller = {
    kind: "principal",
    principal: new PrincipalRef(tenantId, principalId)
};
const ownerTransport = Symbol("sqlite-bootstrap-owner");

class OwnerAuthenticator extends CommandAuthenticator<symbol> {
    public constructor() {
        super(tenantId);
    }

    protected authenticateTransport(transport: symbol): CommandCaller | undefined {
        return transport === ownerTransport ? caller : undefined;
    }
}

class StatementFaultSqlite extends TestSqlite {
    public onRun: ((statement: string) => "skip" | undefined) | undefined;
    public onAll: ((statement: string) => void) | undefined;

    public override run(statement: string, bindings: readonly SqliteValue[]): void {
        if (this.onRun?.(statement) === "skip") return;
        super.run(statement, bindings);
    }

    public override all(statement: string, bindings: readonly SqliteValue[]) {
        this.onAll?.(statement);
        return super.all(statement, bindings);
    }
}

class AnchorVanishSqlite extends TestSqlite {
    #anchorReads = 0;
    public vanishAfter: number | undefined;

    public override all(statement: string, bindings: readonly SqliteValue[]) {
        if (this.vanishAfter !== undefined && statement.includes("FROM tenant_bootstrap_anchor")) {
            this.#anchorReads += 1;
            if (this.#anchorReads > this.vanishAfter) return [];
        }
        return super.all(statement, bindings);
    }
}

function bootstrap(database: TestSqlite, content: CounterContentStore, withAnchor = true) {
    return createSqliteTenantBootstrap({
        actor,
        ...(withAnchor ? { anchor } : {}),
        authenticator: new OwnerAuthenticator(),
        content,
        database
    });
}

function envelope(content: CounterContentStore, key: string): Uint8Array {
    const payload = tenantBootstrapPayload();
    const digest = Digest.sha256(payload);
    const ref = ContentRef.fromDigest(digest);
    content.install(ref.value, payload);
    return CommandEnvelopeCodec.encode(
        new CommandEnvelope({
            command: "tenant.bootstrap",
            caller,
            idempotencyKey: key,
            expectedRevision: Revision.initial(),
            payload: ref,
            payloadDigest: digest
        })
    );
}

function content(): CounterContentStore {
    return new CounterContentStore(() => undefined);
}

describe("SQLite Tenant bootstrap exact failure and identity behavior", () => {
    test("fails closed with the exact error when the anchor vanishes under the composition", { tags: "p0" }, () => {
        const database = new AnchorVanishSqlite();
        bootstrap(database, content());
        // The control store reads the anchor twice while reopening; the third
        // read is the composition's own re-check, which must fail closed.
        database.vanishAfter = 2;

        expect(() => bootstrap(database, content(), false)).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "SQLite Tenant bootstrap anchor is missing"
            })
        );
    });

    test("preserves a typed protocol ID initialization failure exactly", { tags: "p1" }, () => {
        const database = new StatementFaultSqlite();
        database.onRun = (statement) => {
            if (statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_bootstrap_protocol_ids")) {
                throw new AgentCoreError("codec.invalid", "injected bootstrap ID schema fault");
            }
            return undefined;
        };

        expect(() => bootstrap(database, content())).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "injected bootstrap ID schema fault"
            })
        );
    });

    test("stamps every protocol ID with its record-kind prefix", { tags: "p1" }, async () => {
        const database = new TestSqlite();
        const store = content();
        const composition = bootstrap(database, store);

        const result = await composition.dispatch(envelope(store, "prefix-key"), ownerTransport);

        expect(result.outcome).toBe("committed");
        expect(result.write.id.value).toMatch(/^write-\d+$/);
        expect(result.write.audit.value).toMatch(/^audit-\d+$/);
        const writeIds = database.all("SELECT id FROM protocol_write_records ORDER BY sequence", []);
        expect(writeIds).toHaveLength(1);
        for (const row of writeIds) expect(row["id"]).toMatch(/^write-\d+$/);
        const auditRows = database.all(
            "SELECT id, record FROM protocol_audit_records ORDER BY sequence",
            []
        );
        expect(auditRows).toHaveLength(2);
        const kinds: string[] = [];
        for (const row of auditRows) {
            expect(row["id"]).toMatch(/^audit-\d+$/);
            const record = row["record"];
            if (!(record instanceof Uint8Array)) throw new TypeError("Expected audit record bytes");
            const audit = AuditRecordCodec.decode(record);
            expect(audit.correlation.value).toMatch(/^correlation-\d+$/);
            kinds.push(audit.kind.kind);
            if (audit.kind.kind === "invocation") {
                expect(audit.kind.id.value).toMatch(/^invocation-\d+$/);
            }
        }
        expect(kinds.sort()).toEqual(["invocation", "write"]);
    });

    test("translates a raw protocol ID write fault into the exact conflict error", { tags: "p0" }, async () => {
        const database = new StatementFaultSqlite();
        const store = content();
        const composition = bootstrap(database, store);
        database.onRun = (statement) => {
            if (statement.startsWith("UPDATE tenant_bootstrap_protocol_ids")) {
                throw new Error("raw ID write fault");
            }
            return undefined;
        };

        await expect(
            composition.dispatch(envelope(store, "raw-write-fault"), ownerTransport)
        ).rejects.toMatchObject({
            code: "protocol.revision-conflict",
            message: "Tenant bootstrap protocol ID write failed"
        });
    });

    test("preserves a typed protocol ID write fault exactly", { tags: "p0" }, async () => {
        const database = new StatementFaultSqlite();
        const store = content();
        const composition = bootstrap(database, store);
        database.onRun = (statement) => {
            if (statement.startsWith("UPDATE tenant_bootstrap_protocol_ids")) {
                throw new AgentCoreError("protocol.invalid-state", "injected typed ID write failure");
            }
            return undefined;
        };

        await expect(
            composition.dispatch(envelope(store, "typed-write-fault"), ownerTransport)
        ).rejects.toMatchObject({
            code: "protocol.invalid-state",
            message: "injected typed ID write failure"
        });
    });

    test("detects a lost protocol ID increment with the exact conflict error", { tags: "p0" }, async () => {
        const database = new StatementFaultSqlite();
        const store = content();
        const composition = bootstrap(database, store);
        database.onRun = (statement) =>
            statement.startsWith("UPDATE tenant_bootstrap_protocol_ids") ? "skip" : undefined;

        await expect(
            composition.dispatch(envelope(store, "lost-increment"), ownerTransport)
        ).rejects.toMatchObject({
            code: "protocol.revision-conflict",
            message: "Tenant bootstrap protocol ID changed concurrently"
        });
    });

    test("translates a raw protocol ID read fault into the exact codec error", { tags: "p1" }, () => {
        const database = new StatementFaultSqlite();
        database.onAll = (statement) => {
            if (statement.includes("SELECT next_id FROM tenant_bootstrap_protocol_ids")) {
                throw new Error("raw ID read fault");
            }
        };

        expect(() => bootstrap(database, content())).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "Tenant bootstrap protocol ID read failed"
            })
        );
    });

    test("preserves a typed protocol ID read fault exactly", { tags: "p1" }, () => {
        const database = new StatementFaultSqlite();
        database.onAll = (statement) => {
            if (statement.includes("SELECT next_id FROM tenant_bootstrap_protocol_ids")) {
                throw new AgentCoreError("protocol.invalid-state", "injected typed ID read failure");
            }
        };

        expect(() => bootstrap(database, content())).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "injected typed ID read failure"
            })
        );
    });

    test("rejects missing and negative persisted protocol ID state exactly", { tags: "p0" }, async () => {
        const malformed = {
            code: "codec.invalid",
            message: "Tenant bootstrap protocol ID state is malformed"
        };

        const missing = new TestSqlite();
        const missingContent = content();
        const composition = bootstrap(missing, missingContent);
        missing.run("DELETE FROM tenant_bootstrap_protocol_ids", []);
        await expect(
            composition.dispatch(envelope(missingContent, "missing-id-state"), ownerTransport)
        ).rejects.toMatchObject(malformed);

        const negative = new TestSqlite();
        bootstrap(negative, content());
        negative.run("PRAGMA ignore_check_constraints = ON", []);
        negative.run("UPDATE tenant_bootstrap_protocol_ids SET next_id = -1 WHERE singleton = 1", []);
        expect(() => bootstrap(negative, content(), false)).toThrow(
            expect.objectContaining(malformed)
        );
    });

    test("wraps a foreign dispatcher construction fault with the exact Actor state error", { tags: "p0" }, () => {
        const database = new StatementFaultSqlite();
        database.onAll = (statement) => {
            if (statement.startsWith("PRAGMA table_info(protocol_")) {
                throw new TypeError("injected protocol schema fault");
            }
        };

        expect(() => bootstrap(database, content())).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Tenant bootstrap Actor state is invalid"
            })
        );
    });

    test("preserves a typed dispatcher construction fault exactly", { tags: "p0" }, () => {
        const database = new StatementFaultSqlite();
        database.onAll = (statement) => {
            if (statement.startsWith("PRAGMA table_info(protocol_")) {
                throw new AgentCoreError("codec.invalid", "injected protocol schema fault");
            }
        };

        expect(() => bootstrap(database, content())).toThrow(
            expect.objectContaining({
                code: "codec.invalid",
                message: "injected protocol schema fault"
            })
        );
    });
});

import { type ActorRef } from "../../actors";
import type { TransientContentAccess } from "../../content";
import { Revision } from "../../core";
import { AgentCoreError } from "../../errors";
import type { TenantId } from "../../identity";
import { AuditRecordId, CorrelationId, InvocationId, WriteRecordId } from "../../invocations";
import {
    CommandDispatcher,
    CommandIngress,
    createTenantBootstrapCommand,
    type CommandAuthenticator,
    type CommandDispatchResult,
    type CommandIngressResult,
    type TenantBootstrapAnchor,
    type TenantBootstrapAnchorRecord
} from "../../protocol";
import { SqliteActorStore } from "./actor";
import { SqliteProtocolPersistence } from "./protocol";
import { SqliteTenantControlStore, createSqliteTenantControlStore } from "./tenant";
import { ReadableSqlite, TransactionalSqlite, type SqliteRow } from "./sqlite";

const CREATE_IDS = `CREATE TABLE IF NOT EXISTS tenant_bootstrap_protocol_ids (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_id INTEGER NOT NULL CHECK (next_id >= 0)
) STRICT`;

export interface SqliteTenantBootstrapInit<Transport> {
    readonly actor: ActorRef;
    readonly anchor?: TenantBootstrapAnchor;
    readonly authenticator: CommandAuthenticator<Transport>;
    readonly content: TransientContentAccess;
    readonly database: TransactionalSqlite;
}

export class SqliteTenantBootstrap<Transport> {
    readonly #ingress: CommandIngress<
        TransactionalSqlite,
        ReadableSqlite,
        ReadableSqlite,
        Transport
    >;
    readonly #control: SqliteTenantControlStore;
    public readonly tenantId: TenantId;

    public constructor(init: SqliteTenantBootstrapInit<Transport>) {
        this.#control = createSqliteTenantControlStore(init.database, init.anchor);
        const anchor = this.#control.bootstrapAnchor();
        if (anchor === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "SQLite Tenant bootstrap anchor is missing"
            );
        }
        this.tenantId = anchor.tenantId;
        try {
            init.database.transaction(() => {
                init.database.run(CREATE_IDS, []);
                init.database.run(
                    "INSERT OR IGNORE INTO tenant_bootstrap_protocol_ids (singleton, next_id) VALUES (1, 0)",
                    []
                );
            });
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Tenant bootstrap protocol ID initialization failed"
            );
        }
        readNextId(init.database);
        try {
            const dispatcher = new CommandDispatcher<
                TransactionalSqlite,
                ReadableSqlite,
                ReadableSqlite
            >({
                store: new SqliteActorStore(init.database),
                persistence: new SqliteProtocolPersistence(init.database),
                ids: {
                    writeRecordId: (transaction) => new WriteRecordId(nextId(transaction, "write")),
                    auditRecordId: (transaction) => new AuditRecordId(nextId(transaction, "audit")),
                    correlationId: (transaction) =>
                        new CorrelationId(nextId(transaction, "correlation")),
                    invocationId: (transaction) =>
                        new InvocationId(nextId(transaction, "invocation"))
                },
                actor: init.actor,
                tenant: anchor.tenantId,
                readOnly: (transaction) => transaction,
                commands: [
                    createTenantBootstrapCommand(
                        {
                            anchor: () => this.#control.bootstrapAnchor(),
                            anchorInTransaction: () => this.#control.bootstrapAnchor(),
                            eligible: () => this.#control.isBootstrapEligible(),
                            currentRevision: () => Revision.initial(),
                            bootstrapTenant: (
                                _transaction: TransactionalSqlite,
                                verifiedAnchor: TenantBootstrapAnchorRecord,
                                expectedRevision: Revision
                            ) =>
                                this.#control.bootstrapTenant(
                                    init.database,
                                    verifiedAnchor,
                                    expectedRevision
                                )
                        },
                        {
                            actor: init.actor,
                            tenantId: anchor.tenantId
                        }
                    )
                ],
                limits: { envelopeBytes: 16_384, payloadBytes: 16_384 }
            });
            this.#ingress = new CommandIngress({
                dispatcher,
                content: init.content,
                authenticator: init.authenticator,
                leaseForMilliseconds: 60_000
            });
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Tenant bootstrap Actor state is invalid"
            );
        }
    }

    public accept(
        envelope: Uint8Array,
        transport: Transport,
        submittedBytes?: Uint8Array
    ): Promise<CommandIngressResult> {
        return this.#ingress.accept(envelope, transport, submittedBytes);
    }

    public async dispatch(
        envelope: Uint8Array,
        transport: Transport,
        submittedBytes?: Uint8Array
    ): Promise<CommandDispatchResult> {
        const result = await this.accept(envelope, transport, submittedBytes);
        if (result.kind === "preDispatchFailure") throw result.cause;
        return result;
    }
}

export function createSqliteTenantBootstrap<Transport>(
    init: SqliteTenantBootstrapInit<Transport>
): SqliteTenantBootstrap<Transport> {
    return new SqliteTenantBootstrap(init);
}

function nextId(transaction: TransactionalSqlite, prefix: string): string {
    const current = readNextId(transaction);
    if (current === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Tenant bootstrap protocol ID is exhausted"
        );
    }
    try {
        transaction.run(
            "UPDATE tenant_bootstrap_protocol_ids SET next_id = next_id + 1 WHERE singleton = 1",
            []
        );
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError(
            "protocol.revision-conflict",
            "Tenant bootstrap protocol ID write failed"
        );
    }
    const value = readNextId(transaction);
    if (value !== current + 1) {
        throw new AgentCoreError(
            "protocol.revision-conflict",
            "Tenant bootstrap protocol ID changed concurrently"
        );
    }
    return `${prefix}-${value}`;
}

function readNextId(database: ReadableSqlite): number {
    let rows: readonly SqliteRow[];
    try {
        rows = database.all(
            "SELECT next_id FROM tenant_bootstrap_protocol_ids WHERE singleton = 1",
            []
        );
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw new AgentCoreError("codec.invalid", "Tenant bootstrap protocol ID read failed");
    }
    const value = rows[0]?.["next_id"];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new AgentCoreError(
            "codec.invalid",
            "Tenant bootstrap protocol ID state is malformed"
        );
    }
    return value;
}

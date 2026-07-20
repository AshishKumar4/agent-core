import { Digest } from "../../../core";
import type { ActorRef } from "../../../actors";
import { AgentCoreError } from "../../../errors";
import {
    AuditRecord,
    InvocationPublicationOutbox,
    MediatedReplayRecord,
    type AuditAppendContext,
    type AuditKind,
    type InvocationEvidencePersistence,
    type InvocationReplayPersistence
} from "../../../invocations";
import type { AuditRecordId } from "../../../interaction-references";
import { TransactionalSqlite, type SqliteRow } from "../sqlite";

export interface SqliteInvocationAuditAppendPort {
    findAudit(transaction: TransactionalSqlite, id: AuditRecordId): AuditRecord | undefined;
    findAuditByEvidence(
        transaction: TransactionalSqlite,
        actor: ActorRef,
        kind: AuditKind
    ): AuditRecord | undefined;
    appendAudit(
        transaction: TransactionalSqlite,
        record: AuditRecord,
        context?: AuditAppendContext
    ): void;
}

const CREATE_REPLAY_IDENTITIES = `CREATE TABLE IF NOT EXISTS invocation_mediated_replay_identities (
    scope TEXT NOT NULL,
    request_key TEXT NOT NULL,
    replay_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (scope, request_key)
)`;

const CREATE_REPLAY_REVISIONS = `CREATE TABLE IF NOT EXISTS invocation_mediated_replay_revisions (
    replay_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL,
    PRIMARY KEY (replay_id, revision)
)`;

const CREATE_PUBLICATIONS = `CREATE TABLE IF NOT EXISTS invocation_publication_outbox (
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'published')),
    record BLOB NOT NULL,
    PRIMARY KEY (id, revision)
)`;

export class SqliteInvocationMediationPersistence
    implements
        InvocationReplayPersistence<TransactionalSqlite>,
        InvocationEvidencePersistence<TransactionalSqlite>
{
    public constructor(
        database: TransactionalSqlite,
        private readonly audits: SqliteInvocationAuditAppendPort
    ) {
        database.transaction(() => {
            for (const statement of [
                CREATE_REPLAY_IDENTITIES,
                CREATE_REPLAY_REVISIONS,
                CREATE_PUBLICATIONS
            ])
                database.run(statement, []);
        });
    }

    public replay(
        transaction: TransactionalSqlite,
        scope: string,
        requestKey: string
    ): MediatedReplayRecord | undefined {
        const identity = one(
            transaction,
            `SELECT replay_id FROM invocation_mediated_replay_identities
             WHERE scope = ? AND request_key = ?`,
            [scope, requestKey]
        );
        return identity === undefined
            ? undefined
            : this.replayById(transaction, new Digest(text(identity, "replay_id")));
    }

    public replayById(
        transaction: TransactionalSqlite,
        id: Digest
    ): MediatedReplayRecord | undefined {
        const row = one(
            transaction,
            `SELECT replay_id, revision, record FROM invocation_mediated_replay_revisions
             WHERE replay_id = ? ORDER BY revision DESC LIMIT 1`,
            [id.value]
        );
        if (row === undefined) return undefined;
        const record = MediatedReplayRecord.decode(bytes(row, "record"));
        if (
            !record.id.equals(id) ||
            text(row, "replay_id") !== id.value ||
            integer(row, "revision") !== record.revision.value
        )
            corrupt();
        return record;
    }

    public appendReplay(transaction: TransactionalSqlite, record: MediatedReplayRecord): void {
        const current = this.replayById(transaction, record.id);
        if (record.revision.value === 0) {
            if (current !== undefined) conflict("Replay reservation already exists");
            append(
                transaction,
                `INSERT INTO invocation_mediated_replay_identities
                 (scope, request_key, replay_id) VALUES (?, ?, ?)`,
                [record.scope, record.requestKey, record.id.value]
            );
        } else if (
            current?.revision.value !== record.revision.value - 1 ||
            current.scope !== record.scope ||
            current.requestKey !== record.requestKey
        ) {
            conflict("Replay revision is not the next reserved transition");
        }
        append(
            transaction,
            `INSERT INTO invocation_mediated_replay_revisions
             (replay_id, revision, record) VALUES (?, ?, ?)`,
            [record.id.value, record.revision.value, MediatedReplayRecord.encode(record)]
        );
    }

    public appendAudit(
        transaction: TransactionalSqlite,
        record: AuditRecord,
        context?: AuditAppendContext
    ): void {
        this.audits.appendAudit(transaction, record, context);
    }

    public audit(transaction: TransactionalSqlite, id: AuditRecordId): AuditRecord | undefined {
        return this.audits.findAudit(transaction, id);
    }

    public findAuditByEvidence(
        transaction: TransactionalSqlite,
        actor: ActorRef,
        kind: AuditKind
    ): AuditRecord | undefined {
        return this.audits.findAuditByEvidence(transaction, actor, kind);
    }

    public publication(
        transaction: TransactionalSqlite,
        id: Digest
    ): InvocationPublicationOutbox | undefined {
        const row = one(
            transaction,
            `SELECT id, revision, state, record FROM invocation_publication_outbox
             WHERE id = ? ORDER BY revision DESC LIMIT 1`,
            [id.value]
        );
        return row === undefined ? undefined : decodePublication(row, id);
    }

    public pendingPublications(
        transaction: TransactionalSqlite
    ): readonly InvocationPublicationOutbox[] {
        return Object.freeze(
            transaction
                .all(
                    `SELECT current.id, current.revision, current.state, current.record
             FROM invocation_publication_outbox AS current
             WHERE current.state = 'pending'
               AND NOT EXISTS (
                   SELECT 1 FROM invocation_publication_outbox AS later
                   WHERE later.id = current.id AND later.revision > current.revision
               )
             ORDER BY current.id`,
                    []
                )
                .map((row) => decodePublication(row))
        );
    }

    public appendPublication(
        transaction: TransactionalSqlite,
        record: InvocationPublicationOutbox
    ): void {
        const current = this.publication(transaction, record.id);
        if (
            (current === undefined && record.revision.value !== 0) ||
            (current !== undefined && !record.follows(current))
        ) {
            conflict("Publication revision is not the next transition");
        }
        append(
            transaction,
            `INSERT INTO invocation_publication_outbox
             (id, revision, state, record) VALUES (?, ?, ?, ?)`,
            [
                record.id.value,
                record.revision.value,
                record.state.kind,
                InvocationPublicationOutbox.encode(record)
            ]
        );
    }
}

function decodePublication(row: SqliteRow, expected?: Digest): InvocationPublicationOutbox {
    const record = InvocationPublicationOutbox.decode(bytes(row, "record"));
    if (
        (expected !== undefined && !record.id.equals(expected)) ||
        text(row, "id") !== record.id.value ||
        integer(row, "revision") !== record.revision.value ||
        text(row, "state") !== record.state.kind
    )
        corrupt();
    return record;
}

function one(
    transaction: TransactionalSqlite,
    statement: string,
    bindings: readonly (string | number)[]
): SqliteRow | undefined {
    return transaction.all(statement, bindings)[0];
}

function append(
    transaction: TransactionalSqlite,
    statement: string,
    bindings: readonly (string | number | Uint8Array)[]
): void {
    try {
        transaction.run(statement, bindings);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        conflict("Invocation mediation append conflicted");
    }
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string") corrupt();
    return value;
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) corrupt();
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) corrupt();
    return value.slice();
}

function conflict(message: string): never {
    throw new AgentCoreError("invocation.invalid", message);
}

function corrupt(): never {
    throw new AgentCoreError("codec.invalid", "Stored invocation mediation projection is corrupt");
}

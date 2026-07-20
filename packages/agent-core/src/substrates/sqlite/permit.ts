import type { ActorRef, SynchronousResultGuard } from "../../actors";
import {
    AuthorityPermit,
    type AuthenticatedAuthorityPermit,
    type AuthorityPermitExpectation,
    type AuthorityPermitOwnerStore,
    requireAuthenticatedAuthorityPermit
} from "../../authority";
import { Digest } from "../../core";
import { AgentCoreError } from "../../errors";
import { TransactionalSqlite, hasSameSqliteProvenance, type SqliteRow } from "./sqlite";

const CREATE_PERMITS = `CREATE TABLE IF NOT EXISTS authority_permit_nonces (
    nonce TEXT PRIMARY KEY CHECK (length(nonce) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    state TEXT NOT NULL CHECK (state IN ('issued', 'consumed')),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    record BLOB,
    CHECK ((state = 'issued' AND record IS NOT NULL) OR (state = 'consumed' AND record IS NULL))
) STRICT`;

export class SqliteAuthorityPermitStore implements AuthorityPermitOwnerStore<TransactionalSqlite> {
    public constructor(
        private readonly database: TransactionalSqlite,
        public readonly owner: ActorRef
    ) {
        try {
            database.transaction(() => database.run(CREATE_PERMITS, []));
            this.validateRows(database);
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Authority permit schema initialization failed");
        }
    }

    public transaction<Result>(
        operation: (transaction: TransactionalSqlite) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.database.transaction(() => operation(this.database), ...guard);
    }

    public issued(transaction: TransactionalSqlite, nonce: string): AuthorityPermit | undefined {
        const row = this.row(transaction, nonce);
        if (row === undefined || text(row, "state") !== "issued") return undefined;
        return this.decodeIssued(row, nonce);
    }

    public consumed(transaction: TransactionalSqlite, nonce: string): Digest | undefined {
        const row = this.row(transaction, nonce);
        if (row === undefined || text(row, "state") !== "consumed") return undefined;
        this.validateOwner(row);
        if (row["record"] !== null) throw corrupt();
        return new Digest(text(row, "digest"));
    }

    public issue(transaction: TransactionalSqlite, permit: AuthorityPermit): AuthorityPermit {
        this.requireTransaction(transaction);
        if (!permit.issuer.equals(this.owner)) {
            throw denied("Authority permit was issued by another Actor owner");
        }
        const bytes = AuthorityPermit.encode(permit);
        try {
            transaction.run(
                `INSERT OR IGNORE INTO authority_permit_nonces
                    (nonce, owner_kind, owner_id, state, digest, record)
                 VALUES (?, ?, ?, 'issued', ?, ?)`,
                [permit.nonce, this.owner.kind, this.owner.id.value, permit.digest().value, bytes]
            );
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw denied("Authority permit nonce could not be issued atomically");
        }
        const stored = this.issued(transaction, permit.nonce);
        if (stored === undefined) {
            throw denied("Authority permit nonce was already used by this Actor owner");
        }
        if (!stored.expectation.equals(permit.expectation)) {
            throw denied("Authority permit nonce is bound to another issuance expectation");
        }
        return stored;
    }

    public consume(
        transaction: TransactionalSqlite,
        authentication: AuthenticatedAuthorityPermit,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void {
        this.requireTransaction(transaction);
        requireAuthenticatedAuthorityPermit(authentication, permit);
        if (!permit.target.actor.equals(this.owner)) {
            throw denied("Authority permit targets another Actor owner");
        }
        permit.assertConsumable(expected, now);
        this.requireUnused(transaction, permit.nonce);
        const digest = permit.digest();
        try {
            transaction.run(
                `INSERT INTO authority_permit_nonces
                    (nonce, owner_kind, owner_id, state, digest, record)
                 VALUES (?, ?, ?, 'consumed', ?, NULL)`,
                [permit.nonce, this.owner.kind, this.owner.id.value, digest.value]
            );
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw denied("Authority permit nonce could not be consumed exactly once");
        }
        if (!this.consumed(transaction, permit.nonce)?.equals(digest)) {
            throw conflict("Authority permit consumption did not persist exactly");
        }
    }

    private requireUnused(transaction: TransactionalSqlite, nonce: string): void {
        if (this.row(transaction, nonce) !== undefined) {
            throw denied("Authority permit nonce was already used by this Actor owner");
        }
    }

    private row(transaction: TransactionalSqlite, nonce: string): SqliteRow | undefined {
        this.requireTransaction(transaction);
        try {
            return transaction.all("SELECT * FROM authority_permit_nonces WHERE nonce = ?", [
                nonce
            ])[0];
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Authority permit read failed");
        }
    }

    private validateRows(transaction: TransactionalSqlite): void {
        this.requireTransaction(transaction);
        let rows: readonly SqliteRow[];
        try {
            rows = transaction.all("SELECT * FROM authority_permit_nonces ORDER BY nonce", []);
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Authority permit recovery read failed");
        }
        for (const row of rows) {
            const nonce = text(row, "nonce");
            const state = text(row, "state");
            if (state === "issued") this.decodeIssued(row, nonce);
            else if (state === "consumed") {
                this.validateOwner(row);
                new Digest(text(row, "digest"));
                if (row["record"] !== null) throw corrupt();
            } else throw corrupt();
        }
    }

    private decodeIssued(row: SqliteRow, expectedNonce: string): AuthorityPermit {
        this.validateOwner(row);
        const record = row["record"];
        if (!(record instanceof Uint8Array)) throw corrupt();
        const permit = AuthorityPermit.decode(record.slice());
        if (
            permit.nonce !== expectedNonce ||
            text(row, "nonce") !== expectedNonce ||
            text(row, "state") !== "issued" ||
            text(row, "digest") !== permit.digest().value ||
            !permit.issuer.equals(this.owner)
        )
            throw corrupt();
        return permit;
    }

    private validateOwner(row: SqliteRow): void {
        if (
            text(row, "owner_kind") !== this.owner.kind ||
            text(row, "owner_id") !== this.owner.id.value
        )
            throw corrupt();
    }

    private requireTransaction(transaction: TransactionalSqlite): void {
        if (
            !(transaction instanceof TransactionalSqlite) ||
            !hasSameSqliteProvenance(this.database, transaction)
        )
            throw new TypeError("Authority permit transaction belongs to another SQLite owner");
    }
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0) throw corrupt();
    return value;
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

function conflict(message: string): AgentCoreError {
    return new AgentCoreError("protocol.revision-conflict", message);
}

function corrupt(message = "Stored authority permit ownership is malformed"): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

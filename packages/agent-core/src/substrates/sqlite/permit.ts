import type {
    ActorActivation,
    ActorLocalStore,
    ActorRecoveryState,
    ActorRef,
    SynchronousResultGuard,
    TransactionOperation
} from "../../actors";
import {
    AuthorityPermit,
    TenantAuthorityTransactionPort,
    type AuthenticatedAuthorityPermit,
    type AuthorityPermitExpectation,
    type AuthorityPermitIssueStore,
    type AuthorityPermitTargetStore,
    type TenantAuthorityReadStore,
    TargetAuthorityPermitDenial,
    TargetAuthorityPermitRequest,
    TargetLeaseEvidence,
    TargetLeaseEvidenceReference,
    type TargetLeaseEvidenceStore,
    requireAuthenticatedAuthorityPermit
} from "../../authority";
import { Digest } from "../../core";
import { AgentCoreError } from "../../errors";
import {
    ReadableSqlite,
    TransactionalSqlite,
    hasSameSqliteProvenance,
    isSqliteText,
    type SqliteRow
} from "./sqlite";
import { SqliteActorStore, isActiveSqliteActorTransaction } from "./actor";
import { createSqliteTenantControlStore } from "./tenant";

const CREATE_PERMITS = `CREATE TABLE IF NOT EXISTS authority_permit_nonces (
    nonce TEXT PRIMARY KEY CHECK (length(nonce) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    state TEXT NOT NULL CHECK (state IN ('requested', 'issued')),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    record BLOB NOT NULL
) STRICT`;

const CREATE_CONSUMPTIONS = `CREATE TABLE IF NOT EXISTS authority_permit_consumptions (
    nonce TEXT PRIMARY KEY CHECK (length(nonce) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    permit BLOB NOT NULL
) STRICT`;

const CREATE_DENIALS = `CREATE TABLE IF NOT EXISTS authority_permit_denials (
    nonce TEXT PRIMARY KEY CHECK (length(nonce) > 0),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    denial BLOB NOT NULL
) STRICT`;

const CREATE_LEASE_EVIDENCE_PROJECTIONS = `CREATE TABLE IF NOT EXISTS authority_permit_lease_evidence (
    source_kind TEXT NOT NULL CHECK (source_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    evidence BLOB NOT NULL,
    PRIMARY KEY (source_kind, source_id, idempotency_key)
) STRICT`;

const CREATE_SOURCE_LEASE_EVIDENCE = `CREATE TABLE IF NOT EXISTS authority_target_lease_evidence (
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('tenant', 'workspace', 'run', 'environment', 'slate')),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    evidence BLOB NOT NULL,
    PRIMARY KEY (owner_kind, owner_id, idempotency_key)
) STRICT`;

export class SqliteAuthorityPermitStore
    implements
        AuthorityPermitTargetStore<TransactionalSqlite>,
        AuthorityPermitIssueStore<TransactionalSqlite>
{
    readonly #actors: SqliteActorStore;

    public constructor(
        private readonly database: TransactionalSqlite,
        public readonly owner: ActorRef
    ) {
        try {
            this.#actors = new SqliteActorStore(database);
            database.transaction(() => {
                database.run(CREATE_PERMITS, []);
                database.run(CREATE_CONSUMPTIONS, []);
                database.run(CREATE_DENIALS, []);
                database.run(CREATE_LEASE_EVIDENCE_PROJECTIONS, []);
            });
            this.#actors.transaction((transaction) => this.validateRows(transaction));
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Authority permit schema initialization failed");
        }
    }

    public transaction<Result>(
        operation: (transaction: TransactionalSqlite) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#actors.transaction(operation, ...guard);
    }

    public issued(transaction: TransactionalSqlite, nonce: string): AuthorityPermit | undefined {
        const row = this.row(transaction, nonce);
        if (row === undefined || text(row, "state") !== "issued") return undefined;
        return this.decodeIssued(row, nonce);
    }

    public projectedEvidence(
        transaction: TransactionalSqlite,
        reference: TargetLeaseEvidenceReference
    ): TargetLeaseEvidence | undefined {
        this.requireTransaction(transaction);
        const row = transaction.all(
            `SELECT * FROM authority_permit_lease_evidence
             WHERE source_kind = ? AND source_id = ? AND idempotency_key = ?`,
            [
                reference.key.source.kind,
                reference.key.source.id.value,
                reference.key.idempotencyKey
            ]
        )[0];
        if (row === undefined) return undefined;
        const bytes = row["evidence"];
        if (!(bytes instanceof Uint8Array) || text(row, "digest") !== reference.digest.value) {
            throw corrupt();
        }
        const evidence = TargetLeaseEvidence.decode(bytes.slice());
        if (!evidence.key.equals(reference.key) || !evidence.digest().equals(reference.digest)) {
            throw corrupt();
        }
        return evidence;
    }

    public projectEvidence(
        transaction: TransactionalSqlite,
        evidence: TargetLeaseEvidence
    ): TargetLeaseEvidence {
        this.requireTransaction(transaction);
        try {
            transaction.run(
                `INSERT OR IGNORE INTO authority_permit_lease_evidence
                    (source_kind, source_id, idempotency_key, digest, evidence)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    evidence.key.source.kind,
                    evidence.key.source.id.value,
                    evidence.key.idempotencyKey,
                    evidence.digest().value,
                    TargetLeaseEvidence.encode(evidence)
                ]
            );
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw denied("Target lease evidence could not be projected atomically");
        }
        const row = transaction.all(
            `SELECT * FROM authority_permit_lease_evidence
             WHERE source_kind = ? AND source_id = ? AND idempotency_key = ?`,
            [
                evidence.key.source.kind,
                evidence.key.source.id.value,
                evidence.key.idempotencyKey
            ]
        )[0];
        const bytes = row?.["evidence"];
        if (row === undefined || !(bytes instanceof Uint8Array)) {
            throw conflict("Target lease evidence projection did not persist");
        }
        const stored = TargetLeaseEvidence.decode(bytes.slice());
        if (
            !stored.key.equals(evidence.key) ||
            !stored.digest().equals(evidence.digest()) ||
            text(row, "digest") !== stored.digest().value
        ) {
            throw denied("Target lease evidence projection key is bound to another attestation");
        }
        return stored;
    }

    public requested(
        transaction: TransactionalSqlite,
        nonce: string
    ): TargetAuthorityPermitRequest | undefined {
        const row = this.row(transaction, nonce);
        if (row === undefined || text(row, "state") !== "requested") return undefined;
        return this.decodeRequested(row, nonce);
    }

    public consumed(transaction: TransactionalSqlite, nonce: string): Digest | undefined {
        const row = this.consumptionRow(transaction, nonce);
        return row === undefined
            ? undefined
            : this.decodeConsumed(transaction, row, nonce).digest();
    }

    public denied(
        transaction: TransactionalSqlite,
        nonce: string
    ): TargetAuthorityPermitDenial | undefined {
        const row = this.denialRow(transaction, nonce);
        return row === undefined ? undefined : this.decodeDenied(transaction, row, nonce);
    }

    public request(
        transaction: TransactionalSqlite,
        request: TargetAuthorityPermitRequest
    ): TargetAuthorityPermitRequest {
        this.requireTransaction(transaction);
        if (!request.expectation.target.actor.equals(this.owner)) {
            throw denied("Authority permit request targets another Actor owner");
        }
        const bytes = TargetAuthorityPermitRequest.encode(request);
        try {
            transaction.run(
                `INSERT OR IGNORE INTO authority_permit_nonces
                    (nonce, owner_kind, owner_id, state, digest, record)
                 VALUES (?, ?, ?, 'requested', ?, ?)`,
                [request.nonce, this.owner.kind, this.owner.id.value, request.digest().value, bytes]
            );
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw denied("Authority permit target request could not be recorded atomically");
        }
        const stored = this.requested(transaction, request.nonce);
        if (stored === undefined) {
            throw denied("Authority permit nonce was already used by this Actor owner");
        }
        if (!stored.digest().equals(request.digest())) {
            throw denied("Authority permit nonce is bound to another target request");
        }
        return stored;
    }

    public deny(
        transaction: TransactionalSqlite,
        denial: TargetAuthorityPermitDenial
    ): TargetAuthorityPermitDenial {
        this.requireTransaction(transaction);
        if (!denial.request.expectation.target.actor.equals(this.owner)) {
            throw denied("Authority permit denial targets another Actor owner");
        }
        const request = this.requested(transaction, denial.request.nonce);
        if (request === undefined || !request.digest().equals(denial.request.digest())) {
            throw denied("Authority denial does not match its exact durable target request");
        }
        const existing = this.denied(transaction, denial.request.nonce);
        if (existing !== undefined) {
            if (!existing.digest().equals(denial.digest())) {
                throw denied("Authority permit nonce is bound to another Tenant denial");
            }
            return existing;
        }
        if (this.consumptionRow(transaction, denial.request.nonce) !== undefined) {
            throw denied("Authority permit nonce was already consumed by this Actor owner");
        }
        try {
            transaction.run(
                `INSERT INTO authority_permit_denials
                    (nonce, owner_kind, owner_id, digest, denial)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    denial.request.nonce,
                    this.owner.kind,
                    this.owner.id.value,
                    denial.digest().value,
                    TargetAuthorityPermitDenial.encode(denial)
                ]
            );
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw denied("Authority permit denial could not be recorded atomically");
        }
        const stored = this.denied(transaction, denial.request.nonce);
        if (stored === undefined || !stored.digest().equals(denial.digest())) {
            throw conflict("Authority permit denial did not persist exactly");
        }
        return stored;
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
        if (
            !stored.expectation.equals(permit.expectation) ||
            !stored.requestDigest.equals(permit.requestDigest)
        ) {
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
        const requested = this.requested(transaction, permit.nonce);
        if (requested === undefined) {
            if (this.row(transaction, permit.nonce) !== undefined) {
                this.requireUnused(transaction, permit.nonce);
            }
            throw denied("Authority permit has no durable target request");
        }
        if (!requested.expectation.equals(expected)) {
            throw denied("Authority permit does not match its exact target request");
        }
        if (!permit.requestDigest.equals(requested.digest())) {
            throw denied("Authority permit was issued for another target request");
        }
        if (this.denialRow(transaction, permit.nonce) !== undefined) {
            throw denied("Authority permit request was denied by its Tenant");
        }
        if (this.consumptionRow(transaction, permit.nonce) !== undefined) {
            throw denied("Authority permit nonce was already used by this Actor owner");
        }
        const digest = permit.digest();
        try {
            transaction.run(
                `INSERT INTO authority_permit_consumptions
                    (nonce, owner_kind, owner_id, digest, permit)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    permit.nonce,
                    this.owner.kind,
                    this.owner.id.value,
                    digest.value,
                    AuthorityPermit.encode(permit)
                ]
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
        if (
            this.row(transaction, nonce) !== undefined ||
            this.denialRow(transaction, nonce) !== undefined ||
            this.consumptionRow(transaction, nonce) !== undefined
        ) {
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

    private consumptionRow(transaction: TransactionalSqlite, nonce: string): SqliteRow | undefined {
        this.requireTransaction(transaction);
        try {
            return transaction.all("SELECT * FROM authority_permit_consumptions WHERE nonce = ?", [
                nonce
            ])[0];
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Authority permit consumption read failed");
        }
    }

    private denialRow(transaction: TransactionalSqlite, nonce: string): SqliteRow | undefined {
        this.requireTransaction(transaction);
        try {
            return transaction.all("SELECT * FROM authority_permit_denials WHERE nonce = ?", [
                nonce
            ])[0];
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Authority permit denial read failed");
        }
    }

    private validateRows(transaction: TransactionalSqlite): void {
        this.requireTransaction(transaction);
        let rows: readonly SqliteRow[];
        let denials: readonly SqliteRow[];
        let consumptions: readonly SqliteRow[];
        try {
            rows = transaction.all("SELECT * FROM authority_permit_nonces ORDER BY nonce", []);
            denials = transaction.all("SELECT * FROM authority_permit_denials ORDER BY nonce", []);
            consumptions = transaction.all(
                "SELECT * FROM authority_permit_consumptions ORDER BY nonce",
                []
            );
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Authority permit recovery read failed");
        }
        for (const row of rows) {
            const nonce = text(row, "nonce");
            const state = text(row, "state");
            if (state === "requested") this.decodeRequested(row, nonce);
            else if (state === "issued") this.decodeIssued(row, nonce);
            else throw corrupt();
        }
        for (const row of consumptions) {
            this.decodeConsumed(transaction, row, text(row, "nonce"));
        }
        for (const row of denials) {
            const nonce = text(row, "nonce");
            if (this.consumptionRow(transaction, nonce) !== undefined) throw corrupt();
            this.decodeDenied(transaction, row, nonce);
        }
    }

    private decodeRequested(row: SqliteRow, expectedNonce: string): TargetAuthorityPermitRequest {
        this.validateOwner(row);
        const record = row["record"];
        if (!(record instanceof Uint8Array)) throw corrupt();
        let request: TargetAuthorityPermitRequest;
        try {
            request = TargetAuthorityPermitRequest.decode(record.slice());
        } catch {
            throw corrupt();
        }
        if (
            request.nonce !== expectedNonce ||
            text(row, "nonce") !== expectedNonce ||
            text(row, "state") !== "requested" ||
            text(row, "digest") !== request.digest().value ||
            !request.expectation.target.actor.equals(this.owner)
        )
            throw corrupt();
        return request;
    }

    private decodeIssued(row: SqliteRow, expectedNonce: string): AuthorityPermit {
        this.validateOwner(row);
        const record = row["record"];
        if (!(record instanceof Uint8Array)) throw corrupt();
        let permit: AuthorityPermit;
        try {
            permit = AuthorityPermit.decode(record.slice());
        } catch {
            throw corrupt();
        }
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

    private decodeConsumed(
        transaction: TransactionalSqlite,
        row: SqliteRow,
        expectedNonce: string
    ): AuthorityPermit {
        this.validateOwner(row);
        const bytes = row["permit"];
        if (!(bytes instanceof Uint8Array)) throw corrupt();
        let permit: AuthorityPermit;
        try {
            permit = AuthorityPermit.decode(bytes.slice());
        } catch {
            throw corrupt();
        }
        const request = this.requested(transaction, expectedNonce);
        if (
            request === undefined ||
            permit.nonce !== expectedNonce ||
            text(row, "nonce") !== expectedNonce ||
            text(row, "digest") !== permit.digest().value ||
            !permit.target.actor.equals(this.owner) ||
            !permit.expectation.equals(request.expectation) ||
            !permit.requestDigest.equals(request.digest())
        ) {
            throw corrupt();
        }
        return permit;
    }

    private decodeDenied(
        transaction: TransactionalSqlite,
        row: SqliteRow,
        expectedNonce: string
    ): TargetAuthorityPermitDenial {
        this.validateOwner(row);
        const bytes = row["denial"];
        if (!(bytes instanceof Uint8Array)) throw corrupt();
        let denial: TargetAuthorityPermitDenial;
        try {
            denial = TargetAuthorityPermitDenial.decode(bytes.slice());
        } catch {
            throw corrupt();
        }
        const request = this.requested(transaction, expectedNonce);
        if (
            request === undefined ||
            denial.request.nonce !== expectedNonce ||
            text(row, "nonce") !== expectedNonce ||
            text(row, "digest") !== denial.digest().value ||
            !denial.request.expectation.target.actor.equals(this.owner) ||
            !denial.request.digest().equals(request.digest())
        ) {
            throw corrupt();
        }
        return denial;
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
        if (!isActiveSqliteActorTransaction(transaction)) {
            throw new AgentCoreError(
                "actor.stale-callback",
                "Authority permit writes require the active SQLite Actor transaction"
            );
        }
    }
}

/** SQLite source-Actor store for immutable target lease evidence. */
export class SqliteTargetLeaseEvidenceStore
    implements TargetLeaseEvidenceStore<TransactionalSqlite>
{
    readonly #actors: SqliteActorStore;

    public constructor(
        private readonly database: TransactionalSqlite,
        public readonly owner: ActorRef
    ) {
        this.#actors = new SqliteActorStore(database);
        database.transaction(() => {
            database.run(CREATE_SOURCE_LEASE_EVIDENCE, []);
        });
        this.#actors.transaction((transaction) => this.validateRows(transaction));
    }

    public transaction<Result>(
        operation: (transaction: TransactionalSqlite) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#actors.transaction(operation, ...guard);
    }

    public evidence(
        transaction: TransactionalSqlite,
        idempotencyKey: string
    ): TargetLeaseEvidence | undefined {
        this.requireTransaction(transaction);
        const row = transaction.all(
            `SELECT * FROM authority_target_lease_evidence
             WHERE owner_kind = ? AND owner_id = ? AND idempotency_key = ?`,
            [this.owner.kind, this.owner.id.value, idempotencyKey]
        )[0];
        if (row === undefined) return undefined;
        return this.decode(row, idempotencyKey);
    }

    public record(
        transaction: TransactionalSqlite,
        evidence: TargetLeaseEvidence
    ): TargetLeaseEvidence {
        this.requireTransaction(transaction);
        if (!evidence.key.source.equals(this.owner)) {
            throw denied("Target lease evidence belongs to another source Actor");
        }
        try {
            transaction.run(
                `INSERT OR IGNORE INTO authority_target_lease_evidence
                    (owner_kind, owner_id, idempotency_key, digest, evidence)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    this.owner.kind,
                    this.owner.id.value,
                    evidence.key.idempotencyKey,
                    evidence.digest().value,
                    TargetLeaseEvidence.encode(evidence)
                ]
            );
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw denied("Target lease evidence could not be recorded atomically");
        }
        const stored = this.evidence(transaction, evidence.key.idempotencyKey);
        if (stored === undefined) throw conflict("Target lease evidence did not persist");
        if (!stored.digest().equals(evidence.digest())) {
            throw denied("Target lease evidence key is bound to another source attestation");
        }
        return stored;
    }

    private validateRows(transaction: TransactionalSqlite): void {
        this.requireTransaction(transaction);
        const rows = transaction.all(
            `SELECT * FROM authority_target_lease_evidence
             WHERE owner_kind = ? AND owner_id = ? ORDER BY idempotency_key`,
            [this.owner.kind, this.owner.id.value]
        );
        for (const row of rows) {
            this.decode(row, text(row, "idempotency_key"));
        }
    }

    private decode(row: SqliteRow, idempotencyKey: string): TargetLeaseEvidence {
        const bytes = row["evidence"];
        if (!(bytes instanceof Uint8Array)) throw corrupt();
        const evidence = TargetLeaseEvidence.decode(bytes.slice());
        if (
            text(row, "owner_kind") !== this.owner.kind ||
            text(row, "owner_id") !== this.owner.id.value ||
            text(row, "idempotency_key") !== idempotencyKey ||
            text(row, "digest") !== evidence.digest().value ||
            !evidence.key.source.equals(this.owner) ||
            evidence.key.idempotencyKey !== idempotencyKey
        ) {
            throw corrupt();
        }
        return evidence;
    }

    private requireTransaction(transaction: TransactionalSqlite): void {
        if (
            !(transaction instanceof TransactionalSqlite) ||
            !hasSameSqliteProvenance(this.database, transaction)
        ) {
            throw new TypeError("Target lease evidence transaction belongs to another SQLite owner");
        }
        if (!isActiveSqliteActorTransaction(transaction)) {
            throw new AgentCoreError(
                "actor.stale-callback",
                "Target lease evidence writes require the active SQLite Actor transaction"
            );
        }
    }
}

/** Binds a Tenant's current authority view and issued permits to one SQLite transaction. */
export class SqliteTenantAuthorityPermitStore
    extends TenantAuthorityTransactionPort<TransactionalSqlite>
    implements
        ActorLocalStore<TransactionalSqlite, ReadableSqlite>,
        AuthorityPermitIssueStore<TransactionalSqlite>
{
    readonly #permits: SqliteAuthorityPermitStore;
    readonly #authority: TenantAuthorityReadStore;
    readonly #actors: SqliteActorStore;

    public constructor(
        private readonly database: TransactionalSqlite,
        public readonly owner: ActorRef
    ) {
        super();
        if (owner.kind !== "tenant") {
            throw new TypeError("SQLite Tenant authority permit store requires a Tenant Actor");
        }
        this.#authority = createSqliteTenantControlStore(database);
        this.#permits = new SqliteAuthorityPermitStore(database, owner);
        this.#actors = new SqliteActorStore(database);
    }

    public bindActor(actor: ActorRef): void {
        this.#actors.bindActor(actor);
    }

    public activateActor(
        actor: ActorRef,
        start: (transaction: TransactionalSqlite, activation: ActorActivation) => void
    ): ActorRecoveryState {
        return this.#actors.activateActor(actor, start);
    }

    public loadRecoveryState(
        transaction: TransactionalSqlite,
        actor: ActorRef
    ): ActorRecoveryState | undefined {
        return this.#actors.loadRecoveryState(transaction, actor);
    }

    public saveRecoveryState(transaction: TransactionalSqlite, state: ActorRecoveryState): void {
        this.#actors.saveRecoveryState(transaction, state);
    }

    public authority(transaction: TransactionalSqlite): TenantAuthorityReadStore {
        this.requireTransaction(transaction);
        return this.#authority;
    }

    public transaction<Result>(
        operation: TransactionOperation<TransactionalSqlite, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#actors.transaction(operation, ...guard);
    }

    public read<Result>(
        transaction: TransactionalSqlite,
        operation: TransactionOperation<ReadableSqlite, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#actors.read(transaction, operation, ...guard);
    }

    public projectedEvidence(
        transaction: TransactionalSqlite,
        reference: TargetLeaseEvidenceReference
    ): TargetLeaseEvidence | undefined {
        return this.#permits.projectedEvidence(transaction, reference);
    }

    public projectEvidence(
        transaction: TransactionalSqlite,
        evidence: TargetLeaseEvidence
    ): TargetLeaseEvidence {
        return this.#permits.projectEvidence(transaction, evidence);
    }

    public issued(transaction: TransactionalSqlite, nonce: string): AuthorityPermit | undefined {
        return this.#permits.issued(transaction, nonce);
    }

    public issue(transaction: TransactionalSqlite, permit: AuthorityPermit): AuthorityPermit {
        return this.#permits.issue(transaction, permit);
    }

    private requireTransaction(transaction: TransactionalSqlite): void {
        if (
            !(transaction instanceof TransactionalSqlite) ||
            !hasSameSqliteProvenance(this.database, transaction)
        ) {
            throw new TypeError("Tenant authority transaction belongs to another SQLite owner");
        }
        if (!isActiveSqliteActorTransaction(transaction)) {
            throw new AgentCoreError(
                "actor.stale-callback",
                "Tenant authority writes require the active SQLite Actor transaction"
            );
        }
    }
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (!isSqliteText(value) || value.length === 0) throw corrupt();
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

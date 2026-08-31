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

/**
 * One bounded page of this owner's rows, and the deletes a settled expired nonce implies.
 * Expiry is read from the stored record rather than from a column: these tables are created
 * lazily with IF NOT EXISTS and no migrator owns them, so adding a column would leave every
 * database that already exists without it. Decoding a bounded page per sweep costs a known
 * amount and keeps the schema exactly as every release before it wrote.
 */
const PRUNE_CANDIDATES = `SELECT * FROM authority_permit_nonces
    WHERE owner_kind = ? AND owner_id = ? AND nonce > ? ORDER BY nonce LIMIT ?`;
const PRUNE_CONSUMPTION = "DELETE FROM authority_permit_consumptions WHERE nonce = ?";
const PRUNE_DENIAL = "DELETE FROM authority_permit_denials WHERE nonce = ?";
const PRUNE_NONCE = "DELETE FROM authority_permit_nonces WHERE nonce = ?";

/**
 * Proves a prune sweep is bounded and its horizon is a real instant, returning that instant.
 * Both are construction shape rather than operational conditions, so both refuse with
 * TypeError, and they refuse in one named place so no call site re-states the rule.
 */
function requirePruneBounds(before: Date, limit: number): number {
    const horizon = before.getTime();
    if (!Number.isSafeInteger(horizon) || horizon < 0) {
        throw new TypeError("Authority permit prune horizon must be a valid time");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TypeError("Authority permit prune limit must be a positive safe integer");
    }
    return horizon;
}

/** One prune page: what it removed, how far it read, and where the next page resumes. */
export interface AuthorityPermitPrunePage {
    readonly removed: number;
    readonly examined: number;
    readonly more: boolean;
    readonly cursor: string;
}

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
            // No full-table validation here. Every read path already validates the exact
            // row it decodes, so scanning and decoding all three tables on construction
            // repeated that work over the store's whole lifetime history — O(total permits)
            // synchronous CPU and memory on every cold start, growing without bound and
            // eventually making the owning Actor unconstructable, with no reachable drain
            // because construction precedes every operation. Corruption is now reported by
            // the read that meets it, which is also the only read that needs it.
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
        // Ownership before corruption. A shared database holds other Actors' rows, and a row
        // this store does not own is that Actor's business, not evidence of a broken store.
        if (row === undefined || this.ownedByAnother(row)) return undefined;
        if (this.requireNonceState(row, nonce) !== "issued") return undefined;
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
            [reference.key.source.kind, reference.key.source.id.value, reference.key.idempotencyKey]
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
            [evidence.key.source.kind, evidence.key.source.id.value, evidence.key.idempotencyKey]
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
        // Ownership before corruption; see `issued`. This is also what preserves cross-owner
        // occupancy, since consume reads this and must see "not mine", not "malformed".
        if (row === undefined || this.ownedByAnother(row)) return undefined;
        if (this.requireNonceState(row, nonce) !== "requested") return undefined;
        return this.decodeRequested(row, nonce);
    }

    public consumed(transaction: TransactionalSqlite, nonce: string): Digest | undefined {
        const row = this.consumptionRow(transaction, nonce);
        if (row === undefined) return undefined;
        // The mirror of `denied`: a nonce cannot be both consumed and denied, so a row set
        // showing both is corruption whichever side the reader came from.
        if (this.denialRow(transaction, nonce) !== undefined) throw corrupt();
        return this.decodeConsumed(transaction, row, nonce).digest();
    }

    public denied(
        transaction: TransactionalSqlite,
        nonce: string
    ): TargetAuthorityPermitDenial | undefined {
        const row = this.denialRow(transaction, nonce);
        if (row === undefined) return undefined;
        // A nonce cannot be both denied and consumed: no pair of writes produces it, so a row
        // set that shows both is corruption. Recovery used to catch this by scanning; the read
        // that meets it catches it now.
        if (this.consumptionRow(transaction, nonce) !== undefined) throw corrupt();
        return this.decodeDenied(transaction, row, nonce);
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
            throw this.occupancyDenial(
                transaction,
                request.nonce,
                "Authority permit target request could not be recorded atomically"
            );
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
            throw this.occupancyDenial(
                transaction,
                permit.nonce,
                "Authority permit nonce could not be issued atomically"
            );
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
        // Occupancy first, and on the owner columns alone. A nonce row belonging to another
        // Actor is not corruption, it is that Actor holding the nonce, and deciding it here
        // keeps the semantic refusal ahead of any decode that would call the same row
        // malformed for having a different owner.
        const occupant = this.row(transaction, permit.nonce);
        if (occupant !== undefined && this.ownedByAnother(occupant)) {
            throw denied("Authority permit nonce is already held by another Actor owner");
        }
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

    /**
     * Deletes rows whose permit expiry precedes `before`, reading at most `limit` candidates
     * after the `after` cursor, and reports where the next page resumes.
     *
     * Time settles a permit, not the consumption ledger. An expired permit can decide nothing
     * on either side: issuance refuses a request whose expiry is not after the issuance clock,
     * and assertConsumable refuses a permit outside its window, so a row whose expiry has
     * passed buys nothing whether or not it was ever consumed or denied. Keying retention on
     * settled rows left every unsettled row — an abandoned request, an issuance the target
     * never came back for — resident forever, which is the unbounded growth this exists to
     * stop. The caller subtracts its retention from the horizon, so `before` already means
     * expiry plus retention.
     *
     * The page is a keyset, not an offset. A fixed `ORDER BY nonce LIMIT n` window is occupied
     * by whatever sorts first, so a run of rows too young to prune at the head of the ordering
     * would fill every page forever and no later row would ever be reached. The cursor moves
     * past everything examined, pruned or not, so the sweep always advances.
     *
     * Excluded on purpose: authority_permit_lease_evidence. Its rows are keyed by source and
     * idempotency key rather than by nonce, so this nonce-ordered walk cannot reach them
     * coherently, and a source may legitimately re-project an attestation after the permit it
     * attested expired. Sweeping it needs its own source-keyed pass; the exclusion is recorded
     * on the conformance row rather than left for a reader to infer.
     */
    public prune(
        transaction: TransactionalSqlite,
        before: Date,
        limit: number,
        after = ""
    ): AuthorityPermitPrunePage {
        this.requireTransaction(transaction);
        const horizon = requirePruneBounds(before, limit);
        let candidates: readonly SqliteRow[];
        try {
            candidates = transaction.all(PRUNE_CANDIDATES, [
                this.owner.kind,
                this.owner.id.value,
                after,
                limit
            ]);
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Authority permit prune read failed");
        }
        let removed = 0;
        let cursor = after;
        for (const row of candidates) {
            const nonce = text(row, "nonce");
            cursor = nonce;
            const expiresAt = this.storedExpiry(row);
            if (expiresAt === undefined || expiresAt >= horizon) continue;
            try {
                transaction.run(PRUNE_CONSUMPTION, [nonce]);
                transaction.run(PRUNE_DENIAL, [nonce]);
                transaction.run(PRUNE_NONCE, [nonce]);
            } catch (error) {
                if (error instanceof AgentCoreError) throw error;
                throw corrupt("Authority permit prune failed");
            }
            removed += 1;
        }
        // `more` is whether the page filled, never how much it removed. A page of rows all too
        // young removes nothing and still has successors, and a sweep keyed on `removed` would
        // switch itself off exactly there.
        return Object.freeze({
            removed,
            examined: candidates.length,
            more: candidates.length >= limit,
            cursor
        });
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

    /**
     * The state a nonce row declares, refused when it is not one this store writes or when
     * the stored record does not match it.
     *
     * A reader must not filter on state and return nothing: an unknown state, or a record of
     * the wrong kind for its state, is corruption and silently reading past it hands a caller
     * "no such nonce" for a row that exists. Recovery caught this by decoding every row on
     * construction; the read that meets the row catches it now, which is the same refusal
     * without the unbounded startup scan.
     */
    private requireNonceState(row: SqliteRow, nonce: string): "requested" | "issued" {
        this.validateOwner(row);
        const state = text(row, "state");
        if (state !== "requested" && state !== "issued") throw corrupt();
        const record = row["record"];
        if (!(record instanceof Uint8Array)) throw corrupt();
        // Decoding under the declared state is what rejects a record resurrected over a spent
        // nonce: an issued permit stored under `requested`, or a request stored under `issued`,
        // fails here rather than being served as the other kind.
        try {
            if (state === "issued") AuthorityPermit.decode(record.slice());
            else TargetAuthorityPermitRequest.decode(record.slice());
        } catch {
            throw corrupt();
        }
        if (text(row, "nonce") !== nonce) throw corrupt();
        return state;
    }

    /**
     * The expiry a stored nonce row carries, for a store on either side of the permit.
     *
     * `decodeIssued` cannot serve this: it asserts the permit's issuer IS this store's owner,
     * which holds on the Tenant side and never on the target side, so a target's prune would
     * find nothing prunable at all.
     */
    private storedExpiry(row: SqliteRow): number | undefined {
        const record = row["record"];
        if (!(record instanceof Uint8Array)) throw corrupt();
        const state = text(row, "state");
        if (state !== "requested" && state !== "issued") throw corrupt();
        try {
            // Both records carry the same expiry; which one is stored depends on which side
            // of the permit this store is, so the state chooses the decoder.
            return state === "issued"
                ? AuthorityPermit.decode(record.slice()).expiresAt.getTime()
                : TargetAuthorityPermitRequest.decode(record.slice()).expiresAt.getTime();
        } catch {
            throw corrupt();
        }
    }

    /**
     * The refusal a nonce that would not take a write deserves, named for who actually holds
     * it. `INSERT OR IGNORE` no-ops silently against a row another Actor owns, and the
     * read-back then sees nothing; reporting that as this Actor having used the nonce blames
     * the wrong party and hides a shared-database collision behind a replay message.
     */
    private occupancyDenial(
        transaction: TransactionalSqlite,
        nonce: string,
        vanished: string
    ): AgentCoreError {
        const occupant = this.row(transaction, nonce);
        // No row at all means the write vanished rather than that anyone used the nonce.
        // Reporting a replay there names an event that never happened and hides a storage
        // fault behind an authority answer, so the caller's own atomic-write text is what
        // this case deserves.
        if (occupant === undefined) return denied(vanished);
        if (this.ownedByAnother(occupant)) {
            return denied("Authority permit nonce is already held by another Actor owner");
        }
        return denied("Authority permit nonce was already used by this Actor owner");
    }

    /** Whether this row's owner columns name an Actor other than this store's owner. */
    private ownedByAnother(row: SqliteRow): boolean {
        return (
            text(row, "owner_kind") !== this.owner.kind ||
            text(row, "owner_id") !== this.owner.id.value
        );
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

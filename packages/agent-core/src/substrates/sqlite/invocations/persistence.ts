import { AgentCoreError } from "../../../errors";
import type { RecordCodec } from "../../../core";
import { TransactionalSqlite, type SqliteRow } from "../sqlite";
import { InvocationError } from "../../../invocations";

interface TextReference {
    readonly value: string;
}

export interface PreparedProjection {
    readonly id: string;
}

export interface ApprovalProjection {
    readonly id: string;
    readonly invocation: string;
    readonly revision: number;
    readonly phase: string;
}

export interface ClaimProjection {
    readonly id: string;
    readonly invocation: string;
    readonly itemIndex: number;
    readonly ordinal: number;
}

export interface AttemptProjection {
    readonly id: string;
    readonly invocation: string;
    readonly itemIndex: number;
    readonly ordinal: number;
    readonly claim: string;
}

export interface ContinuationProjection {
    readonly invocation: string;
}

export type ReceiptProjection =
    | {
          readonly id: string;
          readonly variant: "preEffect";
          readonly invocation: string;
          readonly itemIndex: number;
          readonly outcome: string;
      }
    | {
          readonly id: string;
          readonly variant: "attempt";
          readonly attempt: string;
          readonly previous?: string;
          readonly outcome: string;
      };

export interface SqliteInvocationCodecs<Prepared, Approval, Claim, Attempt, Receipt, Continuation> {
    readonly prepared: RecordCodec<Prepared>;
    readonly approval: RecordCodec<Approval>;
    readonly claim: RecordCodec<Claim>;
    readonly attempt: RecordCodec<Attempt>;
    readonly receipt: RecordCodec<Receipt>;
    readonly continuation: RecordCodec<Continuation>;
    projectPrepared(record: Prepared): PreparedProjection;
    projectApproval(record: Approval): ApprovalProjection;
    projectClaim(record: Claim): ClaimProjection;
    projectAttempt(record: Attempt): AttemptProjection;
    projectReceipt(record: Receipt): ReceiptProjection;
    projectContinuation(record: Continuation): ContinuationProjection;
}

const CREATE_PREPARED = `CREATE TABLE IF NOT EXISTS invocation_prepared_records (
    id TEXT PRIMARY KEY,
    record BLOB NOT NULL
)`;

const CREATE_APPROVAL_IDENTITIES = `CREATE TABLE IF NOT EXISTS invocation_approval_identities (
    invocation_id TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL UNIQUE
)`;

const CREATE_APPROVALS = `CREATE TABLE IF NOT EXISTS invocation_approval_revisions (
    approval_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    phase TEXT NOT NULL,
    record BLOB NOT NULL,
    PRIMARY KEY (approval_id, revision)
)`;

const CREATE_CLAIMS = `CREATE TABLE IF NOT EXISTS invocation_item_claims (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    invocation_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    record BLOB NOT NULL
)`;

const CREATE_CONTINUATIONS = `CREATE TABLE IF NOT EXISTS invocation_continuations (
    invocation_id TEXT PRIMARY KEY,
    record BLOB NOT NULL
)`;

const CREATE_ATTEMPTS = `CREATE TABLE IF NOT EXISTS invocation_effect_attempts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    invocation_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    claim_id TEXT NOT NULL UNIQUE,
    record BLOB NOT NULL,
    UNIQUE (invocation_id, item_index, ordinal)
)`;

const CREATE_RECEIPTS = `CREATE TABLE IF NOT EXISTS invocation_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    variant TEXT NOT NULL CHECK (variant IN ('preEffect', 'attempt')),
    invocation_id TEXT NOT NULL,
    item_index INTEGER NOT NULL CHECK (item_index >= 0),
    attempt_id TEXT,
    previous_id TEXT UNIQUE,
    outcome TEXT NOT NULL,
    record BLOB NOT NULL,
    CHECK (
        (variant = 'preEffect' AND attempt_id IS NULL AND previous_id IS NULL)
        OR (variant = 'attempt' AND attempt_id IS NOT NULL)
    )
)`;

const CREATE_PRE_EFFECT_UNIQUE = `CREATE UNIQUE INDEX IF NOT EXISTS invocation_pre_effect_item
    ON invocation_receipts (invocation_id, item_index)
    WHERE variant = 'preEffect'`;

const CREATE_INITIAL_ATTEMPT_RECEIPT_UNIQUE = `CREATE UNIQUE INDEX IF NOT EXISTS invocation_initial_attempt_receipt
    ON invocation_receipts (attempt_id)
    WHERE variant = 'attempt' AND previous_id IS NULL`;

export class SqliteInvocationPersistence<
    Prepared,
    Approval,
    Claim,
    Attempt,
    Receipt,
    Continuation
> {
    public constructor(
        database: TransactionalSqlite,
        private readonly codecs: SqliteInvocationCodecs<
            Prepared,
            Approval,
            Claim,
            Attempt,
            Receipt,
            Continuation
        >
    ) {
        database.transaction(() => {
            for (const statement of [
                CREATE_PREPARED,
                CREATE_APPROVAL_IDENTITIES,
                CREATE_APPROVALS,
                CREATE_CONTINUATIONS,
                CREATE_CLAIMS,
                CREATE_ATTEMPTS,
                CREATE_RECEIPTS,
                CREATE_PRE_EFFECT_UNIQUE,
                CREATE_INITIAL_ATTEMPT_RECEIPT_UNIQUE
            ])
                database.run(statement, []);
        });
    }

    public prepared(transaction: TransactionalSqlite, id: TextReference): Prepared | undefined {
        const row = this.one(
            transaction,
            "SELECT id, record FROM invocation_prepared_records WHERE id = ?",
            [id.value]
        );
        if (row === undefined) return undefined;
        const record = this.codecs.prepared.decode(bytes(row, "record"));
        const projection = this.codecs.projectPrepared(record);
        if (text(row, "id") !== id.value || projection.id !== id.value) corrupt();
        return record;
    }

    public insertPrepared(transaction: TransactionalSqlite, record: Prepared): void {
        const projection = this.codecs.projectPrepared(record);
        appendRecord(
            transaction,
            "INSERT INTO invocation_prepared_records (id, record) VALUES (?, ?)",
            [projection.id, this.codecs.prepared.encode(record)]
        );
    }

    public approval(transaction: TransactionalSqlite, id: TextReference): Approval | undefined {
        const row = this.one(
            transaction,
            `SELECT approval_id, invocation_id, revision, phase, record
             FROM invocation_approval_revisions WHERE approval_id = ?
             ORDER BY revision DESC LIMIT 1`,
            [id.value]
        );
        return row === undefined ? undefined : this.decodeApproval(row);
    }

    public approvalForInvocation(
        transaction: TransactionalSqlite,
        invocation: TextReference
    ): Approval | undefined {
        const row = this.one(
            transaction,
            "SELECT approval_id FROM invocation_approval_identities WHERE invocation_id = ?",
            [invocation.value]
        );
        if (row === undefined) return undefined;
        const approval = this.approval(transaction, { value: text(row, "approval_id") });
        return approval === undefined ||
            this.codecs.projectApproval(approval).invocation !== invocation.value
            ? corrupt()
            : approval;
    }

    public approvalRevision(
        transaction: TransactionalSqlite,
        id: TextReference,
        revision: number
    ): Approval | undefined {
        const row = this.one(
            transaction,
            `SELECT approval_id, invocation_id, revision, phase, record
             FROM invocation_approval_revisions WHERE approval_id = ? AND revision = ?`,
            [id.value, revision]
        );
        return row === undefined ? undefined : this.decodeApproval(row);
    }

    public appendApproval(transaction: TransactionalSqlite, record: Approval): void {
        const projection = this.codecs.projectApproval(record);
        if (projection.revision === 0) {
            appendRecord(
                transaction,
                `INSERT INTO invocation_approval_identities (invocation_id, approval_id)
                 VALUES (?, ?)`,
                [projection.invocation, projection.id]
            );
        } else {
            const identity = this.one(
                transaction,
                "SELECT approval_id FROM invocation_approval_identities WHERE invocation_id = ?",
                [projection.invocation]
            );
            if (identity === undefined || text(identity, "approval_id") !== projection.id)
                corrupt();
        }
        appendRecord(
            transaction,
            `INSERT INTO invocation_approval_revisions
             (approval_id, invocation_id, revision, phase, record) VALUES (?, ?, ?, ?, ?)`,
            [
                projection.id,
                projection.invocation,
                projection.revision,
                projection.phase,
                this.codecs.approval.encode(record)
            ]
        );
    }

    public continuation(
        transaction: TransactionalSqlite,
        invocation: TextReference
    ): Continuation | undefined {
        const row = this.one(
            transaction,
            "SELECT invocation_id, record FROM invocation_continuations WHERE invocation_id = ?",
            [invocation.value]
        );
        if (row === undefined) return undefined;
        const record = this.codecs.continuation.decode(bytes(row, "record"));
        if (
            text(row, "invocation_id") !== invocation.value ||
            this.codecs.projectContinuation(record).invocation !== invocation.value
        ) {
            corrupt();
        }
        return record;
    }

    public insertContinuation(transaction: TransactionalSqlite, record: Continuation): void {
        const projection = this.codecs.projectContinuation(record);
        appendRecord(
            transaction,
            "INSERT INTO invocation_continuations (invocation_id, record) VALUES (?, ?)",
            [projection.invocation, this.codecs.continuation.encode(record)]
        );
    }

    public claim(transaction: TransactionalSqlite, id: TextReference): Claim | undefined {
        const row = this.one(
            transaction,
            `SELECT id, invocation_id, item_index, ordinal, record
             FROM invocation_item_claims WHERE id = ?`,
            [id.value]
        );
        return row === undefined ? undefined : this.decodeClaim(row);
    }

    public claimsForItem(
        transaction: TransactionalSqlite,
        invocation: TextReference,
        itemIndex: number
    ): readonly Claim[] {
        return transaction
            .all(
                `SELECT id, invocation_id, item_index, ordinal, record
             FROM invocation_item_claims WHERE invocation_id = ? AND item_index = ?
             ORDER BY sequence`,
                [invocation.value, itemIndex]
            )
            .map((row) => this.decodeClaim(row));
    }

    public appendClaim(transaction: TransactionalSqlite, record: Claim): void {
        const projection = this.codecs.projectClaim(record);
        appendRecord(
            transaction,
            `INSERT INTO invocation_item_claims
             (id, invocation_id, item_index, ordinal, record) VALUES (?, ?, ?, ?, ?)`,
            [
                projection.id,
                projection.invocation,
                projection.itemIndex,
                projection.ordinal,
                this.codecs.claim.encode(record)
            ]
        );
    }

    public attempt(transaction: TransactionalSqlite, id: TextReference): Attempt | undefined {
        const row = this.one(
            transaction,
            `SELECT id, invocation_id, item_index, ordinal, claim_id, record
             FROM invocation_effect_attempts WHERE id = ?`,
            [id.value]
        );
        return row === undefined ? undefined : this.decodeAttempt(row);
    }

    public attemptForClaim(
        transaction: TransactionalSqlite,
        claim: TextReference
    ): Attempt | undefined {
        const row = this.one(
            transaction,
            `SELECT id, invocation_id, item_index, ordinal, claim_id, record
             FROM invocation_effect_attempts WHERE claim_id = ?`,
            [claim.value]
        );
        return row === undefined ? undefined : this.decodeAttempt(row);
    }

    public attemptsForItem(
        transaction: TransactionalSqlite,
        invocation: TextReference,
        itemIndex: number
    ): readonly Attempt[] {
        return transaction
            .all(
                `SELECT id, invocation_id, item_index, ordinal, claim_id, record
             FROM invocation_effect_attempts WHERE invocation_id = ? AND item_index = ?
             ORDER BY ordinal`,
                [invocation.value, itemIndex]
            )
            .map((row) => this.decodeAttempt(row));
    }

    public appendAttempt(transaction: TransactionalSqlite, record: Attempt): void {
        const projection = this.codecs.projectAttempt(record);
        appendRecord(
            transaction,
            `INSERT INTO invocation_effect_attempts
             (id, invocation_id, item_index, ordinal, claim_id, record)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                projection.id,
                projection.invocation,
                projection.itemIndex,
                projection.ordinal,
                projection.claim,
                this.codecs.attempt.encode(record)
            ]
        );
    }

    public receipt(transaction: TransactionalSqlite, id: TextReference): Receipt | undefined {
        const row = this.one(
            transaction,
            `SELECT id, variant, invocation_id, item_index, attempt_id, previous_id, outcome, record
             FROM invocation_receipts WHERE id = ?`,
            [id.value]
        );
        return row === undefined ? undefined : this.decodeReceipt(transaction, row);
    }

    public receiptsForItem(
        transaction: TransactionalSqlite,
        invocation: TextReference,
        itemIndex: number
    ): readonly Receipt[] {
        return transaction
            .all(
                `SELECT id, variant, invocation_id, item_index, attempt_id, previous_id, outcome, record
             FROM invocation_receipts WHERE invocation_id = ? AND item_index = ?
             ORDER BY sequence`,
                [invocation.value, itemIndex]
            )
            .map((row) => this.decodeReceipt(transaction, row));
    }

    public receiptsForAttempt(
        transaction: TransactionalSqlite,
        attempt: TextReference
    ): readonly Receipt[] {
        return transaction
            .all(
                `SELECT id, variant, invocation_id, item_index, attempt_id, previous_id, outcome, record
             FROM invocation_receipts WHERE attempt_id = ? ORDER BY sequence`,
                [attempt.value]
            )
            .map((row) => this.decodeReceipt(transaction, row));
    }

    public appendReceipt(transaction: TransactionalSqlite, record: Receipt): void {
        const projection = this.codecs.projectReceipt(record);
        let invocation: string;
        let itemIndex: number;
        if (projection.variant === "preEffect") {
            invocation = projection.invocation;
            itemIndex = projection.itemIndex;
        } else {
            const attempt = this.attempt(transaction, { value: projection.attempt });
            if (attempt === undefined) {
                throw new InvocationError(
                    "store.missing-evidence",
                    "Attempt Receipt requires an existing EffectAttempt"
                );
            }
            const attemptProjection = this.codecs.projectAttempt(attempt);
            invocation = attemptProjection.invocation;
            itemIndex = attemptProjection.itemIndex;
        }
        appendRecord(
            transaction,
            `INSERT INTO invocation_receipts
             (id, variant, invocation_id, item_index, attempt_id, previous_id, outcome, record)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                projection.id,
                projection.variant,
                invocation,
                itemIndex,
                projection.variant === "attempt" ? projection.attempt : null,
                projection.variant === "attempt" ? (projection.previous ?? null) : null,
                projection.outcome,
                this.codecs.receipt.encode(record)
            ]
        );
    }

    private decodeApproval(row: SqliteRow): Approval {
        const record = this.codecs.approval.decode(bytes(row, "record"));
        const projection = this.codecs.projectApproval(record);
        if (
            projection.id !== text(row, "approval_id") ||
            projection.invocation !== text(row, "invocation_id") ||
            projection.revision !== integer(row, "revision") ||
            projection.phase !== text(row, "phase")
        )
            corrupt();
        return record;
    }

    private decodeClaim(row: SqliteRow): Claim {
        const record = this.codecs.claim.decode(bytes(row, "record"));
        const projection = this.codecs.projectClaim(record);
        if (
            projection.id !== text(row, "id") ||
            projection.invocation !== text(row, "invocation_id") ||
            projection.itemIndex !== integer(row, "item_index") ||
            projection.ordinal !== integer(row, "ordinal")
        )
            corrupt();
        return record;
    }

    private decodeAttempt(row: SqliteRow): Attempt {
        const record = this.codecs.attempt.decode(bytes(row, "record"));
        const projection = this.codecs.projectAttempt(record);
        if (
            projection.id !== text(row, "id") ||
            projection.invocation !== text(row, "invocation_id") ||
            projection.itemIndex !== integer(row, "item_index") ||
            projection.ordinal !== integer(row, "ordinal") ||
            projection.claim !== text(row, "claim_id")
        )
            corrupt();
        return record;
    }

    private decodeReceipt(transaction: TransactionalSqlite, row: SqliteRow): Receipt {
        const record = this.codecs.receipt.decode(bytes(row, "record"));
        const projection = this.codecs.projectReceipt(record);
        const attempt = nullableText(row, "attempt_id");
        const previous = nullableText(row, "previous_id");
        if (
            projection.id !== text(row, "id") ||
            projection.variant !== text(row, "variant") ||
            projection.outcome !== text(row, "outcome") ||
            (projection.variant === "preEffect"
                ? projection.invocation !== text(row, "invocation_id") ||
                  projection.itemIndex !== integer(row, "item_index") ||
                  attempt !== undefined ||
                  previous !== undefined
                : projection.attempt !== attempt || projection.previous !== previous)
        )
            corrupt();
        if (projection.variant === "attempt") {
            const source = this.attempt(transaction, { value: projection.attempt });
            if (source === undefined) corrupt();
            const sourceProjection = this.codecs.projectAttempt(source);
            if (
                sourceProjection.invocation !== text(row, "invocation_id") ||
                sourceProjection.itemIndex !== integer(row, "item_index")
            )
                corrupt();
        }
        return record;
    }

    private one(
        transaction: TransactionalSqlite,
        statement: string,
        bindings: readonly (string | number)[]
    ): SqliteRow | undefined {
        return transaction.all(statement, bindings)[0];
    }
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string") corrupt();
    return value;
}

function nullableText(row: SqliteRow, column: string): string | undefined {
    const value = row[column];
    if (value === null) return undefined;
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

function corrupt(): never {
    throw new AgentCoreError(
        "codec.invalid",
        "Stored invocation projection does not match codec bytes"
    );
}

function appendRecord(
    transaction: TransactionalSqlite,
    statement: string,
    bindings: readonly (string | number | Uint8Array | null)[]
): void {
    try {
        transaction.run(statement, bindings);
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        if (!isConstraintFailure(error)) throw error;
        throw new InvocationError("store.duplicate-record", "Invocation record append conflicted");
    }
}

function isConstraintFailure(error: unknown): boolean {
    if (error === null || typeof error !== "object") return false;
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) return true;
    const message = (error as { readonly message?: unknown }).message;
    return typeof message === "string" && /(?:constraint|unique)/iu.test(message);
}

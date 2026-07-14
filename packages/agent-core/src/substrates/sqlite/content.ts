import type { ActorRef } from "../../actors";
import {
    ByteRange,
    ContentStat,
    ContentStore,
    MediaHint,
    type ContentPutResult
} from "../../content";
import { ContentRef, Digest } from "../../core";
import { AgentCoreError } from "../../errors";
import type { TenantId } from "../../identity";
import { SqliteContentRetention, SqliteTransientContentAccess } from "./content-retention";
import { type SqliteRow, TransactionalSqlite } from "./sqlite";

const CREATE_CONTENT = `CREATE TABLE IF NOT EXISTS content_blobs (
    ref TEXT PRIMARY KEY CHECK (
        length(ref) = 71
        AND substr(ref, 1, 7) = 'sha256:'
        AND substr(ref, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    digest TEXT NOT NULL CHECK (
        length(digest) = 64
        AND digest NOT GLOB '*[^0-9a-f]*'
    ),
    bytes BLOB NOT NULL,
    media_type TEXT CHECK (media_type IS NULL OR length(media_type) BETWEEN 1 AND 255),
    size INTEGER NOT NULL CHECK (size >= 0)
) STRICT`;

export interface StoredSqliteContent {
    readonly ref: ContentRef;
    readonly digest: Digest;
    readonly bytes: Uint8Array;
    readonly hint: MediaHint | undefined;
    readonly size: number;
}

export class SqliteContentStore extends ContentStore {
    public constructor(private readonly database: TransactionalSqlite) {
        super();
        this.database.transaction(() => {
            initializeSqliteContent(this.database);
        });
    }

    public retention(tenant: TenantId, actor: ActorRef): SqliteContentRetention {
        return new SqliteContentRetention(this.database, tenant, actor);
    }

    public transient(
        tenant: TenantId,
        actor: ActorRef,
        now?: () => Date
    ): SqliteTransientContentAccess {
        return new SqliteTransientContentAccess(this.database, tenant, actor, now);
    }

    public async put(bytesValue: Uint8Array, hint?: MediaHint): Promise<ContentPutResult> {
        const detached = bytesValue.slice();
        const digest = Digest.sha256(detached);
        const ref = ContentRef.fromDigest(digest);
        this.database.transaction(() => {
            insertSqliteContent(this.database, ref, digest, detached, hint);
            const content = loadSqliteContent(this.database, ref);
            if (content === undefined || !equalBytes(content.bytes, detached)) {
                throw corruptContent();
            }
        });
        return { ref, digest };
    }

    public async get(ref: ContentRef, range: ByteRange = ByteRange.all()): Promise<Uint8Array> {
        const content = loadSqliteContent(this.database, ref);
        if (content === undefined) throw contentNotFound(ref);
        return range.read(content.bytes.slice()).slice();
    }

    public async stat(ref: ContentRef): Promise<ContentStat | undefined> {
        const content = loadSqliteContent(this.database, ref);
        return content === undefined ? undefined : sqliteContentStat(content);
    }
}

export function initializeSqliteContent(database: TransactionalSqlite): void {
    database.run(CREATE_CONTENT, []);
}

export function loadSqliteContent(
    database: TransactionalSqlite,
    ref: ContentRef
): StoredSqliteContent | undefined {
    const row = database.all(
        `SELECT ref, digest, bytes, media_type, size
         FROM content_blobs WHERE ref = ?`,
        [ref.value]
    )[0];
    return row === undefined ? undefined : validateContentRow(row, ref);
}

export function listSqliteContent(database: TransactionalSqlite): readonly StoredSqliteContent[] {
    return database
        .all(
            `SELECT ref, digest, bytes, media_type, size
         FROM content_blobs ORDER BY ref`,
            []
        )
        .map((row) => validateContentRow(row, new ContentRef(sqliteText(row, "ref"))));
}

export function deleteSqliteContent(database: TransactionalSqlite, ref: ContentRef): void {
    database.run("DELETE FROM content_blobs WHERE ref = ?", [ref.value]);
}

export function sqliteContentStat(content: StoredSqliteContent): ContentStat {
    return new ContentStat(content.ref, content.digest, content.size, content.hint);
}

export function insertSqliteContent(
    database: TransactionalSqlite,
    ref: ContentRef,
    digest: Digest,
    contentBytes: Uint8Array,
    hint?: MediaHint
): void {
    database.run(
        `INSERT OR IGNORE INTO content_blobs (ref, digest, bytes, media_type, size)
         VALUES (?, ?, ?, ?, ?)`,
        [ref.value, digest.value, contentBytes, hint?.mediaType ?? null, contentBytes.byteLength]
    );
}

function validateContentRow(row: SqliteRow, expectedRef: ContentRef): StoredSqliteContent {
    try {
        const ref = new ContentRef(sqliteText(row, "ref"));
        const digest = new Digest(sqliteText(row, "digest"));
        const contentBytes = sqliteBytes(row, "bytes");
        const size = sqliteInteger(row, "size");
        const mediaType = sqliteNullableText(row, "media_type");
        if (
            !ref.equals(expectedRef) ||
            !ref.digest.equals(digest) ||
            !digest.equals(Digest.sha256(contentBytes)) ||
            size !== contentBytes.byteLength
        )
            throw corruptContent();
        return {
            ref,
            digest,
            bytes: contentBytes,
            hint: mediaType === undefined ? undefined : new MediaHint(mediaType),
            size
        };
    } catch (error) {
        if (error instanceof AgentCoreError) throw error;
        throw corruptContent();
    }
}

export function sqliteBytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) throw invalidSqliteColumn("byte", column);
    return value;
}

export function sqliteText(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string") throw invalidSqliteColumn("string", column);
    return value;
}

function sqliteNullableText(row: SqliteRow, column: string): string | undefined {
    const value = row[column];
    if (value === null) return undefined;
    if (typeof value !== "string") throw invalidSqliteColumn("nullable string", column);
    return value;
}

export function sqliteInteger(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw invalidSqliteColumn("non-negative safe integer", column);
    }
    return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function contentNotFound(ref: ContentRef): AgentCoreError {
    return new AgentCoreError("content.not-found", `Content not found: ${ref.value}`);
}

function corruptContent(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored content is malformed");
}

function invalidSqliteColumn(expected: string, column: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", `Expected ${expected} column: ${column}`);
}

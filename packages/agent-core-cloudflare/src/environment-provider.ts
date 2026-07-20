import {
    AgentCoreError,
    ContentRef,
    Digest,
    Revision,
    TenantId,
    decodeBase64,
    decodeCanonicalJson,
    encodeBase64,
    encodeCanonicalJson,
    type JsonValue
} from "@agent-core/core";
import {
    EnvironmentProvider,
    EnvironmentId,
    EnvironmentSessionId,
    EnvironmentSnapshotId,
    PortExposureId,
    ProviderActionOutcome,
    ProviderDescriptor,
    ProviderResourceOutcome,
    type ExposePortRequest,
    type LiveEnvironmentSession,
    type OpenSessionRequest,
    type SnapshotEnvironmentRequest
} from "@agent-core/core/environment-provider";
import type { R2ContentObjectRepository } from "./content-object.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { SqliteApplicationMigration, SynchronousSqlitePort } from "./migration.js";

const SNAPSHOT_FORMAT = "agent-core-environment-snapshot/1";
const MAX_FILE_PATH_LENGTH = 1024;

const READ_PIN =
    "SELECT revision, generation FROM agent_core_environment_pins WHERE environment_id = ?";
const UPSERT_PIN = `INSERT INTO agent_core_environment_pins (environment_id, revision, generation)
    VALUES (?, ?, ?)
    ON CONFLICT (environment_id)
    DO UPDATE SET revision = excluded.revision, generation = excluded.generation`;
const READ_SESSION = `SELECT environment_id, revision, generation, session_epoch, restore_ref, state
    FROM agent_core_environment_sessions WHERE session_id = ?`;
const INSERT_SESSION = `INSERT INTO agent_core_environment_sessions
    (session_id, environment_id, revision, generation, session_epoch, restore_ref, state)
    VALUES (?, ?, ?, ?, ?, ?, ?)`;
const CLOSE_SESSION = `UPDATE agent_core_environment_sessions
        SET state = 'closed', session_epoch = session_epoch + 1 WHERE session_id = ?`;
const READ_FILE = `SELECT content FROM agent_core_environment_session_files
    WHERE session_id = ? AND path = ?`;
const READ_FILES = `SELECT path, content FROM agent_core_environment_session_files
    WHERE session_id = ? ORDER BY path`;
const UPSERT_FILE = `INSERT INTO agent_core_environment_session_files (session_id, path, content)
    VALUES (?, ?, ?)
    ON CONFLICT (session_id, path) DO UPDATE SET content = excluded.content`;
const DELETE_FILES = "DELETE FROM agent_core_environment_session_files WHERE session_id = ?";
const READ_SNAPSHOT = `SELECT environment_id, session_id, revision, generation, session_epoch, content_ref
    FROM agent_core_environment_snapshots WHERE snapshot_id = ?`;
const INSERT_SNAPSHOT = `INSERT INTO agent_core_environment_snapshots
    (snapshot_id, environment_id, session_id, revision, generation, session_epoch, content_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?)`;
const READ_EXPOSURE = `SELECT environment_id, session_id, revision, generation, session_epoch, port, url, state
    FROM agent_core_environment_exposures WHERE exposure_id = ?`;
const INSERT_EXPOSURE = `INSERT INTO agent_core_environment_exposures
    (exposure_id, environment_id, session_id, revision, generation, session_epoch, port, url, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const REVOKE_EXPOSURE = `UPDATE agent_core_environment_exposures
    SET url = NULL, state = 'revoked' WHERE exposure_id = ?`;
const REVOKE_SESSION_EXPOSURES = `UPDATE agent_core_environment_exposures
    SET url = NULL, state = 'revoked' WHERE session_id = ?`;

export function environmentProviderMigration(version: number): SqliteApplicationMigration {
    return Object.freeze({
        version,
        name: "cloudflare-environment-provider",
        statements: Object.freeze([
            `CREATE TABLE agent_core_environment_pins (
                environment_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL CHECK (revision >= 0),
                generation INTEGER NOT NULL CHECK (generation >= 0)
            ) STRICT`,
            `CREATE TABLE agent_core_environment_sessions (
                session_id TEXT PRIMARY KEY,
                environment_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision >= 0),
                generation INTEGER NOT NULL CHECK (generation >= 0),
                session_epoch INTEGER NOT NULL CHECK (session_epoch >= 0),
                restore_ref TEXT,
                state TEXT NOT NULL CHECK (state IN ('open', 'closed'))
            ) STRICT`,
            `CREATE TABLE agent_core_environment_session_files (
                session_id TEXT NOT NULL,
                path TEXT NOT NULL,
                content BLOB NOT NULL,
                PRIMARY KEY (session_id, path)
            ) STRICT`,
            `CREATE TABLE agent_core_environment_snapshots (
                snapshot_id TEXT PRIMARY KEY,
                environment_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision >= 0),
                generation INTEGER NOT NULL CHECK (generation >= 0),
                session_epoch INTEGER NOT NULL CHECK (session_epoch >= 0),
                content_ref TEXT NOT NULL
            ) STRICT`,
            `CREATE TABLE agent_core_environment_exposures (
                exposure_id TEXT PRIMARY KEY,
                environment_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision >= 0),
                generation INTEGER NOT NULL CHECK (generation >= 0),
                session_epoch INTEGER NOT NULL CHECK (session_epoch >= 0),
                port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
                url TEXT,
                state TEXT NOT NULL CHECK (state IN ('exposed', 'revoked'))
            ) STRICT`
        ])
    });
}

export interface DurableObjectEnvironmentProviderOptions {
    readonly previewHost: string;
}

interface SessionRecord {
    readonly environment: string;
    readonly revision: number;
    readonly generation: number;
    readonly sessionEpoch: number;
    readonly restoreRef: string | null;
    readonly state: "open" | "closed";
}

interface SnapshotRecord {
    readonly environment: string;
    readonly session: string;
    readonly revision: number;
    readonly generation: number;
    readonly sessionEpoch: number;
    readonly contentRef: string;
}

interface ExposureRecord {
    readonly environment: string;
    readonly session: string;
    readonly revision: number;
    readonly generation: number;
    readonly sessionEpoch: number;
    readonly port: number;
    readonly url: string | null;
    readonly state: "exposed" | "revoked";
}

/**
 * Environment substrate over a Durable Object's private SQLite and an R2 content
 * repository. Session filesystem state lives in Durable Object storage so it survives
 * instance eviction; snapshots are content-addressed R2 objects; preview URLs derive
 * deterministically from the exact (environment, revision, generation, session,
 * exposure, port) pin. Requests carrying a stale or mismatched generation pin settle
 * as definitive failures, never as retriable errors.
 */
export class DurableObjectEnvironmentProvider extends EnvironmentProvider {
    public constructor(
        public readonly descriptor: ProviderDescriptor,
        private readonly database: SynchronousSqlitePort,
        private readonly content: R2ContentObjectRepository,
        private readonly tenantId: TenantId,
        private readonly options: DurableObjectEnvironmentProviderOptions,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
        if (!(descriptor instanceof ProviderDescriptor)) {
            operationalFailure(
                errors,
                "operation.invalid-input",
                "Environment provider descriptor must be a ProviderDescriptor"
            );
        }
        if (!(tenantId instanceof TenantId)) {
            operationalFailure(
                errors,
                "operation.invalid-input",
                "Environment provider tenant ID must be a TenantId"
            );
        }
        if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(options.previewHost)) {
            operationalFailure(
                errors,
                "operation.invalid-input",
                "Environment provider preview host must be a lowercase DNS name"
            );
        }
    }

    public async openSession(
        request: OpenSessionRequest
    ): Promise<ProviderResourceOutcome<LiveEnvironmentSession>> {
        this.validateSessionRequest(request);
        const existing = this.readSession(request.sessionId.value);
        if (existing !== undefined) return this.replayOpen(existing, request);
        if (this.comparePin(request) === "stale") return ProviderResourceOutcome.failed;

        let restored: ReadonlyMap<string, Uint8Array> | undefined;
        if (request.restore !== undefined) {
            restored = await this.loadSnapshotFiles(request.restore);
            if (restored === undefined) return ProviderResourceOutcome.failed;
        }

        return this.database.transaction(() => {
            const raced = this.readSession(request.sessionId.value);
            if (raced !== undefined) return this.replayOpen(raced, request);
            const pin = this.comparePin(request);
            if (pin === "stale") return ProviderResourceOutcome.failed;
            if (pin === "advance") {
                this.database.run(UPSERT_PIN, [
                    request.environmentId.value,
                    request.environmentRevision.value,
                    request.generation
                ]);
            }
            this.database.run(INSERT_SESSION, [
                request.sessionId.value,
                request.environmentId.value,
                request.environmentRevision.value,
                request.generation,
                0,
                request.restore?.value ?? null,
                "open"
            ]);
            for (const [path, content] of restored ?? []) {
                this.database.run(UPSERT_FILE, [request.sessionId.value, path, content]);
            }
            return ProviderResourceOutcome.ready(sessionHandle());
        });
    }

    public async inspectSession(
        request: OpenSessionRequest
    ): Promise<ProviderResourceOutcome<LiveEnvironmentSession>> {
        this.validateSessionRequest(request);
        const session = this.readSession(request.sessionId.value);
        if (session === undefined) return ProviderResourceOutcome.absent;
        if (!this.sameSessionReservation(session, request)) return ProviderResourceOutcome.failed;
        if (session.state === "closed") return ProviderResourceOutcome.absent;
        return ProviderResourceOutcome.ready(sessionHandle());
    }

    public async closeSession(request: OpenSessionRequest): Promise<ProviderActionOutcome> {
        this.validateSessionRequest(request);
        return this.database.transaction(() => {
            const session = this.readSession(request.sessionId.value);
            if (session === undefined) {
                // A close can legitimately race an open that never reached this substrate;
                // the tombstone keeps the session ID from ever opening afterwards.
                this.database.run(INSERT_SESSION, [
                    request.sessionId.value,
                    request.environmentId.value,
                    request.environmentRevision.value,
                    request.generation,
                    1,
                    request.restore?.value ?? null,
                    "closed"
                ]);
                return ProviderActionOutcome.succeeded;
            }
            if (!this.sameSessionReservation(session, request)) return ProviderActionOutcome.failed;
            if (session.state === "closed") return ProviderActionOutcome.succeeded;
            this.database.run(CLOSE_SESSION, [request.sessionId.value]);
            this.database.run(DELETE_FILES, [request.sessionId.value]);
            this.database.run(REVOKE_SESSION_EXPOSURES, [request.sessionId.value]);
            return ProviderActionOutcome.succeeded;
        });
    }

    public async createSnapshot(
        request: SnapshotEnvironmentRequest
    ): Promise<ProviderResourceOutcome<ContentRef>> {
        this.validateSnapshotRequest(request);
        const existing = this.readSnapshot(request.snapshotId.value);
        if (existing !== undefined) return this.replaySnapshot(existing, request);
        const session = this.readSession(request.sessionId.value);
        if (
            session === undefined ||
            session.state === "closed" ||
            !this.sameSessionPin(session, request)
        ) {
            return ProviderResourceOutcome.failed;
        }
        const bytes = this.serializeSessionFiles(request.sessionId.value);
        const stored = await this.content.put(this.tenantId, bytes);
        const reference = ContentRef.fromDigest(new Digest(stored.digest));
        return this.database.transaction(() => {
            const raced = this.readSnapshot(request.snapshotId.value);
            if (raced !== undefined) return this.replaySnapshot(raced, request);
            const current = this.readSession(request.sessionId.value);
            if (
                current === undefined ||
                current.state === "closed" ||
                !this.sameSessionPin(current, request)
            ) {
                return ProviderResourceOutcome.failed;
            }
            this.database.run(INSERT_SNAPSHOT, [
                request.snapshotId.value,
                request.environmentId.value,
                request.sessionId.value,
                request.environmentRevision.value,
                request.generation,
                request.sessionEpoch,
                reference.value
            ]);
            return ProviderResourceOutcome.ready(reference);
        });
    }

    public async inspectSnapshot(
        request: SnapshotEnvironmentRequest
    ): Promise<ProviderResourceOutcome<ContentRef>> {
        this.validateSnapshotRequest(request);
        const snapshot = this.readSnapshot(request.snapshotId.value);
        if (snapshot === undefined) return ProviderResourceOutcome.absent;
        return this.replaySnapshot(snapshot, request);
    }

    public async exposePort(request: ExposePortRequest): Promise<ProviderResourceOutcome<string>> {
        this.validateExposureRequest(request);
        return this.database.transaction(() => {
            const existing = this.readExposure(request.exposureId.value);
            if (existing !== undefined) {
                if (existing.state === "revoked" || !this.sameExposurePin(existing, request)) {
                    return ProviderResourceOutcome.failed;
                }
                return ProviderResourceOutcome.ready(this.requireExposureUrl(existing));
            }
            const session = this.readSession(request.sessionId.value);
            if (
                session === undefined ||
                session.state === "closed" ||
                !this.sameSessionPin(session, request)
            ) {
                return ProviderResourceOutcome.failed;
            }
            const url = this.previewUrl(request);
            this.database.run(INSERT_EXPOSURE, [
                request.exposureId.value,
                request.environmentId.value,
                request.sessionId.value,
                request.environmentRevision.value,
                request.generation,
                request.sessionEpoch,
                request.port,
                url,
                "exposed"
            ]);
            return ProviderResourceOutcome.ready(url);
        });
    }

    public async inspectExposure(
        request: ExposePortRequest
    ): Promise<ProviderResourceOutcome<string>> {
        this.validateExposureRequest(request);
        const exposure = this.readExposure(request.exposureId.value);
        if (exposure === undefined || exposure.state === "revoked") {
            return ProviderResourceOutcome.absent;
        }
        if (!this.sameExposurePin(exposure, request)) return ProviderResourceOutcome.failed;
        return ProviderResourceOutcome.ready(this.requireExposureUrl(exposure));
    }

    public async revokeExposure(request: ExposePortRequest): Promise<ProviderActionOutcome> {
        this.validateExposureRequest(request);
        return this.database.transaction(() => {
            const exposure = this.readExposure(request.exposureId.value);
            if (exposure === undefined) {
                // Revocation can race an exposure that never reached this substrate; the
                // revoked tombstone keeps the exposure ID from ever materializing afterwards.
                this.database.run(INSERT_EXPOSURE, [
                    request.exposureId.value,
                    request.environmentId.value,
                    request.sessionId.value,
                    request.environmentRevision.value,
                    request.generation,
                    request.sessionEpoch,
                    request.port,
                    null,
                    "revoked"
                ]);
                return ProviderActionOutcome.succeeded;
            }
            if (!this.sameExposurePin(exposure, request)) return ProviderActionOutcome.failed;
            if (exposure.state === "revoked") return ProviderActionOutcome.succeeded;
            this.database.run(REVOKE_EXPOSURE, [request.exposureId.value]);
            return ProviderActionOutcome.succeeded;
        });
    }

    public writeSessionFile(request: OpenSessionRequest, path: string, content: Uint8Array): void {
        this.validateSessionRequest(request);
        this.requireFilePath(path);
        if (!(content instanceof Uint8Array)) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Environment session file content must be a Uint8Array"
            );
        }
        this.requireOpenSession(request);
        this.database.run(UPSERT_FILE, [request.sessionId.value, path, content.slice()]);
    }

    public readSessionFile(request: OpenSessionRequest, path: string): Uint8Array | undefined {
        this.validateSessionRequest(request);
        this.requireFilePath(path);
        this.requireOpenSession(request);
        const rows = this.database.all(READ_FILE, [request.sessionId.value, path]);
        if (rows.length === 0) return undefined;
        const content = rows[0]?.content;
        if (!(content instanceof Uint8Array)) {
            this.corrupt("Environment session file content is corrupt");
        }
        return content.slice();
    }

    private replayOpen(
        session: SessionRecord,
        request: OpenSessionRequest
    ): ProviderResourceOutcome<LiveEnvironmentSession> {
        if (!this.sameSessionReservation(session, request) || session.state === "closed") {
            return ProviderResourceOutcome.failed;
        }
        return ProviderResourceOutcome.ready(sessionHandle());
    }

    private replaySnapshot(
        snapshot: SnapshotRecord,
        request: SnapshotEnvironmentRequest
    ): ProviderResourceOutcome<ContentRef> {
        if (
            snapshot.environment !== request.environmentId.value ||
            snapshot.session !== request.sessionId.value ||
            snapshot.revision !== request.environmentRevision.value ||
            snapshot.generation !== request.generation ||
            snapshot.sessionEpoch !== request.sessionEpoch
        ) {
            return ProviderResourceOutcome.failed;
        }
        return ProviderResourceOutcome.ready(new ContentRef(snapshot.contentRef));
    }

    private comparePin(
        request: OpenSessionRequest | SnapshotEnvironmentRequest | ExposePortRequest
    ): "current" | "advance" | "stale" {
        const rows = this.database.all(READ_PIN, [request.environmentId.value]);
        if (rows.length === 0) return "advance";
        const revision = rows[0]?.revision;
        const generation = rows[0]?.generation;
        if (!isRecordedNumber(revision) || !isRecordedNumber(generation)) {
            this.corrupt("Environment generation pin is corrupt");
        }
        if (request.environmentRevision.value === revision && request.generation === generation) {
            return "current";
        }
        if (request.environmentRevision.value > revision && request.generation > generation) {
            return "advance";
        }
        return "stale";
    }

    private sameSessionPin(
        session: SessionRecord,
        request: OpenSessionRequest | SnapshotEnvironmentRequest | ExposePortRequest
    ): boolean {
        return (
            session.environment === request.environmentId.value &&
            session.revision === request.environmentRevision.value &&
            session.generation === request.generation &&
            (!("sessionEpoch" in request) || session.sessionEpoch === request.sessionEpoch)
        );
    }

    private sameSessionReservation(session: SessionRecord, request: OpenSessionRequest): boolean {
        return (
            this.sameSessionPin(session, request) &&
            session.restoreRef === (request.restore?.value ?? null)
        );
    }

    private sameExposurePin(exposure: ExposureRecord, request: ExposePortRequest): boolean {
        return (
            exposure.environment === request.environmentId.value &&
            exposure.session === request.sessionId.value &&
            exposure.revision === request.environmentRevision.value &&
            exposure.generation === request.generation &&
            exposure.sessionEpoch === request.sessionEpoch &&
            exposure.port === request.port
        );
    }

    private previewUrl(request: ExposePortRequest): string {
        const token = Digest.sha256(
            encodeCanonicalJson({
                environmentId: request.environmentId.value,
                environmentRevision: request.environmentRevision.value,
                exposureId: request.exposureId.value,
                generation: request.generation,
                port: request.port,
                sessionEpoch: request.sessionEpoch,
                sessionId: request.sessionId.value
            })
        ).value;
        // DNS labels max out at 63 characters, so the 64-character token spans two labels.
        return `https://${token.slice(0, 32)}.${token.slice(32)}.${this.options.previewHost}/`;
    }

    private serializeSessionFiles(session: string): Uint8Array {
        const files: Record<string, string> = {};
        for (const row of this.database.all(READ_FILES, [session])) {
            const { path, content } = row;
            if (typeof path !== "string" || !(content instanceof Uint8Array)) {
                this.corrupt("Environment session file row is corrupt");
            }
            files[path] = encodeBase64(content);
        }
        return encodeCanonicalJson({ files, format: SNAPSHOT_FORMAT });
    }

    private async loadSnapshotFiles(
        restore: ContentRef
    ): Promise<ReadonlyMap<string, Uint8Array> | undefined> {
        let decoded: JsonValue;
        try {
            const stored = await this.content.get(this.tenantId, restore.digest.value);
            if (stored === undefined) return undefined;
            decoded = decodeCanonicalJson(stored.bytes);
        } catch (error) {
            if (error instanceof AgentCoreError && error.code === "codec.invalid") return undefined;
            throw error;
        }
        if (
            !isJsonRecord(decoded) ||
            decoded.format !== SNAPSHOT_FORMAT ||
            Reflect.ownKeys(decoded).length !== 2
        ) {
            return undefined;
        }
        const encodedFiles = decoded.files;
        if (!isJsonRecord(encodedFiles)) return undefined;
        const files = new Map<string, Uint8Array>();
        try {
            for (const [path, encoded] of Object.entries(encodedFiles)) {
                if (typeof encoded !== "string") return undefined;
                files.set(path, decodeBase64(encoded));
            }
        } catch (error) {
            if (error instanceof AgentCoreError && error.code === "codec.invalid") return undefined;
            throw error;
        }
        return files;
    }

    private readSession(session: string): SessionRecord | undefined {
        const rows = this.database.all(READ_SESSION, [session]);
        if (rows.length === 0) return undefined;
        const row = rows[0];
        const environmentId = row?.environment_id;
        const revision = row?.revision;
        const generation = row?.generation;
        const sessionEpoch = row?.session_epoch;
        const restoreRef = row?.restore_ref;
        const state = row?.state;
        if (
            typeof environmentId !== "string" ||
            !isRecordedNumber(revision) ||
            !isRecordedNumber(generation) ||
            !isRecordedNumber(sessionEpoch) ||
            (restoreRef !== null && typeof restoreRef !== "string") ||
            (state !== "open" && state !== "closed")
        ) {
            this.corrupt("Environment session record is corrupt");
        }
        return {
            environment: environmentId,
            revision,
            generation,
            sessionEpoch,
            restoreRef: restoreRef ?? null,
            state
        };
    }

    private readSnapshot(snapshot: string): SnapshotRecord | undefined {
        const rows = this.database.all(READ_SNAPSHOT, [snapshot]);
        if (rows.length === 0) return undefined;
        const row = rows[0];
        const environmentId = row?.environment_id;
        const sessionId = row?.session_id;
        const revision = row?.revision;
        const generation = row?.generation;
        const sessionEpoch = row?.session_epoch;
        const contentRef = row?.content_ref;
        if (
            typeof environmentId !== "string" ||
            typeof sessionId !== "string" ||
            !isRecordedNumber(revision) ||
            !isRecordedNumber(generation) ||
            !isRecordedNumber(sessionEpoch) ||
            typeof contentRef !== "string"
        ) {
            this.corrupt("Environment snapshot record is corrupt");
        }
        return {
            environment: environmentId,
            session: sessionId,
            revision,
            generation,
            sessionEpoch,
            contentRef
        };
    }

    private readExposure(exposure: string): ExposureRecord | undefined {
        const rows = this.database.all(READ_EXPOSURE, [exposure]);
        if (rows.length === 0) return undefined;
        const row = rows[0];
        const environmentId = row?.environment_id;
        const sessionId = row?.session_id;
        const revision = row?.revision;
        const generation = row?.generation;
        const sessionEpoch = row?.session_epoch;
        const port = row?.port;
        const url = row?.url;
        const state = row?.state;
        if (
            typeof environmentId !== "string" ||
            typeof sessionId !== "string" ||
            !isRecordedNumber(revision) ||
            !isRecordedNumber(generation) ||
            !isRecordedNumber(sessionEpoch) ||
            !isRecordedNumber(port) ||
            (url !== null && typeof url !== "string") ||
            (state !== "exposed" && state !== "revoked")
        ) {
            this.corrupt("Port exposure record is corrupt");
        }
        return {
            environment: environmentId,
            session: sessionId,
            revision,
            generation,
            sessionEpoch,
            port,
            url: url ?? null,
            state
        };
    }

    private requireExposureUrl(exposure: ExposureRecord): string {
        if (exposure.url === null) this.corrupt("Exposed port record is missing its preview URL");
        return exposure.url;
    }

    private requireOpenSession(request: OpenSessionRequest): void {
        const session = this.readSession(request.sessionId.value);
        if (
            session === undefined ||
            session.state === "closed" ||
            !this.sameSessionReservation(session, request)
        ) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                "Environment session files require an open session with an exact generation pin"
            );
        }
    }

    private validateSessionRequest(request: OpenSessionRequest): void {
        this.validatePin(request);
        this.requireIdentifier(request.sessionId, EnvironmentSessionId, "Environment session ID");
        if (request.restore !== undefined && !(request.restore instanceof ContentRef)) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Environment session restore must be a ContentRef"
            );
        }
    }

    private validateSnapshotRequest(request: SnapshotEnvironmentRequest): void {
        this.validatePin(request);
        this.requireIdentifier(request.sessionId, EnvironmentSessionId, "Environment session ID");
        this.requireIdentifier(
            request.snapshotId,
            EnvironmentSnapshotId,
            "Environment snapshot ID"
        );
        this.validateSessionEpoch(request.sessionEpoch);
    }

    private validateExposureRequest(request: ExposePortRequest): void {
        this.validatePin(request);
        this.requireIdentifier(request.sessionId, EnvironmentSessionId, "Environment session ID");
        this.requireIdentifier(request.exposureId, PortExposureId, "Port exposure ID");
        this.validateSessionEpoch(request.sessionEpoch);
        if (!Number.isSafeInteger(request.port) || request.port < 1 || request.port > 65_535) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Port exposure port must be between 1 and 65535"
            );
        }
    }

    private validatePin(
        request: OpenSessionRequest | SnapshotEnvironmentRequest | ExposePortRequest
    ): void {
        this.requireIdentifier(request.environmentId, EnvironmentId, "Environment ID");
        if (!(request.environmentRevision instanceof Revision)) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Environment revision must be a Revision"
            );
        }
        if (!isRecordedNumber(request.generation)) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Environment generation must be a non-negative safe integer"
            );
        }
    }

    private requireIdentifier<Identifier>(
        value: unknown,
        constructor: new (value: string) => Identifier,
        name: string
    ): asserts value is Identifier {
        if (!(value instanceof constructor)) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                `${name} must use its canonical branded class`
            );
        }
    }

    private validateSessionEpoch(sessionEpoch: number): void {
        if (!isRecordedNumber(sessionEpoch)) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Environment session epoch must be a non-negative safe integer"
            );
        }
    }

    private requireFilePath(path: string): void {
        if (typeof path !== "string" || path.length === 0 || path.length > MAX_FILE_PATH_LENGTH) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                `Environment session file path must contain between 1 and ${MAX_FILE_PATH_LENGTH} characters`
            );
        }
    }

    private corrupt(message: string): never {
        return operationalFailure(this.errors, "codec.invalid", message);
    }
}

function sessionHandle(): LiveEnvironmentSession {
    return Object.freeze({ children: Object.freeze([]), release(): void {} });
}

function isJsonRecord(
    value: JsonValue | undefined
): value is { readonly [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordedNumber(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

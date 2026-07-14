import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import { Environment, EnvironmentRevisionRecord } from "./environment";
import { PortExposure } from "./exposure";
import { EnvironmentId, EnvironmentSessionId, EnvironmentSnapshotId, PortExposureId } from "./id";
import { EnvironmentSession } from "./session";
import { EnvironmentSnapshot } from "./snapshot";

export type EnvironmentStoredRecordKind = "head" | "revision" | "session" | "snapshot" | "exposure";

export interface EnvironmentStoredRow {
    readonly kind: EnvironmentStoredRecordKind;
    readonly key: string;
    readonly recordRevision: number;
    readonly projection: readonly string[];
    readonly bytes: Uint8Array;
}

export interface EnvironmentStoreImage {
    readonly rows: readonly EnvironmentStoredRow[];
}

export abstract class EnvironmentStore {
    public abstract getEnvironment(id: EnvironmentId): Environment | undefined;
    public abstract getRevision(
        environmentId: EnvironmentId,
        revision: Revision
    ): EnvironmentRevisionRecord | undefined;
    public abstract compareAndSetEnvironment(
        expected: Revision | undefined,
        revision: EnvironmentRevisionRecord,
        environment: Environment
    ): boolean;

    public abstract getSession(id: EnvironmentSessionId): EnvironmentSession | undefined;
    public abstract compareAndSetSession(
        expected: Revision | undefined,
        session: EnvironmentSession
    ): boolean;

    public abstract getSnapshot(id: EnvironmentSnapshotId): EnvironmentSnapshot | undefined;
    public abstract compareAndSetSnapshot(
        expected: Revision | undefined,
        snapshot: EnvironmentSnapshot
    ): boolean;

    public abstract getExposure(id: PortExposureId): PortExposure | undefined;
    public abstract listExposures(sessionId: EnvironmentSessionId): readonly PortExposure[];
    public abstract compareAndSetExposure(
        expected: Revision | undefined,
        exposure: PortExposure
    ): boolean;
}

export class MemoryEnvironmentStore extends EnvironmentStore {
    readonly #rows = new Map<string, EnvironmentStoredRow>();

    public constructor(image?: EnvironmentStoreImage) {
        super();
        for (const row of image?.rows ?? []) {
            const storageKey = rowKey(row.kind, row.key);
            if (this.#rows.has(storageKey)) {
                throw corruptStore("Environment store image contains a duplicate key");
            }
            this.#rows.set(storageKey, copyRow(row));
        }
        if (image !== undefined) this.validateImage();
    }

    public exportImage(): EnvironmentStoreImage {
        return Object.freeze({
            rows: Object.freeze(
                [...this.#rows.values()]
                    .sort((left, right) =>
                        rowKey(left.kind, left.key).localeCompare(rowKey(right.kind, right.key))
                    )
                    .map(copyRow)
            )
        });
    }

    public getEnvironment(id: EnvironmentId): Environment | undefined {
        const row = this.#rows.get(rowKey("head", id.value));
        if (row === undefined) return undefined;
        const environment = decodeRow(row, Environment.decode, projectEnvironment);
        if (!environment.id.equals(id))
            throw corruptStore("Environment head key does not match codec bytes");
        this.requirePinnedRevision(
            environment.id,
            environment.activeRevision,
            environment.generation,
            "Environment head"
        );
        return environment;
    }

    public getRevision(
        environmentId: EnvironmentId,
        revision: Revision
    ): EnvironmentRevisionRecord | undefined {
        const key = revisionKey(environmentId, revision);
        const row = this.#rows.get(rowKey("revision", key));
        if (row === undefined) return undefined;
        const record = decodeRow(row, EnvironmentRevisionRecord.decode, projectRevision);
        if (!record.environmentId.equals(environmentId) || !record.revision.equals(revision)) {
            throw corruptStore("Environment revision key does not match codec bytes");
        }
        return record;
    }

    public compareAndSetEnvironment(
        expected: Revision | undefined,
        revision: EnvironmentRevisionRecord,
        environment: Environment
    ): boolean {
        const revisionBytes = EnvironmentRevisionRecord.encode(revision);
        const canonicalRevision = EnvironmentRevisionRecord.decode(revisionBytes);
        const environmentBytes = Environment.encode(environment);
        const canonicalEnvironment = Environment.decode(environmentBytes);
        if (
            !canonicalRevision.environmentId.equals(canonicalEnvironment.id) ||
            !canonicalRevision.revision.equals(canonicalEnvironment.activeRevision) ||
            canonicalRevision.generation !== canonicalEnvironment.generation
        ) {
            throw corruptStore("Environment head must advance with its exact revision generation");
        }

        const headKey = rowKey("head", canonicalEnvironment.id.value);
        const immutableRevisionKey = revisionKey(
            canonicalRevision.environmentId,
            canonicalRevision.revision
        );
        const storedRevisionKey = rowKey("revision", immutableRevisionKey);
        const currentHeadRow = this.#rows.get(headKey);
        const currentRevisionRow = this.#rows.get(storedRevisionKey);
        if (currentHeadRow !== undefined) {
            decodeRow(currentHeadRow, Environment.decode, projectEnvironment);
        }
        if (currentRevisionRow !== undefined) {
            decodeRow(currentRevisionRow, EnvironmentRevisionRecord.decode, projectRevision);
        }
        if (
            currentHeadRow !== undefined &&
            currentRevisionRow !== undefined &&
            equalBytes(currentHeadRow.bytes, environmentBytes) &&
            equalBytes(currentRevisionRow.bytes, revisionBytes)
        ) {
            return true;
        }
        if (currentHeadRow?.recordRevision !== expected?.value) return false;

        const requiredRecordRevision = expected === undefined ? 0 : expected.value + 1;
        if (
            !Number.isSafeInteger(requiredRecordRevision) ||
            canonicalEnvironment.recordRevision.value !== requiredRecordRevision
        ) {
            throw corruptStore("Environment head CAS must advance exactly one record revision");
        }
        this.validateRevisionSequence(canonicalRevision, false);
        if (
            currentRevisionRow !== undefined &&
            !equalBytes(currentRevisionRow.bytes, revisionBytes)
        ) {
            throw corruptStore(`Environment revision ${immutableRevisionKey} is immutable`);
        }

        const nextRevisionRow = revisionRow(canonicalRevision, revisionBytes);
        const nextHeadRow = storedRow(
            "head",
            canonicalEnvironment.id.value,
            canonicalEnvironment.recordRevision,
            projectEnvironment(canonicalEnvironment),
            environmentBytes
        );
        decodeRow(nextRevisionRow, EnvironmentRevisionRecord.decode, projectRevision);
        decodeRow(nextHeadRow, Environment.decode, projectEnvironment);

        const previousRevisionRow = currentRevisionRow;
        const previousHeadRow = currentHeadRow;
        this.#rows.set(storedRevisionKey, nextRevisionRow);
        try {
            this.beforeEnvironmentHeadCommit();
            this.#rows.set(headKey, nextHeadRow);
            const persisted = this.getEnvironment(canonicalEnvironment.id);
            if (
                persisted === undefined ||
                !equalBytes(Environment.encode(persisted), environmentBytes)
            ) {
                throw corruptStore("Environment atomic CAS did not persist codec bytes");
            }
        } catch (error) {
            restoreRow(this.#rows, storedRevisionKey, previousRevisionRow);
            restoreRow(this.#rows, headKey, previousHeadRow);
            if (error instanceof AgentCoreError) throw error;
            throw corruptStore("Environment atomic head CAS failed");
        }
        return true;
    }

    protected beforeEnvironmentHeadCommit(): void {}

    public getSession(id: EnvironmentSessionId): EnvironmentSession | undefined {
        const row = this.#rows.get(rowKey("session", id.value));
        if (row === undefined) return undefined;
        const session = decodeRow(row, EnvironmentSession.decode, projectSession);
        if (!session.id.equals(id))
            throw corruptStore("Environment session key does not match codec bytes");
        this.validateSessionPin(session);
        return session;
    }

    public compareAndSetSession(
        expected: Revision | undefined,
        session: EnvironmentSession
    ): boolean {
        this.validateSessionPin(session);
        return this.compareAndSet(
            "session",
            session.id.value,
            expected,
            session,
            EnvironmentSession.encode,
            EnvironmentSession.decode,
            projectSession
        );
    }

    public getSnapshot(id: EnvironmentSnapshotId): EnvironmentSnapshot | undefined {
        const row = this.#rows.get(rowKey("snapshot", id.value));
        if (row === undefined) return undefined;
        const snapshot = decodeRow(row, EnvironmentSnapshot.decode, projectSnapshot);
        if (!snapshot.id.equals(id))
            throw corruptStore("Environment snapshot key does not match codec bytes");
        this.validateSnapshotPin(snapshot);
        return snapshot;
    }

    public compareAndSetSnapshot(
        expected: Revision | undefined,
        snapshot: EnvironmentSnapshot
    ): boolean {
        this.validateSnapshotPin(snapshot);
        return this.compareAndSet(
            "snapshot",
            snapshot.id.value,
            expected,
            snapshot,
            EnvironmentSnapshot.encode,
            EnvironmentSnapshot.decode,
            projectSnapshot
        );
    }

    public getExposure(id: PortExposureId): PortExposure | undefined {
        const row = this.#rows.get(rowKey("exposure", id.value));
        if (row === undefined) return undefined;
        const exposure = decodeRow(row, PortExposure.decode, projectExposure);
        if (!exposure.id.equals(id))
            throw corruptStore("Port exposure key does not match codec bytes");
        this.validateExposurePin(exposure);
        return exposure;
    }

    public listExposures(sessionId: EnvironmentSessionId): readonly PortExposure[] {
        return Object.freeze(
            [...this.#rows.values()]
                .filter((row) => row.kind === "exposure")
                .map((row) => decodeRow(row, PortExposure.decode, projectExposure))
                .filter((exposure) => exposure.sessionId.equals(sessionId))
                .map((exposure) => {
                    this.validateExposurePin(exposure);
                    return exposure;
                })
                .sort((left, right) => left.id.value.localeCompare(right.id.value))
        );
    }

    public compareAndSetExposure(expected: Revision | undefined, exposure: PortExposure): boolean {
        this.validateExposurePin(exposure);
        return this.compareAndSet(
            "exposure",
            exposure.id.value,
            expected,
            exposure,
            PortExposure.encode,
            PortExposure.decode,
            projectExposure
        );
    }

    private compareAndSet<Record>(
        kind: Exclude<EnvironmentStoredRecordKind, "head" | "revision">,
        key: string,
        expected: Revision | undefined,
        record: Record,
        encode: (record: Record) => Uint8Array,
        decode: (bytes: Uint8Array) => Record,
        project: (record: Record) => readonly string[]
    ): boolean {
        const bytes = encode(record);
        const canonical = decode(bytes);
        const projection = project(canonical);
        const recordRevision = projectionRevision(projection);
        const storageKey = rowKey(kind, key);
        const current = this.#rows.get(storageKey);
        if (current !== undefined) {
            decodeRow(current, decode, project);
            if (equalBytes(current.bytes, bytes)) return true;
        }
        const expectedValue = expected?.value;
        if (current?.recordRevision !== expectedValue) return false;
        const requiredRevision = expected === undefined ? 0 : expected.value + 1;
        if (!Number.isSafeInteger(requiredRevision) || recordRevision !== requiredRevision) {
            throw corruptStore("Environment store CAS must advance exactly one record revision");
        }
        const row = Object.freeze({
            kind,
            key,
            recordRevision,
            projection: Object.freeze([...projection]),
            bytes: copyBytes(bytes)
        });
        this.#rows.set(storageKey, row);
        decodeRow(row, decode, project);
        return true;
    }

    private validateSessionPin(session: EnvironmentSession): void {
        this.requirePinnedRevision(
            session.environmentId,
            session.environmentRevision,
            session.generation,
            "Environment session"
        );
        if (session.restoreFrom === undefined) return;
        const snapshot = this.getSnapshot(session.restoreFrom);
        if (
            snapshot === undefined ||
            snapshot.state.name !== "ready" ||
            !snapshot.environmentId.equals(session.environmentId) ||
            !snapshot.environmentRevision.equals(session.environmentRevision) ||
            snapshot.generation !== session.generation
        ) {
            throw new AgentCoreError(
                "environment.invalid-session",
                "Environment session restore must use a ready snapshot from its exact generation"
            );
        }
    }

    private validateSnapshotPin(snapshot: EnvironmentSnapshot): void {
        this.requirePinnedRevision(
            snapshot.environmentId,
            snapshot.environmentRevision,
            snapshot.generation,
            "Environment snapshot"
        );
        const session = this.getSession(snapshot.sessionId);
        if (
            session === undefined ||
            !session.environmentId.equals(snapshot.environmentId) ||
            !session.environmentRevision.equals(snapshot.environmentRevision) ||
            session.generation !== snapshot.generation
        ) {
            throw new AgentCoreError(
                "environment.invalid-session",
                "Environment snapshot must pin its source session generation"
            );
        }
    }

    private validateExposurePin(exposure: PortExposure): void {
        this.requirePinnedRevision(
            exposure.environmentId,
            exposure.environmentRevision,
            exposure.generation,
            "Port exposure"
        );
        const session = this.getSession(exposure.sessionId);
        if (
            session === undefined ||
            !session.environmentId.equals(exposure.environmentId) ||
            !session.environmentRevision.equals(exposure.environmentRevision) ||
            session.generation !== exposure.generation ||
            exposure.sessionEpoch > session.epoch
        ) {
            throw new AgentCoreError(
                "environment.stale-session",
                "Port exposure must pin its source session generation and epoch"
            );
        }
    }

    private requirePinnedRevision(
        environmentId: EnvironmentId,
        revision: Revision,
        generation: number,
        name: string
    ): EnvironmentRevisionRecord {
        const record = this.getRevision(environmentId, revision);
        if (record === undefined || record.generation !== generation) {
            throw new AgentCoreError(
                "environment.stale-session",
                `${name} must pin a stored Environment generation`
            );
        }
        return record;
    }

    private validateImage(): void {
        for (const row of this.#rows.values()) {
            switch (row.kind) {
                case "head":
                    this.getEnvironment(new EnvironmentId(row.key));
                    break;
                case "revision": {
                    const revision = decodeRow(
                        row,
                        EnvironmentRevisionRecord.decode,
                        projectRevision
                    );
                    if (row.key !== revisionKey(revision.environmentId, revision.revision)) {
                        throw corruptStore("Environment revision key does not match codec bytes");
                    }
                    this.validateRevisionSequence(revision, true);
                    break;
                }
                case "session":
                    this.getSession(new EnvironmentSessionId(row.key));
                    break;
                case "snapshot":
                    this.getSnapshot(new EnvironmentSnapshotId(row.key));
                    break;
                case "exposure":
                    this.getExposure(new PortExposureId(row.key));
                    break;
            }
        }
        for (const row of this.#rows.values()) {
            if (row.kind !== "revision") continue;
            const revision = decodeRow(row, EnvironmentRevisionRecord.decode, projectRevision);
            const environment = this.getEnvironment(revision.environmentId);
            if (
                environment === undefined ||
                revision.revision.value > environment.activeRevision.value
            ) {
                throw corruptStore("Environment store contains an orphan revision");
            }
        }
    }

    private validateRevisionSequence(record: EnvironmentRevisionRecord, stored: boolean): void {
        const invalid =
            record.revision.value === 0
                ? record.generation !== 0
                : (() => {
                      const previous = this.getRevision(
                          record.environmentId,
                          new Revision(record.revision.value - 1)
                      );
                      return (
                          previous === undefined ||
                          previous.generation === Number.MAX_SAFE_INTEGER ||
                          record.generation !== previous.generation + 1
                      );
                  })();
        if (!invalid) return;
        const message = "Environment revisions must form a contiguous generation sequence";
        if (stored) throw corruptStore(message);
        throw corruptStore(message);
    }
}

function revisionRow(record: EnvironmentRevisionRecord, bytes: Uint8Array): EnvironmentStoredRow {
    return storedRow(
        "revision",
        revisionKey(record.environmentId, record.revision),
        record.revision,
        projectRevision(record),
        bytes
    );
}

function storedRow(
    kind: EnvironmentStoredRecordKind,
    key: string,
    revision: Revision,
    projection: readonly string[],
    bytes: Uint8Array
): EnvironmentStoredRow {
    return Object.freeze({
        kind,
        key,
        recordRevision: revision.value,
        projection: Object.freeze([...projection]),
        bytes: copyBytes(bytes)
    });
}

function projectEnvironment(record: Environment): readonly string[] {
    return [
        record.id.value,
        String(record.activeRevision.value),
        String(record.generation),
        String(record.recordRevision.value)
    ];
}

function projectRevision(record: EnvironmentRevisionRecord): readonly string[] {
    return [
        record.environmentId.value,
        String(record.revision.value),
        String(record.generation),
        record.provider.id.value,
        record.provider.version,
        record.provider.configuration.value,
        String(record.revision.value)
    ];
}

function projectSession(record: EnvironmentSession): readonly string[] {
    return [
        record.id.value,
        record.environmentId.value,
        String(record.environmentRevision.value),
        String(record.generation),
        String(record.epoch),
        record.state.name,
        record.restoreFrom?.value ?? "",
        String(record.recordRevision.value)
    ];
}

function projectSnapshot(record: EnvironmentSnapshot): readonly string[] {
    return [
        record.id.value,
        record.environmentId.value,
        record.sessionId.value,
        String(record.environmentRevision.value),
        String(record.generation),
        record.state.name,
        record.content?.value ?? "",
        String(record.recordRevision.value)
    ];
}

function projectExposure(record: PortExposure): readonly string[] {
    return [
        record.id.value,
        record.environmentId.value,
        record.sessionId.value,
        String(record.environmentRevision.value),
        String(record.generation),
        String(record.sessionEpoch),
        String(record.port),
        record.state.name,
        record.url ?? "",
        String(record.recordRevision.value)
    ];
}

function decodeRow<Record>(
    row: EnvironmentStoredRow,
    decode: (bytes: Uint8Array) => Record,
    project: (record: Record) => readonly string[]
): Record {
    const record = decode(copyBytes(row.bytes));
    const expectedProjection = project(record);
    if (
        projectionRevision(expectedProjection) !== row.recordRevision ||
        !equalProjection(row.projection, expectedProjection)
    ) {
        throw corruptStore("Environment store projection does not match codec bytes");
    }
    return record;
}

function projectionRevision(projection: readonly string[]): number {
    const value = Number(projection.at(-1));
    if (!Number.isSafeInteger(value) || value < 0) {
        throw corruptStore("Environment store record revision projection is malformed");
    }
    return value;
}

function equalProjection(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function revisionKey(environmentId: EnvironmentId, revision: Revision): string {
    return `${environmentId.value}\u0000${revision.value}`;
}

function rowKey(kind: EnvironmentStoredRecordKind, key: string): string {
    return `${kind}\u0000${key}`;
}

function copyRow(row: EnvironmentStoredRow): EnvironmentStoredRow {
    return Object.freeze({
        kind: row.kind,
        key: row.key,
        recordRevision: row.recordRevision,
        projection: Object.freeze([...row.projection]),
        bytes: copyBytes(row.bytes)
    });
}

function copyBytes(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function restoreRow(
    rows: Map<string, EnvironmentStoredRow>,
    key: string,
    row: EnvironmentStoredRow | undefined
): void {
    if (row === undefined) rows.delete(key);
    else rows.set(key, row);
}

function corruptStore(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

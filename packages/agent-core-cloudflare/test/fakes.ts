import {
    AgentCoreError,
    type JsonValue,
    compareCanonicalText,
    isJsonValue,
    jsonDataParser
} from "@agent-core/core";
import type {
    AlarmStorageLike,
    AuthoritativeDurableObjectHost,
    AuthoritativeWorkerRouter,
    CloudflareDurableObjectStorage,
    CloudflareErrorPort,
    CloudflareExecutionContextLike,
    CloudflareSqlBinding,
    CloudflareSqlCursor,
    CloudflareSqlStorage,
    CloudflareSqlValue,
    DispatchNamespaceLike,
    DueReconciliation,
    DurableObjectNamespaceLike,
    DynamicWorkerHandleLike,
    DynamicWorkerLoadOptions,
    FetchServiceLike,
    HibernatingWebSocketContextLike,
    HibernatingWebSocketLike,
    QueueMessageLike,
    R2BucketLike,
    R2GetOptionsLike,
    R2ObjectBodyLike,
    R2ObjectLike,
    R2PutOptionsLike,
    R2RangeLike,
    ReconciliationOutbox,
    SqliteRow,
    SqliteValue,
    SynchronousResultGuard,
    SynchronousSqlitePort,
    WorkerLoaderBindingLike
} from "../src/index.js";
import { DynamicWorkerLimits, ReconciliationOutboxId } from "../src/index.js";
import {
    isFiniteNumber,
    isPlatformMethod,
    isPlatformObject,
    isText
} from "../src/platform-value.js";

/** Structural test doubles only; these are not Cloudflare runtime emulators. */

const json = jsonDataParser((message) => new TypeError(message));

export const fakeErrors: CloudflareErrorPort = Object.freeze({
    raise(code, message, cause): never {
        const error = new AgentCoreError(code, message);
        if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause.value });
        throw error;
    }
} satisfies CloudflareErrorPort);

/**
 * The per-load bound every fixture loads under. §10.2 admits no unbounded load, so a
 * fixture that wanted one would have to state it here and could not.
 */
export const fakeWorkerLimits = new DynamicWorkerLimits(50, 8);

export interface FakeSqlExecution<Row extends Record<string, CloudflareSqlValue>> {
    readonly rows?: readonly Row[];
    readonly onConsumed?: () => void;
}

export interface FakeSqlCall {
    readonly statement: string;
    readonly bindings: readonly CloudflareSqlBinding[];
}

export class FakeSqlStorage implements CloudflareSqlStorage {
    public readonly calls: FakeSqlCall[] = [];

    public constructor(
        private readonly execute: (
            statement: string,
            bindings: readonly CloudflareSqlBinding[]
        ) => FakeSqlExecution<Record<string, CloudflareSqlValue>>
    ) {}

    public exec(
        statement: string,
        ...bindings: readonly CloudflareSqlBinding[]
    ): CloudflareSqlCursor<Record<string, CloudflareSqlValue>> {
        this.calls.push({ statement, bindings: bindings.map(cloneBinding) });
        const execution = this.execute(statement, bindings);
        return new FakeSqlCursor(execution.rows ?? [], execution.onConsumed);
    }
}

/**
 * How a test rolls its own state back when a fake transaction throws, the way the
 * Durable Object runtime rolls storage back. The snapshot belongs to the test that
 * captures it, so the double is generic over it rather than opaque about it.
 */
export interface FakeTransactionRollback<Snapshot> {
    capture(): Snapshot;
    restore(snapshot: Snapshot): void;
}

export class FakeDurableObjectStorage<Snapshot = never> implements CloudflareDurableObjectStorage {
    #active = false;
    #scheduledAt: number | null = null;

    public constructor(
        public readonly sql: CloudflareSqlStorage,
        private readonly rollback?: FakeTransactionRollback<Snapshot>
    ) {}

    public transactionSync<Result>(operation: () => Result): Result {
        if (this.#active) throw new TypeError("Fake Durable Object transaction is nested");
        const rollBack = this.capture();
        this.#active = true;
        try {
            const result = operation();
            if (isThenable(result)) {
                throw new TypeError("Fake Durable Object transactions must be synchronous");
            }
            return result;
        } catch (error) {
            rollBack();
            throw error;
        } finally {
            this.#active = false;
        }
    }

    private capture(): () => void {
        const rollback = this.rollback;
        if (rollback === undefined) return () => undefined;
        const snapshot = rollback.capture();
        return () => {
            rollback.restore(snapshot);
        };
    }

    public async getAlarm(): Promise<number | null> {
        return this.#scheduledAt;
    }

    public async setAlarm(scheduledTime: number): Promise<void> {
        this.#scheduledAt = scheduledTime;
    }

    public async deleteAlarm(): Promise<void> {
        this.#scheduledAt = null;
    }
}

export class FakeRuntimeSqlite implements SynchronousSqlitePort {
    readonly #migrations = new Map<number, string>();
    readonly #snapshots = new Map<string, Map<number, Uint8Array>>();
    readonly #deltas = new Map<string, Map<number, Uint8Array>>();
    readonly #outbox = new Map<string, number>();
    public readonly calls: Array<{
        readonly statement: string;
        readonly bindings: readonly SqliteValue[];
    }> = [];

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        this.record(statement, bindings);
        if (statement.includes("FROM agent_core_migrations")) {
            return [...this.#migrations]
                .sort(([left], [right]) => left - right)
                .map(([version, name]) => ({ version, name }));
        }
        if (statement.startsWith("SELECT MAX(revision)")) {
            const channel = boundText(bindings, 0);
            const revisions = [
                ...this.values(this.#snapshots, channel).keys(),
                ...this.values(this.#deltas, channel).keys()
            ];
            return [{ revision: revisions.length === 0 ? null : Math.max(...revisions) }];
        }
        if (statement.startsWith("SELECT revision, payload FROM agent_core_view_snapshots")) {
            const channel = boundText(bindings, 0);
            const after = boundInteger(bindings, 1);
            const latest = [...this.values(this.#snapshots, channel)]
                .filter(([revision]) => revision > after)
                .sort(([left], [right]) => right - left)[0];
            return latest === undefined
                ? []
                : [{ revision: latest[0], payload: latest[1].slice() }];
        }
        if (statement.startsWith("SELECT revision, payload FROM agent_core_view_deltas")) {
            const channel = boundText(bindings, 0);
            const after = boundInteger(bindings, 1);
            return [...this.values(this.#deltas, channel)]
                .filter(([revision]) => revision > after)
                .sort(([left], [right]) => left - right)
                .map(([revision, payload]) => ({ revision, payload: payload.slice() }));
        }
        if (statement.includes("SELECT id, scheduled_at FROM agent_core_reconciliation_outbox")) {
            const now = boundInteger(bindings, 0);
            const limit = boundInteger(bindings, 1);
            return [...this.#outbox]
                .filter(([, scheduledAt]) => scheduledAt <= now)
                .sort(
                    ([leftId, leftTime], [rightId, rightTime]) =>
                        leftTime - rightTime || compareCanonicalText(leftId, rightId)
                )
                .slice(0, limit)
                .map(([id, scheduledAt]) => ({ id, scheduled_at: scheduledAt }));
        }
        if (statement.startsWith("SELECT MIN(scheduled_at)")) {
            return [
                {
                    scheduled_at:
                        this.#outbox.size === 0 ? null : Math.min(...this.#outbox.values())
                }
            ];
        }
        return [];
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.record(statement, bindings);
        if (statement.startsWith("INSERT INTO agent_core_migrations")) {
            this.#migrations.set(boundInteger(bindings, 0), boundText(bindings, 1));
        } else if (statement.startsWith("INSERT INTO agent_core_view_deltas")) {
            this.values(this.#deltas, boundText(bindings, 0)).set(
                boundInteger(bindings, 1),
                boundBytes(bindings, 2).slice()
            );
        } else if (statement.startsWith("INSERT INTO agent_core_view_snapshots")) {
            this.values(this.#snapshots, boundText(bindings, 0)).set(
                boundInteger(bindings, 1),
                boundBytes(bindings, 2).slice()
            );
        } else if (statement.startsWith("DELETE FROM agent_core_view_deltas")) {
            deleteThrough(
                this.values(this.#deltas, boundText(bindings, 0)),
                boundInteger(bindings, 1)
            );
        } else if (statement.startsWith("DELETE FROM agent_core_view_snapshots")) {
            deleteBefore(
                this.values(this.#snapshots, boundText(bindings, 0)),
                boundInteger(bindings, 1)
            );
        } else if (statement.startsWith("INSERT INTO agent_core_reconciliation_outbox")) {
            this.#outbox.set(boundText(bindings, 0), boundInteger(bindings, 1));
        } else if (statement.startsWith("DELETE FROM agent_core_reconciliation_outbox")) {
            // The durable statement fences on the observed schedule; so does the fake.
            const id = boundText(bindings, 0);
            if (this.#outbox.get(id) === boundInteger(bindings, 1)) this.#outbox.delete(id);
        } else if (statement.startsWith("UPDATE agent_core_reconciliation_outbox")) {
            const id = boundText(bindings, 1);
            if (this.#outbox.get(id) === boundInteger(bindings, 2)) {
                this.#outbox.set(id, boundInteger(bindings, 0));
            }
        }
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return operation();
    }

    public migrationMarkers(): ReadonlyMap<number, string> {
        return this.#migrations;
    }

    private values(
        source: Map<string, Map<number, Uint8Array>>,
        channel: string
    ): Map<number, Uint8Array> {
        let values = source.get(channel);
        if (values === undefined) {
            values = new Map();
            source.set(channel, values);
        }
        return values;
    }

    private record(statement: string, bindings: readonly SqliteValue[]): void {
        this.calls.push({ statement, bindings: bindings.map(cloneSqliteValue) });
    }
}

class FakeSqlCursor<
    Row extends Record<string, CloudflareSqlValue>
> implements CloudflareSqlCursor<Row> {
    public constructor(
        private readonly rows: readonly Row[],
        private readonly onConsumed: (() => void) | undefined
    ) {}

    public [Symbol.iterator](): Iterator<Row> {
        let index = 0;
        let completed = false;
        return {
            next: (): IteratorResult<Row> => {
                const row = this.rows[index];
                if (row !== undefined) {
                    index += 1;
                    return { done: false, value: row };
                }
                if (!completed) {
                    completed = true;
                    this.onConsumed?.();
                }
                return { done: true, value: undefined };
            }
        };
    }
}

interface FakeR2StoredObject {
    bytes: Uint8Array;
    metadata: Record<string, string>;
    checksum: ArrayBuffer;
    etag: string;
    declaredSize: number | undefined;
}

export class FakeR2Bucket implements R2BucketLike {
    readonly #objects = new Map<string, FakeR2StoredObject>();
    #etag = 0;
    public readonly putCalls: Array<{
        readonly key: string;
        readonly options: R2PutOptionsLike;
    }> = [];
    /** Every read and the window it asked for, so a pushed-down range is observable. */
    public readonly getCalls: Array<{
        readonly key: string;
        readonly range: R2RangeLike | undefined;
    }> = [];
    public readonly headCalls: string[] = [];
    /** Every body actually buffered, so a refusal taken before buffering is observable. */
    public readonly bodyReads: string[] = [];

    public async put(
        key: string,
        value: ArrayBuffer | ArrayBufferView,
        options: R2PutOptionsLike
    ): Promise<R2ObjectLike | null> {
        this.putCalls.push({ key, options: clonePutOptions(options) });
        if (options.onlyIf.etagDoesNotMatch === "*" && this.#objects.has(key)) return null;
        const stored: FakeR2StoredObject = {
            bytes: viewBytes(value),
            metadata: { ...options.customMetadata },
            checksum: options.sha256.slice(0),
            etag: String(++this.#etag),
            declaredSize: undefined
        };
        this.#objects.set(key, stored);
        return object(key, stored);
    }

    /**
     * Serves a window by clamping it to the object, which is what a permissive object
     * store does with an over-long range. The fake keeps that behaviour on purpose: a
     * range refusal observed against a fake that refused for itself would prove nothing
     * about the seam, so here the clamp is available and the seam still must not use it.
     */
    public async get(key: string, options?: R2GetOptionsLike): Promise<R2ObjectBodyLike | null> {
        this.getCalls.push({ key, range: options?.range });
        const stored = this.#objects.get(key);
        if (stored === undefined) return null;
        const metadata = object(key, stored);
        const window = options?.range;
        const served =
            window === undefined
                ? stored.bytes
                : stored.bytes.subarray(
                      Math.min(window.offset, stored.bytes.byteLength),
                      Math.min(window.offset + window.length, stored.bytes.byteLength)
                  );
        return {
            ...metadata,
            arrayBuffer: async () => {
                this.bodyReads.push(key);
                return served.slice().buffer;
            }
        };
    }

    public async head(key: string): Promise<R2ObjectLike | null> {
        this.headCalls.push(key);
        const stored = this.#objects.get(key);
        return stored === undefined ? null : object(key, stored);
    }

    public corruptBody(key: string, bytes: Uint8Array): void {
        this.require(key).bytes = bytes.slice();
    }

    public corruptMetadata(key: string, field: string, value: string): void {
        this.require(key).metadata[field] = value;
    }

    public corruptChecksum(key: string, checksum: ArrayBuffer): void {
        this.require(key).checksum = checksum.slice(0);
    }

    /**
     * Reports a size the object does not hold, which is how a bound measured against
     * R2's reported size is exercised without allocating the bytes it refuses.
     */
    public declareSize(key: string, size: number): void {
        this.require(key).declaredSize = size;
    }

    private require(key: string): FakeR2StoredObject {
        const value = this.#objects.get(key);
        if (value === undefined) throw new TypeError(`Missing fake R2 object: ${key}`);
        return value;
    }
}

export class FakeWebSocket implements HibernatingWebSocketLike {
    public attachmentValue: JsonValue = null;
    public readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];

    public serializeAttachment(value: JsonValue): void {
        this.attachmentValue = structuredClone(value);
    }

    public deserializeAttachment(): JsonValue {
        return structuredClone(this.attachmentValue);
    }

    public send(message: string | ArrayBuffer | ArrayBufferView): void {
        this.sent.push(message);
    }

    /**
     * What this socket was sent, as text. The view stream is a text protocol, so a binary
     * frame — or a missing one — is the adapter misbehaving rather than something a test
     * should decode.
     */
    public sentText(): readonly string[] {
        return this.sent.map((message) => {
            if (!isText(message)) {
                throw new TypeError("Fake WebSocket was sent a binary frame");
            }
            return message;
        });
    }

    public sentTextAt(index: number): string {
        const message = this.sentText()[index];
        if (message === undefined) throw new TypeError(`Fake WebSocket sent no frame ${index}`);
        return message;
    }
}

export class FakeWebSocketContext implements HibernatingWebSocketContextLike {
    public readonly accepted: HibernatingWebSocketLike[] = [];

    public acceptWebSocket(socket: HibernatingWebSocketLike): void {
        this.accepted.push(socket);
    }
}

export class FakeQueueMessage<Body> implements QueueMessageLike<Body> {
    public acknowledgements = 0;
    public readonly retries: Array<Readonly<{ delaySeconds?: number }> | undefined> = [];

    public constructor(
        public readonly id: string,
        public readonly body: Body
    ) {}

    public ack(): void {
        this.acknowledgements += 1;
    }

    public retry(options?: Readonly<{ delaySeconds?: number }>): void {
        this.retries.push(options);
    }
}

export class FakeWorkerLoader implements WorkerLoaderBindingLike<FetchServiceLike> {
    public readonly calls: DynamicWorkerLoadOptions[] = [];
    public disposals = 0;
    public readonly service: FetchServiceLike = {
        fetch: (request) => new Response(request.url)
    };

    public load(options: DynamicWorkerLoadOptions): DynamicWorkerHandleLike<FetchServiceLike> {
        this.calls.push(options);
        return {
            getEntrypoint: () => this.service,
            [Symbol.dispose]: () => {
                this.disposals += 1;
            }
        };
    }
}

export class FakeDispatchNamespace implements DispatchNamespaceLike<FetchServiceLike> {
    public readonly calls: Array<{
        readonly scriptName: string;
        readonly parameters: Readonly<Record<string, string>> | undefined;
    }> = [];

    public get(
        scriptName: string,
        parameters?: Readonly<Record<string, string>>
    ): FetchServiceLike {
        this.calls.push({ scriptName, parameters });
        return { fetch: (request) => new Response(`${scriptName}:${request.url}`) };
    }
}

export class FakeExecutionContext implements CloudflareExecutionContextLike {
    public readonly pending: Promise<void>[] = [];

    public waitUntil(promise: Promise<void>): void {
        this.pending.push(promise);
    }
}

export class FakeWorkerRouter<Environment> implements AuthoritativeWorkerRouter<Environment> {
    public readonly requests: Request[] = [];

    public fetch(
        request: Request,
        _environment: Environment,
        _context: CloudflareExecutionContextLike
    ): Response {
        this.requests.push(request);
        return new Response("routed");
    }
}

export class FakeDurableObjectHost implements AuthoritativeDurableObjectHost {
    public repairs = 0;
    public alarms = 0;
    public readonly messages: Array<string | ArrayBuffer> = [];
    public closes = 0;
    public errors = 0;

    public async repairAlarm(): Promise<void> {
        this.repairs += 1;
    }

    public fetch(request: Request): Response {
        return new Response(request.url);
    }

    public alarm(): void {
        this.alarms += 1;
    }

    public webSocketMessage(
        _socket: HibernatingWebSocketLike,
        message: string | ArrayBuffer
    ): void {
        this.messages.push(message);
    }

    public webSocketClose(
        _socket: HibernatingWebSocketLike,
        _code: number,
        _reason: string,
        _wasClean: boolean
    ): void {
        this.closes += 1;
    }

    public webSocketError(_socket: HibernatingWebSocketLike, _error: Error): void {
        this.errors += 1;
    }
}

export class FakeAlarmStorage implements AlarmStorageLike {
    #setFailures = 0;
    public scheduledAt: number | null = null;
    public readonly setCalls: number[] = [];
    public deleteCalls = 0;

    public async getAlarm(): Promise<number | null> {
        return this.scheduledAt;
    }

    public async setAlarm(scheduledTime: number): Promise<void> {
        if (this.#setFailures > 0) {
            this.#setFailures -= 1;
            throw new TypeError("Fake physical alarm write failed");
        }
        this.scheduledAt = scheduledTime;
        this.setCalls.push(scheduledTime);
    }

    public async deleteAlarm(): Promise<void> {
        this.scheduledAt = null;
        this.deleteCalls += 1;
    }

    public failNextSet(): void {
        this.#setFailures += 1;
    }
}

export class FakeReconciliationOutbox implements ReconciliationOutbox {
    readonly #scheduled = new Map<string, number>();
    readonly #acknowledgementFailures = new Set<string>();
    public duplicateDueIds = false;
    public readonly acknowledgedIds: string[] = [];
    public readonly rescheduled: Array<{ readonly id: string; readonly scheduledAt: number }> = [];

    public enqueue(id: string, scheduledAt: number): void {
        this.#scheduled.set(id, scheduledAt);
    }

    public async dueIds(now: number, limit: number): Promise<readonly DueReconciliation[]> {
        const due = [...this.#scheduled]
            .filter(([, scheduledAt]) => scheduledAt <= now)
            .sort(
                ([leftId, leftTime], [rightId, rightTime]) =>
                    leftTime - rightTime || compareCanonicalText(leftId, rightId)
            )
            .slice(0, limit)
            .map(([id, scheduledAt]) => ({ id: new ReconciliationOutboxId(id), scheduledAt }));
        return this.duplicateDueIds ? due.flatMap((entry) => [entry, entry]) : due;
    }

    public async nextDueAt(): Promise<number | null> {
        if (this.#scheduled.size === 0) return null;
        return Math.min(...this.#scheduled.values());
    }

    public async acknowledge(due: DueReconciliation): Promise<void> {
        if (this.#acknowledgementFailures.delete(due.id.value)) {
            throw new TypeError("Fake outbox acknowledgement failed");
        }
        // The durable outbox fences on the observed schedule; the fake must too,
        // or a lost-wakeup regression passes here and fails in production.
        if (this.#scheduled.get(due.id.value) !== due.scheduledAt) return;
        this.#scheduled.delete(due.id.value);
        this.acknowledgedIds.push(due.id.value);
    }

    public async reschedule(due: DueReconciliation, scheduledAt: number): Promise<void> {
        if (this.#scheduled.get(due.id.value) !== due.scheduledAt) return;
        this.#scheduled.set(due.id.value, scheduledAt);
        this.rescheduled.push({ id: due.id.value, scheduledAt });
    }

    public failAcknowledgeOnce(id: string): void {
        this.#acknowledgementFailures.add(id);
    }
}

export interface FakeDurableObjectId {
    readonly name: string;
    readonly jurisdiction: string | undefined;
}

interface FakeNamespaceState<Stub> {
    readonly create: (name: string, jurisdiction: string | undefined) => Stub;
    readonly stubs: Map<string, Stub>;
    readonly selectedJurisdictions: string[];
}

export class FakeDurableObjectNamespace<Stub> implements DurableObjectNamespaceLike<
    FakeDurableObjectId,
    Stub
> {
    readonly #state: FakeNamespaceState<Stub>;
    public readonly selectedJurisdictions: string[];

    public constructor(
        create: (name: string, jurisdiction: string | undefined) => Stub,
        private readonly selectedJurisdiction?: string,
        state?: FakeNamespaceState<Stub>
    ) {
        this.#state = state ?? {
            create,
            stubs: new Map<string, Stub>(),
            selectedJurisdictions: []
        };
        this.selectedJurisdictions = this.#state.selectedJurisdictions;
    }

    public idFromName(name: string): FakeDurableObjectId {
        return Object.freeze({ name, jurisdiction: this.selectedJurisdiction });
    }

    public get(id: FakeDurableObjectId): Stub {
        const key = `${id.jurisdiction ?? "default"}\u0000${id.name}`;
        let stub = this.#state.stubs.get(key);
        if (stub === undefined) {
            stub = this.#state.create(id.name, id.jurisdiction);
            this.#state.stubs.set(key, stub);
        }
        return stub;
    }

    public jurisdiction(jurisdiction: string): FakeDurableObjectNamespace<Stub> {
        this.#state.selectedJurisdictions.push(jurisdiction);
        return new FakeDurableObjectNamespace(this.#state.create, jurisdiction, this.#state);
    }
}

function object(key: string, stored: FakeR2StoredObject): R2ObjectLike {
    return {
        key,
        size: stored.declaredSize ?? stored.bytes.byteLength,
        etag: stored.etag,
        customMetadata: { ...stored.metadata },
        checksums: { sha256: stored.checksum.slice(0) }
    };
}

function clonePutOptions(options: R2PutOptionsLike): R2PutOptionsLike {
    return {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: { ...options.customMetadata },
        sha256: options.sha256.slice(0)
    };
}

function viewBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    const start = value.byteOffset;
    return new Uint8Array(value.buffer.slice(start, start + value.byteLength));
}

function cloneBinding(value: CloudflareSqlBinding): CloudflareSqlBinding {
    return value instanceof ArrayBuffer ? value.slice(0) : value;
}

function cloneSqliteValue(value: SqliteValue): SqliteValue {
    return value instanceof Uint8Array ? value.slice() : value;
}

function deleteThrough(values: Map<number, Uint8Array>, revision: number): void {
    for (const current of values.keys()) if (current <= revision) values.delete(current);
}

function deleteBefore(values: Map<number, Uint8Array>, revision: number): void {
    for (const current of values.keys()) if (current < revision) values.delete(current);
}

/**
 * Reads a statement's bindings the way the real substrate reads a stored row:
 * positionally, and refusing what that position is not for. Coercing instead would let a
 * caller pass the wrong value in the wrong slot and still see the fake agree. Every
 * binding union in this package is a subset of `CloudflareSqlValue`, so one reader serves
 * the Cloudflare-facing storage and the runtime-facing port alike.
 */
export function boundText(bindings: readonly CloudflareSqlValue[], index: number): string {
    const value = bindings[index];
    if (!isJsonValue(value)) throw new TypeError(`Fake SQLite binding ${index} is not text`);
    return json.string(value, `Fake SQLite binding ${index}`);
}

export function boundInteger(bindings: readonly CloudflareSqlValue[], index: number): number {
    const value = bindings[index];
    if (!isFiniteNumber(value) || !Number.isSafeInteger(value)) {
        throw new TypeError(`Fake SQLite binding ${index} is not an integer`);
    }
    return value;
}

function boundBytes(bindings: readonly CloudflareSqlValue[], index: number): Uint8Array {
    const value = bindings[index];
    if (!(value instanceof Uint8Array)) {
        throw new TypeError(`Fake SQLite binding ${index} is not a BLOB`);
    }
    return value;
}

function isThenable(value: unknown): value is PromiseLike<void> {
    if (!isPlatformObject(value)) return false;
    // SAFETY: this optional view reads only then; callability is the complete behavior
    // the fake transaction needs to reject an asynchronous callback.
    const candidate = value as Partial<PromiseLike<void>>;
    return isPlatformMethod(candidate.then);
}

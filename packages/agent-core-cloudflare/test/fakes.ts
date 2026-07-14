import { AgentCoreError } from "@agent-core/core";
import type {
    AlarmStorageLike,
    AuthoritativeDurableObjectHost,
    AuthoritativeWorkerRouter,
    CloudflareErrorPort,
    CloudflareExecutionContextLike,
    CloudflareOperationalErrorCode,
    CloudflareDurableObjectStorage,
    CloudflareSqlBinding,
    CloudflareSqlCursor,
    CloudflareSqlStorage,
    CloudflareSqlValue,
    DurableObjectNamespaceLike,
    DispatchNamespaceLike,
    DynamicWorkerHandleLike,
    DynamicWorkerLoadOptions,
    FetchServiceLike,
    HibernatingWebSocketContextLike,
    HibernatingWebSocketLike,
    QueueMessageLike,
    R2BucketLike,
    R2ObjectBodyLike,
    R2ObjectLike,
    R2PutOptionsLike,
    ReconciliationOutbox,
    SqliteRow,
    SqliteValue,
    SynchronousResultGuard,
    SynchronousSqlitePort,
    WorkerLoaderBindingLike
} from "../src/index.js";
import { ReconciliationOutboxId } from "../src/index.js";

/** Structural test doubles only; these are not Cloudflare runtime emulators. */

export const fakeErrors: CloudflareErrorPort = Object.freeze({
    raise(code: CloudflareOperationalErrorCode, message: string, cause?: unknown): never {
        const error = new AgentCoreError(code, message);
        if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
        throw error;
    }
});

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

export class FakeDurableObjectStorage implements CloudflareDurableObjectStorage {
    #active = false;
    #scheduledAt: number | null = null;

    public constructor(
        public readonly sql: CloudflareSqlStorage,
        private readonly snapshot: () => unknown = () => undefined,
        private readonly restore: (snapshot: unknown) => void = () => undefined
    ) {}

    public transactionSync<Result>(operation: () => Result): Result {
        if (this.#active) throw new TypeError("Fake Durable Object transaction is nested");
        const snapshot = this.snapshot();
        this.#active = true;
        try {
            const result = operation();
            if (isThenable(result)) {
                throw new TypeError("Fake Durable Object transactions must be synchronous");
            }
            return result;
        } catch (error) {
            this.restore(snapshot);
            throw error;
        } finally {
            this.#active = false;
        }
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
            const channel = bindings[0] as string;
            const revisions = [
                ...this.values(this.#snapshots, channel).keys(),
                ...this.values(this.#deltas, channel).keys()
            ];
            return [{ revision: revisions.length === 0 ? null : Math.max(...revisions) }];
        }
        if (statement.startsWith("SELECT revision, payload FROM agent_core_view_snapshots")) {
            const channel = bindings[0] as string;
            const after = bindings[1] as number;
            const latest = [...this.values(this.#snapshots, channel)]
                .filter(([revision]) => revision > after)
                .sort(([left], [right]) => right - left)[0];
            return latest === undefined
                ? []
                : [{ revision: latest[0], payload: latest[1].slice() }];
        }
        if (statement.startsWith("SELECT revision, payload FROM agent_core_view_deltas")) {
            const channel = bindings[0] as string;
            const after = bindings[1] as number;
            return [...this.values(this.#deltas, channel)]
                .filter(([revision]) => revision > after)
                .sort(([left], [right]) => left - right)
                .map(([revision, payload]) => ({ revision, payload: payload.slice() }));
        }
        if (statement.includes("SELECT id FROM agent_core_reconciliation_outbox")) {
            const now = bindings[0] as number;
            const limit = bindings[1] as number;
            return [...this.#outbox]
                .filter(([, scheduledAt]) => scheduledAt <= now)
                .sort(
                    ([leftId, leftTime], [rightId, rightTime]) =>
                        leftTime - rightTime || leftId.localeCompare(rightId)
                )
                .slice(0, limit)
                .map(([id]) => ({ id }));
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
            this.#migrations.set(bindings[0] as number, bindings[1] as string);
        } else if (statement.startsWith("INSERT INTO agent_core_view_deltas")) {
            this.values(this.#deltas, bindings[0] as string).set(
                bindings[1] as number,
                (bindings[2] as Uint8Array).slice()
            );
        } else if (statement.startsWith("INSERT INTO agent_core_view_snapshots")) {
            this.values(this.#snapshots, bindings[0] as string).set(
                bindings[1] as number,
                (bindings[2] as Uint8Array).slice()
            );
        } else if (statement.startsWith("DELETE FROM agent_core_view_deltas")) {
            deleteThrough(this.values(this.#deltas, bindings[0] as string), bindings[1] as number);
        } else if (statement.startsWith("DELETE FROM agent_core_view_snapshots")) {
            deleteBefore(
                this.values(this.#snapshots, bindings[0] as string),
                bindings[1] as number
            );
        } else if (statement.startsWith("INSERT INTO agent_core_reconciliation_outbox")) {
            this.#outbox.set(bindings[0] as string, bindings[1] as number);
        } else if (statement.startsWith("DELETE FROM agent_core_reconciliation_outbox")) {
            this.#outbox.delete(bindings[0] as string);
        } else if (statement.startsWith("UPDATE agent_core_reconciliation_outbox")) {
            this.#outbox.set(bindings[1] as string, bindings[0] as number);
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
}

export class FakeR2Bucket implements R2BucketLike {
    readonly #objects = new Map<string, FakeR2StoredObject>();
    #etag = 0;
    public readonly putCalls: Array<{
        readonly key: string;
        readonly options: R2PutOptionsLike;
    }> = [];

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
            etag: String(++this.#etag)
        };
        this.#objects.set(key, stored);
        return object(key, stored);
    }

    public async get(key: string): Promise<R2ObjectBodyLike | null> {
        const stored = this.#objects.get(key);
        if (stored === undefined) return null;
        const metadata = object(key, stored);
        return {
            ...metadata,
            arrayBuffer: async () => stored.bytes.slice().buffer
        };
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

    private require(key: string): FakeR2StoredObject {
        const value = this.#objects.get(key);
        if (value === undefined) throw new TypeError(`Missing fake R2 object: ${key}`);
        return value;
    }
}

export class FakeWebSocket implements HibernatingWebSocketLike {
    public attachmentValue: unknown = null;
    public readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];

    public serializeAttachment(value: unknown): void {
        this.attachmentValue = structuredClone(value);
    }

    public deserializeAttachment(): unknown {
        return structuredClone(this.attachmentValue);
    }

    public send(message: string | ArrayBuffer | ArrayBufferView): void {
        this.sent.push(message);
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

export class FakeWorkerLoader implements WorkerLoaderBindingLike {
    public readonly calls: DynamicWorkerLoadOptions[] = [];
    public disposals = 0;
    public readonly service: FetchServiceLike = {
        fetch: (request) => new Response(request.url)
    };

    public load(options: DynamicWorkerLoadOptions): DynamicWorkerHandleLike {
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
    public readonly pending: Promise<unknown>[] = [];

    public waitUntil(promise: Promise<unknown>): void {
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

    public webSocketError(_socket: HibernatingWebSocketLike, _error: unknown): void {
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

    public async dueIds(now: number, limit: number): Promise<readonly ReconciliationOutboxId[]> {
        const ids = [...this.#scheduled]
            .filter(([, scheduledAt]) => scheduledAt <= now)
            .sort(
                ([leftId, leftTime], [rightId, rightTime]) =>
                    leftTime - rightTime || leftId.localeCompare(rightId)
            )
            .slice(0, limit)
            .map(([id]) => new ReconciliationOutboxId(id));
        return this.duplicateDueIds ? ids.flatMap((id) => [id, id]) : ids;
    }

    public async nextDueAt(): Promise<number | null> {
        if (this.#scheduled.size === 0) return null;
        return Math.min(...this.#scheduled.values());
    }

    public async acknowledge(id: ReconciliationOutboxId): Promise<void> {
        if (this.#acknowledgementFailures.delete(id.value)) {
            throw new TypeError("Fake outbox acknowledgement failed");
        }
        this.#scheduled.delete(id.value);
        this.acknowledgedIds.push(id.value);
    }

    public async reschedule(id: ReconciliationOutboxId, scheduledAt: number): Promise<void> {
        this.#scheduled.set(id.value, scheduledAt);
        this.rescheduled.push({ id: id.value, scheduledAt });
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
        size: stored.bytes.byteLength,
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? typeof (value as { readonly then?: unknown }).then === "function"
        : false;
}

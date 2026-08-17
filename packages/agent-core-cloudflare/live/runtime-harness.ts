import {
    AgentCoreError,
    isJsonObject,
    isJsonValue,
    jsonDataParser,
    type JsonValue
} from "@agent-core/core";
import { DurableObject } from "cloudflare:workers";
import {
    AlarmOutboxReconciler,
    DurableOperationJournal,
    ReconciliationOutboxId,
    SqliteReconciliationOutbox,
    cloudflareRuntimeMigrations,
    createCloudflareDurableObjectClass,
    type AlarmStorageLike,
    type AuthoritativeDurableObjectHost,
    type CloudflareDurableObjectInstance,
    type CloudflareDurableObjectRuntime,
    type HibernatingWebSocketLike,
    type ResumableAttempt,
    type SqliteApplicationMigration,
    type SqliteRow,
    type SynchronousSqlitePort
} from "../src/index.js";
import {
    errors,
    field,
    flagField,
    handle,
    handleResponse,
    numberField,
    optionalNumberField,
    readBody,
    type LiveBody
} from "./protocol.js";
import { isFiniteNumber, isText } from "../src/platform-value.js";

const hibernationData = jsonDataParser((message) => new AgentCoreError("codec.invalid", message));

export interface LiveRuntimeEnvironment {
    readonly GIT_COMMIT?: string;
}

/** Lane results are declared as object types so they stay assignable to `JsonValue`. */
type ClaimView = { readonly owner: string; readonly dueAt: number };

type AlarmStateView = {
    readonly physicalAlarm: number | null;
    readonly claims: readonly ClaimView[];
};

type OutboxEntryView = { readonly id: string; readonly scheduledAt: number };

type OutboxStateView = {
    readonly entries: readonly OutboxEntryView[];
    readonly nextDueAt: number | null;
    readonly physicalAlarm: number | null;
    readonly claims: readonly ClaimView[];
};

/**
 * Alarm claims the harness owns. The runtime takes its own claim under a different
 * owner, so the dispatch rule below can never release the reconciler's wakeup.
 */
const CLAIM_PREFIX = "probe.";
const THROWING_SUBJECT = "alarm.throwing";
/** Short enough that a live retry lands inside one test, long enough to be observable. */
const RETRY_DELAY_MS = 2_000;
const HOLD_STEP_MS = 100;
const HOLD_STEPS = 120;
const MAX_OUTBOX_ENTRIES = 100;
/** The one named resumable work the lane declares, and the control row that holds it. */
const RESUME_WORK = "live-resume";

const liveHarnessMigration: SqliteApplicationMigration = Object.freeze({
    version: cloudflareRuntimeMigrations.length + 1,
    name: "live-harness-journal",
    statements: Object.freeze([
        `CREATE TABLE live_events (
            ordinal INTEGER PRIMARY KEY,
            kind TEXT NOT NULL,
            subject TEXT NOT NULL,
            at INTEGER NOT NULL,
            detail INTEGER NOT NULL
        ) STRICT`,
        `CREATE TABLE live_controls (
            subject TEXT PRIMARY KEY,
            hold INTEGER NOT NULL CHECK (hold IN (0, 1)),
            faults INTEGER NOT NULL CHECK (faults >= 0),
            until INTEGER NOT NULL CHECK (until >= 0)
        ) STRICT`,
        `CREATE TABLE live_deliveries (
            delivery_id TEXT PRIMARY KEY,
            attempts INTEGER NOT NULL CHECK (attempts > 0)
        ) STRICT`
    ])
});

/**
 * The live lane's two releases of one worker. Every deployment defines
 * `LIVE_SCHEMA_RELEASE`; the `next` release declares one migration that `base` does not,
 * which is what makes rolling back to `base` meet a schema it cannot read.
 */
declare const LIVE_SCHEMA_RELEASE: string;

const liveRolloutMigration: SqliteApplicationMigration = Object.freeze({
    version: cloudflareRuntimeMigrations.length + 2,
    name: "live-harness-rollout",
    statements: Object.freeze([
        `CREATE TABLE live_rollout (
            subject TEXT PRIMARY KEY,
            at INTEGER NOT NULL CHECK (at >= 0)
        ) STRICT`
    ])
});

const liveReleaseMigrations: readonly SqliteApplicationMigration[] = Object.freeze(
    LIVE_SCHEMA_RELEASE === "next"
        ? [liveHarnessMigration, liveRolloutMigration]
        : [liveHarnessMigration]
);

/**
 * Identifies the isolate serving a request. A hibernating WebSocket that wakes into a
 * different isolate proves the object was genuinely evicted; Workers forbid randomness
 * at module scope, so the value is minted on first observation.
 */
let isolateNonce: string | undefined;

function currentIsolate(): string {
    isolateNonce ??= crypto.randomUUID();
    return isolateNonce;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((settle) => setTimeout(settle, milliseconds));
}

function textColumn(row: SqliteRow, column: string): string {
    const value = row[column];
    if (!isText(value)) {
        throw new AgentCoreError("codec.invalid", `Live harness column ${column} is not text`);
    }
    return value;
}

function integerColumn(row: SqliteRow, column: string): number {
    const value = row[column];
    if (!isFiniteNumber(value) || !Number.isSafeInteger(value)) {
        throw new AgentCoreError(
            "codec.invalid",
            `Live harness column ${column} is not an integer`
        );
    }
    return value;
}

/** Append-only durable journal: every live assertion reads observable state from here. */
class LiveJournal {
    public constructor(private readonly database: SynchronousSqlitePort) {}

    public record(kind: string, subject: string, detail = 0): void {
        this.database.run(
            "INSERT INTO live_events (kind, subject, at, detail) VALUES (?, ?, ?, ?)",
            [kind, subject, Date.now(), detail]
        );
    }

    public events(): JsonValue {
        return this.database
            .all("SELECT ordinal, kind, subject, at, detail FROM live_events ORDER BY ordinal", [])
            .map((row) => ({
                ordinal: integerColumn(row, "ordinal"),
                kind: textColumn(row, "kind"),
                subject: textColumn(row, "subject"),
                at: integerColumn(row, "at"),
                detail: integerColumn(row, "detail")
            }));
    }
}

class LiveRuntimeHost implements AuthoritativeDurableObjectHost {
    readonly #database: SynchronousSqlitePort;
    readonly #journal: LiveJournal;
    readonly #outbox: SqliteReconciliationOutbox;
    readonly #reconciler: AlarmOutboxReconciler;
    readonly #operations: DurableOperationJournal;

    public constructor(
        private readonly runtime: CloudflareDurableObjectRuntime<LiveRuntimeEnvironment>
    ) {
        this.#database = runtime.sqlite;
        this.#journal = new LiveJournal(runtime.sqlite);
        this.#outbox = new SqliteReconciliationOutbox(runtime.sqlite, errors);
        this.#operations = new DurableOperationJournal(
            runtime.sqlite,
            this.#outbox,
            { [RESUME_WORK]: (attempt) => this.#runResumable(attempt) },
            errors
        );
        this.#reconciler = new AlarmOutboxReconciler(
            runtime.alarms,
            this.#outbox,
            (id) => this.#dispatchReconciliation(id),
            errors,
            { retryDelayMs: RETRY_DELAY_MS }
        );
    }

    public repairAlarm(): Promise<void> {
        return this.#reconciler.repairAlarm();
    }

    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/socket") {
            return handleResponse(async () => this.#openSocket(url));
        }
        const body = await readBody(request);
        switch (url.pathname) {
            case "/enqueue":
                return handle(() => this.#enqueue(body));
            case "/acknowledge":
                return handle(() => this.#acknowledge(body));
            case "/outbox":
                return handle(() => this.#outboxState());
            case "/claim":
                return handle(() => this.#claim(body));
            case "/unclaim":
                return handle(() => this.#unclaim(body));
            case "/arm-throwing":
                return handle(() => this.#armThrowing(body));
            case "/alarms":
                return handle(() => this.#alarmState());
            case "/resume-begin":
                return handle(() => this.#beginResumable(body));
            case "/resume-state":
                return handle(() => this.#resumableState(body));
            case "/events":
                return handle(async () => ({ events: this.#journal.events() }));
            case "/blob":
                return handle(async () => this.#appendBlob(body));
            case "/blob-read":
                return handle(async () => this.#readBlob(body));
            case "/queue-delivery":
                return handle(async () => this.#recordDelivery(body));
            case "/queue-poison":
                return handle(async () => this.#recordPoison(body));
            case "/deliveries":
                return handle(async () => this.#deliveries());
            default:
                return new Response("not found", { status: 404 });
        }
    }

    public async alarm(): Promise<void> {
        const now = Date.now();
        this.#journal.record("alarm.fired", "", now);
        const throwUntil = this.#controlUntil(THROWING_SUBJECT);
        if (now < throwUntil) {
            // A throwing alarm must not be lost. Nothing outside the object re-arms it:
            // whatever fires it again is the platform's own recovery.
            this.#journal.record("alarm.threw", THROWING_SUBJECT, throwUntil);
            throw new AgentCoreError("protocol.invalid-state", "Injected live alarm failure");
        }
        for (const claim of this.#dueClaims(now)) {
            this.#journal.record("claim.fired", claim.owner, claim.dueAt);
            await this.#claimStorage(claim.owner).deleteAlarm();
        }
        await this.#reconciler.handleAlarm();
    }

    public webSocketMessage(socket: HibernatingWebSocketLike, message: string | ArrayBuffer): void {
        if (!isText(message)) {
            throw new AgentCoreError("codec.invalid", "Live socket messages must be text");
        }
        const decoded: unknown = JSON.parse(message);
        if (!isJsonValue(decoded) || !isJsonObject(decoded)) {
            throw new AgentCoreError("codec.invalid", "Live socket message must be JSON data");
        }
        const request: LiveBody = decoded;
        const before = this.runtime.webSockets.attachment(socket);
        if (request["ack"] !== undefined) {
            this.runtime.webSockets.acknowledge(socket, numberField(request, "ack"));
        }
        if (flagField(request, "append")) {
            const next = this.runtime.revisions.currentRevision(before.channel) + 1;
            this.runtime.revisions.append(
                before.channel,
                next,
                new TextEncoder().encode(`live-${next}`)
            );
        }
        const after = this.runtime.webSockets.attachment(socket);
        this.#journal.record("socket.message", after.channel, after.ackedRevision);
        socket.send(
            JSON.stringify({
                probe: "attachment",
                isolate: currentIsolate(),
                before,
                after,
                currentRevision: this.runtime.revisions.currentRevision(after.channel)
            })
        );
        this.runtime.webSockets.replay(socket);
    }

    public webSocketClose(): void {}

    public webSocketError(): void {}

    #openSocket(url: URL): Response {
        const channel = url.searchParams.get("channel") ?? "";
        const acked = Number(url.searchParams.get("acked") ?? "");
        if (channel.length === 0 || !Number.isSafeInteger(acked) || acked < 0) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Live socket needs a channel and an acknowledged revision"
            );
        }
        if (this.runtime.revisions.currentRevision(channel) === 0) {
            this.runtime.revisions.append(channel, 1, new TextEncoder().encode("live-1"));
            this.runtime.revisions.append(channel, 2, new TextEncoder().encode("live-2"));
        }
        const pair = new WebSocketPair();
        this.runtime.webSockets.accept(pair[1], channel, acked);
        this.#journal.record("socket.accepted", channel, acked);
        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    /**
     * One sweep serves both lanes. An ID the resumption journal holds is a resumable
     * operation; anything else is a bare outbox probe, which is what keeps the fence and
     * retry evidence about the outbox itself.
     */
    async #dispatchReconciliation(id: ReconciliationOutboxId): Promise<void> {
        if (this.#operations.record(id) !== undefined) {
            await this.#operations.resume(id);
            return;
        }
        await this.#reconcile(id);
    }

    /**
     * The lane's resumable work. Both steps write through the durable event journal from
     * inside their checkpoint, so a step that committed is visible exactly once however
     * many attempts the operation takes, and the hold between them is where a real
     * instance kill lands mid-attempt.
     */
    async #runResumable(attempt: ResumableAttempt): Promise<void> {
        this.#journal.record(
            "resume.observed",
            `${attempt.id.value}#${currentIsolate()}`,
            attempt.interrupted ? attempt.attempt : -attempt.attempt
        );
        attempt.checkpoint("first", () =>
            this.#journal.record("resume.step", `${attempt.id.value}#first`, attempt.attempt)
        );
        for (let step = 0; step < HOLD_STEPS && this.#controlHeld(attempt.id.value); step += 1) {
            await delay(HOLD_STEP_MS);
        }
        attempt.checkpoint("second", () =>
            this.#journal.record("resume.step", `${attempt.id.value}#second`, attempt.attempt)
        );
    }

    async #beginResumable(body: LiveBody): Promise<JsonValue> {
        const id = new ReconciliationOutboxId(field(body, "id"));
        this.#operations.begin(id, RESUME_WORK, Date.now() + numberField(body, "delayMs"));
        // Controls land before the alarm is armed, so a sweep can never observe the
        // operation before the hold that the scenario begins it with.
        this.#applyControls(id.value, body);
        await this.#reconciler.armAlarm();
        return this.#resumableState(body);
    }

    async #resumableState(body: LiveBody): Promise<JsonValue> {
        const id = new ReconciliationOutboxId(field(body, "id"));
        this.#applyControls(id.value, body);
        const record = this.#operations.record(id);
        return {
            isolate: currentIsolate(),
            operation:
                record === undefined
                    ? null
                    : { work: record.work, attempts: record.attempts, claimed: record.claimed },
            ...(await this.#outboxState())
        };
    }

    async #reconcile(id: ReconciliationOutboxId): Promise<void> {
        this.#journal.record("reconcile.started", id.value);
        // Holding the sweep open across real awaits leaves the object's input gate open,
        // which is exactly when a request can reschedule this entry underneath it.
        for (let step = 0; step < HOLD_STEPS && this.#controlHeld(id.value); step += 1) {
            await delay(HOLD_STEP_MS);
        }
        if (this.#consumeFault(id.value)) {
            this.#journal.record("reconcile.failed", id.value);
            throw new AgentCoreError(
                "protocol.invalid-state",
                `Injected reconciliation fault for ${id.value}`
            );
        }
        this.#journal.record("reconcile.finished", id.value);
    }

    async #enqueue(body: LiveBody): Promise<OutboxStateView & { readonly scheduledAt: number }> {
        const id = new ReconciliationOutboxId(field(body, "id"));
        const scheduledAt = Date.now() + numberField(body, "delayMs");
        // Both writes land before the first await, so an alarm can never observe a
        // rescheduled entry whose control row has not caught up.
        this.#outbox.enqueue(id, scheduledAt);
        // Journalled so a scenario can prove where a reschedule landed relative to a sweep.
        this.#journal.record("outbox.enqueued", id.value, scheduledAt);
        this.#applyControls(id.value, body);
        await this.#reconciler.armAlarm();
        return { scheduledAt, ...(await this.#outboxState()) };
    }

    async #acknowledge(body: LiveBody): Promise<OutboxStateView> {
        await this.#outbox.acknowledge({
            id: new ReconciliationOutboxId(field(body, "id")),
            scheduledAt: numberField(body, "scheduledAt")
        });
        await this.#reconciler.armAlarm();
        return this.#outboxState();
    }

    async #outboxState(): Promise<OutboxStateView> {
        const entries = await this.#outbox.dueIds(Number.MAX_SAFE_INTEGER, MAX_OUTBOX_ENTRIES);
        return {
            entries: entries.map((entry) => ({
                id: entry.id.value,
                scheduledAt: entry.scheduledAt
            })),
            nextDueAt: await this.#outbox.nextDueAt(),
            ...(await this.#alarmState())
        };
    }

    async #claim(body: LiveBody): Promise<AlarmStateView & { readonly dueAt: number }> {
        const owner = CLAIM_PREFIX + field(body, "owner");
        const dueAt = Date.now() + numberField(body, "delayMs");
        await this.#claimStorage(owner).setAlarm(dueAt);
        return { dueAt, ...(await this.#alarmState()) };
    }

    async #unclaim(body: LiveBody): Promise<AlarmStateView> {
        await this.#claimStorage(CLAIM_PREFIX + field(body, "owner")).deleteAlarm();
        return this.#alarmState();
    }

    async #armThrowing(
        body: LiveBody
    ): Promise<AlarmStateView & { readonly dueAt: number; readonly until: number }> {
        const until = Date.now() + numberField(body, "throwForMs");
        this.#database.run(
            `INSERT INTO live_controls (subject, hold, faults, until) VALUES (?, 0, 0, ?)
             ON CONFLICT (subject) DO UPDATE SET until = excluded.until`,
            [THROWING_SUBJECT, until]
        );
        const dueAt = Date.now() + numberField(body, "delayMs");
        await this.#claimStorage(`${CLAIM_PREFIX}throwing`).setAlarm(dueAt);
        return { dueAt, until, ...(await this.#alarmState()) };
    }

    async #alarmState(): Promise<AlarmStateView> {
        return {
            physicalAlarm: await this.runtime.state.storage.getAlarm(),
            claims: this.#database
                .all("SELECT owner, due_at FROM agent_core_alarm_claims ORDER BY due_at, owner", [])
                .map((row) => ({
                    owner: textColumn(row, "owner"),
                    dueAt: integerColumn(row, "due_at")
                }))
        };
    }

    #appendBlob(body: LiveBody): JsonValue {
        const channel = field(body, "channel");
        const revision = this.runtime.revisions.currentRevision(channel) + 1;
        const payload = new Uint8Array(numberField(body, "bytes")).fill(7);
        this.runtime.revisions.append(channel, revision, payload);
        return { revision, byteLength: payload.byteLength };
    }

    #readBlob(body: LiveBody): JsonValue {
        const channel = field(body, "channel");
        const replay = this.runtime.revisions.replay(channel, 0);
        const last = replay.deltas.at(-1) ?? replay.snapshot;
        return {
            currentRevision: replay.currentRevision,
            lastByteLength: last === undefined ? null : last.payload.byteLength
        };
    }

    #recordDelivery(body: LiveBody): JsonValue {
        const deliveryId = field(body, "deliveryId");
        this.#database.run(
            `INSERT INTO live_deliveries (delivery_id, attempts) VALUES (?, 1)
             ON CONFLICT (delivery_id) DO UPDATE SET attempts = attempts + 1`,
            [deliveryId]
        );
        const attempts = this.#deliveryAttempts(deliveryId);
        this.#journal.record("queue.delivered", deliveryId, attempts);
        // "retry-once" proves a real redelivery: the first attempt is refused, the
        // second is taken, so a second attempt can only come from the queue itself.
        const disposition = field(body, "mode") === "retry-once" && attempts < 2 ? "retry" : "ack";
        return { attempts, disposition };
    }

    #recordPoison(body: LiveBody): JsonValue {
        const messageId = field(body, "messageId");
        this.#journal.record("queue.poison", field(body, "deliveryId"));
        return { messageId };
    }

    #deliveries(): JsonValue {
        return {
            deliveries: this.#database
                .all("SELECT delivery_id, attempts FROM live_deliveries ORDER BY delivery_id", [])
                .map((row) => ({
                    deliveryId: textColumn(row, "delivery_id"),
                    attempts: integerColumn(row, "attempts")
                }))
        };
    }

    #deliveryAttempts(deliveryId: string): number {
        const rows = this.#database.all(
            "SELECT attempts FROM live_deliveries WHERE delivery_id = ?",
            [deliveryId]
        );
        const row = rows[0];
        if (row === undefined) {
            throw new AgentCoreError(
                "codec.invalid",
                `Live delivery ${deliveryId} was not recorded`
            );
        }
        return integerColumn(row, "attempts");
    }

    #claimStorage(owner: string): AlarmStorageLike {
        return this.runtime.alarmClaims.owner(owner, this.runtime.state.storage);
    }

    #dueClaims(now: number): readonly ClaimView[] {
        return this.#database
            .all(
                `SELECT owner, due_at FROM agent_core_alarm_claims
                 WHERE due_at <= ? AND owner LIKE ? ORDER BY due_at, owner`,
                [now, `${CLAIM_PREFIX}%`]
            )
            .map((row) => ({
                owner: textColumn(row, "owner"),
                dueAt: integerColumn(row, "due_at")
            }));
    }

    #applyControls(subject: string, body: LiveBody): void {
        if (body["hold"] !== undefined || body["faults"] !== undefined) {
            this.#database.run(
                `INSERT INTO live_controls (subject, hold, faults, until) VALUES (?, ?, ?, 0)
                 ON CONFLICT (subject) DO UPDATE SET hold = excluded.hold, faults = excluded.faults`,
                [subject, flagField(body, "hold") ? 1 : 0, optionalNumberField(body, "faults", 0)]
            );
        }
        if (flagField(body, "release")) {
            this.#database.run("UPDATE live_controls SET hold = 0 WHERE subject = ?", [subject]);
        }
    }

    #controlHeld(subject: string): boolean {
        return this.#control(subject, "hold") === 1;
    }

    #controlUntil(subject: string): number {
        return this.#control(subject, "until") ?? 0;
    }

    #consumeFault(subject: string): boolean {
        if ((this.#control(subject, "faults") ?? 0) <= 0) return false;
        this.#database.run("UPDATE live_controls SET faults = faults - 1 WHERE subject = ?", [
            subject
        ]);
        return true;
    }

    #control(subject: string, column: "hold" | "faults" | "until"): number | undefined {
        const rows = this.#database.all(
            `SELECT ${column} AS value FROM live_controls WHERE subject = ?`,
            [subject]
        );
        const row = rows[0];
        return row === undefined ? undefined : integerColumn(row, "value");
    }
}

const LiveRuntimeDelegate = createCloudflareDurableObjectClass<LiveRuntimeEnvironment>({
    errors,
    migrations: liveReleaseMigrations,
    host: { create: (runtime) => new LiveRuntimeHost(runtime) }
});

export class LiveRuntimeHarness extends DurableObject<LiveRuntimeEnvironment> {
    readonly #delegate: CloudflareDurableObjectInstance;

    public constructor(state: DurableObjectState, environment: LiveRuntimeEnvironment) {
        super(state, environment);
        this.#delegate = new LiveRuntimeDelegate(
            state satisfies ConstructorParameters<typeof LiveRuntimeDelegate>[0],
            environment
        );
    }

    public fetch(request: Request): Response | Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/abort") {
            this.ctx.abort();
            return new Response(null, { status: 204 });
        }
        if (url.pathname === "/sockets") {
            return handle(async () => this.#hibernatingSockets());
        }
        // The delegate refuses every operation when the object's applied schema is one
        // this release does not declare. Mapping that inside the object keeps its exact
        // code observable to the lane instead of crossing the object boundary untyped.
        return handleResponse(async () => this.#delegate.fetch(request));
    }

    public alarm(): void | Promise<void> {
        return this.#delegate.alarm();
    }

    public webSocketMessage(
        socket: WebSocket,
        message: string | ArrayBuffer
    ): void | Promise<void> {
        return this.#delegate.webSocketMessage(socket, message);
    }

    public webSocketClose(
        socket: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean
    ): void | Promise<void> {
        return this.#delegate.webSocketClose(socket, code, reason, wasClean);
    }

    public webSocketError(socket: WebSocket, error: Error): void | Promise<void> {
        return this.#delegate.webSocketError(socket, error);
    }

    /**
     * Reads the hibernation manager's own copy of every attachment, in an I/O context
     * that shares nothing with the socket's. Decoding here rather than through the
     * adapter keeps the observation independent of the code under evidence.
     */
    #hibernatingSockets(): JsonValue {
        return {
            count: this.ctx.getWebSockets().length,
            attachments: this.ctx.getWebSockets().map((socket) => {
                const value: unknown = socket.deserializeAttachment();
                if (!isJsonValue(value) || !isJsonObject(value)) {
                    throw new AgentCoreError(
                        "codec.invalid",
                        "Hibernating socket attachment is not a live view attachment"
                    );
                }
                return {
                    channel: hibernationData.nonemptyString(
                        value["channel"],
                        "Hibernating socket channel"
                    ),
                    ackedRevision: hibernationData.safeInteger(
                        value["ackedRevision"],
                        "Hibernating socket revision"
                    )
                };
            })
        };
    }
}
